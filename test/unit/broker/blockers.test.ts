/**
 * Unit tests for `src/broker/blockers.ts`.
 *
 * Pins the conversion of low-level refusal and execution events (gate denials,
 * silent sandbox environment blocks, missing artifacts, and ceiling restrictions)
 * into uniform `Blocker` records. Verifies that `actionable`, `remedy`,
 * `blocks_outcome`, summarization, rendering, and policy descriptions remain
 * consistent across broker outcomes and CLI outputs.
 */
import { describe, expect, it } from 'vitest'

import {
  blockerFromDenial,
  blockerFromEnvironmentBlock,
  blockerFromGateMissing,
  blockerFromMissingArtifact,
  blockersFromGateLog,
  countActionable,
  describePolicy,
  hasOutcomeBlocker,
  isAgyEngineRefusal,
  policyCeilingBlockers,
  renderBlocker,
  renderBlockers,
  summarizeBlockers,
  ceilingAbsenceWarning,
} from '../../../src/broker/blockers.js'
import type {
  ArtifactCheck,
  Blocker,
  DenialClass1,
  DenialClass2,
  EffectivePolicy,
  GateLogEntry,
} from '../../../src/contract/types.js'

function makePolicy(overrides: Partial<EffectivePolicy> = {}): EffectivePolicy {
  return {
    profile: 'general_worker',
    workspace: '/test/workspace',
    read_roots: ['/test/workspace'],
    write_roots: ['/test/workspace'],
    allow: ['command(ls)'],
    deny: [],
    bypass_sandbox: true,
    sandbox_forced_by: null,
    add_dirs: [],
    add_dirs_source: 'none',
    command_policy: 'allowlist',
    policy_version: 3,
    ceiling_present: true,
    ceiling_path: null,
    on_denial: 'continue',
    max_denials: null,
    rejected_allow: [],
    lifted: [],
    sandbox: 'none',
    sandbox_source: 'default',
    seatbelt_write_roots: [],
    rejected_read_roots: [],
    ...overrides,
  }
}

describe('isAgyEngineRefusal', () => {
  it('returns true when message contains "user denied permission to run command"', () => {
    expect(
      isAgyEngineRefusal(
        'permission check failed: user denied permission to run command:\nls -la /tmp',
      ),
    ).toBe(true)
  })

  it('returns true when message contains "permission check failed for unsandboxed"', () => {
    expect(
      isAgyEngineRefusal(
        'permission check failed for unsandboxed "curl https://example.com"',
      ),
    ).toBe(true)
  })

  it('returns false for gate hook refusal messages', () => {
    expect(
      isAgyEngineRefusal(
        'tool call denied by pre-tool hook: this action is not permitted by profile',
      ),
    ).toBe(false)
  })

  it('returns false for generic command errors', () => {
    expect(
      isAgyEngineRefusal(
        'Command failed with exit code 1: file not found',
      ),
    ).toBe(false)
  })
})

