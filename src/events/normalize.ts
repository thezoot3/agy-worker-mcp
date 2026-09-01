import { ENVIRONMENT_BLOCK_SIGNATURES } from '../contract/types.js'
import type { AgyEvent, AgyToolInfo, NormalizedEvent, NormalizedKind } from '../contract/types.js'
import type { ParsedLine } from './parse.js'

/**
 * Turn raw `step_update` traffic into a short human-readable trail.
 *
 * Keep: phase transitions, command start/end, errors and warnings, check
 * PASS/FAIL, artifact creation, and the tail of the final response.
 * Drop: repeated token deltas, blank text, and duplicates of the previous line.
 *
 * Normalization happens on read, in memory. Nothing is persisted — the raw
 * NDJSON stays the only stored form (`docs/01` 결정 3).
 */
export interface NormalizeOptions {
  /** Truncate each line to this many characters. */
  maxLineChars?: number
  /** Collapse consecutive `agent_message` lines into one. */
  collapseDeltas?: boolean
}

const DEFAULT_MAX_CHARS = 200

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Head truncation: keep the start, ellipsis at the end. */
function truncateHead(text: string, maxChars: number): string {
  const collapsed = collapseWhitespace(text)
  if (collapsed.length <= maxChars) return collapsed
  if (maxChars <= 1) return collapsed.slice(0, maxChars)
  return collapsed.slice(0, maxChars - 1) + '…'
}

/** Tail truncation: keep the end (the part that matters for a final response). */
function truncateTail(text: string, maxChars: number): string {
  const collapsed = collapseWhitespace(text)
  if (collapsed.length <= maxChars) return collapsed
  if (maxChars <= 1) return collapsed.slice(collapsed.length - maxChars)
  return '…' + collapsed.slice(collapsed.length - (maxChars - 1))
}

function commandOf(toolInfo: AgyToolInfo | undefined): string | undefined {
  const cmd = toolInfo?.parameters?.CommandLine
  return typeof cmd === 'string' ? cmd : undefined
}

function environmentSignatureIn(output: string): string | null {
  for (const sig of ENVIRONMENT_BLOCK_SIGNATURES) {
    if (output.includes(sig)) return sig
  }
  return null
}

function make(
  kind: NormalizedKind,
  severity: NormalizedEvent['severity'],
  stepIdx: number | null,
  text: string,
  extra?: Partial<NormalizedEvent>,
): NormalizedEvent {
  return { kind, severity, step_idx: stepIdx, text, ...extra }
}

