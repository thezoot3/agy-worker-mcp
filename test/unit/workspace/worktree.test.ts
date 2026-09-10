import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ValidationError } from '../../../src/contract/errors.js'
import type { EffectivePolicy, JobRow } from '../../../src/contract/types.js'
import { decide } from '../../../src/gate/gate.js'
import { EMPTY_CEILING } from '../../../src/policy/ceiling.js'
import { resolvePolicy } from '../../../src/policy/profiles.js'
import { createJobWorktree, removeJobWorktree, worktreeStatus } from '../../../src/workspace/worktree.js'

let hasGit = false
try {
  const check = spawnSync('git', ['--version'], { stdio: 'ignore' })
  hasGit = check.status === 0
} catch {
  hasGit = false
}

function runGit(cwd: string, args: string[]): string {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
  if (res.status !== 0) {
    throw new Error(`git command failed (${args.join(' ')}): ${res.stderr || res.stdout}`)
  }
  return (res.stdout || '').trim()
}

function makeRepository(parent: string, name: string): string {
  const repo = join(parent, name)
  mkdirSync(repo, { recursive: true })
  runGit(repo, ['init', '-b', 'main'])
  runGit(repo, ['config', 'user.name', 'Test User'])
  runGit(repo, ['config', 'user.email', 'test@example.com'])
  runGit(repo, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, 'tracked.txt'), 'initial content')
  runGit(repo, ['add', '.'])
  runGit(repo, ['commit', '-m', 'initial commit'])
  return repo
}

describe('createJobWorktree and removeJobWorktree', () => {
  let tempDir: string
  let repo: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'agy-worktree-test-'))
    if (hasGit) {
      repo = makeRepository(tempDir, 'base-repo')
    }
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it.skipIf(!hasGit)('1. creates <root>/.worktrees/agy-<id> on branch agy/<id>', () => {
    const jobId = 'test-job-1'
    const creation = createJobWorktree({
      root: repo,
      jobId,
      baseRef: 'HEAD',
      linkPaths: [],
    })

    const expectedPath = join(repo, '.worktrees', `agy-${jobId}`)
    const expectedBranch = `agy/${jobId}`

    expect(creation.path).toBe(expectedPath)
    expect(creation.branch).toBe(expectedBranch)
    expect(existsSync(creation.path)).toBe(true)

    const currentBranch = runGit(creation.path, ['branch', '--show-current'])
    expect(currentBranch).toBe(expectedBranch)
  })

  it.skipIf(!hasGit)('2. base_commit equals git rev-parse HEAD of the base repository', () => {
    const headCommit = runGit(repo, ['rev-parse', 'HEAD'])
    const creation = createJobWorktree({
      root: repo,
      jobId: 'test-job-2',
      baseRef: 'HEAD',
      linkPaths: [],
    })

    expect(creation.base_commit).toBe(headCommit)
  })

  it.skipIf(!hasGit)('3. a base_ref that does not exist throws ValidationError and creates nothing on disk', () => {
    expect(() =>
      createJobWorktree({
        root: repo,
        jobId: 'test-job-3',
        baseRef: 'non-existent-ref-abc-123',
        linkPaths: [],
      }),
    ).toThrow(ValidationError)

    expect(existsSync(join(repo, '.worktrees'))).toBe(false)
  })

  it.skipIf(!hasGit)('4. link_paths: ["node_modules"] produces a symlink whose realpath is the base repository\'s node_modules', () => {
    const nodeModulesDir = join(repo, 'node_modules')
    mkdirSync(nodeModulesDir, { recursive: true })
    writeFileSync(join(nodeModulesDir, 'package.json'), '{"name":"test"}')

    const creation = createJobWorktree({
      root: repo,
      jobId: 'test-job-4',
      baseRef: 'HEAD',
      linkPaths: ['node_modules'],
    })

    const worktreeNodeModules = join(creation.path, 'node_modules')
    expect(existsSync(worktreeNodeModules)).toBe(true)
    expect(lstatSync(worktreeNodeModules).isSymbolicLink()).toBe(true)
    expect(realpathSync(worktreeNodeModules)).toBe(realpathSync(nodeModulesDir))

    const content = readFileSync(join(worktreeNodeModules, 'package.json'), 'utf8')
    expect(content).toBe('{"name":"test"}')
    expect(creation.linked).toEqual(['node_modules'])
  })

  it.skipIf(!hasGit)('5. a link_paths entry that does not exist is skipped and reported in warnings, and the worktree still exists', () => {
    const creation = createJobWorktree({
      root: repo,
      jobId: 'test-job-5',
      baseRef: 'HEAD',
      linkPaths: ['uninstalled_dep'],
    })

    expect(existsSync(creation.path)).toBe(true)
    expect(creation.linked).toEqual([])
    expect(creation.warnings.some((w) => w.includes('uninstalled_dep'))).toBe(true)
  })

  it.skipIf(!hasGit)('6. removeJobWorktree removes both worktree and branch, and is idempotent — a second call does not throw', () => {
    const creation = createJobWorktree({
      root: repo,
      jobId: 'test-job-6',
      baseRef: 'HEAD',
      linkPaths: [],
    })

    expect(existsSync(creation.path)).toBe(true)

    // First call: removes both worktree and branch
    removeJobWorktree({
      root: repo,
      path: creation.path,
      branch: creation.branch,
    })

    expect(existsSync(creation.path)).toBe(false)
    const branchCheck = spawnSync('git', ['rev-parse', '--verify', creation.branch], { cwd: repo })
    expect(branchCheck.status).not.toBe(0)

    // Second call: idempotent, does not throw
    expect(() =>
      removeJobWorktree({
        root: repo,
        path: creation.path,
        branch: creation.branch,
      }),
    ).not.toThrow()
  })

  it.skipIf(!hasGit)('7. worktreeStatus counts an uncommitted file and reports zero on a clean worktree', () => {
    const jobId = 'test-job-7'
    const creation = createJobWorktree({
      root: repo,
      jobId,
      baseRef: 'HEAD',
      linkPaths: [],
    })

    // Clean worktree: 0 changed files
    expect(worktreeStatus(creation.path)).toBe(0)

    // Add an uncommitted file
    writeFileSync(join(creation.path, 'uncommitted.txt'), 'hello')
    expect(worktreeStatus(creation.path)).toBe(1)

    // Remove worktree
    removeJobWorktree({
      root: repo,
      path: creation.path,
      branch: creation.branch,
      force: true,
    })
  })

  /**
   * Every caller of `worktreeStatus` is deciding whether to delete a directory,
   * so "git would not answer" has to be distinguishable from "nothing changed".
   * A fail-open zero would delete a worktree whose unmerged work is the entire
   * output of a job.
   */
  it('reports null when git cannot answer, and 0 when there is nothing to lose', () => {
    const notARepository = join(tempDir, 'not-a-repository')
    mkdirSync(notARepository, { recursive: true })
    expect(worktreeStatus(notARepository)).toBeNull()

    expect(worktreeStatus(join(tempDir, 'never-existed'))).toBe(0)
  })
})

