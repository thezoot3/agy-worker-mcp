import type {
  AgyEvent,
  AgyInitEvent,
  AgyResultEvent,
  AgyStepUpdateEvent,
  AgyUnknownEvent,
} from '../contract/types.js'
import { readFirstLine } from './cursor.js'

/**
 * A parsed line. A malformed line is preserved as `ok: false` rather than dropped:
 * losing bytes silently makes a truncated or interleaved stream indistinguishable
 * from a clean one, and the malformed count feeds the broker's warnings.
 */
export type ParsedLine =
  | { ok: true; event: AgyEvent; raw: string; offset?: number }
  | { ok: true; event: AgyUnknownEvent; raw: string; offset?: number; unknown: true }
  | { ok: false; raw: string; error: string; offset?: number }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function parseEventLine(raw: string, offset?: number): ParsedLine {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, raw, error: `invalid JSON: ${message}`, offset }
  }

  if (!isRecord(parsed)) {
    return { ok: false, raw, error: 'not a JSON object', offset }
  }

  const eventName = parsed.event
  if (typeof eventName !== 'string' || eventName.length === 0) {
    return { ok: false, raw, error: 'missing "event" field', offset }
  }

  if (eventName === 'init' && typeof parsed.conversation_id === 'string' && isRecord(parsed.init)) {
    return { ok: true, event: parsed as unknown as AgyInitEvent, raw, offset }
  }
  if (eventName === 'step_update' && isRecord(parsed.step_update)) {
    return { ok: true, event: parsed as unknown as AgyStepUpdateEvent, raw, offset }
  }
  if (eventName === 'result' && isRecord(parsed.result)) {
    return { ok: true, event: parsed as unknown as AgyResultEvent, raw, offset }
  }

  return { ok: true, event: parsed as AgyUnknownEvent, raw, offset, unknown: true }
}

export function parseEventLines(lines: string[], startOffset = 0): ParsedLine[] {
  const out: ParsedLine[] = []
  let offset = startOffset
  for (const line of lines) {
    out.push(parseEventLine(line, offset))
    offset += Buffer.byteLength(line, 'utf8') + 1
  }
  return out
}

/** Narrowing helpers. The envelope key always equals the `event` value. */
export function isInit(e: AgyEvent | AgyUnknownEvent): e is AgyInitEvent {
  return e.event === 'init'
}

export function isStepUpdate(e: AgyEvent | AgyUnknownEvent): e is AgyStepUpdateEvent {
  return e.event === 'step_update'
}

export function isResult(e: AgyEvent | AgyUnknownEvent): e is AgyResultEvent {
  return e.event === 'result'
}

/** All well-formed events out of a parse batch. */
export function okEvents(parsed: ParsedLine[]): AgyEvent[] {
  const out: AgyEvent[] = []
  for (const p of parsed) {
    if (!p.ok) continue
    if ('unknown' in p) continue
    out.push(p.event)
  }
  return out
}

/**
 * `conversation_id` from the first line of an events file, or null.
 *
 * Cheap by design — the gate calls it once per candidate job on every tool call.
 * It is available before any tool runs because `init` is always line 1 (§4).
 */
export function extractConversationId(eventsPath: string): string | null {
  const first = readFirstLine(eventsPath)
  if (first === null) return null
  const parsed = parseEventLine(first)
  if (!parsed.ok) return null
  if (isInit(parsed.event)) return parsed.event.conversation_id
  return null
}

/** The last `result` event, i.e. the final turn's self-report. */
export function lastResult(events: AgyEvent[]): AgyResultEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e !== undefined && isResult(e)) return e
  }
  return null
}
