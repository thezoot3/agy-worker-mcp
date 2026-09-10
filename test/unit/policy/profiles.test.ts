import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ValidationError } from '../../../src/contract/errors.js'
import { canonicalize } from '../../../src/contract/paths.js'
import { EMPTY_CEILING, type Ceiling } from '../../../src/policy/ceiling.js'
import { describeProfiles, resolvePolicy } from '../../../src/policy/profiles.js'

/**
 * `resolvePolicy(input, ceiling)` — resolves effective policy against profile and ceiling (docs/permissions.md)
 */

let base: string
let workspace: string
let extra1: string
let extra2: string

function ceiling(overrides: Partial<Ceiling>): Ceiling {
  // Ceilings carry command_policy since 0.3.0; default it to 'allowlist' here.
  return { ...EMPTY_CEILING, ...overrides }
}

beforeEach(() => {
  base = canonicalize(mkdtempSync(join(tmpdir(), 'agy-worker-profiles-')))
  workspace = join(base, 'workspace')
  extra1 = join(base, 'extra1')
  extra2 = join(base, 'extra2')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(extra1, { recursive: true })
  mkdirSync(extra2, { recursive: true })
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('resolvePolicy — read_roots: ceiling default applied, request narrows, grows read_roots only', () => {
  it('(a) ceiling with two entries and no request applies both with source "ceiling"', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace,
      ceiling: ceiling({ read_roots: [extra1, extra2] }),
    })
    expect(policy.add_dirs).toEqual([extra1, extra2])
    expect(policy.add_dirs_source).toBe('ceiling')
    expect(policy.read_roots).toEqual([workspace, extra1, extra2])
    expect(policy.write_roots).toEqual([workspace])
    expect(policy.rejected_read_roots).toEqual([])
  })

  it('(b) request specifying a subset of ceiling entries applies only that subset with source "request"', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace,
      ceiling: ceiling({ read_roots: [extra1, extra2] }),
      requested: { read_roots: [extra1] },
    })
    expect(policy.add_dirs).toEqual([extra1])
    expect(policy.add_dirs_source).toBe('request')
    expect(policy.read_roots).toEqual([workspace, extra1])
    expect(policy.write_roots).toEqual([workspace])
    expect(policy.rejected_read_roots).toEqual([])
  })

  it('(c) request outside the ceiling is rejected and results in 0 applied', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace,
      ceiling: ceiling({ read_roots: [extra1] }),
      requested: { read_roots: [extra2] },
    })
    expect(policy.add_dirs).toEqual([])
    expect(policy.rejected_read_roots).toEqual([extra2])
    expect(policy.add_dirs_source).toBe('request')
    expect(policy.read_roots).toEqual([workspace])
  })

  it('(d) neither ceiling nor request has read_roots, resolves to [] with source "none"', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace,
      ceiling: ceiling({ read_roots: [] }),
    })
    expect(policy.add_dirs).toEqual([])
    expect(policy.add_dirs_source).toBe('none')
    expect(policy.read_roots).toEqual([workspace])
    expect(policy.rejected_read_roots).toEqual([])
  })

  it('with no ceiling and no requested.read_roots, read_roots is just the workspace and source is "none"', () => {
    const policy = resolvePolicy({ profile: 'general_worker', workspace })
    expect(policy.read_roots).toEqual([workspace])
    expect(policy.write_roots).toEqual([workspace])
    expect(policy.add_dirs).toEqual([])
    expect(policy.add_dirs_source).toBe('none')
    expect(policy.rejected_read_roots).toEqual([])
  })

  it('a ceiling glob (**) covers a deeper requested path', () => {
    const globRoot = join(base, 'globroot')
    const deep = join(globRoot, 'sub', 'dir')
    mkdirSync(deep, { recursive: true })
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace,
      ceiling: ceiling({ read_roots: [join(globRoot, '**')] }),
      requested: { read_roots: [deep] },
    })
    expect(policy.add_dirs).toEqual([deep])
    expect(policy.rejected_read_roots).toEqual([])
  })

  it('research_readonly grows read_roots the same way — read_roots is not gated by bypassSandbox', () => {
    const policy = resolvePolicy({
      profile: 'research_readonly',
      workspace,
      ceiling: ceiling({ read_roots: [extra1] }),
      requested: { read_roots: [extra1] },
    })
    expect(policy.read_roots).toEqual([workspace, extra1])
  })
})

