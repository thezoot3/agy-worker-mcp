/**
 * `agy-worker-setup --report` (`src/report/report.ts`) — argument parsing and
 * the end-to-end I/O path: resolving a project, reading whatever exists on
 * disk, and writing a file. The renderers themselves are covered in
 * `render.test.ts`; this file is about what happens before and after them.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ensureJobDirs, ensureProjectDirs, jobPaths, projectPaths } from '../../../src/contract/paths.js'
import { parseReportArgs, runReport } from '../../../src/report/report.js'

const NOW = 1_757_900_000_000 // 2025-09-15T02:13:20Z, arbitrary but fixed

describe('parseReportArgs', () => {
  it('defaults to project mode, last 100, no since, default redaction', () => {
    const parsed = parseReportArgs([], '/w', NOW)
    expect(parsed).toEqual({
      kind: 'report',
      options: {
        mode: 'project',
        jobId: null,
        sinceMs: null,
        last: 100,
        out: null,
        open: false,
        includePrompt: false,
        redact: 'default',
        cwd: '/w',
      },
    })
  })

  it('switches to job mode on --job', () => {
    const parsed = parseReportArgs(['--job', 'job-42'], '/w', NOW)
    expect(parsed).toEqual({ kind: 'report', options: expect.objectContaining({ mode: 'job', jobId: 'job-42' }) })
  })

  it('rejects a job id that could walk out of the jobs directory', () => {
    // Unchecked, `jobPaths` would join this straight onto jobsDir and the
    // report would describe whatever sits there instead of saying "no such job".
    const parsed = parseReportArgs(['--job', '../../..'], '/w', NOW)
    expect(parsed).toEqual({
      kind: 'error',
      message: "--job must be a job id (letters, digits, dash, underscore); got '../../..'",
    })
  })

  it('rejects --job combined with --last', () => {
    const parsed = parseReportArgs(['--job', 'job-42', '--last', '10'], '/w', NOW)
    expect(parsed).toEqual({ kind: 'error', message: '--job cannot be combined with --last or --since' })
  })

  it('rejects --job combined with --since', () => {
    const parsed = parseReportArgs(['--job', 'job-42', '--since', '7d'], '/w', NOW)
    expect(parsed.kind).toBe('error')
  })

  it('resolves --since 7d relative to the given "now"', () => {
    const parsed = parseReportArgs(['--since', '7d'], '/w', NOW)
    expect(parsed).toEqual({ kind: 'report', options: expect.objectContaining({ sinceMs: NOW - 7 * 86_400_000 }) })
  })

  it('accepts --since in minutes and hours too', () => {
    expect(parseReportArgs(['--since', '30m'], '/w', NOW)).toEqual({
      kind: 'report',
      options: expect.objectContaining({ sinceMs: NOW - 30 * 60_000 }),
    })
    expect(parseReportArgs(['--since', '12h'], '/w', NOW)).toEqual({
      kind: 'report',
      options: expect.objectContaining({ sinceMs: NOW - 12 * 3_600_000 }),
    })
  })

  it('rejects a --since value that is not <N>m, <N>h, or <N>d', () => {
    const parsed = parseReportArgs(['--since', '7days'], '/w', NOW)
    expect(parsed).toEqual({ kind: 'error', message: expect.stringContaining('--since must look like') })
  })

  it('--last and --since combine (since filters, last caps)', () => {
    const parsed = parseReportArgs(['--since', '7d', '--last', '5'], '/w', NOW)
    expect(parsed).toEqual({
      kind: 'report',
      options: expect.objectContaining({ sinceMs: NOW - 7 * 86_400_000, last: 5 }),
    })
  })

  it('rejects a non-numeric or non-positive --last', () => {
    expect(parseReportArgs(['--last', 'abc'], '/w', NOW).kind).toBe('error')
    expect(parseReportArgs(['--last', '0'], '/w', NOW).kind).toBe('error')
    expect(parseReportArgs(['--last', '-3'], '/w', NOW).kind).toBe('error')
  })

  it('rejects an unrecognised --redact value', () => {
    const parsed = parseReportArgs(['--redact', 'paranoid'], '/w', NOW)
    expect(parsed).toEqual({ kind: 'error', message: expect.stringContaining('--redact must be default or strict') })
  })

  it('accepts --out, --open, --include-prompt, and --redact strict together', () => {
    const parsed = parseReportArgs(['--out', 'report.html', '--open', '--include-prompt', '--redact', 'strict'], '/w', NOW)
    expect(parsed).toEqual({
      kind: 'report',
      options: expect.objectContaining({ out: 'report.html', open: true, includePrompt: true, redact: 'strict' }),
    })
  })

  it('accepts the --flag=value form for every value-taking flag', () => {
    const parsed = parseReportArgs(['--job=job-9', '--out=x.html'], '/w', NOW)
    expect(parsed).toEqual({
      kind: 'report',
      options: expect.objectContaining({ jobId: 'job-9', out: 'x.html' }),
    })
  })

  it('rejects an unknown flag', () => {
    expect(parseReportArgs(['--wat'], '/w', NOW)).toEqual({ kind: 'error', message: 'unknown argument: --wat' })
  })
})

describe('runReport', () => {
  let base: string
  let projectRoot: string
  let originalProjectRoot: string | undefined
  let originalStateHome: string | undefined

  beforeEach(() => {
    originalProjectRoot = process.env.AGY_WORKER_PROJECT
    originalStateHome = process.env.AGY_WORKER_HOME

    // Resolve symlinks up front (macOS's tmpdir() is one) — `resolveProjectRoot`
    // canonicalizes internally, and a raw vs. resolved mismatch here would make
    // the project-key hash computed by the test disagree with the one `runReport`
    // computes, sending it looking for the job directory in the wrong place.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'agy-report-test-')))
    projectRoot = join(base, 'project')
    mkdirSync(projectRoot, { recursive: true })
    const stateHomeDir = join(base, 'state')

    process.env.AGY_WORKER_PROJECT = projectRoot
    process.env.AGY_WORKER_HOME = stateHomeDir
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
    if (originalProjectRoot !== undefined) process.env.AGY_WORKER_PROJECT = originalProjectRoot
    else delete process.env.AGY_WORKER_PROJECT
    if (originalStateHome !== undefined) process.env.AGY_WORKER_HOME = originalStateHome
    else delete process.env.AGY_WORKER_HOME
  })

  it('produces a valid project report even when usage.jsonl has never been written', () => {
    const result = runReport({
      mode: 'project',
      jobId: null,
      sinceMs: null,
      last: 100,
      out: null,
      open: false,
      includePrompt: false,
      redact: 'default',
      cwd: base,
    })
    expect(result.ok).toBe(true)
    expect(result.outPath).toBeDefined()
    expect(existsSync(result.outPath!)).toBe(true)
    const html = readFileSync(result.outPath!, 'utf8')
    expect(html).toContain('Overview')
    expect(html).toContain('Denied-rule table')
  })

  it('writes the default project filename as agy-worker-report-<YYYYMMDD-HHmm>.html under cwd', () => {
    const result = runReport({
      mode: 'project',
      jobId: null,
      sinceMs: null,
      last: 100,
      out: null,
      open: false,
      includePrompt: false,
      redact: 'default',
      cwd: base,
    })
    expect(result.outPath).toMatch(/agy-worker-report-\d{8}-\d{4}\.html$/)
    expect(result.outPath!.startsWith(base)).toBe(true)
  })

  it('fails with exit-worthy ok:false for an unknown job id, and writes nothing', () => {
    const result = runReport({
      mode: 'job',
      jobId: 'does-not-exist',
      sinceMs: null,
      last: 100,
      out: null,
      open: false,
      includePrompt: false,
      redact: 'default',
      cwd: base,
    })
    expect(result.ok).toBe(false)
    expect(result.outPath).toBeUndefined()
    expect(result.text).toContain('does-not-exist')
  })

  it('respects an explicit --out path resolved against cwd', () => {
    const result = runReport({
      mode: 'project',
      jobId: null,
      sinceMs: null,
      last: 100,
      out: 'custom-name.html',
      open: false,
      includePrompt: false,
      redact: 'default',
      cwd: base,
    })
    expect(result.outPath).toBe(join(base, 'custom-name.html'))
    expect(existsSync(result.outPath!)).toBe(true)
  })

  it('generates a complete job report end to end from a fake job directory, with the expected headings', () => {
    const paths = ensureProjectDirs(projectPaths(projectRoot))
    const jobId = 'job-e2e-1'
    const paths2 = ensureJobDirs(jobPaths(paths, jobId))

    writeFileSync(
      paths2.brokerResult,
      JSON.stringify({
        schema_version: 4,
        job_id: jobId,
        session_id: 'sess-1',
        conversation_id: null,
        lifecycle: 'finished',
        cwd: projectRoot,
        profile: 'general_worker',
        session_mode: 'oneshot',
        created_at: 1000,
        started_at: 1000,
        finished_at: 2000,
        agent_report: { status: 'SUCCESS', response: 'done', error: null, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, conversation_id: null },
        broker_summary: {
          headline: 'Job finished: verified_success.',
          outcome: 'verified_success',
          exit_code: 0,
          duration_ms: 1000,
          counts: { events: 2, steps: 2, tool_calls: 1, tool_errors: 0, turns: 1, malformed_lines: 0 },
          log_tail: [],
        },
        verification: { blockers: [], expected_artifacts: [], changed_files: [], warnings: [], contract_status: 'not_required', checked_at: 2000, verify: null },
        workspace: { kind: 'in_place', path: projectRoot, branch: null, base_commit: null, head_commit: null, committed: false, changed_file_count: 0 },
        agent_status: 'SUCCESS',
        contract_status: 'not_required',
        structured_output: null,
        finalized_at: 2000,
      }),
    )
    writeFileSync(
      paths2.effectiveConfig,
      JSON.stringify({
        job_id: jobId,
        session_id: 'sess-1',
        conversation_id: null,
        cwd: projectRoot,
        profile: 'general_worker',
        model: 'gemini-3.8-flash-high',
        effort: 'high',
        mode: null,
        session_mode: 'oneshot',
        on_denial: 'continue',
        write_mode: true,
        timeout_ms: 60000,
        deadline_at: 61000,
        idle_timeout_ms: null,
        expected_artifacts: [],
        json_schema_path: null,
        policy: {
          profile: 'general_worker',
          workspace: projectRoot,
          read_roots: [projectRoot],
          write_roots: [projectRoot],
          allow: ['command(npx vitest)'],
          deny: ['command(git push)'],
          sandbox: 'none',
          sandbox_source: 'default',
          seatbelt_write_roots: [],
        },
        add_dirs: [],
        verify: null,
        argv: ['agy'],
        agy_bin: '/usr/local/bin/agy',
        agy_version: '1.1.27',
        env: {},
        created_at: 1000,
        worktree: null,
      }),
    )
    writeFileSync(paths2.state, JSON.stringify({ job_id: jobId, lifecycle: 'finished', pid: null, pgid: null, proc_start_time: null, started_at: 1000, finished_at: 2000, updated_at: 2000, gate_confirmed: true }))
    writeFileSync(
      paths2.gateLog,
      [
        JSON.stringify({ ts: 1000, step_idx: 0, tool: 'run_command', command: 'npm test', decision: 'allow', policy: 'ceiling' }),
      ].join('\n') + '\n',
    )
    writeFileSync(
      paths2.events,
      [
        JSON.stringify({ event: 'init', conversation_id: 'conv-1', init: { model: 'gemini-3.8-flash-high', cwd: projectRoot } }),
        JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'All done.', duration_seconds: 1 } }),
      ].join('\n') + '\n',
    )
    writeFileSync(paths2.stderr, '')

    const result = runReport({
      mode: 'job',
      jobId,
      sinceMs: null,
      last: 100,
      out: null,
      open: false,
      includePrompt: false,
      redact: 'default',
      cwd: base,
    })

    expect(result.ok).toBe(true)
    expect(result.outPath).toBe(join(base, `agy-worker-report-${jobId}.html`))
    const html = readFileSync(result.outPath!, 'utf8')
    expect(html).toContain('Verdict')
    expect(html).toContain('Blockers')
    expect(html).toContain('Gate-log table');
    expect(html).toContain('Timeline')
    expect(html).toContain('Changed files and workspace')
    expect(html).toContain('Environment')
    expect(html).toContain('Raw')
    // request.json was never written and --include-prompt was not passed, so it must not be missing from the report's own list either
    expect(html).not.toContain('request.json')
  })
})
