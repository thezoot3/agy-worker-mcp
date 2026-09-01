import { closeSync, existsSync, openSync, readSync } from 'node:fs'

import { jobPaths, readJsonIfExists } from '../contract/paths.js'
import type { EffectivePolicy, JobRow, Lifecycle } from '../contract/types.js'
import type { Store } from '../store/db.js'
import { listJobs, tryGetJob } from '../store/jobs.js'
import { bindConversationId, findSessionByConversation } from '../store/sessions.js'

/**
 * Map a hook payload's `conversationId` onto one of our jobs (`docs/03` §1.4).
 *
 * With no daemon there is nobody to build the mapping ahead of time, so the gate
 * builds it itself: take the live jobs, read the **first line only** of each
 * candidate's `events.ndjson`, and compare `conversation_id`. That line exists
 * before any tool call because `init` is always first (§4), so there is no guess
 * and no race.
 *
 * `workspacePaths` alone is not enough — several jobs can share a workspace.
 */

/**
 * Binding candidates (`docs/03` §1.4 names `starting`/`running`; `queued` and
 * `canceling` are included defensively). The runner only ever reaches the DB's
 * `jobs.lifecycle` through `reconcile`'s absorption of `state.json` (finding 1/9),
 * which can lag the gate hook firing for a job the server has not touched again
 * since `agy_start` — `queued` covers that lag. `canceling` keeps a job bound
 * (so its policy keeps applying) after `on_denial: 'abort'` marks it (finding 13).
 */
const BIND_LIFECYCLES: readonly Lifecycle[] = ['queued', 'starting', 'running', 'canceling']

export interface BoundJob {
  job: JobRow
  policy: EffectivePolicy
  conversationId: string
}

/**
 * Null means "not one of ours" — a user's own interactive agy session.
 *
 * ⚠ That case must produce `{"decision":"ask"}`, never `{}`. `{}` is a denial
 * (§9) and would break every interactive session on the machine.
 */
export function bindConversation(store: Store, conversationId: string): BoundJob | null {
  const cached = lookupBoundJob(store, conversationId)
  if (cached) {
    const policy = loadJobPolicy(store, cached.job_id)
    if (policy) return { job: cached, policy, conversationId }
    // policy.json missing for a job we thought was bound: fall through and
    // re-scan rather than reporting a broken binding as "not ours".
  }

  const candidates = listJobs(store, { lifecycle: [...BIND_LIFECYCLES], limit: 10000 })
  for (const job of candidates) {
    const seen = readInitConversationId(store, job.job_id)
    if (seen !== null && seen === conversationId) {
      recordBinding(store, job.job_id, conversationId)
      const policy = loadJobPolicy(store, job.job_id)
      if (!policy) return null
      return { job, policy, conversationId }
    }
  }

  return null
}

/**
 * Persist the mapping so later calls skip the file scan. Also fills in
 * `sessions.conversation_id` when it was still NULL.
 */
export function recordBinding(store: Store, jobId: string, conversationId: string): void {
  const job = tryGetJob(store, jobId)
  if (!job || !job.session_id) return
  try {
    bindConversationId(store, job.session_id, conversationId)
  } catch {
    // Best effort. A lost race here just means the next hook call scans again.
  }
}

/** Cached lookup for a conversation already bound in a previous hook invocation. */
export function lookupBoundJob(store: Store, conversationId: string): JobRow | null {
  const session = findSessionByConversation(store, conversationId)
  if (!session) return null
  const jobs = listJobs(store, {
    sessionId: session.session_id,
    lifecycle: [...BIND_LIFECYCLES],
    limit: 1,
  })
  return jobs[0] ?? null
}

/** Load `jobs/<id>/policy.json`. Null when it is missing or unreadable. */
export function loadJobPolicy(store: Store, jobId: string): EffectivePolicy | null {
  const paths = jobPaths(store.paths, jobId)
  return readJsonIfExists<EffectivePolicy>(paths.policy)
}

/**
 * Reads only the first line of `events.ndjson` (well, the first ~8KB, which is
 * always enough — `init` is a small fixed-shape object) and pulls
 * `conversation_id` out of it. Never throws; a job whose events file does not
 * exist yet simply is not a binding candidate this call.
 */
function readInitConversationId(store: Store, jobId: string): string | null {
  const path = jobPaths(store.paths, jobId).events
  if (!existsSync(path)) return null

  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return null
  }

  try {
    const chunkSize = 8192
    const buf = Buffer.alloc(chunkSize)
    const bytesRead = readSync(fd, buf, 0, chunkSize, 0)
    if (bytesRead <= 0) return null

    const text = buf.toString('utf8', 0, bytesRead)
    const newlineIdx = text.indexOf('\n')
    const line = newlineIdx >= 0 ? text.slice(0, newlineIdx) : text
    if (!line.trim()) return null

    const parsed = JSON.parse(line) as { event?: string; conversation_id?: string }
    if (parsed.event === 'init' && typeof parsed.conversation_id === 'string') {
      return parsed.conversation_id
    }
    return null
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}
