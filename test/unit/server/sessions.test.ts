/**
 * Unit tests for `agy_sessions` handler (`src/server/tools/sessions.ts`).
 *
 * Verifies observable behavior:
 * - Happy path: Lists sessions with count and state filtering (active vs closed).
 * - Happy path: Inspects ('get') an existing session by session_id.
 * - Happy path: Closes ('close') an active session, updating its state to closed.
 * - Error path: Missing session_id for 'get' or 'close' returns VALIDATION error.
 * - Error path: Non-existent session_id returns an error envelope.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SessionRow } from '../../../src/contract/types.js'
import { DEFAULT_LIMITS, type ToolContext } from '../../../src/server/context.js'
import { handleSessions } from '../../../src/server/tools/sessions.js'
import { createSession } from '../../../src/store/sessions.js'
import { makeTestStore, type TestStoreHandle } from '../helpers/store.js'

function replyJson<T = Record<string, unknown>>(reply: { content: Array<{ type: string; text: string }> }): T {
  return JSON.parse(reply.content[0]!.text) as T
}

describe('agy_sessions tool handler', () => {
  let handle: TestStoreHandle
  let ctx: ToolContext

  beforeEach(() => {
    handle = makeTestStore()
    ctx = {
      store: handle.store,
      paths: handle.store.paths,
      version: '0.2.2',
      limits: DEFAULT_LIMITS,
    }
  })

  afterEach(() => {
    handle.cleanup()
  })

  it('lists sessions and supports filtering by state', async () => {
    const s1 = createSession(ctx.store, { cwd: handle.workspace, model: 'claude-sonnet-4-6' })
    const s2 = createSession(ctx.store, { cwd: handle.workspace, model: 'gemini-3.8-flash-high' })

    // List all sessions (defaults to action: 'list')
    const listRep = await handleSessions(ctx, {})
    expect(listRep.isError).toBeFalsy()

    const listBody = replyJson<{ sessions: SessionRow[]; count: number }>(listRep)
    expect(listBody.count).toBe(2)
    const returnedIds = listBody.sessions.map((s) => s.session_id)
    expect(returnedIds).toContain(s1.session_id)
    expect(returnedIds).toContain(s2.session_id)

    // Close s1
    const closeRep = await handleSessions(ctx, { action: 'close', session_id: s1.session_id })
    expect(closeRep.isError).toBeFalsy()
    const closeBody = replyJson<{ session: SessionRow }>(closeRep)
    expect(closeBody.session.session_id).toBe(s1.session_id)
    expect(closeBody.session.state).toBe('closed')

    // Filter by state = 'active' -> only s2
    const activeRep = await handleSessions(ctx, { action: 'list', state: 'active' })
    expect(activeRep.isError).toBeFalsy()
    const activeBody = replyJson<{ sessions: SessionRow[]; count: number }>(activeRep)
    expect(activeBody.count).toBe(1)
    expect(activeBody.sessions[0]!.session_id).toBe(s2.session_id)

    // Filter by state = 'closed' -> only s1
    const closedRep = await handleSessions(ctx, { action: 'list', state: 'closed' })
    expect(closedRep.isError).toBeFalsy()
    const closedBody = replyJson<{ sessions: SessionRow[]; count: number }>(closedRep)
    expect(closedBody.count).toBe(1)
    expect(closedBody.sessions[0]!.session_id).toBe(s1.session_id)
  })

  it('gets an existing session by session_id', async () => {
    const session = createSession(ctx.store, { cwd: handle.workspace, model: 'claude-sonnet-4-6' })

    const rep = await handleSessions(ctx, { action: 'get', session_id: session.session_id })
    expect(rep.isError).toBeFalsy()

    const body = replyJson<{ session: SessionRow }>(rep)
    expect(body.session.session_id).toBe(session.session_id)
    expect(body.session.model).toBe('claude-sonnet-4-6')
    expect(body.session.state).toBe('active')
  })

  it('returns VALIDATION error when session_id is missing for action "get" or "close"', async () => {
    const getRep = await handleSessions(ctx, { action: 'get' })
    expect(getRep.isError).toBe(true)
    const getBody = replyJson<{ error: string; detail?: { field?: string } }>(getRep)
    expect(getBody.error).toBe('VALIDATION')
    expect(getBody.detail?.field).toBe('session_id')

    const closeRep = await handleSessions(ctx, { action: 'close' })
    expect(closeRep.isError).toBe(true)
    const closeBody = replyJson<{ error: string; detail?: { field?: string } }>(closeRep)
    expect(closeBody.error).toBe('VALIDATION')
    expect(closeBody.detail?.field).toBe('session_id')
  })

  it('returns error envelope when getting or closing non-existent session_id', async () => {
    const getRep = await handleSessions(ctx, { action: 'get', session_id: 'session-nonexistent' })
    expect(getRep.isError).toBe(true)
    const getBody = replyJson<{ message: string }>(getRep)
    expect(getBody.message).toContain('session-nonexistent')

    const closeRep = await handleSessions(ctx, { action: 'close', session_id: 'session-nonexistent' })
    expect(closeRep.isError).toBe(true)
    const closeBody = replyJson<{ message: string }>(closeRep)
    expect(closeBody.message).toContain('session-nonexistent')
  })
})
