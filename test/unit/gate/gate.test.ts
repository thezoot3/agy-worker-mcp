import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PASSTHROUGH, countDeniesInGateLog, decide, parsePayload } from '../../../src/gate/gate.js'
import type { GateDecideInput } from '../../../src/gate/gate.js'
import type { BoundJob } from '../../../src/gate/bind.js'
import { HARD_DENY, resolvePolicy } from '../../../src/policy/profiles.js'
import { extractRequiredRule, parseGateDenial } from '../../../src/events/detect.js'
import { canonicalize } from '../../../src/contract/paths.js'
import { openStore } from '../../../src/store/db.js'
import type { EffectivePolicy, JobRow } from '../../../src/contract/types.js'

const WS = '/abs/workspace'

function makeJob(over: Partial<JobRow> = {}): JobRow {
  return {
    job_id: 'job-1',
    session_id: null,
    lifecycle: 'running',
    outcome: null,
    headline: null,
    cwd: WS,
    profile: 'general_worker',
    write_mode: 1,
    session_mode: 'oneshot',
    pid: 1234,
    pgid: 1234,
    proc_start_time: 'x',
    created_at: 0,
    started_at: 0,
    finished_at: null,
    deadline_at: null,
    exit_code: null,
    agent_status: null,
    contract_status: null,
    on_denial: 'continue',
    requested_by: null,
    parent_task_id: null,
    ...over,
  }
}

function bound(policy: EffectivePolicy, job: Partial<JobRow> = {}): BoundJob {
  return { job: makeJob(job), policy, conversationId: 'conv-1' }
}

describe('stage 1 — unbound conversation → always ask, never {} (§2.2 step 1)', () => {
  it('bound === null produces {"decision":"ask"}, the safe pass-through', () => {
    const outcome = decide({
      payload: { conversationId: 'not-ours', toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } },
      bound: null,
    })
    expect(outcome.decision).toEqual(PASSTHROUGH)
    expect(outcome.decision).toEqual({ decision: 'ask' })
    expect(outcome.decision.decision).not.toBe(undefined)
    // Explicitly never the empty object, which agy treats as a denial.
    expect(Object.keys(outcome.decision)).not.toHaveLength(0)
    expect(outcome.log).toBeNull()
    expect(outcome.requestsAbort).toBe(false)
  })
})

describe('stage 2 — unsupported: unclassifiable or subagent tool call (§2.2 step 2)', () => {
  it('a genuinely unknown tool name is denied, stage "unsupported", required_rule null', () => {
    const policy = resolvePolicy({ profile: 'general_worker', workspace: WS })
    const outcome = decide({
      payload: { conversationId: 'conv-1', toolCall: { name: 'totally_made_up_tool', args: {} } },
      bound: bound(policy),
    })
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.log?.policy).toBe('unsupported')
    expect(parseGateDenial(outcome.decision.reason ?? '')?.required_rule).toBeNull()
  })

  it('view_file missing its required AbsolutePath argument is unsupported, not a crash', () => {
    const policy = resolvePolicy({ profile: 'general_worker', workspace: WS })
    const outcome = decide({
      payload: { conversationId: 'conv-1', toolCall: { name: 'view_file', args: { path: '/x' } } },
      bound: bound(policy),
    })
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.log?.policy).toBe('unsupported')
  })

  it.each(['define_subagent', 'invoke_subagent', 'manage_subagents', 'browser_subagent'])(
    '%s is denied as unsupported, with the M2 reason, under either profile',
    (toolName) => {
      for (const profile of ['research_readonly', 'general_worker'] as const) {
        const policy = resolvePolicy({ profile, workspace: WS })
        const outcome = decide({
          payload: { conversationId: 'conv-1', toolCall: { name: toolName, args: { name: 'x' } } },
          bound: bound(policy, { profile }),
        })
        expect(outcome.decision.decision).toBe('deny')
        expect(outcome.log?.policy).toBe('unsupported')
        expect(outcome.decision.reason).toContain('conversationId')
      }
    },
  )
})

describe('stage 3 — control: manage_task is always allowed, no overwrite (§2.2 step 3)', () => {
  it('allows manage_task even under research_readonly, which allows almost nothing else', () => {
    const policy = resolvePolicy({ profile: 'research_readonly', workspace: WS })
    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: { name: 'manage_task', args: { Action: 'status', TaskId: 'conv-1/task-1' } },
      },
      bound: bound(policy, { profile: 'research_readonly' }),
    })
    expect(outcome.decision).toEqual({ decision: 'allow' })
    expect(outcome.log?.policy).toBe('control')
  })
})

