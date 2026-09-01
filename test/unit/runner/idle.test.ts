import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { appendJsonLine } from '../../../src/contract/paths.js'
import type { AgyResultEvent } from '../../../src/contract/types.js'
import { startIdleWatchdog } from '../../../src/runner/idle.js'

/**
 * `startIdleWatchdog` (`docs/04` 미해결 질문 3). Real timers, small values —
 * matches the timing style already used by the integration suite's
 * `waitUntil`/`sleep` helpers rather than fake timers, since the watchdog
 * itself polls a real file on a real interval.
 */

const dirs: string[] = []

function eventsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-idle-test-'))
  dirs.push(dir)
  return join(dir, 'events.ndjson')
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Fake stdin: just enough of `Writable` for `startIdleWatchdog` to call `.end()`. */
function fakeStdin(): { end: () => void; endCalls: number } {
  const state = { endCalls: 0 }
  return {
    endCalls: 0,
    end() {
      state.endCalls++
      this.endCalls = state.endCalls
    },
  }
}

function appendResult(path: string, numTurns: number): void {
  const line: AgyResultEvent = {
    event: 'result',
    result: {
      conversation_id: 'conv-1',
      status: 'SUCCESS',
      response: `turn ${numTurns} done`,
      duration_seconds: 0.1,
      num_turns: numTurns,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  }
  appendJsonLine(path, line)
}

/** Poll `fn` (real timers) until truthy or the deadline. */
async function waitFor(fn: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fn()) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 15))
  }
}

describe('startIdleWatchdog — never fires before a turn actually completes', () => {
  it('does not close stdin while pendingTurns > 0, even past idleTimeoutMs', async () => {
    const path = eventsFile()
    const stdin = fakeStdin()
    let closed = false
    const wd = startIdleWatchdog({
      eventsPath: path,
      idleTimeoutMs: 60,
      stdin: stdin as never,
      pollMs: 15,
      onIdleClose: () => {
        closed = true
      },
    })

    // Turn 1 relayed — in flight. No `result` event ever lands.
    wd.noteActivity()

    await new Promise((r) => setTimeout(r, 300))
    expect(closed).toBe(false)
    expect(stdin.endCalls).toBe(0)

    wd.stop()
  })
})

describe('startIdleWatchdog — closes stdin idleTimeoutMs after a turn completes with no follow-up', () => {
  it('fires onIdleClose exactly once and ends stdin exactly once', async () => {
    const path = eventsFile()
    const stdin = fakeStdin()
    let closeCount = 0
    const wd = startIdleWatchdog({
      eventsPath: path,
      idleTimeoutMs: 80,
      stdin: stdin as never,
      pollMs: 15,
      onIdleClose: () => {
        closeCount++
      },
    })

    wd.noteActivity() // turn 1 relayed
    appendResult(path, 1) // turn 1 completes -> watchdog should arm

    const fired = await waitFor(() => closeCount > 0, 2000)
    expect(fired).toBe(true)
    expect(closeCount).toBe(1)
    expect(stdin.endCalls).toBe(1)

    // Stays fired — no double-fire from the poll loop continuing.
    await new Promise((r) => setTimeout(r, 200))
    expect(closeCount).toBe(1)
    expect(stdin.endCalls).toBe(1)

    wd.stop()
  })
})

describe('startIdleWatchdog — activity after a completed turn cancels the pending close', () => {
  it('does not fire if noteActivity() lands before idleTimeoutMs elapses', async () => {
    const path = eventsFile()
    const stdin = fakeStdin()
    let closed = false
    const wd = startIdleWatchdog({
      eventsPath: path,
      idleTimeoutMs: 150,
      stdin: stdin as never,
      pollMs: 15,
      onIdleClose: () => {
        closed = true
      },
    })

    wd.noteActivity() // turn 1 relayed
    appendResult(path, 1) // turn 1 completes -> idle deadline armed for 150ms

    // A second turn is sent well before the 150ms deadline.
    await new Promise((r) => setTimeout(r, 40))
    wd.noteActivity()

    // Wait past what would have been the first deadline. Still not idle:
    // turn 2 has not completed yet.
    await new Promise((r) => setTimeout(r, 200))
    expect(closed).toBe(false)
    expect(stdin.endCalls).toBe(0)

    wd.stop()
  })

  it('re-arms and fires idleTimeoutMs after the second turn completes', async () => {
    const path = eventsFile()
    const stdin = fakeStdin()
    let closeCount = 0
    const wd = startIdleWatchdog({
      eventsPath: path,
      idleTimeoutMs: 80,
      stdin: stdin as never,
      pollMs: 15,
      onIdleClose: () => {
        closeCount++
      },
    })

    wd.noteActivity()
    appendResult(path, 1)
    await new Promise((r) => setTimeout(r, 30)) // well inside the 80ms deadline
    wd.noteActivity()
    appendResult(path, 2)

    const fired = await waitFor(() => closeCount > 0, 2000)
    expect(fired).toBe(true)
    expect(closeCount).toBe(1)
    expect(stdin.endCalls).toBe(1)

    wd.stop()
  })
})

describe('startIdleWatchdog — stop() prevents any later close', () => {
  it('a completed turn after stop() never triggers onIdleClose', async () => {
    const path = eventsFile()
    const stdin = fakeStdin()
    let closed = false
    const wd = startIdleWatchdog({
      eventsPath: path,
      idleTimeoutMs: 40,
      stdin: stdin as never,
      pollMs: 15,
      onIdleClose: () => {
        closed = true
      },
    })

    wd.noteActivity()
    wd.stop()
    appendResult(path, 1)

    await new Promise((r) => setTimeout(r, 200))
    expect(closed).toBe(false)
    expect(stdin.endCalls).toBe(0)
  })
})
