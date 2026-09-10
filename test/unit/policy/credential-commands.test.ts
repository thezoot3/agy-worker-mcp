import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { decide } from '../../../src/gate/gate.js'
import { resolvePolicy } from '../../../src/policy/profiles.js'
import { canonicalize } from '../../../src/contract/paths.js'
import type { BoundJob } from '../../../src/gate/bind.js'
import type { EffectivePolicy, JobRow, Profile } from '../../../src/contract/types.js'

const WS = '/abs/workspace'
const HOME = canonicalize(homedir())

function job(profile: Profile): JobRow {
  return {
    job_id: 'job-1',
    session_id: null,
    lifecycle: 'running',
    outcome: null,
    headline: null,
    cwd: WS,
    profile,
    write_mode: 1,
    session_mode: 'oneshot',
    pid: 1,
    pgid: 1,
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
  }
}

function boundFor(profile: Profile, requested?: { allow?: string[]; deny?: string[] }): BoundJob {
  const policy: EffectivePolicy = resolvePolicy({ profile, workspace: WS, requested })
  return { job: job(profile), policy, conversationId: 'conv-1' }
}

function decideCmd(
  commandLine: string,
  profile: Profile = 'general_worker',
  requested?: { allow?: string[]; deny?: string[] },
) {
  return decide({
    payload: {
      conversationId: 'conv-1',
      toolCall: { name: 'run_command', args: { CommandLine: commandLine } },
    },
    bound: boundFor(profile, requested),
  })
}

describe('Item 3: credential HARD_DENY for commands', () => {
  const credentialTargets = [
    '~/.ssh/id_rsa',
    '~/.aws/credentials',
    '~/.gnupg/pubring.kbx',
    '~/.config/gh/hosts.yml',
    '~/.config/gcloud/credentials.db',
    '~/.npmrc',
    '~/.git-credentials',
    '~/.netrc',
    '~/.docker/config.json',
    '~/.kube/config',
    '~/.gemini/state.json',
    '~/.antigravity/auth.json',
    '~/.agy-worker/state',
  ]

  it.each(credentialTargets)(
    'denies read targeting credential path: cat %s',
    (credPath) => {
      const outcome = decideCmd(`cat ${credPath}`)
      expect(outcome.decision.decision).toBe('deny')
      expect(outcome.decision.reason).toContain('hard_deny')
      expect(outcome.log?.policy).toBe('deny_list')
    },
  )

  it.each(credentialTargets)(
    'denies absolute credential path targeting: cat %s (canonical)',
    (credPath) => {
      const absPath = credPath.replace(/^~\//, `${HOME}/`)
      const outcome = decideCmd(`cat ${absPath}`)
      expect(outcome.decision.decision).toBe('deny')
      expect(outcome.decision.reason).toContain('hard_deny')
      expect(outcome.log?.policy).toBe('deny_list')
    },
  )

  it('denies redirection targeting credentials: echo evil > ~/.ssh/authorized_keys', () => {
    const outcome = decideCmd('echo evil > ~/.ssh/authorized_keys')
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.decision.reason).toContain('hard_deny')
  })

  it('denies redirection appending to credentials: echo evil >> ~/.aws/credentials', () => {
    const outcome = decideCmd('echo evil >> ~/.aws/credentials')
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.decision.reason).toContain('hard_deny')
  })

  it('denies nested bash -c invocations targeting credentials', () => {
    const outcome = decideCmd('bash -c "cat ~/.ssh/id_rsa"')
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.decision.reason).toContain('hard_deny')
  })

  it('denies nested sh -c redirection targeting credentials', () => {
    const outcome = decideCmd('sh -c "echo evil > ~/.netrc"')
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.decision.reason).toContain('hard_deny')
  })

  it('client-requested allow list cannot bypass hard_deny', () => {
    const outcome = decideCmd('cat ~/.ssh/id_rsa', 'general_worker', {
      allow: ['command(cat)'],
    })
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.decision.reason).toContain('hard_deny')
  })

  it.each(['general_worker', 'research_readonly'] as const)(
    'denies credentials under profile %s',
    (profile) => {
      const outcome = decideCmd('cat ~/.docker/config.json', profile)
      expect(outcome.decision.decision).toBe('deny')
      expect(outcome.decision.reason).toContain('hard_deny')
    },
  )

  it('ordinary commands inside workspace are not affected by credential check', () => {
    const outcome = decideCmd('cat src/index.ts', 'general_worker')
    expect(outcome.decision.reason ?? '').not.toContain('hard_deny')
  })
})
