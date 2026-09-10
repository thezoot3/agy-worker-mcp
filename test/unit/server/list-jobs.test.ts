/**
 * Unit tests for `agy_list_jobs` handler (`src/server/tools/listJobs.ts`).
 *
 * Verifies observable behavior:
 * - Happy path: Lists jobs with filtering by lifecycle and limits, correctly ordered by created_at DESC.
 * - Error path: Returns an error envelope when query execution fails (e.g. invalid SQL parameter type, undefined input).
 * - Finding (it.fails): `handleListJobs` omits zod schema validation (`listJobsInput.parse`), so
 *   invalid arguments like negative limits or invalid lifecycles are silently ignored rather than
 *   returning a validation error.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { JobRow } from '../../../src/contract/types.js'
import { DEFAULT_LIMITS, type ToolContext } from '../../../src/server/context.js'
import { handleListJobs } from '../../../src/server/tools/listJobs.js'
import { updateJob } from '../../../src/store/jobs.js'
import { makeTestStore, newTestJob, type TestStoreHandle } from '../helpers/store.js'

function replyJson<T = Record<string, unknown>>(reply: { content: Array<{ type: string; text: string }> }): T {
  return JSON.parse(reply.content[0]!.text) as T
}

describe('agy_list_jobs tool handler', () => {
  let handle: TestStoreHandle
  let ctx: ToolContext

  beforeEach(() => {
    handle = makeTestStore()
    ctx = {
      store: handle.store,
      paths: handle.store.paths,
      version: '0.2.2',
      limits: DEFAULT_LIMITS,
    }
  })

  afterEach(() => {
    handle.cleanup()
  })

  it('lists jobs with correct count, lifecycle filter, and limit', async () => {
    const job1 = newTestJob(ctx.store, { cwd: handle.workspace, profile: 'general_worker' })
    const job2 = newTestJob(ctx.store, { cwd: handle.workspace, profile: 'research_readonly' })
    const job3 = newTestJob(ctx.store, { cwd: handle.workspace, profile: 'general_worker' })

    // Give distinct timestamps to test ordering deterministically
    ctx.store.db.prepare('UPDATE jobs SET created_at = ? WHERE job_id = ?').run(1000, job1.job_id)
    ctx.store.db.prepare('UPDATE jobs SET created_at = ? WHERE job_id = ?').run(2000, job2.job_id)
    ctx.store.db.prepare('UPDATE jobs SET created_at = ? WHERE job_id = ?').run(3000, job3.job_id)

    updateJob(ctx.store, job2.job_id, { lifecycle: 'running' })
    updateJob(ctx.store, job3.job_id, { lifecycle: 'finished' })

    // 1. List all jobs (no filter): should return all 3, ordered newest first (job3, job2, job1)
    const allRep = await handleListJobs(ctx, {})
    expect(allRep.isError).toBeFalsy()
    const allBody = replyJson<{ jobs: JobRow[]; count: number }>(allRep)
    expect(allBody.count).toBe(3)
    expect(allBody.jobs.map((j) => j.job_id)).toEqual([job3.job_id, job2.job_id, job1.job_id])

    // 2. Filter by lifecycle
    const runningRep = await handleListJobs(ctx, { lifecycle: ['running'] })
    expect(runningRep.isError).toBeFalsy()
    const runningBody = replyJson<{ jobs: JobRow[]; count: number }>(runningRep)
    expect(runningBody.count).toBe(1)
    expect(runningBody.jobs[0]!.job_id).toBe(job2.job_id)
    expect(runningBody.jobs[0]!.lifecycle).toBe('running')

    // 3. Filter with limit
    const limitRep = await handleListJobs(ctx, { limit: 2 })
    expect(limitRep.isError).toBeFalsy()
    const limitBody = replyJson<{ jobs: JobRow[]; count: number }>(limitRep)
    expect(limitBody.count).toBe(2)
    expect(limitBody.jobs.map((j) => j.job_id)).toEqual([job3.job_id, job2.job_id])
  })

  it('returns error envelope when query parameter has invalid type for SQLite', async () => {
    const rep = await handleListJobs(ctx, { session_id: { invalid: true } as never })
    expect(rep.isError).toBe(true)
  })

  it('returns error envelope when input is undefined', async () => {
    const rep = await handleListJobs(ctx, undefined as never)
    expect(rep.isError).toBe(true)
  })

  it.fails('rejects invalid arguments violating listJobsInput schema with VALIDATION error', async () => {
    // Finding / Bug: handleListJobs does not parse input through listJobsInput (Zod schema),
    // so negative limits or invalid enum values in lifecycle are not rejected with an error.
    const rep = await handleListJobs(ctx, { limit: -5 } as never)
    expect(rep.isError).toBe(true)
  })
})
