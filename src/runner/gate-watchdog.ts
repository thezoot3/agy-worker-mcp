import { fileSize } from '../contract/paths.js'
import { readLinesFrom } from '../events/cursor.js'
import { okEvents, parseEventLines } from '../events/parse.js'

/**
 * Runtime confirmation that our PreToolUse gate actually loaded for this job
 * (I4).
 *
 * Nothing agy emits on stdout/stdin says whether `<workspace>/.agents/hooks.json`
 * loaded — the only place that fact appears is agy's own internal log file
 * (`~/.gemini/antigravity-cli/log/cli-*.log`, M5), which is not attributable to a
 * specific job once two jobs run concurrently. So this watches for the one
 * self-contained signal we do control: `jobs/<id>/gate-log.jsonl`, which our own
 * gate appends to on every verdict it makes (`src/gate/gate.ts`'s `logDecision`,
 * right after `emit` writes the decision to stdout — so a running gate's line
 * lands only a few ticks after agy has already read that decision).
 *
 * Trigger, not a flat timer (redesigned after a real flake): a fixed delay after
 * the first tool step goes ACTIVE raced real hook-spawn latency under heavy
 * parallel test load and produced false "missing" kills on a perfectly healthy
 * gate. `decide()`'s step order (`src/gate/gate.ts`) is: PreToolUse hooks run
 * and gate the tool call *before* agy lets it execute, so with hooks loaded the
 * tool cannot reach a terminal state (`DONE`/`ERROR`) before our gate has
 * already appended its line — the gate-log write can only trail the terminal
 * event by the width of one `appendJsonLine` call, never longer. So the
 * deterministic signal is: the first tool step reaching `DONE`/`ERROR` with
 * `gate-log.jsonl` still empty. A short grace period (`graceMs`, default 1s)
 * absorbs exactly that append-vs-event race and nothing more.
 *
 * A hard cap (`capMs`, default 60s) is kept only as a backstop for a first tool
 * step that stays `ACTIVE` a long time (a genuinely slow first command) with
 * hooks missing: a working gate would already have logged within milliseconds
 * of that `ACTIVE` transition (it runs *before* the tool starts), so an empty
 * gate-log after `capMs` is itself sufficient evidence even without a terminal
 * event yet — this bounds how long a hooks-missing job can run fully unguarded
 * when its first tool call happens to be slow.
 *
 * `ensureGateHook` (`src/gate/hooks-file.ts`) writes our hooks.json key first in
 * the object so our gate is the first PreToolUse group agy evaluates and
 * therefore always runs, even when another group would deny and short-circuit
 * agy's own sequential evaluation (M6). The one case this cannot cover is a
 * hook installed *outside* any file we own — e.g. a user's global
 * `~/.gemini/config/hooks.json` — that denies ahead of ours; agy never reaches
 * our group for that call, gate-log.jsonl never gets a line, and this watchdog
 * (correctly, if bluntly) reports the job as `process_error` "gate never
 * fired". That residual case is accepted, not handled: it is safe (fail
 * closed), just imprecise about *why*.
 *
 * Same tailing approach as `idle.ts`: poll `events.ndjson` from a byte cursor,
 * parse only complete lines, never hold the file open between polls.
 */

export interface GateWatchdogOptions {
  /** `jobs/<id>/events.ndjson` — where the first tool step becomes visible. */
  eventsPath: string
  /** `jobs/<id>/gate-log.jsonl` — non-empty the instant our gate has run once. */
  gateLogPath: string
  /**
   * Grace period after the first tool step reaches `DONE`/`ERROR` before
   * declaring the gate missing, absorbing the gate-log append trailing the
   * terminal event by a beat. Default 1000ms.
   */
  graceMs?: number
  /**
   * Hard-cap backstop from the first tool step going `ACTIVE`, for a slow first
   * command that never reaches a terminal state. Default 60000ms.
   */
  capMs?: number
  pollMs?: number
  /** Fired at most once: the gate confirmed itself, at any point. */
  onConfirmed: () => void
  /** Fired at most once: grace or cap elapsed with nothing in gate-log.jsonl. */
  onMissing: () => void
}

export interface GateWatchdog {
  /** Stop polling and cancel any pending timer. Idempotent, safe after resolution. */
  stop(): void
  /**
   * Call once the agy process is known to have exited, in place of (or right
   * before) `stop()`. Does one last synchronous check instead of relying on
   * the next poll tick or a pending timer, both of which a job that exits very
   * quickly can race: a happy job that finishes in under one `pollMs` would
   * otherwise leave `gate_confirmed` stuck at `null` even though the gate
   * plainly ran, and a broken-hooks job that happens to run to completion
   * before its grace/cap timer fires would leave it `null` instead of `false`
   * even though nothing further can ever write to `gate-log.jsonl` once the
   * process is gone. Idempotent, safe after resolution or `stop()`.
   */
  finalize(): void
}

