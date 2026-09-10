/**
 * The gate and the broker's own verification (see docs/permissions.md),
 * kept independent of agy's self-report.
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
 * denial and the scripted `output` is never emitted — 0.2.0 (PR2) sharpened
 * this further: `default_decision` is gone, so an unmatched command is denied
 * under *every* profile now, not just `research_readonly`'s old `deny`
 * default. `happy.json` runs `git status`, which sits in both shipped
 * profiles' allow ceilings.
 *
 * #13 additionally exercises events/detect.ts's Class 1 parsing and
 * broker/verify.ts's aggregation with a hand-installed extra PreToolUse hook,
 * alongside (not instead of) our own `dist/gate.js`, that denies
 * unconditionally — a second, independent path into the detection pipeline.
 * This used to be a real (if rare) flake source for the runtime gate watchdog
 * (I4): `installExtraDenyGate` below writes its key into `hooks.json` *before*
 * `agy_start` runs, and `ensureGateHook` (`src/gate/hooks-file.ts`) writes our
 * own key first in the object specifically so that ordering can never cause
 * our gate to be skipped by an earlier group's deny (M6) — see that module's own comment.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  applyEnv,
  ensureBuilt,
  makeProject,
  readJobState,
  REPO_ROOT,
  replyJson,
  waitUntil,
  writeAgyWrapper,
  type TestProject,
} from './helpers.js'

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

describe('the gate answers "ask" (never {}) for a conversation that is not one of ours', () => {
  it('dist/gate.js emits exactly {"decision":"ask"} for an unbound conversationId', async () => {
    // The project's store must already exist for this to exercise genuine
    // "unbound" (§2.3: bindConversation resolves, this conversationId matches
    // no job of ours) rather than "the store cannot even be opened" (§2.3's
    // separate `state unavailable` row, PR2) — a fresh AGY_WORKER_HOME with no
    // project ever created is the *other* failure path, covered at the unit
    // level in test/unit/gate/gate.test.ts.
    applyEnv(project, 'unbound-probe')
    const { createContext } = await import('../../src/server/context.js')
    const ctx = createContext()
    ctx.store.close()

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

describe('a Class 1 (structured) denial is visible even though agy exits 0 / reports SUCCESS', () => {
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
    // Measured: a hook denial is still exit 0 / status SUCCESS.
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
    ) as {
      verification: { blockers: Array<{ source: string; actionable: boolean; message: string }>; warnings: string[] }
    }
    const gateBlockers = verification.verification.blockers.filter((b) => b.source === 'gate')
    expect(gateBlockers.length).toBeGreaterThanOrEqual(1)
    expect(gateBlockers[0]!.actionable).toBe(true)
    expect(gateBlockers[0]!.message).toContain('tool call denied by pre-tool hook:')
    // This denial came from a foreign hook, not from a rule our gate could
    // name, so the ceiling would not open it — no "no project ceiling" hint
    // here even though the project has no ceiling file (blockers.ts
    // ceilingAbsenceWarning; the positive case is unit-tested there).
    expect(verification.verification.warnings.some((w) => w.startsWith('no project ceiling'))).toBe(false)

    ctx.store.close()
  })
})

describe('a Class 2 (silent environment) block is detected even though status stays SUCCESS, and blocks verified_success', () => {
  it('a "Could not resolve host" tool output is caught by broker/verify.ts without any hook firing (job forced sandboxed)', async () => {
    applyEnv(project, 'network-blocked')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')

    const ctx = createContext()
    // 0.2.1: general_worker bypasses the sandbox by default, so the signature
    // only means "sandbox" on a job that actually ran sandboxed.
    const started = replyJson(
      await handleStart(ctx, {
        prompt: 'x',
        profile: 'general_worker',
        expected_artifacts: [],
        permissions: { sandbox: 'agy' },
      } as never),
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

  it('the same output on a job that ran unsandboxed (general_worker default) is a warning, not a blocker', async () => {
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
      outcome: string
      warnings: string[]
    }
    expect(waited.lifecycle).toBe('finished')
    expect(waited.outcome).not.toBe('blocked')
    expect(waited.warnings.some((w) => w.includes('sandbox: none'))).toBe(true)

    const verification = replyJson(
      await handleResult(ctx, { job_id: started.job_id, section: 'verification' } as never),
    ) as { verification: { blockers: Array<{ source: string }> } }
    expect(verification.verification.blockers.filter((b) => b.source === 'sandbox')).toEqual([])

    ctx.store.close()
  })
})

describe('a missing expected artifact keeps the job out of verified_success', () => {
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

describe('on_denial:"abort" terminates the job on the first policy denial', () => {
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

describe('PR2: subagent tools are denied (M2), and a bound job\'s gate-log never carries "ask" (I1)', () => {
  it('subagent-bypass ends blocked, with gate blockers for define_subagent/invoke_subagent', async () => {
    // Before PR2, the *parent's* define_subagent/invoke_subagent calls matched
    // nothing and (under general_worker's old `default_decision: 'ask'`) sailed
    // through — the only thing M2 exposed was that the *nested* run_command
    // (a different, unbound conversationId) bypassed policy entirely. PR2
    // closes the parent side too: `classifyToolCall` marks every subagent tool
    // `unsupported`, so define_subagent/invoke_subagent are now denied outright
    // by our own gate, at the `unsupported` stage.
    //
    // What PR2 does NOT close (and this test asserts what the fake actually
    // produces, not what would be ideal): `test/fake-agy/agy.mjs`'s
    // `subagent_run_command` extension always plays the nested step
    // unconditionally — it does not model "invoke_subagent was itself denied,
    // so the subagent never actually ran". So the nested `echo from-subagent`
    // still executes, under a fresh conversationId `bindConversation` cannot
    // match to this job, and still gets `ask` (§2.2 step 1 — genuinely not
    // ours). That call's decision is real, but never logged to *this* job's
    // gate-log.jsonl (logging requires `bound !== null`), which is exactly why
    // the I1 assertion below holds regardless.
    applyEnv(project, 'subagent-bypass')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')
    const { jobPaths } = await import('../../src/contract/paths.js')

    const ctx = createContext()
    const started = replyJson(await handleStart(ctx, { prompt: 'x', profile: 'general_worker' } as never)) as {
      job_id: string
    }
    const waited = replyJson(await handleWait(ctx, { job_id: started.job_id, wait_ms: 10_000 } as never)) as {
      lifecycle: string
      outcome: string
      headline: string
    }
    expect(waited.lifecycle).toBe('finished')
    expect(waited.outcome).toBe('blocked')
    expect(waited.headline).toContain('gate denial')

    const verification = replyJson(
      await handleResult(ctx, { job_id: started.job_id, section: 'verification' } as never),
    ) as { verification: { blockers: Array<{ source: string; tool: string | null; actionable: boolean }> } }
    const gateBlockers = verification.verification.blockers.filter((b) => b.source === 'gate')
    const deniedTools = gateBlockers.map((b) => b.tool)
    expect(deniedTools).toContain('define_subagent')
    expect(deniedTools).toContain('invoke_subagent')
    // Not actionable: no permissions.allow rule can grant a subagent tool —
    // classifyToolCall marks it unsupported unconditionally.
    expect(gateBlockers.every((b) => b.actionable === false)).toBe(true)

    // I1: bound job, so its own gate-log.jsonl must not contain a single
    // 'ask' line — every call the gate actually bound to this job was either
    // allowed or denied, never passed through.
    const gateLogPath = join(jobPaths(ctx.paths, started.job_id).dir, 'gate-log.jsonl')
    const lines = readFileSync(gateLogPath, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    const decisions = lines.map((l) => (JSON.parse(l) as { decision: string }).decision)
    expect(decisions).not.toContain('ask')

    ctx.store.close()
  })
})

/**
 * PR3 §3.1/§3.2 — `hooks.json` entry lifecycle:
 * `agy_start` writes `GATE_HOOK_KEY`, and `reconcile` removes only that key once
 * no live job on the same canonical `cwd` needs it any more, preserving any
 * other key untouched.
 */
