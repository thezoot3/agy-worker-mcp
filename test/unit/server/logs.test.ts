/**
 * Unit tests for `agy_logs` handler (`src/server/tools/logs.ts`).
 *
 * Verifies observable behavior:
 * - Happy path (cursor): Reads NDJSON event lines using after_cursor, returning lines and next cursor offset.
 * - Happy path (tail): Reads the last N lines using tail_lines.
 * - Error path: Non-existent job_id returns JOB_NOT_FOUND error.
 * - Error path: Mutually exclusive parameters (after_cursor and tail_lines together) return VALIDATION error.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { jobPaths } from '../../../src/contract/paths.js'
import { DEFAULT_LIMITS, type ToolContext } from '../../../src/server/context.js'
import { handleLogs } from '../../../src/server/tools/logs.js'
import { makeTestStore, newTestJob, type TestStoreHandle } from '../helpers/store.js'

function replyJson<T = Record<string, unknown>>(reply: { content: Array<{ type: string; text: string }> }): T {
  return JSON.parse(reply.content[0]!.text) as T
}

describe('agy_logs tool handler', () => {
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

  it('reads event logs via cursor and tail_lines from written ndjson', async () => {
    const job = newTestJob(ctx.store, { cwd: handle.workspace })
    const paths = jobPaths(ctx.paths, job.job_id)
    mkdirSync(paths.dir, { recursive: true })

    const line1 = JSON.stringify({ event: 'init', session_id: 's1' })
    const line2 = JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE' } })
    const line3 = JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } })
    writeFileSync(paths.events, `${line1}\n${line2}\n${line3}\n`, 'utf8')

    // 1. Cursor read from offset 0
    const cursorRep = await handleLogs(ctx, { job_id: job.job_id, stream: 'events', after_cursor: 0 })
    expect(cursorRep.isError).toBeFalsy()

    const cursorBody = replyJson<{
      job_id: string
      stream: string
      lines: string[]
      cursor: number
      eof: boolean
    }>(cursorRep)

    expect(cursorBody.job_id).toBe(job.job_id)
    expect(cursorBody.stream).toBe('events')
    expect(cursorBody.lines).toEqual([line1, line2, line3])
    expect(cursorBody.cursor).toBeGreaterThan(0)
    expect(cursorBody.eof).toBe(true)

    // 2. Tail read for last 2 lines
    const tailRep = await handleLogs(ctx, { job_id: job.job_id, stream: 'events', tail_lines: 2 })
    expect(tailRep.isError).toBeFalsy()

    const tailBody = replyJson<{
      job_id: string
      stream: string
      lines: string[]
    }>(tailRep)

    expect(tailBody.job_id).toBe(job.job_id)
    expect(tailBody.stream).toBe('events')
    expect(tailBody.lines).toEqual([line2, line3])
  })

  it('returns JOB_NOT_FOUND error when job_id does not exist', async () => {
    const rep = await handleLogs(ctx, { job_id: 'job-nonexistent' })
    expect(rep.isError).toBe(true)

    const body = replyJson<{
      error: string
      message: string
    }>(rep)

    expect(body.error).toBe('JOB_NOT_FOUND')
    expect(body.message).toContain('job-nonexistent')
  })

  it('returns VALIDATION error when both after_cursor and tail_lines are provided', async () => {
    const job = newTestJob(ctx.store, { cwd: handle.workspace })
    const rep = await handleLogs(ctx, {
      job_id: job.job_id,
      after_cursor: 0,
      tail_lines: 10,
    })
    expect(rep.isError).toBe(true)

    const body = replyJson<{
      error: string
      message: string
      detail?: { field?: string }
    }>(rep)

    expect(body.error).toBe('VALIDATION')
    expect(body.detail?.field).toBe('after_cursor/tail_lines')
  })

  it('returns digest stream and rejects pagination parameters', async () => {
    const job = newTestJob(ctx.store, { cwd: handle.workspace })
    const rep = await handleLogs(ctx, { job_id: job.job_id, stream: 'digest' })
    expect(rep.isError).toBeFalsy()
    const body = replyJson<{ job_id: string; stream: string; digest: unknown; text: string }>(rep)
    expect(body.stream).toBe('digest')
    expect(body.text).toContain(`job ${job.job_id}`)

    const conflictRep = await handleLogs(ctx, { job_id: job.job_id, stream: 'digest', tail_lines: 5 })
    expect(conflictRep.isError).toBe(true)
    const errBody = replyJson<{ error: string; detail?: { field?: string } }>(conflictRep)
    expect(errBody.error).toBe('VALIDATION')
    expect(errBody.detail?.field).toBe('stream')
  })
})

