/**
 * `src/report/render.ts` — the two pure HTML renderers behind
 * `agy-worker-setup --report` (docs/operations.md).
 *
 * These are golden-ish assertions rather than full snapshots: pinning every
 * byte of a page this large would make the test brittle to CSS tweaks that
 * change nothing security- or content-relevant. What is pinned down hard is
 * the one thing that must never regress — that a string a job read out of a
 * file, however hostile-looking, can never become live markup in the page.
 */
import { describe, expect, it } from 'vitest'

import type { BrokerResult, EffectiveConfig, UsageRecord } from '../../../src/contract/types.js'
import { renderJobReport, renderProjectReport, type JobReportInput, type ProjectReportInput } from '../../../src/report/render.js'
import type { RedactOptions } from '../../../src/report/redact.js'
import type { UsageRollup } from '../../../src/usage/read.js'

const REDACTION: RedactOptions = { level: 'default', home: '/Users/alice', workspace: '/Users/alice/code/project' }

function fixtureRollup(overrides: Partial<UsageRollup> = {}): UsageRollup {
  return {
    jobs: 0,
    window: { from: null, to: null },
    outcomes: {},
    tokens: { input: 0, output: 0, total: 0, cache_read: 0 },
    duration_ms: { median: null, p90: null },
    denied_rules: [],
    models: [],
    by_day: [],
    failures: [],
    agy_versions: {},
    ...overrides,
  }
}

function fixtureProjectInput(overrides: Partial<ProjectReportInput> = {}): ProjectReportInput {
  return {
    generatedAt: 1_757_900_000_000,
    projectRoot: '/Users/alice/code/project',
    redaction: REDACTION,
    read: { malformed: 0, rotated: false },
    rollup: fixtureRollup(),
    request: { sinceMs: null, last: 100 },
    ...overrides,
  }
}

