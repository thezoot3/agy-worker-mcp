/**
 * 그룹 5 — 프로세스 제어 (`docs/05` §2). fake 로는 항상 통과하던 cancel/timeout
 * 이 실제 agy 프로세스 트리(자식 셸, 샌드박스 래퍼 포함)에서도 그룹을 비우는지.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  LIVE,
  LIVE_EFFORT,
  LIVE_MODEL,
  applyLiveEnv,
  ensureBuilt,
  makeLiveProject,
  processGroupAlive,
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

const LONG_PROMPT =
  'Run the shell command: sleep 120 — and wait for it to finish before replying.'

live('L12 — agy_cancel empties the real process group', () => {
  it('pgrep -g <pgid> is empty after cancel', async () => {
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleCancel } = await import('../../src/server/tools/cancel.js')
    const { reconcile } = await import('../../src/broker/reconcile.js')
    const { getJob } = await import('../../src/store/jobs.js')

    const ctx = createContext()
    const t0 = Date.now()
    const started = replyJson(
      await handleStart(ctx, {
        prompt: LONG_PROMPT,
        profile: 'general_worker',
        model: LIVE_MODEL,
        effort: LIVE_EFFORT,
        timeout_ms: 180_000,
      } as never),
    ) as { job_id: string }

    const live_ = await waitUntil(
      async () => {
        await reconcile(ctx.store)
        const job = getJob(ctx.store, started.job_id)
        return job.pgid !== null ? job : null
      },
      { timeoutMs: 40_000, label: 'runner published a pgid' },
    )

    const canceled = replyJson(await handleCancel(ctx, { job_id: started.job_id } as never)) as {
      killed?: boolean
    }
    // eslint-disable-next-line no-console
    console.log('[L12] cancel ->', JSON.stringify(canceled))

    await waitUntil(() => (processGroupAlive(live_.pgid!) ? null : true), {
      timeoutMs: 30_000,
      label: 'process group empty after cancel',
    })

    const finished = await waitUntil(
      async () => {
        await reconcile(ctx.store)
        const job = getJob(ctx.store, started.job_id)
        return job.lifecycle === 'finished' ? job : null
      },
      { timeoutMs: 40_000, label: 'canceled job finalized' },
    )
    recordUsage({
      test: 'L12',
      job_id: started.job_id,
      model: LIVE_MODEL,
      events: readEvents(ctx, started.job_id),
      wall_ms: Date.now() - t0,
    })
    // eslint-disable-next-line no-console
    console.log('[L12]', JSON.stringify({ outcome: finished.outcome, exit_code: finished.exit_code }))
    expect(processGroupAlive(live_.pgid!)).toBe(false)
    expect(canceled.killed).toBe(true)
    expect(finished.outcome).toBe('canceled')

    ctx.store.close()
  })
})

live('L13 — a short timeout_ms kills the real tree and finalizes timed_out', () => {
  it('the deadline fires, the group is emptied, and the outcome is terminal', async () => {
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { reconcile } = await import('../../src/broker/reconcile.js')
    const { getJob } = await import('../../src/store/jobs.js')

    const ctx = createContext()
    const t0 = Date.now()
    const started = replyJson(
      await handleStart(ctx, {
        prompt: LONG_PROMPT,
        profile: 'general_worker',
        model: LIVE_MODEL,
        effort: LIVE_EFFORT,
        timeout_ms: 25_000,
      } as never),
    ) as { job_id: string }

    const live_ = await waitUntil(
      async () => {
        await reconcile(ctx.store)
        const job = getJob(ctx.store, started.job_id)
        return job.pgid !== null ? job : null
      },
      { timeoutMs: 40_000, label: 'runner published a pgid' },
    )

    const finished = await waitUntil(
      async () => {
        await reconcile(ctx.store)
        const job = getJob(ctx.store, started.job_id)
        return job.lifecycle === 'finished' ? job : null
      },
      { timeoutMs: 90_000, label: 'deadline fired and job finalized' },
    )
    recordUsage({
      test: 'L13',
      job_id: started.job_id,
      model: LIVE_MODEL,
      events: readEvents(ctx, started.job_id),
      wall_ms: Date.now() - t0,
    })
    // eslint-disable-next-line no-console
    console.log('[L13]', JSON.stringify({ outcome: finished.outcome, exit_code: finished.exit_code }))

    expect(processGroupAlive(live_.pgid!)).toBe(false)
    // Exactly `timed_out`. A set that also accepts `failed` would hide the very
    // bug this test found: the runner's watchdog kills the group, writes the
    // resulting exit code, and the deadline verdict is lost unless `state.json`
    // carries it.
    expect(finished.outcome).toBe('timed_out')

    ctx.store.close()
  })
})
