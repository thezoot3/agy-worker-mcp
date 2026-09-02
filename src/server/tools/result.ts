import { z } from 'zod'

import { jobPaths } from '../../contract/paths.js'
import { reconcile } from '../../broker/reconcile.js'
import { loadBrokerResult } from '../../broker/result.js'
import { getJob } from '../../store/jobs.js'
import { errorReply, reply, type ToolContext, type ToolReply } from '../context.js'

/**
 * `agy_result` — the full, paged result of a finished job.
 *
 * This is where the recovery loop lives: `verification.blockers[]` carries one
 * entry per thing that stood in the way, each with `actionable` (can a
 * different `agy_start` lift it) and `remedy` (what to change) — a gate
 * denial's `required_rule` for `permissions.allow`, `permissions.network` for
 * a silent sandbox network block that agy reported as SUCCESS. The original
 * record behind each entry is kept verbatim in `detail`.
 */
export const resultInput = z.object({
  job_id: z.string(),
  section: z
    .enum(['summary', 'agent_report', 'verification', 'response', 'all'])
    .optional()
    .describe('Which part to return. Defaults to summary.'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Character offset into the "response" section, for paging a long agent response.'),
  limit: z.number().int().positive().optional().describe('Character count for the "response" section.'),
})

export type ResultInput = z.infer<typeof resultInput>

const DEFAULT_RESPONSE_LIMIT = 8000

function pageResponse(text: string | null, offset: number, limit: number) {
  const full = text ?? ''
  const slice = full.slice(offset, offset + limit)
  return {
    text: slice,
    offset,
    next_offset: offset + slice.length < full.length ? offset + slice.length : null,
    total_length: full.length,
  }
}

export async function handleResult(ctx: ToolContext, input: ResultInput): Promise<ToolReply> {
  try {
    await reconcile(ctx.store)
    const job = getJob(ctx.store, input.job_id)

    if (job.lifecycle !== 'finished') {
      return reply({
        job_id: job.job_id,
        lifecycle: job.lifecycle,
        message: 'job has not finished yet; call agy_wait or retry agy_result later',
      })
    }

    const paths = jobPaths(ctx.paths, job.job_id)
    const result = loadBrokerResult(paths)
    if (!result) {
      return reply({
        job_id: job.job_id,
        lifecycle: job.lifecycle,
        message: 'job is finished but broker-result.json is not available yet; retry shortly',
      })
    }

    const section = input.section ?? 'summary'
    const offset = input.offset ?? 0
    const limit = input.limit ?? DEFAULT_RESPONSE_LIMIT

    if (section === 'summary') {
      return reply({
        job_id: result.job_id,
        session_id: result.session_id,
        lifecycle: result.lifecycle,
        broker_summary: result.broker_summary,
        agent_status: result.agent_status,
        contract_status: result.contract_status,
      })
    }
    if (section === 'agent_report') {
      return reply({ job_id: result.job_id, agent_report: result.agent_report })
    }
    if (section === 'verification') {
      return reply({ job_id: result.job_id, verification: result.verification })
    }
    if (section === 'response') {
      return reply({ job_id: result.job_id, response: pageResponse(result.agent_report.response, offset, limit) })
    }

    // section === 'all'
    return reply({
      ...result,
      agent_report: { ...result.agent_report, response: pageResponse(result.agent_report.response, offset, limit) },
    })
  } catch (e) {
    return errorReply(e)
  }
}
