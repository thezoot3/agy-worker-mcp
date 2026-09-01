/**
 * 그룹 3 — 세션 (`docs/05` §2). `--conversation` 재개가 무손실인지, `agy_send`
 * 로 큐잉한 턴이 실제로 실행되는지. 이 둘이 "turn = process" 설계의 전제다
 * (`docs/03` §3).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  LIVE,
  LIVE_EFFORT,
  LIVE_MODEL,
  LIVE_TIMEOUT_MS,
  applyLiveEnv,
  ensureBuilt,
  makeLiveProject,
  readEvents,
  recordUsage,
  replyJson,
  waitUntil,
  type LiveProject,
} from './helpers.js'

const live = LIVE ? describe : describe.skip

let project: LiveProject

beforeAll(() => {
  if (LIVE) ensureBuilt()
})

beforeEach(() => {
  if (!LIVE) return
  project = makeLiveProject()
  applyLiveEnv(project)
})

live('L8 — resuming a finished oneshot job keeps the conversation intact', () => {
  it('turn 2 recalls a word only turn 1 was told', async () => {
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')
    const { getSession } = await import('../../src/store/sessions.js')

    const ctx = createContext()
    const t0 = Date.now()

    const first = replyJson(
      await handleStart(ctx, {
        prompt: 'Remember the word TANGERINE. Reply with just: OK. Do not run any commands.',
        profile: 'research_readonly',
        model: LIVE_MODEL,
        effort: LIVE_EFFORT,
        timeout_ms: LIVE_TIMEOUT_MS,
      } as never),
    ) as { job_id: string; session_id: string }
    await handleWait(ctx, { job_id: first.job_id, wait_ms: LIVE_TIMEOUT_MS } as never)
    const firstEvents = readEvents(ctx, first.job_id)
    recordUsage({ test: 'L8/1', job_id: first.job_id, model: LIVE_MODEL, events: firstEvents, wall_ms: Date.now() - t0 })

    const conversationAfterFirst = getSession(ctx.store, first.session_id)?.conversation_id
    expect(conversationAfterFirst).toBeTruthy()

    const t1 = Date.now()
    const second = replyJson(
      await handleStart(ctx, {
        prompt: 'What word did I ask you to remember? Reply with just that one word.',
        session_id: first.session_id,
        profile: 'research_readonly',
        model: LIVE_MODEL,
        effort: LIVE_EFFORT,
        timeout_ms: LIVE_TIMEOUT_MS,
      } as never),
    ) as { job_id: string; session_id: string }
    const waited = replyJson(
      await handleWait(ctx, { job_id: second.job_id, wait_ms: LIVE_TIMEOUT_MS } as never),
    ) as { lifecycle: string; outcome: string }
    const secondEvents = readEvents(ctx, second.job_id)
    recordUsage({ test: 'L8/2', job_id: second.job_id, model: LIVE_MODEL, events: secondEvents, wall_ms: Date.now() - t1 })

    const agent = replyJson(
      await handleResult(ctx, { job_id: second.job_id, section: 'agent' } as never),
    ) as { agent?: { response?: string; num_turns?: number } }
    // eslint-disable-next-line no-console
    console.log('[L8]', JSON.stringify({ outcome: waited.outcome, agent: agent.agent }))

    // The same conversation was resumed, not a new one started.
    expect(getSession(ctx.store, second.session_id)?.conversation_id).toBe(conversationAfterFirst)
    expect(second.session_id).toBe(first.session_id)
    // Lossless resume: turn 2 can only know this from turn 1's context.
    expect((agent.agent?.response ?? '').toUpperCase()).toContain('TANGERINE')

    ctx.store.close()
  })
})

live('L9 — agy_send queues a turn onto a live session and num_turns advances', () => {
  it('a session-mode job accepts a follow-up and finishes having run both turns', async () => {
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleSend } = await import('../../src/server/tools/send.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')
    const { reconcile } = await import('../../src/broker/reconcile.js')
    const { getJob } = await import('../../src/store/jobs.js')

    const ctx = createContext()
    const t0 = Date.now()
    const started = replyJson(
      await handleStart(ctx, {
        prompt: 'Reply with just: FIRST. Do not run any commands.',
        profile: 'research_readonly',
        session_mode: 'session',
        model: LIVE_MODEL,
        effort: LIVE_EFFORT,
        timeout_ms: 150_000,
      } as never),
    ) as { job_id: string; session_id: string }

    // Queue as soon as the runner is actually up, so the relay has a stdin to
    // write to (docs/03 §4 — the inbox is drained by the runner, not the server).
    await waitUntil(
      async () => {
        await reconcile(ctx.store)
        return getJob(ctx.store, started.job_id).pid !== null ? true : null
      },
      { timeoutMs: 30_000, label: 'runner up' },
    )
    const sent = replyJson(
      await handleSend(ctx, { job_id: started.job_id, prompt: 'Now reply with just: SECOND.' } as never),
    ) as Record<string, unknown>
    // eslint-disable-next-line no-console
    console.log('[L9] send ->', JSON.stringify(sent))

    const waited = replyJson(
      await handleWait(ctx, { job_id: started.job_id, wait_ms: 160_000 } as never),
    ) as { lifecycle: string; outcome: string }
    const events = readEvents(ctx, started.job_id)
    recordUsage({ test: 'L9', job_id: started.job_id, model: LIVE_MODEL, events, wall_ms: Date.now() - t0 })

    const agent = replyJson(
      await handleResult(ctx, { job_id: started.job_id, section: 'agent' } as never),
    ) as { agent?: { num_turns?: number; response?: string } }
    // eslint-disable-next-line no-console
    console.log(
      '[L9]',
      JSON.stringify({
        lifecycle: waited.lifecycle,
        outcome: waited.outcome,
        result_events: events.filter((e) => e.event === 'result').length,
        agent: agent.agent,
      }),
    )

    expect(waited.lifecycle).toBe('finished')
    expect(events.filter((e) => e.event === 'result').length).toBeGreaterThanOrEqual(2)

    ctx.store.close()
  })
})