/** Null when the event carries nothing worth a line. */
export function normalizeEvent(event: AgyEvent, opts?: NormalizeOptions): NormalizedEvent | null {
  const maxChars = opts?.maxLineChars ?? DEFAULT_MAX_CHARS

  if (event.event === 'init') {
    const i = event.init
    return make(
      'session_start',
      'info',
      null,
      truncateHead(`session started model=${i.model} cwd=${i.cwd}`, maxChars),
    )
  }

  if (event.event === 'result') {
    const r = event.result
    if (r.status === 'SUCCESS') {
      return make('final_response', 'info', null, truncateTail(r.response ?? '', maxChars), {
        duration_seconds: r.duration_seconds,
      })
    }
    const text = r.error ?? r.response ?? 'turn ended with an error'
    return make('final_response', 'error', null, truncateTail(text, maxChars), {
      duration_seconds: r.duration_seconds,
    })
  }

  // step_update
  const su = event.step_update
  const stepIdx = su.step_index ?? null
  const command = commandOf(su.tool_info)

  if (su.step_type === 'tool') {
    if (su.state === 'ERROR') {
      const msg = su.tool_info?.error?.message ?? 'tool call failed'
      return make(
        'tool_error',
        'error',
        stepIdx,
        truncateHead(`${su.tool_name ?? 'tool'} failed: ${msg}`, maxChars),
        { tool: su.tool_name, command, duration_seconds: su.duration_seconds },
      )
    }
    if (su.state === 'ACTIVE') {
      return make(
        'command_start',
        'info',
        stepIdx,
        truncateHead(`${su.tool_name ?? 'tool'} started${command ? `: ${command}` : ''}`, maxChars),
        { tool: su.tool_name, command },
      )
    }
    if (su.state === 'DONE') {
      const output = su.tool_info?.output
      if (typeof output === 'string' && environmentSignatureIn(output) !== null) {
        const sig = environmentSignatureIn(output) as string
        return make(
          'environment_block',
          'warning',
          stepIdx,
          truncateHead(
            `${su.tool_name ?? 'tool'} output looks blocked by the environment (${sig})`,
            maxChars,
          ),
          { tool: su.tool_name, command, duration_seconds: su.duration_seconds },
        )
      }
      return make(
        'command_end',
        'info',
        stepIdx,
        truncateHead(`${su.tool_name ?? 'tool'} finished${command ? `: ${command}` : ''}`, maxChars),
        { tool: su.tool_name, command, duration_seconds: su.duration_seconds },
      )
    }
    return null
  }

  if (su.step_type === 'user_input') {
    if (su.state === 'DONE') {
      return make('phase', 'info', stepIdx, 'turn started')
    }
    return null
  }

  if (su.step_type === 'system_message') {
    const text = su.text_delta
    if (!text || text.trim() === '') return null
    return make('system', 'info', stepIdx, truncateHead(text, maxChars))
  }

  if (su.step_type === 'agent_response') {
    if (su.state === 'ERROR') {
      return make('tool_error', 'error', stepIdx, 'agent response ended in error')
    }
    // Streamed token deltas are dropped on purpose — the tail of the final
    // response is already captured once, from the `result` event.
    return null
  }

  // Unrecognized step_type: still surface an error state, drop everything else.
  if (su.state === 'ERROR') {
    return make('tool_error', 'error', stepIdx, `step ${stepIdx ?? '?'} ended in error`)
  }
  return null
}

/** Batch form; also surfaces malformed lines as `kind: 'raw'`, severity `warning`. */
export function normalizeParsed(parsed: ParsedLine[], opts?: NormalizeOptions): NormalizedEvent[] {
  const maxChars = opts?.maxLineChars ?? DEFAULT_MAX_CHARS
  const out: NormalizedEvent[] = []
  let prevKey: string | null = null

  for (const p of parsed) {
    let ne: NormalizedEvent | null

    if (!p.ok) {
      ne = make('raw', 'warning', null, truncateHead(`malformed line: ${p.error}`, maxChars), {
        offset: p.offset,
      })
    } else if ('unknown' in p) {
      ne = make('raw', 'info', null, truncateHead(`unknown event: ${p.raw}`, maxChars), {
        offset: p.offset,
      })
    } else {
      ne = normalizeEvent(p.event, opts)
      if (ne !== null && p.offset !== undefined) ne = { ...ne, offset: p.offset }
    }

    if (ne === null) continue
    if (ne.text.trim() === '') continue

    const key = `${ne.kind}|${ne.step_idx}|${ne.text}`
    if (key === prevKey) continue // duplicate of the immediately preceding line

    out.push(ne)
    prevKey = key
  }

  return out
}

/** Render one normalized event as a single display line. */
export function formatNormalized(e: NormalizedEvent): string {
  const prefix = e.severity === 'error' ? '[ERROR]' : e.severity === 'warning' ? '[WARN]' : ''
  const stepPart = e.step_idx !== null ? `#${e.step_idx}` : ''
  return [prefix, stepPart, e.text].filter((s) => s.length > 0).join(' ')
}

/**
 * The last `maxLines` display lines, obeying a byte budget.
 * This is what `agy_wait` returns as `log_tail` (`docs/04` #16, #17).
 */
export function tailSummary(events: NormalizedEvent[], maxLines: number, maxBytes?: number): string[] {
  if (maxLines <= 0) return []
  const lines = events.slice(-maxLines).map(formatNormalized)
  if (maxBytes === undefined) return lines

  let total = lines.reduce((acc, l) => acc + Buffer.byteLength(l, 'utf8') + 1, 0)
  while (lines.length > 0 && total > maxBytes) {
    const removed = lines.shift()
    if (removed === undefined) break
    total -= Buffer.byteLength(removed, 'utf8') + 1
  }
  return lines
}
