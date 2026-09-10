/**
 * `agy_capabilities.ceiling` — the human-owned permission ceiling
 * (`policy/ceiling.ts`, docs/permissions.md). A caller checks
 * this before `agy_start` to see what a `permissions.read_roots` request
 * could ever be granted, and whether the project forces the sandbox on
 * (`sandboxed`), without guessing from a rejected `agy_start` reply.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'

import { canonicalize, projectPaths } from '../../src/contract/paths.js'
import type { Capabilities } from '../../src/contract/types.js'
import { ceilingPath } from '../../src/policy/ceiling.js'
import { applyEnv, makeProject, replyJson, type TestProject } from './helpers.js'

let project: TestProject

beforeEach(() => {
  project = makeProject()
  applyEnv(project, 'happy')
})

async function capabilities(): Promise<Capabilities> {
  const { createContext } = await import('../../src/server/context.js')
  const { handleCapabilities } = await import('../../src/server/tools/capabilities.js')
  const ctx = createContext()
  try {
    return replyJson<Capabilities>(await handleCapabilities(ctx, {}))
  } finally {
    ctx.store.close()
  }
}

describe('agy_capabilities.ceiling', () => {
  it('present is false, and every list is empty, when no policy.json exists', async () => {
    const caps = await capabilities()
    expect(caps.ceiling.present).toBe(false)
    expect(caps.ceiling.path).toContain('policy.json')
    expect(caps.ceiling.allow).toEqual([])
    expect(caps.ceiling.deny).toEqual([])
    expect(caps.ceiling.sandbox).toBe('none')
    expect(caps.ceiling.read_roots).toEqual([])
    expect(caps.ceiling.command_policy).toBe('allowlist')
    // Not an error, but said out loud: the door exists and the user holds the key.
    expect(caps.ceiling.warnings.filter((w) => w.startsWith('no project ceiling'))).toHaveLength(1)
    expect(caps.ceiling.warnings[0]).toContain(caps.ceiling.path)

    const gw = caps.profiles.find((p) => p.name === 'general_worker')!
    const ro = caps.profiles.find((p) => p.name === 'research_readonly')!
    expect(gw.bypass_sandbox).toBe(true)
    expect(ro.bypass_sandbox).toBe(false)
  })

  it('present is true and the lists reflect policy.json verbatim, {workspace} left unsubstituted', async () => {
    const paths = projectPaths(canonicalize(project.root))
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(
      ceilingPath(paths),
      JSON.stringify({
        version: 2,
        allow: ['command(./gradlew)', 'write_file({workspace}/build/**)'],
        deny: ['command(curl)'],
        sandboxed: true,
        read_roots: [],
      }),
    )

    const caps = await capabilities()
    expect(caps.ceiling.present).toBe(true)
    expect(caps.ceiling.allow).toEqual(['command(./gradlew)', 'write_file({workspace}/build/**)'])
    expect(caps.ceiling.deny).toEqual(['command(curl)'])
    expect(caps.ceiling.sandbox).toBe('agy')
    expect(caps.ceiling.warnings.some((w) => w.startsWith('no project ceiling'))).toBe(false)
  })

  it('a corrupt policy.json fails agy_capabilities closed too, not just agy_start', async () => {
    const paths = projectPaths(canonicalize(project.root))
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(ceilingPath(paths), '{ not json')

    const { createContext } = await import('../../src/server/context.js')
    const { handleCapabilities } = await import('../../src/server/tools/capabilities.js')
    const ctx = createContext()
    try {
      const reply = await handleCapabilities(ctx, {})
      expect(reply.isError).toBe(true)
      const envelope = reply.structuredContent as { error: string; detail: { field: string } }
      expect(envelope.error).toBe('VALIDATION')
      expect(envelope.detail.field).toBe('ceiling')
    } finally {
      ctx.store.close()
    }
  })
})
