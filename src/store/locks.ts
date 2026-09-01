import type { LockRow, LockScope } from '../contract/types.js'
import { LockConflictError, type LockConflictDetail } from '../contract/errors.js'
import { canonicalize } from '../contract/paths.js'
import { isPidAlive, isSameProcess } from '../runner/reap.js'
import { transaction, now } from './db.js'
import type { Store } from './db.js'
import { countLiveJobs, tryGetJob, LIVE_LIFECYCLES } from './jobs.js'

/** Default per-project concurrency ceiling (`docs/01` 결정 4). */
export const DEFAULT_MAX_RUNNING = 3

/** Everything one job needs, acquired together or not at all. */
export interface JobLockRequest {
  jobId: string
  /** Canonical cwd. Only taken when `writeMode` is true — readers run in parallel. */
  cwd: string
  writeMode: boolean
  /** Session id. Enforces one running turn per agy conversation. */
  sessionId?: string | null
  /** Ceiling on `lifecycle IN ('starting','running')` jobs. */
  maxRunning?: number
}

export interface AcquiredLocks {
  jobId: string
  rows: LockRow[]
  /** Stale rows reclaimed on the way in, for the audit trail. */
  reclaimed: LockRow[]
}

interface LockRowRaw {
  scope: string
  key: string
  holder_job_id: string
  acquired_at: number
}

function toLockRow(raw: LockRowRaw): LockRow {
  return raw as unknown as LockRow
}

function getLockRow(store: Store, scope: LockScope, key: string): LockRow | null {
  const row = store.db
    .prepare('SELECT * FROM locks WHERE scope = ? AND key = ?')
    .get(scope, key) as LockRowRaw | undefined
  return row ? toLockRow(row) : null
}

function deleteLockRow(store: Store, scope: LockScope, key: string): void {
  store.db.prepare('DELETE FROM locks WHERE scope = ? AND key = ?').run(scope, key)
}

/**
 * How long a holder with no pid yet is still treated as alive: `agy_start`
 * acquires locks, creates the rows, writes job files and only then spawns the
 * detached runner — tens to hundreds of ms during which `job.pid` is
 * legitimately still null. Without this grace window every lock acquired in
 * that window reads as "dead holder" and is stolen (finding 2).
 */
const START_GRACE_MS = 30_000

/**
 * Is the job holding this lock still the process we recorded?
 *
 * True while the holder is still in its start grace window (pid not published
 * yet, but young enough that it plausibly will be). False once the pid is
 * gone, once the grace window has elapsed with still no pid, or when the pid
 * is alive but `proc_start_time` differs, which means the number was reused by
 * an unrelated process.
 */
export function isHolderAlive(store: Store, holderJobId: string): boolean {
  const job = tryGetJob(store, holderJobId)
  if (!job) return false
  if (job.pid === null) {
    if (job.lifecycle === 'queued' || job.lifecycle === 'starting') {
      return now() - job.created_at < START_GRACE_MS
    }
    return false
  }
  if (!isPidAlive(job.pid)) return false
  return isSameProcess(job.pid, job.proc_start_time)
}

/**
 * Resolve one existing lock row: alive → the row itself (caller must treat as a
 * conflict), stale → deleted and returned via `reclaimed`, absent → null both ways.
 */
function resolveExisting(
  store: Store,
  scope: LockScope,
  key: string,
  reclaimed: LockRow[],
): LockRow | null {
  const existing = getLockRow(store, scope, key)
  if (!existing) return null
  if (isHolderAlive(store, existing.holder_job_id)) {
    return existing
  }
  deleteLockRow(store, scope, key)
  reclaimed.push(existing)
  return null
}

