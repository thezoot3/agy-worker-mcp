import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { canonicalize } from '../../../src/contract/paths.js'
import { MAX_RUNNING_JOBS_CAP } from '../../../src/contract/types.js'
import { ValidationError } from '../../../src/contract/errors.js'
import {
  additionalDirCovered,
  additionalDirRoot,
  ceilingPath,
  EMPTY_CEILING,
  loadCeiling,
  migrateV1ToV2,
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
  it('reads allow/deny/sandbox verbatim, {workspace} left unsubstituted', () => {
    writeCeilingFile(
      JSON.stringify({
        version: 2,
        allow: ['command(./gradlew)', 'write_file({workspace}/build/**)'],
        deny: ['command(curl)'],
        sandbox: 'agy',
      }),
    )
    const ceiling = loadCeiling({ dir: stateDir })
    expect(ceiling.allow).toEqual(['command(./gradlew)', 'write_file({workspace}/build/**)'])
    expect(ceiling.deny).toEqual(['command(curl)'])
    expect(ceiling.sandbox).toBe('agy')
  })

  /**
   * The concurrency number is the one ceiling key that changes how many jobs
   * run at once rather than what one job may do, so it has its own cap: a
   * number above it fails the file closed instead of being quietly clamped,
   * because a ceiling that says forty while the server runs twelve is a
   * disagreement nobody would ever see except as an unexplained lock conflict.
   */
  it('reads max_running_jobs, and rejects one above the server cap', () => {
    writeCeilingFile(JSON.stringify({ version: 2, max_running_jobs: 8 }))
    expect(loadCeiling({ dir: stateDir }).max_running_jobs).toBe(8)

    writeCeilingFile(JSON.stringify({ version: 2, max_running_jobs: MAX_RUNNING_JOBS_CAP + 1 }))
    expect(() => loadCeiling({ dir: stateDir })).toThrow(ValidationError)
    try {
      loadCeiling({ dir: stateDir })
    } catch (e) {
      expect((e as ValidationError).detail.expected).toContain(String(MAX_RUNNING_JOBS_CAP))
    }
  })

  it('rejects a non-positive or fractional max_running_jobs', () => {
    for (const bad of [0, -1, 2.5]) {
      writeCeilingFile(JSON.stringify({ version: 2, max_running_jobs: bad }))
      expect(() => loadCeiling({ dir: stateDir })).toThrow(ValidationError)
    }
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

  it('a version 1 file throws ValidationError from loadCeiling containing the conversion', () => {
    writeCeilingFile(
      JSON.stringify({
        version: 1,
        extra_allow: ['command(./gradlew)'],
        extra_deny: ['command(curl)'],
        additional_dirs: ['/tmp'],
        command_policy: 'denylist',
      }),
    )
    let thrown: ValidationError | null = null
    try {
      loadCeiling({ dir: stateDir })
    } catch (e) {
      if (e instanceof ValidationError) thrown = e
    }
    expect(thrown).not.toBeNull()
    expect(thrown!.message).toContain('"version": 2')
    expect(thrown!.message).toContain("<<'JSON'")
  })

  it('offers the version 2 equivalent of a version 1 file, with no empty keys', () => {
    const rawV1 = {
      version: 1,
      extra_allow: ['command(./gradlew)'],
      extra_deny: ['command(curl)'],
      additional_dirs: ['/tmp'],
      sandboxed: true,
      command_policy: 'denylist',
    }
    const path = join(stateDir, 'policy.json')
    const migration = migrateV1ToV2(rawV1, path)
    expect(migration).not.toBeNull()
    expect(migration?.draft).toEqual({
      version: 2,
      allow: ['command(./gradlew)'],
      deny: ['command(curl)'],
      read_roots: ['/tmp'],
      sandbox: 'agy',
      command_policy: 'denylist',
    })
    // Nothing empty: a converted file should read like one a person wrote.
    expect(migration?.draft).not.toHaveProperty('exceptions')
    expect(migration?.draft).not.toHaveProperty('write_roots')
    expect(migration?.write_command).toContain(path)
    expect(migration?.write_command).toContain("<<'JSON'")
  })

  it('offers no migration for a version 2 file or for no file at all', () => {
    expect(migrateV1ToV2({ version: 2, allow: ['command(ls)'] })).toBeNull()
    expect(migrateV1ToV2(EMPTY_CEILING)).toBeNull()
    expect(migrateV1ToV2(null)).toBeNull()
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

  it('a version 2 file using sandboxed: true fails to load and the message names sandbox', () => {
    writeCeilingFile(JSON.stringify({ version: 2, sandboxed: true }))
    let thrown: ValidationError | null = null
    try {
      loadCeiling({ dir: stateDir })
    } catch (e) {
      if (e instanceof ValidationError) thrown = e
    }
    expect(thrown).not.toBeNull()
    expect(thrown!.message).toContain('sandbox')
  })

  it('a valid version 2 file loads unchanged and resolves sandbox (regression)', () => {
    const workspaceBase = mkdtempSync(join(tmpdir(), 'agy-worker-ceiling-ws-'))
    try {
      const workspace = canonicalize(workspaceBase)
      writeCeilingFile(JSON.stringify({ version: 2, sandbox: 'agy' }))
      const ceiling = loadCeiling({ dir: stateDir })
      expect(ceiling.version).toBe(2)
      expect(ceiling.sandbox).toBe('agy')
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

describe('loadCeiling — link_paths validation', () => {
  it('loads valid project-root-relative link_paths', () => {
    writeCeilingFile(JSON.stringify({ version: 2, link_paths: ['node_modules'] }))
    const ceiling = loadCeiling({ dir: stateDir })
    expect(ceiling.link_paths).toEqual(['node_modules'])
  })

  it('rejects absolute paths', () => {
    writeCeilingFile(JSON.stringify({ version: 2, link_paths: ['/abs'] }))
    expect(() => loadCeiling({ dir: stateDir })).toThrow(ValidationError)
  })

  it('rejects entries containing .. segments', () => {
    writeCeilingFile(JSON.stringify({ version: 2, link_paths: ['../x'] }))
    expect(() => loadCeiling({ dir: stateDir })).toThrow(ValidationError)
  })

  it('rejects empty entries', () => {
    writeCeilingFile(JSON.stringify({ version: 2, link_paths: [''] }))
    expect(() => loadCeiling({ dir: stateDir })).toThrow(ValidationError)
  })
})