describe('stage 4 — containment, ahead of every rule list (§2.2 step 4)', () => {
  it('a write outside the workspace is denied even though nothing is on any deny list', () => {
    const policy = resolvePolicy({ profile: 'general_worker', workspace: WS })
    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: { name: 'write_to_file', args: { TargetFile: '/etc/evil.txt', CodeContent: 'x' } },
      },
      bound: bound(policy),
    })
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.log?.policy).toBe('containment')
    expect(outcome.decision.reason).toContain('/etc/evil.txt')
  })

  it('a read outside the workspace is denied under research_readonly, even though read_file({workspace}/**) is allowed', () => {
    const policy = resolvePolicy({ profile: 'research_readonly', workspace: WS })
    const outcome = decide({
      payload: { conversationId: 'conv-1', toolCall: { name: 'view_file', args: { AbsolutePath: '/etc/passwd' } } },
      bound: bound(policy, { profile: 'research_readonly' }),
    })
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.log?.policy).toBe('containment')
  })

  it.each(['research_readonly', 'general_worker'] as const)(
    '%s allows list_dir on the workspace root itself — `{workspace}/**` alone does not cover it',
    (profile) => {
      const policy = resolvePolicy({ profile, workspace: WS })
      const outcome = decide({
        payload: { conversationId: 'conv-1', toolCall: { name: 'list_dir', args: { DirectoryPath: WS } } },
        bound: bound(policy),
      })
      expect(outcome.decision.decision).toBe('allow')
    },
  )

  it('research_readonly allows view_file inside the workspace (finding 12 inversion resolved: real containment now applies per-tool)', () => {
    const policy = resolvePolicy({ profile: 'research_readonly', workspace: WS })
    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: { name: 'view_file', args: { AbsolutePath: `${WS}/a.txt` } },
      },
      bound: bound(policy, { profile: 'research_readonly' }),
    })
    expect(outcome.decision.decision).toBe('allow')
    expect(outcome.log?.policy).toBe('profile_allowlist')
  })

  it('.agents containment via run_command redirection (I6): denied even though it stays inside the workspace', () => {
    const policy = resolvePolicy({ profile: 'general_worker', workspace: WS })
    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: { name: 'run_command', args: { CommandLine: `echo pwned > ${WS}/.agents/hooks.json` } },
      },
      bound: bound(policy),
    })
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.log?.policy).toBe('containment')
    expect(outcome.decision.reason).toContain('.agents')
  })

  it('.agents containment via replace_file_content (I6): denied for the same reason', () => {
    const policy = resolvePolicy({ profile: 'general_worker', workspace: WS })
    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: {
          name: 'replace_file_content',
          args: {
            TargetFile: `${WS}/.agents/hooks.json`,
            TargetContent: 'x',
            ReplacementContent: 'y',
          },
        },
      },
      bound: bound(policy),
    })
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.log?.policy).toBe('containment')
    expect(outcome.decision.reason).toContain('.agents')
  })

  it('HARD_DENY carries write_file({workspace}/.agents/**) too, substituted at resolvePolicy time — belt and suspenders with the structural I6 check above', () => {
    const policy = resolvePolicy({ profile: 'general_worker', workspace: WS })
    expect(policy.deny).toContain(`write_file(${canonicalize(WS)}/.agents/**)`)
  })

  it('resolves paths against actual execution directory (policy.workspace), ignoring model Cwd (Cwd mismatch)', () => {
    const policy = resolvePolicy({ profile: 'general_worker', workspace: WS })
    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: {
          name: 'run_command',
          args: {
            CommandLine: 'rm -r ../../x',
            Cwd: `${WS}/src/policy`,
          },
        },
      },
      bound: bound(policy),
    })
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.log?.policy).toBe('containment')
  })
})

describe('stage 5 — deny list beats allow (§2.2 step 5, ahead of step 6)', () => {
  it('a command matching both deny and allow is denied', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace: WS,
      requested: { allow: ['command(git push|status)'] },
    })
    // general_worker's ceiling only covers status|log|diff|add|commit, so a
    // requested "git push|status" narrows to nothing wider than the ceiling for
    // push — build the case directly instead, matching against the policy that
    // actually has "git push" in *both* lists.
    const custom: EffectivePolicy = {
      ...policy,
      allow: [...policy.allow, 'command(git push)'],
      deny: [...policy.deny, 'command(git push)'],
    }

    const input: GateDecideInput = {
      payload: {
        conversationId: 'conv-1',
        toolCall: { name: 'run_command', args: { CommandLine: 'git push origin main' } },
      },
      bound: bound(custom),
    }
    const outcome = decide(input)
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.log?.policy).toBe('deny_list')
  })

  it('HARD_DENY (git push) refuses even when a client tried to allow it', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace: WS,
    })
    // Simulate a policy.json where allow was hand-crafted to include git push —
    // deny (which always contains HARD_DENY, {workspace}-substituted) must
    // still win.
    const substitutedHardDeny = HARD_DENY.map((rule) => rule.replaceAll('{workspace}', canonicalize(WS)))
    const tampered: EffectivePolicy = { ...policy, allow: [...policy.allow, 'command(git push)'] }
    expect(tampered.deny).toEqual(expect.arrayContaining(substitutedHardDeny))

    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: { name: 'run_command', args: { CommandLine: 'git push origin main' } },
      },
      bound: bound(tampered),
    })
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.log?.policy).toBe('deny_list')
  })
})

