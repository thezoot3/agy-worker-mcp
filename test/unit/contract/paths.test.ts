/**
 * Acceptance unit tests for project root discovery (`src/contract/paths.ts`).
 *
 * Real git repositories, worktrees, and submodules are constructed via git
 * commands in a temporary directory rather than mock files because git worktree
 * indirection (`commondir`) and submodule pointers (`gitdir:` without
 * `commondir`) represent genuine git on-disk layouts that synthetic mocks
 * cannot faithfully replicate.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  canonicalize,
  projectKey,
  resolveProjectRoot,
  type ProjectRootResolution,
} from '../../../src/contract/paths.js'
import { ENV } from '../../../src/contract/types.js'

let hasGit = false
try {
  const check = spawnSync('git', ['--version'], { stdio: 'ignore' })
  hasGit = check.status === 0
} catch {
  hasGit = false
}

function runGit(workingDirectory: string, argumentsList: string[]): void {
  const result = spawnSync('git', argumentsList, {
    cwd: workingDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
  if (result.status !== 0) {
    throw new Error(`git command failed (${argumentsList.join(' ')}): ${result.stderr || result.stdout}`)
  }
}

/**
 * A fresh repository per case. Cases used to share one `plain-repository`
 * created by the first `it`, which made every later case depend on that one
 * running first — a filtered or skipped run failed for a reason that had
 * nothing to do with the behaviour under test.
 */
function makeRepository(parent: string, name: string): string {
  const repository = join(parent, name)
  mkdirSync(repository, { recursive: true })
  runGit(repository, ['init', '-b', 'main'])
  runGit(repository, ['config', 'user.name', 'Test User'])
  runGit(repository, ['config', 'user.email', 'test@example.com'])
  runGit(repository, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repository, 'tracked.txt'), 'content')
  runGit(repository, ['add', '.'])
  runGit(repository, ['commit', '-m', 'initial commit'])
  return repository
}

