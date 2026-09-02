/**
 * docs/04 완료 기준 (task numbering) #12–#16 — the gate and the broker's own
 * verification, kept independent of agy's self-report.
 *
 * #13 and #16 need a policy denial to actually happen, which needs
 * `bindConversation()` (`src/gate/bind.ts`) to find the job among the live
 * `jobs` rows. That binding now works: `ingestRunnerState()` in
 * `src/broker/reconcile.ts` absorbs `state.json` on every reconcile, so a
 * running job's `jobs.lifecycle` / `pid` reach SQLite while it is still
 * running. Our own `dist/gate.js` therefore reaches its `decide()` for our own
 * tool calls, and profile deny-lists and `on_denial` fire for real.
 *
 * Consequence for fixtures: a scenario's scripted tool command has to be one
 * the chosen profile actually permits, otherwise the step becomes a Class 1
 * denial and the scripted `output` is never emitted. `happy.json` runs
 * `python3`, which `research_readonly` refuses (`defaultDecision: 'deny'`,
 * `allowInterpreters: false`), so it is driven under `general_worker` here.
 *
 * #13 additionally exercises events/detect.ts's Class 1 parsing and
 * broker/verify.ts's aggregation with a hand-installed extra PreToolUse hook,
 * alongside (not instead of) our own `dist/gate.js`, that denies
 * unconditionally — a second, independent path into the detection pipeline.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { applyEnv, ensureBuilt, makeProject, REPO_ROOT, replyJson, waitUntil, type TestProject } from './helpers.js'

let project: TestProject

beforeAll(() => {
  ensureBuilt()
})

beforeEach(() => {
  project = makeProject()
})

/** Same technique as test/fake-agy/golden.test.ts's installGate, under a different hook key. */
function installExtraDenyGate(workspaceRoot: string, denySubstring: string, reason: string): void {
  const agents = join(workspaceRoot, '.agents')
  mkdirSync(agents, { recursive: true })
  const script = join(agents, 'extra-gate.sh')
  writeFileSync(
    script,
    `#!/bin/sh
IN=$(cat)
case "$IN" in
  *${denySubstring}*) printf '{"decision":"deny","reason":"${reason}"}' ;;
  *) printf '{"decision":"ask"}' ;;
esac
`,
    { mode: 0o755 },
  )
  chmodSync(script, 0o755)
  const hooksPath = join(agents, 'hooks.json')
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(readFileSync(hooksPath, 'utf8'))
  } catch {
    existing = {}
  }
  existing['test-extra-gate'] = {
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: './extra-gate.sh', timeout: 15 }] }],
  }
  writeFileSync(hooksPath, JSON.stringify(existing))
}

describe('#12 — the gate answers "ask" (never {}) for a conversation that is not one of ours', () => {
  it('dist/gate.js emits exactly {"decision":"ask"} for an unbound conversationId', () => {
    const payload = {
      conversationId: 'not-one-of-our-jobs-' + Date.now(),
      stepIdx: 0,
      modelName: 'gemini-3.7-flash-low',
      toolCall: { name: 'run_command', args: { CommandLine: 'echo hi' } },
      workspacePaths: [],
    }
    const out = execFileSync('node', [join(REPO_ROOT, 'dist', 'gate.js')], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, AGY_WORKER_HOME: project.home, AGY_WORKER_PROJECT: project.root },
    })
    expect(out).toBe('{"decision":"ask"}')
    expect(out).not.toBe('{}')
  })
})

describe('#13 — a Class 1 (structured) denial is visible even though agy exits 0 / reports SUCCESS', () => {
  it('verification.blockers records it as an actionable source:"gate" entry, and the packet says blocked', async () => {
    applyEnv(project, 'hook-denied')
    mkdirSync(project.root, { recursive: true })
    installExtraDenyGate(
      project.root,
      'forbidden-marker',
      'denied by an integration-test-installed extra hook for #13',
    )

    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')

    const ctx = createContext()
    const started = replyJson(await handleStart(ctx, { prompt: 'x', profile: 'general_worker' } as never)) as {
      job_id: string
    }
    const waited = replyJson(await handleWait(ctx, { job_id: started.job_id, wait_ms: 10_000 } as never)) as {
      lifecycle: string
      exit_code: number
      agent_status: string
      outcome: string
      counts: { blockers: number; actionable: number }
      headline: string
    }
    expect(waited.lifecycle).toBe('finished')
    // Measured, docs/02 §9: a hook denial is still exit 0 / status SUCCESS.
    expect(waited.exit_code).toBe(0)
    expect(waited.agent_status).toBe('SUCCESS')
    // The packet's own invariant: a blocker our gate authored carries
    // blocks_outcome, so it must always come with outcome "blocked" — never
    // with a success. The headline names who refused.
    expect(waited.counts.blockers).toBeGreaterThanOrEqual(1)
    expect(waited.outcome).toBe('blocked')
    expect(waited.headline).toContain('gate denial')

    const verification = replyJson(
      await handleResult(ctx, { job_id: started.job_id, section: 'verification' } as never),
    ) as { verification: { blockers: Array<{ source: string; actionable: boolean; message: string }> } }
    const gateBlockers = verification.verification.blockers.filter((b) => b.source === 'gate')
    expect(gateBlockers.length).toBeGreaterThanOrEqual(1)
    expect(gateBlockers[0]!.actionable).toBe(true)
    expect(gateBlockers[0]!.message).toContain('tool call denied by pre-tool hook:')

    ctx.store.close()
  })
})

