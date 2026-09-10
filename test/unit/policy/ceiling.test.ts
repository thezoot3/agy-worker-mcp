import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { canonicalize } from '../../../src/contract/paths.js'
import { ValidationError } from '../../../src/contract/errors.js'
import {
  additionalDirCovered,
  additionalDirRoot,
  ceilingPath,
  EMPTY_CEILING,
  loadCeiling,
} from '../../../src/policy/ceiling.js'
import { resolvePolicy } from '../../../src/policy/profiles.js'

/**
 * The human-owned ceiling (docs/permissions.md) at
 * `<project state dir>/policy.json`. Missing → empty. Present but invalid →
 * fails closed (`ValidationError`) so `agy_start` tells the human what to fix
 * instead of silently narrowing to nothing.
 */

let stateDir: string

function writeCeilingFile(content: string): void {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(ceilingPath({ dir: stateDir }), content)
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'agy-worker-ceiling-'))
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

describe('loadCeiling — missing file', () => {
  it('returns the empty ceiling', () => {
    const ceiling = loadCeiling({ dir: stateDir })
    expect(ceiling).toEqual({ ...EMPTY_CEILING, path: join(stateDir, 'policy.json') })
    expect(ceiling.present).toBe(false)
  })
})

describe('loadCeiling — invalid file fails closed with ValidationError', () => {
  it('not valid JSON', () => {
    writeCeilingFile('{not json')
    try {
      loadCeiling({ dir: stateDir })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError)
      expect((e as ValidationError).detail.field).toBe('ceiling')
      expect(String((e as ValidationError).detail.expected)).toContain(ceilingPath({ dir: stateDir }))
    }
  })

  it('wrong version', () => {
    writeCeilingFile(JSON.stringify({ version: 3 }))
    expect(() => loadCeiling({ dir: stateDir })).toThrow(ValidationError)
  })

  it('an exceptions entry naming a HARD_DENY rule', () => {
    writeCeilingFile(JSON.stringify({ version: 2, exceptions: ['write_file({workspace}/.agents/**)'] }))
    expect(() => loadCeiling({ dir: stateDir })).toThrow(/HARD_DENY/)
  })

  it('a non-string entry', () => {
    writeCeilingFile(JSON.stringify({ version: 2, allow: [123] }))
    expect(() => loadCeiling({ dir: stateDir })).toThrow(ValidationError)
  })

  it('an unparsable rule string in allow', () => {
    writeCeilingFile(JSON.stringify({ version: 2, allow: ['not-a-rule'] }))
    try {
      loadCeiling({ dir: stateDir })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError)
      expect((e as ValidationError).detail.field).toBe('ceiling')
    }
  })

  it('a policy.json containing legacy unsandboxed key fails closed with migration message', () => {
    writeCeilingFile(JSON.stringify({ version: 2, unsandboxed: ['command(ls)'] }))
    try {
      loadCeiling({ dir: stateDir })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError)
      expect((e as ValidationError).detail.field).toBe('ceiling')
      expect(String((e as ValidationError).detail.expected)).toContain('the "unsandboxed" key was removed in 0.2.1')
    }
  })

  it('sandboxed is not boolean fails with ValidationError', () => {
    writeCeilingFile(JSON.stringify({ version: 2, sandboxed: 'yes' }))
    expect(() => loadCeiling({ dir: stateDir })).toThrow(ValidationError)
  })
})

describe('loadCeiling — valid file', () => {
  it('reads allow/deny/sandboxed verbatim, {workspace} left unsubstituted', () => {
    writeCeilingFile(
      JSON.stringify({
        version: 2,
        allow: ['command(./gradlew)', 'write_file({workspace}/build/**)'],
        deny: ['command(curl)'],
        sandboxed: true,
      }),
    )
    const ceiling = loadCeiling({ dir: stateDir })
    expect(ceiling.allow).toEqual(['command(./gradlew)', 'write_file({workspace}/build/**)'])
    expect(ceiling.deny).toEqual(['command(curl)'])
    expect(ceiling.sandbox).toBe('agy')
  })

  it('expands ~ and canonicalizes read_roots entries', () => {
    writeCeilingFile(JSON.stringify({ version: 2, read_roots: ['~/agy-worker-ceiling-test-fixture'] }))
    const ceiling = loadCeiling({ dir: stateDir })
    expect(ceiling.read_roots).toHaveLength(1)
    const resolved = ceiling.read_roots[0] as string
    expect(resolved.startsWith(canonicalize(homedir()))).toBe(true)
    expect(resolved.endsWith('agy-worker-ceiling-test-fixture')).toBe(true)
  })

  it('missing arrays default to empty and sandboxed defaults to false', () => {
    writeCeilingFile(JSON.stringify({ version: 2 }))
    expect(loadCeiling({ dir: stateDir })).toEqual({
      ...EMPTY_CEILING,
      version: 2,
      present: true,
      path: join(stateDir, 'policy.json'),
    })
    expect(loadCeiling({ dir: stateDir }).sandbox).toBe('none')
  })

  it('reads exceptions verbatim', () => {
    writeCeilingFile(JSON.stringify({ version: 2, exceptions: ['command(git push)', 'command(npm install)'] }))
    expect(loadCeiling({ dir: stateDir }).exceptions).toEqual(['command(git push)', 'command(npm install)'])
  })

  it('reads a version 1 file, converts its keys, and warns with the rename list', () => {
    writeCeilingFile(
      JSON.stringify({
        version: 1,
        extra_allow: ['command(./gradlew)'],
        extra_deny: ['command(curl)'],
        additional_dirs: ['/tmp'],
        command_policy: 'denylist',
      }),
    )
    const c = loadCeiling({ dir: stateDir })
    expect(c.version).toBe(1)
    expect(c.allow).toEqual(['command(./gradlew)'])
    expect(c.deny).toEqual(['command(curl)'])
    expect(c.exceptions).toEqual([])
    expect(c.read_roots).toHaveLength(1)
    expect(c.command_policy).toBe('denylist')
    expect(c.warnings).toHaveLength(1)
    expect(c.warnings[0]).toContain('extra_allow → allow')
    expect(c.warnings[0]).toContain('additional_dirs → read_roots')
  })

  it('a version 1 file with the new key names is rejected (keys are per-version)', () => {
    writeCeilingFile(JSON.stringify({ version: 1, allow: ['command(ls)'] }))
    expect(() => loadCeiling({ dir: stateDir })).toThrow(ValidationError)
  })
})

