/**
 * Group 9 — Denial recovery loop (see docs/permissions.md).
 *
 * The permission ceiling of `research_readonly` is fixed to 6 rules, and a client
 * cannot expand beyond that ceiling (`resolvePolicy`: allow is the intersection of
 * request and ceiling). Thus, to create a reproducible "denial -> required_rule ->
 * add directly to allow -> allowed" loop, we must use a rule that is **inside the ceiling
 * but omitted by the client's narrow request** — `command(ls)` is in the
 * research_readonly ceiling, but in turn 1 we deliberately omit it by only requesting
 * `permissions.allow: ['read_file(...)']`.
 *
 * Turn 1: attempt ls execution -> denied, collect `required_rule`
 * Turn 2: same prompt, add `required_rule` directly to `permissions.allow` -> confirm allowed
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
        blockers?: Array<{
          source: string
          actionable: boolean
          remedy: string | null
          command: string | null
          detail?: { policy?: string | null }
        }>
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      '[L17 turn1]',
      JSON.stringify({ outcome: waited1.outcome, blockers: full1.verification?.blockers }, null, 1),
    )

    expect(waited1.lifecycle).toBe('finished')
    expect(waited1.outcome).toBe('blocked')
    const denial = full1.verification?.blockers?.find((b) => b.source === 'gate')
    expect(denial).toBeDefined()
    expect(denial?.detail?.policy).toBe('default')
    expect(denial?.actionable).toBe(true)
    // `remedy` on a gate blocker is exactly the rule to put into permissions.allow.
    const requiredRule = denial?.remedy ?? null
    expect(requiredRule).not.toBeNull()

    // Turn 2 — same prompt, widened with exactly the required_rule the broker
    // handed back. This is the recovery loop that docs/permissions.md and
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
      verification?: { blockers?: Array<{ source: string }> }
    }

    // eslint-disable-next-line no-console
    console.log(
      '[L17 turn2]',
      JSON.stringify(
        {
          required_rule_used: requiredRule,
          outcome: waited2.outcome,
          headline: full2.broker_summary?.headline,
          blockers: full2.verification?.blockers,
        },
        null,
        1,
      ),
    )

    expect(waited2.lifecycle).toBe('finished')
    expect((full2.verification?.blockers ?? []).filter((b) => b.source === 'gate').length).toBe(0)
    expect(waited2.outcome).not.toBe('blocked')

    ctx.store.close()
  })
})
