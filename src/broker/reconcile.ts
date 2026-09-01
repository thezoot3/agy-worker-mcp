import { readFileSync, rmSync } from 'node:fs'

import type { EffectiveConfig, JobRow, JobStateFile } from '../contract/types.js'
import { jobPaths, readJsonIfExists } from '../contract/paths.js'
import { readLinesFrom } from '../events/cursor.js'
import { okEvents, parseEventLines } from '../events/parse.js'
import { checkProcessIdentity, isPidAlive, isSameProcess, killProcessGroup } from '../runner/reap.js'
import type { Store } from '../store/db.js'
import { now, transaction } from '../store/db.js'
import { getJob, listJobs, tryGetJob, updateJob } from '../store/jobs.js'
import { listLocks, releaseJobLocks } from '../store/locks.js'
import { bindConversationId, getSession } from '../store/sessions.js'
import { buildBrokerResult, writeBrokerResult } from './result.js'

/**
 * The daemon replacement (`docs/01` 결정 5).
 *
 * Every MCP tool handler calls this first. It has to be cheap, idempotent, and
 * guarded by `BEGIN IMMEDIATE` so two servers racing to finalize the same job
 * write the result exactly once.
 *
 * | observation                              | action                                        |
 * | ---------------------------------------- | --------------------------------------------- |
 * | `exit_code` exists, lifecycle = running   | finalize → verify → outcome/headline → unlock  |
 * | pid gone, no `exit_code`                  | `process_error` (the runner was killed)        |
 * | `deadline_at` 경과, pid 살아있음           | killpg 후 `timed_out`                          |
 * | pid 살아있으나 start_time 불일치           | pid 재사용 → `orphaned`                        |
 *
 * The order above is the order these are checked in, and it matters: `exit_code`
 * existing always wins (even over a passed deadline — the runner beat us to it),
 * and a passed deadline is checked before a pid-reuse mismatch. Among the last
 * two, pid reuse is checked first: it is the only *positive* observation of the
 * three, while "pid gone" covers both an ordinary exit and a lost runner.
 */

export interface ReconcileOptions {
  /** Freeze the clock in tests. */
  now?: number
  /** Skip the (more expensive) verification pass; used by hot read-only paths. */
  skipVerify?: boolean
}

export interface ReconcileReport {
  checked: number
  finalized: string[]
  timedOut: string[]
  orphaned: string[]
  processErrors: string[]
  locksReleased: number
  durationMs: number
}

/**
 * How long the runner is given to write `exit_code` after its agy child is
 * already gone. The runner only has to `writeFileAtomic` a couple of bytes from
 * an `exit` handler, so this is generous; it only ever costs latency on a run
 * that really did lose its runner.
 */
const RUNNER_WRITEBACK_GRACE_MS = 1500

/** Lifecycles that can have a live process and so are worth reconciling. */
const RECONCILABLE_LIFECYCLES: readonly JobRow['lifecycle'][] = [
  'queued',
  'starting',
  'running',
  'canceling',
]

/** Sweep every live job. Safe to call on every tool invocation. */
export async function reconcile(store: Store, opts?: ReconcileOptions): Promise<ReconcileReport> {
  const start = Date.now()
  const nowMs = opts?.now ?? now()

  const candidates = listJobs(store, { lifecycle: [...RECONCILABLE_LIFECYCLES], limit: 10000 })
  const locksBefore = listLocks(store).length

  const report: ReconcileReport = {
    checked: 0,
    finalized: [],
    timedOut: [],
    orphaned: [],
    processErrors: [],
    locksReleased: 0,
    durationMs: 0,
  }

  for (const job of candidates) {
    report.checked++
    const before = job.lifecycle
    const after = await reconcileJob(store, job, { ...opts, now: nowMs, skipVerify: opts?.skipVerify })
    if (before === 'finished' || after.lifecycle !== 'finished') continue

    switch (after.outcome) {
      case 'timed_out':
        report.timedOut.push(after.job_id)
        break
      case 'orphaned':
        report.orphaned.push(after.job_id)
        break
      case 'process_error':
        report.processErrors.push(after.job_id)
        break
      default:
        report.finalized.push(after.job_id)
    }
  }

  const locksAfter = listLocks(store).length
  report.locksReleased = Math.max(0, locksBefore - locksAfter)
  report.durationMs = Date.now() - start
  return report
}