describe('blockerFromDenial', () => {
  it('gate denial with policy "default" produces actionable: true, blocks_outcome: true, and remedy with required_rule', () => {
    const d: DenialClass1 = {
      class: 1,
      source: 'gate',
      tool: 'run_command',
      command: 'git status',
      required_rule: 'command(git status)',
      policy: 'default',
      message: 'not permitted by current rules',
      step_idx: 1,
    }
    const b = blockerFromDenial(d)
    expect(b.source).toBe('gate')
    expect(b.actionable).toBe(true)
    expect(b.remedy).toBe('command(git status)')
    expect(b.blocks_outcome).toBe(true)
    expect(b.tool).toBe('run_command')
    expect(b.command).toBe('git status')
    expect(b.message).toContain('command(git status)')
  })

  it('gate denial with policy "default" without required_rule produces actionable: true and remedy: null', () => {
    const d: DenialClass1 = {
      class: 1,
      source: 'gate',
      tool: 'view_file',
      command: null,
      required_rule: null,
      policy: 'default',
      message: 'operation not allowed',
      step_idx: 2,
    }
    const b = blockerFromDenial(d)
    expect(b.source).toBe('gate')
    expect(b.actionable).toBe(true)
    expect(b.remedy).toBeNull()
    expect(b.blocks_outcome).toBe(true)
  })

  it('gate denial with policy "containment" produces actionable: false, remedy: null, and blocks_outcome: true', () => {
    const d: DenialClass1 = {
      class: 1,
      source: 'gate',
      tool: 'write_to_file',
      command: null,
      required_rule: null,
      policy: 'containment',
      message: 'path outside workspace',
      step_idx: 3,
    }
    const b = blockerFromDenial(d)
    expect(b.source).toBe('gate')
    expect(b.actionable).toBe(false)
    expect(b.remedy).toBeNull()
    expect(b.blocks_outcome).toBe(true)
    expect(b.message).toContain('containment is checked before any rule')
  })

  it('gate denial with policy "unsupported" produces actionable: false, remedy: null, and blocks_outcome: true', () => {
    const d: DenialClass1 = {
      class: 1,
      source: 'gate',
      tool: 'unknown_agent_tool',
      command: null,
      required_rule: null,
      policy: 'unsupported',
      message: 'tool is not supported',
      step_idx: 4,
    }
    const b = blockerFromDenial(d)
    expect(b.source).toBe('gate')
    expect(b.actionable).toBe(false)
    expect(b.remedy).toBeNull()
    expect(b.blocks_outcome).toBe(true)
    expect(b.message).toContain('unsupported, checked before any rule list')
  })

  // BUG (src/broker/blockers.ts): DenialClass1 doc in types.ts states that deny_list
  // refusals cannot be granted by any rule and must be non-actionable, but blockerFromDenial
  // does not check for policy === 'deny_list', falling through to actionable: true.
  it.fails('gate denial with policy "deny_list" produces actionable: false and remedy: null', () => {
    const d: DenialClass1 = {
      class: 1,
      source: 'gate',
      tool: 'run_command',
      command: 'rm -rf /',
      required_rule: null,
      policy: 'deny_list',
      message: 'command denied by deny_list',
      step_idx: 5,
    }
    const b = blockerFromDenial(d)
    expect(b.actionable).toBe(false)
    expect(b.remedy).toBeNull()
  })

  it('non-gate refusal matching agy engine signature produces source: "agy_engine", actionable: false, blocks_outcome: false', () => {
    const d: DenialClass1 = {
      class: 1,
      source: 'unknown',
      tool: 'run_command',
      command: 'ls',
      required_rule: null,
      policy: null,
      message: 'user denied permission to run command: ls',
      step_idx: 6,
    }
    const b = blockerFromDenial(d)
    expect(b.source).toBe('agy_engine')
    expect(b.actionable).toBe(false)
    expect(b.remedy).toBeNull()
    expect(b.blocks_outcome).toBe(false)
  })

  it('non-gate refusal with generic error produces source: "tool_error", actionable: false, blocks_outcome: false', () => {
    const d: DenialClass1 = {
      class: 1,
      source: 'unknown',
      tool: 'run_command',
      command: 'node broken.js',
      required_rule: null,
      policy: null,
      message: 'ReferenceError: foo is not defined',
      step_idx: 7,
    }
    const b = blockerFromDenial(d)
    expect(b.source).toBe('tool_error')
    expect(b.actionable).toBe(false)
    expect(b.remedy).toBeNull()
    expect(b.blocks_outcome).toBe(false)
  })
})

