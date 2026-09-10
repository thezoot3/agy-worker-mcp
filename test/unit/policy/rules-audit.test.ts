import { describe, expect, it } from 'vitest'

import { decide } from '../../../src/gate/gate.js'
import { parseGateDenial } from '../../../src/events/detect.js'
import { pathsFromToolCall, ABS_PATH_TOKEN } from '../../../src/policy/containment.js'
import {
  evaluateCommandPolicy,
  parseRulesLenient,
  splitChainSegments,
  stripEnvPrefixTokens,
  DENIED_ENV_PATTERNS,
  isDeniedEnvVar,
} from '../../../src/policy/rules.js'
import type { BoundJob } from '../../../src/gate/bind.js'
import type { EffectivePolicy, JobRow } from '../../../src/contract/types.js'

const WS = '/abs/workspace'

const AUDIT_ALLOW = [
  'command(./gradlew)',
  'command(ls)',
  'command(wc)',
  'command(git status|log|diff)',
  'command(./handbook/reference/check-coverage.sh)',
  'command(echo)',
]

const AUDIT_DENY = [
  'command(rm)',
  'command(git push)',
]

function makeJob(): JobRow {
  return {
    job_id: 'audit-job',
    session_id: null,
    lifecycle: 'running',
    outcome: null,
    headline: null,
    cwd: WS,
    profile: 'general_worker',
    write_mode: 1,
    session_mode: 'oneshot',
    pid: 1001,
    pgid: 1001,
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

function boundAudit(overPolicy: Partial<EffectivePolicy> = {}): BoundJob {
  const policy: EffectivePolicy = {
    profile: 'general_worker',
    allow: [...AUDIT_ALLOW],
    deny: [...AUDIT_DENY],
    workspace: WS,
    read_roots: [WS, '/opt/jdk', '/opt'],
    write_roots: [WS],
    bypass_sandbox: true,
    sandbox_forced_by: null,
    policy_version: 3,
    ceiling_present: true,
    ceiling_path: null,
    on_denial: 'continue',
    max_denials: null,
    add_dirs: [],
    add_dirs_source: 'none',
    // PR3: specify default 'allowlist' as command_policy was added to EffectivePolicy
    command_policy: 'allowlist',
    rejected_allow: [],
    lifted: [],
    sandbox: 'none',
    sandbox_source: 'default',
    seatbelt_write_roots: [],
    rejected_read_roots: [],
    ...overPolicy,
  }
  return { job: makeJob(), policy, conversationId: 'conv-audit' }
}

function decideCmd(commandLine: string, overPolicy: Partial<EffectivePolicy> = {}) {
  return decide({
    payload: {
      conversationId: 'conv-audit',
      toolCall: { name: 'run_command', args: { CommandLine: commandLine } },
    },
    bound: boundAudit(overPolicy),
  })
}

describe('PR2 audit table: command patterns with explicit rule set', () => {
  it('JAVA_HOME=/opt/jdk ./gradlew --offline build → allow', () => {
    const outcome = decideCmd('JAVA_HOME=/opt/jdk ./gradlew --offline build')
    expect(outcome.decision.decision).toBe('allow')
  })

  it('env JAVA_HOME=/opt/jdk ./gradlew --offline :bridge:test → allow', () => {
    const outcome = decideCmd('env JAVA_HOME=/opt/jdk ./gradlew --offline :bridge:test')
    expect(outcome.decision.decision).toBe('allow')
  })

  it('export JAVA_HOME=/opt/jdk → allow (no-op)', () => {
    const outcome = decideCmd('export JAVA_HOME=/opt/jdk')
    expect(outcome.decision.decision).toBe('allow')
  })

  it('export JAVA_HOME=/opt/jdk && ./gradlew :bridge:compileKotlin → allow', () => {
    const outcome = decideCmd('export JAVA_HOME=/opt/jdk && ./gradlew :bridge:compileKotlin')
    expect(outcome.decision.decision).toBe('allow')
  })

  it('PATH=/tmp/evil:$PATH ./gradlew build → deny (env_assignment_denied)', () => {
    const outcome = decideCmd('PATH=/tmp/evil:$PATH ./gradlew build')
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.decision.reason).toContain('env_assignment_denied')
  })

  it('LD_PRELOAD=/tmp/x.so ls → deny', () => {
    const outcome = decideCmd('LD_PRELOAD=/tmp/x.so ls')
    expect(outcome.decision.decision).toBe('deny')
  })

  it('bash -c "echo hello" → allow', () => {
    const outcome = decideCmd('bash -c "echo hello"')
    expect(outcome.decision.decision).toBe('allow')
  })

  it('bash -c "git push origin main" → deny', () => {
    const outcome = decideCmd('bash -c "git push origin main"')
    expect(outcome.decision.decision).toBe('deny')
  })

  it('bash ./handbook/reference/check-coverage.sh → allow', () => {
    const outcome = decideCmd('bash ./handbook/reference/check-coverage.sh')
    expect(outcome.decision.decision).toBe('allow')
  })

  it('JAVA_HOME=/opt/jdk ./handbook/reference/check-coverage.sh → allow', () => {
    const outcome = decideCmd('JAVA_HOME=/opt/jdk ./handbook/reference/check-coverage.sh')
    expect(outcome.decision.decision).toBe('allow')
  })

  it('ls -la && wc -l a.txt → allow', () => {
    const outcome = decideCmd('ls -la && wc -l a.txt')
    expect(outcome.decision.decision).toBe('allow')
  })

  it('ls -la && rm -rf x → deny, no required_rule (deny_list)', () => {
    const outcome = decideCmd('ls -la && rm -rf x')
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.log?.policy).toBe('deny_list')
    const parsed = parseGateDenial(outcome.decision.reason ?? '')
    expect(parsed?.required_rule).toBeNull()
  })

  it('git diff HEAD~1 | wc -l → allow', () => {
    const outcome = decideCmd('git diff HEAD~1 | wc -l')
    expect(outcome.decision.decision).toBe('allow')
  })

  it('git show abc:file.kt | grep -n key → deny, required_rule command(git show)', () => {
    const outcome = decideCmd('git show abc:file.kt | grep -n key')
    expect(outcome.decision.decision).toBe('deny')
    const parsed = parseGateDenial(outcome.decision.reason ?? '')
    expect(parsed?.required_rule).toBe('command(git show)')
  })

  it('echo "a && b" → allow (delimiters inside quotes are not split)', () => {
    const outcome = decideCmd('echo "a && b"')
    expect(outcome.decision.decision).toBe('allow')
  })

  it('ls $(git status) → allow', () => {
    const outcome = decideCmd('ls $(git status)')
    expect(outcome.decision.decision).toBe('allow')
  })

  it('ls $(rm -rf /) → deny', () => {
    const outcome = decideCmd('ls $(rm -rf /)')
    expect(outcome.decision.decision).toBe('deny')
  })

  it('cat <<EOF → deny (cannot parse)', () => {
    const outcome = decideCmd('cat <<EOF')
    expect(outcome.decision.decision).toBe('deny')
  })

  it('./gradlew build; git push → deny', () => {
    const outcome = decideCmd('./gradlew build; git push')
    expect(outcome.decision.decision).toBe('deny')
  })
})

