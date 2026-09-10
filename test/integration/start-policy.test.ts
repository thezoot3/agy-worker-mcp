/**
 * `agy_start` reports what the profile ceiling did to a `permissions` request.
 *
 * The trap, measured: a client asked for
 * `allow: ["command(./gradlew)","command(bash)","command(javap)"]`, all three
 * fell outside the ceiling, and because `allow` is an *intersection* the
 * effective list collapsed to `[]` — dropping the profile's own defaults with
 * it. The old reply carried neither `rejected_allow` nor a warning, so the job
 * ran with nothing explicitly allowed and no one could tell.
 *
 * `dry_run` only: none of this spawns agy.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { canonicalize, projectPaths } from '../../src/contract/paths.js'
import type { Blocker, EffectiveConfig, PolicySummary } from '../../src/contract/types.js'
import { ceilingPath } from '../../src/policy/ceiling.js'
import { applyEnv, ensureBuilt, makeProject, replyJson, type TestProject } from './helpers.js'

/** Resolve the ceiling path the same way `agy_start` will — no store connection needed. */
function ceilingPathFor(project: TestProject): string {
  return ceilingPath(projectPaths(canonicalize(project.root)))
}

let project: TestProject

// The last case starts a real (fake-agy) job, which spawns dist/runner.js.
beforeAll(() => {
  ensureBuilt()
})

beforeEach(() => {
  project = makeProject()
  applyEnv(project, 'happy')
})

interface StartReply {
  dry_run?: boolean
  policy_summary: PolicySummary
  blockers: Blocker[]
  warnings: string[]
  effective_config: EffectiveConfig
}

async function start(input: Record<string, unknown>): Promise<StartReply> {
  const { createContext } = await import('../../src/server/context.js')
  const { handleStart } = await import('../../src/server/tools/start.js')
  const ctx = createContext()
  try {
    return replyJson<StartReply>(await handleStart(ctx, input as never))
  } finally {
    ctx.store.close()
  }
}

describe('a permissions.allow request entirely outside the ceiling', () => {
  it('reports every rejection as a policy_ceiling blocker and says the allow list collapsed', async () => {
    const reply = await start({
      prompt: 'x',
      profile: 'general_worker',
      permissions: { allow: ['command(bash)', 'command(javap)'] },
      dry_run: true,
    })

    expect(reply.policy_summary.allow_count).toBe(0)
    expect(reply.policy_summary.profile).toBe('general_worker')

    const rejections = reply.blockers.filter((b) => b.source === 'policy_ceiling')
    expect(rejections.length).toBeGreaterThanOrEqual(3) // two rejected rules + the collapse
    for (const rule of ['command(bash)', 'command(javap)']) {
      const b = rejections.find((r) => r.message.includes(rule))
      expect(b, `a blocker for ${rule}`).toBeDefined()
      expect(b!.actionable).toBe(true)
      expect(b!.remedy).toContain('permissions.allow')
    }

    // The collapse itself, in its own words, with the instruction to restart.
    const collapse = rejections.find((b) => b.message.includes('effective allow list is empty'))
    expect(collapse).toBeDefined()
    expect(collapse!.message).toContain("profile's own default allowances")
    expect(collapse!.remedy).toContain('start again with no permissions.allow')

    // And the same thing in `warnings`, which is what a prose-reading caller sees.
    expect(reply.warnings.some((w) => w.includes('effective allow list is empty'))).toBe(true)
  })

  it('a request the ceiling covers produces no blockers and keeps the rules', async () => {
    const reply = await start({
      prompt: 'x',
      profile: 'general_worker',
      // Added to the ceiling in 0.1.1 precisely so build commands stop bouncing.
      permissions: { allow: ['command(./gradlew)', 'command(mvn)'] },
      dry_run: true,
    })

    expect(reply.policy_summary.allow_count).toBe(2)
    expect(reply.blockers).toEqual([])
    // PR5: the 'nothing verifiable' pre-flight warning is orthogonal to the ceiling.
    expect(
      reply.warnings.filter((w) => !w.startsWith('nothing verifiable') && !w.startsWith('no project ceiling')),
    ).toEqual([])
  })

  it('with no policy.json, agy_start warns once that there is no ceiling and names the file and the way to propose one', async () => {
    const reply = await start({ prompt: 'x', profile: 'general_worker', dry_run: true })
    const hints = reply.warnings.filter((w) => w.startsWith('no project ceiling'))
    expect(hints).toHaveLength(1)
    expect(hints[0]).toContain('policy.json')
    expect(hints[0]).toContain('agy_ceiling')
    expect(hints[0]).toContain('/agy-ceiling')
    expect(hints[0]).toContain('approves')
    expect(reply.effective_config.policy.ceiling_present).toBe(false)
  })

  it('omitting permissions entirely leaves the full profile ceiling in place', async () => {
    const reply = await start({ prompt: 'x', profile: 'general_worker', dry_run: true })
    expect(reply.policy_summary.allow_count).toBeGreaterThan(0)
    expect(reply.blockers).toEqual([])
  })
})

