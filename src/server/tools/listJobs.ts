import { z } from 'zod'

import { reconcile } from '../../broker/reconcile.js'
import { listJobs } from '../../store/jobs.js'
import { errorReply, reply, type ToolContext, type ToolReply } from '../context.js'

/**
 * `agy_list_jobs` — running and recently finished jobs in this project.
 *
 * Jobs are per-project by construction; there is no cross-project view, which is
 * the isolation property this design wanted anyway (`docs/01` 결정 1).
 */
export const listJobsInput = z.object({
  lifecycle: z
    .array(z.enum(['queued', 'starting', 'running', 'canceling', 'finished']))
    .optional()
    .describe('Restrict to these lifecycle states.'),
  session_id: z.string().optional(),
  cwd: z.string().optional().describe('Exact match on the canonical workspace path.'),
  since_ms: z.number().int().positive().optional().describe('Only jobs created in the last N ms.'),
  limit: z.number().int().positive().optional(),
})

export type ListJobsInput = z.infer<typeof listJobsInput>

export async function handleListJobs(ctx: ToolContext, input: ListJobsInput): Promise<ToolReply> {
  try {
    await reconcile(ctx.store)
    const rows = listJobs(ctx.store, {
      lifecycle: input.lifecycle,
      sessionId: input.session_id,
      cwd: input.cwd,
      since: input.since_ms !== undefined ? Date.now() - input.since_ms : undefined,
      limit: input.limit,
    })
    return reply({ jobs: rows, count: rows.length })
  } catch (e) {
    return errorReply(e)
  }
}