describe('containment integration for assignment values', () => {
  it('ABS_PATH_TOKEN extracts NAME=/abs/path assignments', () => {
    expect(ABS_PATH_TOKEN.test('JAVA_HOME=/Users/x/.jdks/jdk')).toBe(true)
    const m = ABS_PATH_TOKEN.exec('JAVA_HOME=/Users/x/.jdks/jdk')
    expect(m?.[1]).toBe('/Users/x/.jdks/jdk')
  })

  it('pathsFromToolCall extracts assignment values as read paths', () => {
    const { read } = pathsFromToolCall('run_command', {
      CommandLine: 'JAVA_HOME=/Users/x/.jdks/jdk ./gradlew build',
      Cwd: WS,
    })
    expect(read).toContain('/Users/x/.jdks/jdk')
  })

  it('JAVA_HOME=/Users/x/.jdks/jdk fails containment when /Users/x/.jdks/jdk is outside read roots', () => {
    const outcome = decideCmd('JAVA_HOME=/Users/x/.jdks/jdk ./gradlew build', {
      read_roots: [WS], // does not contain /Users/x/.jdks/jdk
    })
    expect(outcome.decision.decision).toBe('deny')
    expect(outcome.log?.policy).toBe('containment')
    expect(outcome.decision.reason).toContain('/Users/x/.jdks/jdk')
  })

  it('a bare absolute argument is not containment-checked (cat /etc/hosts stays an allow-list question)', () => {
    const outcome = decideCmd('ls /etc/hosts', { read_roots: [WS] })
    expect(outcome.log?.policy).not.toBe('containment')
    expect(outcome.decision.decision).toBe('allow')
  })

  it('env NAME=/abs and export NAME=/abs values are containment-checked too', () => {
    expect(decideCmd('env JAVA_HOME=/Users/x/.jdks/jdk ./gradlew build', { read_roots: [WS] }).log?.policy).toBe(
      'containment',
    )
    expect(decideCmd('export JAVA_HOME=/Users/x/.jdks/jdk', { read_roots: [WS] }).log?.policy).toBe('containment')
  })

  it('JAVA_HOME=/Users/x/.jdks/jdk passes containment when /Users/x/.jdks/jdk is within read roots', () => {
    const outcome = decideCmd('JAVA_HOME=/Users/x/.jdks/jdk ./gradlew build', {
      read_roots: [WS, '/Users/x/.jdks/jdk'],
    })
    expect(outcome.decision.decision).toBe('allow')
  })
})

