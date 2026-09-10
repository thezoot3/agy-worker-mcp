import { spawn } from 'node:child_process'
import { closeSync, openSync, writeSync } from 'node:fs'

import type { VerifyRecord } from '../contract/types.js'
import { killProcessGroup } from './reap.js'

/**
 * `verify_command` execution (PR6; see docs/permissions.md).
 *
 * Run once by the runner, after agy has exited normally, against the final
 * workspace state — outside the model's own decisions entirely. Not a
 * sandboxing feature: this runs as the user, with no isolation, at the same
 * trust level as the parent agent running the command itself. Its own
 * `deadline_at`-independent timeout (`timeoutMs`) means it may finish after
 * the job's `deadline_at` has already passed; that is expected, not a bug —
 * agy's deadline and the verify timeout are two separate clocks.
 */

const MAX_VERIFY_LOG_BYTES = 1024 * 1024
const TRUNCATION_MARKER = '\n[agy-worker: verify output truncated at 1 MiB]\n'

export interface RunVerifyOptions {
  command: string
  /** Canonical workspace — the same `cwd` agy itself ran in. */
  cwd: string
  /** The same allowlisted child env agy's own process received. */
  env: Record<string, string>
  timeoutMs: number
  /** `jobs/<id>/verify.log` — truncated fresh for this run. */
  logPath: string
}

/**
 * Spawn `sh -c <command>` detached (its own process group, same technique as
 * `spawnAgyDetached`), append stdout+stderr to `logPath` capped at 1 MiB, and
 * wait up to `timeoutMs` — killing the whole group on timeout.
 *
 * Unlike agy's own spawn, stdio is genuinely piped rather than fd-redirected:
 * the runner is alive and actively draining both streams for the entire
 * lifetime of this call (there is no detached-parent-exits race to guard
 * against here), which is what makes counting bytes for the 1 MiB cap
 * possible in the first place.
 */
export async function runVerifyCommand(opts: RunVerifyOptions): Promise<VerifyRecord> {
  const startedAt = Date.now()
  const startHr = process.hrtime.bigint()

  // 'w': each job runs verify_command at most once, so a fresh file is always
  // correct — there is nothing from a previous run to append to.
  const logFd = openSync(opts.logPath, 'w', 0o600)
  let bytesWritten = 0
  let truncated = false

  const appendChunk = (chunk: Buffer): void => {
    if (truncated) return
    const remaining = MAX_VERIFY_LOG_BYTES - bytesWritten
    if (remaining <= 0) {
      truncated = true
      writeSync(logFd, TRUNCATION_MARKER)
      return
    }
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
    writeSync(logFd, slice)
    bytesWritten += slice.length
    if (chunk.length > remaining) {
      truncated = true
      writeSync(logFd, TRUNCATION_MARKER)
    }
  }

  let child
  try {
    child = spawn('sh', ['-c', opts.command], {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    writeSync(logFd, `[agy-worker: verify spawn failed: ${message}]\n`)
    closeSync(logFd)
    const durationMs = Math.round(Number(process.hrtime.bigint() - startHr) / 1e6)
    return {
      command: opts.command,
      exit_code: null,
      signal: null,
      started_at: startedAt,
      duration_ms: durationMs,
      timed_out: false,
    }
  }

  const pid = child.pid
  if (pid == null) {
    closeSync(logFd)
    throw new Error('agy-worker-runner: verify spawn produced no pid')
  }
  // detached:true makes the child the leader of its own process group, so
  // pgid === pid — same as spawnAgyDetached.
  const pgid = pid

  child.stdout?.on('data', appendChunk)
  child.stderr?.on('data', appendChunk)

  const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
    child.once('error', () => resolveExit({ code: null, signal: null }))
  })

  let timedOut = false
  const timeoutTimer = setTimeout(() => {
    timedOut = true
    void killProcessGroup(pgid)
  }, opts.timeoutMs)

  const { code, signal } = await exitPromise
  clearTimeout(timeoutTimer)
  closeSync(logFd)

  const durationMs = Math.round(Number(process.hrtime.bigint() - startHr) / 1e6)

  return {
    command: opts.command,
    exit_code: code,
    signal,
    started_at: startedAt,
    duration_ms: durationMs,
    timed_out: timedOut,
  }
}
