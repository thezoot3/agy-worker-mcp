/**
 * Doctor tests (`test/unit/setup/doctor.test.ts`).
 *
 * Covers Case 9 from SPEC.md:
 * - doctor returns a failing check when the launcher is missing
 * - doctor returns a failing check when the launcher's server path is dangling
 * - doctor returns a failing check when the launcher version differs from the package version
 * - doctor returns structured results with pass/fail and fix recommendations
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { doctor } from '../../../src/setup/doctor.js'
import { writeLauncher } from '../../../src/setup/launcher.js'
import { agySearchLocations, resolveAgyBin } from '../../../src/runner/spawn.js'

let base: string
let fakeHome: string
let fakeCodexHome: string
let fakeStateHome: string
let fakePkgDir: string

let originalHome: string | undefined
let originalCodexHome: string | undefined
let originalAgyWorkerHome: string | undefined

beforeEach(() => {
  originalHome = process.env.HOME
  originalCodexHome = process.env.CODEX_HOME
  originalAgyWorkerHome = process.env.AGY_WORKER_HOME

  base = mkdtempSync(join(tmpdir(), 'agy-doctor-test-'))
  fakeHome = join(base, 'home')
  fakeCodexHome = join(fakeHome, '.codex')
  fakeStateHome = join(fakeHome, '.agy-worker')
  fakePkgDir = join(base, 'pkg')

  mkdirSync(fakeHome, { recursive: true })
  mkdirSync(fakeCodexHome, { recursive: true })
  mkdirSync(fakeStateHome, { recursive: true })
  mkdirSync(fakePkgDir, { recursive: true })

  process.env.HOME = fakeHome
  process.env.CODEX_HOME = fakeCodexHome
  process.env.AGY_WORKER_HOME = fakeStateHome

  writeFileSync(join(fakePkgDir, 'package.json'), JSON.stringify({ version: '1.0.0' }))
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
  if (originalHome !== undefined) process.env.HOME = originalHome
  else delete process.env.HOME
  if (originalCodexHome !== undefined) process.env.CODEX_HOME = originalCodexHome
  else delete process.env.CODEX_HOME
  if (originalAgyWorkerHome !== undefined) process.env.AGY_WORKER_HOME = originalAgyWorkerHome
  else delete process.env.AGY_WORKER_HOME
})

describe('doctor checks (Case 9)', () => {
  it('returns a failing check when the launcher is missing', () => {
    const report = doctor({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      stateHomeDir: fakeStateHome,
      packageSource: fakePkgDir,
      cwd: base,
    })

    const launcherCheck = report.checks.find((c) => c.id === 'launcher_exists')
    expect(launcherCheck).toBeDefined()
    expect(launcherCheck?.ok).toBe(false)
    expect(launcherCheck?.message).toContain('not found')
    expect(launcherCheck?.fix).toBeDefined()
  })

  it('returns a failing check when the launcher server path is dangling', () => {
    // Write launcher pointing to dangling server path
    const danglingServer = join(base, 'missing-server.js')
    writeLauncher({
      stateHomeDir: fakeStateHome,
      recordedServer: danglingServer,
      version: '1.0.0',
    })

    const report = doctor({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      stateHomeDir: fakeStateHome,
      packageSource: fakePkgDir,
      cwd: base,
    })

    const launcherCheck = report.checks.find((c) => c.id === 'launcher_exists')
    expect(launcherCheck).toBeDefined()
    expect(launcherCheck?.ok).toBe(false)
    expect(launcherCheck?.message).toContain('server entry point not found')
    expect(launcherCheck?.fix).toContain('--force')
  })

  it('returns a failing check when launcher version differs from package version', () => {
    // Write valid server file
    const realServer = join(base, 'server.js')
    writeFileSync(realServer, '// ok')

    // Write launcher with version 0.9.0 while package is 1.0.0
    writeLauncher({
      stateHomeDir: fakeStateHome,
      recordedServer: realServer,
      version: '0.9.0',
    })

    const report = doctor({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      stateHomeDir: fakeStateHome,
      packageSource: fakePkgDir,
      cwd: base,
    })

    const versionCheck = report.checks.find((c) => c.id === 'launcher_version')
    expect(versionCheck).toBeDefined()
    expect(versionCheck?.ok).toBe(false)
    expect(versionCheck?.message).toContain('0.9.0')
    expect(versionCheck?.message).toContain('1.0.0')
    expect(versionCheck?.fix).toBeDefined()
  })

  it('passes launcher and version checks when configured correctly', () => {
    const realServer = join(base, 'server.js')
    writeFileSync(realServer, '// ok')

    writeLauncher({
      stateHomeDir: fakeStateHome,
      recordedServer: realServer,
      version: '1.0.0',
    })

    const report = doctor({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      stateHomeDir: fakeStateHome,
      packageSource: fakePkgDir,
      cwd: base,
    })

    const launcherCheck = report.checks.find((c) => c.id === 'launcher_exists')
    expect(launcherCheck?.ok).toBe(true)

    const versionCheck = report.checks.find((c) => c.id === 'launcher_version')
    expect(versionCheck?.ok).toBe(true)
  })

  it('detects when launcher is not executable', () => {
    const realServer = join(base, 'server.js')
    writeFileSync(realServer, '// ok')

    const { launcherPath } = writeLauncher({
      stateHomeDir: fakeStateHome,
      recordedServer: realServer,
      version: '1.0.0',
    })

    // Remove execute permission
    chmodSync(launcherPath, 0o644)

    const report = doctor({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      stateHomeDir: fakeStateHome,
      packageSource: fakePkgDir,
      cwd: base,
    })

    const launcherCheck = report.checks.find((c) => c.id === 'launcher_exists')
    expect(launcherCheck?.ok).toBe(false)
    expect(launcherCheck?.message).toContain('not executable')
    expect(launcherCheck?.fix).toContain('chmod +x')
  })

  it('flags duplicate project-scope skills shadowing user-scope skills', () => {
    // Create both user and project scope skills
    const userSkillDir = join(fakeHome, '.claude', 'skills', 'agy-ceiling')
    const projectSkillDir = join(base, '.claude', 'skills', 'agy-ceiling')
    mkdirSync(userSkillDir, { recursive: true })
    mkdirSync(projectSkillDir, { recursive: true })

    const report = doctor({
      homeDir: fakeHome,
      codexHomeDir: fakeCodexHome,
      stateHomeDir: fakeStateHome,
      packageSource: fakePkgDir,
      cwd: base,
    })

    const skillsCheck = report.checks.find((c) => c.id === 'skills_and_commands')
    expect(skillsCheck?.ok).toBe(false)
    expect(skillsCheck?.message).toContain('duplicates')
  })
})

describe('resolveAgyBin and agySearchLocations (Task 2)', () => {
  it('prefers AGY_WORKER_AGY_BIN override when set', () => {
    const override = join(base, 'fake-agy')
    expect(resolveAgyBin({ AGY_WORKER_AGY_BIN: override })).toBe(override)
  })

  it('searches PATH directories and finds executable agy', () => {
    const binDir = join(base, 'custom-bin')
    mkdirSync(binDir, { recursive: true })
    const agyBin = join(binDir, 'agy')
    writeFileSync(agyBin, '#!/bin/sh\necho "1.0.0"')
    chmodSync(agyBin, 0o755)

    const resolved = resolveAgyBin({ PATH: binDir })
    expect(resolved).toBe(agyBin)
  })

  it('falls back to $HOME/.local/bin/agy when not in PATH', () => {
    const localBin = join(fakeHome, '.local', 'bin')
    mkdirSync(localBin, { recursive: true })
    const agyBin = join(localBin, 'agy')
    writeFileSync(agyBin, '#!/bin/sh\necho "1.0.0"')
    chmodSync(agyBin, 0o755)

    const resolved = resolveAgyBin({ HOME: fakeHome, PATH: '/empty-dir' })
    expect(resolved).toBe(agyBin)
  })

  it('throws an Error listing all searched locations when agy is not found', () => {
    let error: Error | undefined
    try {
      resolveAgyBin({ HOME: fakeHome, PATH: '/empty-path-one:/empty-path-two' })
    } catch (err) {
      error = err as Error
    }

    expect(error).toBeDefined()
    expect(error?.message).toContain('agy binary not found')
    expect(error?.message).toContain('/empty-path-one/agy')
    expect(error?.message).toContain('/empty-path-two/agy')
    expect(error?.message).toContain('.local/bin/agy')
    expect(error?.message).toContain('/opt/homebrew/bin/agy')
    expect(error?.message).toContain('/usr/local/bin/agy')
  })

  it('agySearchLocations includes PATH entries and known locations', () => {
    const locations = agySearchLocations({ HOME: fakeHome, PATH: '/bin1:/bin2' })
    expect(locations).toContain(join('/bin1', 'agy'))
    expect(locations).toContain(join('/bin2', 'agy'))
    expect(locations).toContain(join(fakeHome, '.local', 'bin', 'agy'))
    expect(locations).toContain('/opt/homebrew/bin/agy')
    expect(locations).toContain('/usr/local/bin/agy')
  })
})
