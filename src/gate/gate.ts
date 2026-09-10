import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { appendJsonLine, chmodDbFiles, jobPaths } from '../contract/paths.js'
import { GATE_DENIAL_MARKER } from '../contract/types.js'
import type {
  EffectivePolicy,
  GateDecision,
  GateDecisionStage,
  GateDenialPayload,
  GateLogEntry,
  GatePayload,
  OnDenial,
} from '../contract/types.js'
import { evaluateCommandPolicy, firstMatch, firstMatchForDenial, parseRulesLenient, requiredRuleFor } from '../policy/rules.js'
import { seatbeltCommandLine } from '../policy/seatbelt.js'
import { ALLOWED_DEV_READS, assignmentReadPaths, commandMutationWritePaths, extractCommandContainment, isAgentsPath, isContainedForKind, type ContainmentRoots } from '../policy/containment.js'
import { isCredentialPath } from '../policy/hard-deny.js'
import { classifyToolCall } from '../policy/tools.js'
import type { BoundJob } from './bind.js'
import { bindConversation } from './bind.js'
import { openStore } from '../store/db.js'
import { updateJob } from '../store/jobs.js'

/**
 * The PreToolUse hook. Spawned fresh for every single tool call, so it must stay
 * cheap — no warm caches, no heavy imports, no network.
 *
 * ⚠⚠ The one absolute rule of this file: **something with a `decision` field must
 * reach stdout on every path.** `{}` and empty output are denials (§9). A crash,
 * a JSON parse failure, a locked database, a missing job — all of them must still
 * print a `decision`. This is the only code in the package that can affect
 * anything outside our own jobs; getting it wrong breaks the user's interactive
 * agy sessions machine-wide.
 *
 * That decision is not always `ask` any more (0.2.0, I1/I3). A *bound* job's gate never answers
 * `ask` — every tool call is either allowed or denied, and any failure once we
 * know a call is ours becomes `deny`, not a silent pass-through. `ask` survives
 * only for the two cases where we genuinely cannot tell whose call this is: a
 * payload we could not parse at all, and a `conversationId` that binds to none
 * of our jobs (someone's own interactive agy session, which this package must
 * never touch). Failing `ask` there is still correct because agy itself fails
 * closed on anything else a hook can produce — a non-zero exit or output that
 * does not parse as JSON is a *denial*, not a pass-through (measured against
 * 1.1.23, §9) — so `ask` in print mode is the one output that reliably reaches
 * agy's own built-in engine and, for a job we cannot identify, that engine's
 * ordinary confirmation-under-`--dangerously-skip-permissions` behaviour is
 * exactly what the user asked for by running their own session (M3-C:
 * with no `overwrite.BypassSandbox`, the model's own value wins).
 */

/** The safe pass-through. Delegates to agy's built-in engine. Never `{}`. */
export const PASSTHROUGH: GateDecision = { decision: 'ask' }

export interface GateDecideInput {
  payload: GatePayload
  /** Null when the conversation is not one of ours. */
  bound: BoundJob | null
}

export interface GateOutcome {
  decision: GateDecision
  /** Row to append to `gate-log.jsonl`; null when we are not logging (unbound). */
  log: GateLogEntry | null
  /** True when `on_denial === 'abort'` and this call was denied. */
  requestsAbort: boolean
}

/**
 * `<guidance sentence> [agy-worker-denial:{"required_rule":...}]` — agy passes
 * `reason` to the model verbatim (measured, §10), so the human sentence goes
 * first and the machine payload our own `events/detect.ts` parses trails it.
 */
function composeDenialReason(guidance: string, onDenial: OnDenial, payload: GateDenialPayload): string {
  const abortNote =
    onDenial === 'abort'
      ? ' This job is configured with on_denial: "abort" and will be terminated immediately due to this denial.'
      : ''
  return `${guidance}${abortNote} [${GATE_DENIAL_MARKER}${JSON.stringify(payload)}]`
}