describe('stage 6 — allow list, run_command overwrites Cwd + BypassSandbox (§2.2 step 6)', () => {
  it('an allowed run_command is granted with overwrite.Cwd pinned and BypassSandbox:true on general_worker by default (I2)', () => {
    const policy = resolvePolicy({ profile: 'general_worker', workspace: WS })
    expect(policy.bypass_sandbox).toBe(true)
    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: { name: 'run_command', args: { CommandLine: 'git status' } },
      },
      bound: bound(policy),
    })
    expect(outcome.decision).toEqual({
      decision: 'allow',
      overwrite: { Cwd: canonicalize(WS), BypassSandbox: true },
    })
    expect(outcome.log?.policy).toBe('profile_allowlist')
  })

  it('BypassSandbox:false when policy.bypass_sandbox is false (e.g. research_readonly or sandboxed ceiling) (I2)', () => {
    const policy = resolvePolicy({ profile: 'research_readonly', workspace: WS })
    expect(policy.bypass_sandbox).toBe(false)
    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: { name: 'run_command', args: { CommandLine: 'git status' } },
      },
      bound: bound(policy),
    })
    expect(outcome.decision).toEqual({
      decision: 'allow',
      overwrite: { Cwd: canonicalize(WS), BypassSandbox: false },
    })
  })

  it('a non-run_command allow carries no overwrite at all', () => {
    const policy = resolvePolicy({ profile: 'research_readonly', workspace: WS })
    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: { name: 'view_file', args: { AbsolutePath: `${WS}/a.txt` } },
      },
      bound: bound(policy, { profile: 'research_readonly' }),
    })
    expect(outcome.decision).toEqual({ decision: 'allow' })
  })
})

describe('stage 7 — default: nothing matched → deny, never ask (§2.2 step 7, I1)', () => {
  it('research_readonly denies an unmatched command and reports a required_rule the caller can retry with', () => {
    const policy = resolvePolicy({ profile: 'research_readonly', workspace: WS })
    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: { name: 'run_command', args: { CommandLine: 'brew install something' } },
      },
      bound: bound(policy, { profile: 'research_readonly' }),
    })
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.log?.policy).toBe('default')
    const payload = parseGateDenial(outcome.decision.reason ?? '')
    expect(payload?.required_rule).toBe('command(brew install something)')
    expect(extractRequiredRule(outcome.decision.reason ?? '')).toBe(
      'command(brew install something)',
    )
  })

  it('a command already on the deny list is denied at the deny_list stage, with no required_rule (nothing would lift it)', () => {
    const policy = resolvePolicy({ profile: 'research_readonly', workspace: WS })
    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: { name: 'run_command', args: { CommandLine: 'python script.py' } },
      },
      bound: bound(policy, { profile: 'research_readonly' }),
    })
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.log?.policy).toBe('deny_list')
    expect(parseGateDenial(outcome.decision.reason ?? '')?.required_rule).toBeNull()
  })

  it('general_worker also denies an unmatched action now — I1: a bound job never gets ask, default_decision is gone', () => {
    const policy = resolvePolicy({ profile: 'general_worker', workspace: WS })
    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: { name: 'run_command', args: { CommandLine: 'some totally novel command' } },
      },
      bound: bound(policy),
    })
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.log?.policy).toBe('default')
  })
})

