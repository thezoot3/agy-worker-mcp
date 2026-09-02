/**
 * `Blocker` — the one vocabulary every judgement surface projects.
 *
 * The regression it exists for: a real job came back with
 * `counts.permission_denials: 1` next to `outcome: "success_unverified"`,
 * because the packet counted every Class 1 event while `decideOutcome` counted
 * only the ones our gate authored. Both now read `verification.blockers`, so
 * the two can no longer disagree — and each entry says who refused
 * (`source`), whether the caller can lift it (`actionable`), and what to change
 * (`remedy`).
 */
import { afterEach, describe, expect, it } from 'vitest'

import { buildBrokerResult, migrateBrokerResult, projectJudgementPacket } from '../../../src/broker/result.js'
import { HOOK_DENIAL_PREFIX } from '../../../src/contract/types.js'
import type { AgyEvent, Blocker, BrokerResult } from '../../../src/contract/types.js'
import { makeTestStore, newTestJob, type TestStoreHandle } from '../helpers/store.js'

/** Verbatim shape of the refusal measured in the field (see AGY_ENGINE_REFUSAL_SIGNATURES). */
const AGY_ENGINE_MESSAGE =
  'permission check failed for unsandboxed "ls -la /Users/someone/.jdks/": user denied permission to run command:\nls -la /Users/someone/.jdks/'

function toolErrorEvent(stepIndex: number, command: string, message: string): AgyEvent {
  return {
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-1',
      step_index: stepIndex,
      state: 'ERROR',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: {
        name: 'run_command',
        parameters: { CommandLine: command },
        error: { type: 'TOOL_ERROR', message },
      },
    },
  }
}

/** A successful tool step whose *output* carries a Class 2 signature. */
function environmentBlockEvent(stepIndex: number, command: string, output: string): AgyEvent {
  return {
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-1',
      step_index: stepIndex,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: command }, output },
    },
  }
}

