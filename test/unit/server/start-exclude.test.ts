import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ensureGitExclude } from '../../../src/server/tools/start.js'

describe('ensureGitExclude housekeeping', () => {
  let tempBase: string
  let repoDir: string

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), 'agy-exclude-test-'))
    repoDir = join(tempBase, 'repo')
    mkdirSync(repoDir, { recursive: true })
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' })
  })

  afterEach(() => {
    rmSync(tempBase, { recursive: true, force: true })
  })

  it('gains both lines exactly once when run twice on the same workspace', () => {
    const excludeFile = join(repoDir, '.git', 'info', 'exclude')
    expect(existsSync(excludeFile)).toBe(true)

    // First run
    ensureGitExclude(repoDir)
    let content = readFileSync(excludeFile, 'utf8')
    expect(content).toContain('.agents/\n')
    expect(content).toContain('.worktrees/\n')

    // Second run
    ensureGitExclude(repoDir)
    content = readFileSync(excludeFile, 'utf8')
    const agentsMatches = content.match(/\.agents\//g) ?? []
    const worktreesMatches = content.match(/\.worktrees\//g) ?? []
    expect(agentsMatches.length).toBe(1)
    expect(worktreesMatches.length).toBe(1)
  })

  it('does not duplicate an existing entry already present in another form', () => {
    const excludeFile = join(repoDir, '.git', 'info', 'exclude')
    writeFileSync(excludeFile, '# Custom ignore\n.agents\n', 'utf8')

    ensureGitExclude(repoDir)

    const content = readFileSync(excludeFile, 'utf8')
    // .agents was already present, so .agents/ must not be added
    expect(content).not.toContain('.agents/\n')
    // .worktrees/ should be added
    expect(content).toContain('.worktrees/\n')
  })

  it('does nothing and never throws on a non-git workspace', () => {
    const nonGit = join(tempBase, 'non-git')
    mkdirSync(nonGit, { recursive: true })

    expect(() => ensureGitExclude(nonGit)).not.toThrow()
    expect(existsSync(join(nonGit, '.git'))).toBe(false)
  })

  it('updates .git/info/exclude in a linked worktree where .git is a file', () => {
    // Commit a dummy file so a branch can be created for worktree
    writeFileSync(join(repoDir, 'initial.txt'), 'initial\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, stdio: 'ignore' })

    const worktreeDir = join(tempBase, 'wt')
    execFileSync('git', ['worktree', 'add', worktreeDir, '-b', 'wt-branch'], { cwd: repoDir, stdio: 'ignore' })

    // Verify .git is a file in the worktree
    const wtGit = join(worktreeDir, '.git')
    const contentWtGit = readFileSync(wtGit, 'utf8')
    expect(contentWtGit.startsWith('gitdir:')).toBe(true)

    // Call ensureGitExclude on the linked worktree
    ensureGitExclude(worktreeDir)

    // The shared exclude file in the main repository must be updated
    const mainExclude = join(repoDir, '.git', 'info', 'exclude')
    const mainContent = readFileSync(mainExclude, 'utf8')
    expect(mainContent).toContain('.agents/\n')
    expect(mainContent).toContain('.worktrees/\n')

    // Calling it again should not duplicate
    ensureGitExclude(worktreeDir)
    const afterContent = readFileSync(mainExclude, 'utf8')
    const agentsCount = (afterContent.match(/\.agents\//g) ?? []).length
    const wtCount = (afterContent.match(/\.worktrees\//g) ?? []).length
    expect(agentsCount).toBe(1)
    expect(wtCount).toBe(1)
  })
})
