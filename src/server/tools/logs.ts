import { z } from 'zod'

import { ValidationError } from '../../contract/errors.js'
import { jobPaths } from '../../contract/paths.js'
import { reconcile } from '../../broker/reconcile.js'
import { readLinesFrom, tailLines } from '../../events/cursor.js'
import { parseEventLines } from '../../events/parse.js'
import { formatNormalized, normalizeParsed } from '../../events/normalize.js'
import { getJob } from '../../store/jobs.js'
import { errorReply, reply, type ToolContext, type ToolReply } from '../context.js'

/**
 * `agy_logs` — read events, normalized lines, or stderr by cursor or tail.
 *
 * MVP-essential rather than a later nicety: with jobs owned by no client, this is
 * the only way a client that did not start a job can see what it is doing
 * (`docs/01`, tool surface).
 */
export const logsInput = z.object({
  job_id: z.string(),
  stream: z
    .enum(['events', 'normalized', 'stderr'])
    .optional()
    .describe('events = raw NDJSON, normalized = one readable line per meaningful step. Defaults to normalized.'),
  after_cursor: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Byte offset from a previous call. Mutually exclusive with tail_lines.'),
  tail_lines: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Last N lines. Mutually exclusive with after_cursor.'),
  max_bytes: z.number().int().positive().optional(),
})

export type LogsInput = z.infer<typeof logsInput>

export async function handleLogs(ctx: ToolContext, input: LogsInput): Promise<ToolReply> {
  try {
    await reconcile(ctx.store)

    if (input.after_cursor !== undefined && input.tail_lines !== undefined) {
      throw new ValidationError({
        field: 'after_cursor/tail_lines',
        value: { after_cursor: input.after_cursor, tail_lines: input.tail_lines },
        expected: 'only one of after_cursor or tail_lines, not both',
      })
    }

    const job = getJob(ctx.store, input.job_id)
    const paths = jobPaths(ctx.paths, job.job_id)
    const stream = input.stream ?? 'normalized'
    const maxBytes = input.max_bytes ?? ctx.limits.max_response_bytes
    const sourcePath = stream === 'stderr' ? paths.stderr : paths.events

    if (input.tail_lines !== undefined) {
      const rawLines = tailLines(sourcePath, input.tail_lines, maxBytes)
      const lines =
        stream === 'normalized'
          ? normalizeParsed(parseEventLines(rawLines)).map(formatNormalized)
          : rawLines
      return reply({ job_id: job.job_id, stream, lines })
    }

    const cursor = input.after_cursor ?? 0
    const read = readLinesFrom(sourcePath, cursor, { maxBytes })
    const lines =
      stream === 'normalized'
        ? normalizeParsed(parseEventLines(read.lines, cursor)).map(formatNormalized)
        : read.lines

    return reply({
      job_id: job.job_id,
      stream,
      lines,
      cursor: read.nextCursor,
      eof: read.eof,
      truncated: read.truncated,
    })
  } catch (e) {
    return errorReply(e)
  }
}