describe('renderProjectReport', () => {
  it('renders a valid, readable report for a project with no usage history at all', () => {
    const html = renderProjectReport(fixtureProjectInput())
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('Overview')
    expect(html).toContain('Denied-rule table')
    expect(html).toContain('Model × outcome')
    expect(html).toContain('Daily activity')
    expect(html).toContain('Failures')
    expect(html).toContain('No rows.')
  })

  it('prints the redaction notice and the level the report was run at', () => {
    const html = renderProjectReport(fixtureProjectInput({ redaction: { level: 'strict' } }))
    expect(html).toContain('This report is a local snapshot')
    expect(html).toContain('Redaction level for this report: strict.')
  })

  it('surfaces a malformed-lines or rotated window rather than hiding it', () => {
    const html = renderProjectReport(fixtureProjectInput({ read: { malformed: 3, rotated: true } }))
    expect(html).toMatch(/3 lines of usage\.jsonl could not be parsed/)
    expect(html).toContain('usage.jsonl has rotated at least once')
  })

  it('renders the denied-rule table with the vocabulary note, redacting a required_rule that carries a workspace path', () => {
    const rollup = fixtureRollup({
      jobs: 2,
      window: { from: 1_000, to: 2_000 },
      denied_rules: [
        {
          required_rule: 'command(rm -rf /Users/alice/code/project/build)',
          count: 4,
          jobs: 2,
          last_ts: 2_000,
          last_job_id: 'job-abc',
        },
      ],
    })
    const html = renderProjectReport(fixtureProjectInput({ rollup }))
    expect(html).toContain('command(rm -rf &lt;workspace&gt;/build)')
    expect(html).toContain('agy_ceiling reads')
    expect(html).toContain('agy-worker-setup --report --job job-abc')
  })

  it('builds the model × outcome table with one column per outcome actually seen', () => {
    const rollup = fixtureRollup({
      jobs: 3,
      models: [
        { model: 'gemini-3.8-flash-high', effort: 'high', jobs: 2, outcomes: { verified_success: 2 }, total_tokens: 500 },
        { model: 'gemini-3.8-pro', effort: null, jobs: 1, outcomes: { blocked: 1 }, total_tokens: 90 },
      ],
    })
    const html = renderProjectReport(fixtureProjectInput({ rollup }))
    expect(html).toContain('gemini-3.8-flash-high')
    expect(html).toContain('data-key="outcome_verified_success"')
    expect(html).toContain('data-key="outcome_blocked"')
  })

  it('lists failures with a copyable per-job report command', () => {
    const rollup = fixtureRollup({
      failures: [{ job_id: 'job-xyz', ts: 5_000, outcome: 'blocked', profile: 'general_worker', model: 'gemini-3.8-pro', remedy: 'widen the ceiling' }],
    })
    const html = renderProjectReport(fixtureProjectInput({ rollup }))
    expect(html).toContain('agy-worker-setup --report --job job-xyz')
    expect(html).toContain('widen the ceiling')
  })

  it('never emits a network resource reference of any kind', () => {
    const html = renderProjectReport(fixtureProjectInput({ rollup: fixtureRollup({ jobs: 1, agy_versions: { '1.1.27': 1 } }) }))
    expect(html).not.toMatch(/https?:\/\//)
  })

  it('escapes a hostile-looking agy version string in the overview line', () => {
    const html = renderProjectReport(fixtureProjectInput({ rollup: fixtureRollup({ jobs: 1, agy_versions: { '<script>alert(3)</script>': 1 } }) }))
    expect(html).not.toContain('<script>alert(3)</script>')
    expect(html).toContain('&lt;script&gt;alert(3)&lt;/script&gt;')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Job mode
// ─────────────────────────────────────────────────────────────────────────────

function fixtureBrokerResult(overrides: Partial<BrokerResult> = {}): BrokerResult {
  return {
    schema_version: 4,
    job_id: 'job-1',
    session_id: 'sess-1',
    conversation_id: null,
    lifecycle: 'finished',
    cwd: '/Users/alice/code/project',
    profile: 'general_worker',
    session_mode: 'oneshot',
    created_at: 1_700_000_000_000,
    started_at: 1_700_000_000_500,
    finished_at: 1_700_000_010_000,
    agent_report: {
      status: 'SUCCESS',
      response: 'All done.',
      error: null,
      num_turns: 1,
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, cache_read_tokens: 10 },
      conversation_id: null,
    },
    broker_summary: {
      headline: 'Job finished: verified_success.',
      outcome: 'verified_success',
      exit_code: 0,
      duration_ms: 9500,
      counts: { events: 5, steps: 5, tool_calls: 2, tool_errors: 0, turns: 1, malformed_lines: 0 },
      log_tail: [],
    },
    verification: {
      blockers: [],
      expected_artifacts: [],
      changed_files: ['M src/index.ts'],
      warnings: [],
      contract_status: 'not_required',
      checked_at: 1_700_000_010_000,
      verify: null,
    },
    workspace: {
      kind: 'in_place',
      path: '/Users/alice/code/project',
      branch: null,
      base_commit: 'abc123',
      head_commit: 'abc123',
      committed: false,
      changed_file_count: 1,
    },
    agent_status: 'SUCCESS',
    contract_status: 'not_required',
    structured_output: null,
    finalized_at: 1_700_000_010_100,
    ...overrides,
  } as unknown as BrokerResult
}

function fixtureEffectiveConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
  return {
    job_id: 'job-1',
    session_id: 'sess-1',
    conversation_id: null,
    cwd: '/Users/alice/code/project',
    profile: 'general_worker',
    model: 'gemini-3.8-flash-high',
    effort: 'high',
    mode: null,
    session_mode: 'oneshot',
    on_denial: 'continue',
    write_mode: true,
    timeout_ms: 60_000,
    deadline_at: 1_700_000_060_000,
    idle_timeout_ms: null,
    expected_artifacts: [],
    json_schema_path: null,
    policy: {
      profile: 'general_worker',
      workspace: '/Users/alice/code/project',
      read_roots: ['/Users/alice/code/project'],
      write_roots: ['/Users/alice/code/project'],
      allow: ['command(npx vitest)'],
      deny: ['command(git push)'],
      sandbox: 'none',
      sandbox_source: 'default',
      seatbelt_write_roots: [],
      bypass_sandbox: true,
      sandbox_forced_by: null,
      add_dirs: [],
      add_dirs_source: 'none',
      command_policy: 'allowlist',
      policy_version: 3,
      on_denial: 'continue',
    },
    add_dirs: [],
    verify: null,
    argv: ['agy', 'run'],
    agy_bin: '/usr/local/bin/agy',
    agy_version: '1.1.27',
    env: {},
    created_at: 1_700_000_000_000,
    worktree: null,
    ...overrides,
  } as unknown as EffectiveConfig
}

function fixtureJobInput(overrides: Partial<JobReportInput> = {}): JobReportInput {
  return {
    generatedAt: 1_757_900_000_000,
    jobId: 'job-1',
    redaction: REDACTION,
    includePrompt: false,
    brokerResult: fixtureBrokerResult(),
    effectiveConfig: fixtureEffectiveConfig(),
    usageRecord: null,
    gateConfirmed: true,
    gateLogText: null,
    normalizedLogLines: [],
    stderrText: null,
    promptText: null,
    missingFiles: [],
    ...overrides,
  }
}

describe('renderJobReport', () => {
  it('renders the verdict, environment and raw sections for a complete job', () => {
    const html = renderJobReport(fixtureJobInput())
    expect(html).toContain('Verdict')
    expect(html).toContain('Job finished: verified_success.')
    expect(html).toContain('Environment')
    expect(html).toContain('command(npx vitest)')
    expect(html).toContain('command(git push)')
    expect(html).toContain('Raw')
  })

  it('calls out a contract_status/agent_status disagreement instead of burying it', () => {
    const html = renderJobReport(
      fixtureJobInput({
        brokerResult: fixtureBrokerResult({ contract_status: 'violated', agent_status: 'SUCCESS' }),
      }),
    )
    expect(html).toContain('self-report is not evidence')
  })

  it('separates non-actionable blockers visually and shows the remedy for actionable ones', () => {
    const html = renderJobReport(
      fixtureJobInput({
        brokerResult: fixtureBrokerResult({
          verification: {
            blockers: [
              { source: 'gate', actionable: true, remedy: 'add command(npm test) to allow', blocks_outcome: true, tool: 'run_command', command: 'npm test', message: 'denied by gate' },
              { source: 'agy_engine', actionable: false, remedy: null, blocks_outcome: false, tool: null, command: null, message: 'agy refused this itself' },
            ],
            expected_artifacts: [],
            changed_files: [],
            warnings: [],
            contract_status: 'not_required',
            checked_at: 1_700_000_010_000,
            verify: null,
          },
        } as unknown as Partial<BrokerResult>),
      }),
    )
    expect(html).toContain('add command(npm test) to allow')
    expect(html).toContain('nothing a different agy_start can fix')
    expect(html).toContain('not actionable')
  })

  it('escapes a blocker message and remedy that carry a hostile-looking verbatim run string', () => {
    const html = renderJobReport(
      fixtureJobInput({
        brokerResult: fixtureBrokerResult({
          verification: {
            blockers: [
              {
                source: 'gate',
                actionable: true,
                remedy: 'add <img src=x onerror=alert(1)> to allow',
                blocks_outcome: true,
                tool: 'run_command',
                command: null,
                message: '<script>alert(2)</script> was refused',
              },
            ],
            expected_artifacts: [],
            changed_files: [],
            warnings: [],
            contract_status: 'not_required',
            checked_at: 1_700_000_010_000,
            verify: null,
          },
        } as unknown as Partial<BrokerResult>),
      }),
    )
    expect(html).not.toContain('<script>alert(2)</script>')
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('lists missing files instead of crashing when the job directory has partially aged out', () => {
    const html = renderJobReport(fixtureJobInput({ missingFiles: ['gate-log.jsonl', 'stderr.log'] }))
    expect(html).toContain('gate-log.jsonl')
    expect(html).toContain('stderr.log')
    expect(html).toMatch(/deleted on a normal schedule/)
  })

  it('excludes the prompt and marks response text omitted when --include-prompt was not passed', () => {
    const html = renderJobReport(
      fixtureJobInput({
        includePrompt: false,
        normalizedLogLines: ['final response text that should never appear'],
        promptText: 'the secret prompt',
      }),
    )
    expect(html).not.toContain('the secret prompt')
    expect(html).toContain('excluded')
  })

  it('includes the prompt when --include-prompt was passed', () => {
    const html = renderJobReport(
      fixtureJobInput({ includePrompt: true, promptText: 'the actual prompt text' }),
    )
    expect(html).toContain('the actual prompt text')
  })

  it('renders every gate-log line, allows included, with a matched rule column', () => {
    const gateLogText = [
      JSON.stringify({ ts: 1, step_idx: 0, tool: 'run_command', command: 'npm test', decision: 'allow', policy: 'ceiling' }),
      JSON.stringify({
        ts: 2,
        step_idx: 1,
        tool: 'run_command',
        command: 'git push',
        decision: 'deny',
        policy: 'ceiling',
        reason: 'blocked [agy-worker-denial:{"required_rule":"command(git push)"}]',
      }),
    ].join('\n')
    const html = renderJobReport(fixtureJobInput({ gateLogText }))
    expect(html).toContain('npm test')
    expect(html).toContain('git push')
    expect(html).toContain('command(git push)')
    expect(html).toContain('allow')
    expect(html).toContain('deny')
  })

  it('escapes a <script> command string in the gate log so it cannot become live markup, in the visible table and in the embedded JSON alike', () => {
    const gateLogText = JSON.stringify({
      ts: 1,
      step_idx: 0,
      tool: 'run_command',
      command: '<script>alert(1)</script>',
      decision: 'deny',
      policy: 'ceiling',
      reason: 'blocked',
    })
    const html = renderJobReport(fixtureJobInput({ gateLogText }))
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    // the embedded sort/filter payload escapes the same value the JSON way (redact.test.ts pins this exact form)
    expect(html).toContain('\\u003cscript>alert(1)\\u003c/script>')
  })

  it('escapes a log line whose body contains a literal </script>, in the collapsible timeline', () => {
    const html = renderJobReport(
      fixtureJobInput({ normalizedLogLines: ['tool output included a literal </script> tag from a file it read'] }),
    )
    expect(html).not.toContain('a literal </script> tag')
    expect(html).toContain('a literal &lt;/script&gt; tag')
  })

  it('redacts a secret pattern anywhere it appears — stderr, effective-config, and a blocker remedy alike', () => {
    const html = renderJobReport(
      fixtureJobInput({
        stderrText: 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwx failed',
      }),
    )
    expect(html).not.toContain('sk-abcdefghijklmnopqrstuvwx')
    expect(html).toContain('[redacted:')
  })

  it('renders the workspace and changed-files section from broker-result.json', () => {
    const html = renderJobReport(fixtureJobInput())
    expect(html).toContain('Changed files and workspace')
    expect(html).toContain('M src/index.ts')
  })

  it('falls back gracefully when broker-result.json and effective-config.json are both absent', () => {
    const html = renderJobReport(fixtureJobInput({ brokerResult: null, effectiveConfig: null }))
    expect(html).toContain('No broker-result.json for this job')
    expect(html).toContain('effective-config.json was not found')
  })

  it('enriches the environment section from a matching usage.jsonl record when the job directory itself has aged past those fields', () => {
    const usageRecord = {
      v: 1,
      ts: 1_700_000_010_000,
      job_id: 'job-1',
      session_id: 'sess-1',
      profile: 'general_worker',
      model: 'gemini-3.8-flash-high',
      effort: 'high',
      session_mode: 'oneshot',
      isolation: 'in_place',
      sandbox: 'none',
      on_denial: 'continue',
      outcome: 'verified_success',
      contract_status: 'not_required',
      agent_status: 'SUCCESS',
      exit_code: 0,
      duration_ms: 9500,
      queued_ms: 10,
      counts: { events: 5, steps: 5, tool_calls: 2, tool_errors: 0, turns: 1, malformed_lines: 0 },
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      files: { read: 1, edited: 1 },
      denials: [],
      blockers: [],
      verify: { ran: false, passed: false },
      workspace: { kind: 'in_place', changed_files: 1 },
      env: { agy: '1.1.27', pkg: '0.4.0', node: 'v24.21.0', platform: 'darwin' },
    } as unknown as UsageRecord
    const html = renderJobReport(fixtureJobInput({ effectiveConfig: null, usageRecord }))
    expect(html).toContain('v24.21.0')
    expect(html).toContain('darwin')
  })

  it('never emits a network resource reference of any kind', () => {
    const html = renderJobReport(fixtureJobInput({ gateLogText: '', normalizedLogLines: ['session started'] }))
    expect(html).not.toMatch(/https?:\/\//)
  })
})