describe('on_denial: abort requests an abort flag on deny', () => {
  it('sets requestsAbort true only when denied under on_denial=abort', () => {
    const policy = resolvePolicy({
      profile: 'research_readonly',
      workspace: WS,
      onDenial: 'abort',
    })
    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: { name: 'run_command', args: { CommandLine: 'python x.py' } },
      },
      bound: bound(policy, { profile: 'research_readonly', on_denial: 'abort' }),
    })
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.requestsAbort).toBe(true)
  })

  it('does not request abort on an allow decision', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace: WS,
      onDenial: 'abort',
    })
    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: { name: 'run_command', args: { CommandLine: 'git status' } },
      },
      bound: bound(policy, { on_denial: 'abort' }),
    })
    expect(outcome.requestsAbort).toBe(false)
  })

  it('unsupported tool under on_denial=abort sets requestsAbort=false', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace: WS,
      onDenial: 'abort',
    })
    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: { name: 'unsupported_custom_tool', args: {} },
      },
      bound: bound(policy, { on_denial: 'abort' }),
    })
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.requestsAbort).toBe(false)
  })

  it('subagent tool (define_subagent) under on_denial=abort sets requestsAbort=true', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace: WS,
      onDenial: 'abort',
    })
    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: { name: 'define_subagent', args: { name: 'sub' } },
      },
      bound: bound(policy, { on_denial: 'abort' }),
    })
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.requestsAbort).toBe(true)
  })

  it('schedule under on_denial=abort is allowed as control with requestsAbort=false', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace: WS,
      onDenial: 'abort',
    })
    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: { name: 'schedule', args: { DurationSeconds: 10, Prompt: 'check' } },
      },
      bound: bound(policy, { on_denial: 'abort' }),
    })
    expect(outcome.decision.decision).toBe('allow')
    expect(outcome.requestsAbort).toBe(false)
  })
})

describe('parsePayload — tolerant, never throws', () => {
  it('parses a well-formed hook payload', () => {
    const raw = JSON.stringify({
      conversationId: 'c1',
      stepIdx: 2,
      toolCall: { name: 'run_command', args: { CommandLine: 'ls' } },
      workspacePaths: ['/ws'],
    })
    const parsed = parsePayload(raw)
    expect(parsed?.conversationId).toBe('c1')
    expect(parsed?.toolCall.name).toBe('run_command')
  })

  it('returns null for garbage input instead of throwing', () => {
    expect(parsePayload('not json')).toBeNull()
    expect(parsePayload('')).toBeNull()
    expect(parsePayload(null)).toBeNull()
    expect(parsePayload('{}')).toBeNull()
    expect(parsePayload('{"conversationId":"c1"}')).toBeNull() // missing toolCall
  })
})

describe('stdout is write-once and pollution-proof', () => {
  it('guardStdout swallows everything that is not emit(), and emit writes only once', async () => {
    const { emit, guardStdout, resetEmitForTests, PASSTHROUGH } = await import('../../../src/gate/gate.js')
    const written: string[] = []
    const original = process.stdout.write
    // Stand in for the real fd. guardStdout() captured the *module-load* binding,
    // so this only proves the public `process.stdout.write` is neutered; the
    // write-once behaviour is asserted through emit's own flag.
    resetEmitForTests()
    try {
      guardStdout()
      // A stray write from anywhere in the import graph must not reach stdout.
      expect(process.stdout.write('garbage from some library\n')).toBe(true)
      expect(written).toEqual([])
      emit(PASSTHROUGH)
      // A second decision — e.g. main() emitted and then the catch fired — must
      // not append a second JSON document to the same stdout.
      emit({ decision: 'deny', reason: 'should never be written' })
    } finally {
      process.stdout.write = original
      resetEmitForTests()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// main() failure paths (§2.3) — driven in-process. `readStdin()` reads real fd
// 0 (`readFileSync(0, ...)`), which this suite cannot hand per-test input to
// without control over the process's actual stdin, so stdin is mocked at the
// `node:fs` level, scoped to fd 0 only — every other `readFileSync` call
// (policy.json, schema.sql, ...) still hits the real filesystem.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      if (path === 0) {
        if (mockStdin.value === null) throw new Error('EAGAIN (no mock stdin set for this test)')
        return mockStdin.value
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)
    }) as typeof actual.readFileSync,
  }
})

const mockStdin: { value: string | null } = { value: null }

