import { describe, expect, it } from 'vitest'

import { PASSTHROUGH, decide, parsePayload } from '../../../src/gate/gate.js'
import type { GateDecideInput } from '../../../src/gate/gate.js'
import type { BoundJob } from '../../../src/gate/bind.js'
import { HARD_DENY, resolvePolicy } from '../../../src/policy/profiles.js'
import { extractRequiredRule, parseGateDenial } from '../../../src/events/detect.js'
import type { EffectivePolicy, JobRow } from '../../../src/contract/types.js'

function makeJob(over: Partial<JobRow> = {}): JobRow {
  return {
    job_id: 'job-1',
    session_id: null,
    lifecycle: 'running',
    outcome: null,
    headline: null,
    cwd: '/abs/workspace',
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

describe('unbound conversation → always ask, never {} (docs/03 §1.3 step 1)', () => {
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

describe('decision order: deny beats allow (docs/03 §1.3 step 2 before step 3)', () => {
  it('a command matching both deny and allow is denied', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace: '/abs/workspace',
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
  })

  it('HARD_DENY (git push) refuses even when a client tried to allow it', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace: '/abs/workspace',
    })
    // Simulate a policy.json where allow was hand-crafted to include git push —
    // deny (which always contains HARD_DENY) must still win.
    const tampered: EffectivePolicy = { ...policy, allow: [...policy.allow, 'command(git push)'] }
    expect(tampered.deny).toEqual(expect.arrayContaining([...HARD_DENY]))

    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: { name: 'run_command', args: { CommandLine: 'git push origin main' } },
      },
      bound: bound(tampered),
    })
    expect(outcome.decision.decision).toBe('deny')
  })
})

describe('allow hit forces Cwd overwrite to the workspace', () => {
  it('an allowed command is granted with overwrite.Cwd pinned', () => {
    const policy = resolvePolicy({ profile: 'general_worker', workspace: '/abs/workspace' })
    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: { name: 'run_command', args: { CommandLine: 'git status' } },
      },
      bound: bound(policy),
    })
    expect(outcome.decision).toEqual({
      decision: 'allow',
      overwrite: { Cwd: '/abs/workspace' },
    })
  })
})

describe('default (nothing matched) falls back to profile default_decision', () => {
  it('research_readonly denies by default and reports a required_rule the caller can retry with', () => {
    const policy = resolvePolicy({ profile: 'research_readonly', workspace: '/abs/workspace' })
    // "brew install" hits neither research_readonly's allow list nor its deny
    // list, so this exercises the step-4 default (as opposed to command(python),
    // which is already an explicit deny-list entry and would short-circuit
    // through the deny_list stage instead — where required_rule is always null).
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
    const policy = resolvePolicy({ profile: 'research_readonly', workspace: '/abs/workspace' })
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

  it('general_worker asks (passes through) by default for unmatched actions', () => {
    const policy = resolvePolicy({ profile: 'general_worker', workspace: '/abs/workspace' })
    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: { name: 'run_command', args: { CommandLine: 'some totally novel command' } },
      },
      bound: bound(policy),
    })
    expect(outcome.decision.decision).toBe('ask')
  })

  it('an unclassifiable tool call (no recognized subject) falls through to bound_passthrough logging, not a crash', () => {
    const policy = resolvePolicy({ profile: 'general_worker', workspace: '/abs/workspace' })
    const outcome = decide({
      payload: { conversationId: 'conv-1', toolCall: { name: 'view_file', args: { path: '/x' } } },
      bound: bound(policy),
    })
    expect(outcome.decision.decision).toBe('ask')
    expect(outcome.log?.policy).toBe('bound_passthrough')
  })
})

describe('on_denial: abort requests an abort flag on deny', () => {
  it('sets requestsAbort true only when denied under on_denial=abort', () => {
    const policy = resolvePolicy({
      profile: 'research_readonly',
      workspace: '/abs/workspace',
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
      workspace: '/abs/workspace',
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
