import { z } from 'zod'

import { reconcile } from '../../broker/reconcile.js'
import { isPidAlive, isSameProcess, killProcessGroup } from '../../runner/reap.js'
import { getJob, updateJob } from '../../store/jobs.js'
import { errorReply, reply, type ToolContext, type ToolReply } from '../context.js'

/**
 * `agy_cancel` — kill a running job and everything it spawned.
 *
 * Signals the process group, not the pid, so agy's own children die too
 * (`docs/04` #10 verifies `pgrep -g` afterwards).
 */
export const cancelInput = z.object({
  job_id: z.string(),
  reason: z.string().optional(),
  grace_ms: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Milliseconds between SIGTERM and SIGKILL.'),
})

export type CancelInput = z.infer<typeof cancelInput>

export async function handleCancel(ctx: ToolContext, input: CancelInput): Promise<ToolReply> {
  try {
    await reconcile(ctx.store)
    let job = getJob(ctx.store, input.job_id)

    if (job.lifecycle === 'finished') {
      return reply({ job_id: job.job_id, lifecycle: job.lifecycle, killed: false, message: 'already finished' })
    }

    // Only signal the recorded pgid when we can confirm it still identifies
    // *our* process: a null proc_start_time (nothing was ever recorded) or a pid
    // that no longer matches it means the pgid may have been recycled by an
    // unrelated process tree since (finding 6) — do not kill in that case.
    let killed = false
    if (
      job.pgid !== null &&
      job.pid !== null &&
      job.proc_start_time !== null &&
      isPidAlive(job.pid) &&
      isSameProcess(job.pid, job.proc_start_time)
    ) {
      killed = await killProcessGroup(job.pgid, { graceMs: input.grace_ms })
    }

    job = updateJob(ctx.store, job.job_id, { lifecycle: 'canceling' })
    // The runner still owns writing exit_code; the next reconcile finalizes
    // this as `canceled` once it appears (`docs/01` 결정 5).
    await reconcile(ctx.store)
    job = getJob(ctx.store, job.job_id)

    return reply({
      job_id: job.job_id,
      lifecycle: job.lifecycle,
      outcome: job.outcome,
      killed,
      pgid: job.pgid,
      reason: input.reason ?? null,
    })
  } catch (e) {
    return errorReply(e)
  }
}
