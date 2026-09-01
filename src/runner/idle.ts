import type { Writable } from 'node:stream'

import { readLinesFrom } from '../events/cursor.js'
import { isResult, okEvents, parseEventLines } from '../events/parse.js'

/**
 * Idle watchdog for `session_mode: 'session'` jobs (`docs/04` 미해결 질문 3).
 *
 * Without this, a session-mode job that finishes its one turn and never
 * receives another `agy_send` just sits with stdin open until the hard
 * `deadline_at` — measured live, that wasted the entire `--print-timeout`
 * window for a job whose actual work was done in seconds (`docs/05` §6.3).
 * `reconcile` cannot fix this on its own: it only runs from a tool entry
 * point (`docs/01` 결정 5), so nothing revisits an idle job until some client
 * happens to call one. The watchdog runs *inside the runner*, which is
 * already alive and unattended (`docs/01` 결정 1) — the same reason the
 * deadline watchdog in `runner.ts` is not reconcile-based either.
 *
 * Deliberately conservative about when a turn is "in flight" vs. idle: it
 * only arms the idle deadline after actually observing a `result` event for
 * every turn it has seen relayed, via `events.ndjson` — never merely because
 * no new inbox line has appeared. Closing stdin while agy is still mid-turn
 * is unmeasured territory (docs/02 §7 only measured that a *second* turn
 * queues while a first is in flight, not what an EOF mid-turn does), so this
 * never guesses at that: it waits for the turn's own `result` line before
 * treating the process as idle at all.
 */

export interface IdleWatchdogOptions {
  /** `jobs/<id>/events.ndjson` — the only place a completed turn is visible. */
  eventsPath: string
  idleTimeoutMs: number
  /** agy's stdin. Ending it is what makes agy exit at EOF (§6). */
  stdin: Writable
  pollMs?: number
  /** Fired exactly once, the moment the watchdog closes stdin for inactivity. */
  onIdleClose: () => void
}

export interface IdleWatchdog {
  /** Stop polling and cancel any pending idle deadline. Idempotent. */
  stop(): void
  /**
   * Call whenever a turn is relayed to agy's stdin. Marks that turn "in
   * flight" and cancels any pending idle deadline — the watchdog will not
   * re-arm until it observes that turn's own `result` event.
   */
  noteActivity(): void
}

/**
 * Start the watchdog. It never fires before at least one full turn/`result`
 * cycle has been observed: `pendingTurns` starts at 0 and the idle deadline is
 * only armed inside the branch that just decremented it back to 0, so a
 * watchdog created the instant a job spawns cannot race turn 1's own relay.
 */
export function startIdleWatchdog(opts: IdleWatchdogOptions): IdleWatchdog {
  const pollMs = opts.pollMs ?? 250

  let stopped = false
  let fired = false
  let eventsOffset = 0
  /** Turns relayed to stdin but not yet confirmed complete by a `result` event. */
  let pendingTurns = 0
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null

  function clearIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function armIdleTimer(): void {
    clearIdleTimer()
    idleTimer = setTimeout(() => {
      if (fired || stopped) return
      fired = true
      stopInternal()
      try {
        opts.stdin.end()
      } catch {
        // stdin already gone — nothing left to close.
      }
      opts.onIdleClose()
    }, opts.idleTimeoutMs)
  }

  function poll(): void {
    if (stopped) return
    const { lines, nextCursor } = readLinesFrom(opts.eventsPath, eventsOffset)
    eventsOffset = nextCursor

    if (lines.length > 0) {
      const events = okEvents(parseEventLines(lines, 0))
      let completed = 0
      for (const e of events) if (isResult(e)) completed++
      if (completed > 0) {
        pendingTurns = Math.max(0, pendingTurns - completed)
        // Only arm right here, on the transition a `result` just produced —
        // never merely because nothing has happened lately.
        if (pendingTurns === 0) armIdleTimer()
      }
    }

    if (!stopped) pollTimer = setTimeout(poll, pollMs)
  }

  function stopInternal(): void {
    stopped = true
    clearIdleTimer()
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  pollTimer = setTimeout(poll, pollMs)

  return {
    stop: stopInternal,
    noteActivity(): void {
      if (stopped) return
      pendingTurns++
      clearIdleTimer()
    },
  }
}
