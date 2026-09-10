import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore } from '../../../src/store/db.js'
import type { Store } from '../../../src/store/db.js'
import { createJob, updateJob } from '../../../src/store/jobs.js'
import type { NewJob } from '../../../src/store/jobs.js'
import type { JobRow } from '../../../src/contract/types.js'

/**
 * Isolated project store for one test. Points `AGY_WORKER_HOME` and
 * `AGY_WORKER_PROJECT` at fresh temp dirs so tests never share SQLite state or
 * race on the real home directory, and restores both env vars on cleanup.
 */
export interface TestStoreHandle {
  store: Store
  /** Canonical project root / workspace for this test. */
  workspace: string
  cleanup(): void
}

export function makeTestStore(): TestStoreHandle {
  const home = mkdtempSync(join(tmpdir(), 'agy-worker-home-'))
  const project = mkdtempSync(join(tmpdir(), 'agy-worker-project-'))
  const prevHome = process.env.AGY_WORKER_HOME
  const prevProject = process.env.AGY_WORKER_PROJECT
  process.env.AGY_WORKER_HOME = home
  process.env.AGY_WORKER_PROJECT = project

  const store = openStore({ cwd: project })

  return {
    store,
    workspace: project,
    cleanup(): void {
      store.close()
      if (prevHome === undefined) delete process.env.AGY_WORKER_HOME
      else process.env.AGY_WORKER_HOME = prevHome
      if (prevProject === undefined) delete process.env.AGY_WORKER_PROJECT
      else process.env.AGY_WORKER_PROJECT = prevProject
      rmSync(home, { recursive: true, force: true })
      rmSync(project, { recursive: true, force: true })
    },
  }
}

export interface NewTestJobOptions extends Partial<NewJob> {
  cwd: string
}

/** Create a job row with sane defaults for lock/reconcile tests. */
export function newTestJob(store: Store, opts: NewTestJobOptions): JobRow {
  const jobId = opts.jobId ?? `job-${Math.random().toString(36).slice(2)}`
  return createJob(store, {
    jobId,
    sessionId: opts.sessionId ?? null,
    cwd: opts.cwd,
    profile: opts.profile ?? 'general_worker',
    writeMode: opts.writeMode ?? true,
    sessionMode: opts.sessionMode ?? 'oneshot',
    onDenial: opts.onDenial ?? 'continue',
    deadlineAt: opts.deadlineAt ?? null,
  })
}

/** Patch a job to look like a live, running holder with a given pid. */
export function markRunning(
  store: Store,
  jobId: string,
  pid: number,
  procStartTime: string | null,
): JobRow {
  return updateJob(store, jobId, {
    lifecycle: 'running',
    pid,
    pgid: pid,
    proc_start_time: procStartTime,
    started_at: Date.now(),
  })
}
