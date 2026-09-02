/**
 * `agy_start` reports what the profile ceiling did to a `permissions` request.
 *
 * The trap, measured: a client asked for
 * `allow: ["command(./gradlew)","command(bash)","command(javap)"]`, all three
 * fell outside the ceiling, and because `allow` is an *intersection* the
 * effective list collapsed to `[]` — dropping the profile's own defaults with
 * it. The old reply carried neither `rejected_allow` nor a warning, so the job
 * ran with nothing explicitly allowed and no one could tell.
 *
 * `dry_run` only: none of this spawns agy.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Blocker, PolicySummary } from '../../src/contract/types.js'
import { applyEnv, ensureBuilt, makeProject, replyJson, type TestProject } from './helpers.js'

let project: TestProject

// The last case starts a real (fake-agy) job, which spawns dist/runner.js.
beforeAll(() => {
  ensureBuilt()
})

beforeEach(() => {
  project = makeProject()
  applyEnv(project, 'happy')
})

interface StartReply {
  dry_run?: boolean
  policy_summary: PolicySummary
  blockers: Blocker[]
  warnings: string[]
}

async function start(input: Record<string, unknown>): Promise<StartReply> {
  const { createContext } = await import('../../src/server/context.js')
  const { handleStart } = await import('../../src/server/tools/start.js')
  const ctx = createContext()
  try {
    return replyJson<StartReply>(await handleStart(ctx, input as never))
  } finally {
    ctx.store.close()
  }
}

describe('a permissions.allow request entirely outside the ceiling', () => {
  it('reports every rejection as a policy_ceiling blocker and says the allow list collapsed', async () => {
    const reply = await start({
      prompt: 'x',
      profile: 'general_worker',
      permissions: { allow: ['command(bash)', 'command(javap)'] },
      dry_run: true,
    })

    expect(reply.policy_summary.allow_count).toBe(0)
    expect(reply.policy_summary.profile).toBe('general_worker')

    const rejections = reply.blockers.filter((b) => b.source === 'policy_ceiling')
    expect(rejections.length).toBeGreaterThanOrEqual(3) // two rejected rules + the collapse
    for (const rule of ['command(bash)', 'command(javap)']) {
      const b = rejections.find((r) => r.message.includes(rule))
      expect(b, `a blocker for ${rule}`).toBeDefined()
      expect(b!.actionable).toBe(true)
      expect(b!.remedy).toContain('permissions.allow')
    }

    // The collapse itself, in its own words, with the instruction to restart.
    const collapse = rejections.find((b) => b.message.includes('effective allow list is empty'))
    expect(collapse).toBeDefined()
    expect(collapse!.message).toContain("profile's own default allowances")
    expect(collapse!.remedy).toContain('start again with no permissions.allow')

    // And the same thing in `warnings`, which is what a prose-reading caller sees.
    expect(reply.warnings.some((w) => w.includes('effective allow list is empty'))).toBe(true)
  })

  it('a request the ceiling covers produces no blockers and keeps the rules', async () => {
    const reply = await start({
      prompt: 'x',
      profile: 'general_worker',
      // Added to the ceiling in 0.1.1 precisely so build commands stop bouncing.
      permissions: { allow: ['command(./gradlew)', 'command(mvn)'] },
      dry_run: true,
    })

    expect(reply.policy_summary.allow_count).toBe(2)
    expect(reply.blockers).toEqual([])
    expect(reply.warnings).toEqual([])
  })

  it('omitting permissions entirely leaves the full profile ceiling in place', async () => {
    const reply = await start({ prompt: 'x', profile: 'general_worker', dry_run: true })
    expect(reply.policy_summary.allow_count).toBeGreaterThan(0)
    expect(reply.blockers).toEqual([])
  })
})

describe('the non-dry_run reply carries the same three fields', () => {
  it('a real agy_start reports its policy too, not just a job_id', async () => {
    const reply = await start({
      prompt: 'x',
      profile: 'general_worker',
      permissions: { allow: ['command(bash)'] },
    })

    expect(reply.dry_run).toBe(false)
    expect(reply.policy_summary.allow_count).toBe(0)
    expect(reply.blockers.some((b) => b.source === 'policy_ceiling')).toBe(true)
    expect(reply.warnings.length).toBeGreaterThan(0)
  })
})
