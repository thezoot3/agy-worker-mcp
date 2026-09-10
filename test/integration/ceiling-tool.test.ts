/**
 * `agy_ceiling` (`src/server/tools/ceiling.ts`): the read-only helper behind
 * the agy-ceiling skill. Without a draft it reports the current file, the
 * effective policy, and denial history; with a draft it reviews the draft
 * and judges expected_commands against it. It never writes policy.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { canonicalize, projectPaths } from '../../src/contract/paths.js'
import type { CeilingReply } from '../../src/contract/types.js'
import { ceilingPath } from '../../src/policy/ceiling.js'
import { applyEnv, makeProject, replyJson, type TestProject } from './helpers.js'

let project: TestProject

beforeEach(() => {
  project = makeProject()
  applyEnv(project, 'happy')
})

function writeCeiling(body: Record<string, unknown>): string {
  const paths = projectPaths(canonicalize(project.root))
  mkdirSync(paths.dir, { recursive: true })
  const p = ceilingPath(paths)
  writeFileSync(p, JSON.stringify(body))
  return p
}

async function call(input: Record<string, unknown>): Promise<CeilingReply> {
  const { createContext } = await import('../../src/server/context.js')
  const { handleCeiling } = await import('../../src/server/tools/ceiling.js')
  const ctx = createContext()
  try {
    return replyJson<CeilingReply>(await handleCeiling(ctx, input as never))
  } finally {
    ctx.store.close()
  }
}

describe('agy_ceiling', () => {
  it('without a file: present false, profile defaults, empty history, writes nothing', async () => {
    const out = await call({})
    expect(out.present).toBe(false)
    expect(out.writes_nothing).toBe(true)
    expect(out.review).toBeNull()
    expect(out.history?.jobs).toBe(0)
    expect(out.effective.deny).toContain('command(git push)')
    expect(out.effective.hard_deny.some((r) => r.includes('.agents'))).toBe(true)
    expect(existsSync(out.path)).toBe(false)
  })

  it('with a v2 file: lifted rules show in effective, history is computed from job dirs', async () => {
    writeCeiling({ version: 2, exceptions: ['command(git push)'], allow: ['command(cargo)'] })
    // a fake job directory with one denial
    const paths = projectPaths(canonicalize(project.root))
    const jobDir = join(paths.jobsDir, 'job1-abcdef')
    mkdirSync(jobDir, { recursive: true })
    writeFileSync(
      join(jobDir, 'gate-log.jsonl'),
      JSON.stringify({
        ts: 1,
        job_id: 'job1-abcdef',
        conversation_id: 'c',
        step_idx: 2,
        tool: 'run_command',
        command: 'make',
        decision: 'deny',
        policy: 'default',
        matched_rule: null,
        reason: 'denied [agy-worker-denial:{"required_rule":"command(make)"}]',
      }) + '\n',
    )
    const out = await call({})
    expect(out.present).toBe(true)
    expect(out.effective.lifted).toEqual(['command(git push)'])
    expect(out.effective.deny).not.toContain('command(git push)')
    expect(out.effective.allow).toContain('command(cargo)')
    expect(out.history?.jobs).toBe(1)
  })

  it('with a draft: review replaces history, preflight judges commands against the draft, file untouched', async () => {
    const p = writeCeiling({ version: 2 })
    const before = readFileSync(p, 'utf8')
    const out = await call({
      draft: { version: 2, allow: ['command(cargo)'], exceptions: ['command(git push)'] },
      expected_commands: ['cargo build', 'git push origin main', 'curl https://x'],
    })
    expect(out.review?.ok).toBe(true)
    expect(out.history).toBeNull()
    expect(out.preflight?.map((c) => c.decision)).toEqual(['allow', 'allow', 'deny'])
    expect(out.effective.lifted).toEqual(['command(git push)'])
    expect(readFileSync(p, 'utf8')).toBe(before)
  })

  it('a draft that would not load: ok false with the loader error, no preflight', async () => {
    const out = await call({ draft: { version: 2, exceptions: [`read_file(${homedir()}/.ssh/**)`] }, expected_commands: ['ls'] })
    expect(out.review?.ok).toBe(false)
    expect(out.preflight).toBeNull()
  })
})
