import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { ValidationError } from '../contract/errors.js'
import { canonicalize } from '../contract/paths.js'

export interface WorktreeCreation {
  path: string
  branch: string
  base_ref: string
  base_commit: string
  linked: string[]
  linkedRoots: string[]
  warnings: string[]
}

/**
 * Creates an isolated git worktree for a job at `<root>/.worktrees/agy-<jobId>`
 * on branch `agy/<jobId>` based on `baseRef`. Symlinks specified ceiling linkPaths
 * from the base repository into the worktree.
 */
export function createJobWorktree(input: {
  root: string
  jobId: string
  baseRef: string
  linkPaths: string[]
}): WorktreeCreation {
  const baseRef = input.baseRef || 'HEAD'

  // Resolve base_commit before creating anything on disk so an invalid ref
  // fails immediately without leaving orphaned directories behind.
  const revParse = spawnSync('git', ['rev-parse', baseRef], {
    cwd: input.root,
    encoding: 'utf8',
  })
  if (revParse.status !== 0) {
    const err = (revParse.stderr || revParse.stdout || '').trim()
    throw new ValidationError({
      field: 'base_ref',
      value: input.baseRef,
      expected: err || `valid git ref (${baseRef})`,
    })
  }
  const baseCommit = revParse.stdout.trim()

  const worktreePath = join(input.root, '.worktrees', `agy-${input.jobId}`)
  const branch = `agy/${input.jobId}`

  const addProc = spawnSync(
    'git',
    ['worktree', 'add', '-b', branch, worktreePath, baseRef],
    {
      cwd: input.root,
      encoding: 'utf8',
    },
  )
  if (addProc.status !== 0) {
    const err = (addProc.stderr || addProc.stdout || '').trim()
    throw new ValidationError({
      field: 'worktree',
      value: worktreePath,
      expected: err || 'git worktree add to succeed',
    })
  }

  const linked: string[] = []
  const linkedRoots: string[] = []
  const warnings: string[] = []

  for (const entry of input.linkPaths) {
    const source = join(input.root, entry)
    if (!existsSync(source)) {
      warnings.push(`link_paths entry "${entry}" does not exist and was skipped`)
      continue
    }

    const target = join(worktreePath, entry)
    try {
      mkdirSync(dirname(target), { recursive: true })
      // Point symlink at the absolute source path so it remains valid
      // regardless of the worktree's location.
      const absSource = resolve(input.root, entry)
      symlinkSync(absSource, target)
      linked.push(entry)
      linkedRoots.push(canonicalize(source))
    } catch (err) {
      // Roll back the entire worktree if a dependency link cannot be created;
      // a job running without its expected links would fail ambiguously later.
      removeJobWorktree({
        root: input.root,
        path: worktreePath,
        branch,
        force: true,
      })
      throw new ValidationError({
        field: 'link_paths',
        value: entry,
        expected: `symlink creation to succeed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  return {
    path: worktreePath,
    branch,
    base_ref: baseRef,
    base_commit: baseCommit,
    linked,
    linkedRoots,
    warnings,
  }
}

/**
 * Removes a job worktree and its branch. Idempotent: safe to call on a worktree
 * or branch that is already gone.
 */
export function removeJobWorktree(input: {
  root: string
  path: string
  branch: string | null
  force?: boolean
}): void {
  const removeArgs = ['worktree', 'remove']
  if (input.force) {
    removeArgs.push('--force')
  }
  removeArgs.push(input.path)

  const removeProc = spawnSync('git', removeArgs, {
    cwd: input.root,
    encoding: 'utf8',
  })

  if (removeProc.status !== 0) {
    const err = (removeProc.stderr || removeProc.stdout || '').trim()
    const isAlreadyGone =
      err.includes('is not a working tree') ||
      err.includes('not a valid working tree') ||
      err.includes('is not a worktree') ||
      err.includes('No such file or directory') ||
      !existsSync(input.path)

    if (!isAlreadyGone) {
      throw new ValidationError({
        field: 'worktree',
        value: input.path,
        expected: err || 'git worktree remove to succeed',
      })
    }

    // Prune stale worktree administrative metadata if the directory was already gone.
    spawnSync('git', ['worktree', 'prune'], {
      cwd: input.root,
      encoding: 'utf8',
    })
  }

  if (input.branch) {
    const branchArgs = ['branch', input.force ? '-D' : '-d', input.branch]
    const branchProc = spawnSync('git', branchArgs, {
      cwd: input.root,
      encoding: 'utf8',
    })

    if (branchProc.status !== 0) {
      const err = (branchProc.stderr || branchProc.stdout || '').trim()
      const isNotFound = err.includes('not found')
      if (!isNotFound) {
        throw new ValidationError({
          field: 'branch',
          value: input.branch,
          expected: err || `git branch ${input.force ? '-D' : '-d'} to succeed`,
        })
      }
    }
  }
}