/**
 * Pure decision function — no I/O, so it is exhaustively testable.
 *
 * Order is fixed (see docs/permissions.md) and each step matters:
 *
 * 1. `bound === null` → `ask`, return immediately. Not our job (§1.3 step 1).
 * 2. `unsupported` (unclassifiable tool, or a subagent tool — M2) → `deny`,
 *    `required_rule: null`.
 * 3. `control` (`manage_task`) → `allow`, no overwrite.
 * 4. containment (write outside `write_roots` or into `{workspace}/.agents`
 *    — I6; read outside `read_roots`) → `deny`, ahead of every rule list.
 * 5. deny list matches → `deny`.
 * 6. allow list matches → `allow`; `run_command` additionally pins
 *    `overwrite.Cwd` and sets `overwrite.BypassSandbox` from `policy.bypass_sandbox`
 *    (I2) — every allow explicitly decides sandboxing, never leaves it to the
 *    model (M3 variant C: an unset overwrite lets the model's own value win).
 * 7. otherwise → `deny`, `required_rule` filled in. I1: a bound job's gate
 *    never answers `ask` — `default_decision` is gone.
 *
 * A `deny` reason is an instruction channel, not an explanation: agy hands the
 * string to the model verbatim (§10), so it should name the permitted alternative
 * and carry a parsable `GATE_DENIAL_MARKER` payload for the broker.
 */