describe('the non-dry_run reply carries the same three fields', () => {
  it('a real agy_start reports its policy too, not just a job_id', async () => {
    const reply = await start({
      prompt: 'x',
      profile: 'general_worker',
      permissions: { allow: ['command(bash)'] },
    })

    expect(reply.dry_run).toBe(false)
    expect(reply.policy_summary.allow_count).toBe(0)
    expect(reply.blockers.some((b) => b.source === 'policy_ceiling')).toBe(true)
    expect(reply.warnings.length).toBeGreaterThan(0)
  })
})

/**
 * PR4 (docs/permissions.md) — the human ceiling at
 * `<project state dir>/policy.json`, outside the workspace (I6). `dry_run`
 * only below; the end-to-end (real fake-agy job) BypassSandbox test is its own
 * describe block further down.
 */
describe('the human ceiling — permissions.read_roots must match a ceiling glob', () => {
  function writeCeiling(project: TestProject, body: Record<string, unknown>): void {
    const paths = projectPaths(canonicalize(project.root))
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(ceilingPath(paths), JSON.stringify(body))
  }

  it('a requested read_roots entry inside a ceiling glob shows up in effective_config.policy and argv', async () => {
    const jdksDir = join(project.home, 'jdks-fixture')
    mkdirSync(jdksDir, { recursive: true })
    // `canonicalize()` resolves symlinks (macOS: /var -> /private/var), so the
    // policy's own resolved form is what the assertion below compares against.
    const jdksDirCanonical = canonicalize(jdksDir)
    writeCeiling(project, { version: 2, read_roots: [join(project.home, 'jdks-fixture')] })

    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const ctx = createContext()
    try {
      const reply = replyJson<{ effective_config: EffectiveConfig }>(
        await handleStart(ctx, {
          prompt: 'x',
          profile: 'general_worker',
          permissions: { read_roots: [jdksDir] },
          dry_run: true,
        } as never),
      )
      expect(reply.effective_config.policy.add_dirs).toEqual([jdksDirCanonical])
      expect(reply.effective_config.policy.rejected_read_roots).toEqual([])
      expect(reply.effective_config.argv).toContain('--add-dir')
      expect(reply.effective_config.argv).toContain(jdksDirCanonical)
    } finally {
      ctx.store.close()
    }
  })

  it('a requested read_roots entry outside every ceiling glob is rejected and reported as a policy_ceiling blocker', async () => {
    const insideDir = join(project.home, 'inside-fixture')
    const outsideDir = join(project.home, 'outside-fixture')
    mkdirSync(insideDir, { recursive: true })
    mkdirSync(outsideDir, { recursive: true })
    writeCeiling(project, { version: 2, read_roots: [insideDir] })

    const reply = await start({
      prompt: 'x',
      profile: 'general_worker',
      permissions: { read_roots: [outsideDir] },
      dry_run: true,
    })

    expect(reply.policy_summary.add_dirs).toEqual([])
    const rejection = reply.blockers.find(
      (b) => b.source === 'policy_ceiling' && b.message.includes(outsideDir),
    )
    expect(rejection).toBeDefined()
    expect(rejection!.actionable).toBe(true)
  })

  it('a corrupt ceiling file makes agy_start fail closed with a VALIDATION error naming the ceiling file', async () => {
    const paths = projectPaths(canonicalize(project.root))
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(ceilingPath(paths), '{ this is not json')

    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const ctx = createContext()
    try {
      const reply = await handleStart(ctx, { prompt: 'x', profile: 'general_worker', dry_run: true } as never)
      expect(reply.isError).toBe(true)
      const envelope = reply.structuredContent as { error: string; detail: { field: string; expected: string } }
      expect(envelope.error).toBe('VALIDATION')
      expect(envelope.detail.field).toBe('ceiling')
      expect(envelope.detail.expected).toContain(ceilingPathFor(project))
    } finally {
      ctx.store.close()
    }
  })
})

