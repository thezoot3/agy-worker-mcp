/**
 * Unit tests for `agy_send` handler (`src/server/tools/send.ts`).
 *
 * Verifies observable behavior:
 * - Happy path: Running session-mode job accepts follow-up turn and close directives, appending ndjson to inbox.jsonl.
 * - Error path: Sending to a finished job returns VALIDATION error.
 * - Error path: Sending to a oneshot session-mode job returns VALIDATION error.
 * - Error path: Missing both text and close flag returns VALIDATION error.
 * - Error path: Non-existent job returns JOB_NOT_FOUND error.
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { jobPaths } from '../../../src/contract/paths.js'
import type { InboxControlLine, InboxUserLine } from '../../../src/contract/types.js'
import { DEFAULT_LIMITS, type ToolContext } from '../../../src/server/context.js'
import { handleSend } from '../../../src/server/tools/send.js'
import { updateJob } from '../../../src/store/jobs.js'
import { makeTestStore, newTestJob, type TestStoreHandle } from '../helpers/store.js'

function replyJson<T = Record<string, unknown>>(reply: { content: Array<{ type: string; text: string }> }): T {
  return JSON.parse(reply.content[0]!.text) as T
}

describe('agy_send tool handler', () => {
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

  it('queues a follow-up user turn and close directive into inbox.jsonl for running session job', async () => {
    const job = newTestJob(ctx.store, { cwd: handle.workspace, sessionMode: 'session' })
    updateJob(ctx.store, job.job_id, { lifecycle: 'running' })

    const rep = await handleSend(ctx, {
      job_id: job.job_id,
      text: 'continue with the next step',
      close: true,
    })
    expect(rep.isError).toBeFalsy()

    const body = replyJson<{ job_id: string; queued: boolean; closed: boolean }>(rep)
    expect(body.job_id).toBe(job.job_id)
    expect(body.queued).toBe(true)
    expect(body.closed).toBe(true)

    // Verify inbox file on disk
    const paths = jobPaths(ctx.paths, job.job_id)
    const rawLines = readFileSync(paths.inbox, 'utf8').trim().split('\n')
    expect(rawLines).toHaveLength(2)

    const turn = JSON.parse(rawLines[0]!) as InboxUserLine
    expect(turn.event).toBe('user')
    expect(turn.message.role).toBe('user')
    expect(turn.message.content[0]!.text).toBe('continue with the next step')

    const closeLine = JSON.parse(rawLines[1]!) as InboxControlLine
    expect(closeLine.agy_worker_control).toBe('close')
    expect(typeof closeLine.ts).toBe('number')
  })

  it('returns VALIDATION error when sending to a finished job', async () => {
    const job = newTestJob(ctx.store, { cwd: handle.workspace, sessionMode: 'session' })
    updateJob(ctx.store, job.job_id, { lifecycle: 'finished' })

    const rep = await handleSend(ctx, { job_id: job.job_id, text: 'hello' })
    expect(rep.isError).toBe(true)

    const body = replyJson<{ error: string; message: string; detail?: { field?: string } }>(rep)
    expect(body.error).toBe('VALIDATION')
    expect(body.detail?.field).toBe('job_id')
    expect(body.message).toContain('is already "finished"')
  })

  it('returns VALIDATION error when sending to a oneshot job', async () => {
    const job = newTestJob(ctx.store, { cwd: handle.workspace, sessionMode: 'oneshot' })
    updateJob(ctx.store, job.job_id, { lifecycle: 'running' })

    const rep = await handleSend(ctx, { job_id: job.job_id, text: 'hello' })
    expect(rep.isError).toBe(true)

    const body = replyJson<{ error: string; message: string; detail?: { field?: string } }>(rep)
    expect(body.error).toBe('VALIDATION')
    expect(body.detail?.field).toBe('job_id')
    expect(body.message).toContain('session_mode "session"')
  })

  it('returns VALIDATION error when neither text nor close is provided', async () => {
    const job = newTestJob(ctx.store, { cwd: handle.workspace, sessionMode: 'session' })
    updateJob(ctx.store, job.job_id, { lifecycle: 'running' })

    const rep = await handleSend(ctx, { job_id: job.job_id })
    expect(rep.isError).toBe(true)

    const body = replyJson<{ error: string; message: string; detail?: { field?: string } }>(rep)
    expect(body.error).toBe('VALIDATION')
    expect(body.detail?.field).toBe('text/close')
  })

  it('returns JOB_NOT_FOUND error when job_id does not exist', async () => {
    const rep = await handleSend(ctx, { job_id: 'job-nonexistent', text: 'hello' })
    expect(rep.isError).toBe(true)

    const body = replyJson<{ error: string; message: string }>(rep)
    expect(body.error).toBe('JOB_NOT_FOUND')
    expect(body.message).toContain('job-nonexistent')
  })
})
