/**
 * 그룹 7 — 동시 실행 agy 프로세스 수의 계정/쿼터 상한 (`docs/02` 미확인 5번).
 *
 * `DEFAULT_MAX_RUNNING`(`src/store/locks.ts`) / `DEFAULT_LIMITS.max_running_jobs`
 * (`src/server/context.ts`)의 기본값 3은 근거 없이 골라졌다. 이 그룹은 그 값이
 * 아니라 **실제 agy 계정/쿼터가 동시 프로세스 수에 상한을 두는지**를 직접 관측한다.
 *
 * 우리 자신의 lock(프로젝트당 `running_limit`)에 걸리지 않도록, 서로 다른
 * `makeLiveProject()` 워크스페이스 — 곧 서로 다른 project root, 서로 다른
 * SQLite — 에 하나씩 job 을 띄운다. `applyLiveEnv` 는 쓰지 않는다: 그건
 * `AGY_WORKER_PROJECT` 를 전역으로 고정해 버려서 프로젝트를 나눌 수 없다.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import {
  LIVE,
  LIVE_EFFORT,
  LIVE_MODEL,
  LIVE_TIMEOUT_MS,
  agyVersion,
  ensureBuilt,
  makeLiveProject,
  readEvents,
  recordUsage,
  replyJson,
  requireAgyOnPath,
  type LiveProject,
} from './helpers.js'

const live = LIVE ? describe : describe.skip

const N = 4 // docs/05 지시: 4개로 시작. 문제 없으면 6개까지만.

beforeAll(() => {
  if (!LIVE) return
  ensureBuilt()
  // eslint-disable-next-line no-console
  console.log(`[live] agy ${agyVersion()} at ${requireAgyOnPath()}, model=${LIVE_MODEL}, N=${N}`)
})

live(`L14 — ${N} concurrent agy processes across ${N} independent projects`, () => {
  it('observes whether a real account/quota ceiling shows up, and in what shape', async () => {
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')

    // One shared state home (harmless — each project gets its own subdir keyed
    // by sha256(root)); no AGY_WORKER_PROJECT override, so each context's own
    // `cwd` decides its project root independently.
    const sharedHome = mkdtempSync(join(tmpdir(), 'agy-live-concurrency-home-'))
    process.env.AGY_WORKER_HOME = sharedHome
    delete process.env.AGY_WORKER_PROJECT
    delete process.env.AGY_WORKER_AGY_BIN
    delete process.env.AGY_FAKE_SCENARIO
    delete process.env.AGY_FAKE_STATE_DIR

    const projects: LiveProject[] = Array.from({ length: N }, () => makeLiveProject())
    const contexts = projects.map((p) => createContext(p.root))

    const t0 = Date.now()
    const starts = await Promise.all(
      contexts.map((ctx, i) =>
        handleStart(ctx, {
          prompt: 'Reply with exactly: OK',
          profile: 'research_readonly',
          model: LIVE_MODEL,
          effort: LIVE_EFFORT,
          timeout_ms: LIVE_TIMEOUT_MS,
          requested_by: `concurrency-probe-${i}`,
        } as never),
      ),
    )
    const started = starts.map((s) => replyJson(s)) as Array<{ job_id?: string; error?: unknown }>

    // eslint-disable-next-line no-console
    console.log('[L14] agy_start results', JSON.stringify(started, null, 1))

    const waits = await Promise.all(
      contexts.map((ctx, i) => {
        const jobId = started[i]?.job_id
        if (!jobId) return Promise.resolve(null)
        return handleWait(ctx, { job_id: jobId, wait_ms: LIVE_TIMEOUT_MS } as never)
      }),
    )

    const rows = waits.map((w, i) => {
      const jobId = started[i]?.job_id
      if (!w || !jobId) return { i, job_id: jobId ?? null, start_error: started[i]?.error ?? 'no job_id' }
      const waited = replyJson(w) as { lifecycle: string; outcome: string; exit_code?: number | null; headline?: string | null }
      const events = readEvents(contexts[i]!, jobId)
      recordUsage({ test: `L14-${i}`, job_id: jobId, model: LIVE_MODEL, events, wall_ms: Date.now() - t0 })
      return {
        i,
        job_id: jobId,
        lifecycle: waited.lifecycle,
        outcome: waited.outcome,
        exit_code: waited.exit_code ?? null,
        headline: waited.headline ?? null,
        event_count: events.length,
        last_events: events.slice(-3),
      }
    })

    // eslint-disable-next-line no-console
    console.log('[L14] final state of all', N, 'jobs:', JSON.stringify(rows, null, 1))

    for (const ctx of contexts) ctx.store.close()

    // Observational: N is small on purpose (docs/05 지시). If nothing failed,
    // "no ceiling observed at N" is itself the reportable result — do not loosen
    // this into a multi-choice assertion. Every job that got a job_id must at
    // least reach `finished`; what `outcome`/`exit_code` it lands on is exactly
    // the thing under observation and goes into the report, not into `expect`.
    for (const row of rows) {
      if ('lifecycle' in row) {
        expect(row.lifecycle).toBe('finished')
      }
    }
  })
})