describe('#14 — a Class 2 (silent environment) block is detected even though status stays SUCCESS, and blocks verified_success', () => {
  it('a "Could not resolve host" tool output is caught by broker/verify.ts without any hook firing', async () => {
    applyEnv(project, 'network-blocked')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')

    const ctx = createContext()
    const started = replyJson(
      await handleStart(ctx, { prompt: 'x', profile: 'general_worker', expected_artifacts: [] } as never),
    ) as { job_id: string }
    const waited = replyJson(await handleWait(ctx, { job_id: started.job_id, wait_ms: 10_000 } as never)) as {
      lifecycle: string
      exit_code: number
      outcome: string
    }
    expect(waited.lifecycle).toBe('finished')
    expect(waited.exit_code).toBe(0)
    expect(waited.outcome).toBe('blocked')

    const verification = replyJson(
      await handleResult(ctx, { job_id: started.job_id, section: 'verification' } as never),
    ) as { verification: { blockers: Array<{ source: string; detail?: { signature?: string } }> } }
    const sandboxBlockers = verification.verification.blockers.filter((b) => b.source === 'sandbox')
    expect(sandboxBlockers.length).toBe(1)
    // The original Class 2 record survives verbatim under `detail`.
    expect(sandboxBlockers[0]!.detail?.signature).toBe('Could not resolve host')

    ctx.store.close()
  })
})

describe('#15 — a missing expected artifact keeps the job out of verified_success', () => {
  it('happy scenario, plus an expected_artifacts entry the fake agy never creates', async () => {
    applyEnv(project, 'happy')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')

    const ctx = createContext()
    const started = replyJson(
      await handleStart(ctx, {
        prompt: 'x',
        profile: 'general_worker',
        expected_artifacts: ['does-not-exist/output.txt'],
      } as never),
    ) as { job_id: string }
    const waited = replyJson(await handleWait(ctx, { job_id: started.job_id, wait_ms: 10_000 } as never)) as {
      lifecycle: string
      outcome: string
    }
    expect(waited.lifecycle).toBe('finished')
    expect(waited.outcome).not.toBe('verified_success')
    expect(waited.outcome).toBe('blocked')

    const verification = replyJson(
      await handleResult(ctx, { job_id: started.job_id, section: 'verification' } as never),
    ) as { verification: { expected_artifacts: Array<{ path: string; exists: boolean }> } }
    expect(verification.verification.expected_artifacts).toEqual([
      { path: 'does-not-exist/output.txt', exists: false, absolute: expect.any(String), size: null },
    ])

    ctx.store.close()
  })

  it('the same artifact actually present makes the job verified_success', async () => {
    applyEnv(project, 'happy')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')

    mkdirSync(project.root, { recursive: true })
    writeFileSync(join(project.root, 'output.txt'), 'present\n')

    const ctx = createContext()
    const started = replyJson(
      await handleStart(ctx, {
        prompt: 'x',
        profile: 'general_worker',
        expected_artifacts: ['output.txt'],
      } as never),
    ) as { job_id: string }
    const waited = replyJson(await handleWait(ctx, { job_id: started.job_id, wait_ms: 10_000 } as never)) as {
      outcome: string
    }
    expect(waited.outcome).toBe('verified_success')

    ctx.store.close()
  })
})

describe('#16 — on_denial:"abort" terminates the job on the first policy denial', () => {
  it('a general_worker job with on_denial:"abort" running a hard-denied command is canceled, not left running to completion', async () => {
    // on_denial is consulted only inside our own gate.ts's decide(), which
    // requires the job to be bound — so this case exercises the full
    // policy-to-gate wiring, not just the detection pipeline.
    applyEnv(project, 'denial-then-workaround')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { reconcile } = await import('../../src/broker/reconcile.js')
    const { getJob } = await import('../../src/store/jobs.js')

    const ctx = createContext()
    const started = replyJson(
      await handleStart(ctx, { prompt: 'x', profile: 'general_worker', on_denial: 'abort' } as never),
    ) as { job_id: string }

    const finished = await waitUntil(
      async () => {
        await reconcile(ctx.store)
        const job = getJob(ctx.store, started.job_id)
        return job.lifecycle === 'finished' ? job : null
      },
      { timeoutMs: 10_000, label: 'on_denial:abort job reaches a terminal state' },
    )
    // denial-then-workaround's third tool call ("python -m pytest") only runs
    // if the job was allowed to keep going after the pip-install denial. With
    // on_denial:"abort" honoured, the gate should mark it 'canceling' at the
    // moment of the first denial and the job should finish 'canceled', never
    // reaching (and reporting) the workaround step.
    expect(finished.outcome).toBe('canceled')

    ctx.store.close()
  })
})