/**
 * Acquire every lock the job needs inside one `BEGIN IMMEDIATE` transaction.
 *
 * The procedure is fixed (`docs/01` 결정 4) and must not be split across
 * transactions — a check in one and an insert in another is a TOCTOU race:
 *
 * 1. select the `(scope, key)` rows
 * 2. for each existing row, look up the holder job and decide staleness with
 *    **both** pid liveness and `proc_start_time` equality. pid alone is wrong:
 *    a recycled pid reads as a live holder and the lock never frees.
 * 3. count `starting|running` jobs against `maxRunning`
 * 4. `INSERT INTO locks` — a primary-key collision *is* the lost race
 * 5. `COMMIT`
 *
 * @throws {import('../contract/errors.js').LockConflictError} when a live holder
 * or the ceiling blocks it. Losing must be an error, never quiet serialization
 * (`docs/04` #4, #7), and the error carries the holder so the caller can wait on
 * it or cancel it.
 */
export function acquireJobLocks(store: Store, req: JobLockRequest): AcquiredLocks {
  return transaction(store.db, () => {
    const reclaimed: LockRow[] = []
    const wanted: Array<{ scope: LockScope; key: string }> = []

    if (req.writeMode) {
      wanted.push({ scope: 'cwd_write', key: canonicalize(req.cwd) })
    }
    if (req.sessionId) {
      wanted.push({ scope: 'session', key: req.sessionId })
    }

    for (const w of wanted) {
      const held = resolveExisting(store, w.scope, w.key, reclaimed)
      if (held) {
        const holder = tryGetJob(store, held.holder_job_id)
        const detail: LockConflictDetail = {
          scope: w.scope,
          key: w.key,
          reason: 'held',
          holder_job_id: held.holder_job_id,
          holder_pid: holder?.pid ?? null,
          holder_started_at: holder?.started_at ?? null,
          acquired_at: held.acquired_at,
          running_job_ids: [],
          limit: null,
        }
        throw new LockConflictError(detail)
      }
    }

    const maxRunning = req.maxRunning ?? DEFAULT_MAX_RUNNING
    const liveCount = countLiveJobs(store)
    if (liveCount >= maxRunning) {
      const runningJobIds = store.db
        .prepare(
          `SELECT job_id FROM jobs WHERE lifecycle IN (${LIVE_LIFECYCLES.map(() => '?').join(', ')})`,
        )
        .all(...LIVE_LIFECYCLES)
        .map((r) => (r as { job_id: string }).job_id)
      const detail: LockConflictDetail = {
        scope: 'running_limit',
        key: '*',
        reason: 'limit',
        holder_job_id: null,
        holder_pid: null,
        holder_started_at: null,
        acquired_at: null,
        running_job_ids: runningJobIds,
        limit: maxRunning,
      }
      throw new LockConflictError(detail)
    }

    const acquiredAt = now()
    const rows: LockRow[] = []
    for (const w of wanted) {
      store.db
        .prepare(
          'INSERT INTO locks (scope, key, holder_job_id, acquired_at) VALUES (?, ?, ?, ?)',
        )
        .run(w.scope, w.key, req.jobId, acquiredAt)
      rows.push({ scope: w.scope, key: w.key, holder_job_id: req.jobId, acquired_at: acquiredAt })
    }

    return { jobId: req.jobId, rows, reclaimed }
  })
}

/** Release every lock held by a job. Idempotent; returns how many rows went away. */
export function releaseJobLocks(store: Store, jobId: string): number {
  const result = store.db.prepare('DELETE FROM locks WHERE holder_job_id = ?').run(jobId)
  return Number(result.changes)
}

export function listLocks(store: Store, scope?: LockScope): LockRow[] {
  const rows = scope
    ? (store.db.prepare('SELECT * FROM locks WHERE scope = ?').all(scope) as unknown as LockRowRaw[])
    : (store.db.prepare('SELECT * FROM locks').all() as unknown as LockRowRaw[])
  return rows.map(toLockRow)
}

/**
 * Drop rows whose holder is provably gone. Called from `reconcile`; also runs
 * inline during {@link acquireJobLocks} so a dead holder never deadlocks anyone.
 */
export function reapStaleLocks(store: Store): LockRow[] {
  return transaction(store.db, () => {
    const all = listLocks(store)
    const reclaimed: LockRow[] = []
    for (const row of all) {
      if (!isHolderAlive(store, row.holder_job_id)) {
        deleteLockRow(store, row.scope, row.key)
        reclaimed.push(row)
      }
    }
    return reclaimed
  })
}