/**
 * The whole point of `link_paths`, and the part no unit of it proves alone:
 * `canonicalize()` resolves symlinks, so a read of
 * `<worktree>/node_modules/x` *is* a read of `<root>/node_modules/x` by the
 * time containment sees it — outside the job's own workspace. Three layers
 * have to agree (containment roots, the allow list, and the gate that consults
 * both) or a worktree job cannot run a single test. Asserting on
 * `policy.read_roots` alone would keep passing if the gate stopped consulting
 * them.
 */
describe('worktree isolation, decided by the gate', () => {
  let tempDir: string
  let repo: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'agy-worktree-gate-'))
    if (hasGit) repo = makeRepository(tempDir, 'base-repo')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  function worktreePolicy(creation: { path: string; linkedRoots: string[] }): EffectivePolicy {
    return resolvePolicy({
      profile: 'general_worker',
      workspace: creation.path,
      ceiling: { ...EMPTY_CEILING, present: true, version: 2, link_paths: ['node_modules'] },
      linkedRoots: creation.linkedRoots,
    })
  }

  function verdict(policy: EffectivePolicy, name: string, args: Record<string, unknown>): string {
    const job = {
      job_id: 'worktree-job',
      session_id: null,
      lifecycle: 'running',
      outcome: null,
      headline: null,
      cwd: policy.workspace,
      profile: 'general_worker',
      write_mode: 1,
      session_mode: 'oneshot',
      pid: 1,
      pgid: 1,
      proc_start_time: 'x',
      created_at: 0,
      started_at: 0,
      finished_at: null,
      deadline_at: null,
      exit_code: null,
      agent_status: null,
      contract_status: null,
      on_denial: 'continue',
      requested_by: null,
      parent_task_id: null,
    } as unknown as JobRow
    const outcome = decide({
      payload: { conversationId: 'conv-1', toolCall: { name, args } },
      bound: { job, policy, conversationId: 'conv-1' },
    })
    return outcome.decision.decision
  }

  it.skipIf(!hasGit)('reads through the link are allowed; writes through it are not', () => {
    mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
    const creation = createJobWorktree({
      root: repo,
      jobId: 'gate-job',
      baseRef: 'HEAD',
      linkPaths: ['node_modules'],
    })
    const policy = worktreePolicy(creation)
    const linked = join(creation.path, 'node_modules', 'dep', 'index.js')

    expect(verdict(policy, 'view_file', { AbsolutePath: linked })).toBe('allow')
    expect(verdict(policy, 'run_command', { CommandLine: 'cat node_modules/dep/index.js', Cwd: creation.path })).toBe('allow')
    expect(verdict(policy, 'run_command', { CommandLine: `cat ${linked}`, Cwd: creation.path })).toBe('allow')

    // The shared directory is the base repository's, and every other worktree's.
    // One job mutating it would leak into all of them and into the user's own
    // working tree.
    expect(verdict(policy, 'write_to_file', { TargetFile: linked, CodeContent: 'x' })).toBe('deny')
    expect(
      verdict(policy, 'run_command', {
        CommandLine: `echo x > ${join(repo, 'node_modules', 'dep', 'index.js')}`,
        Cwd: creation.path,
      }),
    ).toBe('deny')

    // Writes inside the worktree are the job's actual work.
    expect(verdict(policy, 'write_to_file', { TargetFile: join(creation.path, 'tracked.txt'), CodeContent: 'x' })).toBe('allow')

    // The link widens reads to exactly one directory, not to the repository
    // the worktree came from.
    expect(verdict(policy, 'run_command', { CommandLine: `cat ${join(repo, 'tracked.txt')}`, Cwd: creation.path })).toBe('deny')

    // A job that could add or remove worktrees could move its own workspace out
    // from under the gate.
    expect(verdict(policy, 'run_command', { CommandLine: 'git worktree add /tmp/elsewhere', Cwd: creation.path })).toBe('deny')

    removeJobWorktree({ root: repo, path: creation.path, branch: creation.branch, force: true })
  })
})
