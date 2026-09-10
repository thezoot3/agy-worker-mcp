/**
 * Unit tests for `agy_ceiling` handler (`src/server/tools/ceiling.ts`)
 * and `agy_start` permissions sandbox handling (`src/server/tools/start.ts`).
 */
import { writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CeilingReply } from '../../../src/contract/types.js'
import { ceilingPath } from '../../../src/policy/ceiling.js'
import { DEFAULT_LIMITS, type ToolContext } from '../../../src/server/context.js'
import { handleCeiling } from '../../../src/server/tools/ceiling.js'
import { handleStart } from '../../../src/server/tools/start.js'
import { makeTestStore, type TestStoreHandle } from '../helpers/store.js'

function replyJson<T = Record<string, unknown>>(reply: { content: Array<{ type: string; text: string }> }): T {
  return JSON.parse(reply.content[0]!.text) as T
}

describe('agy_ceiling and permissions.sandbox tool handlers', () => {
  let handle: TestStoreHandle
  let ctx: ToolContext

  beforeEach(() => {
    handle = makeTestStore()
    ctx = {
      store: handle.store,
      paths: handle.store.paths,
      version: '0.4.0',
      limits: DEFAULT_LIMITS,
    }
  })

  afterEach(() => {
    handle.cleanup()
  })

  it('reports present: false when no ceiling file exists', async () => {
    const rep = await handleCeiling(ctx, {})
    expect(rep.isError).toBeFalsy()
    const body = replyJson<CeilingReply>(rep)
    expect(body.present).toBe(false)
    expect(body.ceiling.present).toBe(false)
    expect(body.v1_migration).toBeUndefined()
  })

  it('keeps answering for version 1 ceiling file, failing closed and providing migration draft and write_command', async () => {
    const v1Content = {
      version: 1,
      sandboxed: true,
      extra_allow: ['command(npm test)', 'command(git status)'],
      extra_deny: ['command(rm -rf *)'],
      additional_dirs: ['/tmp/extra'],
      command_policy: 'denylist',
    }
    const cPath = ceilingPath(ctx.paths)
    writeFileSync(cPath, JSON.stringify(v1Content, null, 2))

    const rep = await handleCeiling(ctx, {})
    expect(rep.isError).toBeFalsy()

    const body = replyJson<CeilingReply>(rep)
    expect(body.present).toBe(true)

    // Indication that the current file does not load
    expect(body.error).toBeDefined()
    expect(body.error).toContain('is version 1, which 0.4.0 rejects')
    expect(body.ceiling.error).toBeDefined()
    expect(body.ceiling.warnings).toEqual(expect.arrayContaining([expect.stringContaining('version 1')]))

    // Fail closed: effective allow must be empty
    expect(body.effective.allow).toEqual([])

    // Carries v1_migration draft and write_command
    expect(body.v1_migration).toBeDefined()
    expect(body.v1_migration?.draft).toBeDefined()
    expect(body.v1_migration?.draft.version).toBe(2)
    expect(body.v1_migration?.draft.sandbox).toBe('agy')
    expect(body.v1_migration?.draft.allow).toEqual(['command(npm test)', 'command(git status)'])
    expect(body.v1_migration?.draft.deny).toEqual(['command(rm -rf *)'])
    expect(body.v1_migration?.draft.read_roots).toEqual(['/tmp/extra'])
    expect(body.v1_migration?.draft.command_policy).toBe('denylist')
    expect(body.v1_migration?.write_command).toContain(`cat > ${cPath} <<'JSON'`)
    expect(body.v1_migration?.write_command).toContain('"version": 2')
  })

  it('loads valid version 2 ceiling file normally', async () => {
    const v2Content = {
      version: 2,
      sandbox: 'agy',
      allow: ['command(npm test)'],
      deny: ['command(rm -rf *)'],
    }
    const cPath = ceilingPath(ctx.paths)
    writeFileSync(cPath, JSON.stringify(v2Content, null, 2))

    const rep = await handleCeiling(ctx, {})
    expect(rep.isError).toBeFalsy()

    const body = replyJson<CeilingReply>(rep)
    expect(body.present).toBe(true)
    expect(body.ceiling.version).toBe(2)
    expect(body.ceiling.error).toBeUndefined()
    expect(body.v1_migration).toBeUndefined()
    expect(body.ceiling.sandbox).toBe('agy')
    expect(body.ceiling.allow).toEqual(['command(npm test)'])
    expect(body.ceiling.deny).toEqual(['command(rm -rf *)'])
  })

  it('fails closed with error reply when ceiling file is malformed and not a v1 file', async () => {
    const cPath = ceilingPath(ctx.paths)
    writeFileSync(cPath, 'not-valid-json {')

    const rep = await handleCeiling(ctx, {})
    expect(rep.isError).toBe(true)
  })

  it('agy_start with permissions.sandboxed returns a VALIDATION error reply naming sandbox', async () => {
    const rep = await handleStart(ctx, {
      prompt: 'do work',
      dry_run: true,
      permissions: { sandboxed: true } as never,
    })
    expect(rep.isError).toBe(true)

    const body = replyJson<{ error: string; message: string }>(rep)
    expect(body.error).toBe('VALIDATION')
    expect(body.message).toContain('sandbox')
  })

  it('agy_start with permissions.sandbox: "agy" (dry_run: true) resolves sandbox_forced_by: "request"', async () => {
    const rep = await handleStart(ctx, {
      prompt: 'do work',
      profile: 'general_worker',
      dry_run: true,
      permissions: { sandbox: 'agy' },
    })
    expect(rep.isError).toBeFalsy()

    const body = replyJson<{
      dry_run: boolean
      policy_summary: { bypass_sandbox: boolean; sandbox_forced_by: string | null }
    }>(rep)
    expect(body.dry_run).toBe(true)
    expect(body.policy_summary.bypass_sandbox).toBe(false)
    expect(body.policy_summary.sandbox_forced_by).toBe('request')
  })
})
