import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { appendJsonLine } from '../../../src/contract/paths.js'
import type { AgyStepUpdateEvent, AgyStepState, GateLogEntry } from '../../../src/contract/types.js'
import { startGateWatchdog } from '../../../src/runner/gate-watchdog.js'

/**
 * `startGateWatchdog` (I4: runtime gate confirmation; docs/operations.md). Real timers,
 * small values — same style as `idle.test.ts`, since the watchdog polls a real
 * file on a real interval and this is what it will actually race in production.
 *
 * Redesigned after a real flake under CI-style parallel load: the trigger is
 * the first tool step reaching a terminal state (`DONE`/`ERROR`), not a flat
 * timer after `ACTIVE`, with a short grace period to absorb the gate-log append
 * trailing the terminal event, and a long hard-cap backstop for a first tool
 * step that never reaches terminal at all.
 */

const dirs: string[] = []

function testDir(): { eventsPath: string; gateLogPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agy-gate-watchdog-test-'))
  dirs.push(dir)
  return { eventsPath: join(dir, 'events.ndjson'), gateLogPath: join(dir, 'gate-log.jsonl') }
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function appendToolStep(path: string, state: AgyStepState): void {
  const line: AgyStepUpdateEvent = {
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-1',
      step_index: 0,
      state,
      step_type: 'tool',
      tool_name: 'run_command',
    },
  }
  appendJsonLine(path, line)
}

function appendNonToolStep(path: string, state: AgyStepState): void {
  const line: AgyStepUpdateEvent = {
    event: 'step_update',
    step_update: {
      conversation_id: 'conv-1',
      step_index: 0,
      state,
      step_type: 'agent_response',
    },
  }
  appendJsonLine(path, line)
}

function appendGateLine(path: string): void {
  const entry: GateLogEntry = {
    ts: Date.now(),
    job_id: 'job-1',
    conversation_id: 'conv-1',
    step_idx: 0,
    tool: 'run_command',
    command: 'echo hi',
    decision: 'allow',
    policy: 'profile_allowlist',
    matched_rule: 'command(echo)',
    reason: null,
  }
  appendJsonLine(path, entry)
}

/** Poll `fn` (real timers) until truthy or the deadline. */
async function waitFor(fn: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fn()) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('startGateWatchdog — a gate-log line at any point confirms', () => {
  it('a line that appears before the terminal step confirms immediately, well inside grace/cap', async () => {
    const { eventsPath, gateLogPath } = testDir()
    let confirmed = false
    let missing = false
    const wd = startGateWatchdog({
      eventsPath,
      gateLogPath,
      graceMs: 5000,
      capMs: 5000,
      pollMs: 15,
      onConfirmed: () => {
        confirmed = true
      },
      onMissing: () => {
        missing = true
      },
    })

    appendToolStep(eventsPath, 'ACTIVE')
    appendGateLine(gateLogPath)
    // Terminal step never even needs to land — confirm should not wait for it.

    expect(await waitFor(() => confirmed, 1000)).toBe(true)
    expect(missing).toBe(false)

    wd.stop()
  })
})

describe('startGateWatchdog — terminal step with an empty gate-log declares missing after grace', () => {
  it('DONE with no gate-log line: missing fires once graceMs has elapsed, not before', async () => {
    const { eventsPath, gateLogPath } = testDir()
    let confirmed = false
    let missing = false
    const wd = startGateWatchdog({
      eventsPath,
      gateLogPath,
      graceMs: 120,
      capMs: 5000,
      pollMs: 15,
      onConfirmed: () => {
        confirmed = true
      },
      onMissing: () => {
        missing = true
      },
    })

    appendToolStep(eventsPath, 'ACTIVE')
    appendToolStep(eventsPath, 'DONE')

    // Still inside the grace window: neither callback should have fired yet.
    await new Promise((r) => setTimeout(r, 40))
    expect(confirmed).toBe(false)
    expect(missing).toBe(false)

    expect(await waitFor(() => missing, 1000)).toBe(true)
    expect(confirmed).toBe(false)

    wd.stop()
  })
})

describe('startGateWatchdog — ACTIVE-only with an empty gate-log declares missing after the hard cap', () => {
  it('a first tool step that never reaches terminal is caught by capMs, not graceMs', async () => {
    const { eventsPath, gateLogPath } = testDir()
    let confirmed = false
    let missing = false
    const wd = startGateWatchdog({
      eventsPath,
      gateLogPath,
      graceMs: 5000, // would never fire — no terminal step ever lands
      capMs: 120,
      pollMs: 15,
      onConfirmed: () => {
        confirmed = true
      },
      onMissing: () => {
        missing = true
      },
    })

    appendToolStep(eventsPath, 'ACTIVE')

    await new Promise((r) => setTimeout(r, 40))
    expect(confirmed).toBe(false)
    expect(missing).toBe(false)

    expect(await waitFor(() => missing, 1000)).toBe(true)
    expect(confirmed).toBe(false)

    wd.stop()
  })
})

describe('startGateWatchdog — a job with no tool step at all resolves neither', () => {
  it('finalize() after only non-tool events, with no gate-log line, calls neither callback', async () => {
    const { eventsPath, gateLogPath } = testDir()
    let confirmed = false
    let missing = false
    const wd = startGateWatchdog({
      eventsPath,
      gateLogPath,
      graceMs: 5000,
      capMs: 5000,
      pollMs: 15,
      onConfirmed: () => {
        confirmed = true
      },
      onMissing: () => {
        missing = true
      },
    })

    appendNonToolStep(eventsPath, 'DONE')
    await new Promise((r) => setTimeout(r, 40))

    wd.finalize()

    expect(confirmed).toBe(false)
    expect(missing).toBe(false)
  })
})

describe('startGateWatchdog — finalize() resolves a fast-exiting job without waiting for a timer', () => {
  it('gate-log already has a line: finalize confirms synchronously', () => {
    const { eventsPath, gateLogPath } = testDir()
    let confirmed = false
    let missing = false
    const wd = startGateWatchdog({
      eventsPath,
      gateLogPath,
      graceMs: 5000,
      capMs: 5000,
      pollMs: 5000, // never gets a chance to fire on its own
      onConfirmed: () => {
        confirmed = true
      },
      onMissing: () => {
        missing = true
      },
    })

    appendToolStep(eventsPath, 'ACTIVE')
    appendToolStep(eventsPath, 'DONE')
    appendGateLine(gateLogPath)

    wd.finalize()

    expect(confirmed).toBe(true)
    expect(missing).toBe(false)
  })

  it('a tool step ran but gate-log is still empty: finalize declares missing synchronously', () => {
    const { eventsPath, gateLogPath } = testDir()
    let confirmed = false
    let missing = false
    const wd = startGateWatchdog({
      eventsPath,
      gateLogPath,
      graceMs: 5000,
      capMs: 5000,
      pollMs: 5000,
      onConfirmed: () => {
        confirmed = true
      },
      onMissing: () => {
        missing = true
      },
    })

    appendToolStep(eventsPath, 'ACTIVE')

    wd.finalize()

    expect(confirmed).toBe(false)
    expect(missing).toBe(true)
  })
})
