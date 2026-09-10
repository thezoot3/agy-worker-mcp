import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { canonicalize } from '../../src/contract/paths.js'
import { createContext } from '../../src/server/context.js'
import { handleStart } from '../../src/server/tools/start.js'
import { applyEnv, ensureBuilt, makeProject, replyJson, type TestProject } from './helpers.js'

let project: TestProject

beforeAll(() => {
  ensureBuilt()
})

beforeEach(() => {
  project = makeProject({ git: true })
  applyEnv(project, 'happy')
})

afterEach(() => {
  rmSync(project.home, { recursive: true, force: true })
  rmSync(project.root, { recursive: true, force: true })
  rmSync(project.fakeStateDir, { recursive: true, force: true })
})

import type { WorkspaceInfo } from '../../src/contract/types.js'

interface StartSuccessReply {
  job_id: string
  session_id: string
  cwd: string
  dry_run: boolean
  workspace?: WorkspaceInfo
}

interface StartErrorReply {
  error: string
  message: string
  detail?: {
    field?: string
    value?: unknown
    expected?: string
  }
}

describe('start tool with isolation: "worktree"', () => {
  it('10. isolation: "worktree" with base_ref set and dry_run: true returns workspace block and creates no .worktrees directory', async () => {
    const ctx = createContext()
    try {
      const res = await handleStart(ctx, {
        prompt: 'test worktree dry run',
        isolation: 'worktree',
        base_ref: 'HEAD',
        dry_run: true,
      })
      expect(res.isError).toBeFalsy()
      const reply = replyJson<StartSuccessReply>(res)
      expect(reply.workspace).toBeDefined()
      expect(reply.workspace?.kind).toBe('worktree')
      expect(reply.workspace?.branch).toBe(`agy/${reply.job_id}`)
      expect(reply.workspace?.path).toBe(join(canonicalize(project.root), '.worktrees', `agy-${reply.job_id}`))
      expect(reply.workspace?.committed).toBe(false)
      expect(reply.workspace?.changed_file_count).toBe(0)

      // Ensure no .worktrees directory was created on disk in dry_run
      expect(existsSync(join(project.root, '.worktrees'))).toBe(false)
    } finally {
      ctx.store.db.close()
    }
  })

  it('11. base_ref without isolation is a ValidationError on field base_ref', async () => {
    const ctx = createContext()
    try {
      const res = await handleStart(ctx, {
        prompt: 'test base_ref without isolation',
        base_ref: 'HEAD',
        dry_run: true,
      })
      expect(res.isError).toBe(true)
      const err = replyJson<StartErrorReply>(res)
      expect(err.error).toBe('VALIDATION')
      expect(err.detail?.field).toBe('base_ref')
    } finally {
      ctx.store.db.close()
    }
  })

  it('12. isolation: "worktree" on a non-git project root is a ValidationError on field isolation', async () => {
    const nonGitProj = makeProject({ git: false })
    applyEnv(nonGitProj, 'happy')
    const ctx = createContext()
    try {
      const res = await handleStart(ctx, {
        prompt: 'test isolation on non-git repo',
        isolation: 'worktree',
        dry_run: true,
      })
      expect(res.isError).toBe(true)
      const err = replyJson<StartErrorReply>(res)
      expect(err.error).toBe('VALIDATION')
      expect(err.detail?.field).toBe('isolation')
    } finally {
      ctx.store.db.close()
      rmSync(nonGitProj.home, { recursive: true, force: true })
      rmSync(nonGitProj.root, { recursive: true, force: true })
      rmSync(nonGitProj.fakeStateDir, { recursive: true, force: true })
    }
  })

  it('isolation: "worktree" while cwd is a subdirectory throws ValidationError on field cwd', async () => {
    const subDir = join(project.root, 'subdir')
    mkdirSync(subDir, { recursive: true })
    const ctx = createContext()
    try {
      const res = await handleStart(ctx, {
        prompt: 'test worktree with subdirectory cwd',
        isolation: 'worktree',
        cwd: subDir,
        dry_run: true,
      })
      expect(res.isError).toBe(true)
      const err = replyJson<StartErrorReply>(res)
      expect(err.error).toBe('VALIDATION')
      expect(err.detail?.field).toBe('cwd')
      expect(err.detail?.expected).toContain(
        'omit cwd, or pass the project root: isolation "worktree" makes a worktree of the whole repository',
      )
    } finally {
      ctx.store.db.close()
    }
  })

  it('4. on_finish without isolation is a ValidationError on field on_finish', async () => {
    const ctx = createContext()
    try {
      const res = await handleStart(ctx, {
        prompt: 'test on_finish without isolation',
        on_finish: 'remove',
        dry_run: true,
      })
      expect(res.isError).toBe(true)
      const err = replyJson<StartErrorReply>(res)
      expect(err.error).toBe('VALIDATION')
      expect(err.detail?.field).toBe('on_finish')
    } finally {
      ctx.store.db.close()
    }
  })

  it('5. agy_start with isolation: "worktree" replies with a workspace block whose kind is "worktree", committed is false and changed_file_count is 0', async () => {
    const ctx = createContext()
    try {
      const res = await handleStart(ctx, {
        prompt: 'test worktree real start',
        isolation: 'worktree',
        base_ref: 'HEAD',
      })
      expect(res.isError).toBeFalsy()
      const reply = replyJson<StartSuccessReply>(res)
      expect(reply.workspace).toBeDefined()
      expect(reply.workspace?.kind).toBe('worktree')
      expect(reply.workspace?.committed).toBe(false)
      expect(reply.workspace?.changed_file_count).toBe(0)
      expect(reply.workspace?.branch).toBe(`agy/${reply.job_id}`)
      expect(existsSync(reply.workspace!.path)).toBe(true)
    } finally {
      ctx.store.db.close()
    }
  })
})
