import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { appendJsonLine, jobPaths } from '../contract/paths.js'
import { GATE_DENIAL_MARKER } from '../contract/types.js'
import type {
  GateDecision,
  GateDenialPayload,
  GateLogEntry,
  GatePayload,
  GateVerdict,
  OnDenial,
} from '../contract/types.js'
import {
  firstMatch,
  firstMatchForDenial,
  parseRulesLenient,
  requiredRuleFor,
  subjectFromToolCall,
} from '../policy/rules.js'
import { escapingRedirectTarget } from '../policy/containment.js'
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
 * print `{"decision":"ask"}`. This is the only code in the package that can affect
 * anything outside our own jobs; getting it wrong breaks the user's interactive
 * agy sessions machine-wide.
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
      ? ' 이 job의 on_denial 설정은 abort 이며, 이 거부로 job이 즉시 종료 처리된다.'
      : ''
  return `${guidance}${abortNote} [${GATE_DENIAL_MARKER}${JSON.stringify(payload)}]`
}

/**
 * Pure decision function — no I/O, so it is exhaustively testable.
 *
 * Order is fixed (`docs/03` §1.3) and each step matters:
 *
 * 1. `bound === null` → `ask`, return immediately. Not our job.
 * 2. deny list matches → `deny`
 * 3. allow list matches → `allow` plus `overwrite.Cwd` pinned to the workspace
 * 4. otherwise → the profile default (`deny` for read-only, `ask` for worker)
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
  const subject = subjectFromToolCall(toolName, args)
  const command = subject?.verb === 'command' ? subject.value : null

  const makeLog = (
    decision: GateVerdict,
    policyStage: GateLogEntry['policy'],
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

  if (subject) {
    // Step 0 — containment, ahead of every rule list and independent of
    // `default_decision`.
    //
    // Rule matching is a *prefix* comparison over tokens (`matchCommandPattern`),
    // so `command(ls)` matches `ls -la > /tmp/evil` too: an allow rule cannot
    // constrain what a shell line appends. Measured live on 2026-09-01 — the
    // write landed, under `--sandbox`, with no denial recorded, under both
    // shipped profiles (`docs/02` §4-c). Redirection is the one part of shell
    // grammar small enough to parse reliably, so it is closed here rather than
    // left to the rule lists that structurally cannot see it.
    const escape = command === null ? null : escapingRedirectTarget(command, policy.workspace)
    if (escape !== null) {
      const denialPayload: GateDenialPayload = {
        job_id: job.job_id,
        tool: toolName,
        required_rule: null,
        policy: 'containment',
        on_denial: policy.on_denial,
      }
      const reason = composeDenialReason(
        `이 명령은 워크스페이스 밖(${escape})으로 출력을 리다이렉트한다. 쓰기는 워크스페이스 안에서만 가능하다. 워크스페이스 안 경로로 다시 시도하거나, 파일 쓰기가 목적이면 write_file 도구를 쓸 것.`,
        policy.on_denial,
        denialPayload,
      )
      return {
        decision: { decision: 'deny', reason },
        log: makeLog('deny', 'containment', null, reason),
        requestsAbort: policy.on_denial === 'abort',
      }
    }

    const denyHit = firstMatchForDenial(parseRulesLenient(policy.deny), subject)
    if (denyHit) {
      const denialPayload: GateDenialPayload = {
        job_id: job.job_id,
        tool: toolName,
        required_rule: null,
        policy: 'deny_list',
        on_denial: policy.on_denial,
      }
      const reason = composeDenialReason(
        `이 동작(${denyHit.raw})은 이 job의 정책에서 금지됨. 다른 툴로 우회하지 말고 이 제약을 최종 응답에 그대로 보고할 것.`,
        policy.on_denial,
        denialPayload,
      )
      return {
        decision: { decision: 'deny', reason },
        log: makeLog('deny', 'deny_list', denyHit.raw, reason),
        requestsAbort: policy.on_denial === 'abort',
      }
    }

    const allowHit = firstMatch(parseRulesLenient(policy.allow), subject)
    if (allowHit) {
      return {
        decision: { decision: 'allow', overwrite: { Cwd: policy.workspace } },
        log: makeLog('allow', 'profile_allowlist', allowHit.raw, null),
        requestsAbort: false,
      }
    }
  }

  // Step 4: nothing matched (either no rule covered it, or the tool's args are
  // not one we can classify at all — `subjectFromToolCall` returned null).
  const policyStage: GateLogEntry['policy'] = subject ? 'default' : 'bound_passthrough'

  // `subjectFromToolCall` only classifies `run_command` (docs/02 §9 — every
  // other tool's argument shape is unmeasured); `default_decision` is the
  // profile's verdict for a *classified* action that matched nothing, not for
  // "we cannot tell what this even is". Applying it to an unclassified call
  // too means `research_readonly`'s `deny` default (meant to gate commands
  // and interpreters) denies every `view_file`/`list_dir`-shaped call as a
  // side effect — the exact inversion of "read-only profile permits reading
  // the workspace" that finding 12 describes. Route the unclassifiable case
  // to the safe passthrough instead; real containment for those tools is
  // still an open blocker (finding 12), not something to fake here.
  if (subject && policy.default_decision === 'deny') {
    const requiredRule = subject ? requiredRuleFor(subject) : null
    const denialPayload: GateDenialPayload = {
      job_id: job.job_id,
      tool: toolName,
      required_rule: requiredRule,
      policy: 'default',
      on_denial: policy.on_denial,
    }
    const guidance = requiredRule
      ? `이 동작은 profile "${policy.profile}" 의 허용 목록에 없음. 계속 필요하면 작업을 중단하고 다음 rule 이 필요하다고 최종 응답에 적을 것: ${requiredRule}`
      : `이 동작은 profile "${policy.profile}" 에서 허용되지 않음. 우회하지 말고 이 제약을 보고할 것.`
    const reason = composeDenialReason(guidance, policy.on_denial, denialPayload)
    return {
      decision: { decision: 'deny', reason },
      log: makeLog('deny', policyStage, null, reason),
      requestsAbort: policy.on_denial === 'abort',
    }
  }

  return {
    decision: { decision: 'ask' },
    log: makeLog('ask', policyStage, null, null),
    requestsAbort: false,
  }
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

/**
 * `dist/gate.js` entry point.
 *
 * Wraps everything in a total try/catch whose fallback is {@link PASSTHROUGH}, and
 * always resolves 0 — a non-zero exit from a hook is not a documented signal, and
 * we must not find out what agy does with one.
 *
 * Emits exactly once: the decision is computed and everything that can fail
 * (DB access, binding, logging, the `on_denial: 'abort'` mark) is contained in a
 * try/catch that runs *before* `emit`, and everything after `emit` is itself
 * wrapped so a failure there can never produce a second line on stdout.
 */
export async function main(): Promise<number> {
  const raw = readStdin()
  const payload = parsePayload(raw)
  if (!payload) {
    emit(PASSTHROUGH)
    return 0
  }

  let outcome: GateOutcome = { decision: PASSTHROUGH, log: null, requestsAbort: false }
  let jobDir: string | null = null

  try {
    const store = openStore({ readOnly: true })
    try {
      const bound = bindConversation(store, payload.conversationId)
      outcome = decide({ payload, bound })

      if (bound) {
        jobDir = jobPaths(store.paths, bound.job.job_id).dir

        if (
          outcome.requestsAbort &&
          bound.job.lifecycle !== 'canceling' &&
          bound.job.lifecycle !== 'finished'
        ) {
          // The store above is now genuinely read-only (finding 19), so this
          // one write opens its own short-lived read-write connection rather
          // than widening the hot path everyone else pays for.
          try {
            const writeStore = openStore({ readOnly: false })
            try {
              // Mark only — docs/04 leaves the actual killpg to the broker's
              // reconcile loop, not to the gate.
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
    outcome = { decision: PASSTHROUGH, log: null, requestsAbort: false }
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
