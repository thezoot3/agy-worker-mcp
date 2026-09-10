/**
 * Seatbelt (0.3.0 PR6): the profile text, the rewritten command line, and how
 * `resolvePolicy` picks the strictest sandbox. Measured on agy 1.1.27
 * (M9): `overwrite.CommandLine` is honoured, and the profile
 * below stops `sh` redirection and `python3 -c "open(...)"` outside the roots.
 */
import { describe, expect, it } from 'vitest'

import { EMPTY_CEILING } from '../../../src/policy/ceiling.js'
import { resolvePolicy } from '../../../src/policy/profiles.js'
import { seatbeltAvailable, seatbeltCommandLine, seatbeltProfile } from '../../../src/policy/seatbelt.js'
import { commandOverwrite } from '../../../src/gate/gate.js'

const WS = '/abs/ws'
const onDarwin = seatbeltAvailable() ? it : it.skip

describe('seatbeltProfile', () => {
  it('allows everything, denies all writes, then re-allows each root as a subpath', () => {
    expect(seatbeltProfile(['/abs/ws', '/private/tmp'])).toBe(
      ['(version 1)', '(allow default)', '(deny file-write*)', '(allow file-write* (subpath "/abs/ws"))', '(allow file-write* (subpath "/private/tmp"))'].join('\n'),
    )
  })

  it('escapes quotes and backslashes inside a root', () => {
    expect(seatbeltProfile(['/a"b\\c'])).toContain('(subpath "/a\\"b\\\\c")')
  })
})

describe('seatbeltCommandLine', () => {
  it('wraps the original in sandbox-exec -p <profile> /bin/sh -c <original>, single-quoted', () => {
    const cl = seatbeltCommandLine(`echo it's`, ['/abs/ws'])
    expect(cl.startsWith("sandbox-exec -p '(version 1)")).toBe(true)
    expect(cl.endsWith(`/bin/sh -c 'echo it'\\''s'`)).toBe(true)
  })
})

describe('resolvePolicy — sandbox', () => {
  it('general_worker defaults to none from default', () => {
    const p = resolvePolicy({ profile: 'general_worker', workspace: WS })
    expect(p.sandbox).toBe('none')
    expect(p.sandbox_source).toBe('default')
    expect(p.bypass_sandbox).toBe(true)
    expect(p.sandbox_forced_by).toBeNull()
  })

  it('research_readonly is always agy from profile', () => {
    const p = resolvePolicy({ profile: 'research_readonly', workspace: WS, ceiling: { ...EMPTY_CEILING, sandbox: 'none' } })
    expect(p.sandbox).toBe('agy')
    expect(p.sandbox_source).toBe('profile')
    expect(p.bypass_sandbox).toBe(false)
    expect(p.sandbox_forced_by).toBe('profile')
  })

  onDarwin('ceiling seatbelt applies; request can raise it to agy but not lower it', () => {
    const c = { ...EMPTY_CEILING, sandbox: 'seatbelt' as const }
    const a = resolvePolicy({ profile: 'general_worker', workspace: WS, ceiling: c })
    expect(a.sandbox).toBe('seatbelt')
    expect(a.sandbox_source).toBe('ceiling')
    expect(a.bypass_sandbox).toBe(true)
    expect(a.seatbelt_write_roots).toContain(WS)
    expect(a.seatbelt_write_roots).toContain('/private/tmp')
    const b = resolvePolicy({ profile: 'general_worker', workspace: WS, ceiling: c, requested: { sandbox: 'agy' } })
    expect(b.sandbox).toBe('agy')
    expect(b.sandbox_source).toBe('request')
    expect(b.sandbox_forced_by).toBe('request')
    const cc = resolvePolicy({ profile: 'general_worker', workspace: WS, ceiling: { ...EMPTY_CEILING, sandbox: 'agy' }, requested: { sandbox: 'seatbelt' } })
    expect(cc.sandbox).toBe('agy')
    expect(cc.sandbox_source).toBe('ceiling')
  })

  it('requested sandboxed: true still means agy', () => {
    const p = resolvePolicy({ profile: 'general_worker', workspace: WS, requested: { sandboxed: true } })
    expect(p.sandbox).toBe('agy')
    expect(p.sandbox_source).toBe('request')
  })

  it('ceiling write_roots widen write_roots, read_roots and the seatbelt roots', () => {
    const p = resolvePolicy({ profile: 'general_worker', workspace: WS, ceiling: { ...EMPTY_CEILING, write_roots: ['/abs/cache'] } })
    expect(p.write_roots).toEqual([WS, '/abs/cache'])
    expect(p.read_roots).toContain('/abs/cache')
    expect(p.seatbelt_write_roots).toContain('/abs/cache')
  })
})

describe('commandOverwrite', () => {
  onDarwin('under seatbelt: BypassSandbox true and CommandLine rewritten; otherwise no CommandLine', () => {
    const sb = resolvePolicy({ profile: 'general_worker', workspace: WS, ceiling: { ...EMPTY_CEILING, sandbox: 'seatbelt' } })
    const o = commandOverwrite(sb, 'npm test')
    expect(o.BypassSandbox).toBe(true)
    expect(o.Cwd).toBe(WS)
    expect(o.CommandLine).toContain("/bin/sh -c 'npm test'")
    const none = resolvePolicy({ profile: 'general_worker', workspace: WS })
    expect(commandOverwrite(none, 'npm test')).toEqual({ Cwd: WS, BypassSandbox: true })
    const agy = resolvePolicy({ profile: 'research_readonly', workspace: WS })
    expect(commandOverwrite(agy, 'ls')).toEqual({ Cwd: WS, BypassSandbox: false })
  })
})
