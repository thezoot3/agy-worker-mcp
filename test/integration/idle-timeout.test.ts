/**
 * `docs/04` 미해결 질문 3 (resolved) — a `session_mode:'session'` job whose
 * single turn finishes and never gets a follow-up `agy_send` must close on its
 * own `idle_timeout_ms` after that turn, not sit until the hard `timeout_ms`
 * deadline. Measured live without this: the job idled out the *entire*
 * `--print-timeout` window for a turn that finished in seconds (`docs/05`
 * §6.3).
 *
 * Also covers 미해결 질문 2 (resolved): `agy_send` never touches `deadline_at`.
 * The second describe block below proves it directly against the DB row.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { applyEnv, ensureBuilt, makeProject, replyJson, sleep, waitUntil, type TestProject } from './helpers.js'

let project: TestProject

beforeAll(() => {
  ensureBuilt()
})

beforeEach(() => {
  project = makeProject()
})

describe('idle timeout — a session-mode job with no follow-up agy_send closes on idle_timeout_ms, not timeout_ms', () => {
  it('finishes well before the hard deadline, with a clean (non-timed-out) outcome and idle_closed recorded', async () => {
    // `resume`'s first turn is pure agent_response, no tool call — keeps this
    // test about the idle watchdog, not the gate (a bare "happy" turn calls
    // run_command, which research_readonly denies and turns the outcome into
    // "blocked").
    applyEnv(project, 'resume')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')

    const ctx = createContext()

    const started = replyJson(
      await handleStart(ctx, {
        prompt: 'first and only turn',
        profile: 'research_readonly',
        session_mode: 'session',
        // Deliberately far apart: idle_timeout_ms must be what ends this job,
        // not timeout_ms. If the idle watchdog were a no-op, this test would
        // only finish after the full 20s and outcome would be timed_out.
        timeout_ms: 20_000,
        idle_timeout_ms: 500,
      } as never),
    ) as { job_id: string; idle_timeout_ms: number }

    expect(started.idle_timeout_ms).toBe(500)

    const t0 = Date.now()
    const waited = await waitUntil(
      async () => {
        const w = replyJson(await handleWait(ctx, { job_id: started.job_id, wait_ms: 500 } as never)) as {
          lifecycle: string
          warnings: string[]
        }
        return w.lifecycle === 'finished' ? w : null
      },
      { timeoutMs: 10_000, label: 'idle-timeout job finished' },
    )
    const elapsedMs = Date.now() - t0

    // Comfortably under the 20s hard deadline — proves idle_timeout_ms, not
    // timeout_ms, ended this job.
    expect(elapsedMs).toBeLessThan(10_000)

    const full = replyJson(await handleResult(ctx, { job_id: started.job_id, section: 'all' } as never)) as {
      broker_summary: { outcome: string }
      agent_report: { num_turns: number | null }
      verification: { warnings: string[] }
    }
    expect(full.broker_summary.outcome).toBe('success_unverified')
    expect(full.agent_report.num_turns).toBe(1)

    // An idle close exits 0 like any clean finish, so without an explicit
    // warning the caller cannot tell "your session was reaped" from "the job
    // ended normally" — and only the first of those calls for a resume.
    const idleWarning = full.verification.warnings.find((w) => w.includes('idle_timeout_ms'))
    expect(idleWarning).toBeDefined()
    expect(idleWarning).toContain('500')
    expect(idleWarning).toContain('agy_start({ session_id })')
    expect(waited.warnings).toEqual(full.verification.warnings)

    const state = JSON.parse(
      readFileSync(join(ctx.paths.jobsDir, started.job_id, 'state.json'), 'utf8'),
    ) as { idle_closed?: boolean; timed_out?: boolean }
    expect(state.idle_closed).toBe(true)
    expect(state.timed_out).toBe(false)

    ctx.store.close()
  })
})

describe('idle timeout — a job never receiving idle_timeout_ms defaults it only for session mode', () => {
  it('oneshot jobs get idle_timeout_ms: null; session jobs get the server default', async () => {
    applyEnv(project, 'happy')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')

    const ctx = createContext()

    const oneshot = replyJson(
      await handleStart(ctx, { prompt: 'x', profile: 'research_readonly', dry_run: true } as never),
    ) as { effective_config: { idle_timeout_ms: number | null } }
    expect(oneshot.effective_config.idle_timeout_ms).toBeNull()

    const session = replyJson(
      await handleStart(ctx, {
        prompt: 'x',
        profile: 'research_readonly',
        session_mode: 'session',
        dry_run: true,
      } as never),
    ) as { effective_config: { idle_timeout_ms: number | null } }
    expect(session.effective_config.idle_timeout_ms).toBe(ctx.limits.default_idle_timeout_ms)

    ctx.store.close()
  })
})

describe('agy_send — deadline_at is never extended by a queued turn (미해결 질문 2, resolved)', () => {
  it('the jobs row deadline_at is identical before and after agy_send', async () => {
    applyEnv(project, 'multi-turn')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleSend } = await import('../../src/server/tools/send.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { getJob } = await import('../../src/store/jobs.js')

    const ctx = createContext()

    const started = replyJson(
      await handleStart(ctx, {
        prompt: 'first turn',
        profile: 'research_readonly',
        session_mode: 'session',
        timeout_ms: 20_000,
      } as never),
    ) as { job_id: string }

    const beforeSend = getJob(ctx.store, started.job_id)
    const deadlineBefore = beforeSend.deadline_at

    await sleep(300)
    await handleSend(ctx, { job_id: started.job_id, text: 'second turn', close: true } as never)

    const afterSend = getJob(ctx.store, started.job_id)
    expect(afterSend.deadline_at).toBe(deadlineBefore)

    await waitUntil(
      async () => {
        const w = replyJson(await handleWait(ctx, { job_id: started.job_id, wait_ms: 1000 } as never)) as {
          lifecycle: string
        }
        return w.lifecycle === 'finished' ? w : null
      },
      { timeoutMs: 15_000, label: 'multi-turn session job finished' },
    )

    // Still unchanged after the job actually finishes and reconcile runs.
    const afterFinish = getJob(ctx.store, started.job_id)
    expect(afterFinish.deadline_at).toBe(deadlineBefore)

    ctx.store.close()
  })
})