/**
 * Reconcile one job and return its current row.
 *
 * A no-op when the job is already `finished`: a second caller arriving after
 * finalization reads the existing `broker-result.json`, not rebuilds it.
 */
export async function reconcileJob(store: Store, job: JobRow, opts?: ReconcileOptions): Promise<JobRow> {
  if (job.lifecycle === 'finished') return job

  const nowMs = opts?.now ?? now()
  const paths = jobPaths(store.paths, job.job_id)

  // The runner (which must never import `src/server/**`) records pid/pgid/
  // proc_start_time/lifecycle only in `state.json`; reconcile is the sole place
  // that absorbs it into the jobs row, since nothing else reads it back.
  job = ingestRunnerState(store, job, paths.state)

  const exitCode = readExitCode(paths.exitCode)

  if (exitCode !== null) {
    // The runner's own watchdog may have produced this exit code by killing the
    // process group at the deadline. Only `state.json` carries that fact — the
    // exit code alone is indistinguishable from an ordinary failure.
    const runnerTimedOut = readJsonIfExists<JobStateFile>(paths.state)?.timed_out === true
    return finalizeJob(store, job, exitCode, nowMs, runnerTimedOut)
  }

  // Row 3 (checked ahead of the pid-null early return): a deadline that has
  // passed must finalize the job even when the runner never published a pid —
  // otherwise a runner that fails to start (or dies before spawning agy) leaves
  // the job, and its locks, live forever.
  if (job.deadline_at !== null && nowMs >= job.deadline_at) {
    if (
      job.pid !== null &&
      job.pgid !== null &&
      isPidAlive(job.pid) &&
      isSameProcess(job.pid, job.proc_start_time)
    ) {
      await killProcessGroup(job.pgid)
    }
    const exitAfterKill = await pollExitCode(paths.exitCode)
    if (exitAfterKill !== null) {
      // We killed it for the deadline, so the exit code it produced is a
      // timeout's exit code, not a failure's.
      return finalizeJob(store, job, exitAfterKill, now(), true)
    }
    return finalizeAbnormal(store, job, 'timed_out', now())
  }

  if (job.pid === null) {
    // Not spawned yet (still `queued`/`starting`) and its deadline (if any)
    // has not passed. Nothing observable to reconcile.
    return job
  }

  const identity = checkProcessIdentity(job.pid, job.proc_start_time)

  // Row 4: pid alive, but the start-time token belongs to a *different*
  // process. Checked before row 2 because it is the only positive conclusion of
  // the three — `gone` covers both an ordinary exit and a lost runner, and
  // telling those apart is row 2's job.
  if (identity === 'different') {
    return finalizeAbnormal(store, job, 'orphaned', nowMs)
  }

  // Row 2: pid gone, no exit_code file. The runner was killed before it could
  // record a result.
  //
  // `agy` dying is NOT by itself evidence of that: between agy's exit and the
  // runner's `writeExitCode` there is a short window in which the pid is
  // already gone while a perfectly healthy run is about to record exit 0.
  // Reading only `isPidAlive` here misclassifies every normally-finishing job
  // caught in that window as `process_error`, which a caller polling reconcile
  // in a loop hits reliably. So re-poll for the exit_code first, and only
  // conclude the runner is lost once the grace elapses with nothing written.
  if (identity === 'gone') {
    const exitAfterDeath = await pollExitCode(paths.exitCode, RUNNER_WRITEBACK_GRACE_MS)
    if (exitAfterDeath !== null) {
      return finalizeJob(store, job, exitAfterDeath, now())
    }
    return finalizeAbnormal(store, job, 'process_error', now())
  }

  // Row 5: the gate marked this job `canceling` (on_denial: 'abort'). The gate
  // only marks it — reconcile owns the actual killpg, and does it here rather
  // than waiting for the deadline.
  if (job.lifecycle === 'canceling' && job.pgid !== null) {
    await killProcessGroup(job.pgid)
    const exitAfterKill = await pollExitCode(paths.exitCode)
    if (exitAfterKill !== null) {
      return finalizeJob(store, job, exitAfterKill, now())
    }
    return finalizeAbnormal(store, job, 'timed_out', now())
  }

  // Still genuinely running.
  return job
}

