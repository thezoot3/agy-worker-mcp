import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PathEscapeError, ValidationError } from '../../../src/contract/errors.js'
import { canonicalize, stateHome } from '../../../src/contract/paths.js'
import {
  ALLOWED_DEV_READS,
  buildRoots,
  checkRead,
  checkWrite,
  expandLeadingTilde,
  extractCommandContainment,
  hasUnexpandedChars,
  pathsFromToolCall,
  validateWriteRoots,
} from '../../../src/policy/containment.js'

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

describe('unexpanded shell expansions in path positions', () => {
  it('detects unexpanded characters: ~, $, `, *, ?, [', () => {
    expect(hasUnexpandedChars('foo$BAR')).toBe(true)
    expect(hasUnexpandedChars('foo`cmd`')).toBe(true)
    expect(hasUnexpandedChars('*.ts')).toBe(false)
    expect(hasUnexpandedChars('file?.txt')).toBe(false)
    expect(hasUnexpandedChars('test[0-9].js')).toBe(false)
    expect(hasUnexpandedChars('foo~bar')).toBe(true)
    expect(hasUnexpandedChars('/plain/path/file.txt')).toBe(false)
  })

  it('leading ~/ is expanded before checking for unexpanded chars', () => {
    const home = canonicalize(homedir())
    const expanded = expandLeadingTilde('~/documents/file.txt')
    expect(expanded).toBe(join(home, 'documents', 'file.txt'))
    expect(hasUnexpandedChars(expanded)).toBe(false)
  })

  it('unexpandedPath is identified in commands with shell expansions', () => {
    const r1 = extractCommandContainment('cat ~/file$VAR.txt', workspace)
    expect(r1.unexpandedPath).toBe('~/file$VAR.txt')

    const r2 = extractCommandContainment('rm $TMPDIR/x.log', workspace)
    expect(r2.unexpandedPath).toBe('$TMPDIR/x.log')

    const r3 = extractCommandContainment('echo foo > `pwd`/out.txt', workspace)
    expect(r3.unexpandedPath).toBe('`pwd`/out.txt')
  })

  it('a glob is cut back to its literal directory prefix and contained there', () => {
    expect(expandLeadingTilde('src/*.ts')).toBe('src')
    expect(expandLeadingTilde('*.ts')).toBe('.')
    expect(expandLeadingTilde('dist/**/x.js')).toBe('dist')
    expect(expandLeadingTilde('/[abc]/x')).toBe('/')
    expect(expandLeadingTilde('~/.ssh/*')).toBe(join(canonicalize(homedir()), '.ssh'))

    const inside = extractCommandContainment('rm -f dist/*.js', workspace)
    expect(inside.unexpandedPath).toBeNull()
    expect(inside.writePaths).toEqual([join(workspace, 'dist')])

    const read = extractCommandContainment('cat src/*.ts', workspace)
    expect(read.unexpandedPath).toBeNull()
    expect(read.readPaths).toEqual([join(workspace, 'src')])

    const outside = extractCommandContainment('rm -f ../*', workspace)
    expect(outside.unexpandedPath).toBeNull()
    expect(outside.writePaths).toEqual([resolve(workspace, '..')])
  })
})

describe('read utilities containment', () => {
  it('identifies file read targets for read utilities', () => {
    const r = extractCommandContainment('cat /etc/passwd', workspace)
    expect(r.readPaths).toContain('/etc/passwd')
  })

  it('identifies grep search directories/files', () => {
    const r = extractCommandContainment('grep -rn pattern /var/log', workspace)
    expect(r.readPaths).toContain('/var/log')
  })

  it('identifies sed and awk file read targets', () => {
    const rSed = extractCommandContainment("sed -n '1p' /etc/hosts", workspace)
    expect(rSed.readPaths).toContain('/etc/hosts')

    const rAwk = extractCommandContainment("awk '{print $1}' /etc/resolv.conf", workspace)
    expect(rAwk.readPaths).toContain('/etc/resolv.conf')
  })

  it('identifies find search root', () => {
    const r = extractCommandContainment('find /var -name "*.log"', workspace)
    expect(r.readPaths).toContain('/var')
  })

  it('identifies script targets for python3, node, and java', () => {
    const rPy = extractCommandContainment('python3 /opt/script.py arg1', workspace)
    expect(rPy.readPaths).toContain('/opt/script.py')

    const rNode = extractCommandContainment('node /opt/server.js', workspace)
    expect(rNode.readPaths).toContain('/opt/server.js')

    const rJava = extractCommandContainment('java /opt/Main.java', workspace)
    expect(rJava.readPaths).toContain('/opt/Main.java')
  })

  it('cp and mv distinguish read sources from write target', () => {
    const rCp = extractCommandContainment('cp /etc/hosts /tmp/hosts.bak', workspace)
    expect(rCp.readPaths).toContain('/etc/hosts')
    expect(rCp.writePaths).toContain('/tmp/hosts.bak')
  })

  it('ALLOWED_DEV_READS whitelists standard null/stream devices', () => {
    expect(ALLOWED_DEV_READS.has('/dev/null')).toBe(true)
    expect(ALLOWED_DEV_READS.has('/dev/stdin')).toBe(true)
    expect(ALLOWED_DEV_READS.has('/dev/stdout')).toBe(true)
    expect(ALLOWED_DEV_READS.has('/dev/stderr')).toBe(true)

    const r = extractCommandContainment('cat /dev/null', workspace)
    expect(r.readPaths).toContain('/dev/null')
  })
})

