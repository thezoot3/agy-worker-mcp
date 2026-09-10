import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { z } from 'zod'

import { ValidationError } from '../../contract/errors.js'
import {
  assertContained,
  binPath,
  canonicalize,
  chmodDbFiles,
  ensureJobDirs,
  isWithin,
  jobPaths,
  newJobId,
  newSessionId,
  stateHome,
  writeJsonAtomic,
} from '../../contract/paths.js'
import type { EffectiveConfig, JobRequest } from '../../contract/types.js'
import { describePolicy } from '../../broker/blockers.js'
import { cleanupOldJobs, reconcile } from '../../broker/reconcile.js'
import { ensureGateHook } from '../../gate/hooks-file.js'
import { ceilingAbsenceHint, loadCeiling } from '../../policy/ceiling.js'
import { validateWriteRoots } from '../../policy/containment.js'
import { getProfile, resolvePolicy } from '../../policy/profiles.js'
import { evaluateCommandPolicy, firstMatchForDenial, parseRulesLenient } from '../../policy/rules.js'
import { hooksFilePath } from '../../gate/hooks-file.js'
import { appendUserTurn } from '../../runner/inbox.js'
import { buildAgyArgv, buildChildEnv, resolveAgyBin } from '../../runner/spawn.js'
import { acquireJobLocks } from '../../store/locks.js'
import { createJob, listJobs, LIVE_LIFECYCLES } from '../../store/jobs.js'
import { createSession, getSession } from '../../store/sessions.js'
import { errorReply, reply, type ToolContext, type ToolReply } from '../context.js'
import { acceptedEfforts } from './capabilities.js'

/**
 * `agy_start` — begin a new job and return its `job_id` immediately.
 *
 * Never blocks. The job outlives this server process, so any client connected to
 * the same project can pick it up with `agy_wait` / `agy_logs`.
 *
 * `dry_run: true` resolves everything — argv, policy, locks that *would* be
 * taken — and returns the `EffectiveConfig` without spawning. Settling
 * configuration this way costs no agy quota.
 */
export const startInput = z.object({
  prompt: z.string().min(1).describe('Task for the agent. Sent as --print=<prompt>.'),
  cwd: z
    .string()
    .optional()
    .describe('Workspace directory. Must be inside the project root. Defaults to the project root.'),
  profile: z
    .enum(['research_readonly', 'general_worker'])
    .optional()
    .describe('Permission profile ceiling. research_readonly cannot write or run interpreters. Defaults to research_readonly.'),
  model: z
    .string()
    .refine((v) => !v.startsWith('-'), 'must not look like a CLI flag')
    .optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  mode: z
    .string()
    .refine((v) => !v.startsWith('-'), 'must not look like a CLI flag')
    .optional()
    .describe('agy execution mode, e.g. accept-edits or plan.'),
  session_id: z
    .string()
    .optional()
    .describe('Continue an existing agy conversation. Omit to create a new session.'),
  session_mode: z
    .enum(['oneshot', 'session'])
    .optional()
    .describe('oneshot closes stdin after the prompt; session keeps it open for agy_send.'),
  permissions: z
    .object({
      allow: z
        .array(z.string())
        .optional()
        .describe('Narrows within the profile+ceiling allow list; entries the ceiling refuses come back in rejected_allow.'),
      deny: z
        .array(z.string())
        .optional()
        .describe('Always wins: unioned with the profile deny list and HARD_DENY, never narrowed.'),
      sandboxed: z
        .boolean()
        .optional()
        .describe('Forces agy\'s OS sandbox on for this job (0.2.0 behaviour). Parent can only narrow: true forces the sandbox on; false or absent changes nothing.'),
      read_roots: z
        .array(z.string())
        .optional()
        .describe(
          "The project ceiling's read_roots apply by default. List entries here only to use a subset of them; entries outside the ceiling are dropped and reported in rejected_read_roots.",
        ),
    })
    .optional()
    .describe(
      'Three-owner model (see docs/permissions.md): code (HARD_DENY, profiles) is fixed; the project ceiling (~/.agy-worker/projects/<hash>/policy.json, human-owned, outside the workspace) sets what can ever be granted; this field only narrows within that ceiling, never widens it.',
    ),
  on_denial: z
    .enum(['abort', 'continue', 'guide'])
    .optional()
    .describe('What to do on the first policy denial. Default continue.'),
  max_denials: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Abort the job after this many gate denials regardless of on_denial. Null = never. A middle ground between abort (one flaky-tool workaround kills the job) and continue (unbounded denial loops).',
    ),
  timeout_ms: z.number().int().positive().optional(),
  idle_timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'session_mode "session" only. Closes stdin (ending the process) after this many ms of no agy_send following the last completed turn. Does not affect timeout_ms/deadline_at — agy_send never extends those. Ignored for oneshot.',
    ),
  expected_artifacts: z
    .array(z.string())
    .optional()
    .describe('Workspace-relative paths that must exist afterwards. Missing ones block verified_success.'),
  json_schema: z.string().optional().describe('Path to a JSON schema for structured output.'),
  verify_command: z
    .string()
    .min(1)
    .transform((v) => v.trim())
    .refine((v) => v.length > 0, 'must not be blank')
    .optional()
    .describe(
      'A command the runner — not agy — runs once, after agy exits normally, against the final workspace state. Outside the model\'s own decisions: it cannot skip, reorder, or narrow it. Not a sandboxing feature — it runs as the user, unsandboxed, at the same trust level as the parent agent running the command itself. A non-zero exit or a verify_timeout_ms timeout makes outcome "failed", never a Blocker.',
    ),
  verify_timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Timeout for verify_command alone, independent of timeout_ms/deadline_at — verify_command may run past the job\'s own deadline. Defaults to limits.default_verify_timeout_ms, clamped to limits.max_timeout_ms. Ignored without verify_command.',
    ),
  requested_by: z.string().optional(),
  parent_task_id: z.string().optional(),
  dry_run: z
    .boolean()
    .optional()
    .describe('Resolve configuration and policy without spawning agy. Costs no quota.'),
  expected_commands: z
    .array(z.string())
    .optional()
    .describe('dry_run only: shell commands to evaluate against the effective policy.'),
})