describe('resolvePolicy — bypass_sandbox and sandbox_forced_by', () => {
  it('general_worker + no ceiling resolves to bypass_sandbox: true, sandbox_forced_by: null', () => {
    const policy = resolvePolicy({ profile: 'general_worker', workspace })
    expect(policy.bypass_sandbox).toBe(true)
    expect(policy.sandbox_forced_by).toBeNull()
  })

  it('general_worker + ceiling sandboxed: true resolves to bypass_sandbox: false, sandbox_forced_by: "ceiling"', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace,
      ceiling: ceiling({ sandbox: 'agy' }),
    })
    expect(policy.bypass_sandbox).toBe(false)
    expect(policy.sandbox_forced_by).toBe('ceiling')
  })

  it('general_worker + requested sandboxed: true throws ValidationError naming sandbox', () => {
    let thrown: ValidationError | null = null
    try {
      resolvePolicy({
        profile: 'general_worker',
        workspace,
        requested: { sandboxed: true },
      })
    } catch (e) {
      if (e instanceof ValidationError) thrown = e
    }
    expect(thrown).not.toBeNull()
    expect(thrown!.message).toContain('sandbox')
  })

  it('general_worker + requested sandbox: "agy" resolves to bypass_sandbox: false, sandbox_forced_by: "request"', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace,
      requested: { sandbox: 'agy' },
    })
    expect(policy.bypass_sandbox).toBe(false)
    expect(policy.sandbox_forced_by).toBe('request')
  })

  it('ceiling sandbox: "agy" takes precedence in sandbox_forced_by over requested sandbox: "agy"', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace,
      ceiling: ceiling({ sandbox: 'agy' }),
      requested: { sandbox: 'agy' },
    })
    expect(policy.bypass_sandbox).toBe(false)
    expect(policy.sandbox_forced_by).toBe('ceiling')
  })

  it('research_readonly always resolves to bypass_sandbox: false, sandbox_forced_by: "profile"', () => {
    const policy = resolvePolicy({
      profile: 'research_readonly',
      workspace,
      ceiling: ceiling({ sandbox: 'none' }),
    })
    expect(policy.bypass_sandbox).toBe(false)
    expect(policy.sandbox_forced_by).toBe('profile')
  })
})

describe('describeProfiles', () => {
  it('reports bypass_sandbox true for general_worker and false for research_readonly', () => {
    const profiles = describeProfiles()
    const gw = profiles.find((p) => p.name === 'general_worker')!
    const ro = profiles.find((p) => p.name === 'research_readonly')!
    expect(gw.bypass_sandbox).toBe(true)
    expect(ro.bypass_sandbox).toBe(false)
  })
})

describe('resolvePolicy — allow ceiling includes ceiling.allow', () => {
  it('allow widens the allow ceiling a permissions.allow request is intersected against', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace,
      ceiling: ceiling({ allow: ['command(ls)'] }),
      requested: { allow: ['command(ls)'] },
    })
    expect(policy.allow).toEqual(['command(ls)'])
    expect(policy.rejected_allow).toEqual([])
  })
})

describe('resolvePolicy — deny includes ceiling.deny, unioned, never narrowable', () => {
  it('deny is present in the effective deny list', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace,
      ceiling: ceiling({ deny: ['command(curl)'] }),
    })
    expect(policy.deny).toContain('command(curl)')
  })
})

describe('resolvePolicy — ceiling.exceptions lifts profile deny rules by exact string (0.3.0)', () => {
  it('a lifted rule leaves deny and is reported in lifted', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace,
      ceiling: ceiling({ exceptions: ['command(git push)'] }),
    })
    expect(policy.deny).not.toContain('command(git push)')
    expect(policy.lifted).toEqual(['command(git push)'])
    expect(policy.deny).toContain('command(curl)')
  })

  it('a broader rule does not lift a narrower one (no specificity matching)', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace,
      ceiling: ceiling({ exceptions: ['command(git)'] }),
    })
    expect(policy.deny).toContain('command(git push)')
    expect(policy.lifted).toEqual([])
    expect(policy.warnings?.some((w) => w.includes('command(git)') && w.includes('ignored'))).toBe(true)
  })

  it('ceiling.deny is unioned after the subtraction, so a project can lift and re-deny (net: denied)', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace,
      ceiling: ceiling({ exceptions: ['command(git push)'], deny: ['command(git push)'] }),
    })
    expect(policy.deny).toContain('command(git push)')
  })

  it('research_readonly ignores exceptions and warns', () => {
    const policy = resolvePolicy({
      profile: 'research_readonly',
      workspace,
      ceiling: ceiling({ exceptions: ['command(python)'] }),
    })
    expect(policy.deny).toContain('command(python)')
    expect(policy.lifted).toEqual([])
    expect(policy.warnings?.some((w) => w.includes('research_readonly'))).toBe(true)
  })

  it('a client request cannot lift anything: requested.deny only adds', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace,
      ceiling: ceiling({ exceptions: ['command(git push)'] }),
      requested: { deny: ['command(git push)'] },
    })
    expect(policy.deny).toContain('command(git push)')
  })

  it('ceiling.warnings (e.g. v1 conversion note) flow into policy.warnings', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace,
      ceiling: ceiling({ warnings: ['policy.json is version 1'] }),
    })
    expect(policy.warnings).toContain('policy.json is version 1')
  })
})

describe('resolvePolicy — max_denials', () => {
  it('defaults max_denials to null when omitted', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace,
    })
    expect(policy.max_denials).toBeNull()
  })

  it('preserves max_denials when passed as a number', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace,
      maxDenials: 3,
    })
    expect(policy.max_denials).toBe(3)
  })
})

describe('resolvePolicy — linkedRoots (worktree isolation)', () => {
  it('puts linkedRoots in read_roots and not in write_roots, and includes read_file in allow list', () => {
    const policy = resolvePolicy({
      profile: 'general_worker',
      workspace,
      linkedRoots: ['/somewhere/node_modules'],
    })
    expect(policy.read_roots).toContain('/somewhere/node_modules')
    expect(policy.write_roots).not.toContain('/somewhere/node_modules')
    expect(policy.allow).toContain('read_file(/somewhere/node_modules/**)')
  })
})

describe('general_worker — worktree deny rule', () => {
  it('denies command(git worktree) for general_worker', () => {
    const policy = resolvePolicy({ profile: 'general_worker', workspace })
    expect(policy.deny).toContain('command(git worktree)')
  })
})

