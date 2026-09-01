/**
 * docs/04 완료 기준 (task numbering) #17 — the default response stays capped
 * while the raw log on disk is kept in full.
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

describe('#17 — capped response, uncapped raw log', () => {
  it('agy_logs honours a small max_bytes and reports truncated:true, while events.ndjson on disk holds everything', async () => {
    applyEnv(project, 'denial-then-workaround')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleLogs } = await import('../../src/server/tools/logs.js')

    const ctx = createContext()
    const started = replyJson(await handleStart(ctx, { prompt: 'x', profile: 'general_worker' } as never)) as {
      job_id: string
    }
    await handleWait(ctx, { job_id: started.job_id, wait_ms: 10_000 } as never)

    const { jobPaths } = await import('../../src/contract/paths.js')
    const paths = jobPaths(ctx.paths, started.job_id)
    const rawOnDisk = readFileSync(paths.events, 'utf8')
    expect(rawOnDisk.length).toBeGreaterThan(300)
    const rawLineCount = rawOnDisk.split('\n').filter((l) => l.trim().length > 0).length
    expect(rawLineCount).toBeGreaterThanOrEqual(9) // init + user_input + 6 scenario steps + result

    const smallCap = 200
    const capped = replyJson(
      await handleLogs(ctx, { job_id: started.job_id, stream: 'events', after_cursor: 0, max_bytes: smallCap } as never),
    ) as { lines: string[]; cursor: number; truncated: boolean }
    expect(capped.truncated).toBe(true)
    // What actually came back must be a strict prefix of what's really on disk —
    // capping must never fabricate or drop from the middle, only stop early.
    const returnedBytes = capped.lines.reduce((n, l) => n + Buffer.byteLength(l, 'utf8') + 1, 0)
    expect(returnedBytes).toBeLessThanOrEqual(smallCap + 4096) // one line may straddle the boundary
    expect(capped.cursor).toBeLessThan(rawOnDisk.length)
    expect(rawOnDisk.startsWith(capped.lines.join('\n'))).toBe(true)

    // Uncapped default response size stays bounded too (docs/04 #16/#17): the
    // whole file fetched through agy_logs with the server's own default cap
    // must never just dump everything unbounded.
    const uncappedCallStillBounded = replyJson(
      await handleLogs(ctx, { job_id: started.job_id, stream: 'events', after_cursor: 0 } as never),
    ) as { lines: string[] }
    const defaultReturnedBytes = JSON.stringify(uncappedCallStillBounded).length
    expect(defaultReturnedBytes).toBeLessThanOrEqual(ctx.limits.max_response_bytes + 8192)

    ctx.store.close()
  })

  it("agy_wait's judgement packet carries only a short log tail, never the full raw stream", async () => {
    applyEnv(project, 'denial-then-workaround')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')

    const ctx = createContext()
    const started = replyJson(await handleStart(ctx, { prompt: 'x', profile: 'general_worker' } as never)) as {
      job_id: string
    }
    const waited = replyJson(await handleWait(ctx, { job_id: started.job_id, wait_ms: 10_000 } as never)) as {
      log_tail: string[]
      headline: string
      outcome: string
    }

    expect(waited.log_tail.length).toBeLessThanOrEqual(ctx.limits.max_log_tail_lines)
    // A single sentence, present, is what docs/04 #17 says a caller needs to
    // decide the next action without reading anything else.
    expect(typeof waited.headline).toBe('string')
    expect(waited.headline.length).toBeGreaterThan(0)
    expect(waited.headline.length).toBeLessThan(500)

    ctx.store.close()
  })
})
