/**
 * `MEASURED_MODELS` / `acceptedEfforts` (`src/server/tools/capabilities.ts`)
 * pin the `--effort` rule measured on agy 1.1.27 (M8):
 * a suffixed name accepts exactly its suffix, `claude-*` accepts nothing,
 * omission is always fine. `agy_start` refuses the rest before spawning.
 */
import { homedir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { acceptedEfforts, handleCapabilities, MEASURED_MODELS } from '../../../src/server/tools/capabilities.js'
import { DEFAULT_LIMITS, type ToolContext } from '../../../src/server/context.js'
import type { Capabilities } from '../../../src/contract/types.js'
import { makeTestStore, type TestStoreHandle } from '../helpers/store.js'

const EFFORTS = ['low', 'medium', 'high']

describe('MEASURED_MODELS', () => {
  it('every entry is { name, efforts[] } drawn from the effort vocabulary', () => {
    expect(MEASURED_MODELS.length).toBeGreaterThan(0)
    for (const m of MEASURED_MODELS) {
      expect(m.name.length).toBeGreaterThan(0)
      expect(Array.isArray(m.efforts)).toBe(true)
      for (const e of m.efforts) expect(EFFORTS).toContain(e)
    }
  })

  it('a name ending in -high|-medium|-low accepts exactly that effort', () => {
    const suffixed = MEASURED_MODELS.filter((m) => /-(low|medium|high)$/.test(m.name))
    expect(suffixed.length).toBeGreaterThan(0)
    for (const m of suffixed) {
      const suffix = /-(low|medium|high)$/.exec(m.name)![1]
      expect(m.efforts).toEqual([suffix])
    }
  })

  it('claude models accept no --effort at all', () => {
    for (const name of ['claude-sonnet-4-6', 'claude-opus-4-6-thinking']) {
      const m = MEASURED_MODELS.find((x) => x.name === name)
      expect(m, name).toBeDefined()
      expect(m!.efforts).toEqual([])
    }
  })
})

describe('acceptedEfforts', () => {
  it('answers from the table for a measured model', () => {
    expect(acceptedEfforts('gemini-3.8-flash-high')).toEqual(['high'])
    expect(acceptedEfforts('gpt-oss-120b-medium')).toEqual(['medium'])
    expect(acceptedEfforts('claude-opus-4-6-thinking')).toEqual([])
  })

  it('applies the suffix rule to an unmeasured but suffixed name', () => {
    expect(acceptedEfforts('gemini-9.9-flash-low')).toEqual(['low'])
  })

  it('is null for a name it knows nothing about', () => {
    expect(acceptedEfforts('unobserved-custom-model')).toBeNull()
  })
})

describe('agy_capabilities handler fields', () => {
  let handle: TestStoreHandle
  let ctx: ToolContext

  beforeEach(() => {
    handle = makeTestStore()
    ctx = {
      store: handle.store,
      paths: handle.store.paths,
      version: '0.2.2',
      limits: DEFAULT_LIMITS,
    }
  })

  afterEach(() => {
    handle.cleanup()
  })

  it('reports project_root_source and omits project_root_moved_from for standard workspace', async () => {
    const rep = await handleCapabilities(ctx, {})
    const payload = JSON.parse(rep.content[0]!.text) as Capabilities
    expect(payload.project_root_source).toBe(handle.store.paths.source)
    expect(payload.project_root_moved_from).toBeUndefined()
  })

  it('reports project_root_source and project_root_moved_from when source is git-worktree', async () => {
    ctx.paths = {
      ...ctx.paths,
      source: 'git-worktree',
      movedFrom: '/path/to/worktree',
    }
    const rep = await handleCapabilities(ctx, {})
    const payload = JSON.parse(rep.content[0]!.text) as Capabilities
    expect(payload.project_root_source).toBe('git-worktree')
    expect(payload.project_root_moved_from).toBe('/path/to/worktree')
  })

  it('does not warn for an ordinary git repository', async () => {
    ctx.paths = {
      ...ctx.paths,
      root: '/Users/someone/code/my-project',
      source: 'git',
    }
    const rep = await handleCapabilities(ctx, {})
    const payload = JSON.parse(rep.content[0]!.text) as Capabilities
    expect(payload.warnings).toEqual([])
  })

  it('warns for a root that is / and names AGY_WORKER_PROJECT', async () => {
    ctx.paths = {
      ...ctx.paths,
      root: '/',
      source: 'env',
    }
    const rep = await handleCapabilities(ctx, {})
    const payload = JSON.parse(rep.content[0]!.text) as Capabilities
    expect(payload.warnings.length).toBeGreaterThan(0)
    expect(payload.warnings.some((w) => w.includes('root') && w.includes('AGY_WORKER_PROJECT'))).toBe(true)
  })

  it('warns for a root that is the home directory and names AGY_WORKER_PROJECT', async () => {
    ctx.paths = {
      ...ctx.paths,
      root: homedir(),
      source: 'git',
    }
    const rep = await handleCapabilities(ctx, {})
    const payload = JSON.parse(rep.content[0]!.text) as Capabilities
    expect(payload.warnings.length).toBeGreaterThan(0)
    expect(payload.warnings.some((w) => w.includes('home directory') && w.includes('AGY_WORKER_PROJECT'))).toBe(true)
  })

  it('warns for a root resolved with source: "cwd" and names AGY_WORKER_PROJECT', async () => {
    ctx.paths = {
      ...ctx.paths,
      root: '/Users/someone/code/plain-dir',
      source: 'cwd',
    }
    const rep = await handleCapabilities(ctx, {})
    const payload = JSON.parse(rep.content[0]!.text) as Capabilities
    expect(payload.warnings.length).toBeGreaterThan(0)
    expect(payload.warnings.some((w) => w.includes('no git root found') && w.includes('AGY_WORKER_PROJECT'))).toBe(true)
  })
})
