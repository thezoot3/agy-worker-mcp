/**
 * 그룹 1 — 기본 경로 (`docs/05` §2). 여기가 깨지면 나머지 그룹은 의미가 없다.
 *
 * 해소 대상: A1 (`--print-timeout` 문법), A2 (`ps -o lstart=`), A6
 * (`--print=<prompt>` + `--input-format stream-json` 공존).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  LIVE,
  LIVE_EFFORT,
  LIVE_MODEL,
  LIVE_TIMEOUT_MS,
  agyVersion,
  applyLiveEnv,
  ensureBuilt,
  makeLiveProject,
  readEvents,
  recordUsage,
  replyJson,
  requireAgyOnPath,
  waitUntil,
  type LiveProject,
} from './helpers.js'

const live = LIVE ? describe : describe.skip

let project: LiveProject

beforeAll(() => {
  if (!LIVE) return
  ensureBuilt()
  // eslint-disable-next-line no-console
  console.log(`[live] agy ${agyVersion()} at ${requireAgyOnPath()}, model=${LIVE_MODEL}`)
})

beforeEach(() => {
  if (!LIVE) return
  project = makeLiveProject()
  applyLiveEnv(project)
})

live('L1 — oneshot smoke: the argv we build is accepted and the run completes', () => {
  it('agy accepts --print-timeout/--add-dir/--output-format and reaches success_unverified', async () => {
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')

    const ctx = createContext()
    const t0 = Date.now()
    const started = replyJson(
      await handleStart(ctx, {
        prompt: 'Reply with exactly the word PONG and nothing else. Do not run any commands.',
        profile: 'research_readonly',
        model: LIVE_MODEL,
        effort: LIVE_EFFORT,
        timeout_ms: LIVE_TIMEOUT_MS,
      } as never),
    ) as { job_id: string; session_id: string }

    const waited = replyJson(
      await handleWait(ctx, { job_id: started.job_id, wait_ms: LIVE_TIMEOUT_MS } as never),
    ) as { lifecycle: string; outcome: string }

    const events = readEvents(ctx, started.job_id)
    recordUsage({ test: 'L1', job_id: started.job_id, model: LIVE_MODEL, events, wall_ms: Date.now() - t0 })

    // A1: a rejected --print-timeout would be exit 2 before any event is written.
    expect(events.length).toBeGreaterThan(0)
    expect(waited.lifecycle).toBe('finished')

    // The first line is `init` and it is where conversation_id comes from
    // (docs/02 §4) — the gate's whole binding strategy rests on this.
    const init = events[0] as { type?: string; conversation_id?: string }
    expect(init.type).toBe('init')
    expect(typeof init.conversation_id).toBe('string')
    expect(init.conversation_id!.length).toBeGreaterThan(0)

    const full = replyJson(await handleResult(ctx, { job_id: started.job_id } as never)) as {
      broker?: { outcome?: string; exit_code?: number | null }
    }
    // eslint-disable-next-line no-console
    console.log('[L1]', JSON.stringify({ outcome: waited.outcome, broker: full.broker }))
    expect(waited.outcome).toBe('success_unverified')

    ctx.store.close()
  })
})

live('L2 — a running job carries a real start-time token and survives its starting client', () => {
  it('ps -o lstart= yields a token, and a second connection re-attaches instead of finalizing', async () => {
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { reconcile } = await import('../../src/broker/reconcile.js')
    const { getJob } = await import('../../src/store/jobs.js')
    const { getProcStartTime, isPidAlive } = await import('../../src/runner/reap.js')

    const clientA = createContext()
    const t0 = Date.now()
    const started = replyJson(
      await handleStart(clientA, {
        prompt: 'Count slowly from 1 to 5, writing one short sentence about each number.',
        profile: 'research_readonly',
        model: LIVE_MODEL,
        effort: LIVE_EFFORT,
        timeout_ms: LIVE_TIMEOUT_MS,
      } as never),
    ) as { job_id: string }

    const running = await waitUntil(
      async () => {
        await reconcile(clientA.store)
        const job = getJob(clientA.store, started.job_id)
        return job.pid !== null ? job : null
      },
      { timeoutMs: 30_000, label: 'jobs row carries a pid' },
    )

    // A2 — the token has to be a real, non-empty string on this platform, and
    // it has to be the same string reconcile stored.
    expect(running.proc_start_time).not.toBeNull()
    expect(running.proc_start_time!.trim().length).toBeGreaterThan(0)
    if (isPidAlive(running.pid!)) {
      expect(getProcStartTime(running.pid!)).toBe(running.proc_start_time)
    }
    // eslint-disable-next-line no-console
    console.log('[L2] proc_start_time =', JSON.stringify(running.proc_start_time))

    // Client A disappears mid-run.
    clientA.store.close()

    const clientB = createContext()
    const finished = await waitUntil(
      async () => {
        await reconcile(clientB.store)
        const job = getJob(clientB.store, started.job_id)
        return job.lifecycle === 'finished' ? job : null
      },
      { timeoutMs: LIVE_TIMEOUT_MS, label: 'job finished under the second client' },
    )
    const events = readEvents(clientB, started.job_id)
    recordUsage({ test: 'L2', job_id: started.job_id, model: LIVE_MODEL, events, wall_ms: Date.now() - t0 })

    // eslint-disable-next-line no-console
    console.log('[L2]', JSON.stringify({ outcome: finished.outcome, exit_code: finished.exit_code }))
    expect(finished.outcome).not.toBe('process_error')
    expect(finished.outcome).not.toBe('orphaned')
    expect(finished.exit_code).toBe(0)

    clientB.store.close()
  })
})

live('L3 — session mode turn 1: --print=<prompt> coexists with --input-format stream-json', () => {
  it('the composed argv that src/server/tools/start.ts:212 flags as unverified actually runs', async () => {
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')

    const ctx = createContext()
    const t0 = Date.now()
    const started = replyJson(
      await handleStart(ctx, {
        prompt: 'Reply with exactly the word READY and nothing else. Do not run any commands.',
        profile: 'research_readonly',
        session_mode: 'session',
        model: LIVE_MODEL,
        effort: LIVE_EFFORT,
        timeout_ms: LIVE_TIMEOUT_MS,
      } as never),
    ) as { job_id: string; session_id: string }

    const waited = replyJson(
      await handleWait(ctx, { job_id: started.job_id, wait_ms: LIVE_TIMEOUT_MS } as never),
    ) as { lifecycle: string; outcome: string }

    const events = readEvents(ctx, started.job_id)
    recordUsage({ test: 'L3', job_id: started.job_id, model: LIVE_MODEL, events, wall_ms: Date.now() - t0 })

    // A6 — an argv agy rejects produces zero events and a non-zero exit. The
    // point of this test is to find that out cheaply, so the assertion is on
    // "agy got as far as emitting init", not on the final wording.
    // eslint-disable-next-line no-console
    console.log(
      '[L3]',
      JSON.stringify({
        lifecycle: waited.lifecycle,
        outcome: waited.outcome,
        event_types: events.map((e) => e.type),
      }),
    )
    expect(events.length).toBeGreaterThan(0)
    expect((events[0] as { type?: string }).type).toBe('init')
    expect(waited.lifecycle).toBe('finished')

    ctx.store.close()
  })
})
