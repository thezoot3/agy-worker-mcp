import type {
  AgentStatus,
  ContractStatus,
  Lifecycle,
  Outcome,
  Verification,
} from '../contract/types.js'
import { hasOutcomeBlocker, summarizeBlockers } from './blockers.js'

/**
 * Decide `outcome` and `headline` — the broker's verdict, kept strictly separate
 * from agy's self-report.
 *
 * ⚠ Neither `exit_code === 0` nor `status === 'SUCCESS'` may be treated as
 * success on its own. Measured: a hook denial and a sandbox network block both
 * produce exit 0 and SUCCESS. `verified_success` requires that nothing
 * was blocked *and* every expected artifact exists.
 */

export interface OutcomeInput {
  lifecycle: Lifecycle
  exitCode: number | null
  /** agy's own claim. An input, never the decision. */
  agentStatus: AgentStatus
  verification: Verification
  /** Set when the deadline fired. */
  timedOut: boolean
  /** Set when `agy_cancel` killed it. */
  canceled: boolean
  /**
   * I4: `state.json.gate_confirmed
   * === false` — the runner's own watchdog killed the job because
   * `gate-log.jsonl` never received a line within 3s of the first tool step, so
   * `hooks.json` never actually loaded and nothing before the kill was
   * policy-checked at all. Forces `process_error`, never `blocked`: a
   * `blocked` verdict implies our gate ran and refused something, which is
   * exactly what did not happen here.
   */
  gateMissing: boolean
  /** Set when the runner vanished without writing `exit_code`. */
  runnerLost: boolean
  /** Set when the recorded pid now belongs to a different process. */
  pidReused: boolean
  /** Whether the caller asked for anything verifiable at all. */
  hadExpectations: boolean
}

export interface OutcomeDecision {
  outcome: Outcome
  contract_status: ContractStatus
  /** One sentence. The first thing a calling agent reads. */
  headline: string
  /** Reasons `verified_success` was withheld, in caller-facing wording. */
  warnings: string[]
}

/**
 * Fixed precedence, most certain fact first:
 *
 * 1. `canceled` — an explicit `agy_cancel` always wins, even over a deadline
 *    that also happened to pass.
 * 2. `timedOut` — the broker's own deadline enforcement fired.
 * 3. `gateMissing` — our own watchdog killed the job because the gate never
 *    confirmed itself (I4); nothing before that point was policy-checked, so
 *    this outranks any verdict `verification.blockers` might otherwise imply.
 * 4. `runnerLost` — the runner vanished without a trace; nothing below this
 *    point can be trusted, because there was nothing to observe it.
 * 5. `pidReused` — the recorded pid is alive but is provably not our process.
 * 6. Otherwise: agy actually ran to some conclusion. Judge it from the exit
 *    code and agy's own status first.
 * 7. `hasOutcomeBlocker` — a confirmed refusal (gate, sandbox, missing
 *    artifact) is `blocked`. Blockers outrank `verify` here on purpose:
 *    "who refused" is a different
 *    question from "did the check pass", and a job that was denied something
 *    is `blocked` even if its `verify_command` also happened to fail.
 * 8. `verify` — PR6. A configured `verify_command` that exited non-zero or hit
 *    its own `verify_timeout_ms` is a job **failure**, never a `Blocker` (that
 *    vocabulary means "who refused", and nothing refused here) — so this reads
 *    `verification.verify` directly rather than going through
 *    `hasOutcomeBlocker`.
 * 9. Otherwise `verified_success` — either because `expected_artifacts`/
 *    `json_schema` were requested and all satisfied, or because a configured
 *    `verify_command` already passed (having survived step 8): a passing
 *    check counts as "actually verified" on its own, even with no
 *    `expected_artifacts` at all. With neither, `success_unverified`.
 */
export function decideOutcome(input: OutcomeInput): OutcomeDecision {
  const outcome = computeOutcome(input)
  const headline = buildHeadline(outcome, input)
  return {
    outcome,
    contract_status: input.verification.contract_status,
    headline,
    warnings: input.verification.warnings,
  }
}

