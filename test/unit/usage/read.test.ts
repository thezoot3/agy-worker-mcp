/**
 * `src/usage/read.ts` — the reading side of the permanent `usage.jsonl` layer
 * (docs/operations.md).
 *
 * The two things worth pinning down: a file several processes append to and a
 * power cut can tear must never take the reader down with it, and the roll-up
 * the denied-rule table is built from has to count rules the way a human would
 * — how often, and across how many jobs, which are different questions.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ProjectPaths } from '../../../src/contract/paths.js'
import type { UsageRecord } from '../../../src/contract/types.js'
import { readUsage, rollUp } from '../../../src/usage/read.js'

let dir: string

// `readUsage` reads exactly two fields off `ProjectPaths`, so a fixture with
// those two is honest about what the function needs — the same shortcut
// `test/unit/usage/record.test.ts` takes for `EffectiveConfig`.
function fixturePaths(): ProjectPaths {
  return { dir, usageLog: join(dir, 'usage.jsonl') } as unknown as ProjectPaths
}

function fixtureRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    v: 1,
    ts: 1_757_817_600_000,
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
    duration_ms: 1_000,
    queued_ms: 10,
    counts: { events: 1, steps: 1, tool_calls: 1, tool_errors: 0, turns: 1, malformed_lines: 0 },
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, cache_read_tokens: 50 },
    files: { read: 1, edited: 1 },
    denials: [],
    blockers: [],
    verify: { ran: false, passed: false },
    workspace: { kind: 'in_place', changed_files: 0 },
    env: { agy: '1.1.27', pkg: '0.4.0', node: 'v24.21.0', platform: 'darwin' },
    ...overrides,
  } as UsageRecord
}

function writeLog(name: string, lines: string[]): void {
  writeFileSync(join(dir, name), lines.join('\n') + '\n')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agy-usage-read-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readUsage', () => {
  it('returns an empty window rather than throwing when nothing has been recorded yet', () => {
    const result = readUsage(fixturePaths())
    expect(result).toEqual({ records: [], malformed: 0, rotated: false })
  })

  it('reads the rotated generation and the live one together, oldest first', () => {
    writeLog('usage.1.jsonl', [JSON.stringify(fixtureRecord({ job_id: 'old', ts: 1_000 }))])
    writeLog('usage.jsonl', [JSON.stringify(fixtureRecord({ job_id: 'new', ts: 2_000 }))])

    const result = readUsage(fixturePaths())

    expect(result.records.map((r) => r.job_id)).toEqual(['old', 'new'])
    expect(result.rotated).toBe(true)
  })

  it('counts and skips a torn line and an unknown schema version instead of failing', () => {
    writeLog('usage.jsonl', [
      JSON.stringify(fixtureRecord({ job_id: 'a', ts: 1_000 })),
      '{"v":1,"job_id":"torn",', // a half-written append
      JSON.stringify({ ...fixtureRecord({ job_id: 'future' }), v: 2 }),
      JSON.stringify(fixtureRecord({ job_id: 'b', ts: 2_000 })),
    ])

    const result = readUsage(fixturePaths())

    expect(result.records.map((r) => r.job_id)).toEqual(['a', 'b'])
    expect(result.malformed).toBe(2)
  })

  it('applies since, then keeps the most recent N', () => {
    writeLog(
      'usage.jsonl',
      [1_000, 2_000, 3_000, 4_000].map((ts) => JSON.stringify(fixtureRecord({ job_id: `j${ts}`, ts }))),
    )

    expect(readUsage(fixturePaths(), { since: 2_000 }).records.map((r) => r.job_id)).toEqual([
      'j2000',
      'j3000',
      'j4000',
    ])
    expect(readUsage(fixturePaths(), { since: 2_000, limit: 2 }).records.map((r) => r.job_id)).toEqual([
      'j3000',
      'j4000',
    ])
  })
})

describe('rollUp', () => {
  it('describes an empty window without inventing numbers', () => {
    const rollup = rollUp([])
    expect(rollup.jobs).toBe(0)
    expect(rollup.window).toEqual({ from: null, to: null })
    expect(rollup.duration_ms).toEqual({ median: null, p90: null })
    expect(rollup.denied_rules).toEqual([])
  })

  it('counts a rule by both how often it was required and how many jobs needed it', () => {
    const rollup = rollUp([
      fixtureRecord({
        job_id: 'a',
        ts: 1_000,
        denials: [{ stage: 'default', required_rule: 'command(npx vitest)', count: 5 }],
      }),
      fixtureRecord({
        job_id: 'b',
        ts: 2_000,
        denials: [
          { stage: 'default', required_rule: 'command(npx vitest)', count: 1 },
          { stage: 'default', required_rule: 'command(npm install)', count: 9 },
        ],
      }),
    ])

    const vitest = rollup.denied_rules.find((r) => r.required_rule === 'command(npx vitest)')!
    expect(vitest.count).toBe(6)
    expect(vitest.jobs).toBe(2)
    expect(vitest.last_job_id).toBe('b')
    // sorted by how often it was required, so the runaway single job leads
    expect(rollup.denied_rules[0]!.required_rule).toBe('command(npm install)')
  })

  it('sums tokens, orders durations, and groups models, days and agy versions', () => {
    const rollup = rollUp([
      fixtureRecord({ job_id: 'a', ts: Date.UTC(2026, 8, 10, 12), duration_ms: 100 }),
      fixtureRecord({
        job_id: 'b',
        ts: Date.UTC(2026, 8, 10, 13),
        duration_ms: 300,
        model: null,
        effort: null,
        env: { agy: '1.1.28', pkg: '0.4.0', node: 'v24.21.0', platform: 'darwin' },
      }),
      fixtureRecord({ job_id: 'c', ts: Date.UTC(2026, 8, 11, 12), duration_ms: 200, usage: null }),
    ])

    expect(rollup.jobs).toBe(3)
    expect(rollup.tokens).toEqual({ input: 200, output: 20, total: 220, cache_read: 100 })
    expect(rollup.duration_ms.median).toBe(200)
    expect(rollup.outcomes).toEqual({ verified_success: 3 })
    expect(rollup.agy_versions).toEqual({ '1.1.27': 2, '1.1.28': 1 })
    // a job that named no model is a real answer about how the worker is used
    expect(rollup.models.map((m) => m.model).sort()).toEqual(['(default)', 'gemini-3.8-flash-high'])
    expect(rollup.by_day).toHaveLength(2)
    expect(rollup.by_day[0]!.day < rollup.by_day[1]!.day).toBe(true)
  })

  it('lists only the outcomes that mean the job did not do what was asked, newest first', () => {
    const rollup = rollUp([
      fixtureRecord({ job_id: 'ok', ts: 1_000, outcome: 'success_unverified' }),
      fixtureRecord({
        job_id: 'blocked-1',
        ts: 2_000,
        outcome: 'blocked',
        blockers: [
          { source: 'gate', actionable: false, remedy: null },
          { source: 'gate', actionable: true, remedy: 'command(npx vitest)' },
        ],
      }),
      fixtureRecord({ job_id: 'crashed', ts: 3_000, outcome: 'process_error' }),
    ])

    expect(rollup.failures.map((f) => f.job_id)).toEqual(['crashed', 'blocked-1'])
    // the first actionable remedy is what tells the reader they can fix it themselves
    expect(rollup.failures[1]!.remedy).toBe('command(npx vitest)')
  })
})
