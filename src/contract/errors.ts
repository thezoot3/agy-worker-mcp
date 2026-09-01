/**
 * Structured errors. READ-ONLY after Stage 1.
 *
 * Every error carries a machine-readable `detail` so the *calling agent* can
 * repair itself without another round trip: which job holds the lock, which rule
 * string to add, which enum values exist. `docs/04` #17 depends on this.
 */

import type {
  LockRequestScope,
  OnDenial,
  RuleVerb,
} from './types.js'

export type ErrorCode =
  | 'LOCK_CONFLICT'
  | 'POLICY_DENIED'
  | 'PATH_ESCAPE'
  | 'JOB_NOT_FOUND'
  | 'VALIDATION'

/** Wire shape of any error surfaced through MCP. */
export interface ErrorEnvelope<D = unknown> {
  error: ErrorCode
  message: string
  detail: D
  /** Concrete next action for the caller. Always present. */
  remedy: string
}

/** Base for everything in this module. `instanceof` works across all subclasses. */
export abstract class AgyWorkerError<D = unknown> extends Error {
  abstract readonly code: ErrorCode
  readonly detail: D
  readonly remedy: string

  protected constructor(message: string, detail: D, remedy: string) {
    super(message)
    this.name = new.target.name
    this.detail = detail
    this.remedy = remedy
    Error.captureStackTrace?.(this, new.target)
  }

  toJSON(): ErrorEnvelope<D> {
    return {
      error: this.code,
      message: this.message,
      detail: this.detail,
      remedy: this.remedy,
    }
  }
}

export function isAgyWorkerError(e: unknown): e is AgyWorkerError {
  return e instanceof AgyWorkerError
}

