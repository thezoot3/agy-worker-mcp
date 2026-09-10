import { existsSync } from 'node:fs'
import { z } from 'zod'

import { reconcile } from '../../broker/reconcile.js'
import { ValidationError } from '../../contract/errors.js'
import { jobPaths, readJsonIfExists } from '../../contract/paths.js'
import type { EffectiveConfig } from '../../contract/types.js'
import { LIVE_LIFECYCLES, tryGetJob } from '../../store/jobs.js'
import { removeJobWorktree, worktreeStatus } from '../../workspace/worktree.js'
import { errorReply, reply, type ToolContext, type ToolReply } from '../context.js'

/**
 * `agy_release_workspace` — the eleventh tool.
 *
 * Takes a job worktree and its branch away after the caller merges.
 * Destructive and idempotent.
 */
export const releaseWorkspaceInput = z.object({
  job_id: z.string().describe('The job whose worktree should be released.'),
  force: z
    .boolean()
    .optional()
    .describe('Remove the worktree and branch even if uncommitted changes exist.'),
})

export type ReleaseWorkspaceInput = z.infer<typeof releaseWorkspaceInput>

export async function handleReleaseWorkspace(
  ctx: ToolContext,
  input: ReleaseWorkspaceInput,
): Promise<ToolReply> {
  try {
    await reconcile(ctx.store)

    const job = tryGetJob(ctx.store, input.job_id)
    if (!job) {
      throw new ValidationError({
        field: 'job_id',
        value: input.job_id,
        expected: `an existing job id in project ${ctx.paths.root}`,
      })
    }

    const paths = jobPaths(ctx.paths, job.job_id)
    const config = readJsonIfExists<EffectiveConfig>(paths.effectiveConfig)
    if (!config?.worktree) {
      throw new ValidationError({
        field: 'job_id',
        value: input.job_id,
        expected: 'a worktree job — this job ran in place and has nothing to release',
      })
    }

    if (LIVE_LIFECYCLES.includes(job.lifecycle)) {
      throw new ValidationError({
        field: 'job_id',
        value: input.job_id,
        expected: `a finished job — job is currently ${job.lifecycle}; releasing a workspace out from under a running job is not allowed`,
      })
    }

    const wt = config.worktree
    const alreadyGone = !existsSync(wt.path)

    if (!alreadyGone) {
      // `null` is git declining to answer. Treated as dirty on purpose: this
      // tool deletes a directory, and the one thing worse than refusing a
      // release is granting one that throws away work nobody merged.
      const changedCount = worktreeStatus(wt.path)
      if (changedCount !== 0 && !input.force) {
        throw new ValidationError(
          {
            field: 'force',
            value: input.force,
            expected:
              changedCount === null
                ? `a worktree whose status git can read — merge ${wt.branch} first, or pass force: true to remove ${wt.path} regardless`
                : `a clean worktree — ${wt.path} has ${changedCount} uncommitted change(s) on branch ${wt.branch}. Merge the branch first, or pass force: true to discard them`,
          },
          changedCount === null
            ? `cannot read the status of worktree ${wt.path}`
            : `worktree ${wt.path} on branch ${wt.branch} has ${changedCount} uncommitted change(s)`,
        )
      }
    }

    removeJobWorktree({
      root: ctx.paths.root,
      path: wt.path,
      branch: wt.branch,
      // Even a worktree with nothing of the caller's left in it still holds the
      // `.agents/hooks.json` this server wrote, which plain `git worktree
      // remove` refuses to delete.
      force: true,
    })

    return reply({
      job_id: job.job_id,
      removed: !alreadyGone,
      path: wt.path,
      branch: wt.branch,
      forced: Boolean(input.force),
    })
  } catch (e) {
    return errorReply(e)
  }
}