describe('hooks.json entry lifecycle', () => {
  function hooksJsonPath(cwd: string): string {
    return join(cwd, '.agents', 'hooks.json')
  }

  /** `removeGateHook` deletes the file entirely once our key was the only one left. */
  function readHooksJsonOrEmpty(cwd: string): Record<string, unknown> {
    try {
      return JSON.parse(readFileSync(hooksJsonPath(cwd), 'utf8')) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  it('agy_start writes our key with a bare "node <gate>" command, no "|| printf" fallback', async () => {
    applyEnv(project, 'happy')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')

    const ctx = createContext()
    const started = replyJson(await handleStart(ctx, { prompt: 'x', profile: 'research_readonly' } as never)) as {
      job_id: string
      cwd: string
    }

    const hooks = JSON.parse(readFileSync(hooksJsonPath(started.cwd), 'utf8')) as Record<
      string,
      { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }
    >
    expect(hooks['agy-worker-gate']).toBeDefined()
    const command = hooks['agy-worker-gate']!.PreToolUse[0]!.hooks[0]!.command
    expect(command.startsWith('node ')).toBe(true)
    expect(command).not.toContain('||')
    expect(command).not.toContain('printf')

    ctx.store.close()
  })

  it('once the job finishes and reconcile runs (any tool call triggers it), our key is gone and an unrelated key survives', async () => {
    applyEnv(project, 'happy')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')

    const cwd = project.root
    mkdirSync(join(cwd, '.agents'), { recursive: true })
    writeFileSync(
      hooksJsonPath(cwd),
      JSON.stringify({
        'unrelated-hook': {
          PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'printf \'{"decision":"ask"}\'', timeout: 15 }] }],
        },
      }),
    )

    const ctx = createContext()
    const started = replyJson(await handleStart(ctx, { prompt: 'x', profile: 'research_readonly' } as never)) as {
      job_id: string
    }
    // handleWait's own internal reconcile() (called by every tool handler)
    // is the "any tool call" that absorbs the finished job.
    const waited = replyJson(await handleWait(ctx, { job_id: started.job_id, wait_ms: 10_000 } as never)) as {
      lifecycle: string
    }
    expect(waited.lifecycle).toBe('finished')

    const hooks = JSON.parse(readFileSync(hooksJsonPath(cwd), 'utf8')) as Record<string, unknown>
    expect(hooks['agy-worker-gate']).toBeUndefined()
    expect(hooks['unrelated-hook']).toBeDefined()

    ctx.store.close()
  })

  it('with two live jobs on the same cwd, finishing one keeps the entry (the other is still live)', async () => {
    applyEnv(project, 'hang')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleCancel } = await import('../../src/server/tools/cancel.js')
    const { reconcile } = await import('../../src/broker/reconcile.js')
    const { getJob } = await import('../../src/store/jobs.js')

    const ctx = createContext()
    // research_readonly takes no cwd_write lock, so two of these on the same
    // cwd can both be live at once.
    const long = replyJson(
      await handleStart(ctx, { prompt: 'long', profile: 'research_readonly' } as never),
    ) as { job_id: string; cwd: string }

    await waitUntil(
      () => {
        const s = readJobState(ctx, long.job_id)
        return s?.pgid != null ? s : null
      },
      { timeoutMs: 8000, label: 'long-running job published a pgid' },
    )

    // A second, quick job on the same cwd, different scenario.
    process.env.AGY_WORKER_AGY_BIN = writeAgyWrapper(project, 'happy')
    const short = replyJson(
      await handleStart(ctx, { prompt: 'short', profile: 'research_readonly', cwd: long.cwd } as never),
    ) as { job_id: string }

    const finishedShort = await waitUntil(
      async () => {
        await reconcile(ctx.store)
        const job = getJob(ctx.store, short.job_id)
        return job.lifecycle === 'finished' ? job : null
      },
      { timeoutMs: 10_000, label: 'short job finished' },
    )
    expect(finishedShort.lifecycle).toBe('finished')

    // The long job is still live, so our key must still be there.
    const hooksAfterShort = JSON.parse(readFileSync(hooksJsonPath(long.cwd), 'utf8')) as Record<string, unknown>
    expect(hooksAfterShort['agy-worker-gate']).toBeDefined()

    // Now finish the long job too, and confirm the key finally goes away.
    await handleCancel(ctx, { job_id: long.job_id } as never)
    await waitUntil(
      async () => {
        await reconcile(ctx.store)
        const job = getJob(ctx.store, long.job_id)
        return job.lifecycle === 'finished' ? job : null
      },
      { timeoutMs: 10_000, label: 'long job finished after cancel' },
    )
    // No other key was ever installed here, so removeGateHook deletes the
    // whole file (and the now-empty .agents dir) rather than leaving `{}`.
    const hooksAfterBoth = readHooksJsonOrEmpty(long.cwd)
    expect(hooksAfterBoth['agy-worker-gate']).toBeUndefined()

    ctx.store.close()
  })
})

