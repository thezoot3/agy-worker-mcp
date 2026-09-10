/**
 * Integration test: project ceiling read_roots applies by default when
 * permissions.read_roots is omitted from the request (PR4).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { canonicalize, projectPaths } from '../../src/contract/paths.js'
import type { EffectiveConfig, PolicySummary } from '../../src/contract/types.js'
import { ceilingPath } from '../../src/policy/ceiling.js'
import { applyEnv, ensureBuilt, makeProject, replyJson, type TestProject } from './helpers.js'

function writeCeiling(project: TestProject, body: Record<string, unknown>): void {
  const paths = projectPaths(canonicalize(project.root))
  mkdirSync(paths.dir, { recursive: true })
  writeFileSync(ceilingPath(paths), JSON.stringify(body))
}

let project: TestProject

beforeAll(() => {
  ensureBuilt()
})

beforeEach(() => {
  project = makeProject()
  applyEnv(project, 'happy')
})

describe('project ceiling read_roots applies by default', () => {
  it('applies ceiling read_roots when requested.read_roots is omitted', async () => {
    const toolchainDir = join(project.home, 'toolchain')
    mkdirSync(toolchainDir, { recursive: true })
    const toolchainCanonical = canonicalize(toolchainDir)

    writeCeiling(project, {
      version: 2,
      read_roots: [join(project.home, 'toolchain', '**')],
    })

    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const ctx = createContext()
    try {
      const reply = replyJson<{
        effective_config: EffectiveConfig
        policy_summary: PolicySummary
      }>(
        await handleStart(ctx, {
          prompt: 'run build',
          profile: 'general_worker',
          dry_run: true,
        } as never),
      )

      expect(reply.policy_summary.add_dirs_source).toBe('ceiling')
      expect(reply.policy_summary.add_dirs).toEqual([toolchainCanonical])
      expect(reply.effective_config.policy.add_dirs).toEqual([toolchainCanonical])
      expect(reply.effective_config.argv).toContain('--add-dir')
      expect(reply.effective_config.argv).toContain(toolchainCanonical)
    } finally {
      ctx.store.close()
    }
  })

  it('skips non-existent ceiling read_roots and reports warning', async () => {
    const missingDir = join(project.home, 'missing-toolchain', '**')
    writeCeiling(project, {
      version: 2,
      read_roots: [missingDir],
    })

    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const ctx = createContext()
    try {
      const reply = replyJson<{
        effective_config: EffectiveConfig
        policy_summary: PolicySummary
        warnings: string[]
      }>(
        await handleStart(ctx, {
          prompt: 'run build',
          profile: 'general_worker',
          dry_run: true,
        } as never),
      )

      expect(reply.policy_summary.add_dirs_source).toBe('none')
      expect(reply.policy_summary.add_dirs).toEqual([])
      expect(reply.effective_config.policy.add_dirs).toEqual([])
      expect(
        reply.warnings.some((w) =>
          w.includes('ceiling read_roots entry') && w.includes('does not exist and was skipped'),
        ),
      ).toBe(true)
    } finally {
      ctx.store.close()
    }
  })
})