const DEFAULT_GRACE_MS = 1000
const DEFAULT_CAP_MS = 60_000

/**
 * Start the watchdog. Resolves at most once, via exactly one of `onConfirmed` /
 * `onMissing` — or never, if the job ends before any tool step ever runs (a job
 * with no tool calls has nothing for the gate to confirm, so `gate_confirmed`
 * stays `null`, which the runner's caller must default it to).
 */
export function startGateWatchdog(opts: GateWatchdogOptions): GateWatchdog {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS
  const capMs = opts.capMs ?? DEFAULT_CAP_MS
  const pollMs = opts.pollMs ?? 100

  let stopped = false
  let resolved = false
  /** Any tool step_update observed at all (ACTIVE or terminal). Drives the cap. */
  let sawToolStep = false
  /** A tool step_update reaching DONE/ERROR observed. Drives the grace period. */
  let sawTerminalToolStep = false
  let eventsOffset = 0
  let graceTimer: ReturnType<typeof setTimeout> | null = null
  let capTimer: ReturnType<typeof setTimeout> | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  function gateLogHasLine(): boolean {
    return fileSize(opts.gateLogPath) > 0
  }

  function stopInternal(): void {
    stopped = true
    if (graceTimer) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
    if (capTimer) {
      clearTimeout(capTimer)
      capTimer = null
    }
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  function confirm(): void {
    if (resolved || stopped) return
    resolved = true
    stopInternal()
    opts.onConfirmed()
  }

  function declareMissing(): void {
    if (resolved || stopped) return
    resolved = true
    stopInternal()
    opts.onMissing()
  }

  function armGrace(): void {
    if (graceTimer !== null) return
    graceTimer = setTimeout(() => {
      graceTimer = null
      if (resolved || stopped) return
      if (gateLogHasLine()) confirm()
      else declareMissing()
    }, graceMs)
  }

  function armCap(): void {
    if (capTimer !== null) return
    capTimer = setTimeout(() => {
      capTimer = null
      if (resolved || stopped) return
      // Backstop only (see module comment): by now a working gate would
      // already have logged, so an empty gate-log is itself the signal even
      // without a terminal step yet.
      if (gateLogHasLine()) confirm()
      else declareMissing()
    }, capMs)
  }

  /** Advances `sawToolStep`/`sawTerminalToolStep`. Stops scanning once the terminal signal is in. */
  function scanForToolStep(): void {
    if (sawTerminalToolStep) return
    const { lines, nextCursor } = readLinesFrom(opts.eventsPath, eventsOffset)
    eventsOffset = nextCursor
    if (lines.length === 0) return
    const events = okEvents(parseEventLines(lines, 0))
    for (const e of events) {
      if (e.event !== 'step_update' || e.step_update.step_type !== 'tool') continue
      sawToolStep = true
      const state = e.step_update.state
      if (state === 'DONE' || state === 'ERROR') {
        sawTerminalToolStep = true
        break
      }
    }
  }

  /** Shared by `poll()` and `finalize()`: scan, then confirm/arm off the result. */
  function checkAndMaybeResolve(): void {
    scanForToolStep()

    // Checked every time, not only once a timer fires: a line that appears
    // before the terminal step (the common, healthy case — the gate runs
    // *before* the tool executes) should confirm immediately rather than
    // waiting out grace or cap.
    if (gateLogHasLine()) {
      confirm()
      return
    }

    if (sawTerminalToolStep) armGrace()
    else if (sawToolStep) armCap()
  }

  function poll(): void {
    if (stopped || resolved) return
    checkAndMaybeResolve()
    if (!stopped) pollTimer = setTimeout(poll, pollMs)
  }

  function finalize(): void {
    if (resolved || stopped) {
      stopInternal()
      return
    }
    scanForToolStep()
    if (gateLogHasLine()) {
      confirm()
      return
    }
    if (sawToolStep) {
      // The process is already gone, so nothing will ever add a line now —
      // no need to wait out grace/cap. `onMissing` still runs (it also kills
      // the process group, which is a safe no-op on an already-empty group)
      // so the runner's bookkeeping is identical either way.
      declareMissing()
      return
    }
    stopInternal()
  }

  pollTimer = setTimeout(poll, pollMs)

  return { stop: stopInternal, finalize }
}