describe('blockerFromEnvironmentBlock', () => {
  const d2: DenialClass2 = {
    class: 2,
    tool: 'run_command',
    command: 'curl https://example.com',
    signature: 'Could not resolve host',
    excerpt: 'curl: (6) Could not resolve host',
    step_idx: 1,
  }

  it('when sandbox_forced_by is "request", produces actionable: true with retry remedy', () => {
    const policy = makePolicy({ sandbox_forced_by: 'request', bypass_sandbox: false })
    const b = blockerFromEnvironmentBlock(d2, policy)
    expect(b.source).toBe('sandbox')
    expect(b.actionable).toBe(true)
    expect(b.blocks_outcome).toBe(true)
    expect(b.remedy).toContain('retry without permissions.sandboxed')
  })

  it('when sandbox_forced_by is "profile", produces actionable: true with general_worker remedy', () => {
    const policy = makePolicy({ sandbox_forced_by: 'profile', bypass_sandbox: false })
    const b = blockerFromEnvironmentBlock(d2, policy)
    expect(b.source).toBe('sandbox')
    expect(b.actionable).toBe(true)
    expect(b.blocks_outcome).toBe(true)
    expect(b.remedy).toContain('start the job with profile "general_worker"')
  })

  it('when policy profile is "research_readonly" and sandbox_forced_by is null, treats reason as "profile"', () => {
    const policy = makePolicy({
      profile: 'research_readonly',
      sandbox_forced_by: null,
      bypass_sandbox: false,
    })
    const b = blockerFromEnvironmentBlock(d2, policy)
    expect(b.source).toBe('sandbox')
    expect(b.actionable).toBe(true)
    expect(b.blocks_outcome).toBe(true)
    expect(b.remedy).toContain('start the job with profile "general_worker"')
  })

  it('when sandbox_forced_by is "ceiling", produces actionable: false and ceiling human remedy', () => {
    const policy = makePolicy({ sandbox_forced_by: 'ceiling', bypass_sandbox: false })
    const b = blockerFromEnvironmentBlock(d2, policy)
    expect(b.source).toBe('sandbox')
    expect(b.actionable).toBe(false)
    expect(b.blocks_outcome).toBe(true)
    expect(b.remedy).toContain('a human must set "sandbox": "none" (or "seatbelt") in the project ceiling')
  })

  it('when policy is null or undefined, defaults to actionable: false with ceiling remedy', () => {
    const b = blockerFromEnvironmentBlock(d2, null)
    expect(b.source).toBe('sandbox')
    expect(b.actionable).toBe(false)
    expect(b.blocks_outcome).toBe(true)
    expect(b.remedy).toContain('a human must set "sandbox": "none" (or "seatbelt") in the project ceiling')
  })

  // BUG (src/broker/blockers.ts): Spec notes that when policy.bypass_sandbox is true,
  // environment blocks are warning-level with blocks_outcome: false. Currently blockers.ts
  // unconditionally hardcodes blocks_outcome: true (delegating filtering to verify.ts).
  it.fails('when policy.bypass_sandbox is true, produces blocks_outcome: false', () => {
    const policy = makePolicy({ bypass_sandbox: true, sandbox_forced_by: null })
    const b = blockerFromEnvironmentBlock(d2, policy)
    expect(b.blocks_outcome).toBe(false)
  })
})

describe('blockerFromGateMissing', () => {
  it('produces non-actionable broker blocker with blocks_outcome: true', () => {
    const b = blockerFromGateMissing()
    expect(b.source).toBe('broker')
    expect(b.actionable).toBe(false)
    expect(b.remedy).toBeNull()
    expect(b.blocks_outcome).toBe(true)
    expect(b.tool).toBeNull()
    expect(b.command).toBeNull()
    expect(b.message).toBe('gate hook never fired; hooks.json was not loaded')
  })
})

describe('blockerFromMissingArtifact', () => {
  it('produces actionable broker blocker with remedy pointing to missing artifact', () => {
    const artifact: ArtifactCheck = {
      path: 'build/output.json',
      absolute: '/test/workspace/build/output.json',
      exists: false,
      size: null,
    }
    const b = blockerFromMissingArtifact(artifact)
    expect(b.source).toBe('broker')
    expect(b.actionable).toBe(true)
    expect(b.remedy).toBe('have the job create build/output.json, or drop it from expected_artifacts')
    expect(b.blocks_outcome).toBe(true)
    expect(b.tool).toBeNull()
    expect(b.command).toBeNull()
    expect(b.message).toBe('expected artifact missing: build/output.json (/test/workspace/build/output.json)')
    expect(b.detail).toEqual(artifact)
  })
})

describe('policyCeilingBlockers', () => {
  it('1 rejected_allow produces 1 actionable blocker with blocks_outcome: false', () => {
    const policy = makePolicy({
      allow: ['command(ls)'],
      rejected_allow: ['command(rm)'],
    })
    const blockers = policyCeilingBlockers(policy)
    expect(blockers).toHaveLength(1)
    expect(blockers[0]?.source).toBe('policy_ceiling')
    expect(blockers[0]?.actionable).toBe(true)
    expect(blockers[0]?.blocks_outcome).toBe(false)
    expect(blockers[0]?.remedy).toContain('drop command(rm) from permissions.allow')
    expect(blockers[0]?.detail).toEqual({ rule: 'command(rm)', profile: 'general_worker' })
  })

  it('empty allow produces a collapse trap blocker', () => {
    const policy = makePolicy({
      allow: [],
      rejected_allow: [],
    })
    const blockers = policyCeilingBlockers(policy)
    expect(blockers).toHaveLength(1)
    expect(blockers[0]?.source).toBe('policy_ceiling')
    expect(blockers[0]?.actionable).toBe(true)
    expect(blockers[0]?.blocks_outcome).toBe(false)
    expect(blockers[0]?.message).toContain('the effective allow list is empty')
    expect(blockers[0]?.remedy).toContain('start again with no permissions.allow at all')
  })

  it('rejected_allow and empty allow produces 2 blockers (rejection + collapse trap)', () => {
    const policy = makePolicy({
      allow: [],
      rejected_allow: ['command(rm)'],
    })
    const blockers = policyCeilingBlockers(policy)
    expect(blockers).toHaveLength(2)
    expect(blockers[0]?.detail).toEqual({ rule: 'command(rm)', profile: 'general_worker' })
    expect(blockers[1]?.message).toContain('the effective allow list is empty')
  })

  it('rejected_read_roots produces actionable blocker with project ceiling guidance', () => {
    const policy = makePolicy({
      allow: ['command(ls)'],
      rejected_read_roots: ['/outside/path'],
    })
    const blockers = policyCeilingBlockers(policy)
    expect(blockers).toHaveLength(1)
    expect(blockers[0]?.source).toBe('policy_ceiling')
    expect(blockers[0]?.actionable).toBe(true)
    expect(blockers[0]?.blocks_outcome).toBe(false)
    expect(blockers[0]?.remedy).toContain('add a glob covering /outside/path')
  })
})