describe('additionalDirCovered — glob matching for read_roots', () => {
  it('an exact entry matches only itself', () => {
    const ceiling = { ...EMPTY_CEILING, read_roots: ['/x/jdks'] }
    expect(additionalDirCovered(ceiling, '/x/jdks')).toBe(true)
    expect(additionalDirCovered(ceiling, '/x/jdks/25')).toBe(false)
  })

  it('a ** glob covers any depth beneath the root', () => {
    const ceiling = { ...EMPTY_CEILING, read_roots: ['/x/gradle/**'] }
    expect(additionalDirCovered(ceiling, '/x/gradle/caches/modules-2')).toBe(true)
    expect(additionalDirCovered(ceiling, '/x/other')).toBe(false)
  })
})

describe('loadCeiling + resolvePolicy — {workspace} substitution and sandboxed ceiling, end to end', () => {
  it('a rule ceiling entry substitutes {workspace} with the job workspace, and general_worker bypasses sandbox by default', () => {
    const workspaceBase = mkdtempSync(join(tmpdir(), 'agy-worker-ceiling-ws-'))
    try {
      const workspace = canonicalize(workspaceBase)
      writeCeilingFile(
        JSON.stringify({
          version: 2,
          allow: ['command(ls)', 'write_file({workspace}/out/**)'],
        }),
      )
      const ceiling = loadCeiling({ dir: stateDir })
      const policy = resolvePolicy({ profile: 'general_worker', workspace, ceiling })

      expect(policy.allow).toContain(`write_file(${workspace}/out/**)`)
      expect(policy.allow).not.toContain('write_file({workspace}/out/**)')
      expect(policy.bypass_sandbox).toBe(true)
      expect(policy.sandbox_forced_by).toBeNull()
    } finally {
      rmSync(workspaceBase, { recursive: true, force: true })
    }
  })

  it('ceiling with sandboxed: true forces bypass_sandbox to false and records forced_by', () => {
    const workspaceBase = mkdtempSync(join(tmpdir(), 'agy-worker-ceiling-ws-'))
    try {
      const workspace = canonicalize(workspaceBase)
      writeCeilingFile(JSON.stringify({ version: 2, sandboxed: true }))
      const ceiling = loadCeiling({ dir: stateDir })
      const policy = resolvePolicy({ profile: 'general_worker', workspace, ceiling })

      expect(policy.bypass_sandbox).toBe(false)
      expect(policy.sandbox_forced_by).toBe('ceiling')
    } finally {
      rmSync(workspaceBase, { recursive: true, force: true })
    }
  })
})

describe('additionalDirRoot — converts ceiling glob pattern to concrete directory', () => {
  it('~/.jdks/** resolves to .jdks under HOME when directory exists', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'agy-home-jdks-'))
    const jdks = join(tmpHome, '.jdks')
    mkdirSync(jdks, { recursive: true })
    const savedHome = process.env.HOME
    process.env.HOME = tmpHome
    try {
      const root = additionalDirRoot('~/.jdks/**')
      expect(root).toBe(canonicalize(jdks))
    } finally {
      process.env.HOME = savedHome
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('returns null for a non-existent path', () => {
    const nonExistent = join(stateDir, 'does-not-exist', '**')
    expect(additionalDirRoot(nonExistent)).toBeNull()
  })

  it('returns canonical path as-is for a path without wildcards when directory exists', () => {
    const concreteDir = join(stateDir, 'concrete-dir')
    mkdirSync(concreteDir, { recursive: true })
    expect(additionalDirRoot(concreteDir)).toBe(canonicalize(concreteDir))
  })
})

