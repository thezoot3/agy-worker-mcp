/**
 * 그룹 9 — 거부 복구 루프 (`docs/05` 작업 C, `docs/03` §2 가 주장하는 루프).
 *
 * `research_readonly` 의 permission 천장(ceiling)은 6개 규칙으로 고정돼 있어
 * 클라이언트가 그 천장 밖으로 확장할 수는 없다(`resolvePolicy`: allow 는 요청과
 * 천장의 교집합). 그래서 재현 가능한 "거부 -> required_rule -> allow 에 그대로
 * 추가 -> 통과" 루프를 만들려면, 천장 **안에는 있지만 클라이언트 자신의 좁은
 * 요청이 제외한** 규칙을 써야 한다 — `command(ls)` 는 research_readonly 천장에
 * 있지만, 1턴에서는 `permissions.allow: ['read_file(...)']` 만 요청해 일부러
 * 제외한다.
 *
 * 1턴: ls 실행 시도 -> 거부, `required_rule` 회수
 * 2턴: 같은 프롬프트, `permissions.allow` 에 `required_rule` 을 그대로 추가 -> 통과 확인
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
  writeWorkspaceFile,
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

const PROMPT = 'Run the shell command: ls — exactly that, nothing else. Then report what files you see.'

live('L17 — required_rule from a denial, fed back into permissions.allow, actually unblocks the retry', () => {
  it('turn 1 is denied for ls (excluded by a narrow client request); turn 2, widened with required_rule, runs it', async () => {
    writeWorkspaceFile(project, 'marker.txt', 'recovery-loop-probe\n')

    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')

    const ctx = createContext()
    const t0 = Date.now()

    // Turn 1 — deliberately narrow: only read_file, no command(*) at all.
    const started1 = replyJson(
      await handleStart(ctx, {
        prompt: PROMPT,
        profile: 'research_readonly',
        model: LIVE_MODEL,
        effort: LIVE_EFFORT,
        timeout_ms: LIVE_TIMEOUT_MS,
        permissions: { allow: ['read_file({workspace}/**)'] },
      } as never),
    ) as { job_id: string }

    const waited1 = replyJson(
      await handleWait(ctx, { job_id: started1.job_id, wait_ms: LIVE_TIMEOUT_MS } as never),
    ) as { lifecycle: string; outcome: string }

    const events1 = readEvents(ctx, started1.job_id)
    recordUsage({ test: 'L17-turn1', job_id: started1.job_id, model: LIVE_MODEL, events: events1, wall_ms: Date.now() - t0 })

    const full1 = replyJson(await handleResult(ctx, { job_id: started1.job_id, section: 'all' } as never)) as {
      verification?: {
        permission_denials?: Array<{ required_rule: string | null; policy: string | null; command: string | null }>
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      '[L17 turn1]',
      JSON.stringify({ outcome: waited1.outcome, denials: full1.verification?.permission_denials }, null, 1),
    )

    expect(waited1.lifecycle).toBe('finished')
    expect(waited1.outcome).toBe('blocked')
    const denial = full1.verification?.permission_denials?.[0]
    expect(denial).toBeDefined()
    expect(denial?.policy).toBe('default')
    const requiredRule = denial?.required_rule ?? null
    expect(requiredRule).not.toBeNull()

    // Turn 2 — same prompt, widened with exactly the required_rule the broker
    // handed back. This is the recovery loop docs/03 §2 and
    // src/server/instructions.ts claim exists.
    const t1 = Date.now()
    const started2 = replyJson(
      await handleStart(ctx, {
        prompt: PROMPT,
        profile: 'research_readonly',
        model: LIVE_MODEL,
        effort: LIVE_EFFORT,
        timeout_ms: LIVE_TIMEOUT_MS,
        permissions: { allow: ['read_file({workspace}/**)', requiredRule as string] },
      } as never),
    ) as { job_id: string }

    const waited2 = replyJson(
      await handleWait(ctx, { job_id: started2.job_id, wait_ms: LIVE_TIMEOUT_MS } as never),
    ) as { lifecycle: string; outcome: string }

    const events2 = readEvents(ctx, started2.job_id)
    recordUsage({ test: 'L17-turn2', job_id: started2.job_id, model: LIVE_MODEL, events: events2, wall_ms: Date.now() - t1 })

    const full2 = replyJson(await handleResult(ctx, { job_id: started2.job_id, section: 'all' } as never)) as {
      broker_summary?: { headline?: string }
      verification?: { permission_denials?: unknown[] }
    }

    // eslint-disable-next-line no-console
    console.log(
      '[L17 turn2]',
      JSON.stringify(
        {
          required_rule_used: requiredRule,
          outcome: waited2.outcome,
          headline: full2.broker_summary?.headline,
          denials: full2.verification?.permission_denials,
        },
        null,
        1,
      ),
    )

    expect(waited2.lifecycle).toBe('finished')
    expect(full2.verification?.permission_denials?.length ?? 0).toBe(0)
    expect(waited2.outcome).not.toBe('blocked')

    ctx.store.close()
  })
})
