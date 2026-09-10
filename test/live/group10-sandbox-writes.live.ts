/**
 * Group 10 — Shell writes inside sandbox (M7). 0.2.0 forces
 * `BypassSandbox: false` on every run_command (I2). Whether agy's seatbelt allows
 * in-workspace writes in that state depends on the agy version — 1.1.23 allowed it,
 * while 1.1.24 denied it (measured 2026-09-02) — which can only be caught live,
 * not in code. This test records that fact and asserts that the broker honestly
 * reports whichever occurs: file created ⇔ no sandbox blocker.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
  project = makeLiveProject({ git: true })
  applyLiveEnv(project)
  // `command(npm run)` is on general_worker's allow list; the script is where
  // the writes happen. W1: file in the workspace root. W2: mkdir + file in a
  // subdirectory (what a build tool does). W3: a path agy's profile is known
  // to leave writable (`~/.gradle`, P2) — the control.
  writeFileSync(
    join(project.root, 'package.json'),
    JSON.stringify({
      name: 'agy-live-sandbox-writes',
      private: true,
      scripts: {
        probe:
          "sh -c 'echo hi > out.txt && echo W1_OK || echo W1_FAIL; mkdir -p build && echo hi > build/x && echo W2_OK || echo W2_FAIL; echo hi > \"$HOME/.gradle/agy-live-probe-tmp\" && echo W3_OK || echo W3_FAIL; rm -f \"$HOME/.gradle/agy-live-probe-tmp\"'",
      },
    }),
  )
})

live('L18 — run_command writes inside the workspace (0.2.1)', () => {
  it('general_worker runs unsandboxed by default and writes succeed', async () => {
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')

    const ctx = createContext()
    const t0 = Date.now()
    const started = replyJson(
      await handleStart(ctx, {
        prompt: 'Run exactly this one shell command: npm run probe — then paste its complete output verbatim.',
        profile: 'general_worker',
        model: LIVE_MODEL,
        effort: LIVE_EFFORT,
        timeout_ms: LIVE_TIMEOUT_MS,
      } as never),
    ) as { job_id: string }
    const waited = replyJson(
      await handleWait(ctx, { job_id: started.job_id, wait_ms: LIVE_TIMEOUT_MS } as never),
    ) as { outcome: string }
    const events = readEvents(ctx, started.job_id)
    recordUsage({ test: 'L18-default', job_id: started.job_id, model: LIVE_MODEL, events, wall_ms: Date.now() - t0 })

    const full = replyJson(await handleResult(ctx, { job_id: started.job_id, section: 'all' } as never)) as {
      verification?: { blockers?: Array<{ source?: string; remedy?: string | null }> }
    }
    ctx.store.close()

    const outs = events
      .map((e) => (e as { step_update?: { tool_info?: { output?: string } } }).step_update?.tool_info?.output)
      .filter((o): o is string => typeof o === 'string')
      .join('\n')
    const w1 = existsSync(join(project.root, 'out.txt'))
    const w2 = existsSync(join(project.root, 'build', 'x'))
    const blockers = full.verification?.blockers ?? []
    const sandboxBlockers = blockers.filter((b) => b.source === 'sandbox')

    // The gate allowed `npm run probe` — nothing of ours refused.
    expect(blockers.some((b) => b.source === 'gate')).toBe(false)
    expect(outs).toMatch(/W3_(OK|FAIL)/)
    // 0.2.1: general_worker runs unsandboxed by default — writes succeed and no sandbox blocker exists
    expect(w1 && w2).toBe(true)
    expect(sandboxBlockers.length).toBe(0)
    expect(waited.outcome).not.toBe('blocked')
  })

  it('permissions.sandboxed: true forces the sandbox on, failing writes and reporting the remedy', async () => {
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')

    const ctx = createContext()
    const t0 = Date.now()
    const started = replyJson(
      await handleStart(ctx, {
        prompt: 'Run exactly this one shell command: npm run probe — then paste its complete output verbatim.',
        profile: 'general_worker',
        permissions: { sandboxed: true },
        model: LIVE_MODEL,
        effort: LIVE_EFFORT,
        timeout_ms: LIVE_TIMEOUT_MS,
      } as never),
    ) as { job_id: string }
    const waited = replyJson(
      await handleWait(ctx, { job_id: started.job_id, wait_ms: LIVE_TIMEOUT_MS } as never),
    ) as { outcome: string }
    const events = readEvents(ctx, started.job_id)
    recordUsage({ test: 'L18-sandboxed', job_id: started.job_id, model: LIVE_MODEL, events, wall_ms: Date.now() - t0 })

    const full = replyJson(await handleResult(ctx, { job_id: started.job_id, section: 'all' } as never)) as {
      verification?: { blockers?: Array<{ source?: string; remedy?: string | null; message?: string }> }
    }
    ctx.store.close()

    const w1 = existsSync(join(project.root, 'out.txt'))
    const w2 = existsSync(join(project.root, 'build', 'x'))
    const blockers = full.verification?.blockers ?? []
    const sandboxBlockers = blockers.filter((b) => b.source === 'sandbox')

    // Gate allowed
    expect(blockers.some((b) => b.source === 'gate')).toBe(false)
    // On agy 1.1.24 seatbelt denies in-workspace writes
    expect(w1 && w2).toBe(false)
    expect(waited.outcome).toBe('blocked')
    expect(sandboxBlockers.length).toBeGreaterThan(0)
    expect(sandboxBlockers[0]?.remedy ?? '').toContain('permissions.sandboxed')
  })
})
