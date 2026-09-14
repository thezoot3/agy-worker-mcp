import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { appendJsonLine, fileSize, type ProjectPaths } from '../contract/paths.js'
import type { BrokerResult, EffectiveConfig, JobRow, UsageRecord } from '../contract/types.js'
import { redactText } from '../report/redact.js'
import type { JobDigest } from '../trace/digest.js'

/**
 * The permanent job-summary log (docs/operations.md, "The usage log").
 * Pure record-building lives here alongside the small amount of I/O the
 * layer needs; the pure core (`buildUsageRecord`) is the part worth testing
 * without touching disk, matching how `trace/digest.ts` and
 * `policy/seatbelt.ts` are split.
 */

/** ~8000 jobs at the measured ~600B/job before a generation rotates out. */
const ROTATE_AT_BYTES = 5 * 1024 * 1024

/**
 * A server can have several jobs finalizing concurrently, each `appendUsage`
 * call an independent process-level `write(2)`. `appendJsonLine` already
 * opens with `O_APPEND` and writes the whole line in one call, and POSIX
 * guarantees a write of `PIPE_BUF` bytes or fewer to be atomic — so as long as
 * every line stays under that, concurrent appenders can never interleave
 * their bytes into a line neither of them wrote. 4096 is the smallest
 * `PIPE_BUF` guaranteed across the platforms this runs on.
 */
const MAX_LINE_BYTES = 4096

/** `denials` / `blockers` are capped here independently of the byte-budget trim below. */
const MAX_LIST_ENTRIES = 20

/**
 * Upper bound on a single `required_rule` / `remedy` string.
 *
 * `requiredRuleFor` builds a command rule out of the whole command line
 * (`command(${tokens.join(' ')})`, `src/policy/rules.ts`), so a denied
 * `npx vitest run … --reporter=json` arrives here in full. The aggregation
 * this file feeds only ever groups by the rule, and a rule nobody can read at
 * a glance is no use to `agy_ceiling` either — clipping keeps the line inside
 * its byte budget without losing which command was refused.
 */
const MAX_RULE_CHARS = 240

/**
 * The one place a string from the run itself is allowed into `usage.jsonl`.
 *
 * `required_rule` and `remedy` are the exception to this file's "enums and
 * rule strings only" rule: a denied command line reaches the first verbatim, and a
 * blocker's remedy can name an absolute path (`blockers.ts` builds "add a
 * glob covering <dir>" and "have the job create <path>"). Since this file is
 * permanent — it deliberately outlives the job directory — a token pasted
 * into a denied `curl` would otherwise sit here forever. Everything therefore
 * goes through the same scrubber the HTML report uses, and is then clipped.
 */
function scrub(text: string, redaction: UsageRedaction): string {
  const cleaned = redactText(text, {
    level: 'default',
    ...(redaction.home ? { home: redaction.home } : {}),
    ...(redaction.workspace ? { workspace: redaction.workspace } : {}),
  })
  return cleaned.length > MAX_RULE_CHARS ? cleaned.slice(0, MAX_RULE_CHARS - 1) + '…' : cleaned
}

/** Paths rewritten out of `required_rule` / `remedy` before they are recorded. */
export interface UsageRedaction {
  home: string | null
  workspace: string | null
}

function capList<T>(items: T[]): T[] {
  return items.length > MAX_LIST_ENTRIES ? items.slice(0, MAX_LIST_ENTRIES) : items
}

/**
 * Facts about the running process and its `agy`, gathered by the caller
 * (`src/broker/reconcile.ts`) so this function stays pure — none of these are
 * computable from `JobRow` / `EffectiveConfig` / `BrokerResult` alone.
 */
export interface UsageEnvironment {
  /** `EffectiveConfig.agy_version`, forwarded rather than re-read here. */
  agyVersion: string | null
  packageVersion: string
  nodeVersion: string
  platform: string
}

export interface BuildUsageRecordInput {
  job: JobRow
  /** Null when `effective-config.json` could not be read at all. */
  config: EffectiveConfig | null
  result: BrokerResult
  digest: JobDigest
  /** `finalizeCore`'s `finishedAt`. */
  finishedAt: number
  environment: UsageEnvironment
  redaction: UsageRedaction
}

/**
 * Pure projection of one finished job onto a {@link UsageRecord}. No disk
 * access, so a test can hand it fixture objects directly (`buildBrokerResult`
 * output, a `JobDigest`, a fake `JobRow`) without going anywhere near
 * `finalizeCore`.
 */