export function decide(input: GateDecideInput): GateOutcome {
  const { payload, bound } = input

  if (!bound) {
    return { decision: PASSTHROUGH, log: null, requestsAbort: false }
  }

  const { job, policy, conversationId } = bound
  const toolName = payload.toolCall?.name ?? 'unknown'
  const args = payload.toolCall?.args ?? {}
  const stepIdx = typeof payload.stepIdx === 'number' ? payload.stepIdx : null
  const toolClass = classifyToolCall(toolName, args, policy.workspace)
  const command =
    toolClass.kind === 'subject' && toolClass.subject.verb === 'command' ? toolClass.subject.value : null

  const makeLog = (
    decision: GateLogEntry['decision'],
    policyStage: GateDecisionStage,
    matchedRule: string | null,
    reason: string | null,
  ): GateLogEntry => ({
    ts: Date.now(),
    job_id: job.job_id,
    conversation_id: conversationId,
    step_idx: stepIdx,
    tool: toolName,
    command,
    decision,
    policy: policyStage,
    matched_rule: matchedRule,
    reason,
  })

  /** Every `deny` in this function goes through here so the payload/log/reason stay in lockstep. */
  const denyWith = (
    policyStage: GateDecisionStage,
    requiredRule: string | null,
    guidance: string,
    options?: { requestsAbort?: boolean; matchedRule?: string | null },
  ): GateOutcome => {
    const denialPayload: GateDenialPayload = {
      job_id: job.job_id,
      tool: toolName,
      required_rule: requiredRule,
      policy: policyStage,
      on_denial: policy.on_denial,
    }
    const reason = composeDenialReason(guidance, policy.on_denial, denialPayload)
    return {
      decision: { decision: 'deny', reason },
      log: makeLog('deny', policyStage, options?.matchedRule ?? null, reason),
      requestsAbort: options?.requestsAbort ?? (policy.on_denial === 'abort'),
    }
  }

  // Step 2 (§2.2): unclassifiable or subagent tool.
  // 0.3.0 PR5: an unsupported tool call sets requestsAbort: false, EXCEPT when
  // it is a subagent tool (M2). Subagents attempt to bypass policy by running
  // under an unbound conversationId, so they must abort when on_denial === 'abort'.
  // But a single call to an unclassified tool such as schedule is not a policy
  // violation, and a flaky tool retry should not cost the whole job.
  if (toolClass.kind === 'unsupported') {
    const requestsAbort = toolClass.subagent && policy.on_denial === 'abort'
    return denyWith('unsupported', null, toolClass.reason, { requestsAbort })
  }

  // Step 3: `manage_task` — conversation-scoped bookkeeping, not a rule subject.
  if (toolClass.kind === 'control') {
    return {
      decision: { decision: 'allow' },
      log: makeLog('allow', 'control', null, null),
      requestsAbort: false,
    }
  }

  // toolClass.kind === 'subject' from here.
  const { subject } = toolClass
  const roots: ContainmentRoots = { read: policy.read_roots, write: policy.write_roots }

  // Step 4: containment & credential HARD_DENY, ahead of every rule list.
  const commandLine = toolName === 'run_command' && typeof args.CommandLine === 'string' ? args.CommandLine : null

  if (toolName === 'run_command' && commandLine !== null) {
    const analysis = extractCommandContainment(commandLine, policy.workspace)

    // Item 1: Unexpanded shell expansions in path positions
    if (analysis.unexpandedPath) {
      return denyWith(
        'containment',
        null,
        `unexpanded_path: Path argument (${analysis.unexpandedPath}) contains unexpanded shell expansions ($VAR, backticks, or non-leading ~) and cannot be verified. Expand the path to an absolute path or a workspace-relative path and retry (globs *, ?, and [ are evaluated against literal directories, so they may be used as-is).`,
      )
    }

    // Item 3: Credential HARD_DENY for commands
    for (const p of analysis.candidatePaths) {
      if (isCredentialPath(p)) {
        return denyWith(
          'deny_list',
          null,
          `hard_deny: credential path protected: ${p}`,
          { matchedRule: 'hard_deny' },
        )
      }
    }

    // Item 4 & 5: Write containment (resolved against policy.workspace, never args.Cwd)
    const allWrite = analysis.writePaths
    for (const w of allWrite) {
      if (isAgentsPath(w, policy.workspace)) {
        return denyWith(
          'containment',
          null,
          `This action attempts to write inside ${policy.workspace}/.agents (${w}). This directory contains the gate's own hook configuration and is always write-protected against all modifications including shell redirection (I6). Use a different path.`,
        )
      }
      if (!isContainedForKind(w, roots, 'write')) {
        return denyWith(
          'containment',
          null,
          `This action attempts to write outside the workspace (${w}). Writes are permitted only within the workspace. Retry with a path inside the workspace.`,
        )
      }
    }

    // Item 2: Read-side containment for shell commands
    const allRead = [...new Set([...analysis.readPaths, ...assignmentReadPaths(commandLine)])]
    for (const r of allRead) {
      if (ALLOWED_DEV_READS.has(r)) continue
      if (!isContainedForKind(r, roots, 'read')) {
        return denyWith(
          'containment',
          null,
          `read_outside_workspace: This action attempts to read outside the workspace (${r}). Reads are permitted only within the workspace.`,
        )
      }
    }
  } else {
    for (const w of toolClass.write) {
      if (isAgentsPath(w, policy.workspace)) {
        return denyWith(
          'containment',
          null,
          `This action attempts to write inside ${policy.workspace}/.agents (${w}). This directory contains the gate's own hook configuration and is always write-protected against all modifications including shell redirection (I6). Use a different path.`,
        )
      }
      if (!isContainedForKind(w, roots, 'write')) {
        return denyWith(
          'containment',
          null,
          `This action attempts to write outside the workspace (${w}). Writes are permitted only within the workspace. Retry with a path inside the workspace.`,
        )
      }
    }

    for (const r of toolClass.read) {
      if (!isContainedForKind(r, roots, 'read')) {
        return denyWith(
          'containment',
          null,
          `This action attempts to read outside the workspace (${r}). Reads are permitted only within the workspace.`,
        )
      }
    }
  }

  // Step 5: deny list.
  const denyHit = firstMatchForDenial(parseRulesLenient(policy.deny), subject)
  if (denyHit) {
    return denyWith(
      'deny_list',
      null,
      `This action (${denyHit.raw}) is denied by this job's policy. Do not attempt to bypass this constraint with another tool; report this restriction directly in your final response.`,
    )
  }

  // Step 6 & 7 for command:
  if (subject.verb === 'command') {
    const cmdEval = evaluateCommandPolicy(
      subject.value,
      parseRulesLenient(policy.allow),
      parseRulesLenient(policy.deny),
      0,
      // The workspace is a security boundary for the interpreter rules
      // (`command(node)`, `command(python3)`), so it is passed rather than
      // inferred: the gate runs as a hook agy spawns, and its own cwd is not
      // guaranteed to be the workspace.
      policy.workspace,
    )
    if (cmdEval.allowed) {
      const overwrite = commandOverwrite(policy, subject.value)
      return {
        decision: { decision: 'allow', overwrite },
        log: makeLog('allow', 'profile_allowlist', cmdEval.matchedRule, null),
        requestsAbort: false,
      }
    }
    if (cmdEval.stage === 'deny_list') {
      const guidance =
        cmdEval.reason === 'env_assignment_denied'
          ? 'env_assignment_denied'
          : `This action is denied by this job's policy. Do not attempt to bypass this constraint with another tool; report this restriction directly in your final response.`
      return denyWith('deny_list', null, guidance)
    }
    // stage === 'default'
    if (policy.command_policy === 'denylist') {
      const overwrite = commandOverwrite(policy, subject.value)
      return {
        decision: { decision: 'allow', overwrite },
        log: makeLog('allow', 'denylist_default', null, null),
        requestsAbort: false,
      }
    }
    return denyWith(
      'default',
      cmdEval.requiredRule,
      `This action is not in the allowlist for profile "${policy.profile}". If it remains necessary, stop execution and report in your final response that the following rule is required: ${cmdEval.requiredRule}`,
    )
  }

  // Step 6: allow list (for non-command subjects).
  const allowHit = firstMatch(parseRulesLenient(policy.allow), subject)
  if (allowHit) {
    return {
      decision: { decision: 'allow' },
      log: makeLog('allow', 'profile_allowlist', allowHit.raw, null),
      requestsAbort: false,
    }
  }

  // Step 7: nothing matched. I1 — a bound job's gate never answers `ask`;
  // `default_decision` is gone, so this is always `deny`.
  const requiredRule = requiredRuleFor(subject)
  return denyWith(
    'default',
    requiredRule,
    `This action is not in the allowlist for profile "${policy.profile}". If it remains necessary, stop execution and report in your final response that the following rule is required: ${requiredRule}`,
  )
}