describe('agy_start fails cleanly when the gate binary is missing', () => {
  afterEach(() => {
    delete process.env.AGY_WORKER_GATE_BIN
  })

  it('a nonexistent gate path (ENV.GATE_BIN override) makes agy_start throw a VALIDATION error instead of installing an unusable hook', async () => {
    applyEnv(project, 'happy')
    process.env.AGY_WORKER_GATE_BIN = join(project.home, 'no-such-gate.js')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')

    const ctx = createContext()
    const reply = await handleStart(ctx, { prompt: 'x', profile: 'research_readonly' } as never)
    expect(reply.isError).toBe(true)
    const envelope = reply.structuredContent as { error: string; detail: { field: string } }
    expect(envelope.error).toBe('VALIDATION')
    expect(envelope.detail.field).toBe('gate')

    // Nothing should have been left behind: no hooks.json written for a job
    // that never actually got a working gate.
    expect(existsSync(join(project.root, '.agents', 'hooks.json'))).toBe(false)

    ctx.store.close()
  })
})

/**
 * Runtime gate confirmation (I4).
 */
describe('runtime gate confirmation (I4)', () => {
  it('happy path: gate_confirmed is true once the gate actually logs a verdict', async () => {
    applyEnv(project, 'happy')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { jobPaths } = await import('../../src/contract/paths.js')

    const ctx = createContext()
    const started = replyJson(await handleStart(ctx, { prompt: 'x', profile: 'general_worker' } as never)) as {
      job_id: string
    }
    const waited = replyJson(await handleWait(ctx, { job_id: started.job_id, wait_ms: 10_000 } as never)) as {
      lifecycle: string
      outcome: string
    }
    expect(waited.lifecycle).toBe('finished')
    expect(waited.outcome).not.toBe('process_error')

    const state = JSON.parse(
      readFileSync(jobPaths(ctx.paths, started.job_id).state, 'utf8'),
    ) as { gate_confirmed: boolean | null }
    expect(state.gate_confirmed).toBe(true)

    ctx.store.close()
  })

  it('hook-missing (AGY_FAKE_SKIP_HOOKS=1): the runner kills the job, gate_confirmed is false, and the broker reports process_error with a source:"broker" blocker', async () => {
    // AGY_FAKE_SKIP_HOOKS=1 has to reach the fake binary's own env read
    // without passing through production's `buildChildEnv` allowlist
    // (`src/runner/spawn.ts`) — baked into the per-scenario wrapper script
    // itself, the same mechanism `AGY_FAKE_SCENARIO` already uses
    // (`test/integration/helpers.ts`'s `writeAgyWrapper`).
    applyEnv(project, 'hook-missing', { AGY_FAKE_SKIP_HOOKS: '1' })
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')
    const { jobPaths } = await import('../../src/contract/paths.js')

    const ctx = createContext()
    const started = replyJson(await handleStart(ctx, { prompt: 'x', profile: 'general_worker' } as never)) as {
      job_id: string
    }
    // The watchdog declares missing gracePeriodMs (default 1s) after the
    // first tool step's terminal event; give this comfortably more room than
    // that plus the kill + reconcile round trip.
    const waited = replyJson(await handleWait(ctx, { job_id: started.job_id, wait_ms: 15_000 } as never)) as {
      lifecycle: string
      outcome: string
      headline: string
    }
    expect(waited.lifecycle).toBe('finished')
    expect(waited.outcome).toBe('process_error')
    expect(waited.headline).toContain('gate hook never fired')

    const state = JSON.parse(
      readFileSync(jobPaths(ctx.paths, started.job_id).state, 'utf8'),
    ) as { gate_confirmed: boolean | null }
    expect(state.gate_confirmed).toBe(false)

    const verification = replyJson(
      await handleResult(ctx, { job_id: started.job_id, section: 'verification' } as never),
    ) as {
      verification: {
        blockers: Array<{ source: string; actionable: boolean; blocks_outcome: boolean; message: string }>
      }
    }
    const gateMissingBlockers = verification.verification.blockers.filter(
      (b) => b.source === 'broker' && b.message.includes('gate hook never fired'),
    )
    expect(gateMissingBlockers.length).toBe(1)
    expect(gateMissingBlockers[0]!.actionable).toBe(false)
    expect(gateMissingBlockers[0]!.blocks_outcome).toBe(true)

    ctx.store.close()
  }, 20_000)
})
