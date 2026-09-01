import { z } from 'zod'

import { ValidationError } from '../../contract/errors.js'
import { reconcile } from '../../broker/reconcile.js'
import { closeSession, getSession, listSessions } from '../../store/sessions.js'
import { errorReply, reply, type ToolContext, type ToolReply } from '../context.js'

/**
 * `agy_sessions` — list, inspect, or close agy conversations.
 *
 * A session is one agy conversation; a job is one turn. Resume is lossless
 * (`--conversation`), so a finished oneshot job can always be continued later by
 * passing its `session_id` to `agy_start` (§6, `docs/03` §3.2).
 */
export const sessionsInput = z.object({
  action: z.enum(['list', 'get', 'close']).optional().describe('Defaults to list.'),
  session_id: z.string().optional().describe('Required for get and close.'),
  state: z.enum(['active', 'closed']).optional(),
  limit: z.number().int().positive().optional(),
})

export type SessionsInput = z.infer<typeof sessionsInput>

function requireSessionId(input: SessionsInput): string {
  if (!input.session_id) {
    throw new ValidationError({
      field: 'session_id',
      value: input.session_id,
      expected: 'a session_id, required for action "get" and "close"',
    })
  }
  return input.session_id
}

export async function handleSessions(ctx: ToolContext, input: SessionsInput): Promise<ToolReply> {
  try {
    await reconcile(ctx.store)
    const action = input.action ?? 'list'

    if (action === 'list') {
      const rows = listSessions(ctx.store, { state: input.state, limit: input.limit })
      return reply({ sessions: rows, count: rows.length })
    }

    if (action === 'get') {
      const sessionId = requireSessionId(input)
      const row = getSession(ctx.store, sessionId)
      if (!row) {
        return errorReply(new Error(`no session "${sessionId}" in project ${ctx.paths.root}`))
      }
      return reply({ session: row })
    }

    // action === 'close'
    const sessionId = requireSessionId(input)
    const row = closeSession(ctx.store, sessionId)
    return reply({ session: row })
  } catch (e) {
    return errorReply(e)
  }
}