export function buildUsageRecord(input: BuildUsageRecordInput): UsageRecord {
  const { job, config, result, digest, finishedAt, environment, redaction } = input

  const verify = result.verification.verify

  return {
    v: 1,
    ts: finishedAt,
    job_id: job.job_id,
    session_id: result.session_id,
    profile: job.profile,
    model: config?.model ?? null,
    effort: config?.effort ?? null,
    session_mode: job.session_mode,
    isolation: config?.worktree ? 'worktree' : 'in_place',
    sandbox: config?.policy.sandbox ?? null,
    on_denial: job.on_denial,
    outcome: result.broker_summary.outcome,
    contract_status: result.contract_status,
    agent_status: result.agent_status,
    exit_code: result.broker_summary.exit_code,
    duration_ms: result.broker_summary.duration_ms,
    queued_ms: job.started_at !== null ? job.started_at - job.created_at : null,
    counts: result.broker_summary.counts,
    usage: result.agent_report.usage,
    files: { read: digest.files.read_count, edited: digest.files.edited_count },
    denials: capList(
      digest.denials.map((denial) => ({
        stage: denial.stage,
        required_rule: denial.required_rule === null ? null : scrub(denial.required_rule, redaction),
        count: denial.count,
      })),
    ),
    blockers: capList(
      result.verification.blockers.map((blocker) => ({
        source: blocker.source,
        actionable: blocker.actionable,
        remedy: blocker.remedy === null ? null : scrub(blocker.remedy, redaction),
      })),
    ),
    verify: verify
      ? { ran: true, passed: verify.exit_code === 0 && !verify.timed_out }
      : { ran: false, passed: false },
    workspace: { kind: result.workspace.kind, changed_files: result.workspace.changed_file_count },
    env: {
      agy: environment.agyVersion,
      pkg: environment.packageVersion,
      node: environment.nodeVersion,
      platform: environment.platform,
    },
  }
}

/**
 * Shorten `denials` then `blockers`, one entry at a time, until the
 * serialised line fits {@link MAX_LINE_BYTES}. `capList` already bounds both
 * to 20 entries, but a job with 20 denials whose `required_rule` strings are
 * unusually long could still overflow the budget — this is the backstop for
 * that, not the normal path.
 */
function fitToLineBudget(record: UsageRecord): UsageRecord {
  let candidate = record
  while (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_LINE_BYTES) {
    if (candidate.denials.length > 0) {
      candidate = { ...candidate, denials: candidate.denials.slice(0, -1) }
    } else if (candidate.blockers.length > 0) {
      candidate = { ...candidate, blockers: candidate.blockers.slice(0, -1) }
    } else {
      // Nothing left to trim. Write the oversized line rather than lose the
      // job's usage entry entirely — this should not happen in practice.
      break
    }
  }
  return candidate
}

/**
 * Append one line to `usageLog`, rotating first when it has grown past
 * {@link ROTATE_AT_BYTES}. Only one generation is kept: `usage.1.jsonl` is
 * overwritten if it already exists (`renameSync` replaces its target on the
 * same filesystem), matching the design's "two generations, no more" choice
 * — this is a summary log, not an archive.
 */
export function appendUsage(paths: ProjectPaths, record: UsageRecord): void {
  if (fileSize(paths.usageLog) >= ROTATE_AT_BYTES) {
    renameSync(paths.usageLog, join(paths.dir, 'usage.1.jsonl'))
  }
  const bounded = fitToLineBudget({
    ...record,
    denials: capList(record.denials),
    blockers: capList(record.blockers),
  })
  appendJsonLine(paths.usageLog, bounded)
}

/** `jobs/<id>/usage.stamp` — see {@link hasUsageStamp}. */
function usageStampPath(jobDir: string): string {
  return join(jobDir, 'usage.stamp')
}

/**
 * Whether this job already produced a `usage.jsonl` line. `finalizeJob`
 * already refuses to re-finalize a job that reads back `finished`, so this
 * should never trip — but the stamp lives in the job directory precisely so
 * it survives exactly as long as the question "did L1 see this job" matters,
 * and disappears with the rest of `jobs/<id>/` once `cleanupOldJobs` decides
 * the job is old enough to forget.
 */
export function hasUsageStamp(jobDir: string): boolean {
  return existsSync(usageStampPath(jobDir))
}

/** Mark this job as accounted for in `usage.jsonl`. Content is irrelevant; only existence matters. */
export function writeUsageStamp(jobDir: string): void {
  writeFileSync(usageStampPath(jobDir), '')
}