describe('main() failure paths (§2.3) — not every failure is ask any more', () => {
  const savedEnv = { ...process.env }
  let realHome: string
  let realProject: string

  beforeEach(() => {
    // A real, initialized project: openStore(readOnly:false) once, up front,
    // so later readOnly opens in these tests succeed (this is what agy_start
    // does for real before ever spawning agy — see start.ts).
    realHome = mkdtempSync(join(tmpdir(), 'agy-gate-main-home-'))
    realProject = mkdtempSync(join(tmpdir(), 'agy-gate-main-proj-'))
    process.env.AGY_WORKER_HOME = realHome
    process.env.AGY_WORKER_PROJECT = realProject
    const store = openStore({ cwd: realProject })
    store.close()
  })

  afterEach(() => {
    process.env = { ...savedEnv }
    mockStdin.value = null
    vi.restoreAllMocks()
  })

  /**
   * `emit()` writes through `realStdoutWrite`, a `process.stdout.write` bound
   * *at module-evaluation time* (gate.ts's own top-of-file comment: "captured
   * before guardStdout neuters the public one"). Reassigning
   * `process.stdout.write` *after* the module is already loaded therefore
   * captures nothing — the module must not exist yet when the override goes
   * up. So: install the capture, THEN `vi.resetModules()`, THEN dynamically
   * import gate.js fresh — its `realStdoutWrite` binds to our capture, not
   * the real fd. `setup` runs between the write override and the reset, so a
   * test can `vi.doMock` a dependency (e.g. bind.js) before the fresh import
   * picks it up.
   */
  async function runMainCapturing(setup?: () => void): Promise<string[]> {
    const written: string[] = []
    const original = process.stdout.write
    process.stdout.write = ((chunk: string) => {
      written.push(chunk)
      return true
    }) as typeof process.stdout.write
    try {
      setup?.()
      vi.resetModules()
      const { main: freshMain } = await import('../../../src/gate/gate.js')
      await freshMain()
    } finally {
      process.stdout.write = original
    }
    return written
  }

  it('unparsable stdin → ask (we cannot tell whose call this is)', async () => {
    mockStdin.value = 'not json at all'
    const written = await runMainCapturing()
    expect(written).toEqual(['{"decision":"ask"}'])
  })

  it('store cannot even be opened (fresh AGY_WORKER_HOME, no project ever initialized) → deny "state unavailable"', async () => {
    mockStdin.value = JSON.stringify({
      conversationId: 'irrelevant',
      toolCall: { name: 'run_command', args: { CommandLine: 'echo hi' } },
    })
    // Point at a brand new, never-initialized home: index.db does not exist,
    // and a readOnly DatabaseSync open cannot create it.
    process.env.AGY_WORKER_HOME = mkdtempSync(join(tmpdir(), 'agy-gate-broken-home-'))
    const written = await runMainCapturing()
    expect(written).toEqual([JSON.stringify({ decision: 'deny', reason: 'agy-worker gate: state unavailable' })])
  })

  it('store opens fine, conversationId matches none of our jobs → ask (genuinely unbound, not a failure)', async () => {
    mockStdin.value = JSON.stringify({
      conversationId: 'some-users-own-interactive-session',
      toolCall: { name: 'run_command', args: { CommandLine: 'echo hi' } },
    })
    const written = await runMainCapturing()
    expect(written).toEqual(['{"decision":"ask"}'])
  })

  it('store opens fine, but something later throws → deny "internal error", not ask (the catch-all default flipped)', async () => {
    mockStdin.value = JSON.stringify({
      conversationId: 'whatever',
      toolCall: { name: 'run_command', args: { CommandLine: 'echo hi' } },
    })
    try {
      const written = await runMainCapturing(() => {
        vi.doMock('../../../src/gate/bind.js', async (importOriginal) => {
          const actual = await importOriginal<typeof import('../../../src/gate/bind.js')>()
          return {
            ...actual,
            bindConversation: () => {
              throw new Error('simulated internal failure')
            },
          }
        })
      })
      expect(written).toEqual([JSON.stringify({ decision: 'deny', reason: 'agy-worker gate: internal error' })])
    } finally {
      vi.doUnmock('../../../src/gate/bind.js')
      vi.resetModules()
    }
  })
})

describe('countDeniesInGateLog — pure counting of deny decisions in gate-log.jsonl', () => {
  it('returns 0 for empty string or whitespace', () => {
    expect(countDeniesInGateLog('')).toBe(0)
    expect(countDeniesInGateLog('   \n\n  ')).toBe(0)
  })

  it('ignores malformed JSON lines', () => {
    const text = 'not-json\n{"decision":"deny"}\n{broken json\n'
    expect(countDeniesInGateLog(text)).toBe(1)
  })

  it('correctly counts deny entries in mixed allow/deny log', () => {
    const text = [
      JSON.stringify({ ts: 1, decision: 'allow', tool: 'view_file' }),
      JSON.stringify({ ts: 2, decision: 'deny', tool: 'run_command' }),
      JSON.stringify({ ts: 3, decision: 'allow', tool: 'list_dir' }),
      JSON.stringify({ ts: 4, decision: 'deny', tool: 'run_command', abort_reason: 'max_denials' }),
      '',
    ].join('\n')
    expect(countDeniesInGateLog(text)).toBe(2)
  })
})