function computeOutcome(input: OutcomeInput): Outcome {
  if (input.canceled) return 'canceled'
  if (input.timedOut) return 'timed_out'
  if (input.gateMissing) return 'process_error'
  if (input.runnerLost) return 'process_error'
  if (input.pidReused) return 'orphaned'

  const exitFailed = input.exitCode !== null && input.exitCode !== 0
  const agentFailed = input.agentStatus === 'ERROR'
  if (exitFailed || agentFailed) return 'failed'

  // One predicate, defined once in `blockers.ts`. A gate denial, a Class 2
  // sandbox block and a missing expected artifact all carry
  // `blocks_outcome: true`; an agy-engine refusal and a plain tool error do
  // not, exactly as before — but the rule now lives in one place instead of
  // three special cases here.
  if (hasOutcomeBlocker(input.verification.blockers)) return 'blocked'

  // PR6: a configured `verify_command` that failed or timed out is a job
  // failure, checked after blockers (a denial wins) and before the
  // expected_artifacts / hadExpectations logic below.
  const verify = input.verification.verify
  if (verify && (verify.exit_code !== 0 || verify.timed_out)) return 'failed'

  // Reaching here with `verify` non-null means it passed (exit 0, not timed
  // out) — that alone is "a check actually passed", so it counts toward
  // verified_success even when nothing else (expected_artifacts/json_schema)
  // was requested.
  if (verify || input.hadExpectations) return 'verified_success'
  return 'success_unverified'
}

/** True when every check that could run did run and did pass. */
export function isVerifiedSuccess(input: OutcomeInput): boolean {
  return computeOutcome(input) === 'verified_success'
}

/**
 * One sentence that, together with the log tail, is enough to choose the next
 * action. It states what the broker concluded and why — never a
 * paraphrase of agy's own response text.
 */
export function buildHeadline(outcome: Outcome, input: OutcomeInput): string {
  const blockers = input.verification.blockers
  const totalArtifacts = input.verification.expected_artifacts.length

  // Blockers that did not force the verdict are still worth a fragment: an
  // agy-engine refusal is invisible everywhere else in the packet, and staying
  // silent about it in a success headline is how a half-done job reads as done.
  // It is a fragment, never the verdict.
  const nonBlocking = blockers.filter((b) => !b.blocks_outcome)
  const nonBlockingSuffix =
    nonBlocking.length > 0 ? ` (non-blocking: ${summarizeBlockers(nonBlocking)})` : ''

  let headline: string
  switch (outcome) {
    case 'verified_success':
      headline = `verified success: exit 0, agy reported ${input.agentStatus}, ${totalArtifacts} expected artifact(s) confirmed, no permission or environment blocks.${nonBlockingSuffix}`
      break
    case 'success_unverified':
      headline = `agy exited 0 and reported ${input.agentStatus}, but nothing verifiable (expected_artifacts, json_schema, or a passing verify_command) was requested — cannot confirm the work actually happened.${nonBlockingSuffix}`
      break
    case 'blocked': {
      const blocking = blockers.filter((b) => b.blocks_outcome)
      headline = `blocked despite exit ${input.exitCode ?? '?'} / status ${input.agentStatus}: ${summarizeBlockers(blocking)}.${nonBlockingSuffix}`
      break
    }
    case 'failed':
      headline =
        input.agentStatus === 'ERROR'
          ? `failed: agy reported ERROR (exit ${input.exitCode ?? '?'}).`
          : `failed: agy exited ${input.exitCode ?? '?'}.`
      break
    case 'timed_out':
      headline = 'timed out: the job exceeded its deadline and the process group was killed.'
      break
    case 'canceled':
      headline = 'canceled: agy_cancel stopped this job.'
      break
    case 'process_error':
      headline = input.gateMissing
        ? 'process error: gate hook never fired; hooks.json was not loaded — the job was killed before any of its tool calls could be trusted.'
        : 'process error: the runner vanished without recording an exit code.'
      break
    case 'orphaned':
      headline = 'orphaned: the recorded pid is alive but belongs to a different process (pid reuse); the job was abandoned.'
      break
  }

  return headline + verifyFragment(input)
}

/**
 * ` verify: exit <code> (<duration>s).` / ` verify: timed out after <s>s.`,
 * appended whenever `verify_command` ran (PR6 §6.3) — regardless of `outcome`,
 * since a caller reading any headline should be able to see the check ran and
 * how it went, not just when it happened to be the deciding fact.
 */
function verifyFragment(input: OutcomeInput): string {
  const v = input.verification.verify
  if (!v) return ''
  const seconds = (v.duration_ms / 1000).toFixed(1)
  return v.timed_out
    ? ` verify: timed out after ${seconds}s.`
    : ` verify: exit ${v.exit_code ?? '?'} (${seconds}s).`
}