describe('renderBlocker, renderBlockers, summarizeBlockers, countActionable, hasOutcomeBlocker', () => {
  const b1: Blocker = {
    source: 'gate',
    actionable: true,
    remedy: 'command(git status)',
    blocks_outcome: true,
    tool: 'run_command',
    command: 'git status',
    message: 'refused by gate',
  }

  const b2: Blocker = {
    source: 'gate',
    actionable: false,
    remedy: null,
    blocks_outcome: true,
    tool: 'run_command',
    command: 'rm',
    message: 'refused containment',
  }

  const b3: Blocker = {
    source: 'policy_ceiling',
    actionable: true,
    remedy: 'drop rule',
    blocks_outcome: false,
    tool: null,
    command: null,
    message: 'ceiling dropped rule',
  }

  it('renderBlocker formats actionable blocker with tool, command, and remedy', () => {
    const line = renderBlocker(b1)
    expect(line).toBe(
      'gate denial [run_command: git status]: refused by gate — remedy: command(git status)',
    )
  })

  it('renderBlocker formats non-actionable blocker with not actionable suffix', () => {
    const line = renderBlocker(b2)
    expect(line).toBe(
      'gate denial [run_command: rm]: refused containment — not actionable: no permissions.allow rule will change this.',
    )
  })

  it('renderBlocker without tool/command omits brackets', () => {
    const line = renderBlocker(b3)
    expect(line).toBe('ceiling rejection: ceiling dropped rule — remedy: drop rule')
  })

  it('renderBlockers maps over blockers list', () => {
    const lines = renderBlockers([b1, b3])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('gate denial')
    expect(lines[1]).toContain('ceiling rejection')
  })

  it('summarizeBlockers aggregates by source in appearance order and indicates actionable', () => {
    expect(summarizeBlockers([b1, b2, b3])).toBe('2 gate denials (actionable), 1 ceiling rejection (actionable)')
    expect(summarizeBlockers([b2])).toBe('1 gate denial')
    expect(summarizeBlockers([])).toBe('')
  })

  it('countActionable counts only actionable blockers', () => {
    expect(countActionable([b1, b2, b3])).toBe(2)
    expect(countActionable([b2])).toBe(0)
    expect(countActionable([])).toBe(0)
  })

  it('hasOutcomeBlocker returns true only if at least one blocker blocks outcome', () => {
    expect(hasOutcomeBlocker([b1])).toBe(true)
    expect(hasOutcomeBlocker([b3])).toBe(false)
    expect(hasOutcomeBlocker([b2, b3])).toBe(true)
    expect(hasOutcomeBlocker([])).toBe(false)
  })
})

describe('describePolicy', () => {
  it('returns policy_summary, blockers, and merges policy.warnings into warnings', () => {
    const policy = makePolicy({
      profile: 'general_worker',
      allow: ['command(git status)'],
      bypass_sandbox: true,
      sandbox_forced_by: null,
      sandbox: 'none',
      sandbox_source: 'default',
      add_dirs: ['/extra/dir'],
      add_dirs_source: 'ceiling',
      rejected_allow: ['command(rm)'],
      warnings: ['custom policy warning from resolver'],
    })

    const desc = describePolicy(policy)

    expect(desc.policy_summary).toEqual({
      profile: 'general_worker',
      allow_count: 1,
      bypass_sandbox: true,
      sandbox_forced_by: null,
      sandbox: 'none',
      sandbox_source: 'default',
      add_dirs: ['/extra/dir'],
      add_dirs_source: 'ceiling',
    })

    expect(desc.blockers).toHaveLength(1)
    expect(desc.blockers[0]?.source).toBe('policy_ceiling')

    expect(desc.warnings).toHaveLength(2)
    expect(desc.warnings[0]).toContain('ceiling rejection')
    expect(desc.warnings[1]).toBe('custom policy warning from resolver')
  })

  it('handles policy without warnings property', () => {
    const policy = makePolicy({
      allow: ['command(ls)'],
      rejected_allow: [],
      warnings: undefined,
    })

    const desc = describePolicy(policy)
    expect(desc.blockers).toHaveLength(0)
    expect(desc.warnings).toEqual([])
  })
})

