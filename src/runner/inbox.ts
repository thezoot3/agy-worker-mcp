import { readFileSync } from 'node:fs'
import type { Writable } from 'node:stream'

import { appendJsonLine } from '../contract/paths.js'
import type { InboxControlLine, InboxLine, InboxUserLine } from '../contract/types.js'

/**
 * Follow-up turns travel through a file, not a socket (`docs/03` §3.4).
 *
 * `agy_send` appends a line and returns; the runner tails the file and relays to
 * agy's stdin. The MCP server never touches the process, so a client dying
 * mid-send cannot wedge anything.
 */

/** Build the stream-json line for a user turn — byte-identical to agy's schema (§5). */
export function userLine(text: string): InboxUserLine {
  return {
    event: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  }
}

/** Append one queued turn. The only thing `agy_send` does. */
export function appendUserTurn(inboxPath: string, text: string): void {
  appendJsonLine(inboxPath, userLine(text))
}

/**
 * Append the close directive. The relay consumes it and closes stdin, which is
 * how agy is told the conversation is over (EOF ends the process, §6).
 */
export function appendClose(inboxPath: string): void {
  const line: InboxControlLine = { agy_worker_control: 'close', ts: Date.now() }
  appendJsonLine(inboxPath, line)
}

function isControlLine(line: InboxLine): line is InboxControlLine {
  return (
    typeof line === 'object' &&
    line !== null &&
    'agy_worker_control' in line &&
    (line as InboxControlLine).agy_worker_control === 'close'
  )
}

export interface InboxRead {
  lines: InboxLine[]
  nextOffset: number
}

/**
 * Read complete lines from `offset` onward. A half-written trailing line is left
 * for the next call, exactly like the events cursor.
 */
export function readInboxFrom(inboxPath: string, offset: number): InboxRead {
  let buf: Buffer
  try {
    buf = readFileSync(inboxPath)
  } catch {
    return { lines: [], nextOffset: offset }
  }
  if (offset < 0 || offset >= buf.length) {
    return { lines: [], nextOffset: Math.max(offset, 0) }
  }

  const text = buf.subarray(offset).toString('utf8')
  const lines: InboxLine[] = []
  let consumedBytes = 0
  let searchFrom = 0

  for (;;) {
    const nlIdx = text.indexOf('\n', searchFrom)
    if (nlIdx === -1) break
    const rawLine = text.slice(searchFrom, nlIdx)
    consumedBytes += Buffer.byteLength(rawLine, 'utf8') + 1 // +1 for the newline itself
    searchFrom = nlIdx + 1

    const trimmed = rawLine.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed = JSON.parse(trimmed) as InboxLine
      lines.push(parsed)
    } catch {
      // Malformed line: drop it, but still consume the bytes so we don't spin on it.
    }
  }

  return { lines, nextOffset: offset + consumedBytes }
}

export interface InboxRelayOptions {
  inboxPath: string
  /** agy's stdin. Only exists when the job was spawned with a stdin pipe. */
  stdin: Writable
  pollMs?: number
  /** Fired after the close directive has been relayed and stdin ended. */
  onClose?: () => void
  /**
   * Fired each time a user line is actually written to stdin. The idle
   * watchdog (`docs/04` 미해결 질문 3) hooks this to know a turn just went "in
   * flight", so it never arms its deadline mid-turn.
   */
  onUserLineSent?: () => void
}

export interface InboxRelay {
  /** Stop polling. Does not close stdin. */
  stop(): void
  /** Bytes consumed so far. */
  readonly offset: number
}

/**
 * Tail the inbox and forward user lines to stdin, filtering out control lines.
 *
 * Queued turns only ever queue: agy finishes the in-flight turn before starting
 * the next one, and there is no interrupt path in print mode (§7). Anything that
 * promises otherwise is wrong.
 */
export function startInboxRelay(opts: InboxRelayOptions): InboxRelay {
  const pollMs = opts.pollMs ?? 250
  let offset = 0
  let stopped = false
  let closed = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function tick(): void {
    if (stopped || closed) return

    const { lines, nextOffset } = readInboxFrom(opts.inboxPath, offset)
    offset = nextOffset

    for (const line of lines) {
      if (isControlLine(line)) {
        closed = true
        try {
          opts.stdin.end()
        } catch {
          // stdin already gone — nothing left to close.
        }
        opts.onClose?.()
        break
      }

      try {
        opts.stdin.write(JSON.stringify(line) + '\n')
        opts.onUserLineSent?.()
      } catch {
        // agy's stdin is gone (process likely exited); stop relaying rather than
        // throwing out of a timer callback.
        stopped = true
        break
      }
    }

    if (!stopped && !closed) {
      timer = setTimeout(tick, pollMs)
    }
  }

  timer = setTimeout(tick, pollMs)

  return {
    stop(): void {
      stopped = true
      if (timer) clearTimeout(timer)
    },
    get offset(): number {
      return offset
    },
  }
}
