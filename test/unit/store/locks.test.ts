import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LockConflictError, isAgyWorkerError } from '../../../src/contract/errors.js'
import { canonicalize } from '../../../src/contract/paths.js'
import { getProcStartTime } from '../../../src/runner/reap.js'
import { createSession } from '../../../src/store/sessions.js'
import {
  DEFAULT_MAX_RUNNING,
  acquireJobLocks,
  reapStaleLocks,
} from '../../../src/store/locks.js'
import { listLocks } from '../../../src/store/locks.js'
import { markRunning, newTestJob, makeTestStore } from '../helpers/store.js'
import type { TestStoreHandle } from '../helpers/store.js'

let handle: TestStoreHandle

beforeEach(() => {
  handle = makeTestStore()
})

afterEach(() => {
  handle.cleanup()
})

/** A pid guaranteed to be dead by the time this returns: a child that already exited. */
function deadPid(): number {
  const res = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  const pid = res.pid
  if (typeof pid !== 'number') throw new Error('spawnSync did not report a pid')
  return pid
}

describe('cwd_write lock contention', () => {
  it('a second write acquisition on the same cwd is a LockConflictError', () => {
    const { store, workspace } = handle
    const holder = newTestJob(store, { cwd: workspace, writeMode: true })
    markRunning(store, holder.job_id, process.pid, getProcStartTime(process.pid))

    acquireJobLocks(store, { jobId: holder.job_id, cwd: workspace, writeMode: true })

    const challenger = newTestJob(store, { cwd: workspace, writeMode: true })
    let thrown: unknown
    try {
      acquireJobLocks(store, { jobId: challenger.job_id, cwd: workspace, writeMode: true })
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(LockConflictError)
    expect(isAgyWorkerError(thrown)).toBe(true)
    const detail = (thrown as LockConflictError).detail
    expect(detail.scope).toBe('cwd_write')
    expect(detail.reason).toBe('held')
    expect(detail.holder_job_id).toBe(holder.job_id)

    // The loser never got a row — losing is an error, not quiet serialization.
    expect(listLocks(store, 'cwd_write')).toHaveLength(1)
  })

  it('read-only acquisitions on the same cwd all pass in parallel', () => {
    const { store, workspace } = handle
    const readerA = newTestJob(store, { cwd: workspace, writeMode: false })
    const readerB = newTestJob(store, { cwd: workspace, writeMode: false })

    const a = acquireJobLocks(store, { jobId: readerA.job_id, cwd: workspace, writeMode: false })
    const b = acquireJobLocks(store, { jobId: readerB.job_id, cwd: workspace, writeMode: false })

    // Read-only requests take no cwd_write row at all.
    expect(a.rows).toHaveLength(0)
    expect(b.rows).toHaveLength(0)
    expect(listLocks(store, 'cwd_write')).toHaveLength(0)
  })

  it('a write job does not block a read-only job on the same cwd', () => {
    const { store, workspace } = handle
    const writer = newTestJob(store, { cwd: workspace, writeMode: true })
    markRunning(store, writer.job_id, process.pid, getProcStartTime(process.pid))
    acquireJobLocks(store, { jobId: writer.job_id, cwd: workspace, writeMode: true })

    const reader = newTestJob(store, { cwd: workspace, writeMode: false })
    const acquired = acquireJobLocks(store, {
      jobId: reader.job_id,
      cwd: workspace,
      writeMode: false,
    })
    expect(acquired.rows).toHaveLength(0)
  })
})

describe('session lock', () => {
  it('a second running job in the same session is a LockConflictError', () => {
    const { store, workspace } = handle
    const sessionId = 'sess-1'
    createSession(store, { sessionId, cwd: workspace })
    const holder = newTestJob(store, { cwd: workspace, writeMode: false, sessionId })
    markRunning(store, holder.job_id, process.pid, getProcStartTime(process.pid))
    acquireJobLocks(store, {
      jobId: holder.job_id,
      cwd: workspace,
      writeMode: false,
      sessionId,
    })

    const challenger = newTestJob(store, { cwd: workspace, writeMode: false, sessionId })
    expect(() =>
      acquireJobLocks(store, {
        jobId: challenger.job_id,
        cwd: workspace,
        writeMode: false,
        sessionId,
      }),
    ).toThrow(LockConflictError)
  })
})

describe('stale holder reclamation', () => {
  it('acquisition succeeds once the holder pid has died', () => {
    const { store, workspace } = handle
    const holder = newTestJob(store, { cwd: workspace, writeMode: true })
    markRunning(store, holder.job_id, deadPid(), null)

    // Directly install the lock row the (now-dead) holder would have taken —
    // acquireJobLocks itself would refuse to grant a lock to an already-dead pid,
    // so this reproduces "was alive, died, next acquisition reclaims it".
    store.db
      .prepare('INSERT INTO locks (scope, key, holder_job_id, acquired_at) VALUES (?, ?, ?, ?)')
      .run('cwd_write', canonicalize(workspace), holder.job_id, Date.now())

    const challenger = newTestJob(store, { cwd: workspace, writeMode: true })
    const acquired = acquireJobLocks(store, {
      jobId: challenger.job_id,
      cwd: workspace,
      writeMode: true,
    })

    expect(acquired.reclaimed).toHaveLength(1)
    expect(acquired.reclaimed[0]?.holder_job_id).toBe(holder.job_id)
    expect(acquired.rows[0]?.holder_job_id).toBe(challenger.job_id)

    const rows = listLocks(store, 'cwd_write')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.holder_job_id).toBe(challenger.job_id)
  })

  it('a live pid with a mismatched proc_start_time (pid reuse) is treated as stale', () => {
    const { store, workspace } = handle
    const holder = newTestJob(store, { cwd: workspace, writeMode: true })
    // process.pid is genuinely alive (it's us), but the recorded start-time token
    // is deliberately wrong — simulating the pid having been recycled since.
    markRunning(store, holder.job_id, process.pid, 'definitely-not-the-real-start-time')

    store.db
      .prepare('INSERT INTO locks (scope, key, holder_job_id, acquired_at) VALUES (?, ?, ?, ?)')
      .run('cwd_write', canonicalize(workspace), holder.job_id, Date.now())

    const challenger = newTestJob(store, { cwd: workspace, writeMode: true })
    const acquired = acquireJobLocks(store, {
      jobId: challenger.job_id,
      cwd: workspace,
      writeMode: true,
    })

    expect(acquired.reclaimed).toHaveLength(1)
    expect(acquired.reclaimed[0]?.holder_job_id).toBe(holder.job_id)
  })

  it('a live pid whose proc_start_time still matches is NOT reclaimed', () => {
    const { store, workspace } = handle
    const holder = newTestJob(store, { cwd: workspace, writeMode: true })
    markRunning(store, holder.job_id, process.pid, getProcStartTime(process.pid))
    acquireJobLocks(store, { jobId: holder.job_id, cwd: workspace, writeMode: true })

    const challenger = newTestJob(store, { cwd: workspace, writeMode: true })
    expect(() =>
      acquireJobLocks(store, { jobId: challenger.job_id, cwd: workspace, writeMode: true }),
    ).toThrow(LockConflictError)
  })

  it('reapStaleLocks sweeps every dead-holder row, live ones untouched', () => {
    const { store, workspace } = handle
    const dead = newTestJob(store, { cwd: `${workspace}/a`, writeMode: true })
    markRunning(store, dead.job_id, deadPid(), null)
    const alive = newTestJob(store, { cwd: `${workspace}/b`, writeMode: true })
    markRunning(store, alive.job_id, process.pid, getProcStartTime(process.pid))

    store.db
      .prepare('INSERT INTO locks (scope, key, holder_job_id, acquired_at) VALUES (?, ?, ?, ?)')
      .run('cwd_write', canonicalize(`${workspace}/a`), dead.job_id, Date.now())
    store.db
      .prepare('INSERT INTO locks (scope, key, holder_job_id, acquired_at) VALUES (?, ?, ?, ?)')
      .run('cwd_write', canonicalize(`${workspace}/b`), alive.job_id, Date.now())

    const reclaimed = reapStaleLocks(store)
    expect(reclaimed.map((r) => r.holder_job_id)).toEqual([dead.job_id])

    const remaining = listLocks(store, 'cwd_write')
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.holder_job_id).toBe(alive.job_id)
  })
})

describe('running-job ceiling', () => {
  it('blocks acquisition once the per-project running limit is hit', () => {
    const { store, workspace } = handle
    const holders = Array.from({ length: DEFAULT_MAX_RUNNING }, (_, i) =>
      newTestJob(store, { cwd: `${workspace}/w${i}`, writeMode: false }),
    )
    for (const h of holders) markRunning(store, h.job_id, process.pid, getProcStartTime(process.pid))

    const oneMore = newTestJob(store, { cwd: `${workspace}/w-extra`, writeMode: false })
    let thrown: unknown
    try {
      acquireJobLocks(store, { jobId: oneMore.job_id, cwd: `${workspace}/w-extra`, writeMode: false })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(LockConflictError)
    expect((thrown as LockConflictError).detail.reason).toBe('limit')
  })
})