describe('resolveProjectRoot', () => {
  let temporaryDirectory: string
  let previousProjectEnvironment: string | undefined

  beforeAll(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'agy-paths-test-'))
  })

  afterAll(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  })

  beforeEach(() => {
    previousProjectEnvironment = process.env[ENV.PROJECT_ROOT]
    delete process.env[ENV.PROJECT_ROOT]
  })

  afterEach(() => {
    if (previousProjectEnvironment !== undefined) {
      process.env[ENV.PROJECT_ROOT] = previousProjectEnvironment
    } else {
      delete process.env[ENV.PROJECT_ROOT]
    }
  })

  it.skipIf(!hasGit)('plain repository: root is the repository, source git', () => {
    const mainRepository = makeRepository(temporaryDirectory, 'plain-repository')

    const resolution = resolveProjectRoot(mainRepository)
    expect(resolution.root).toBe(canonicalize(mainRepository))
    expect(resolution.source).toBe('git')
  })

  it.skipIf(!hasGit)('subdirectory of a plain repository: same root, source git', () => {
    const mainRepository = makeRepository(temporaryDirectory, 'plain-repository-nested')
    const subDirectory = join(mainRepository, 'nested', 'subfolder')
    mkdirSync(subDirectory, { recursive: true })

    const resolution = resolveProjectRoot(subDirectory)
    expect(resolution.root).toBe(canonicalize(mainRepository))
    expect(resolution.source).toBe('git')
  })

  it.skipIf(!hasGit)(
    'linked worktree: resolveProjectRoot returns main repository root, source git-worktree, and matching project keys',
    () => {
      const mainRepository = makeRepository(temporaryDirectory, 'worktree-parent')
      const linkedWorktree = join(temporaryDirectory, 'linked-worktree')
      runGit(mainRepository, ['worktree', 'add', linkedWorktree])

      const resolution = resolveProjectRoot(linkedWorktree)
      expect(resolution.root).toBe(canonicalize(mainRepository))
      expect(resolution.source).toBe('git-worktree')
      expect(resolution.movedFrom).toBe(canonicalize(linkedWorktree))
      // The point of the whole PR: one ceiling, one lock domain, one database
      // for every worktree of a repository. Resolve both sides independently
      // rather than re-keying the same string twice.
      expect(projectKey(resolution.root)).toBe(projectKey(resolveProjectRoot(mainRepository).root))
    },
  )

  it.skipIf(!hasGit)('subdirectory inside a linked worktree: same result', () => {
    const mainRepository = makeRepository(temporaryDirectory, 'worktree-parent-nested')
    const linkedWorktree = join(temporaryDirectory, 'linked-worktree-nested')
    runGit(mainRepository, ['worktree', 'add', linkedWorktree])
    const worktreeSubDirectory = join(linkedWorktree, 'source', 'nested')
    mkdirSync(worktreeSubDirectory, { recursive: true })

    const resolution = resolveProjectRoot(worktreeSubDirectory)
    const expectedRoot = canonicalize(mainRepository)
    expect(resolution.root).toBe(expectedRoot)
    expect(resolution.source).toBe('git-worktree')
    expect(projectKey(resolution.root)).toBe(projectKey(expectedRoot))
  })

  it.skipIf(!hasGit)('submodule: root is the submodule own directory, source git-submodule, not superproject', () => {
    const submoduleOrigin = join(temporaryDirectory, 'submodule-origin')
    mkdirSync(submoduleOrigin, { recursive: true })
    runGit(submoduleOrigin, ['init', '-b', 'main'])
    runGit(submoduleOrigin, ['config', 'user.name', 'Test User'])
    runGit(submoduleOrigin, ['config', 'user.email', 'test@example.com'])
    runGit(submoduleOrigin, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(submoduleOrigin, 'submodule.txt'), 'submodule content')
    runGit(submoduleOrigin, ['add', '.'])
    runGit(submoduleOrigin, ['commit', '-m', 'submodule init'])

    const superRepository = join(temporaryDirectory, 'super-repository')
    mkdirSync(superRepository, { recursive: true })
    runGit(superRepository, ['init', '-b', 'main'])
    runGit(superRepository, ['config', 'user.name', 'Test User'])
    runGit(superRepository, ['config', 'user.email', 'test@example.com'])
    runGit(superRepository, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(superRepository, 'super.txt'), 'super content')
    runGit(superRepository, ['add', '.'])
    runGit(superRepository, ['commit', '-m', 'super init'])

    runGit(superRepository, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      submoduleOrigin,
      'nested-submodule',
    ])

    const submoduleDirectory = join(superRepository, 'nested-submodule')
    const resolution = resolveProjectRoot(submoduleDirectory)
    expect(resolution.root).toBe(canonicalize(submoduleDirectory))
    expect(resolution.source).toBe('git-submodule')
    expect(resolution.root).not.toBe(canonicalize(superRepository))
  })

  it('non-git directory: root is the directory itself, source cwd', () => {
    const nonGitDirectory = join(temporaryDirectory, 'plain-directory')
    mkdirSync(nonGitDirectory, { recursive: true })

    const resolution = resolveProjectRoot(nonGitDirectory)
    expect(resolution.root).toBe(canonicalize(nonGitDirectory))
    expect(resolution.source).toBe('cwd')
  })

  it('AGY_WORKER_PROJECT set: wins over everything, source env', () => {
    const overrideDirectory = join(temporaryDirectory, 'override-directory')
    mkdirSync(overrideDirectory, { recursive: true })
    process.env[ENV.PROJECT_ROOT] = overrideDirectory

    const nonGitDirectory = join(temporaryDirectory, 'unrelated-directory')
    mkdirSync(nonGitDirectory, { recursive: true })

    const resolution = resolveProjectRoot(nonGitDirectory)
    expect(resolution.root).toBe(canonicalize(overrideDirectory))
    expect(resolution.source).toBe('env')
  })

  it('malformed .git file: does not throw, falls back to the directory holding the file', () => {
    const malformedDirectory = join(temporaryDirectory, 'malformed-git-directory')
    mkdirSync(malformedDirectory, { recursive: true })
    writeFileSync(join(malformedDirectory, '.git'), 'gitdir: /nonexistent/xyz\n')

    let resolution: ProjectRootResolution | null = null
    expect(() => {
      resolution = resolveProjectRoot(malformedDirectory)
    }).not.toThrow()
    expect(resolution!.root).toBe(canonicalize(malformedDirectory))
    expect(resolution!.source).toBe('git')
  })
})