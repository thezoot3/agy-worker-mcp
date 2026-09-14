/**
 * `src/usage/record.ts` — the permanent `usage.jsonl` layer
 * (docs/.local/13-usage-and-debug-records.md §2).
 *
 * Covers the pure core (`buildUsageRecord`, including the privacy trim on
 * `denials`/`blockers`) and the small amount of I/O around it: rotation, the
 * 4 KiB line cap, the stamp guard, and the `AGY_WORKER_USAGE=off` switch that
 * `finalizeCore` (`src/broker/reconcile.ts`) honours end to end.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { reconcileJob } from '../../../src/broker/reconcile.js'
import { ensureJobDirs, jobPaths, type ProjectPaths } from '../../../src/contract/paths.js'
import { ENV, type BrokerResult, type EffectiveConfig, type JobRow } from '../../../src/contract/types.js'
import type { JobDigest } from '../../../src/trace/digest.js'
import {
  appendUsage,
  buildUsageRecord,
  hasUsageStamp,
  writeUsageStamp,
} from '../../../src/usage/record.js'
import { getJob } from '../../../src/store/jobs.js'
import { makeTestStore, markRunning, newTestJob, type TestStoreHandle } from '../helpers/store.js'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures for the pure core
// ─────────────────────────────────────────────────────────────────────────────

function fixtureJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    job_id: 'test-job-1',
    session_id: 'sess-1',
    lifecycle: 'finished',
    outcome: 'verified_success',
    headline: 'ok',
    cwd: '/tmp/workspace',
    profile: 'general_worker',
    write_mode: 1,
    session_mode: 'oneshot',
    pid: 111,
    pgid: 111,
    proc_start_time: null,
    created_at: 1_000,
    started_at: 1_200,
    finished_at: 185_413,
    deadline_at: null,
    exit_code: 0,
    agent_status: 'SUCCESS',
    contract_status: 'not_required',
    on_denial: 'continue',
    requested_by: null,
    parent_task_id: null,
    ...overrides,
  }
}

// `as unknown as EffectiveConfig`: only the fields `buildUsageRecord` reads
// (model/effort/worktree/policy.sandbox/agy_version) matter here, matching
// the same shortcut `test/unit/runner/spawn.test.ts` takes for a fixture that
// is never passed through the parts of `EffectiveConfig` it omits.
function fixtureConfig(overrides: Record<string, unknown> = {}): EffectiveConfig {
  return {
    model: 'gemini-3.8-flash-high',
    effort: 'high',
    worktree: null,
    agy_version: '1.1.27',
    policy: { sandbox: 'none' },
    ...overrides,
  } as unknown as EffectiveConfig
}

function fixtureResult(overrides: Partial<BrokerResult> = {}): BrokerResult {
  return {
    schema_version: 4,
    job_id: 'test-job-1',
    session_id: 'sess-1',
    conversation_id: null,
    lifecycle: 'finished',
    cwd: '/tmp/workspace',
    profile: 'general_worker',
    session_mode: 'oneshot',
    created_at: 1_000,
    started_at: 1_200,
    finished_at: 185_413,
    agent_report: {
      status: 'SUCCESS',
      response: null,
      error: null,
      num_turns: 3,
      usage: { input_tokens: 41_233, output_tokens: 8_120, total_tokens: 49_353, cache_read_tokens: 38_000 },
      conversation_id: null,
    },
    broker_summary: {
      headline: 'ok',
      outcome: 'verified_success',
      exit_code: 0,
      duration_ms: 184_213,
      counts: { events: 812, steps: 44, tool_calls: 39, tool_errors: 1, turns: 3, malformed_lines: 0 },
      log_tail: [],
    },
    verification: {
      blockers: [
        {
          source: 'gate',
          actionable: true,
          remedy: 'command(npx vitest)',
          blocks_outcome: false,
          tool: 'run_command',
          command: 'npx vitest --run some/secret/path.test.ts',
          message: 'denied: command(npx vitest) not in allowlist',
          detail: { policy: 'default' },
        },
      ],
      expected_artifacts: [],
      changed_files: ['a.ts'],
      warnings: [],
      contract_status: 'not_required',
      checked_at: 0,
      verify: {
        command: 'npx vitest',
        exit_code: 0,
        signal: null,
        started_at: 0,
        duration_ms: 100,
        timed_out: false,
        output_tail: '',
      },
    },
    workspace: {
      kind: 'in_place',
      path: '/tmp/workspace',
      branch: null,
      base_commit: null,
      head_commit: null,
      committed: false,
      changed_file_count: 7,
    },
    agent_status: 'SUCCESS',
    contract_status: 'not_required',
    structured_output: null,
    finalized_at: 185_500,
    ...overrides,
  }
}

function fixtureDigest(overrides: Partial<JobDigest> = {}): JobDigest {
  return {
    job_id: 'test-job-1',
    outcome: 'verified_success',
    exit_code: 0,
    duration_ms: 184_213,
    turns: 3,
    commands: [],
    files: { read: Array.from({ length: 12 }, (_, i) => `read-${i}.ts`), edited: ['b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'], read_count: 12, edited_count: 5 },
    denials: [{ tool: 'run_command', command: 'npx vitest --run some/secret/path.test.ts', stage: 'default', required_rule: 'command(npx vitest)', count: 3 }],
    tool_errors: [],
    trace: 'full',
    ...overrides,
  }
}

const FIXTURE_ENVIRONMENT = { agyVersion: '1.1.27', packageVersion: '0.4.0', nodeVersion: 'v24.21.0', platform: 'darwin' }
const FIXTURE_REDACTION = { home: '/Users/fixture', workspace: '/tmp/workspace' }

describe('buildUsageRecord — the two fields built out of the run', () => {
  // `requiredRuleFor` spells a command rule as the whole command line
  // (src/policy/rules.ts), so whatever the agent typed — a credential
  // included — arrives here. This file is permanent, so it must not.
  it('scrubs a secret out of a denied command line before recording it', () => {
    const record = buildUsageRecord({
      job: fixtureJob(),
      config: fixtureConfig(),
      result: fixtureResult(),
      digest: fixtureDigest({
        denials: [
          {
            tool: 'run_command',
            command: 'curl ...',
            stage: 'deny_list',
            required_rule: 'command(curl -H Authorization: Bearer ghp_abcdEFGH0123456789abcd https://example.com)',
            count: 1,
          },
        ],
      }),
      finishedAt: 0,
      environment: FIXTURE_ENVIRONMENT,
      redaction: FIXTURE_REDACTION,
    })

    const rule = record.denials[0]!.required_rule!
    expect(rule).not.toContain('ghp_abcdEFGH0123456789abcd')
    expect(rule).toContain('[redacted:')
    // the command itself stays legible — that is what agy_ceiling groups by
    expect(rule).toContain('command(curl')
  })

  it('rewrites home and workspace paths in a rule and in a blocker remedy', () => {
    const record = buildUsageRecord({
      job: fixtureJob(),
      config: fixtureConfig(),
      result: fixtureResult({
        verification: {
          ...fixtureResult().verification,
          blockers: [
            {
              source: 'gate',
              actionable: true,
              remedy: 'add a glob covering /Users/fixture/other-project to read_roots',
              blocks_outcome: false,
              tool: 'run_command',
              command: 'cat /Users/fixture/other-project/x',
              message: 'read outside workspace',
            },
          ],
        },
      }),
      digest: fixtureDigest({
        denials: [
          {
            tool: 'run_command',
            command: 'cat',
            stage: 'containment',
            required_rule: 'read_file(/tmp/workspace/src/index.ts)',
            count: 1,
          },
        ],
      }),
      finishedAt: 0,
      environment: FIXTURE_ENVIRONMENT,
      redaction: FIXTURE_REDACTION,
    })

    expect(record.denials[0]!.required_rule).toBe('read_file(<workspace>/src/index.ts)')
    expect(record.blockers[0]!.remedy).toBe('add a glob covering ~/other-project to read_roots')
  })

  it('clips a rule long enough to threaten the line budget', () => {
    const record = buildUsageRecord({
      job: fixtureJob(),
      config: fixtureConfig(),
      result: fixtureResult(),
      digest: fixtureDigest({
        denials: [
          {
            tool: 'run_command',
            command: 'x',
            stage: 'default',
            required_rule: `command(${'a'.repeat(4000)})`,
            count: 1,
          },
        ],
      }),
      finishedAt: 0,
      environment: FIXTURE_ENVIRONMENT,
      redaction: FIXTURE_REDACTION,
    })

    const rule = record.denials[0]!.required_rule!
    expect(rule.length).toBe(240)
    expect(rule.endsWith('\u2026')).toBe(true)
  })
})

describe('buildUsageRecord — schema shape', () => {
  it('projects a full job onto the v1 shape', () => {
    const record = buildUsageRecord({
      job: fixtureJob(),
      config: fixtureConfig(),
      result: fixtureResult(),
      digest: fixtureDigest(),
      finishedAt: 1_757_817_600_000,
      environment: FIXTURE_ENVIRONMENT,
      redaction: FIXTURE_REDACTION,
    })

    expect(record.v).toBe(1)
    expect(record.ts).toBe(1_757_817_600_000)
    expect(record.job_id).toBe('test-job-1')
    expect(record.session_id).toBe('sess-1')
    expect(record.profile).toBe('general_worker')
    expect(record.model).toBe('gemini-3.8-flash-high')
    expect(record.effort).toBe('high')
    expect(record.session_mode).toBe('oneshot')
    expect(record.isolation).toBe('in_place')
    expect(record.sandbox).toBe('none')
    expect(record.on_denial).toBe('continue')
    expect(record.outcome).toBe('verified_success')
    expect(record.contract_status).toBe('not_required')
    expect(record.agent_status).toBe('SUCCESS')
    expect(record.exit_code).toBe(0)
    expect(record.duration_ms).toBe(184_213)
    expect(record.queued_ms).toBe(200)
    expect(record.counts).toEqual({ events: 812, steps: 44, tool_calls: 39, tool_errors: 1, turns: 3, malformed_lines: 0 })
    expect(record.usage).toEqual({ input_tokens: 41_233, output_tokens: 8_120, total_tokens: 49_353, cache_read_tokens: 38_000 })
    expect(record.files).toEqual({ read: 12, edited: 5 })
    expect(record.verify).toEqual({ ran: true, passed: true })
    expect(record.workspace).toEqual({ kind: 'in_place', changed_files: 7 })
    expect(record.env).toEqual({ agy: '1.1.27', pkg: '0.4.0', node: 'v24.21.0', platform: 'darwin' })
  })

  it('keeps only rule strings and enums in denials — never the raw tool/command', () => {
    const record = buildUsageRecord({
      job: fixtureJob(),
      config: fixtureConfig(),
      result: fixtureResult(),
      digest: fixtureDigest(),
      finishedAt: 0,
      environment: FIXTURE_ENVIRONMENT,
      redaction: FIXTURE_REDACTION,
    })

    expect(record.denials).toEqual([{ stage: 'default', required_rule: 'command(npx vitest)', count: 3 }])
    expect(Object.keys(record.denials[0]!).sort()).toEqual(['count', 'required_rule', 'stage'])
  })

  it('keeps only source/actionable/remedy in blockers — never message, command, tool or detail', () => {
    const record = buildUsageRecord({
      job: fixtureJob(),
      config: fixtureConfig(),
      result: fixtureResult(),
      digest: fixtureDigest(),
      finishedAt: 0,
      environment: FIXTURE_ENVIRONMENT,
      redaction: FIXTURE_REDACTION,
    })

    expect(record.blockers).toEqual([{ source: 'gate', actionable: true, remedy: 'command(npx vitest)' }])
    expect(Object.keys(record.blockers[0]!).sort()).toEqual(['actionable', 'remedy', 'source'])
    expect(JSON.stringify(record.blockers)).not.toContain('secret/path')
  })

  it('reports isolation: worktree when the job ran in one', () => {
    const record = buildUsageRecord({
      job: fixtureJob(),
      config: fixtureConfig({
        worktree: { path: '/tmp/wt', branch: 'agy/x', base_ref: 'main', base_commit: 'abc', linked: [] },
      }),
      result: fixtureResult(),
      digest: fixtureDigest(),
      finishedAt: 0,
      environment: FIXTURE_ENVIRONMENT,
      redaction: FIXTURE_REDACTION,
    })
    expect(record.isolation).toBe('worktree')
  })

  it('falls back cleanly when there is no effective-config.json at all', () => {
    const record = buildUsageRecord({
      job: fixtureJob({ started_at: null }),
      config: null,
      result: fixtureResult(),
      digest: fixtureDigest(),
      finishedAt: 0,
      environment: { ...FIXTURE_ENVIRONMENT, agyVersion: null },
      redaction: FIXTURE_REDACTION,
    })
    expect(record.model).toBeNull()
    expect(record.effort).toBeNull()
    expect(record.isolation).toBe('in_place')
    expect(record.sandbox).toBeNull()
    expect(record.queued_ms).toBeNull()
    expect(record.env.agy).toBeNull()
  })

  it('reports verify: {ran:false, passed:false} when no verify_command ran', () => {
    const record = buildUsageRecord({
      job: fixtureJob(),
      config: fixtureConfig(),
      result: fixtureResult({ verification: { ...fixtureResult().verification, verify: null } }),
      digest: fixtureDigest(),
      finishedAt: 0,
      environment: FIXTURE_ENVIRONMENT,
      redaction: FIXTURE_REDACTION,
    })
    expect(record.verify).toEqual({ ran: false, passed: false })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// appendUsage: rotation, the 4 KiB line cap, and the stamp primitives
// ─────────────────────────────────────────────────────────────────────────────

function fixtureRecord(overrides: Partial<ReturnType<typeof buildUsageRecord>> = {}) {
  const base = buildUsageRecord({
    job: fixtureJob(),
    config: fixtureConfig(),
    result: fixtureResult(),
    digest: fixtureDigest(),
    finishedAt: 42,
    environment: FIXTURE_ENVIRONMENT,
      redaction: FIXTURE_REDACTION,
  })
  return { ...base, ...overrides }
}

let projectDir: string
let paths: ProjectPaths

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'agy-usage-test-'))
  paths = {
    root: '/fake/root',
    source: 'cwd',
    key: 'fakekey',
    dir: projectDir,
    projectJson: join(projectDir, 'project.json'),
    db: join(projectDir, 'index.db'),
    jobsDir: join(projectDir, 'jobs'),
    usageLog: join(projectDir, 'usage.jsonl'),
  }
})

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true })
})

describe('appendUsage — rotation', () => {
  it('rotates usage.jsonl to usage.1.jsonl once the file reaches 5 MiB, overwriting an existing generation', () => {
    const oldGenerationMarker = 'STALE-GENERATION-MARKER\n'
    writeFileSync(join(projectDir, 'usage.1.jsonl'), oldGenerationMarker)

    const filler = 'x'.repeat(5 * 1024 * 1024)
    writeFileSync(paths.usageLog, filler)
    expect(statSync(paths.usageLog).size).toBeGreaterThanOrEqual(5 * 1024 * 1024)

    appendUsage(paths, fixtureRecord())

    const rotated = readFileSync(join(projectDir, 'usage.1.jsonl'), 'utf8')
    expect(rotated).toBe(filler)
    expect(rotated).not.toContain(oldGenerationMarker)

    const current = readFileSync(paths.usageLog, 'utf8').trim().split('\n')
    expect(current).toHaveLength(1)
    expect(JSON.parse(current[0]!).job_id).toBe('test-job-1')
  })

  it('does not rotate below the threshold', () => {
    writeFileSync(paths.usageLog, JSON.stringify({ v: 1 }) + '\n')
    appendUsage(paths, fixtureRecord())
    expect(existsSync(join(projectDir, 'usage.1.jsonl'))).toBe(false)
    expect(readFileSync(paths.usageLog, 'utf8').trim().split('\n')).toHaveLength(2)
  })
})

describe('appendUsage — 4 KiB line cap', () => {
  it('trims an absurd number of denials so the serialised line stays under 4096 bytes', () => {
    const manyDenials = Array.from({ length: 500 }, (_, i) => ({
      stage: 'default',
      required_rule: `command(some-very-long-rule-name-for-padding-${i})`,
      count: 1,
    }))
    const record = fixtureRecord({ denials: manyDenials as never })!

    appendUsage(paths, record)

    const line = readFileSync(paths.usageLog, 'utf8').trim()
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(4096)
    const parsed = JSON.parse(line)
    expect(parsed.denials.length).toBeLessThanOrEqual(20)
  })
})

describe('usage.stamp', () => {
  it('starts absent and is set by writeUsageStamp', () => {
    const jobDir = mkdtempSync(join(tmpdir(), 'agy-usage-job-'))
    try {
      expect(hasUsageStamp(jobDir)).toBe(false)
      writeUsageStamp(jobDir)
      expect(hasUsageStamp(jobDir)).toBe(true)
    } finally {
      rmSync(jobDir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// End to end through `finalizeCore` (src/broker/reconcile.ts): the stamp
// guard against a double append, and the AGY_WORKER_USAGE=off switch.
// ─────────────────────────────────────────────────────────────────────────────

/** A pid that certainly belonged to a process which has already exited. */
function deadPid(): number {
  const r = spawnSync('true')
  if (r.pid == null || r.pid <= 0) throw new Error('spawnSync produced no pid')
  return r.pid
}

