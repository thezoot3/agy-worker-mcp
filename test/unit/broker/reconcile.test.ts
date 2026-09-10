/**
 * `reconcileJob` rows that the 2026-09-08 usage audit
 * caught misjudging real jobs, pinned here so they stay fixed (PR1):
 *
 * - agy's pid is gone while the runner is still running `verify_command`
 *   → the job is *running*, not `process_error`;
 * - a passed `deadline_at` while the runner is verifying → still running,
 *   because verify has its own clock;
 * - `finished_at` / `duration_ms` come from the runner's recorded end time,
 *   not from whenever reconcile happened to look.
 *
 * Process facts are real: a dead pid comes from a process that has actually
 * exited, and "the runner" is this test process itself.
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { reconcileJob } from '../../../src/broker/reconcile.js'
import { ensureJobDirs, jobPaths, readJsonIfExists } from '../../../src/contract/paths.js'
import type { BrokerResult, JobRow, JobStateFile } from '../../../src/contract/types.js'
import { getJob } from '../../../src/store/jobs.js'
import { makeTestStore, markRunning, newTestJob, type TestStoreHandle } from '../helpers/store.js'

let handle: TestStoreHandle

beforeEach(() => {
  handle = makeTestStore()
})

afterEach(() => {
  handle.cleanup()
})

/** A pid that certainly belonged to a process which has already exited. */
function deadPid(): number {
  const r = spawnSync('true')
  if (r.pid == null || r.pid <= 0) throw new Error('spawnSync produced no pid')
  return r.pid
}

interface Fixture {
  job: JobRow
  state: string
  exitCode: string
  brokerResult: string
}

function runningJob(opts: { agyPid: number; deadlineAt?: number; startedAt?: number }): Fixture {
  const job = newTestJob(handle.store, { cwd: handle.workspace, deadlineAt: opts.deadlineAt ?? null })
  const paths = ensureJobDirs(jobPaths(handle.store.paths, job.job_id))
  const running = markRunning(handle.store, job.job_id, opts.agyPid, null)
  if (opts.startedAt !== undefined) {
    handle.store.db.prepare('UPDATE jobs SET started_at = ? WHERE job_id = ?').run(opts.startedAt, job.job_id)
  }
  return { job: getJob(handle.store, running.job_id), state: paths.state, exitCode: paths.exitCode, brokerResult: paths.brokerResult }
}

function writeState(path: string, job: JobRow, extra: Partial<JobStateFile>): void {
  const state: JobStateFile = {
    job_id: job.job_id,
    lifecycle: 'running',
    pid: job.pid,
    pgid: job.pgid,
    proc_start_time: null,
    started_at: job.started_at,
    finished_at: null,
    updated_at: Date.now(),
    ...extra,
  }
  writeFileSync(path, JSON.stringify(state))
}

describe('reconcileJob while the runner is verifying', () => {
  it('agy pid gone + phase "verifying" + live runner_pid → still running, no result written', async () => {
    const f = runningJob({ agyPid: deadPid() })
    writeState(f.state, f.job, { phase: 'verifying', runner_pid: process.pid })

    const after = await reconcileJob(handle.store, f.job)

    expect(after.lifecycle).toBe('running')
    expect(after.outcome).toBeNull()
    expect(readJsonIfExists(f.brokerResult)).toBeNull()
  })

  it('agy pid gone + phase "agy" + live runner_pid → still running (writeback window)', async () => {
    const f = runningJob({ agyPid: deadPid() })
    writeState(f.state, f.job, { phase: 'agy', runner_pid: process.pid })

    const after = await reconcileJob(handle.store, f.job)

    expect(after.lifecycle).toBe('running')
  })

  it('agy pid gone + runner_pid also gone → process_error, as before', async () => {
    const f = runningJob({ agyPid: deadPid() })
    writeState(f.state, f.job, { phase: 'verifying', runner_pid: deadPid() })

    const after = await reconcileJob(handle.store, f.job)

    expect(after.lifecycle).toBe('finished')
    expect(after.outcome).toBe('process_error')
  }, 10_000)

  it('agy pid gone + state.json from an older build (no runner_pid) → process_error, as before', async () => {
    const f = runningJob({ agyPid: deadPid() })
    writeState(f.state, f.job, {})

    const after = await reconcileJob(handle.store, f.job)

    expect(after.outcome).toBe('process_error')
  }, 10_000)

  it('deadline passed while verifying → still running until the verify clock plus backstop runs out', async () => {
    const deadlineAt = Date.now() - 1000
    const f = runningJob({ agyPid: deadPid(), deadlineAt })
    writeState(f.state, f.job, { phase: 'verifying', runner_pid: process.pid })

    const during = await reconcileJob(handle.store, f.job, { now: deadlineAt + 1 })
    expect(during.lifecycle).toBe('running')

    // No effective-config → verify budget is deadline + 0 + the 60 s backstop.
    const after = await reconcileJob(handle.store, during, { now: deadlineAt + 61_000 })
    expect(after.lifecycle).toBe('finished')
    expect(after.outcome).toBe('timed_out')
  }, 10_000)
})

describe('reconcileJob timing on a normal exit', () => {
  it('finished_at and duration_ms come from state.json, not from when reconcile looked', async () => {
    const startedAt = Date.now() - 4 * 24 * 3_600_000
    const runnerFinishedAt = startedAt + 30 * 60_000
    const f = runningJob({ agyPid: deadPid(), startedAt })
    writeState(f.state, f.job, {
      lifecycle: 'finished',
      finished_at: runnerFinishedAt,
      phase: 'done',
      runner_pid: deadPid(),
    })
    writeFileSync(f.exitCode, '0\n')

    const discoveredAt = Date.now()
    const after = await reconcileJob(handle.store, f.job, { now: discoveredAt })

    expect(after.lifecycle).toBe('finished')
    expect(after.finished_at).toBe(runnerFinishedAt)

    const result = readJsonIfExists<BrokerResult>(f.brokerResult)
    expect(result?.finished_at).toBe(runnerFinishedAt)
    expect(result?.broker_summary.duration_ms).toBe(30 * 60_000)
    expect(result?.finalized_at).toBe(discoveredAt)
  })

  it('abnormal finalization (no exit_code) still stamps the discovery time', async () => {
    const f = runningJob({ agyPid: deadPid() })
    writeState(f.state, f.job, { runner_pid: deadPid() })

    const discoveredAt = Date.now()
    const after = await reconcileJob(handle.store, f.job, { now: discoveredAt })

    expect(after.outcome).toBe('process_error')
    // finalizeAbnormal stamps its own `now()`; only require it not to be
    // some stale runner timestamp.
    expect(after.finished_at).toBeGreaterThanOrEqual(discoveredAt)
  }, 10_000)
})
