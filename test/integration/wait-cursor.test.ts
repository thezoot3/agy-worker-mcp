/**
 * The cursor `agy_wait` returns must stay usable after the job finishes.
 *
 * Found by driving the server from a real MCP client: the finished branch of
 * `handleWait` returns the judgement packet rather than a cursor read, and it
 * used to report `cursor: 0`. A caller that polled `agy_wait` and then handed
 * that cursor to `agy_logs` replayed the entire stream from byte 0.
 */
import { readFileSync } from 'node:fs'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { applyEnv, ensureBuilt, makeProject, replyJson, type TestProject } from './helpers.js'

let project: TestProject

beforeAll(() => {
  ensureBuilt()
})

beforeEach(() => {
  project = makeProject()
})

describe('agy_wait cursor after completion', () => {
  it('reports end-of-stream, so a follow-up agy_logs read returns nothing new', async () => {
    applyEnv(project, 'happy')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleLogs } = await import('../../src/server/tools/logs.js')

    const ctx = createContext()
    const started = replyJson(
      await handleStart(ctx, { prompt: 'x', profile: 'general_worker' } as never),
    ) as { job_id: string }

    const waited = replyJson(
      await handleWait(ctx, { job_id: started.job_id, wait_ms: 10_000 } as never),
    ) as { lifecycle: string; cursor: number }
    expect(waited.lifecycle).toBe('finished')

    const { jobPaths } = await import('../../src/contract/paths.js')
    const paths = jobPaths(ctx.paths, started.job_id)
    const size = readFileSync(paths.events).byteLength
    expect(size).toBeGreaterThan(0)

    // The whole point: not 0, and not past the end either.
    expect(waited.cursor).toBeGreaterThan(0)
    expect(waited.cursor).toBeLessThanOrEqual(size)

    const after = replyJson(
      await handleLogs(ctx, {
        job_id: started.job_id,
        stream: 'events',
        after_cursor: waited.cursor,
      } as never),
    ) as { lines: string[]; cursor: number }
    expect(after.lines).toEqual([])
    expect(after.cursor).toBe(waited.cursor)
  })
})