/** agy reports SUCCESS / exit 0 in every case here — that is the whole point. */
function resultEvent(): AgyEvent {
  return {
    event: 'result',
    result: {
      conversation_id: 'conv-1',
      status: 'SUCCESS',
      response: 'done',
      duration_seconds: 1,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  }
}

let handle: TestStoreHandle | null = null

afterEach(() => {
  handle?.cleanup()
  handle = null
})

function judge(events: AgyEvent[]): {
  packet: ReturnType<typeof projectJudgementPacket>
  blockers: Blocker[]
  warnings: string[]
} {
  handle = makeTestStore()
  const job = newTestJob(handle.store, { cwd: handle.workspace })
  const result = buildBrokerResult(handle.store, {
    job,
    events,
    malformedLines: 0,
    exitCode: 0,
    timedOut: false,
    canceled: false,
    runnerLost: false,
    pidReused: false,
    expectedArtifacts: [],
    jsonSchemaPath: null,
    idleClosedAfterMs: null,
    now: Date.now(),
  })
  return {
    packet: projectJudgementPacket(result),
    blockers: result.verification.blockers,
    warnings: result.verification.warnings,
  }
}

const GATE_DENIAL = toolErrorEvent(
  1,
  'pip install requests',
  `${HOOK_DENIAL_PREFIX} denied by policy (required rule: command(pip install requests))`,
)

describe('a confirmed gate denial', () => {
  it('is actionable, carries required_rule as its remedy, and forces outcome "blocked"', () => {
    const { packet, blockers } = judge([GATE_DENIAL, resultEvent()])

    expect(blockers).toHaveLength(1)
    const b = blockers[0]!
    expect(b.source).toBe('gate')
    expect(b.actionable).toBe(true)
    expect(b.remedy).toBe('command(pip install requests)')
    expect(b.blocks_outcome).toBe(true)
    // Nothing from the original Class 1 record is lost.
    expect(b.detail).toMatchObject({ class: 1, source: 'gate', step_idx: 1 })

    expect(packet.outcome).toBe('blocked')
    expect(packet.counts).toMatchObject({ blockers: 1, actionable: 1, tool_errors: 1 })
    expect(packet.headline).toContain('1 gate denial (actionable)')
  })
})

describe("a refusal by agy's own permission engine", () => {
  it('is reported, is not actionable, and never turns a success into "blocked"', () => {
    const { packet, blockers, warnings } = judge([
      toolErrorEvent(1, 'ls -la /Users/someone/.jdks/', AGY_ENGINE_MESSAGE),
      resultEvent(),
    ])

    expect(blockers).toHaveLength(1)
    const b = blockers[0]!
    expect(b.source).toBe('agy_engine')
    expect(b.actionable).toBe(false)
    expect(b.remedy).toBeNull()
    expect(b.blocks_outcome).toBe(false)
    // The measured message is passed through verbatim, not paraphrased.
    expect(b.message).toContain('user denied permission to run command')

    expect(packet.outcome).toBe('success_unverified')
    expect(packet.counts).toMatchObject({ blockers: 1, actionable: 0 })
    // Success is not overturned, but the headline must not stay silent either.
    expect(packet.headline).toContain('non-blocking: 1 agy-engine refusal')
    expect(warnings.some((w) => w.includes('not actionable'))).toBe(true)
  })
})

describe('an ordinary failing tool call', () => {
  it('claims no permission problem at all and does not block the outcome', () => {
    const { packet, blockers, warnings } = judge([
      toolErrorEvent(1, 'python -m pytest', 'collected 1 item\n\n1 failed'),
      resultEvent(),
    ])

    expect(blockers[0]!.source).toBe('tool_error')
    expect(blockers[0]!.blocks_outcome).toBe(false)
    expect(packet.outcome).toBe('success_unverified')
    expect(warnings.some((w) => w.includes('permission engine refused'))).toBe(false)
  })
})

describe('a silent sandbox block', () => {
  it('is a sandbox blocker that does force "blocked", and a network one is actionable', () => {
    const { packet, blockers } = judge([
      environmentBlockEvent(1, 'curl https://example.com', 'curl: (6) Could not resolve host: example.com'),
      resultEvent(),
    ])

    const b = blockers[0]!
    expect(b.source).toBe('sandbox')
    expect(b.blocks_outcome).toBe(true)
    expect(b.actionable).toBe(true)
    expect(b.remedy).toContain('permissions.network')
    expect(b.detail).toMatchObject({ class: 2, signature: 'Could not resolve host' })

    expect(packet.outcome).toBe('blocked')
    expect(packet.headline).toContain('1 sandbox block (actionable)')
  })

  it('a non-network signature is a block we cannot lift at all', () => {
    const { blockers } = judge([
      environmentBlockEvent(1, 'touch /etc/x', 'touch: /etc/x: Operation not permitted'),
      resultEvent(),
    ])

    expect(blockers[0]!.source).toBe('sandbox')
    expect(blockers[0]!.blocks_outcome).toBe(true)
    expect(blockers[0]!.actionable).toBe(false)
    expect(blockers[0]!.remedy).toBeNull()
  })
})

describe('the packet invariant', () => {
  it('outcome "blocked" ⟺ some blocker blocks_outcome, for a job that ran to a conclusion', () => {
    for (const events of [
      [GATE_DENIAL, resultEvent()],
      [toolErrorEvent(1, 'ls /x', AGY_ENGINE_MESSAGE), resultEvent()],
      [environmentBlockEvent(1, 'curl x', 'Could not resolve host'), resultEvent()],
      [resultEvent()],
    ]) {
      const { packet, blockers } = judge(events)
      expect(packet.outcome === 'blocked').toBe(blockers.some((b) => b.blocks_outcome))
      expect(packet.counts.blockers).toBe(blockers.length)
      handle?.cleanup()
      handle = null
    }
  })
})

describe('a broker-result.json written by 0.1.0', () => {
  it('is migrated to blockers on read instead of crashing the tool call', () => {
    // Only the fields the migration touches; the rest is carried through.
    const legacy = {
      schema_version: 1,
      job_id: 'old-job',
      verification: {
        permission_denials: [
          {
            class: 1,
            tool: 'run_command',
            command: 'git push',
            required_rule: 'command(git push)',
            policy: 'deny_list',
            source: 'gate',
            message: 'tool call denied by pre-tool hook: nope',
            step_idx: 2,
          },
        ],
        environment_blocks: [
          {
            class: 2,
            tool: 'run_command',
            command: 'curl x',
            signature: 'Could not resolve host',
            excerpt: 'curl: Could not resolve host',
            step_idx: 4,
          },
        ],
        expected_artifacts: [{ path: 'out.txt', absolute: '/ws/out.txt', exists: false, size: null }],
        changed_files: [],
        warnings: ['permission denied: run_command (git push)'],
        contract_status: 'not_required',
        checked_at: 1,
      },
    } as unknown as BrokerResult

    const migrated = migrateBrokerResult(legacy, '/tmp/broker-result.json')

    expect(migrated.schema_version).toBe(2)
    expect(migrated.job_id).toBe('old-job')
    expect(migrated.verification.blockers.map((b) => b.source)).toEqual(['gate', 'sandbox', 'broker'])
    // Nothing the old lists carried is dropped.
    expect(migrated.verification.blockers[0]!.detail).toMatchObject({ required_rule: 'command(git push)' })
    expect(migrated.verification.expected_artifacts).toHaveLength(1)
  })

  it('refuses a version it does not know how to read, rather than half-typing it', () => {
    const future = { schema_version: 99, verification: {} } as unknown as BrokerResult
    expect(() => migrateBrokerResult(future, '/tmp/broker-result.json')).toThrow(/schema_version/)
  })
})
