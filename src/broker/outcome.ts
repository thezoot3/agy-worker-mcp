import type {
  AgentStatus,
  ContractStatus,
  Lifecycle,
  Outcome,
  Verification,
} from '../contract/types.js'

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

/**
 * Only a `source: 'gate'` Class 1 event is a confirmed refusal (it carries our
 * own `HOOK_DENIAL_PREFIX` marker). `detectClass1` cannot otherwise
 * distinguish an actual permission denial from an ordinary failing tool call
 * (a failing test, a missing file) — counting every Class 1 event as a block
 * would report normal task failures as `blocked` (finding 17).
 */
function confirmedDenialCount(v: Verification): number {
  return v.permission_denials.filter((d) => d.source === 'gate').length
}

function hasBlock(v: Verification): boolean {
  return confirmedDenialCount(v) > 0 || v.environment_blocks.length > 0
}

function hasMissingArtifact(v: Verification): boolean {
  return v.expected_artifacts.some((a) => !a.exists)
}

function computeOutcome(input: OutcomeInput): Outcome {
  if (input.canceled) return 'canceled'
  if (input.timedOut) return 'timed_out'
  if (input.runnerLost) return 'process_error'
  if (input.pidReused) return 'orphaned'

  const exitFailed = input.exitCode !== null && input.exitCode !== 0
  const agentFailed = input.agentStatus === 'ERROR'
  if (exitFailed || agentFailed) return 'failed'

  const blocked = hasBlock(input.verification) || hasMissingArtifact(input.verification)
  if (blocked) return 'blocked'

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
  const v = input.verification
  const denials = confirmedDenialCount(v)
  const blocks = v.environment_blocks.length
  const missing = v.expected_artifacts.filter((a) => !a.exists).length
  const totalArtifacts = v.expected_artifacts.length

  switch (outcome) {
    case 'verified_success':
      return `verified success: exit 0, agy reported ${input.agentStatus}, ${totalArtifacts} expected artifact(s) confirmed, no permission or environment blocks.`
    case 'success_unverified':
      return `agy exited 0 and reported ${input.agentStatus}, but nothing verifiable (expected_artifacts or a json_schema) was requested — cannot confirm the work actually happened.`
    case 'blocked': {
      const parts: string[] = []
      if (denials > 0) parts.push(`${denials} permission denial(s)`)
      if (blocks > 0) parts.push(`${blocks} environment block(s)`)
      if (missing > 0) parts.push(`${missing} of ${totalArtifacts} expected artifact(s) missing`)
      return `blocked despite exit ${input.exitCode ?? '?'} / status ${input.agentStatus}: ${parts.join(', ')}.`
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
