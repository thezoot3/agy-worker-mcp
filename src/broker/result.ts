import type {
  AgentReport,
  AgyEvent,
  BrokerResult,
  BrokerSummary,
  JobRow,
  JudgementPacket,
} from '../contract/types.js'
import type { JobPaths } from '../contract/paths.js'
import { readJsonIfExists, writeJsonAtomic } from '../contract/paths.js'
import { normalizeEvent, tailSummary } from '../events/normalize.js'
import { lastResult } from '../events/parse.js'
import type { Store } from '../store/db.js'
import { decideOutcome } from './outcome.js'
import { verifyJob } from './verify.js'

/**
 * `broker-result.json` is the single source of truth.
 *
 * `agy_wait` projects a subset of it, `agy_result` pages all of it, and nothing
 * else recomputes `outcome` — if a tool derives its own verdict, two callers can
 * be told different things about the same job.
 */

export interface BuildResultInput {
  job: JobRow
  events: AgyEvent[]
  malformedLines: number
  exitCode: number | null
  timedOut: boolean
  canceled: boolean
  runnerLost: boolean
  pidReused: boolean
  expectedArtifacts: string[]
  jsonSchemaPath: string | null
  /**
   * `idle_timeout_ms` when the runner's idle watchdog ended the session, null
   * otherwise. A clean exit 0, so nothing here changes the outcome — but the
   * caller cannot otherwise tell an idle close from an ordinary finish, and the
   * two call for different next steps.
   */
  idleClosedAfterMs: number | null
  now: number
}

const DEFAULT_LOG_TAIL_LINES = 40

export function buildBrokerResult(store: Store, input: BuildResultInput): BrokerResult {
  const verification = verifyJob(store, {
    job: input.job,
    events: input.events,
    expectedArtifacts: input.expectedArtifacts,
    cwd: input.job.cwd,
    // Where a captured --json-schema payload actually lands on the wire is
    // unmeasured (see verify.ts checkContract) — nothing to pass through yet.
    structuredOutput: undefined,
    jsonSchemaPath: input.jsonSchemaPath,
  })

  if (input.idleClosedAfterMs !== null) {
    verification.warnings.push(
      `session closed by idle_timeout_ms (${input.idleClosedAfterMs} ms) with no agy_send after the last turn — resume with agy_start({ session_id })`,
    )
  }

  const agentReport = buildAgentReport(input.events)
  const hadExpectations = input.expectedArtifacts.length > 0 || input.jsonSchemaPath !== null

  const decision = decideOutcome({
    lifecycle: input.job.lifecycle,
    exitCode: input.exitCode,
    agentStatus: agentReport.status,
    verification,
    timedOut: input.timedOut,
    canceled: input.canceled,
    runnerLost: input.runnerLost,
    pidReused: input.pidReused,
    hadExpectations,
  })

  const counts = countEvents(input.events, input.malformedLines)

  const normalized = input.events
    .map((e) => normalizeEvent(e))
    .filter((n): n is NonNullable<typeof n> => n !== null)
  const logTail = tailSummary(normalized, DEFAULT_LOG_TAIL_LINES)

  const durationMs = input.job.started_at !== null ? Math.max(0, input.now - input.job.started_at) : null

  const brokerSummary: BrokerSummary = {
    headline: decision.headline,
    outcome: decision.outcome,
    exit_code: input.exitCode,
    duration_ms: durationMs,
    counts,
    log_tail: logTail,
  }

  return {
    schema_version: 1,
    job_id: input.job.job_id,
    session_id: input.job.session_id,
    conversation_id: agentReport.conversation_id,
    lifecycle: 'finished',
    cwd: input.job.cwd,
    profile: input.job.profile,
    session_mode: input.job.session_mode,
    created_at: input.job.created_at,
    started_at: input.job.started_at,
    finished_at: input.now,
    agent_report: agentReport,
    broker_summary: brokerSummary,
    verification,
    agent_status: agentReport.status,
    contract_status: decision.contract_status,
    structured_output: null,
    finalized_at: input.now,
  }
}

function countEvents(events: AgyEvent[], malformedLines: number): BrokerSummary['counts'] {
  let steps = 0
  let toolCalls = 0
  let toolErrors = 0
  let turns = 0

  for (const e of events) {
    if (e.event === 'result') {
      turns++
      continue
    }
    if (e.event !== 'step_update') continue
    steps++
    const su = e.step_update
    if (su.step_type !== 'tool') continue
    if (su.state === 'DONE') toolCalls++
    if (su.state === 'ERROR') toolErrors++
  }

  return {
    events: events.length,
    steps,
    tool_calls: toolCalls,
    tool_errors: toolErrors,
    turns,
    malformed_lines: malformedLines,
  }
}

/** Extract agy's unverified self-report. Quarantined from `broker_summary` on purpose. */
export function buildAgentReport(events: AgyEvent[]): AgentReport {
  const r = lastResult(events)
  if (!r) {
    return { status: 'unknown', response: null, error: null, num_turns: null, usage: null, conversation_id: null }
  }
  const status = r.result.status === 'SUCCESS' || r.result.status === 'ERROR' ? r.result.status : 'unknown'
  return {
    status,
    response: r.result.response ?? null,
    error: r.result.error ?? null,
    num_turns: r.result.num_turns ?? null,
    usage: r.result.usage ?? null,
    conversation_id: r.result.conversation_id ?? null,
  }
}

/** Atomic write, so a concurrent reader never sees a half-written result. */
export function writeBrokerResult(paths: JobPaths, result: BrokerResult): void {
  writeJsonAtomic(paths.brokerResult, result)
}

/** Null when the job has not been finalized yet. */
export function loadBrokerResult(paths: JobPaths): BrokerResult | null {
  return readJsonIfExists<BrokerResult>(paths.brokerResult)
}

export interface ProjectOptions {
  maxLogTailLines?: number
  maxBytes?: number
  /** Cursor to report back for the caller's next `agy_logs` / `agy_wait`. */
  cursor?: number
}

/**
 * Project the judgement packet `agy_wait` returns: counts, warnings, headline,
 * and a short log tail. No lists, no raw response text — those live in
 * `agy_result` (`docs/04` #16).
 */
export function projectJudgementPacket(result: BrokerResult, opts?: ProjectOptions): JudgementPacket {
  const missingArtifacts = result.verification.expected_artifacts.filter((a) => !a.exists).length
  const maxLines = opts?.maxLogTailLines
  const logTail =
    maxLines !== undefined && maxLines < result.broker_summary.log_tail.length
      ? result.broker_summary.log_tail.slice(-maxLines)
      : result.broker_summary.log_tail

  return {
    job_id: result.job_id,
    lifecycle: result.lifecycle,
    outcome: result.broker_summary.outcome,
    headline: result.broker_summary.headline,
    exit_code: result.broker_summary.exit_code,
    duration_ms: result.broker_summary.duration_ms,
    agent_status: result.agent_status,
    contract_status: result.contract_status,
    counts: {
      permission_denials: result.verification.permission_denials.length,
      environment_blocks: result.verification.environment_blocks.length,
      missing_artifacts: missingArtifacts,
      tool_errors: result.broker_summary.counts.tool_errors,
      turns: result.broker_summary.counts.turns,
    },
    warnings: result.verification.warnings,
    log_tail: logTail,
    cursor: opts?.cursor ?? 0,
  }
}
