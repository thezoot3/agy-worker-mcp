/**
 * PR6 `verify_command` (docs/permissions.md) — a command the
 * *runner* runs once, after agy exits normally, against the final workspace
 * state. Outside the model's own decisions entirely, and not a sandboxing
 * feature: it runs unsandboxed, as the user, exactly like the parent agent
 * running the command itself. A failing verify is a job *failure*
 * (`outcome: 'failed'`), never a `Blocker`.
 */
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  applyEnv,
  describeProcessGroup,
  ensureBuilt,
  fileExists,
  makeProject,
  processGroupAlive,
  replyJson,
  sleep,
  waitUntil,
  type TestProject,
} from './helpers.js'

let project: TestProject

beforeAll(() => {
  ensureBuilt()
})

beforeEach(() => {
  project = makeProject()
})

/** Find the pgid of a still-running process whose argv contains `substr`. */
function findPgidByCommand(substr: string): number | null {
  try {
    const out = execFileSync('ps', ['-eo', 'pid,pgid,args'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    for (const line of out.split('\n')) {
      if (!line.includes(substr)) continue
      const parts = line.trim().split(/\s+/)
      const pgid = Number.parseInt(parts[1] ?? '', 10)
      if (Number.isFinite(pgid)) return pgid
    }
  } catch {
    // ps failing just means "not found yet" to the caller.
  }
  return null
}

describe('PR6 verify_command', () => {
  it('a multi-second verify_command is never judged process_error by a reconciler polling through it (0.2.2 PR1)', async () => {
    applyEnv(project, 'verify-fail')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')

    const ctx = createContext()
    const started = replyJson(
      await handleStart(ctx, { prompt: 'x', profile: 'general_worker', verify_command: 'sleep 4' } as never),
    ) as { job_id: string }

    // Every `agy_wait` runs `reconcile` first — this loop is exactly the
    // caller the audit caught being lied to: agy is gone, `exit_code` is not
    // there yet, and the runner is sitting in `sleep 4`.
    const seen: Array<{ lifecycle: string; outcome: string | null; headline: string }> = []
    const deadline = Date.now() + 30_000
    for (;;) {
      const packet = replyJson(await handleWait(ctx, { job_id: started.job_id, wait_ms: 0 } as never)) as {
        lifecycle: string
        outcome: string | null
        headline: string
      }
      seen.push(packet)
      if (packet.lifecycle === 'finished' || Date.now() > deadline) break
      await sleep(250)
    }

    const last = seen[seen.length - 1]
    expect(last?.lifecycle).toBe('finished')
    expect(seen.map((p) => p.outcome)).not.toContain('process_error')
    expect(last?.outcome).toBe('verified_success')
    expect(seen.some((p) => p.headline.includes('verify_command in progress'))).toBe(true)

    ctx.store.close()
  }, 45_000)

  it('a failing verify_command makes outcome "failed", never a blocker, and writes verify.log', async () => {
    applyEnv(project, 'verify-fail')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')
    const { jobPaths } = await import('../../src/contract/paths.js')

    const ctx = createContext()
    const started = replyJson(
      await handleStart(ctx, { prompt: 'x', profile: 'general_worker', verify_command: 'exit 3' } as never),
    ) as { job_id: string }

    const waited = replyJson(await handleWait(ctx, { job_id: started.job_id, wait_ms: 15_000 } as never)) as {
      lifecycle: string
      outcome: string
      headline: string
    }
    expect(waited.lifecycle).toBe('finished')
    expect(waited.outcome).toBe('failed')
    expect(waited.headline).toContain('verify: exit 3')

    const verification = replyJson(
      await handleResult(ctx, { job_id: started.job_id, section: 'verification' } as never),
    ) as {
      verification: {
        verify: { command: string; exit_code: number | null; timed_out: boolean; output_tail: string } | null
      }
    }
    expect(verification.verification.verify).not.toBeNull()
    expect(verification.verification.verify?.command).toBe('exit 3')
    expect(verification.verification.verify?.exit_code).toBe(3)
    expect(verification.verification.verify?.timed_out).toBe(false)

    expect(fileExists(jobPaths(ctx.paths, started.job_id).verifyLog)).toBe(true)
    expect(fileExists(jobPaths(ctx.paths, started.job_id).verifyJson)).toBe(true)

    ctx.store.close()
  })

  it('verify_timeout_ms kills the verify process group and marks timed_out, forcing outcome "failed"', async () => {
    applyEnv(project, 'verify-timeout')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')

    const ctx = createContext()
    const started = replyJson(
      await handleStart(ctx, {
        prompt: 'x',
        profile: 'general_worker',
        verify_command: 'sleep 30',
        verify_timeout_ms: 1500,
      } as never),
    ) as { job_id: string }

    const pgid = await waitUntil(() => findPgidByCommand('sleep 30'), {
      timeoutMs: 10_000,
      label: 'verify\'s "sleep 30" process appeared',
    })

    const waited = replyJson(await handleWait(ctx, { job_id: started.job_id, wait_ms: 15_000 } as never)) as {
      lifecycle: string
      outcome: string
      headline: string
    }
    expect(waited.lifecycle).toBe('finished')
    expect(waited.outcome).toBe('failed')
    expect(waited.headline).toContain('verify: timed out')

    const verification = replyJson(
      await handleResult(ctx, { job_id: started.job_id, section: 'verification' } as never),
    ) as { verification: { verify: { timed_out: boolean; exit_code: number | null } | null } }
    expect(verification.verification.verify?.timed_out).toBe(true)

    // The job is already 'finished' by the time handleWait returns, which
    // only happens once the runner's own writeExitCode lands — and that is
    // always after runVerifyCommand's killProcessGroup has already awaited
    // the child's exit. Poll briefly anyway rather than asserting once: a
    // grandchild `sleep` reparented oddly could still be a beat behind the
    // group leader's own exit event.
    await waitUntil(() => !processGroupAlive(pgid), {
      timeoutMs: 5000,
      label: () => `verify process group ${pgid} still alive: ${describeProcessGroup(pgid)}`,
    })

    ctx.store.close()
  }, 20_000)

  it('a passing verify_command with no expected_artifacts is verified_success on its own', async () => {
    applyEnv(project, 'happy')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')

    const ctx = createContext()
    const started = replyJson(
      await handleStart(ctx, { prompt: 'x', profile: 'general_worker', verify_command: 'true' } as never),
    ) as { job_id: string }

    const waited = replyJson(await handleWait(ctx, { job_id: started.job_id, wait_ms: 15_000 } as never)) as {
      lifecycle: string
      outcome: string
    }
    expect(waited.lifecycle).toBe('finished')
    expect(waited.outcome).toBe('verified_success')

    ctx.store.close()
  })

  it('agy_start rejects a verify_command matched by a deny rule (HARD_DENY sudo) as field "verify_command"', async () => {
    applyEnv(project, 'happy')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')

    const ctx = createContext()
    const startedReply = await handleStart(ctx, {
      prompt: 'x',
      profile: 'general_worker',
      verify_command: 'sudo ls',
    } as never)
    expect(startedReply.isError).toBe(true)
    const envelope = replyJson(startedReply) as { detail?: { field?: string } }
    expect(envelope.detail?.field).toBe('verify_command')

    ctx.store.close()
  })

  it('verify.log is capped at 1 MiB with a truncation marker, and output_tail stays <= 2 KiB', async () => {
    applyEnv(project, 'verify-fail')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')
    const { jobPaths } = await import('../../src/contract/paths.js')

    const ctx = createContext()
    const started = replyJson(
      await handleStart(ctx, {
        prompt: 'x',
        profile: 'general_worker',
        verify_command: 'head -c 2000000 /dev/zero | tr "\\0" x',
      } as never),
    ) as { job_id: string }

    const waited = replyJson(await handleWait(ctx, { job_id: started.job_id, wait_ms: 15_000 } as never)) as {
      lifecycle: string
    }
    expect(waited.lifecycle).toBe('finished')

    const logPath = jobPaths(ctx.paths, started.job_id).verifyLog
    const size = statSync(logPath).size
    // 1 MiB cap plus a small truncation-marker allowance.
    expect(size).toBeLessThanOrEqual(1024 * 1024 + 256)
    expect(size).toBeGreaterThan(1024 * 1024)

    const verification = replyJson(
      await handleResult(ctx, { job_id: started.job_id, section: 'verification' } as never),
    ) as { verification: { verify: { output_tail: string } | null } }
    expect(verification.verification.verify?.output_tail.length).toBeLessThanOrEqual(2048)

    ctx.store.close()
  })
})