/** Normalizes anything thrown into an envelope so a tool handler never leaks a stack. */
export function toErrorEnvelope(e: unknown): ErrorEnvelope {
  if (isAgyWorkerError(e)) return e.toJSON()
  const message = e instanceof Error ? e.message : String(e)
  return {
    error: 'VALIDATION',
    message,
    detail: { unexpected: true },
    remedy: 'This is an internal failure, not a usable input error. Retry once; if it repeats, report it.',
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export interface LockConflictDetail {
  /** `running_limit` means the project-wide concurrency ceiling, not a row. */
  scope: LockRequestScope
  /** Canonical cwd, session id, or `'*'` for the running limit. */
  key: string
  /** Whether an existing holder blocked it, or the ceiling did. */
  reason: 'held' | 'limit'
  /** Job currently holding the lock. Null for `reason: 'limit'`. */
  holder_job_id: string | null
  holder_pid: number | null
  holder_started_at: number | null
  acquired_at: number | null
  /** Every job counted against the ceiling, for `reason: 'limit'`. */
  running_job_ids: string[]
  limit: number | null
}

/**
 * Losing a lock race is an error, never a silent serialization (`docs/04` #4, #7).
 * The caller decides whether to wait on the holder or pick a different cwd.
 */
export class LockConflictError extends AgyWorkerError<LockConflictDetail> {
  readonly code = 'LOCK_CONFLICT' as const

  constructor(detail: LockConflictDetail, message?: string) {
    const holder = detail.holder_job_id
    super(
      message ??
        (detail.reason === 'limit'
          ? `project concurrency limit reached (${detail.limit} running)`
          : `${detail.scope} lock on "${detail.key}" is held by job ${holder}`),
      detail,
      detail.reason === 'limit'
        ? 'Wait for a running job to finish (agy_wait on one of running_job_ids), or cancel one with agy_cancel.'
        : `Call agy_wait({ job_id: "${holder}" }) to take over the holder, agy_cancel to stop it, or start this job in a different cwd.`,
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export interface PolicyDeniedDetail {
  job_id: string | null
  profile: string
  tool: string
  command: string | null
  /**
   * Rule string that would have permitted this, e.g. `command(python -m pytest)`.
   * Paste it into the next `agy_start`'s `permissions.allow`.
   */
  required_rule: string | null
  /** The deny entry that matched, when the refusal came from a deny list. */
  matched_rule: string | null
  /** Which stage of the decision order refused. */
  policy: 'deny_list' | 'profile_allowlist' | 'containment' | 'network' | 'default'
  /** True when no client request can lift it (hard deny / profile ceiling). */
  immutable: boolean
  on_denial: OnDenial
}

/** A policy refusal, whether reported by the gate or replayed by the broker. */
export class PolicyDeniedError extends AgyWorkerError<PolicyDeniedDetail> {
  readonly code = 'POLICY_DENIED' as const

  constructor(detail: PolicyDeniedDetail, message?: string) {
    super(
      message ??
        `${detail.tool}${detail.command ? ` (${detail.command})` : ''} denied by ${detail.policy} under profile "${detail.profile}"`,
      detail,
      detail.immutable
        ? `This rule cannot be lifted by a client request. Use a different approach, or a profile that permits it.`
        : detail.required_rule
          ? `Retry with permissions.allow including ${JSON.stringify(detail.required_rule)}.`
          : 'Narrow the requested action, or choose a profile whose ceiling covers it.',
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export interface PathEscapeDetail {
  /** What the caller supplied. */
  input_path: string
  /** After realpath + `..` resolution. This is what actually escaped. */
  resolved_path: string
  /** Whether read or write containment was violated. */
  kind: 'read' | 'write'
  /** Canonical roots that were allowed. */
  roots: string[]
  /** True when a symlink was what carried the path outside. */
  via_symlink: boolean
}

/** Containment failure. Checked *after* realpath, never before (`docs/03` §1.8). */
export class PathEscapeError extends AgyWorkerError<PathEscapeDetail> {
  readonly code = 'PATH_ESCAPE' as const

  constructor(detail: PathEscapeDetail, message?: string) {
    super(
      message ??
        `path "${detail.input_path}" resolves to "${detail.resolved_path}", outside the allowed ${detail.kind} roots`,
      detail,
      `Use a path inside one of: ${detail.roots.join(', ')}. Symlinks are resolved before the check, so linking out does not work.`,
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export interface JobNotFoundDetail {
  job_id: string
  /** A few recent job ids so the caller can spot a typo without another call. */
  known_recent: string[]
  project_root: string
}

export class JobNotFoundError extends AgyWorkerError<JobNotFoundDetail> {
  readonly code = 'JOB_NOT_FOUND' as const

  constructor(detail: JobNotFoundDetail, message?: string) {
    super(
      message ?? `no job "${detail.job_id}" in project ${detail.project_root}`,
      detail,
      detail.known_recent.length
        ? `Recent job ids: ${detail.known_recent.join(', ')}. Use agy_list_jobs for the full list.`
        : 'Use agy_list_jobs to see what exists in this project. Jobs are per-project and never visible across projects.',
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export interface ValidationDetail {
  /** Dotted path of the offending input, e.g. `permissions.allow[0]`. */
  field: string
  /** What arrived. Truncated by the thrower if large. */
  value: unknown
  /** Human description of what was required. */
  expected: string
  /** Complete enum when the field is an enum. Lets the caller self-correct. */
  allowed?: string[]
  /** Rule verbs, when the failure was an unparsable permission rule. */
  allowed_verbs?: RuleVerb[]
}

export class ValidationError extends AgyWorkerError<ValidationDetail> {
  readonly code = 'VALIDATION' as const

  constructor(detail: ValidationDetail, message?: string) {
    super(
      message ?? `invalid ${detail.field}: expected ${detail.expected}`,
      detail,
      detail.allowed
        ? `Allowed values: ${detail.allowed.join(' | ')}.`
        : detail.allowed_verbs
          ? `A rule looks like verb(pattern). Verbs: ${detail.allowed_verbs.join(' | ')}. Prefix the pattern with "regex:" to opt into regular expressions.`
          : `Correct ${detail.field} and call again.`,
    )
  }
}
