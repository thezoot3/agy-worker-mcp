/**
 * docs/04 완료 기준 (task numbering) #4, #5, #6, #7 — multi-session.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { applyEnv, ensureBuilt, makeProject, replyJson, sleep, waitUntil, type TestProject } from './helpers.js'

let project: TestProject

beforeAll(() => {
  ensureBuilt()
})

beforeEach(() => {
  project = makeProject()
})

describe('#4 — three different sessions run concurrently, each keeping its own conversation', () => {
  it('all three reach finished with distinct session_ids and distinct conversation_ids', async () => {
    applyEnv(project, 'happy')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleSessions } = await import('../../src/server/tools/sessions.js')

    const ctx = createContext()

    const starts = await Promise.all(
      [0, 1, 2].map((i) =>
        handleStart(ctx, { prompt: `job ${i}`, profile: 'research_readonly' } as never).then(replyJson),
      ),
    )
    const sessionIds = starts.map((s: any) => s.session_id as string)
    expect(new Set(sessionIds).size).toBe(3)

    const waited = await Promise.all(
      starts.map((s: any) => handleWait(ctx, { job_id: s.job_id, wait_ms: 10_000 } as never).then(replyJson)),
    )
    for (const w of waited as any[]) expect(w.lifecycle).toBe('finished')

    const sessions = replyJson(await handleSessions(ctx, { action: 'list' } as never)) as {
      sessions: Array<{ session_id: string; conversation_id: string | null }>
    }
    const conversationIds = sessionIds.map(
      (id) => sessions.sessions.find((s) => s.session_id === id)?.conversation_id,
    )
    expect(conversationIds.every((c) => typeof c === 'string' && c.length > 0)).toBe(true)
    expect(new Set(conversationIds).size).toBe(3)

    ctx.store.close()
  })
})

describe('#5 — a second agy_start on the same session_id while the first is still running is a lock error', () => {
  it('rejects with LOCK_CONFLICT scope "session", not a silent queue', async () => {
    applyEnv(project, 'slow')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')

    const ctx = createContext()
    const first = replyJson(await handleStart(ctx, { prompt: 'first', profile: 'research_readonly' } as never)) as {
      job_id: string
      session_id: string
    }

    const secondReply = await handleStart(ctx, {
      prompt: 'second',
      profile: 'research_readonly',
      session_id: first.session_id,
    } as never)

    expect(secondReply.isError).toBe(true)
    const envelope = secondReply.structuredContent as { error: string; detail: { scope: string; key: string } }
    expect(envelope.error).toBe('LOCK_CONFLICT')
    expect(envelope.detail.scope).toBe('session')
    expect(envelope.detail.key).toBe(first.session_id)

    ctx.store.close()
  })
})

describe('#6 — a finished oneshot job resumed via session_id keeps context', () => {
  it('the second job passes --conversation and num_turns keeps counting from the first', async () => {
    applyEnv(project, 'resume')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')
    const { getSession } = await import('../../src/store/sessions.js')

    const ctx = createContext()

    const first = replyJson(
      await handleStart(ctx, { prompt: 'remember 7919', profile: 'research_readonly' } as never),
    ) as { job_id: string; session_id: string }
    await handleWait(ctx, { job_id: first.job_id, wait_ms: 10_000 } as never)

    const sessionAfterFirst = getSession(ctx.store, first.session_id)
    expect(sessionAfterFirst?.conversation_id).toBeTruthy()

    const second = replyJson(
      await handleStart(ctx, {
        prompt: 'what number?',
        profile: 'research_readonly',
        session_id: first.session_id,
      } as never),
    ) as { job_id: string; session_id: string }
    expect(second.session_id).toBe(first.session_id)

    await handleWait(ctx, { job_id: second.job_id, wait_ms: 10_000 } as never)
    const result = replyJson(
      await handleResult(ctx, { job_id: second.job_id, section: 'agent_report' } as never),
    ) as { agent_report: { response: string; num_turns: number | null; conversation_id: string | null } }

    // resume.json's second turn answers "7919" — proof the second process actually
    // resumed rather than starting a brand-new conversation (docs/02 §6).
    expect(result.agent_report.response).toContain('7919')
    expect(result.agent_report.num_turns).toBe(2)
    expect(result.agent_report.conversation_id).toBe(sessionAfterFirst?.conversation_id)

    ctx.store.close()
  })
})

describe('#7 — agy_send queues a follow-up turn that runs after the in-flight one, and num_turns increases', () => {
  it('a session-mode job accepts a queued turn and finishes with num_turns=2', async () => {
    applyEnv(project, 'multi-turn')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleSend } = await import('../../src/server/tools/send.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')

    const ctx = createContext()

    // Session-mode turn 1 travels over stdin, not the command line: agy refuses
    // `--print=<prompt>` together with `--input-format stream-json` (measured,
    // docs/02 §2), so `agy_start` seeds the prompt into `inbox.jsonl` and the
    // runner's relay writes it in. So `prompt` here IS turn 1, and agy_send
    // adds turn 2 — two turns total.
    const started = replyJson(
      await handleStart(ctx, {
        prompt: 'first turn',
        profile: 'research_readonly',
        session_mode: 'session',
        timeout_ms: 20_000,
      } as never),
    ) as { job_id: string }

    // Queue the second turn shortly after turn 1 is in flight; docs/02 §7 says
    // it only takes effect once the in-flight turn finishes (no interrupt path
    // in print mode) — this is the actual property #7 is about.
    await sleep(300)
    const sent = replyJson(
      await handleSend(ctx, { job_id: started.job_id, text: 'second turn', close: true } as never),
    ) as { queued: boolean; closed: boolean }
    expect(sent.queued).toBe(true)
    expect(sent.closed).toBe(true)

    const waited = await waitUntil(
      async () => {
        const w = replyJson(await handleWait(ctx, { job_id: started.job_id, wait_ms: 1000 } as never)) as {
          lifecycle: string
        }
        return w.lifecycle === 'finished' ? w : null
      },
      { timeoutMs: 15_000, label: 'session-mode job with a queued follow-up turn finished' },
    )
    expect(waited).toBeTruthy()

    const result = replyJson(
      await handleResult(ctx, { job_id: started.job_id, section: 'agent_report' } as never),
    ) as { agent_report: { num_turns: number | null; response: string } }
    expect(result.agent_report.num_turns).toBe(2)
    expect(result.agent_report.response).toContain('TURN2-DONE')

    ctx.store.close()
  })
})
