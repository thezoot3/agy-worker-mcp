import { describe, expect, it } from 'vitest'

import {
  blockerFromDenial,
  blockerFromEnvironmentBlock,
  blockerFromMissingArtifact,
} from '../../../src/broker/blockers.js'
import { decideOutcome, isVerifiedSuccess } from '../../../src/broker/outcome.js'
import type { OutcomeInput } from '../../../src/broker/outcome.js'
import type { Verification, VerifyResult } from '../../../src/contract/types.js'

function emptyVerification(over: Partial<Verification> = {}): Verification {
  return {
    blockers: [],
    expected_artifacts: [],
    changed_files: [],
    warnings: [],
    contract_status: 'not_required',
    checked_at: Date.now(),
    verify: null,
    ...over,
  }
}

function verifyResult(over: Partial<VerifyResult> = {}): VerifyResult {
  return {
    command: 'test -f note.txt',
    exit_code: 0,
    signal: null,
    started_at: Date.now(),
    duration_ms: 1200,
    timed_out: false,
    output_tail: '',
    ...over,
  }
}

function baseInput(over: Partial<OutcomeInput> = {}): OutcomeInput {
  return {
    lifecycle: 'running',
    exitCode: 0,
    agentStatus: 'SUCCESS',
    verification: emptyVerification(),
    timedOut: false,
    canceled: false,
    gateMissing: false,
    runnerLost: false,
    pidReused: false,
    hadExpectations: false,
    ...over,
  }
}

describe('exit 0 + SUCCESS is never trusted on its own', () => {
  it('exit 0 + agy SUCCESS + a missing expected artifact is NOT verified_success', () => {
    // `verifyJob` turns every missing artifact into a `source: 'broker'`
    // blocker; `decideOutcome` now reads only that list, never the artifacts.
    const missing = { path: 'out.txt', absolute: '/ws/out.txt', exists: false, size: null }
    const input = baseInput({
      hadExpectations: true,
      verification: emptyVerification({
        expected_artifacts: [missing],
        blockers: [blockerFromMissingArtifact(missing)],
      }),
    })
    const decision = decideOutcome(input)
    expect(decision.outcome).not.toBe('verified_success')
    expect(decision.outcome).toBe('blocked')
    expect(isVerifiedSuccess(input)).toBe(false)
  })

  it('exit 0 + agy SUCCESS + a confirmed gate denial is "blocked", not success', () => {
    const input = baseInput({
      verification: emptyVerification({
        blockers: [
          blockerFromDenial({
            class: 1,
            tool: 'run_command',
            command: 'git push',
            required_rule: null,
            policy: 'deny_list',
            source: 'gate',
            message: 'denied',
            step_idx: 3,
          }),
        ],
      }),
    })
    expect(decideOutcome(input).outcome).toBe('blocked')
  })

  it('exit 0 + agy SUCCESS + a Class 2 environment block is "blocked", not success', () => {
    const input = baseInput({
      verification: emptyVerification({
        blockers: [
          blockerFromEnvironmentBlock({
            class: 2,
            tool: 'run_command',
            command: 'pip install requests',
            signature: 'Could not resolve host',
            excerpt: '...Could not resolve host...',
            step_idx: 7,
          }),
        ],
      }),
    })
    const decision = decideOutcome(input)
    expect(decision.outcome).toBe('blocked')
    // The headline now names the source of each block rather than the old
    // per-class wording ("environment block(s)").
    expect(decision.headline).toContain('sandbox block')
  })

  it('exit 0 + SUCCESS + all expected artifacts present IS verified_success', () => {
    const input = baseInput({
      hadExpectations: true,
      verification: emptyVerification({
        expected_artifacts: [{ path: 'out.txt', absolute: '/ws/out.txt', exists: true, size: 12 }],
      }),
    })
    expect(decideOutcome(input).outcome).toBe('verified_success')
    expect(isVerifiedSuccess(input)).toBe(true)
  })

  it('exit 0 + SUCCESS + nothing verifiable requested is success_unverified, not verified_success', () => {
    const input = baseInput({ hadExpectations: false })
    expect(decideOutcome(input).outcome).toBe('success_unverified')
  })
})