let handle: TestStoreHandle
let originalUsageEnv: string | undefined

beforeEach(() => {
  handle = makeTestStore()
  originalUsageEnv = process.env[ENV.USAGE]
})

afterEach(() => {
  handle.cleanup()
  if (originalUsageEnv === undefined) delete process.env[ENV.USAGE]
  else process.env[ENV.USAGE] = originalUsageEnv
})

function finishedJob(jobId: string): JobRow {
  const job = newTestJob(handle.store, { jobId, cwd: handle.workspace })
  const jobDirs = ensureJobDirs(jobPaths(handle.store.paths, job.job_id))
  markRunning(handle.store, job.job_id, deadPid(), null)
  writeFileSync(jobDirs.exitCode, '0\n')
  return getJob(handle.store, job.job_id)
}

describe('finalizeCore integration — usage.jsonl', () => {
  it('appends exactly one line and stamps the job directory', async () => {
    delete process.env[ENV.USAGE]
    const job = finishedJob('usage-int-1')

    const after = await reconcileJob(handle.store, job)
    expect(after.lifecycle).toBe('finished')

    expect(existsSync(handle.store.paths.usageLog)).toBe(true)
    const lines = readFileSync(handle.store.paths.usageLog, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).job_id).toBe('usage-int-1')

    const stampedPaths = jobPaths(handle.store.paths, 'usage-int-1')
    expect(hasUsageStamp(stampedPaths.dir)).toBe(true)
  })

  it('AGY_WORKER_USAGE=off writes nothing', async () => {
    process.env[ENV.USAGE] = 'off'
    const job = finishedJob('usage-int-off')

    const after = await reconcileJob(handle.store, job)
    expect(after.lifecycle).toBe('finished')

    expect(existsSync(handle.store.paths.usageLog)).toBe(false)
  })
})
