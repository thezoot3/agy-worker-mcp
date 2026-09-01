import { z } from 'zod'

import { ValidationError } from '../../contract/errors.js'
import { jobPaths } from '../../contract/paths.js'
import { reconcile } from '../../broker/reconcile.js'
import { appendClose, appendUserTurn } from '../../runner/inbox.js'
import { getJob } from '../../store/jobs.js'
import { errorReply, reply, type ToolContext, type ToolReply } from '../context.js'

/**
 * `agy_send` — queue a follow-up turn.
 *
 * Appends one line to `jobs/<id>/inbox.jsonl` and returns. It does not touch the
 * process; the runner relays the line to agy's stdin (`docs/03` §3.4).
 *
 * ⚠ Queued turns only queue. agy finishes the in-flight turn first and there is no
 * way to interrupt or redirect it in print mode (§7).
 *
 * ⚠ Does **not** touch `deadline_at` (`docs/04` 미해결 질문 2, decided). The job's
 * hard deadline is fixed once at `agy_start` from `timeout_ms` and this handler
 * never patches it — see the comment on `EffectiveConfig.deadline_at` for why
 * (short version: an ever-pushed-out deadline lets an actively-fed session hold
 * its locks indefinitely, and nothing else would notice since `reconcile` only
 * runs from a tool entry point). Use `idle_timeout_ms` (`agy_start`) if the goal
 * is "end this session promptly once nobody is sending more turns" — that is a
 * different axis (idle vs. total wall-clock) and is enforced by the runner
 * itself, not by anything `agy_send` does here.
 */
export const sendInput = z.object({
  job_id: z.string(),
  text: z.string().optional().describe('The follow-up turn. Omit when only closing.'),
  close: z
    .boolean()
    .optional()
    .describe('Close stdin after this turn, ending the agy process at EOF.'),
})

export type SendInput = z.infer<typeof sendInput>

export async function handleSend(ctx: ToolContext, input: SendInput): Promise<ToolReply> {
  try {
    await reconcile(ctx.store)
    const job = getJob(ctx.store, input.job_id)

    if (!input.text && !input.close) {
      throw new ValidationError({
        field: 'text/close',
        value: input,
        expected: 'at least one of "text" or "close: true"',
      })
    }
    if (job.session_mode !== 'session') {
      throw new ValidationError({
        field: 'job_id',
        value: input.job_id,
        expected: 'a job started with session_mode "session" — a "oneshot" job closes stdin after its one turn and cannot accept follow-ups',
      })
    }
    if (job.lifecycle === 'finished' || job.lifecycle === 'canceling') {
      throw new ValidationError({
        field: 'job_id',
        value: input.job_id,
        expected: `a job that is still live — job ${job.job_id} is already "${job.lifecycle}"`,
      })
    }

    const paths = jobPaths(ctx.paths, job.job_id)
    if (input.text) appendUserTurn(paths.inbox, input.text)
    if (input.close) appendClose(paths.inbox)

    return reply({ job_id: job.job_id, queued: true, closed: Boolean(input.close) })
  } catch (e) {
    return errorReply(e)
  }
}
