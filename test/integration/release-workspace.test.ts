import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { jobPaths } from '../../src/contract/paths.js'
import { createContext } from '../../src/server/context.js'
import { handleReleaseWorkspace } from '../../src/server/tools/releaseWorkspace.js'
import { createJob, updateJob } from '../../src/store/jobs.js'
import { createJobWorktree } from '../../src/workspace/worktree.js'
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

interface ErrorReply {
  error: string
  message: string
  detail?: {
    field?: string
    value?: unknown
    expected?: string
  }
}

interface ReleaseSuccessReply {
  job_id: string
  removed: boolean
  path: string
  branch: string
  forced: boolean
}

describe('agy_release_workspace', () => {
  it('6. releasing an unknown job id is a ValidationError', async () => {
    const ctx = createContext()
    try {
      const res = await handleReleaseWorkspace(ctx, { job_id: 'nonexistent-job-id' })
      expect(res.isError).toBe(true)
      const reply = replyJson<ErrorReply>(res)
      expect(reply.error).toBe('VALIDATION')
      expect(reply.detail?.field).toBe('job_id')
    } finally {
      ctx.store.close()
    }
  })

  it('7. releasing an in_place job is a ValidationError naming that it ran in place', async () => {
    const ctx = createContext()
    try {
      const jobId = 'test-in-place-job'
      const paths = jobPaths(ctx.paths, jobId)
      mkdirSync(paths.dir, { recursive: true })
      writeFileSync(paths.effectiveConfig, JSON.stringify({ prompt: 'test in place' }))
      createJob(ctx.store, {
        jobId,
        sessionId: null,
        cwd: project.root,
        profile: 'general_worker',
        writeMode: true,
        sessionMode: 'oneshot',
        onDenial: 'continue',
        deadlineAt: null,
      })
      updateJob(ctx.store, jobId, {
        lifecycle: 'finished',
        finished_at: Date.now(),
      })

      const res = await handleReleaseWorkspace(ctx, { job_id: jobId })
      expect(res.isError).toBe(true)
      const reply = replyJson<ErrorReply>(res)
      expect(reply.error).toBe('VALIDATION')
      expect(reply.detail?.field).toBe('job_id')
      expect(reply.detail?.expected).toContain('in place')
    } finally {
      ctx.store.close()
    }
  })

  it('8. releasing a finished worktree job with a dirty tree and no force is a ValidationError naming the path; with force: true it succeeds and the directory is gone', async () => {
    const ctx = createContext()
    try {
      const jobId = 'test-worktree-dirty-job'
      const wt = createJobWorktree({ root: project.root, jobId, baseRef: 'HEAD', linkPaths: [] })
      const paths = jobPaths(ctx.paths, jobId)
      mkdirSync(paths.dir, { recursive: true })
      writeFileSync(
        paths.effectiveConfig,
        JSON.stringify({
          prompt: 'test worktree job',
          profile: 'general_worker',
          worktree: wt,
        }),
      )
      createJob(ctx.store, {
        jobId,
        sessionId: null,
        cwd: wt.path,
        profile: 'general_worker',
        writeMode: true,
        sessionMode: 'oneshot',
        onDenial: 'continue',
        deadlineAt: null,
      })
      updateJob(ctx.store, jobId, {
        lifecycle: 'finished',
        finished_at: Date.now(),
      })

      // Dirty the worktree with an uncommitted file
      writeFileSync(join(wt.path, 'uncommitted.txt'), 'dirty content')

      // Without force: should fail and name the path
      const resWithoutForce = await handleReleaseWorkspace(ctx, { job_id: jobId })
      expect(resWithoutForce.isError).toBe(true)
      const errReply = replyJson<ErrorReply>(resWithoutForce)
      expect(errReply.error).toBe('VALIDATION')
      expect(errReply.detail?.field).toBe('force')
      expect(errReply.detail?.expected).toContain(wt.path)

      // With force: true: should succeed and remove the worktree directory
      const resWithForce = await handleReleaseWorkspace(ctx, { job_id: jobId, force: true })
      expect(resWithForce.isError).toBeFalsy()
      const successReply = replyJson<ReleaseSuccessReply>(resWithForce)
      expect(successReply.job_id).toBe(jobId)
      expect(successReply.removed).toBe(true)
      expect(successReply.forced).toBe(true)
      expect(existsSync(wt.path)).toBe(false)
    } finally {
      ctx.store.close()
    }
  })

  it('9. a second release of the same job returns removed: false and does not throw', async () => {
    const ctx = createContext()
    try {
      const jobId = 'test-worktree-release-twice'
      const wt = createJobWorktree({ root: project.root, jobId, baseRef: 'HEAD', linkPaths: [] })
      const paths = jobPaths(ctx.paths, jobId)
      mkdirSync(paths.dir, { recursive: true })
      writeFileSync(
        paths.effectiveConfig,
        JSON.stringify({
          prompt: 'test worktree release twice',
          profile: 'general_worker',
          worktree: wt,
        }),
      )
      createJob(ctx.store, {
        jobId,
        sessionId: null,
        cwd: wt.path,
        profile: 'general_worker',
        writeMode: true,
        sessionMode: 'oneshot',
        onDenial: 'continue',
        deadlineAt: null,
      })
      updateJob(ctx.store, jobId, {
        lifecycle: 'finished',
        finished_at: Date.now(),
      })

      // First release removes it
      const res1 = await handleReleaseWorkspace(ctx, { job_id: jobId })
      expect(res1.isError).toBeFalsy()
      const reply1 = replyJson<ReleaseSuccessReply>(res1)
      expect(reply1.removed).toBe(true)
      expect(existsSync(wt.path)).toBe(false)

      // Second release returns removed: false without throwing
      const res2 = await handleReleaseWorkspace(ctx, { job_id: jobId })
      expect(res2.isError).toBeFalsy()
      const reply2 = replyJson<ReleaseSuccessReply>(res2)
      expect(reply2.removed).toBe(false)
    } finally {
      ctx.store.close()
    }
  })
})