/**
 * The `overwrite` every allowed `run_command` carries. `Cwd` is pinned to the
 * workspace and `BypassSandbox` is always explicit (I2, M3 variant C). Under
 * `sandbox: 'seatbelt'` the command itself is rewritten to run inside our own
 * write-only profile (M9: `overwrite.CommandLine` is honoured by agy; the
 * model and the event stream still see the original) with agy's sandbox off.
 */
export function commandOverwrite(
  policy: EffectivePolicy,
  commandLine: string,
): { Cwd: string; BypassSandbox: boolean; CommandLine?: string } {
  if (policy.sandbox === 'seatbelt') {
    return {
      Cwd: policy.workspace,
      BypassSandbox: true,
      CommandLine: seatbeltCommandLine(commandLine, policy.seatbelt_write_roots),
    }
  }
  return { Cwd: policy.workspace, BypassSandbox: policy.bypass_sandbox }
}

/**
 * Count the number of 'deny' decisions in a gate-log.jsonl content string.
 * Tolerates empty strings, trailing newlines, and malformed lines.
 */
export function countDeniesInGateLog(text: string): number {
  if (!text) return 0
  let count = 0
  const lines = text.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as { decision?: unknown }
      if (parsed && typeof parsed === 'object' && parsed.decision === 'deny') {
        count++
      }
    } catch {
      // ignore malformed lines
    }
  }
  return count
}

/** Read stdin to EOF. Returns null on any failure — the caller then passes through. */
export function readStdin(): string | null {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return null
  }
}

