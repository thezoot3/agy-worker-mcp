/**
 * 그룹 4 — 차단 탐지 (`docs/05` §2). 해소 대상: A7 (`ENVIRONMENT_BLOCK_SIGNATURES`
 * 문구 일치), A4 (경로 위반이 Class 1 인지 Class 2 인지).
 *
 * 두 테스트 모두 **관측이 목적**이다. 단언은 "run 이 성립했다" 수준에 두고,
 * 실제로 무엇이 나왔는지는 로그로 남겨 `docs/02` 에 반영한다. 예상과 다른 값이
 * 나오는 것이 이 테스트의 성공 조건이지 실패 조건이 아니다.
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

/** Compact view of every tool step, which is where both classes show up. */
function toolSteps(events: Array<Record<string, unknown>>): unknown[] {
  return events
    .filter((e) => e.type === 'step_update')
    .map((e) => ({
      tool: e.tool_name,
      state: e.state,
      info: JSON.stringify(e.tool_info ?? null).slice(0, 600),
    }))
}

live('L10 — a sandboxed network command: which signature does agy actually surface (A7)', () => {
  it('the real failure text is compared against ENVIRONMENT_BLOCK_SIGNATURES', async () => {
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')
    const { ENVIRONMENT_BLOCK_SIGNATURES } = await import('../../src/contract/types.js')

    const ctx = createContext()
    const t0 = Date.now()
    const started = replyJson(
      await handleStart(ctx, {
        prompt:
          'Run the shell command: git ls-remote https://github.com/git/git.git — then tell me the exact error text if it failed.',
        profile: 'general_worker',
        model: LIVE_MODEL,
        effort: LIVE_EFFORT,
        timeout_ms: LIVE_TIMEOUT_MS,
      } as never),
    ) as { job_id: string }

    const waited = replyJson(
      await handleWait(ctx, { job_id: started.job_id, wait_ms: LIVE_TIMEOUT_MS } as never),
    ) as { lifecycle: string; outcome: string }
    const events = readEvents(ctx, started.job_id)
    recordUsage({ test: 'L10', job_id: started.job_id, model: LIVE_MODEL, events, wall_ms: Date.now() - t0 })

    const full = replyJson(await handleResult(ctx, { job_id: started.job_id } as never)) as {
      broker?: { outcome?: string; exit_code?: number | null; agent_status?: string | null }
      verification?: { environment_blocks?: unknown[]; permission_denials?: unknown[] }
    }
    // eslint-disable-next-line no-console
    console.log(
      '[L10]',
      JSON.stringify(
        {
          outcome: waited.outcome,
          broker: full.broker,
          environment_blocks: full.verification?.environment_blocks,
          permission_denials: full.verification?.permission_denials,
          known_signatures: ENVIRONMENT_BLOCK_SIGNATURES,
          steps: toolSteps(events),
        },
        null,
        1,
      ).slice(0, 4000),
    )

    expect(waited.lifecycle).toBe('finished')
    ctx.store.close()
  })
})

live('L11 — writing outside the workspace: Class 1 or Class 2 (A4)', () => {
  it('the shape of a sandbox path violation is recorded', async () => {
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')

    const ctx = createContext()
    const t0 = Date.now()
    const outside = '/tmp/agy-live-outside-probe.txt'
    const started = replyJson(
      await handleStart(ctx, {
        prompt: `Run the shell command: printf hello > ${outside} — then tell me the exact error text if it failed.`,
        profile: 'general_worker',
        model: LIVE_MODEL,
        effort: LIVE_EFFORT,
        timeout_ms: LIVE_TIMEOUT_MS,
      } as never),
    ) as { job_id: string }

    const waited = replyJson(
      await handleWait(ctx, { job_id: started.job_id, wait_ms: LIVE_TIMEOUT_MS } as never),
    ) as { lifecycle: string; outcome: string }
    const events = readEvents(ctx, started.job_id)
    recordUsage({ test: 'L11', job_id: started.job_id, model: LIVE_MODEL, events, wall_ms: Date.now() - t0 })

    const full = replyJson(await handleResult(ctx, { job_id: started.job_id } as never)) as {
      broker?: unknown
      verification?: { environment_blocks?: unknown[]; permission_denials?: unknown[] }
    }
    // eslint-disable-next-line no-console
    console.log(
      '[L11]',
      JSON.stringify(
        {
          outcome: waited.outcome,
          broker: full.broker,
          environment_blocks: full.verification?.environment_blocks,
          permission_denials: full.verification?.permission_denials,
          steps: toolSteps(events),
        },
        null,
        1,
      ).slice(0, 4000),
    )

    expect(waited.lifecycle).toBe('finished')
    ctx.store.close()
  })
})