/**
 * PR4 (docs/permissions.md), end to end — a real (fake-agy) job
 * whose `run_command` reaches for `~/.jdks`, a path outside the workspace and
 * outside every `--add-dir` this test passes.
 *
 * `test/fake-agy/agy.mjs` never persists the hook's `overwrite.BypassSandbox`
 * value anywhere a test can read back directly (confirmed by inspecting
 * `resolveBypassSandbox`/`runToolStep` — it only ever feeds a same-process
 * branch, `'bypass' | 'sandboxed' | 'engine_denied'`, that decides which
 * output the step emits). So `BypassSandbox` is asserted the way the fake
 * actually makes it observable, per `scenarios/sandbox-escape.json` and
 * `scenarios/additional-dir.json`'s own doc comments: `BypassSandbox:true`
 * (mode `'bypass'`) skips the escaping-path check entirely and the scripted
 * `output` ("jdk-25.0.4.1+1\n") comes through untouched, with no Class 2
 * "Operation not permitted" signature — `BypassSandbox:false` (mode
 * `'sandboxed'`) hits `findEscapingPath` and the tool's real output is
 * overwritten with an OS-level "Operation not permitted" line instead, which
 * `broker/verify.ts` detects as a `source:'sandbox'` blocker and forces
 * `outcome:'blocked'`.
 *
 * Deviates from the task's own illustrative `unsandboxed: ["command(echo)"]`
 * example on purpose: `echo` never touches an absolute path, so bypass vs.
 * sandboxed would be indistinguishable in the fake's output either way. `ls
 * ~/.jdks` (the `additional-dir` scenario's own command) is what actually
 * produces the two different, checkable outcomes below.
 */
