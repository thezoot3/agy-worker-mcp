import { execFileSync } from 'node:child_process'

/**
 * Process liveness primitives. Kept apart from the store so both the runner and
 * `reconcile` can use them without dragging SQLite into the runner.
 *
 * Everything here shells out to `ps` / `pgrep` rather than a native addon
 * (`docs/01` 결정 6 keeps native dependency count at 0). Both tools are present on
 * macOS and Linux, which is the whole measured surface (`docs/02` §13); nothing
 * here claims Windows support.
 */

/** Milliseconds sleep, used by the poll loops in {@link killProcessGroup}. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** `kill(pid, 0)`. True also for a process we cannot signal (EPERM) — it exists. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code
    if (code === 'EPERM') return true
    return false
  }
}

/**
 * Opaque per-process start token, compared for equality and never parsed.
 *
 * Together with the pid it identifies a *specific* process. Without it a recycled
 * pid looks like a live lock holder and nothing ever gets reclaimed
 * (`docs/01` 결정 4/5). Returns null when the process is gone.
 */
export function getProcStartTime(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const trimmed = out.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

/**
 * True only when the pid is alive **and** its start token still matches.
 * A false here is what turns a stuck lock into a reclaimed one.
 *
 * When `procStartTime` is `null` — nothing was ever recorded for it, e.g. `ps`
 * was unavailable at capture time — there is no token to compare against, so this
 * falls back to liveness alone. That is a documented, deliberate weakening: it
 * only matters on a platform where {@link getProcStartTime} never worked in the
 * first place, which is outside the measured surface.
 */
export function isSameProcess(pid: number, procStartTime: string | null): boolean {
  if (!isPidAlive(pid)) return false
  if (procStartTime === null) return true
  const current = getProcStartTime(pid)
  return current !== null && current === procStartTime
}

/**
 * Three-way identity check, for callers that must not treat "the process just
 * exited" as "a different process now owns this pid".
 *
 * {@link isSameProcess} deliberately folds both into `false` — for lock
 * reclamation that is right, since neither case is a live holder. `reconcile`
 * needs them apart: `different` is pid reuse (`orphaned`), while `gone` is an
 * ordinary exit whose `exit_code` may be a few milliseconds from landing.
 */
export type ProcessIdentity = 'same' | 'different' | 'gone'

export function checkProcessIdentity(pid: number, procStartTime: string | null): ProcessIdentity {
  if (!isPidAlive(pid)) return 'gone'
  if (procStartTime === null) return 'same'
  const current = getProcStartTime(pid)
  // `ps` returning nothing means the process disappeared between the liveness
  // check and here. That is `gone`, never a mismatch.
  if (current === null) return 'gone'
  return current === procStartTime ? 'same' : 'different'
}

/** Process-group id of a pid, or null if it is gone. */
export function getPgid(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const n = Number.parseInt(out.trim(), 10)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/**
 * Pids currently in the group. `docs/04` #10 requires this to reach 0 after a kill.
 *
 * `pgrep -g <pgid>` is exactly the check named in that completion criterion, so
 * this is not incidental — it is the same tool a human would run to verify a kill.
 */
export function listProcessGroupPids(pgid: number): number[] {
  try {
    const out = execFileSync('pgrep', ['-g', String(pgid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isFinite(n))
  } catch {
    // pgrep exits non-zero when nothing matches. That is "empty group", not an error.
    return []
  }
}

export interface KillGroupOptions {
  /** Milliseconds between SIGTERM and SIGKILL. */
  graceMs?: number
  pollMs?: number
}

function guardTargetPgid(pgid: number): void {
  if (!Number.isInteger(pgid) || pgid <= 1) {
    throw new Error(`refusing to signal process group ${pgid}: group 0 and group 1 are off-limits`)
  }
  const ownPgid = getPgid(process.pid)
  if (ownPgid !== null && ownPgid === pgid) {
    throw new Error(`refusing to signal our own process group ${pgid}`)
  }
}

function trySignal(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal)
  } catch {
    // ESRCH: group already empty. Nothing to do.
  }
}

/**
 * `SIGTERM` the whole group, wait out the grace period, then `SIGKILL`.
 *
 * ⚠ Refuse to signal group 0, group 1, or our own group. A negative-pid kill with
 * a wrong argument takes down the caller and everything around it.
 *
 * @returns true when the group is empty afterwards.
 */
export async function killProcessGroup(pgid: number, opts?: KillGroupOptions): Promise<boolean> {
  const graceMs = opts?.graceMs ?? 5000
  const pollMs = opts?.pollMs ?? 200
  guardTargetPgid(pgid)

  if (listProcessGroupPids(pgid).length === 0) return true

  trySignal(pgid, 'SIGTERM')
  const termDeadline = Date.now() + graceMs
  while (Date.now() < termDeadline) {
    if (listProcessGroupPids(pgid).length === 0) return true
    await sleep(pollMs)
  }
  if (listProcessGroupPids(pgid).length === 0) return true

  trySignal(pgid, 'SIGKILL')
  const killDeadline = Date.now() + Math.max(pollMs * 3, 1000)
  while (Date.now() < killDeadline) {
    if (listProcessGroupPids(pgid).length === 0) return true
    await sleep(pollMs)
  }
  return listProcessGroupPids(pgid).length === 0
}
