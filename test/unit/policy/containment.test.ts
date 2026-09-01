import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PathEscapeError } from '../../../src/contract/errors.js'
import { canonicalize } from '../../../src/contract/paths.js'
import { buildRoots, checkRead, checkWrite, pathsFromToolCall } from '../../../src/policy/containment.js'

let base: string
let workspace: string
let outside: string

beforeEach(() => {
  // Canonicalize the temp root itself first (macOS's tmpdir() is a symlink,
  // e.g. /var/folders -> /private/var/folders) so a "plain, no symlink" path
  // built under it doesn't spuriously look like it traversed a symlink.
  base = canonicalize(mkdtempSync(join(tmpdir(), 'agy-worker-containment-')))
  workspace = join(base, 'workspace')
  outside = join(base, 'outside')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'nope')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('symlink escape is rejected', () => {
  it('a symlink inside the workspace pointing outside it fails the write check', () => {
    const link = join(workspace, 'escape-link')
    symlinkSync(outside, link)
    const roots = buildRoots(workspace)

    let thrown: unknown
    try {
      checkWrite(join(link, 'secret.txt'), roots)
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(PathEscapeError)
    const detail = (thrown as PathEscapeError).detail
    expect(detail.kind).toBe('write')
    expect(detail.via_symlink).toBe(true)
    expect(detail.resolved_path).toBe(canonicalize(join(outside, 'secret.txt')))
  })

  it('a symlink inside the workspace pointing outside it fails the read check too', () => {
    const link = join(workspace, 'escape-link-read')
    symlinkSync(join(outside, 'secret.txt'), link)
    const roots = buildRoots(workspace)

    expect(() => checkRead(link, roots)).toThrow(PathEscapeError)
  })

  it('a symlink that stays inside the workspace is allowed', () => {
    const innerTarget = join(workspace, 'real-dir')
    mkdirSync(innerTarget)
    const link = join(workspace, 'inner-link')
    symlinkSync(innerTarget, link)
    const roots = buildRoots(workspace)

    const resolved = checkWrite(join(link, 'file.txt'), roots)
    expect(resolved.startsWith(canonicalize(workspace))).toBe(true)
  })

  it('a plain absolute path outside the workspace, no symlink involved, is still rejected', () => {
    const roots = buildRoots(workspace)
    let thrown: unknown
    try {
      checkRead(join(outside, 'secret.txt'), roots)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(PathEscapeError)
    expect((thrown as PathEscapeError).detail.via_symlink).toBe(false)
  })

  it('a legitimate path inside the workspace resolves cleanly', () => {
    writeFileSync(join(workspace, 'file.txt'), 'ok')
    const roots = buildRoots(workspace)
    const resolved = checkRead(join(workspace, 'file.txt'), roots)
    expect(resolved).toBe(canonicalize(join(workspace, 'file.txt')))
  })

  it('a not-yet-created file under a symlinked-out directory still resolves through the symlink and is rejected', () => {
    const link = join(workspace, 'escape-link-not-yet')
    symlinkSync(outside, link)
    const roots = buildRoots(workspace)
    // "new-file.txt" does not exist yet; containment must still see through the
    // symlinked parent directory rather than treating the whole path as fresh.
    expect(() => checkWrite(join(link, 'new-file.txt'), roots)).toThrow(PathEscapeError)
  })
})

describe('pathsFromToolCall — best-effort extraction, not the security boundary', () => {
  it('pulls Cwd and absolute-looking tokens out of a run_command call', () => {
    const { read, write } = pathsFromToolCall('run_command', {
      CommandLine: 'cat /etc/passwd',
      Cwd: '/abs/workspace',
    })
    expect(read).toContain('/abs/workspace')
    expect(read).toContain('/etc/passwd')
    expect(write).toEqual(['/abs/workspace'])
  })

  it('a non-run_command tool with no Cwd yields nothing', () => {
    const { read, write } = pathsFromToolCall('view_file', { path: '/abs/x' })
    expect(read).toEqual([])
    expect(write).toEqual([])
  })
})
