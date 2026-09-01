import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { escapingRedirectTarget, redirectionTargets } from '../../../src/policy/containment.js'
import { decide } from '../../../src/gate/gate.js'
import { resolvePolicy } from '../../../src/policy/profiles.js'
import type { BoundJob } from '../../../src/gate/bind.js'
import type { EffectivePolicy, JobRow, Profile } from '../../../src/contract/types.js'

// A real directory, because containment canonicalizes (realpath) both sides.
const WS = mkdtempSync(join(tmpdir(), 'agy-redir-ws-'))

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

function boundFor(profile: Profile): BoundJob {
  const policy: EffectivePolicy = resolvePolicy({ profile, workspace: WS })
  return { job: job(profile), policy, conversationId: 'conv-1' }
}

function verdict(profile: Profile, CommandLine: string): string {
  return decide({
    payload: { conversationId: 'conv-1', toolCall: { name: 'run_command', args: { CommandLine } } },
    bound: boundFor(profile),
  }).decision.decision
}

describe('redirectionTargets — only the redirection grammar, nothing else', () => {
  it('picks up > >> and numbered forms, spaced or glued', () => {
    expect(redirectionTargets('printf hi > /tmp/x', WS)).toEqual(['/tmp/x'])
    expect(redirectionTargets('printf hi >>/tmp/x', WS)).toEqual(['/tmp/x'])
    expect(redirectionTargets('cmd 2> /tmp/err', WS)).toEqual(['/tmp/err'])
    expect(redirectionTargets('cmd &> /tmp/both', WS)).toEqual(['/tmp/both'])
    expect(redirectionTargets('cmd >| /tmp/clobber', WS)).toEqual(['/tmp/clobber'])
  })

  it('resolves a relative target against the workspace, since the gate pins Cwd there', () => {
    expect(redirectionTargets('cmd > out.txt', WS)).toEqual([join(WS, 'out.txt')])
  })

  it('ignores fd duplication and the standard sinks — these write no file', () => {
    expect(redirectionTargets('npm test 2>&1', WS)).toEqual([])
    expect(redirectionTargets('cmd > /dev/null 2>&1', WS)).toEqual([])
    expect(redirectionTargets('cmd > /dev/stderr', WS)).toEqual([])
  })

  it('ignores input redirection — this is about writes', () => {
    expect(redirectionTargets('cmd < /etc/passwd', WS)).toEqual([])
  })

  it('escapingRedirectTarget is null for everything inside the workspace', () => {
    expect(escapingRedirectTarget('npm test 2>&1 | tail -5', WS)).toBeNull()
    expect(escapingRedirectTarget('cmd > out.txt', WS)).toBeNull()
    expect(escapingRedirectTarget('ls -la', WS)).toBeNull()
    expect(escapingRedirectTarget('cmd > /tmp/x', WS)).toBe('/tmp/x')
  })
})

describe('the gate denies an escaping redirect under EVERY profile', () => {
  // Measured live 2026-09-01 (docs/02 §4-c): `printf hello > /tmp/x` ran to
  // completion under --sandbox with no denial. Rule matching is prefix-only, so
  // neither an allow list nor default_decision can see the redirect — hence a
  // containment stage ahead of both.
  it.each<[Profile, string, string]>([
    ['general_worker', 'printf hello > /tmp/agy-escape-probe', 'deny'],
    ['general_worker', 'ls -la > /tmp/agy-escape-probe', 'deny'],
    ['research_readonly', 'ls -la > /tmp/agy-escape-probe', 'deny'],
    ['research_readonly', 'cat a.txt > /tmp/agy-escape-probe', 'deny'],
  ])('%s: %s → %s', (profile, cmd, want) => {
    expect(verdict(profile, cmd)).toBe(want)
  })

  it('the denial is logged as containment, and its reason names the target', () => {
    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: { name: 'run_command', args: { CommandLine: 'printf hi > /tmp/agy-escape-probe' } },
      },
      bound: boundFor('general_worker'),
    })
    expect(outcome.log?.policy).toBe('containment')
    expect(outcome.decision.reason).toContain('/tmp/agy-escape-probe')
  })
})

describe('ordinary work is untouched — the whole point of scoping it this narrowly', () => {
  it.each<[Profile, string]>([
    ['general_worker', 'npm test 2>&1 | tail -5'],
    ['general_worker', 'git status --short'],
    ['general_worker', 'cmd > /dev/null 2>&1'],
    ['general_worker', 'printf hello > out.txt'],
    ['research_readonly', 'ls -la'],
  ])('%s: %s is not denied by containment', (profile, cmd) => {
    const outcome = decide({
      payload: { conversationId: 'conv-1', toolCall: { name: 'run_command', args: { CommandLine: cmd } } },
      bound: boundFor(profile),
    })
    expect(outcome.log?.policy).not.toBe('containment')
  })
})

describe('the denial record tells the caller which stage refused', () => {
  it('a containment refusal round-trips as policy:"containment" with no required_rule', async () => {
    const { scanDenials } = await import('../../../src/events/detect.js')
    const outcome = decide({
      payload: {
        conversationId: 'conv-1',
        toolCall: { name: 'run_command', args: { CommandLine: 'printf hi > /tmp/agy-escape-probe' } },
      },
      bound: boundFor('general_worker'),
    })

    // Exactly what agy puts in tool_info.error.message for a hook denial.
    const scan = scanDenials([
      {
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-1',
          step_index: 2,
          state: 'ERROR',
          step_type: 'tool',
          tool_name: 'run_command',
          tool_info: {
            name: 'run_command',
            parameters: { CommandLine: 'printf hi > /tmp/agy-escape-probe' },
            error: { type: 'TOOL_ERROR', message: `tool call denied by pre-tool hook: ${outcome.decision.reason}` },
          },
        },
      },
    ] as never)

    expect(scan.permission_denials).toHaveLength(1)
    const d = scan.permission_denials[0]!
    expect(d.policy).toBe('containment')
    expect(d.source).toBe('gate')
    // No rule can lift a containment refusal — the caller must change the path.
    expect(d.required_rule).toBeNull()
  })
})
