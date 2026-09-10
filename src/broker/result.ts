import type {
  AgentReport,
  AgyEvent,
  BrokerResult,
  BrokerSummary,
  DenialClass1,
  DenialClass2,
  JobRow,
  JudgementPacket,
  Verification,
} from '../contract/types.js'
import { BROKER_RESULT_VERSION } from '../contract/types.js'
import { ValidationError } from '../contract/errors.js'
import type { JobPaths } from '../contract/paths.js'
import { readJsonIfExists, writeJsonAtomic } from '../contract/paths.js'
import { normalizeEvent, tailSummary } from '../events/normalize.js'
import { lastResult } from '../events/parse.js'
import type { Store } from '../store/db.js'
import {
  blockerFromDenial,
  blockerFromEnvironmentBlock,
  blockerFromGateMissing,
  blockerFromMissingArtifact,
  countActionable,
  renderBlocker,
} from './blockers.js'
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
  /**
   * `state.json.gate_confirmed`, verbatim (I4). `false` adds a `source:'broker'`
   * blocker and forces `outcome: 'process_error'`; `null` (no tool step ever
   * ran, or an older `state.json`) changes nothing.
   */
  gateConfirmed: boolean | null
  /**
   * When the runner actually finished (`state.json.finished_at`), if known.
   * `finished_at` / `duration_ms` come from this; `now` is only when the
   * broker got around to judging it (`finalized_at`). Absent on abnormal
   * finalization (no `exit_code`, so no runner-recorded end) — `now` then.
   * 0.2.2 (PR1): a job nobody polled for four days used to
   * report an 86-hour duration for a 30-minute run.
   */
  finishedAt?: number | null
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

  // I4: fold the gate watchdog's own verdict into the same `blockers` list
  // everything else uses, so `agy_result`'s verification section carries this
  // exactly like any other blocker instead of a special-cased field.
  if (input.gateConfirmed === false) {
    const gateBlocker = blockerFromGateMissing()
    verification.blockers.push(gateBlocker)
    verification.warnings.push(renderBlocker(gateBlocker))
  }

  const agentReport = buildAgentReport(input.events)
  const hadExpectations = input.expectedArtifacts.length > 0 || input.jsonSchemaPath !== null

  const decision = decideOutcome({
    lifecycle: input.job.lifecycle,
    exitCode: input.exitCode,
    agentStatus: agentReport.status,
    agentError: agentReport.error,
    agentResponse: agentReport.response,
    verification,
    timedOut: input.timedOut,
    canceled: input.canceled,
    gateMissing: input.gateConfirmed === false,
    runnerLost: input.runnerLost,
    pidReused: input.pidReused,
    hadExpectations,
  })

  const counts = countEvents(input.events, input.malformedLines)

  const normalized = input.events
    .map((e) => normalizeEvent(e))
    .filter((n): n is NonNullable<typeof n> => n !== null)
  const logTail = tailSummary(normalized, DEFAULT_LOG_TAIL_LINES)

  const finishedAt = input.finishedAt ?? input.now
  const durationMs = input.job.started_at !== null ? Math.max(0, finishedAt - input.job.started_at) : null

  const brokerSummary: BrokerSummary = {
    headline: decision.headline,
    outcome: decision.outcome,
    exit_code: input.exitCode,
    duration_ms: durationMs,
    counts,
    log_tail: logTail,
  }

  return {
    schema_version: BROKER_RESULT_VERSION,
    job_id: input.job.job_id,
    session_id: input.job.session_id,
    conversation_id: agentReport.conversation_id,
    lifecycle: 'finished',
    cwd: input.job.cwd,
    profile: input.job.profile,
    session_mode: input.job.session_mode,
    created_at: input.job.created_at,
    started_at: input.job.started_at,
    finished_at: finishedAt,
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

/**
 * Null when the job has not been finalized yet.
 *
 * A `broker-result.json` written by an older server is migrated in memory
 * (see {@link migrateBrokerResult}) rather than crashing a tool call — job
 * directories outlive an upgrade, and `agy_result` on yesterday's job must keep
 * working. A version we do not know how to read is refused loudly instead of
 * being handed on half-typed.
 *
 * @throws {import('../contract/errors.js').ValidationError} on an unknown version.
 */
export function loadBrokerResult(paths: JobPaths): BrokerResult | null {
  const raw = readJsonIfExists<BrokerResult>(paths.brokerResult)
  if (raw === null) return null
  return migrateBrokerResult(raw, paths.brokerResult)
}

/**
 * Bring a stored result up to {@link BROKER_RESULT_VERSION}.
 *
 * Version 1 kept `verification.permission_denials` and
 * `verification.environment_blocks`; version 2 collapsed those into the single
 * `verification.blockers`; version 3 adds `verification.verify` (PR6,
 * `verify_command`) — always `null` on a migrated file, since no job written
 * before 0.2.0 ever ran a verify command. The version-1 migration runs the
 * same constructors the live path uses, so an old job is judged by exactly
 * today's rules — and nothing in the old records is dropped, since each one is
 * carried in `Blocker.detail`.
 */
export function migrateBrokerResult(raw: BrokerResult, path: string): BrokerResult {
  const version = raw.schema_version
  if (version === BROKER_RESULT_VERSION) return raw
  if (version !== 1 && version !== 2) {
    throw new ValidationError({
      field: `schema_version of ${path}`,
      value: version,
      expected: `a broker-result.json version this server can read (1, 2 or ${BROKER_RESULT_VERSION}) — this file was written by a newer server`,
    })
  }

  let verification: Verification
  if (version === 1) {
    const legacy = raw.verification as Verification & {
      permission_denials?: DenialClass1[]
      environment_blocks?: DenialClass2[]
    }
    const artifacts = legacy.expected_artifacts ?? []
    const blockers = [
      ...(legacy.permission_denials ?? []).map(blockerFromDenial),
      ...(legacy.environment_blocks ?? []).map((b) => blockerFromEnvironmentBlock(b)),
      ...artifacts.filter((a) => !a.exists).map(blockerFromMissingArtifact),
    ]
    verification = {
      blockers,
      expected_artifacts: artifacts,
      changed_files: legacy.changed_files ?? [],
      warnings: legacy.warnings ?? [],
      contract_status: legacy.contract_status,
      checked_at: legacy.checked_at,
      verify: null,
    }
  } else {
    // version === 2: everything but `verify` is already in today's shape.
    verification = { ...raw.verification, verify: null }
  }

  return {
    ...raw,
    schema_version: BROKER_RESULT_VERSION,
    verification,
  }
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
 * `agy_result`.
 */
export function projectJudgementPacket(result: BrokerResult, opts?: ProjectOptions): JudgementPacket {
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
      // Two numbers instead of four differently-defined ones: how much stood in
      // the way, and how much of it the caller can act on. `headline` names the
      // sources; `agy_result`'s `verification.blockers` has each one in full.
      blockers: result.verification.blockers.length,
      actionable: countActionable(result.verification.blockers),
      tool_errors: result.broker_summary.counts.tool_errors,
      turns: result.broker_summary.counts.turns,
    },
    warnings: result.verification.warnings,
    log_tail: logTail,
    cursor: opts?.cursor ?? 0,
  }
}