describe('BypassSandbox — default bypass on general_worker, forced sandboxed by ceiling, request, or research_readonly', () => {
  function writeCeiling(project: TestProject, body: Record<string, unknown>): void {
    const paths = projectPaths(canonicalize(project.root))
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(ceilingPath(paths), JSON.stringify(body))
  }

  it('general_worker runs unsandboxed by default: BypassSandbox comes out true, no sandbox block', async () => {
    applyEnv(project, 'additional-dir')
    writeCeiling(project, { version: 2, allow: ['command(ls)'] })

    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')
    const { jobPaths } = await import('../../src/contract/paths.js')

    const ctx = createContext()
    try {
      const started = replyJson(await handleStart(ctx, { prompt: 'x', profile: 'general_worker' } as never)) as {
        job_id: string
      }
      const waited = replyJson(await handleWait(ctx, { job_id: started.job_id, wait_ms: 10_000 } as never)) as {
        lifecycle: string
        outcome: string
      }
      expect(waited.lifecycle).toBe('finished')

      const gateLogPath = jobPaths(ctx.paths, started.job_id).gateLog
      const lines = readFileSync(gateLogPath, 'utf8').trim().split('\n').filter(Boolean)
      const runCommandLine = lines
        .map((l) => JSON.parse(l) as { tool: string; command: string | null; decision: string })
        .find((e) => e.tool === 'run_command' && e.command === 'ls ~/.jdks')
      expect(runCommandLine).toBeDefined()
      expect(runCommandLine!.decision).toBe('allow')

      // BypassSandbox:true skipped findEscapingPath, so no Class 2 signature
      // ever appeared in tool output — no sandbox blocker, and the job is not
      // blocked on that account.
      const verification = replyJson(
        await handleResult(ctx, { job_id: started.job_id, section: 'verification' } as never),
      ) as { verification: { blockers: Array<{ source: string }> } }
      expect(verification.verification.blockers.filter((b) => b.source === 'sandbox')).toEqual([])
      expect(waited.outcome).not.toBe('blocked')
    } finally {
      ctx.store.close()
    }
  })

  it('general_worker + ceiling sandboxed: true forces BypassSandbox: false and reports human ceiling remedy', async () => {
    applyEnv(project, 'additional-dir')
    writeCeiling(project, { version: 2, allow: ['command(ls)'], sandboxed: true })

    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')
    const { jobPaths } = await import('../../src/contract/paths.js')

    const ctx = createContext()
    try {
      const started = replyJson(await handleStart(ctx, { prompt: 'x', profile: 'general_worker' } as never)) as {
        job_id: string
      }
      const waited = replyJson(await handleWait(ctx, { job_id: started.job_id, wait_ms: 10_000 } as never)) as {
        lifecycle: string
        outcome: string
      }
      expect(waited.lifecycle).toBe('finished')

      const verification = replyJson(
        await handleResult(ctx, { job_id: started.job_id, section: 'verification' } as never),
      ) as { verification: { blockers: Array<{ source: string; remedy: string | null; detail?: { signature?: string } }> } }
      const sandboxBlockers = verification.verification.blockers.filter((b) => b.source === 'sandbox')
      expect(sandboxBlockers.length).toBe(1)
      expect(sandboxBlockers[0]!.detail?.signature).toBe('Operation not permitted')
      expect(sandboxBlockers[0]!.remedy).toContain('"sandbox": "none" (or "seatbelt") in the project ceiling')
      expect(waited.outcome).toBe('blocked')
    } finally {
      ctx.store.close()
    }
  })

  it('general_worker + permissions.sandboxed: true forces BypassSandbox: false and reports retry remedy', async () => {
    applyEnv(project, 'additional-dir')
    writeCeiling(project, { version: 2, allow: ['command(ls)'] })

    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')

    const ctx = createContext()
    try {
      const started = replyJson(
        await handleStart(ctx, { prompt: 'x', profile: 'general_worker', permissions: { sandboxed: true } } as never),
      ) as { job_id: string }
      const waited = replyJson(await handleWait(ctx, { job_id: started.job_id, wait_ms: 10_000 } as never)) as {
        lifecycle: string
        outcome: string
      }
      expect(waited.lifecycle).toBe('finished')

      const verification = replyJson(
        await handleResult(ctx, { job_id: started.job_id, section: 'verification' } as never),
      ) as { verification: { blockers: Array<{ source: string; remedy: string | null; detail?: { signature?: string } }> } }
      const sandboxBlockers = verification.verification.blockers.filter((b) => b.source === 'sandbox')
      expect(sandboxBlockers.length).toBe(1)
      expect(sandboxBlockers[0]!.detail?.signature).toBe('Operation not permitted')
      expect(sandboxBlockers[0]!.remedy).toContain('retry without permissions.sandboxed')
      expect(waited.outcome).toBe('blocked')
    } finally {
      ctx.store.close()
    }
  })

  it('research_readonly always runs sandboxed: BypassSandbox stays false, sandbox escape is blocked', async () => {
    applyEnv(project, 'additional-dir')
    writeCeiling(project, { version: 2, allow: ['command(ls)'] })

    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')
    const { jobPaths } = await import('../../src/contract/paths.js')

    const ctx = createContext()
    try {
      const started = replyJson(
        await handleStart(ctx, { prompt: 'x', profile: 'research_readonly' } as never),
      ) as { job_id: string }
      const waited = replyJson(await handleWait(ctx, { job_id: started.job_id, wait_ms: 10_000 } as never)) as {
        lifecycle: string
        outcome: string
      }
      expect(waited.lifecycle).toBe('finished')

      const gateLogPath = jobPaths(ctx.paths, started.job_id).gateLog
      const lines = readFileSync(gateLogPath, 'utf8').trim().split('\n').filter(Boolean)
      const runCommandLine = lines
        .map((l) => JSON.parse(l) as { tool: string; command: string | null; decision: string })
        .find((e) => e.tool === 'run_command' && e.command === 'ls ~/.jdks')
      expect(runCommandLine).toBeDefined()
      expect(runCommandLine!.decision).toBe('allow')

      // BypassSandbox:false forced findEscapingPath to run; ~/.jdks is
      // outside every --add-dir this job got (none), so the fake synthesizes
      // "Operation not permitted" — a Class 2 signature the broker catches.
      const verification = replyJson(
        await handleResult(ctx, { job_id: started.job_id, section: 'verification' } as never),
      ) as { verification: { blockers: Array<{ source: string; remedy: string | null; detail?: { signature?: string } }> } }
      const sandboxBlockers = verification.verification.blockers.filter((b) => b.source === 'sandbox')
      expect(sandboxBlockers.length).toBe(1)
      expect(sandboxBlockers[0]!.detail?.signature).toBe('Operation not permitted')
      expect(sandboxBlockers[0]!.remedy).toContain('general_worker')
      expect(waited.outcome).toBe('blocked')
    } finally {
      ctx.store.close()
    }
  })
})

