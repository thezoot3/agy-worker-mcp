import { describe, expect, it } from 'vitest'

import {
  detectClass1,
  detectClass2,
  extractRequiredRule,
  matchEnvironmentSignature,
  parseGateDenial,
  scanDenials,
} from '../../../src/events/detect.js'
import { GATE_DENIAL_MARKER, HOOK_DENIAL_PREFIX } from '../../../src/contract/types.js'
import type { AgyEvent, AgyStepUpdateEvent, GateDenialPayload } from '../../../src/contract/types.js'

function toolStep(over: Partial<AgyStepUpdateEvent['step_update']>): AgyStepUpdateEvent {
  return {
    event: 'step_update',
    step_update: {
      conversation_id: 'c1',
      step_index: 4,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'run_command',
      ...over,
    },
  }
}

describe('detectClass1 — structured refusal', () => {
  it('is null for a normal, non-error tool step', () => {
    const step = toolStep({ state: 'DONE', tool_info: { name: 'run_command', output: 'ok\n' } })
    expect(detectClass1(step)).toBeNull()
  })

  it('is null for an ERROR on a non-tool step', () => {
    const step: AgyStepUpdateEvent = {
      event: 'step_update',
      step_update: {
        conversation_id: 'c1',
        step_index: 1,
        state: 'ERROR',
        step_type: 'agent_response',
      },
    }
    expect(detectClass1(step)).toBeNull()
  })

  it('fires on step_type=tool && state=ERROR and extracts a gate-authored required_rule', () => {
    const payload: GateDenialPayload = {
      job_id: 'job-1',
      tool: 'run_command',
      required_rule: 'command(git push)',
      policy: 'deny_list',
      on_denial: 'continue',
    }
    const message = `${HOOK_DENIAL_PREFIX} blocked. [${GATE_DENIAL_MARKER}${JSON.stringify(payload)}]`
    const step = toolStep({
      state: 'ERROR',
      tool_info: {
        name: 'run_command',
        parameters: { CommandLine: 'git push origin main' },
        error: { type: 'TOOL_ERROR', message },
      },
    })

    const c1 = detectClass1(step)
    expect(c1).not.toBeNull()
    expect(c1?.class).toBe(1)
    expect(c1?.tool).toBe('run_command')
    expect(c1?.command).toBe('git push origin main')
    expect(c1?.source).toBe('gate')
    expect(c1?.required_rule).toBe('command(git push)')
    expect(c1?.step_idx).toBe(4)
  })

  it('classifies a non-gate tool error as source "agy"', () => {
    const step = toolStep({
      state: 'ERROR',
      tool_info: { name: 'run_command', error: { type: 'TOOL_ERROR', message: 'boom' } },
    })
    const c1 = detectClass1(step)
    expect(c1?.source).toBe('agy')
    expect(c1?.required_rule).toBeNull()
  })

  it('exit code 0 / status SUCCESS at the process level does not hide a Class 1 event in the stream', () => {
    // The whole point of §9: a denial never shows up as a non-zero exit or an
    // ERROR result — only this step-level signal reveals it.
    const events: AgyEvent[] = [
      { event: 'init', conversation_id: 'c1', init: { model: 'm', cwd: '/ws', permission_mode: 'p', tools: [] } },
      toolStep({
        state: 'ERROR',
        tool_info: { name: 'run_command', error: { type: 'TOOL_ERROR', message: `${HOOK_DENIAL_PREFIX} nope` } },
      }),
      { event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'done', duration_seconds: 1, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]
    const scan = scanDenials(events)
    expect(scan.permission_denials).toHaveLength(1)
  })
})

describe('detectClass2 — silent environment block', () => {
  it('is null when the output has no known signature', () => {
    const step = toolStep({ state: 'DONE', tool_info: { name: 'run_command', output: 'all good\n' } })
    expect(detectClass2(step)).toBeNull()
  })

  it('fires on a DONE tool step whose output matches a known block signature, with no error event at all', () => {
    const step = toolStep({
      state: 'DONE',
      tool_info: {
        name: 'run_command',
        parameters: { CommandLine: 'curl -sS https://example.com' },
        output: 'curl: (6) Could not resolve host: example.com\n',
      },
    })
    const c2 = detectClass2(step)
    expect(c2).not.toBeNull()
    expect(c2?.class).toBe(2)
    expect(c2?.signature).toBe('Could not resolve host')
    expect(c2?.command).toBe('curl -sS https://example.com')
    expect(c2?.excerpt).toContain('Could not resolve host')
  })

  it.each([
    'Temporary failure in name resolution',
    'Connection refused',
    'Operation not permitted',
    'Read-only file system',
    'EACCES',
  ])('recognizes signature %s', (sig) => {
    expect(matchEnvironmentSignature(`some prefix ${sig} some suffix`)).toBe(sig)
  })

  // KNOWN BUG (see blockers): detectClass2 never checks `state` at all, so an
  // ACTIVE (still-running) step whose partial output happens to contain a
  // signature substring fires just like a finished DONE step would — unlike
  // events/normalize.ts's own inline signature check, which is gated on
  // `state === 'DONE'`. `it.fails` pins this down without reddening the suite.
  it.fails('does not fire on an ACTIVE (still-running) tool step even with matching output text', () => {
    const step = toolStep({
      state: 'ACTIVE',
      tool_info: { name: 'run_command', output: 'Could not resolve host' },
    })
    expect(detectClass2(step)).toBeNull()
  })
})

describe('parseGateDenial / extractRequiredRule', () => {
  it('round-trips the embedded payload losslessly', () => {
    const payload: GateDenialPayload = {
      job_id: 'j1',
      tool: 'run_command',
      required_rule: 'command(npm test)',
      policy: 'default',
      on_denial: 'guide',
    }
    const message = `guidance text here [${GATE_DENIAL_MARKER}${JSON.stringify(payload)}]`
    expect(parseGateDenial(message)).toEqual(payload)
    expect(extractRequiredRule(message)).toBe('command(npm test)')
  })

  it('returns null for a message with no marker', () => {
    expect(parseGateDenial('just a plain refusal')).toBeNull()
    expect(extractRequiredRule('just a plain refusal')).toBeNull()
  })

  it('falls back to the "(required rule: ...)" prose form when there is no marker', () => {
    const message = 'not in profile allowlist (required rule: command(echo forbidden-marker))'
    expect(extractRequiredRule(message)).toBe('command(echo forbidden-marker)')
  })
})
