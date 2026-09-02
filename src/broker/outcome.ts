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
 * from agy's self-report (`docs/01`, original design §13.3).
 *
 * ⚠ Neither `exit_code === 0` nor `status === 'SUCCESS'` may be treated as
 * success on its own. Measured: a hook denial and a sandbox network block both
 * produce exit 0 and SUCCESS (§9, §11). `verified_success` requires that nothing
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
 * 3. `runnerLost` — the runner vanished without a trace; nothing below this
 *    point can be trusted, because there was nothing to observe it.
 * 4. `pidReused` — the recorded pid is alive but is provably not our process.
 * 5. Otherwise: agy actually ran to some conclusion. Judge it from the exit
 *    code, agy's own status, and — decisively — the broker's own verification.
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

  if (input.hadExpectations) return 'verified_success'
  return 'success_unverified'
}

/** True when every check that could run did run and did pass. */
export function isVerifiedSuccess(input: OutcomeInput): boolean {
  return computeOutcome(input) === 'verified_success'
}

/**
 * One sentence that, together with the log tail, is enough to choose the next
 * action (`docs/04` #17). It states what the broker concluded and why — never a
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

  switch (outcome) {
    case 'verified_success':
      return `verified success: exit 0, agy reported ${input.agentStatus}, ${totalArtifacts} expected artifact(s) confirmed, no permission or environment blocks.${nonBlockingSuffix}`
    case 'success_unverified':
      return `agy exited 0 and reported ${input.agentStatus}, but nothing verifiable (expected_artifacts or a json_schema) was requested — cannot confirm the work actually happened.${nonBlockingSuffix}`
    case 'blocked': {
      const blocking = blockers.filter((b) => b.blocks_outcome)
      return `blocked despite exit ${input.exitCode ?? '?'} / status ${input.agentStatus}: ${summarizeBlockers(blocking)}.${nonBlockingSuffix}`
    }
    case 'failed':
      return input.agentStatus === 'ERROR'
        ? `failed: agy reported ERROR (exit ${input.exitCode ?? '?'}).`
        : `failed: agy exited ${input.exitCode ?? '?'}.`
    case 'timed_out':
      return 'timed out: the job exceeded its deadline and the process group was killed.'
    case 'canceled':
      return 'canceled: agy_cancel stopped this job.'
    case 'process_error':
      return 'process error: the runner vanished without recording an exit code.'
    case 'orphaned':
      return 'orphaned: the recorded pid is alive but belongs to a different process (pid reuse); the job was abandoned.'
  }
}
