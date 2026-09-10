/**
 * Group 11 — Seatbelt (0.3.0 PR6, M9). Wraps a gate-allowed run_command
 * in a general_worker job with ceiling `sandbox: "seatbelt"` using
 * `sandbox-exec -p <profile> /bin/sh -c <command>`. Asserts that:
 * in-workspace writes and npm scripts succeed; out-of-workspace writes
 * (whether via shell redirection or python) are rejected by the OS;
 * and the broker honestly reports that rejection as a `source: sandbox`
 * blocker (with write_roots guidance).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { canonicalize, projectPaths } from '../../src/contract/paths.js'
import { ceilingPath } from '../../src/policy/ceiling.js'
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

const live = LIVE && process.platform === 'darwin' ? describe : describe.skip
let project: LiveProject
const OUTSIDE = join(homedir(), 'agy-live-seatbelt-probe.txt')

beforeAll(() => {
  if (LIVE) ensureBuilt()
})

beforeEach(() => {
  if (!LIVE) return
  project = makeLiveProject({ git: true })
  applyLiveEnv(project)
  const paths = projectPaths(canonicalize(project.root))
  mkdirSync(paths.dir, { recursive: true })
  writeFileSync(ceilingPath(paths), JSON.stringify({ version: 2, sandbox: 'seatbelt' }))
  writeFileSync(
    join(project.root, 'package.json'),
    JSON.stringify({
      name: 'agy-live-seatbelt',
      private: true,
      scripts: {
        probe: `sh -c 'echo hi > inside.txt && echo W_IN_OK || echo W_IN_FAIL; mkdir -p build && echo hi > build/x && echo W_BUILD_OK || echo W_BUILD_FAIL; echo hi > "${OUTSIDE}" && echo W_OUT_OK || echo W_OUT_FAIL; python3 -c "open(\\"${OUTSIDE}\\",\\"w\\").write(\\"x\\")" && echo PY_OUT_OK || echo PY_OUT_FAIL'`,
      },
    }),
  )
})

live('L19 — seatbelt keeps writes inside the workspace, reports the rest', () => {
  it('inside writes succeed, outside writes (sh and python) are refused, blocker names write_roots', async () => {
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
    ) as { job_id: string; policy_summary: { sandbox: string; sandbox_source: string } }
    expect(started.policy_summary.sandbox).toBe('seatbelt')
    expect(started.policy_summary.sandbox_source).toBe('ceiling')

    const waited = replyJson(
      await handleWait(ctx, { job_id: started.job_id, wait_ms: LIVE_TIMEOUT_MS } as never),
    ) as { outcome: string }
    const events = readEvents(ctx, started.job_id)
    recordUsage({ test: 'L19-seatbelt', job_id: started.job_id, model: LIVE_MODEL, events, wall_ms: Date.now() - t0 })

    const full = replyJson(await handleResult(ctx, { job_id: started.job_id, section: 'all' } as never)) as {
      verification?: { blockers?: Array<{ source?: string; remedy?: string | null; message?: string }> }
    }
    ctx.store.close()

    const outs = events
      .map((e) => (e as { step_update?: { tool_info?: { output?: string } } }).step_update?.tool_info?.output)
      .filter((o): o is string => typeof o === 'string')
      .join('\n')

    expect(existsSync(join(project.root, 'inside.txt'))).toBe(true)
    expect(existsSync(join(project.root, 'build', 'x'))).toBe(true)
    expect(existsSync(OUTSIDE)).toBe(false)
    expect(outs).toContain('W_IN_OK')
    expect(outs).toContain('W_BUILD_OK')
    expect(outs).toContain('W_OUT_FAIL')
    expect(outs).toContain('PY_OUT_FAIL')

    const blockers = full.verification?.blockers ?? []
    const sandboxBlockers = blockers.filter((b) => b.source === 'sandbox')
    expect(blockers.some((b) => b.source === 'gate')).toBe(false)
    expect(sandboxBlockers.length).toBeGreaterThan(0)
    expect(sandboxBlockers[0]!.remedy).toContain('write_roots')
    expect(sandboxBlockers[0]!.message).toContain('seatbelt')
    expect(waited.outcome).toBe('blocked')
  })
})
