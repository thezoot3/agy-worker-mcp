import type { SQLInputValue } from 'node:sqlite'

import type {
  JobRow,
  Lifecycle,
  Outcome,
  OnDenial,
  Profile,
  SessionMode,
} from '../contract/types.js'

type SqlParams = Record<string, SQLInputValue>
import { JobNotFoundError } from '../contract/errors.js'
import { newJobId } from '../contract/paths.js'
import type { Store } from './db.js'
import { now } from './db.js'

/** Lifecycles that count against the concurrency ceiling and hold locks. */
export const LIVE_LIFECYCLES: readonly Lifecycle[] = ['queued', 'starting', 'running', 'canceling']

export interface NewJob {
  jobId: string
  sessionId: string | null
  cwd: string
  profile: Profile
  writeMode: boolean
  sessionMode: SessionMode
  onDenial: OnDenial
  deadlineAt: number | null
  requestedBy?: string | null
  parentTaskId?: string | null
}

export interface JobFilter {
  lifecycle?: Lifecycle | Lifecycle[]
  outcome?: Outcome | Outcome[]
  sessionId?: string
  cwd?: string
  /** Only jobs created at or after this epoch ms. */
  since?: number
  limit?: number
}

interface JobRowRaw {
  job_id: string
  session_id: string | null
  lifecycle: string
  outcome: string | null
  headline: string | null
  cwd: string
  profile: string
  write_mode: number
  session_mode: string
  pid: number | null
  pgid: number | null
  proc_start_time: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
  deadline_at: number | null
  exit_code: number | null
  agent_status: string | null
  contract_status: string | null
  on_denial: string
  requested_by: string | null
  parent_task_id: string | null
}

function toJobRow(raw: JobRowRaw): JobRow {
  return raw as unknown as JobRow
}

/** Inserts with `lifecycle = 'queued'` and `created_at = now()`. */
export function createJob(store: Store, input: NewJob): JobRow {
  const jobId = input.jobId || newJobId()
  const createdAt = now()
  store.db
    .prepare(
      `INSERT INTO jobs (
        job_id, session_id, lifecycle, outcome, headline, cwd, profile,
        write_mode, session_mode, pid, pgid, proc_start_time,
        created_at, started_at, finished_at, deadline_at,
        exit_code, agent_status, contract_status, on_denial,
        requested_by, parent_task_id
      ) VALUES (
        @job_id, @session_id, @lifecycle, NULL, NULL, @cwd, @profile,
        @write_mode, @session_mode, NULL, NULL, NULL,
        @created_at, NULL, NULL, @deadline_at,
        NULL, NULL, NULL, @on_denial,
        @requested_by, @parent_task_id
      )`,
    )
    .run({
      job_id: jobId,
      session_id: input.sessionId,
      lifecycle: 'queued' satisfies Lifecycle,
      cwd: input.cwd,
      profile: input.profile,
      write_mode: input.writeMode ? 1 : 0,
      session_mode: input.sessionMode,
      created_at: createdAt,
      deadline_at: input.deadlineAt,
      on_denial: input.onDenial,
      requested_by: input.requestedBy ?? null,
      parent_task_id: input.parentTaskId ?? null,
    })
  return getJob(store, jobId)
}

/** @throws {import('../contract/errors.js').JobNotFoundError} with recent ids attached. */
export function getJob(store: Store, jobId: string): JobRow {
  const row = tryGetJob(store, jobId)
  if (!row) {
    throw new JobNotFoundError({
      job_id: jobId,
      known_recent: recentJobIds(store),
      project_root: store.root,
    })
  }
  return row
}

export function tryGetJob(store: Store, jobId: string): JobRow | null {
  const row = store.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as
    | JobRowRaw
    | undefined
  return row ? toJobRow(row) : null
}

/**
 * Patch columns and return the row as it now stands.
 *
 * `job_id` and `created_at` are not patchable. Callers inside a transaction must
 * pass that transaction's store; this never opens one of its own.
 */
export function updateJob(
  store: Store,
  jobId: string,
  patch: Partial<Omit<JobRow, 'job_id' | 'created_at'>>,
): JobRow {
  const entries = Object.entries(patch).filter(([k]) => k !== 'job_id' && k !== 'created_at')
  if (entries.length === 0) return getJob(store, jobId)

  const setClauses = entries.map(([k]) => `${k} = @${k}`).join(', ')
  const params: SqlParams = { job_id: jobId }
  for (const [k, v] of entries) {
    if (k === 'write_mode') {
      params[k] = v ? 1 : 0
    } else {
      params[k] = v
    }
  }

  const result = store.db.prepare(`UPDATE jobs SET ${setClauses} WHERE job_id = @job_id`).run(params)
  if (result.changes === 0) {
    throw new JobNotFoundError({
      job_id: jobId,
      known_recent: recentJobIds(store),
      project_root: store.root,
    })
  }
  return getJob(store, jobId)
}

export function listJobs(store: Store, filter?: JobFilter): JobRow[] {
  const clauses: string[] = []
  const params: SqlParams = {}

  if (filter?.lifecycle) {
    const values = Array.isArray(filter.lifecycle) ? filter.lifecycle : [filter.lifecycle]
    const placeholders = values.map((v, i) => `@lifecycle${i}`)
    values.forEach((v, i) => {
      params[`lifecycle${i}`] = v
    })
    clauses.push(`lifecycle IN (${placeholders.join(', ')})`)
  }
  if (filter?.outcome) {
    const values = Array.isArray(filter.outcome) ? filter.outcome : [filter.outcome]
    const placeholders = values.map((v, i) => `@outcome${i}`)
    values.forEach((v, i) => {
      params[`outcome${i}`] = v
    })
    clauses.push(`outcome IN (${placeholders.join(', ')})`)
  }
  if (filter?.sessionId) {
    clauses.push('session_id = @session_id')
    params.session_id = filter.sessionId
  }
  if (filter?.cwd) {
    clauses.push('cwd = @cwd')
    params.cwd = filter.cwd
  }
  if (filter?.since !== undefined) {
    clauses.push('created_at >= @since')
    params.since = filter.since
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = filter?.limit && filter.limit > 0 ? Math.floor(filter.limit) : 100
  const rows = store.db
    .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ${limit}`)
    .all(params) as unknown as JobRowRaw[]
  return rows.map(toJobRow)
}

/** Jobs in {@link LIVE_LIFECYCLES}. The gate's binding candidates come from here. */
export function listLiveJobs(store: Store): JobRow[] {
  return listJobs(store, { lifecycle: [...LIVE_LIFECYCLES], limit: 10000 })
}

/** Ids of the most recent jobs, used to make `JobNotFoundError` self-correcting. */
export function recentJobIds(store: Store, limit = 5): string[] {
  const rows = store.db
    .prepare('SELECT job_id FROM jobs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as { job_id: string }[]
  return rows.map((r) => r.job_id)
}

/** Count of jobs in {@link LIVE_LIFECYCLES}. Checked against the ceiling. */
export function countLiveJobs(store: Store): number {
  const placeholders = LIVE_LIFECYCLES.map((_, i) => `@l${i}`).join(', ')
  const params: SqlParams = {}
  LIVE_LIFECYCLES.forEach((v, i) => {
    params[`l${i}`] = v
  })
  const row = store.db
    .prepare(`SELECT COUNT(*) as n FROM jobs WHERE lifecycle IN (${placeholders})`)
    .get(params) as unknown as { n: number }
  return row.n
}