export type StartInput = z.infer<typeof startInput>

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max)
}

/** Opportunistic retention window for finished job directories. */
const CLEANUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export async function handleStart(ctx: ToolContext, input: StartInput): Promise<ToolReply> {
  try {
    await reconcile(ctx.store)
    cleanupOldJobs(ctx.store, CLEANUP_MAX_AGE_MS)
    chmodDbFiles(ctx.store.paths.db)

    if (input.expected_commands && !input.dry_run) {
      throw new ValidationError({
        field: 'expected_commands',
        value: input.expected_commands,
        expected: 'expected_commands is only valid when dry_run is true',
      })
    }

    // Measured 2026-09-08 (M8): agy rejects an `--effort`
    // that disagrees with a suffixed model name, and any `--effort` on
    // `claude-*`. Both fail in ~5 s with exit 1 after a job was created —
    // the audit (`08`) counted two such wasted jobs. Refuse before spawning.
    if (input.effort && input.model) {
      const accepted = acceptedEfforts(input.model)
      if (accepted !== null && !accepted.includes(input.effort)) {
        throw new ValidationError({
          field: 'effort',
          value: input.effort,
          expected:
            accepted.length === 0
              ? `omit effort for ${input.model}: agy does not accept --effort for this model`
              : `omit effort for ${input.model}, or pass exactly "${accepted.join('" | "')}" (the effort is part of the model name)`,
        })
      }
    }

    const profileName = input.profile ?? 'research_readonly'
    const profileDef = getProfile(profileName)

    const rawCwd = input.cwd ?? ctx.paths.root
    const cwd = assertContained(rawCwd, [ctx.paths.root], 'write')

    // Fail before anything else is created: a job whose gate can never load
    // must never reach `acquireJobLocks` / `createJob` — there would be
    // nothing left to unwind a lock or a job row with no runner ever spawned to
    // finalize it. `ensureGateHook` below no longer has a fail-open fallback
    // (the `|| printf` command is gone), so it must never be called with a
    // `gatePath` that does not exist.
    const gatePath = binPath('gate')
    if (!existsSync(gatePath)) {
      throw new ValidationError({
        field: 'gate',
        value: gatePath,
        expected: 'dist/gate.js built',
      })
    }

    const canonicalCwd = canonicalize(cwd)
    const canonicalState = canonicalize(stateHome())
    const canonicalGate = canonicalize(gatePath)
    if (canonicalState === canonicalCwd || isWithin(canonicalState, canonicalCwd)) {
      throw new ValidationError({
        field: 'workspace',
        value: cwd,
        expected: `workspace must not contain state home (${canonicalState})`,
      })
    }
    if (canonicalGate === canonicalCwd || isWithin(canonicalGate, canonicalCwd)) {
      throw new ValidationError({
        field: 'gate',
        value: gatePath,
        expected: `gate binary (${gatePath}) must not lie inside the workspace (${cwd})`,
      })
    }

    let sessionId: string
    let conversationId: string | null
    let sessionExists = false
    if (input.session_id) {
      const session = getSession(ctx.store, input.session_id)
      if (!session) {
        throw new ValidationError({
          field: 'session_id',
          value: input.session_id,
          expected: `an existing session id in project ${ctx.paths.root}`,
        })
      }
      sessionId = session.session_id
      conversationId = session.conversation_id
      sessionExists = true

      // A still-null conversation_id while a job on this session is genuinely
      // live (queued/starting/running/canceling) just means we are between
      // turns — the natural `LOCK_CONFLICT` from `acquireJobLocks` below is
      // what should surface in that case, not this. Only when *nothing* is
      // live for this session does a null conversation_id mean its one job
      // finished without agy ever reporting a conversation id, so there is
      // nothing to resume — continuing silently would start a brand-new
      // conversation while `agy_start`'s own contract promises this resumes
      // the old one (finding 14): surface it instead of losing context
      // quietly.
      if (conversationId === null) {
        const liveJobs = listJobs(ctx.store, { sessionId, lifecycle: [...LIVE_LIFECYCLES], limit: 1 })
        if (liveJobs.length === 0) {
          throw new ValidationError({
            field: 'session_id',
            value: input.session_id,
            expected:
              'a session whose conversation_id has been captured — this session finished its only job without agy ever reporting a conversation id, so there is nothing to resume',
          })
        }
      }
    } else {
      sessionId = newSessionId()
      conversationId = null
    }

    const onDenial = input.on_denial ?? 'continue'
    const sessionMode = input.session_mode ?? 'oneshot'
    const timeoutMs = clamp(input.timeout_ms ?? ctx.limits.default_timeout_ms, 1, ctx.limits.max_timeout_ms)
    // Only meaningful for session_mode:'session' (see
    // EffectiveConfig.idle_timeout_ms). null for oneshot — its one turn is
    // already followed by an immediate stdin close, so there is no idle gap
    // to bound.
    const idleTimeoutMs =
      sessionMode === 'session'
        ? clamp(input.idle_timeout_ms ?? ctx.limits.default_idle_timeout_ms, 1, ctx.limits.max_idle_timeout_ms)
        : null
    // `--json-schema <path>` hands agy an arbitrary file to read; without
    // containment a client could point it outside the workspace (finding 18).
    const jsonSchemaPath = input.json_schema
      ? assertContained(input.json_schema, [ctx.paths.root], 'read')
      : null
    const expectedArtifacts = input.expected_artifacts ?? []

    // Loaded once per call, fresh — never cached across calls, so an edit to
    // policy.json between two agy_start calls takes effect immediately.
    // Invalid (`ValidationError`) propagates straight to `errorReply` below,
    // failing this call closed rather than silently falling back to an empty
    // ceiling (see docs/permissions.md).
    const ceiling = loadCeiling(ctx.paths)

    const policy = resolvePolicy({
      profile: profileName,
      workspace: cwd,
      requested: input.permissions,
      onDenial,
      maxDenials: input.max_denials ?? null,
      ceiling,
    })

    validateWriteRoots(policy.write_roots, gatePath)

    // PR6: `verify_command` is checked
    // against the same resolved deny list a `run_command` call inside this job
    // would be checked against — `policy.deny` already unions `HARD_DENY`, the
    // profile's own deny list, the ceiling's `deny`, and the request's
    // own `deny`, `{workspace}`-substituted by `resolvePolicy` above — so
    // reusing it here is both the simplest check and the correct one: nothing
    // verify_command runs unsandboxed after the job finishes should be able to
    // do what an ordinary `run_command` call could not have done inside it.
    let verify: { command: string; timeout_ms: number } | null = null
    if (input.verify_command) {
      const denyMatch = firstMatchForDenial(parseRulesLenient(policy.deny), {
        verb: 'command',
        value: input.verify_command,
      })
      if (denyMatch) {
        throw new ValidationError({
          field: 'verify_command',
          value: input.verify_command,
          expected: `a command not matched by a deny rule — matched ${denyMatch.raw}`,
        })
      }
      const verifyTimeoutMs = clamp(
        input.verify_timeout_ms ?? ctx.limits.default_verify_timeout_ms,
        1,
        ctx.limits.max_timeout_ms,
      )
      verify = { command: input.verify_command, timeout_ms: verifyTimeoutMs }
    }

    const jobId = newJobId()
    const now = Date.now()
    const deadlineAt = now + timeoutMs

    // Session mode takes its prompts from stdin, so turn 1 is seeded into the
    // inbox below rather than passed on the command line (agy refuses both).
    const streamInput = sessionMode === 'session'
    // The workspace is always addDirs[0] (buildAgyArgv's own contract);
    // policy.add_dirs is `requested.read_roots` filtered against
    // the human ceiling's glob list.
    const addDirs = [cwd, ...policy.add_dirs]
    // M10 (measured on agy 1.1.27): agy loads `.agents/hooks.json` from
    // *every* `--add-dir`, and a deny from such a hook runs before ours and
    // short-circuits the chain — our gate never sees the call, the watchdog
    // (I4) then kills the job as "gate not confirmed", and whether a foreign
    // `overwrite` could clobber ours is unmeasured. Fail closed: a read root
    // that carries its own hook file is refused here, with the path, rather
    // than started and misreported.
    for (const dir of policy.add_dirs) {
      const foreign = hooksFilePath(dir)
      if (existsSync(foreign)) {
        throw new ValidationError({
          field: 'read_roots',
          value: dir,
          expected: `a read root without its own .agents/hooks.json — agy loads hook files from every --add-dir, and ${foreign} would run ahead of this job's gate (M10). Remove it from read_roots or move the hook file`,
        })
      }
    }
    const argv = buildAgyArgv({
      prompt: streamInput ? '' : input.prompt,
      addDirs,
      model: input.model ?? null,
      effort: input.effort ?? null,
      mode: input.mode ?? null,
      conversationId,
      inputFormat: streamInput ? 'stream-json' : null,
      outputFormat: 'stream-json',
      printTimeoutMs: timeoutMs,
      jsonSchemaPath,
    })

    const agyBin = resolveAgyBin()
    // Pin the gate's own openStore() to the same project root and state home
    // this server resolved, so a nested repo as `cwd` or an env-override root
    // can never make the gate compute a different, empty database (finding 10).
    const env = buildChildEnv(process.env, { projectRoot: ctx.paths.root, stateHome: stateHome() })

    const effectiveConfig: EffectiveConfig = {
      job_id: jobId,
      session_id: sessionId,
      conversation_id: conversationId,
      cwd,
      profile: profileName,
      model: input.model ?? null,
      effort: input.effort ?? null,
      mode: input.mode ?? null,
      session_mode: sessionMode,
      on_denial: onDenial,
      write_mode: profileDef.write,
      timeout_ms: timeoutMs,
      deadline_at: deadlineAt,
      idle_timeout_ms: idleTimeoutMs,
      expected_artifacts: expectedArtifacts,
      json_schema_path: jsonSchemaPath,
      policy,
      add_dirs: addDirs,
      verify,
      argv,
      agy_bin: agyBin,
      env,
      created_at: now,
    }

    // Same three fields on both replies, from one builder: what the policy
    // ended up as, what the request lost on the way there, and that rendered
    // for a caller who reads prose. A rejected `permissions.allow` collapses
    // the effective allow list to empty — profile defaults included — which is
    // the trap this reports (see policyCeilingBlockers).
    const described = describePolicy(policy)
    const warnings = [...described.warnings]
    if (!policy.ceiling_present) warnings.push(ceilingAbsenceHint(policy.ceiling_path))

    const hasVerifiable =
      (input.expected_artifacts && input.expected_artifacts.length > 0) ||
      Boolean(input.verify_command) ||
      Boolean(input.json_schema)
    if (profileName === 'general_worker' && !hasVerifiable) {
      warnings.push(
        'nothing verifiable requested: the best outcome this job can reach is success_unverified. Pass verify_command (the build or test command), expected_artifacts, or json_schema to make verified_success possible.',
      )
    }

    let preflight: {
      commands: Array<{
        command: string
        decision: 'allow' | 'deny'
        stage: string
        required_rule: string | null
      }>
    } | undefined

    if (input.dry_run && input.expected_commands) {
      const allowRules = parseRulesLenient(policy.allow)
      const denyRules = parseRulesLenient(policy.deny)
      const commandResults: Array<{
        command: string
        decision: 'allow' | 'deny'
        stage: string
        required_rule: string | null
      }> = []
      let deniedCount = 0

      for (const cmd of input.expected_commands) {
        const evalRes = evaluateCommandPolicy(cmd, allowRules, denyRules)
        const decision: 'allow' | 'deny' = evalRes.allowed ? 'allow' : 'deny'
        if (!evalRes.allowed) {
          deniedCount++
        }
        commandResults.push({
          command: cmd,
          decision,
          stage: evalRes.stage,
          required_rule: evalRes.requiredRule,
        })
      }

      preflight = { commands: commandResults }
      if (deniedCount > 0) {
        warnings.push(
          `${deniedCount} of ${input.expected_commands.length} expected_commands would be denied; see preflight.commands`,
        )
      }
    }

    if (input.dry_run) {
      return reply({
        dry_run: true,
        job_id: jobId,
        session_id: sessionId,
        policy_summary: described.policy_summary,
        blockers: described.blockers,
        warnings,
        ...(preflight ? { preflight } : {}),
        effective_config: effectiveConfig,
      })
    }

    // Locks first: a lost race must leave nothing behind, and
    // no DB row references this job_id yet, so there is nothing to unwind.
    acquireJobLocks(ctx.store, {
      jobId,
      cwd,
      writeMode: profileDef.write,
      sessionId,
      maxRunning: ctx.limits.max_running_jobs,
    })

    if (!sessionExists) {
      createSession(ctx.store, {
        sessionId,
        cwd,
        model: input.model ?? null,
        effort: input.effort ?? null,
        profile: profileName,
      })
    }

    createJob(ctx.store, {
      jobId,
      sessionId,
      cwd,
      profile: profileName,
      writeMode: profileDef.write,
      sessionMode,
      onDenial,
      deadlineAt,
      requestedBy: input.requested_by ?? null,
      parentTaskId: input.parent_task_id ?? null,
    })
    chmodDbFiles(ctx.store.paths.db)

    const paths = jobPaths(ctx.paths, jobId)
    ensureJobDirs(paths)

    const request: JobRequest = { ...input }
    writeJsonAtomic(paths.request, request)
    writeJsonAtomic(paths.effectiveConfig, effectiveConfig)
    writeJsonAtomic(paths.policy, policy)

    // Turn 1 of a session-mode job. The runner's inbox relay writes it to agy's
    // stdin as soon as the process is up; `agy_send` appends later turns to the
    // same file. Written before the spawn so the relay can never miss it.
    if (streamInput && input.prompt !== '') {
      appendUserTurn(paths.inbox, input.prompt)
    }

    ensureGateHook(cwd, gatePath)

    // Detached: the runner outlives this server process entirely.
    // stdio is 'ignore' — the runner redirects agy's own stdout/stderr
    // to job-directory files itself; nothing here needs a pipe.
    const child = spawn(process.execPath, [binPath('runner'), jobId], {
      cwd: ctx.paths.root,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    child.unref()

    return reply({
      job_id: jobId,
      session_id: sessionId,
      lifecycle: 'queued',
      profile: profileName,
      cwd,
      session_mode: sessionMode,
      deadline_at: deadlineAt,
      idle_timeout_ms: idleTimeoutMs,
      policy_summary: described.policy_summary,
      blockers: described.blockers,
      warnings,
      dry_run: false,
    })
  } catch (e) {
    return errorReply(e)
  }
}
