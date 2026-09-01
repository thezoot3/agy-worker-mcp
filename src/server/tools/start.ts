import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { z } from 'zod'

import { ValidationError } from '../../contract/errors.js'
import {
  assertContained,
  binPath,
  ensureJobDirs,
  jobPaths,
  newJobId,
  newSessionId,
  readJsonIfExists,
  stateHome,
  writeJsonAtomic,
} from '../../contract/paths.js'
import type { EffectiveConfig, JobRequest } from '../../contract/types.js'
import { cleanupOldJobs, reconcile } from '../../broker/reconcile.js'
import { getProfile, resolvePolicy } from '../../policy/profiles.js'
import { buildAgyArgv, buildChildEnv, resolveAgyBin } from '../../runner/spawn.js'
import { acquireJobLocks } from '../../store/locks.js'
import { createJob, listJobs, LIVE_LIFECYCLES } from '../../store/jobs.js'
import { createSession, getSession } from '../../store/sessions.js'
import { errorReply, reply, type ToolContext, type ToolReply } from '../context.js'

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
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
      network: z.enum(['allow', 'deny']).optional(),
    })
    .optional()
    .describe('Narrowing only. allow is intersected with the profile ceiling; deny always wins.'),
  on_denial: z
    .enum(['abort', 'continue', 'guide'])
    .optional()
    .describe('What to do on the first policy denial. Default continue.'),
  timeout_ms: z.number().int().positive().optional(),
  expected_artifacts: z
    .array(z.string())
    .optional()
    .describe('Workspace-relative paths that must exist afterwards. Missing ones block verified_success.'),
  json_schema: z.string().optional().describe('Path to a JSON schema for structured output.'),
  requested_by: z.string().optional(),
  parent_task_id: z.string().optional(),
  dry_run: z
    .boolean()
    .optional()
    .describe('Resolve configuration and policy without spawning agy. Costs no quota.'),
})

export type StartInput = z.infer<typeof startInput>

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max)
}

const GATE_HOOK_KEY = 'agy-worker-gate'

/** Single-quote for a POSIX `sh -c` string, escaping any embedded `'`. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Write (merging, never clobbering unrelated keys) `<workspace>/.agents/hooks.json`
 * so the PreToolUse gate loads for this workspace. `--add-dir` is what makes agy
 * load it at all (`docs/02` §3, `docs/03` §1.2) — this is the piece that puts the
 * file there in the first place, since nothing else in the package owns it.
 *
 * The command is quoted (an unquoted absolute path breaks on any install path
 * containing a space) and wrapped with a fail-open fallback: if `node` cannot
 * even start the gate script (e.g. an npx cache eviction removed it), the hook
 * still emits `{"decision":"ask"}` — a passthrough — instead of the empty
 * stdout that `sh -c` would otherwise produce, which agy's hook contract reads
 * as an unconditional deny for every tool call in this workspace, including the
 * user's own unrelated interactive agy sessions (finding 11).
 */
function ensureGateHooks(workspace: string): void {
  const hooksPath = join(workspace, '.agents', 'hooks.json')
  const gatePath = binPath('gate')
  const existing = readJsonIfExists<Record<string, unknown>>(hooksPath) ?? {}
  const command = `node ${shQuote(gatePath)} || printf '{"decision":"ask"}'`
  existing[GATE_HOOK_KEY] = {
    PreToolUse: [
      {
        matcher: '*',
        hooks: [{ type: 'command', command, timeout: 15 }],
      },
    ],
  }
  writeJsonAtomic(hooksPath, existing)
}

/** Opportunistic retention window for finished job directories (`docs/04`, cleanup). */
const CLEANUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export async function handleStart(ctx: ToolContext, input: StartInput): Promise<ToolReply> {
  try {
    await reconcile(ctx.store)
    cleanupOldJobs(ctx.store, CLEANUP_MAX_AGE_MS)

    const profileName = input.profile ?? 'research_readonly'
    const profileDef = getProfile(profileName)

    const rawCwd = input.cwd ?? ctx.paths.root
    const cwd = assertContained(rawCwd, [ctx.paths.root], 'write')

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
    // `--json-schema <path>` hands agy an arbitrary file to read; without
    // containment a client could point it outside the workspace (finding 18).
    const jsonSchemaPath = input.json_schema
      ? assertContained(input.json_schema, [ctx.paths.root], 'read')
      : null
    const expectedArtifacts = input.expected_artifacts ?? []

    const policy = resolvePolicy({
      profile: profileName,
      workspace: cwd,
      requested: input.permissions,
      onDenial,
    })

    const jobId = newJobId()
    const now = Date.now()
    const deadlineAt = now + timeoutMs

    // ⚠ Whether `--input-format stream-json` may coexist with `--print=<prompt>`
    // for turn 1 of a session-mode job is not in `docs/02` — only the two forms in
    // isolation are measured (§2). This composes them; flagged as a
    // blocker/assumption for verification against real agy.
    const argv = buildAgyArgv({
      prompt: input.prompt,
      addDir: cwd,
      model: input.model ?? null,
      effort: input.effort ?? null,
      mode: input.mode ?? null,
      sandbox: true,
      conversationId,
      inputFormat: sessionMode === 'session' ? 'stream-json' : null,
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
      expected_artifacts: expectedArtifacts,
      json_schema_path: jsonSchemaPath,
      policy,
      argv,
      agy_bin: agyBin,
      env,
      created_at: now,
    }

    if (input.dry_run) {
      return reply({ dry_run: true, job_id: jobId, session_id: sessionId, effective_config: effectiveConfig })
    }

    // Locks first (`docs/01` 결정 4): a lost race must leave nothing behind, and
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

    const paths = jobPaths(ctx.paths, jobId)
    ensureJobDirs(paths)

    const request: JobRequest = { ...input }
    writeJsonAtomic(paths.request, request)
    writeJsonAtomic(paths.effectiveConfig, effectiveConfig)
    writeJsonAtomic(paths.policy, policy)

    ensureGateHooks(cwd)

    // Detached: the runner outlives this server process entirely (`docs/01`
    // 결정 1). stdio is 'ignore' — the runner redirects agy's own stdout/stderr
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
      dry_run: false,
    })
  } catch (e) {
    return errorReply(e)
  }
}
