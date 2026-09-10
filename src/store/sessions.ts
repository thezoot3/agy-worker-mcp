import type { SQLInputValue } from 'node:sqlite'

import type { Profile, SessionRow, SessionState } from '../contract/types.js'
import { newSessionId } from '../contract/paths.js'
import type { Store } from './db.js'
import { now } from './db.js'

type SqlParams = Record<string, SQLInputValue>

export interface NewSession {
  /** Omit to mint one. */
  sessionId?: string
  cwd: string
  model?: string | null
  effort?: string | null
  profile?: Profile | null
}

export interface SessionFilter {
  state?: SessionState
  cwd?: string
  limit?: number
}

interface SessionRowRaw {
  session_id: string
  conversation_id: string | null
  cwd: string
  model: string | null
  effort: string | null
  profile: string | null
  turn_count: number
  last_job_id: string | null
  created_at: number
  last_used_at: number
  state: string
}

function toSessionRow(raw: SessionRowRaw): SessionRow {
  return raw as unknown as SessionRow
}

function requireSession(store: Store, sessionId: string): SessionRow {
  const row = getSession(store, sessionId)
  if (!row) {
    throw new Error(`no session "${sessionId}" in project ${store.root}`)
  }
  return row
}

export function createSession(store: Store, input: NewSession): SessionRow {
  const sessionId = input.sessionId || newSessionId()
  const ts = now()
  store.db
    .prepare(
      `INSERT INTO sessions (
        session_id, conversation_id, cwd, model, effort, profile,
        turn_count, last_job_id, created_at, last_used_at, state
      ) VALUES (
        @session_id, NULL, @cwd, @model, @effort, @profile,
        0, NULL, @created_at, @last_used_at, 'active'
      )`,
    )
    .run({
      session_id: sessionId,
      cwd: input.cwd,
      model: input.model ?? null,
      effort: input.effort ?? null,
      profile: input.profile ?? null,
      created_at: ts,
      last_used_at: ts,
    })
  return requireSession(store, sessionId)
}

export function getSession(store: Store, sessionId: string): SessionRow | null {
  const row = store.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as
    | SessionRowRaw
    | undefined
  return row ? toSessionRow(row) : null
}

/** Reverse lookup used by the gate after it binds a conversation to a job. */
export function findSessionByConversation(store: Store, conversationId: string): SessionRow | null {
  const row = store.db
    .prepare('SELECT * FROM sessions WHERE conversation_id = ?')
    .get(conversationId) as SessionRowRaw | undefined
  return row ? toSessionRow(row) : null
}

/**
 * Attach the conversation id captured from the first `init` event.
 *
 * Bound lazily: at `agy_start` time we do not have one yet (agy mints it), so the
 * column stays NULL until the events file has its first line.
 */
export function bindConversationId(store: Store, sessionId: string, conversationId: string): SessionRow {
  const result = store.db
    .prepare('UPDATE sessions SET conversation_id = ? WHERE session_id = ?')
    .run(conversationId, sessionId)
  if (result.changes === 0) {
    throw new Error(`no session "${sessionId}" in project ${store.root}`)
  }
  return requireSession(store, sessionId)
}

/** Update `last_used_at`, `last_job_id`, and any supplied columns. */
export function touchSession(
  store: Store,
  sessionId: string,
  patch?: Partial<Pick<SessionRow, 'last_job_id' | 'model' | 'effort' | 'profile' | 'turn_count'>>,
): SessionRow {
  const entries = Object.entries(patch ?? {})
  const setClauses = ['last_used_at = @last_used_at', ...entries.map(([k]) => `${k} = @${k}`)]
  const params: SqlParams = { session_id: sessionId, last_used_at: now() }
  for (const [k, v] of entries) params[k] = v as SQLInputValue

  const result = store.db
    .prepare(`UPDATE sessions SET ${setClauses.join(', ')} WHERE session_id = @session_id`)
    .run(params)
  if (result.changes === 0) {
    throw new Error(`no session "${sessionId}" in project ${store.root}`)
  }
  return requireSession(store, sessionId)
}

/** Advance `turn_count` by the number of `result` events a finished job produced. */
export function addTurns(store: Store, sessionId: string, n: number): SessionRow {
  const result = store.db
    .prepare(
      'UPDATE sessions SET turn_count = turn_count + @n, last_used_at = @last_used_at WHERE session_id = @session_id',
    )
    .run({ session_id: sessionId, n, last_used_at: now() })
  if (result.changes === 0) {
    throw new Error(`no session "${sessionId}" in project ${store.root}`)
  }
  return requireSession(store, sessionId)
}

export function listSessions(store: Store, filter?: SessionFilter): SessionRow[] {
  const clauses: string[] = []
  const params: SqlParams = {}
  if (filter?.state) {
    clauses.push('state = @state')
    params.state = filter.state
  }
  if (filter?.cwd) {
    clauses.push('cwd = @cwd')
    params.cwd = filter.cwd
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = filter?.limit && filter.limit > 0 ? Math.floor(filter.limit) : 100
  const rows = store.db
    .prepare(`SELECT * FROM sessions ${where} ORDER BY last_used_at DESC LIMIT ${limit}`)
    .all(params) as unknown as SessionRowRaw[]
  return rows.map(toSessionRow)
}

/**
 * Mark a session closed. The conversation itself is not destroyed — agy resume is
 * lossless, so a closed session is a bookkeeping state, not a deletion.
 */
export function closeSession(store: Store, sessionId: string): SessionRow {
  const result = store.db
    .prepare("UPDATE sessions SET state = 'closed', last_used_at = @last_used_at WHERE session_id = @session_id")
    .run({ session_id: sessionId, last_used_at: now() })
  if (result.changes === 0) {
    throw new Error(`no session "${sessionId}" in project ${store.root}`)
  }
  return requireSession(store, sessionId)
}