/**
 * Absorb `state.json` (written only by the runner) into the jobs row: pid,
 * pgid, proc_start_time and started_at are filled in once and never
 * contradicted (the runner never rewrites them to null), and lifecycle is only
 * ever moved forward (`queued` → `starting` → `running`) — never used to
 * downgrade a `canceling` mark the gate made, and `finished` is decided
 * exclusively by the presence of `exit_code`, never by `state.json` alone.
 */
function ingestRunnerState(store: Store, job: JobRow, statePath: string): JobRow {
  const state = readJsonIfExists<JobStateFile>(statePath)
  if (!state) return job

  const patch: Partial<Omit<JobRow, 'job_id' | 'created_at'>> = {}
  if (state.pid !== null && job.pid === null) patch.pid = state.pid
  if (state.pgid !== null && job.pgid === null) patch.pgid = state.pgid
  if (state.proc_start_time !== null && job.proc_start_time === null) {
    patch.proc_start_time = state.proc_start_time
  }
  if (state.started_at !== null && job.started_at === null) patch.started_at = state.started_at

  if (state.lifecycle === 'running' && (job.lifecycle === 'queued' || job.lifecycle === 'starting')) {
    patch.lifecycle = 'running'
  } else if (state.lifecycle === 'starting' && job.lifecycle === 'queued') {
    patch.lifecycle = 'starting'
  }

  if (Object.keys(patch).length === 0) return job
  return updateJob(store, job.job_id, patch)
}

/**
 * Finalize a job whose `exit_code` file has appeared: run verification, decide
 * the outcome, write `broker-result.json`, set `lifecycle = 'finished'`, release
 * locks. All inside one transaction.
 *
 * The job's *incoming* lifecycle carries one more fact: `'canceling'` means
 * `agy_cancel` had already asked for this exit, so the outcome is `canceled`
 * even though a normal exit code came back. `timedOut` carries the other one,
 * from `state.json`: the runner's watchdog killed the group at the deadline,
 * which is not an ordinary failure however the exit code reads.
 */
export function finalizeJob(
  store: Store,
  job: JobRow,
  exitCode: number,
  nowMs: number,
  timedOut = false,
): JobRow {
  return transaction(store.db, () => {
    const fresh = tryGetJob(store, job.job_id)
    if (fresh === null) return job
    if (fresh.lifecycle === 'finished') return fresh

    const canceled = fresh.lifecycle === 'canceling'
    return finalizeCore(store, fresh, {
      exitCode,
      // An explicit cancel outranks the deadline: the user asked for this exit.
      timedOut: timedOut && !canceled,
      canceled,
      runnerLost: false,
      pidReused: false,
      nowMs,
    })
  })
}

export type AbnormalKind = 'process_error' | 'orphaned' | 'timed_out'

/**
 * Finalize a job with no real `exit_code` — the runner vanished, the pid was
 * reused, or our own deadline enforcement had to kill it directly.
 */
function finalizeAbnormal(store: Store, job: JobRow, kind: AbnormalKind, nowMs: number): JobRow {
  return transaction(store.db, () => {
    const fresh = tryGetJob(store, job.job_id)
    if (fresh === null) return job
    if (fresh.lifecycle === 'finished') return fresh

    const canceled = fresh.lifecycle === 'canceling'
    return finalizeCore(store, fresh, {
      exitCode: null,
      timedOut: kind === 'timed_out' && !canceled,
      canceled,
      runnerLost: kind === 'process_error' && !canceled,
      pidReused: kind === 'orphaned' && !canceled,
      nowMs,
    })
  })
}

interface FinalizeFlags {
  exitCode: number | null
  timedOut: boolean
  canceled: boolean
  runnerLost: boolean
  pidReused: boolean
  nowMs: number
}

