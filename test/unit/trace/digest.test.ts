import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  digestJob,
  digestProject,
  loadJobDigest,
  renderDigest,
  type JobDigest,
} from '../../../src/trace/digest.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const FIXTURES_DIR = join(REPO, 'test', 'fixtures', 'jobs')

function loadFixtureWorkspace(jobDir: string): string | null {
  const brokerResultPath = join(jobDir, 'broker-result.json')
  try {
    const br = JSON.parse(readFileSync(brokerResultPath, 'utf8')) as Record<string, unknown>
    if (typeof br.cwd === 'string') return br.cwd
  } catch {}

  const requestPath = join(jobDir, 'request.json')
  try {
    const req = JSON.parse(readFileSync(requestPath, 'utf8')) as Record<string, unknown>
    if (typeof req.cwd === 'string') return req.cwd
  } catch {}

  return null
}

describe('Execution trace digest', () => {
  describe('loadJobDigest on real job fixtures', () => {
    it('digests mtsdz8oj-63578581 (verified_success with 90 tool calls)', () => {
      const jobDir = join(FIXTURES_DIR, 'mtsdz8oj-63578581')
      const ws = loadFixtureWorkspace(jobDir)
      expect(ws).toBeTruthy()

      const digest = loadJobDigest(jobDir, ws)
      expect(digest.outcome).toBe('verified_success')
      expect(digest.trace).toBe('full')
      expect(digest.commands.length).toBe(12)
      expect(digest.denials.length).toBe(0)

      // Top command assertions
      expect(digest.commands[0]).toEqual({
        command: 'npm run typecheck',
        count: 4,
        denied: 0,
      })

      // Files assertions
      expect(digest.files.edited.length).toBe(6)
      for (const editedPath of digest.files.edited) {
        expect(editedPath.startsWith('/')).toBe(false)
        if (ws) {
          expect(editedPath.startsWith(ws)).toBe(false)
        }
      }
      expect(digest.files.read_count).toBe(36)
      expect(digest.tool_errors.length).toBe(1)
    })

    it('digests mtsdyqbd-31e956b5 (blocked with denials)', () => {
      const jobDir = join(FIXTURES_DIR, 'mtsdyqbd-31e956b5')
      const ws = loadFixtureWorkspace(jobDir)
      expect(ws).toBeTruthy()

      const digest = loadJobDigest(jobDir, ws)
      expect(digest.outcome).toBe('blocked')
      expect(digest.trace).toBe('full')
      expect(digest.commands.length).toBe(15)
      expect(digest.denials.length).toBe(2)
      expect(digest.denials[0]?.stage).toBe('default')
      expect(digest.denials.map((d) => d.required_rule)).toEqual([
        'command(git show)',
        'command(npx vitest --version)',
      ])
      expect(digest.tool_errors.length).toBe(0)
    })

    it('digests mtscrnb1-8f9f63a0 (canceled)', () => {
      const jobDir = join(FIXTURES_DIR, 'mtscrnb1-8f9f63a0')
      const ws = loadFixtureWorkspace(jobDir)
      expect(ws).toBeTruthy()

      const digest = loadJobDigest(jobDir, ws)
      expect(digest.outcome).toBe('canceled')
      expect(digest.trace).toBe('full')
      expect(digest.commands.length).toBe(2)
      expect(digest.denials.length).toBe(1)
      expect(digest.denials[0]?.tool).toBe('schedule')
      expect(digest.denials[0]?.required_rule).toBeNull()
      expect(digest.tool_errors.length).toBe(0)
    })
  })

  describe('digestJob edge cases', () => {
    it('returns empty trace and empty arrays for all-null inputs', () => {
      const digest = digestJob({
        job_id: 'empty-job',
        workspace: null,
        gateLog: null,
        events: null,
        brokerResult: null,
      })

      expect(digest.job_id).toBe('empty-job')
      expect(digest.trace).toBe('empty')
      expect(digest.outcome).toBeNull()
      expect(digest.exit_code).toBeNull()
      expect(digest.duration_ms).toBeNull()
      expect(digest.turns).toBeNull()
      expect(digest.commands).toEqual([])
      expect(digest.files).toEqual({
        read: [],
        edited: [],
        read_count: 0,
        edited_count: 0,
      })
      expect(digest.denials).toEqual([])
      expect(digest.tool_errors).toEqual([])
    })

    it('returns no_gate_log when gateLog is null but events are present', () => {
      const dummyEvents = JSON.stringify({
        event: 'step_update',
        step_update: {
          step_index: 1,
          step_type: 'tool',
          tool_name: 'view_file',
          state: 'DONE',
          tool_info: {
            parameters: { AbsolutePath: '/workspace/foo.ts' },
          },
        },
      })

      const digest = digestJob({
        job_id: 'no-gate-job',
        workspace: '/workspace',
        gateLog: null,
        events: dummyEvents,
        brokerResult: null,
      })

      expect(digest.trace).toBe('no_gate_log')
      expect(digest.files.read).toEqual(['foo.ts'])
      expect(digest.files.read_count).toBe(1)
    })
  })

  describe('renderDigest', () => {
    it('matches inline snapshot for mtsdz8oj-63578581', () => {
      const jobDir = join(FIXTURES_DIR, 'mtsdz8oj-63578581')
      const ws = loadFixtureWorkspace(jobDir)
      const digest = loadJobDigest(jobDir, ws)
      const rendered = renderDigest(digest)

      expect(rendered).toMatchInlineSnapshot(`
        "job mtsdz8oj-63578581 · verified_success · exit 0 · 7.3min · 1 turn
        commands (17 allowed, 0 denied)
          ×4  npm run typecheck
          ×3  npx vitest run test/unit/server
          ×1  git diff src/
          ×1  git status
          ×1  git status --short test/unit/server/
          ×1  ls -la test/unit/server/
          ×1  npx vitest run test/unit/server/cancel.test.ts
          ×1  npx vitest run test/unit/server/list-jobs.test.ts
          ×1  npx vitest run test/unit/server/logs.test.ts
          ×1  npx vitest run test/unit/server/result.test.ts
          ×1  npx vitest run test/unit/server/send.test.ts
          ×1  npx vitest run test/unit/server/sessions.test.ts
        files
          read 36: ., src, src/broker/reconcile.ts, src/broker/result.ts, src/contract/errors.ts, src/contract/paths.ts, src/contract/schema.sql, src/contract/types.ts, … +28 more
          edited 6: test/unit/server/cancel.test.ts, test/unit/server/list-jobs.test.ts, test/unit/server/logs.test.ts, test/unit/server/result.test.ts, test/unit/server/send.test.ts, test/unit/server/sessio…
        denials 0
        tool_errors 1
          #44 view_file: declaring permissions: cortex tool view_file: convert tool call for permissions: model output error: invalid tool call error (invalid_args) failed to read file: open /workspace/.work…"
      `)
    })
  })

  describe('digestProject', () => {
    it('aggregates across the three fixtures', () => {
      const fixtureIds = ['mtsdz8oj-63578581', 'mtsdyqbd-31e956b5', 'mtscrnb1-8f9f63a0']
      const digests: JobDigest[] = []
      const gateLogsById: Record<string, string | null> = {}

      for (const id of fixtureIds) {
        const jobDir = join(FIXTURES_DIR, id)
        const ws = loadFixtureWorkspace(jobDir)
        digests.push(loadJobDigest(jobDir, ws))
        const gateLogPath = join(jobDir, 'gate-log.jsonl')
        gateLogsById[id] = readFileSync(gateLogPath, 'utf8')
      }

      const project = digestProject(digests, gateLogsById)

      expect(project.jobs).toBe(3)
      expect(project.outcomes).toEqual({
        verified_success: 1,
        blocked: 1,
        canceled: 1,
      })

      expect(project.denied_rules.length).toBeGreaterThan(0)
      // Check sorted descending by count
      for (let i = 1; i < project.denied_rules.length; i++) {
        const prev = project.denied_rules[i - 1]
        const curr = project.denied_rules[i]
        if (prev && curr) {
          expect(prev.count).toBeGreaterThanOrEqual(curr.count)
        }
      }

      // Check last_job_id points to mtsdyqbd
      expect(project.denied_rules[0]?.last_job_id).toBe('mtsdyqbd-31e956b5')
      expect(project.top_commands.length).toBeGreaterThan(0)
      expect(project.top_commands.length).toBeLessThanOrEqual(20)
    })
  })
})
