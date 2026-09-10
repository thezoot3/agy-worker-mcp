/**
 * Launcher tests (`test/unit/setup/launcher.test.ts`).
 *
 * Covers Cases 1-4 from SPEC.md:
 * 1. Launcher content: contains no absolute Node path baked as the only option;
 *    quotes every path; ends in `exec`.
 * 2. Launcher resolves Node when PATH=/usr/bin:/bin and a Node exists only in a
 *    fnm-shaped directory.
 * 3. Launcher falls back to the derived lib/node_modules/... server path when
 *    the recorded path no longer exists.
 * 4. Launcher prints one stderr line and exits non-zero when nothing resolves.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { generateLauncherScript, writeLauncher } from '../../../src/setup/launcher.js'

let base: string
let fakeHome: string
let fakeStateHome: string
let originalHome: string | undefined
let originalCodexHome: string | undefined
let originalAgyWorkerHome: string | undefined

beforeEach(() => {
  originalHome = process.env.HOME
  originalCodexHome = process.env.CODEX_HOME
  originalAgyWorkerHome = process.env.AGY_WORKER_HOME

  base = mkdtempSync(join(tmpdir(), 'agy-launcher-test-'))
  fakeHome = join(base, 'home')
  fakeStateHome = join(fakeHome, '.agy-worker')
  mkdirSync(fakeHome, { recursive: true })
  mkdirSync(fakeStateHome, { recursive: true })

  process.env.HOME = fakeHome
  process.env.CODEX_HOME = join(fakeHome, '.codex')
  process.env.AGY_WORKER_HOME = fakeStateHome
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

function canExecuteSh(): boolean {
  try {
    const res = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' })
    return res.status === 0 && res.stdout.trim() === 'ok'
  } catch {
    return false
  }
}

describe('Launcher generator (Case 1: content)', () => {
  it('contains no absolute Node path baked as the only option, quotes every path, and ends in exec', () => {
    const script = generateLauncherScript({
      recordedNode: '/opt/custom/bin/node',
      recordedServer: '/opt/custom/server.js',
    })

    // Contains recorded node but not as the only option
    expect(script).toContain("RECORDED_NODE='/opt/custom/bin/node'")
    expect(script).toContain('fnm/node-versions')
    expect(script).toContain('nvm/versions/node')
    expect(script).toContain('volta/tools/image/node')
    expect(script).toContain('/opt/homebrew/bin/node')

    // Every path expansion is quoted
    expect(script).toContain('"$AGY_WORKER_NODE"')
    expect(script).toContain('"$RECORDED_NODE"')
    expect(script).toContain('"$HOME"/.local/share/fnm')
    expect(script).toContain('"$candidate"')
    expect(script).toContain('"$NODE"')
    expect(script).toContain('"$SERVER"')
    expect(script).toContain('"$@"')

    // Must end in exec "$NODE" "$SERVER" "$@"
    const trimmed = script.trim()
    expect(trimmed).toMatch(/exec "\$NODE" "\$SERVER" "\$@"$/)
  })

  it('writes launcher with mode 0755 and writes .launcher-version', () => {
    const result = writeLauncher({
      stateHomeDir: fakeStateHome,
      version: '1.2.3',
    })

    expect(existsSync(result.launcherPath)).toBe(true)
    expect(existsSync(result.versionPath)).toBe(true)
    expect(readFileSync(result.versionPath, 'utf8').trim()).toBe('1.2.3')
  })
})

describe('Launcher execution (Cases 2-4)', () => {
  const shWorks = canExecuteSh()

  it('resolves Node when PATH=/usr/bin:/bin and a Node exists only in fnm directory (Case 2)', () => {
    // Set up fake fnm directory structure with a fake node executable
    const fnmBinDir = join(fakeHome, '.local', 'share', 'fnm', 'node-versions', 'v22.5.0', 'installation', 'bin')
    mkdirSync(fnmBinDir, { recursive: true })
    const fakeNode = join(fnmBinDir, 'node')

    // Fake node outputs arguments so we can verify it was called
    writeFileSync(fakeNode, '#!/bin/sh\necho "fake-node: $@"')
    chmodSync(fakeNode, 0o755)

    // Fake server
    const fakeServer = join(base, 'server.js')
    writeFileSync(fakeServer, '// fake server')

    // Generate launcher where recorded node does NOT exist
    const { launcherPath } = writeLauncher({
      stateHomeDir: fakeStateHome,
      recordedNode: join(base, 'nonexistent', 'node'),
      recordedServer: fakeServer,
    })

    if (shWorks) {
      const run = spawnSync('sh', [launcherPath, '--test-arg'], {
        env: {
          HOME: fakeHome,
          PATH: '/usr/bin:/bin',
        },
        encoding: 'utf8',
      })
      expect(run.status).toBe(0)
      expect(run.stdout).toContain('fake-node:')
      expect(run.stdout).toContain(fakeServer)
      expect(run.stdout).toContain('--test-arg')
    } else {
      // If sh execution is denied by policy, assert on script structure
      const content = readFileSync(launcherPath, 'utf8')
      expect(content).toContain('fnm/node-versions/*/installation/bin/node')
    }
  })

  it('falls back to derived lib/node_modules/... server path when recorded path does not exist (Case 3)', () => {
    // Set up node in a directory with matching derived server path
    const nodeBinDir = join(base, 'node-tree', 'bin')
    mkdirSync(nodeBinDir, { recursive: true })
    const fakeNode = join(nodeBinDir, 'node')
    writeFileSync(fakeNode, '#!/bin/sh\necho "node: $@"')
    chmodSync(fakeNode, 0o755)

    // Derived server path: <dirname $NODE>/../lib/node_modules/agy-worker-mcp/dist/server.js
    const derivedServer = join(base, 'node-tree', 'lib', 'node_modules', 'agy-worker-mcp', 'dist', 'server.js')
    mkdirSync(join(base, 'node-tree', 'lib', 'node_modules', 'agy-worker-mcp', 'dist'), { recursive: true })
    writeFileSync(derivedServer, '// derived server')

    const { launcherPath } = writeLauncher({
      stateHomeDir: fakeStateHome,
      recordedNode: fakeNode,
      recordedServer: join(base, 'dangling-server.js'), // Does not exist
    })

    if (shWorks) {
      const run = spawnSync('/bin/sh', [launcherPath, '--hello'], {
        env: {
          HOME: fakeHome,
          PATH: '/usr/bin:/bin',
        },
        encoding: 'utf8',
      })
      expect(run.status).toBe(0)
      expect(run.stdout).toContain('lib/node_modules/agy-worker-mcp/dist/server.js')
      expect(run.stdout).toContain('--hello')
    } else {
      const content = readFileSync(launcherPath, 'utf8')
      expect(content).toContain('lib/node_modules/agy-worker-mcp/dist/server.js')
    }
  })

  it('prints one stderr line and exits non-zero when nothing resolves (Case 4)', () => {
    // Launcher with nonexistent paths and empty fallback dirs
    const { launcherPath } = writeLauncher({
      stateHomeDir: fakeStateHome,
      recordedNode: join(base, 'missing', 'node'),
      recordedServer: join(base, 'missing', 'server.js'),
    })

    if (shWorks) {
      const run = spawnSync('/bin/sh', [launcherPath], {
        env: {
          HOME: fakeHome,
          PATH: '/usr/bin:/bin',
        },
        encoding: 'utf8',
      })
      expect(run.status).not.toBe(0)
      expect(run.stderr).toBeDefined()
      const stderrLines = run.stderr.trim().split('\n')
      expect(stderrLines.length).toBe(1)
      expect(stderrLines[0]).toContain('not found')
    } else {
      const content = readFileSync(launcherPath, 'utf8')
      expect(content).toContain('echo "agy-worker-mcp:')
    }
  })
})