/** Shared body of {@link finalizeJob} / {@link finalizeAbnormal}. Must run inside a transaction. */
function finalizeCore(store: Store, job: JobRow, flags: FinalizeFlags): JobRow {
  const paths = jobPaths(store.paths, job.job_id)
  const config = readJsonIfExists<EffectiveConfig>(paths.effectiveConfig)
  const expectedArtifacts = config?.expected_artifacts ?? []
  const jsonSchemaPath = config?.json_schema_path ?? null
  // Only `state.json` records that the runner's idle watchdog closed stdin; the
  // exit code it produces is an ordinary 0.
  const idleClosed = readJsonIfExists<JobStateFile>(paths.state)?.idle_closed === true
  const idleClosedAfterMs = idleClosed ? (config?.idle_timeout_ms ?? null) : null

  const read = readLinesFrom(paths.events, 0)
  const parsed = parseEventLines(read.lines, 0)
  const events = okEvents(parsed)
  const malformedLines = parsed.filter((p) => !p.ok).length

  const result = buildBrokerResult(store, {
    job,
    events,
    malformedLines,
    exitCode: flags.exitCode,
    timedOut: flags.timedOut,
    canceled: flags.canceled,
    runnerLost: flags.runnerLost,
    pidReused: flags.pidReused,
    expectedArtifacts,
    jsonSchemaPath,
    idleClosedAfterMs,
    now: flags.nowMs,
  })

  writeBrokerResult(paths, result)
  releaseJobLocks(store, job.job_id)

  // Write the conversation id back to the session the moment the broker result
  // knows it, independent of whether the gate ever bound this conversation
  // (finding 14) — otherwise a later `agy_start({session_id})` reads
  // `conversation_id: null` and silently starts a brand-new conversation
  // instead of resuming this one.
  if (result.conversation_id && job.session_id) {
    const session = getSession(store, job.session_id)
    if (session && session.conversation_id === null) {
      try {
        bindConversationId(store, job.session_id, result.conversation_id)
      } catch {
        // Best effort — a concurrent bind from the gate already won.
      }
    }
  }

  return updateJob(store, job.job_id, {
    lifecycle: 'finished',
    outcome: result.broker_summary.outcome,
    headline: result.broker_summary.headline,
    exit_code: result.broker_summary.exit_code,
    agent_status: result.agent_status,
    contract_status: result.contract_status,
    finished_at: flags.nowMs,
  })
}

/** Opportunistic cleanup of old job directories, triggered from `agy_start`. */
export function cleanupOldJobs(store: Store, maxAgeMs: number): number {
  const cutoff = now() - maxAgeMs
  const finished = listJobs(store, { lifecycle: 'finished', limit: 10000 })
  let removed = 0

  for (const job of finished) {
    const ts = job.finished_at ?? job.created_at
    if (ts >= cutoff) continue

    const paths = jobPaths(store.paths, job.job_id)
    try {
      rmSync(paths.dir, { recursive: true, force: true })
    } catch {
      // Best effort: an already-gone directory is not a failure.
    }
    store.db.prepare('DELETE FROM jobs WHERE job_id = ?').run(job.job_id)
    removed++
  }

  return removed
}

/** `jobs/<id>/exit_code` holds a bare integer; missing or unparsable reads as null. */
function readExitCode(path: string): number | null {
  try {
    const raw = readFileSync(path, 'utf8').trim()
    if (raw.length === 0) return null
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/**
 * After a forced `killpg`, give a still-alive runner a short window to observe
 * the child's exit and write `exit_code` itself, so the finalize path reuses the
 * real exit code instead of manufacturing one. Bounded so reconcile stays cheap
 * even when the runner is not there to write anything.
 */
async function pollExitCode(path: string, totalMs = 2000, intervalMs = 200): Promise<number | null> {
  const deadline = Date.now() + totalMs
  for (;;) {
    const code = readExitCode(path)
    if (code !== null) return code
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** Convenience: reconcile one job by id, fetching its current row first. */
export async function reconcileJobById(store: Store, jobId: string, opts?: ReconcileOptions): Promise<JobRow> {
  const job = getJob(store, jobId)
  return reconcileJob(store, job, opts)
}