describe('verify_command (PR6, docs/permissions.md)', () => {
  it('a non-zero verify exit code is "failed", never a Blocker', () => {
    const input = baseInput({
      verification: emptyVerification({ verify: verifyResult({ exit_code: 3 }) }),
    })
    const decision = decideOutcome(input)
    expect(decision.outcome).toBe('failed')
    expect(decision.warnings).toEqual([])
    expect(decision.headline).toContain('verify: exit 3')
  })

  it('verify_timeout_ms firing is "failed", with timed_out surfaced in the headline', () => {
    const input = baseInput({
      verification: emptyVerification({
        verify: verifyResult({ exit_code: null, timed_out: true, duration_ms: 1500 }),
      }),
    })
    const decision = decideOutcome(input)
    expect(decision.outcome).toBe('failed')
    expect(decision.headline).toContain('verify: timed out after 1.5s')
  })

  it('a passing verify with no expected_artifacts is verified_success — a passing check counts on its own', () => {
    const input = baseInput({
      hadExpectations: false,
      verification: emptyVerification({ verify: verifyResult({ exit_code: 0 }) }),
    })
    const decision = decideOutcome(input)
    expect(decision.outcome).toBe('verified_success')
    expect(decision.headline).toContain('verify: exit 0')
  })

  it('a confirmed blocker still wins over a failing verify_command', () => {
    const missing = { path: 'out.txt', absolute: '/ws/out.txt', exists: false, size: null }
    const input = baseInput({
      hadExpectations: true,
      verification: emptyVerification({
        expected_artifacts: [missing],
        blockers: [blockerFromMissingArtifact(missing)],
        verify: verifyResult({ exit_code: 1 }),
      }),
    })
    expect(decideOutcome(input).outcome).toBe('blocked')
  })

  it('no verify_command configured leaves outcome exactly as before', () => {
    const input = baseInput({ hadExpectations: false, verification: emptyVerification({ verify: null }) })
    const decision = decideOutcome(input)
    expect(decision.outcome).toBe('success_unverified')
    expect(decision.headline).not.toContain('verify:')
  })
})

describe('precedence order', () => {
  it('canceled wins even when the deadline also passed', () => {
    const input = baseInput({ canceled: true, timedOut: true })
    expect(decideOutcome(input).outcome).toBe('canceled')
  })

  it('timedOut wins over a pid-reuse / runner-lost signal', () => {
    const input = baseInput({ timedOut: true, pidReused: true, runnerLost: true })
    expect(decideOutcome(input).outcome).toBe('timed_out')
  })

  it('runnerLost wins over pidReused', () => {
    const input = baseInput({ runnerLost: true, pidReused: true })
    expect(decideOutcome(input).outcome).toBe('process_error')
  })

  it('gateMissing (I4) is process_error, even with exitCode/agentStatus that would otherwise read "failed", and its headline names the gate', () => {
    const input = baseInput({ gateMissing: true, exitCode: 143, agentStatus: 'unknown' })
    const decision = decideOutcome(input)
    expect(decision.outcome).toBe('process_error')
    expect(decision.headline).toContain('gate hook never fired')
  })

  it('gateMissing wins over runnerLost/pidReused', () => {
    const input = baseInput({ gateMissing: true, runnerLost: true, pidReused: true })
    expect(decideOutcome(input).outcome).toBe('process_error')
  })

  it('timedOut wins over gateMissing', () => {
    const input = baseInput({ timedOut: true, gateMissing: true })
    expect(decideOutcome(input).outcome).toBe('timed_out')
  })

  it('a non-zero exit code is "failed" even when agy self-reports SUCCESS', () => {
    const input = baseInput({ exitCode: 1, agentStatus: 'SUCCESS' })
    expect(decideOutcome(input).outcome).toBe('failed')
  })

  it('agy self-reporting ERROR is "failed" even at exit code 0', () => {
    const input = baseInput({ exitCode: 0, agentStatus: 'ERROR' })
    expect(decideOutcome(input).outcome).toBe('failed')
  })
})

describe('stream interruption classification (PR6 §3)', () => {
  it('classifies "The stream was interrupted" as a retryable warning while outcome stays failed', () => {
    const input = baseInput({
      exitCode: 0,
      agentStatus: 'ERROR',
      agentError: 'The stream was interrupted. Please continue the task you were working on.',
      agentResponse: 'Task partially complete, writing file...',
    })
    const decision = decideOutcome(input)
    expect(decision.outcome).toBe('failed')
    expect(decision.warnings.some((w) => w.includes('retryable') && w.includes('stream interrupted'))).toBe(true)
  })

  it('detects stream interruption if carried via verification warnings', () => {
    const input = baseInput({
      exitCode: 0,
      agentStatus: 'ERROR',
      verification: emptyVerification({
        warnings: ['The stream was interrupted. Please continue the task you were working on.'],
      }),
    })
    const decision = decideOutcome(input)
    expect(decision.outcome).toBe('failed')
    expect(decision.warnings.some((w) => w.includes('retryable') && w.includes('stream interrupted'))).toBe(true)
  })

  it('ordinary ERROR without stream interruption is failed without retryable warning', () => {
    const input = baseInput({
      exitCode: 1,
      agentStatus: 'ERROR',
      agentError: 'Cannot find module ./app.js',
    })
    const decision = decideOutcome(input)
    expect(decision.outcome).toBe('failed')
    expect(decision.warnings.some((w) => w.includes('retryable'))).toBe(false)
  })
})

