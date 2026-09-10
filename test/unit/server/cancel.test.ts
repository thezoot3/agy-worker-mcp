/**
 * Unit tests for `agy_cancel` handler (`src/server/tools/cancel.ts`).
 *
 * Verifies observable behavior:
 * - Happy path: Canceling a queued job transitions its lifecycle to 'canceling' without killing processes.
 * - Idempotency: Canceling an already finished job returns early without attempting kill.
 * - Error path: Canceling a non-existent job returns JOB_NOT_FOUND error envelope.
 * - A queued job with no pid yet is only *marked* `canceling`: the runner still
 *   owns `exit_code`, so finalization waits for the pid to arrive (row 5 of
 *   reconcile kills it then) or for `deadline_at`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_LIMITS, type ToolContext } from '../../../src/server/context.js'
import { handleCancel } from '../../../src/server/tools/cancel.js'
import { getJob, updateJob } from '../../../src/store/jobs.js'
import { makeTestStore, newTestJob, type TestStoreHandle } from '../helpers/store.js'

function replyJson<T = Record<string, unknown>>(reply: { content: Array<{ type: string; text: string }> }): T {
  return JSON.parse(reply.content[0]!.text) as T
}

describe('agy_cancel tool handler', () => {
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

  it('canceling a queued job transitions lifecycle to canceling', async () => {
    const job = newTestJob(ctx.store, { cwd: handle.workspace })
    expect(job.lifecycle).toBe('queued')

    const rep = await handleCancel(ctx, { job_id: job.job_id, reason: 'test cancel' })
    expect(rep.isError).toBeFalsy()

    const body = replyJson<{
      job_id: string
      lifecycle: string
      outcome: string | null
      killed: boolean
      pgid: number | null
      reason: string | null
    }>(rep)

    expect(body.job_id).toBe(job.job_id)
    expect(body.lifecycle).toBe('canceling')
    expect(body.killed).toBe(false)
    expect(body.reason).toBe('test cancel')

    const dbJob = getJob(ctx.store, job.job_id)
    expect(dbJob.lifecycle).toBe('canceling')
  })

  it('canceling an already finished job returns already finished message without killing', async () => {
    const job = newTestJob(ctx.store, { cwd: handle.workspace })
    updateJob(ctx.store, job.job_id, { lifecycle: 'finished', outcome: 'verified_success' })

    const rep = await handleCancel(ctx, { job_id: job.job_id })
    expect(rep.isError).toBeFalsy()

    const body = replyJson<{
      job_id: string
      lifecycle: string
      killed: boolean
      message?: string
    }>(rep)

    expect(body.job_id).toBe(job.job_id)
    expect(body.lifecycle).toBe('finished')
    expect(body.killed).toBe(false)
    expect(body.message).toBe('already finished')
  })

  it('canceling a non-existent job returns JOB_NOT_FOUND error', async () => {
    const rep = await handleCancel(ctx, { job_id: 'job-does-not-exist' })
    expect(rep.isError).toBe(true)

    const body = replyJson<{
      error: string
      message: string
      remedy?: string
    }>(rep)

    expect(body.error).toBe('JOB_NOT_FOUND')
    expect(body.message).toContain('job-does-not-exist')
  })

  it('a queued job without a pid is marked canceling and left for reconcile to finalize', async () => {
    // Nothing to kill yet: the runner has not published agy's pid. cancel must
    // not invent a `canceled` outcome (the runner owns `exit_code` and finalization);
    // the mark is picked up once the pid appears or the deadline passes.
    const job = newTestJob(ctx.store, { cwd: handle.workspace })
    const rep = await handleCancel(ctx, { job_id: job.job_id })
    const body = replyJson<{ lifecycle: string; outcome: string | null; killed: boolean }>(rep)
    expect(body.lifecycle).toBe('canceling')
    expect(body.outcome).toBeNull()
    expect(body.killed).toBe(false)
    expect(getJob(ctx.store, job.job_id).lifecycle).toBe('canceling')
  })
})