describe('mutating commands write targets', () => {
  it('extracts write targets for sed -i and sort -o', () => {
    const rSed = extractCommandContainment("sed -i '' 's/a/b/g' src/file.ts", workspace)
    expect(rSed.writePaths).toContain(canonicalize(join(workspace, 'src/file.ts')))

    const rSort = extractCommandContainment('sort -o sorted.txt unsorted.txt', workspace)
    expect(rSort.writePaths).toContain(canonicalize(join(workspace, 'sorted.txt')))
    expect(rSort.readPaths).toContain(canonicalize(join(workspace, 'unsorted.txt')))
  })

  it('extracts write targets for tee, truncate, and dd', () => {
    const rTee = extractCommandContainment('echo test | tee output.log', workspace)
    expect(rTee.writePaths).toContain(canonicalize(join(workspace, 'output.log')))

    const rTrunc = extractCommandContainment('truncate -s 0 /tmp/target.txt', workspace)
    expect(rTrunc.writePaths).toContain('/tmp/target.txt')

    const rDd = extractCommandContainment('dd if=/dev/zero of=/tmp/zero.bin bs=1M count=1', workspace)
    expect(rDd.writePaths).toContain('/tmp/zero.bin')
  })

  it('extracts write targets for git commands: archive, clone, init, worktree', () => {
    const rArch = extractCommandContainment('git archive --output=bundle.tar.gz HEAD', workspace)
    expect(rArch.writePaths).toContain(canonicalize(join(workspace, 'bundle.tar.gz')))

    const rClone = extractCommandContainment('git clone https://example.com/repo.git my-repo', workspace)
    expect(rClone.writePaths).toContain(canonicalize(join(workspace, 'my-repo')))

    const rWorktree = extractCommandContainment('git worktree add ../wt-branch', workspace)
    expect(rWorktree.writePaths).toContain(resolve(workspace, '../wt-branch'))
  })

  it('extracts write targets for archive extractions: tar -C, unzip -d', () => {
    const rTar = extractCommandContainment('tar -xzf archive.tgz -C /tmp/extracted', workspace)
    expect(rTar.writePaths).toContain('/tmp/extracted')

    const rUnzip = extractCommandContainment('unzip archive.zip -d /tmp/unzipped', workspace)
    expect(rUnzip.writePaths).toContain('/tmp/unzipped')
  })
})

describe('validateWriteRoots sanity', () => {
  it('throws ValidationError when effective write root is root (/) and names the cause', () => {
    expect(() => validateWriteRoots(['/'])).toThrow(ValidationError)
    try {
      validateWriteRoots(['/'])
    } catch (e) {
      expect((e as ValidationError).detail.field).toBe('write_roots')
      expect((e as ValidationError).message).toContain('client working directory')
    }
  })

  it('throws ValidationError when effective write root is home directory and names the cause', () => {
    expect(() => validateWriteRoots([homedir()])).toThrow(ValidationError)
    try {
      validateWriteRoots([homedir()])
    } catch (e) {
      expect((e as ValidationError).detail.field).toBe('write_roots')
      expect((e as ValidationError).message).toContain('client working directory')
    }
  })

  it('throws ValidationError when effective write root contains state home (~/.agy-worker)', () => {
    const sHome = stateHome()
    expect(() => validateWriteRoots([sHome])).toThrow(ValidationError)
    try {
      validateWriteRoots([sHome])
    } catch (e) {
      expect((e as ValidationError).detail.field).toBe('write_roots')
    }
  })

  it('throws ValidationError when effective write root contains gate binary', () => {
    const fakeGate = join(workspace, 'bin', 'gate.js')
    expect(() => validateWriteRoots([workspace], fakeGate)).toThrow(ValidationError)
  })

  it('accepts legitimate workspace write root', () => {
    expect(() => validateWriteRoots([workspace])).not.toThrow()
  })
})

