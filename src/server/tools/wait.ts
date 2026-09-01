import { z } from 'zod'

import { jobPaths } from '../../contract/paths.js'
import type { JudgementPacket } from '../../contract/types.js'
import { reconcile } from '../../broker/reconcile.js'
import { loadBrokerResult, projectJudgementPacket } from '../../broker/result.js'
import { sleep } from '../../runner/reap.js'
import { readLinesFrom } from '../../events/cursor.js'
import { parseEventLines } from '../../events/parse.js'
import { formatNormalized, normalizeParsed, tailSummary } from '../../events/normalize.js'
import { getJob } from '../../store/jobs.js'
import { errorReply, reply, type ToolContext, type ToolReply } from '../context.js'

/**
 * `agy_wait` — long-poll until the job changes state or finishes.
 *
 * Implemented as 200 ms polling, not an in-process await: the job belongs to no
 * client, so there is no handle to await on (`docs/01` 결정 1). From the caller's
 * side it is still a single MCP call.
 *
 * `wait_ms: 0` returns an immediate snapshot. On completion the reply is the
 * judgement packet only — headline, outcome, counts, warnings, short log tail.
 * Lists and raw text belong to `agy_result`.
 */
export const waitInput = z.object({
  job_id: z.string(),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Max time to block. 0 returns the current state immediately.'),
  after_cursor: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Byte offset from a previous call. Only newer events are returned.'),
})

export type WaitInput = z.infer<typeof waitInput>

const POLL_INTERVAL_MS = 200

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max)
}

export async function handleWait(ctx: ToolContext, input: WaitInput): Promise<ToolReply> {
  try {
    const budget = clamp(input.wait_ms ?? 0, 0, ctx.limits.max_timeout_ms)
    const startedAt = Date.now()
    const afterCursor = input.after_cursor ?? 0

    await reconcile(ctx.store)
    let job = getJob(ctx.store, input.job_id)

    for (;;) {
      if (job.lifecycle === 'finished') break
      if (Date.now() - startedAt >= budget) break
      await sleep(POLL_INTERVAL_MS)
      await reconcile(ctx.store)
      job = getJob(ctx.store, input.job_id)
    }

    const paths = jobPaths(ctx.paths, job.job_id)

    if (job.lifecycle === 'finished') {
      const result = loadBrokerResult(paths)
      if (result) {
        const packet = projectJudgementPacket(result, {
          maxLogTailLines: ctx.limits.max_log_tail_lines,
          maxBytes: ctx.limits.max_response_bytes,
        })
        return reply(packet)
      }
    }

    // Not finished (or finished but not finalized yet) — a lightweight
    // snapshot built directly from events.ndjson. No lists, no raw response.
    const read = readLinesFrom(paths.events, afterCursor, { maxBytes: ctx.limits.max_response_bytes })
    const normalized = normalizeParsed(parseEventLines(read.lines, afterCursor))
    const tail = tailSummary(normalized, ctx.limits.max_log_tail_lines, ctx.limits.max_response_bytes)

    const packet: JudgementPacket = {
      job_id: job.job_id,
      lifecycle: job.lifecycle,
      outcome: job.outcome,
      headline: job.headline ?? `job is ${job.lifecycle}`,
      exit_code: job.exit_code,
      duration_ms: job.started_at !== null ? Date.now() - job.started_at : null,
      agent_status: job.agent_status,
      contract_status: job.contract_status,
      counts: {
        permission_denials: 0,
        environment_blocks: 0,
        missing_artifacts: 0,
        tool_errors: 0,
        turns: 0,
      },
      warnings: [],
      log_tail: tail,
      cursor: read.nextCursor,
    }
    return reply(packet)
  } catch (e) {
    return errorReply(e)
  }
}
