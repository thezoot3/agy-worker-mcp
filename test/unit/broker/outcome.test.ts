import { describe, expect, it } from 'vitest'

import {
  blockerFromDenial,
  blockerFromEnvironmentBlock,
  blockerFromMissingArtifact,
} from '../../../src/broker/blockers.js'
import { decideOutcome, isVerifiedSuccess } from '../../../src/broker/outcome.js'
import type { OutcomeInput } from '../../../src/broker/outcome.js'
import type { Verification } from '../../../src/contract/types.js'

function emptyVerification(over: Partial<Verification> = {}): Verification {
  return {
    blockers: [],
    expected_artifacts: [],
    changed_files: [],
    warnings: [],
    contract_status: 'not_required',
    checked_at: Date.now(),
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
    runnerLost: false,
    pidReused: false,
    hadExpectations: false,
    ...over,
  }
}

describe('exit 0 + SUCCESS is never trusted on its own (docs/03 §2)', () => {
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

  it('a non-zero exit code is "failed" even when agy self-reports SUCCESS', () => {
    const input = baseInput({ exitCode: 1, agentStatus: 'SUCCESS' })
    expect(decideOutcome(input).outcome).toBe('failed')
  })

  it('agy self-reporting ERROR is "failed" even at exit code 0', () => {
    const input = baseInput({ exitCode: 0, agentStatus: 'ERROR' })
    expect(decideOutcome(input).outcome).toBe('failed')
  })
})