describe('DENIED_ENV_PATTERNS constants and helpers', () => {
  it('identifies all forbidden environment variable injection vectors', () => {
    expect(isDeniedEnvVar('PATH')).toBe(true)
    expect(isDeniedEnvVar('LD_PRELOAD')).toBe(true)
    expect(isDeniedEnvVar('DYLD_LIBRARY_PATH')).toBe(true)
    expect(isDeniedEnvVar('NODE_OPTIONS')).toBe(true)
    expect(isDeniedEnvVar('BASH_ENV')).toBe(true)
    expect(isDeniedEnvVar('ENV')).toBe(true)
    expect(isDeniedEnvVar('GIT_DIR')).toBe(true)
    expect(isDeniedEnvVar('GIT_WORK_TREE')).toBe(true)
    expect(isDeniedEnvVar('GIT_SSH')).toBe(true)
    expect(isDeniedEnvVar('GIT_SSH_COMMAND')).toBe(true)
    expect(isDeniedEnvVar('GIT_CONFIG')).toBe(true)
    expect(isDeniedEnvVar('GIT_CONFIG_PARAMETERS')).toBe(true)
    expect(isDeniedEnvVar('GIT_EXEC_PATH')).toBe(true)
    expect(isDeniedEnvVar('PYTHONSTARTUP')).toBe(true)
    expect(isDeniedEnvVar('PYTHONPATH')).toBe(true)
    expect(isDeniedEnvVar('PERL5OPT')).toBe(true)
    expect(isDeniedEnvVar('RUBYOPT')).toBe(true)
    expect(isDeniedEnvVar('JAVA_TOOL_OPTIONS')).toBe(true)
    expect(isDeniedEnvVar('_JAVA_OPTIONS')).toBe(true)

    expect(isDeniedEnvVar('JAVA_HOME')).toBe(false)
    expect(isDeniedEnvVar('GRADLE_OPTS')).toBe(false)
  })
})