describe("agy's own approval engine is off for every job (0.2.0 PR5, M3)", () => {
  it('dry_run argv carries --dangerously-skip-permissions once, after the --add-dir entries', async () => {
    const reply = (await start({ prompt: 'x', profile: 'general_worker', dry_run: true })) as StartReply & {
      effective_config: EffectiveConfig
    }
    const argv = reply.effective_config.argv
    expect(argv.filter((a) => a === '--dangerously-skip-permissions')).toHaveLength(1)
    const lastAddDir = argv.lastIndexOf('--add-dir')
    expect(argv[lastAddDir + 2]).toBe('--dangerously-skip-permissions')
    expect(argv).not.toContain('--sandbox')
  })
})

describe('M10 — a read root carrying its own .agents/hooks.json is refused at agy_start', () => {
  function writeCeiling(project: TestProject, body: Record<string, unknown>): void {
    const paths = projectPaths(canonicalize(project.root))
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(ceilingPath(paths), JSON.stringify(body))
  }

  it('fails closed with field read_roots naming the foreign hook file', async () => {
    const extra = join(project.home, 'toolchain-with-hook')
    mkdirSync(join(extra, '.agents'), { recursive: true })
    writeFileSync(join(extra, '.agents', 'hooks.json'), JSON.stringify({ x: { PreToolUse: [] } }))
    writeCeiling(project, { version: 2, read_roots: [extra] })

    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const ctx = createContext()
    try {
      const reply = replyJson<{ error?: string; detail?: { field?: string; expected?: string } }>(
        await handleStart(ctx, { prompt: 'x', profile: 'general_worker', dry_run: true } as never),
      )
      expect(reply.error).toBe('VALIDATION')
      expect(reply.detail?.field).toBe('read_roots')
      expect(reply.detail?.expected).toContain('hooks.json')
    } finally {
      ctx.store.close()
    }
  })
})