/** Tolerant payload parse. Null when the shape is unusable; never throws. */
export function parsePayload(raw: string | null): GatePayload | null {
  if (!raw || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const p = parsed as Record<string, unknown>

    if (typeof p.conversationId !== 'string' || p.conversationId.length === 0) return null

    const toolCallRaw = p.toolCall
    if (!toolCallRaw || typeof toolCallRaw !== 'object') return null
    const toolCall = toolCallRaw as Record<string, unknown>
    if (typeof toolCall.name !== 'string' || toolCall.name.length === 0) return null

    const args =
      toolCall.args && typeof toolCall.args === 'object'
        ? (toolCall.args as Record<string, unknown>)
        : undefined

    return {
      conversationId: p.conversationId,
      stepIdx: typeof p.stepIdx === 'number' ? p.stepIdx : undefined,
      modelName: typeof p.modelName === 'string' ? p.modelName : undefined,
      toolCall: { name: toolCall.name, args },
      workspacePaths: Array.isArray(p.workspacePaths)
        ? (p.workspacePaths.filter((x): x is string => typeof x === 'string'))
        : undefined,
      transcriptPath: typeof p.transcriptPath === 'string' ? p.transcriptPath : undefined,
      artifactDirectoryPath:
        typeof p.artifactDirectoryPath === 'string' ? p.artifactDirectoryPath : undefined,
    }
  } catch {
    return null
  }
}

/** Write the decision to stdout as one line. The only place that writes stdout. */
/**
 * Captured before {@link guardStdout} neuters the public one, so this stays the
 * only path to the real file descriptor.
 */
const realStdoutWrite: (chunk: string) => boolean = process.stdout.write.bind(process.stdout)

let emitted = false

/**
 * Make stdout write-once and pollution-proof.
 *
 * Measured against agy 1.1.23: a hook that exits 0 but whose stdout does not
 * parse is a DENIAL, not a passthrough —
 *   failed to unmarshal result from hook ... via protojson: not json at all
 * and this process always exits 0 (see `src/gate.ts`), so the
 * `|| printf '{"decision":"ask"}'` fallback in `hooks.json` — which only fires
 * on a non-zero exit — cannot cover it. One stray `console.log` from anywhere
 * in the import graph would therefore deny every tool call in the workspace,
 * including the user's own interactive agy sessions.
 *
 * So: everything except {@link emit} is swallowed, and only the first decision
 * is written.
 */
export function guardStdout(): void {
  process.stdout.write = ((
    _chunk: unknown,
    encoding?: unknown,
    cb?: unknown,
  ): boolean => {
    const done = typeof encoding === 'function' ? encoding : cb
    if (typeof done === 'function') (done as () => void)()
    return true
  }) as typeof process.stdout.write
}

export function emit(decision: GateDecision): void {
  if (emitted) return
  emitted = true
  realStdoutWrite(JSON.stringify(decision))
}

/** Test seam: `emitted` is module state and every test needs a clean one. */
export function resetEmitForTests(): void {
  emitted = false
}

/** Append to `gate-log.jsonl`. Every verdict is recorded, allows included (§1.8). */
export function logDecision(jobDir: string, entry: GateLogEntry): void {
  appendJsonLine(join(jobDir, 'gate-log.jsonl'), entry)
}

/** `deny` reason used when the store cannot even be opened (§2.3). No job to log against. */
const STATE_UNAVAILABLE: GateDecision = { decision: 'deny', reason: 'agy-worker gate: state unavailable' }
/** `deny` reason for any failure once we are past "open the store" (§2.3). */
const INTERNAL_ERROR: GateDecision = { decision: 'deny', reason: 'agy-worker gate: internal error' }

