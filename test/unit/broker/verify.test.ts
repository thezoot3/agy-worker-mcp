import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { changedFiles, isHousekeepingPorcelainLine } from '../../../src/broker/verify.js'

describe('changedFiles porcelain filtering', () => {
  let repoDir: string

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'agy-verify-test-'))
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' })
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
  })

  it('reports no changed files when the only workspace change is .agents/hooks.json', () => {
    mkdirSync(join(repoDir, '.agents'), { recursive: true })
    writeFileSync(join(repoDir, '.agents', 'hooks.json'), '{"PreToolUse":[]}\n', 'utf8')

    const changed = changedFiles(repoDir)
    expect(changed).toEqual([])
  })

  it('reports only the source file when both .agents/hooks.json and a source file are changed', () => {
    mkdirSync(join(repoDir, '.agents'), { recursive: true })
    writeFileSync(join(repoDir, '.agents', 'hooks.json'), '{"PreToolUse":[]}\n', 'utf8')

    mkdirSync(join(repoDir, 'src'), { recursive: true })
    writeFileSync(join(repoDir, 'src', 'index.ts'), 'console.log("hello")\n', 'utf8')

    const changed = changedFiles(repoDir)
    expect(changed).toEqual(['?? src/'])
  })

  it('filters .worktrees/ and anything under it', () => {
    mkdirSync(join(repoDir, '.worktrees', 'job-1'), { recursive: true })
    writeFileSync(join(repoDir, '.worktrees', 'job-1', 'file.txt'), 'content\n', 'utf8')

    const changed = changedFiles(repoDir)
    expect(changed).toEqual([])
  })
})

describe('isHousekeepingPorcelainLine', () => {
  it('filters .agents/ and .worktrees/ entries', () => {
    expect(isHousekeepingPorcelainLine('?? .agents/')).toBe(true)
    expect(isHousekeepingPorcelainLine('?? .agents/hooks.json')).toBe(true)
    expect(isHousekeepingPorcelainLine(' M .agents/hooks.json')).toBe(true)
    expect(isHousekeepingPorcelainLine('?? .worktrees/')).toBe(true)
    expect(isHousekeepingPorcelainLine('?? .worktrees/job-1/')).toBe(true)
    expect(isHousekeepingPorcelainLine('?? ".agents/hooks.json"')).toBe(true)
    expect(isHousekeepingPorcelainLine('?? ".worktrees/branch with spaces/file"')).toBe(true)
  })

  it('filters renames involving housekeeping artefacts', () => {
    expect(isHousekeepingPorcelainLine('R  .agents/old -> .agents/new')).toBe(true)
    expect(isHousekeepingPorcelainLine('R  old -> .agents/new')).toBe(true)
    expect(isHousekeepingPorcelainLine('R  .worktrees/old -> new')).toBe(true)
  })

  it('preserves non-housekeeping entries unchanged, including renames and quoted paths', () => {
    expect(isHousekeepingPorcelainLine('?? src/index.ts')).toBe(false)
    expect(isHousekeepingPorcelainLine(' M package.json')).toBe(false)
    expect(isHousekeepingPorcelainLine('R  old.txt -> new.txt')).toBe(false)
    expect(isHousekeepingPorcelainLine('R  "old with spaces.txt" -> "new with spaces.txt"')).toBe(false)
    expect(isHousekeepingPorcelainLine('?? "some \\"quoted\\" file.txt"')).toBe(false)
    expect(isHousekeepingPorcelainLine('?? "path with spaces/file.txt"')).toBe(false)
  })

  it('does not filter filenames that innocently contain .agents or .worktrees as substrings', () => {
    expect(isHousekeepingPorcelainLine('?? my.agents.ts')).toBe(false)
    expect(isHousekeepingPorcelainLine('?? .agents_backup')).toBe(false)
    expect(isHousekeepingPorcelainLine('?? .worktrees_extra')).toBe(false)
    expect(isHousekeepingPorcelainLine('?? sub/.agents/file')).toBe(false)
  })
})