describe('blockersFromGateLog', () => {
  it('returns empty array when gate log has no abort_reason: "max_denials"', () => {
    const text = [
      JSON.stringify({ ts: 1, decision: 'allow', tool: 'view_file' }),
      JSON.stringify({ ts: 2, decision: 'deny', tool: 'run_command' }),
    ].join('\n')
    expect(blockersFromGateLog(text)).toEqual([])
  })

  it('a gate log with an abort_reason: "max_denials" entry yields the extra blocker', () => {
    const text = [
      JSON.stringify({ ts: 1, decision: 'deny', tool: 'run_command' }),
      JSON.stringify({ ts: 2, decision: 'deny', tool: 'run_command' }),
      JSON.stringify({ ts: 3, decision: 'deny', tool: 'run_command', abort_reason: 'max_denials' }),
    ].join('\n')
    const blockers = blockersFromGateLog(text)
    expect(blockers).toHaveLength(1)
    const b = blockers[0]!
    expect(b.source).toBe('gate')
    expect(b.actionable).toBe(true)
    expect(b.remedy).toBe('raise max_denials or fix the prompt so the job stops retrying denied actions')
    expect(b.blocks_outcome).toBe(true)
    expect(b.message).toBe('job aborted after 3 gate denials (max_denials)')
  })

  it('tolerates GateLogEntry array directly', () => {
    const entries: GateLogEntry[] = [
      {
        ts: 1,
        job_id: 'j1',
        conversation_id: 'c1',
        step_idx: 1,
        tool: 'run_command',
        command: 'ls',
        decision: 'deny',
        policy: 'default',
        matched_rule: null,
        reason: 'denied',
        abort_reason: 'max_denials',
      },
    ]
    const blockers = blockersFromGateLog(entries)
    expect(blockers).toHaveLength(1)
    expect(blockers[0]?.message).toBe('job aborted after 1 gate denials (max_denials)')
  })
})


describe('ceilingAbsenceWarning — the "no project ceiling" line on a finished job', () => {
  const ruleBlocker: Blocker = {
    source: 'gate',
    actionable: true,
    remedy: 'command(cargo build)',
    blocks_outcome: true,
    tool: 'run_command',
    command: 'cargo build',
    message: 'our permission gate refused this',
    detail: {},
  }

  it('fires once when the policy recorded no ceiling and a gate blocker names a rule', () => {
    const policy = makePolicy({ ceiling_present: false, ceiling_path: '/home/u/.agy-worker/projects/abc/policy.json' })
    const hint = ceilingAbsenceWarning(policy, [ruleBlocker])
    expect(hint).not.toBeNull()
    expect(hint).toContain('no project ceiling at /home/u/.agy-worker/projects/abc/policy.json')
    expect(hint).toContain('agy_ceiling')
    expect(hint).toContain('/agy-ceiling')
  })

  it('stays quiet when a ceiling file exists, when the job file predates the field, or without a policy', () => {
    expect(ceilingAbsenceWarning(makePolicy({ ceiling_present: true }), [ruleBlocker])).toBeNull()
    expect(ceilingAbsenceWarning(makePolicy(), [ruleBlocker])).toBeNull()
    expect(ceilingAbsenceWarning(null, [ruleBlocker])).toBeNull()
  })

  it('stays quiet when nothing a ceiling could open was refused', () => {
    const policy = makePolicy({ ceiling_present: false, ceiling_path: '/p/policy.json' })
    expect(ceilingAbsenceWarning(policy, [])).toBeNull()
    expect(ceilingAbsenceWarning(policy, [{ ...ruleBlocker, remedy: null, actionable: false }])).toBeNull()
    expect(ceilingAbsenceWarning(policy, [{ ...ruleBlocker, source: 'sandbox', remedy: 'retry without permissions.sandbox' }])).toBeNull()
    expect(
      ceilingAbsenceWarning(policy, [{ ...ruleBlocker, remedy: 'raise max_denials or fix the prompt so the job stops retrying denied actions' }]),
    ).toBeNull()
  })
})