/**
 * `dist/gate.js` entry point.
 *
 * Always resolves 0 — a non-zero exit from a hook is not a documented signal,
 * and we must not find out what agy does with one. Emits exactly once: the
 * decision is computed and everything that can fail (DB access, binding,
 * logging, the `on_denial: 'abort'` mark) is contained in a try/catch that
 * runs *before* `emit`, and everything after `emit` is itself wrapped so a
 * failure there can never produce a second line on stdout.
 *
 * Failure paths (not all of them are
 * `ask` any more, since I1 only protects a *bound* job's decision, not the
 * gate process's own health):
 *   - unparsable payload → `ask` (we cannot even tell whose call this is —
 *     handled above, before this function's own try/catch begins).
 *   - the store cannot be opened at all → `deny`, `state unavailable`. A
 *     broken `AGY_WORKER_HOME`/project dir means we cannot tell bound from
 *     unbound either, but unlike a parse failure this is *our* infrastructure
 *     breaking, not a payload shape we cannot read — failing open here would
 *     mean every tool call in every workspace runs unguarded the moment our
 *     own state directory has a problem.
 *   - `bindConversation` resolves and the conversation is not one of ours →
 *     `ask` (unchanged; `decide()` returns `PASSTHROUGH` for `bound === null`
 *     without throwing, so this falls out of the ordinary call below).
 *   - the store opened and anything after that throws → `deny`, `internal
 *     error`. By this point we hold a real, open connection; failing closed
 *     is strictly safer than guessing `ask` and letting agy's own engine (or
 *     the model, per M3-C) decide unsupervised.
 */
export async function main(): Promise<number> {
  const raw = readStdin()
  const payload = parsePayload(raw)
  if (!payload) {
    emit(PASSTHROUGH)
    return 0
  }

  let outcome: GateOutcome = { decision: INTERNAL_ERROR, log: null, requestsAbort: false }
  let jobDir: string | null = null

  let store: ReturnType<typeof openStore>
  try {
    store = openStore({ readOnly: true })
    chmodDbFiles(store.paths.db)
  } catch {
    emit(STATE_UNAVAILABLE)
    return 0
  }

  try {
    try {
      const bound = bindConversation(store, payload.conversationId)
      outcome = decide({ payload, bound })

      if (bound) {
        jobDir = jobPaths(store.paths, bound.job.job_id).dir

        let reachedMaxDenials = false
        if (
          outcome.log?.decision === 'deny' &&
          typeof bound.policy.max_denials === 'number' &&
          bound.job.lifecycle !== 'canceling' &&
          bound.job.lifecycle !== 'finished'
        ) {
          const gateLogFile = jobPaths(store.paths, bound.job.job_id).gateLog
          let existingDenies = 0
          try {
            if (existsSync(gateLogFile)) {
              existingDenies = countDeniesInGateLog(readFileSync(gateLogFile, 'utf8'))
            }
          } catch {
            // Best effort; tolerate missing or unreadable gate-log.
          }
          reachedMaxDenials = existingDenies + 1 >= bound.policy.max_denials
        }

        const shouldAbort =
          (outcome.requestsAbort || reachedMaxDenials) &&
          bound.job.lifecycle !== 'canceling' &&
          bound.job.lifecycle !== 'finished'

        if (shouldAbort) {
          const abortReason: 'on_denial' | 'max_denials' = outcome.requestsAbort
            ? 'on_denial'
            : 'max_denials'
          if (outcome.log) {
            outcome.log.abort_reason = abortReason
          }
          // The store above is now genuinely read-only (finding 19), so this
          // one write opens its own short-lived read-write connection rather
          // than widening the hot path everyone else pays for.
          try {
            const writeStore = openStore({ readOnly: false })
            chmodDbFiles(writeStore.paths.db)
            try {
              // Mark only — the actual killpg is handled by the broker's
              // reconcile loop, not by the gate.
              updateJob(writeStore, bound.job.job_id, { lifecycle: 'canceling' })
            } finally {
              writeStore.close()
            }
          } catch {
            // Best effort; the deadline / next reconcile still catches it.
          }
        }
      }
    } finally {
      store.close()
    }
  } catch {
    // Past this point we had a real store connection open — fail closed
    // rather than passing through (§2.3's "bound, later exception" row).
    outcome = { decision: INTERNAL_ERROR, log: null, requestsAbort: false }
    jobDir = null
  }

  emit(outcome.decision)

  if (jobDir && outcome.log) {
    try {
      logDecision(jobDir, outcome.log)
    } catch {
      // Logging is best-effort; the decision already reached stdout.
    }
  }

  return 0
}
