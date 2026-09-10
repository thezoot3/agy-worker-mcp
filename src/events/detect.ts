import {
  ENVIRONMENT_BLOCK_SIGNATURES,
  GATE_DENIAL_MARKER,
  HOOK_DENIAL_PREFIX,
} from '../contract/types.js'
import type {
  AgyEvent,
  AgyStepUpdateEvent,
  AgyToolInfo,
  DenialClass1,
  DenialClass2,
  DenialScan,
  GateDenialPayload,
} from '../contract/types.js'

/**
 * Detect the two ways a job gets stuck (see docs/permissions.md).
 *
 * Both are invisible in the obvious places: agy exits 0 and reports
 * `status: "SUCCESS"` for a hook denial *and* for a sandboxed network block
 * (see docs/permissions.md). Skipping this module means reporting failed work as success.
 */

function commandOf(toolInfo: AgyToolInfo | undefined): string | null {
  const cmd = toolInfo?.parameters?.CommandLine
  return typeof cmd === 'string' ? cmd : null
}

/**
 * Class 1 — a structured refusal.
 *
 * Signal: `step_type === 'tool' && state === 'ERROR'`, message in
 * `tool_info.error.message`. stderr stays empty and the exit code stays 0, so
 * this event is the only trace.
 */
export function detectClass1(step: AgyStepUpdateEvent): DenialClass1 | null {
  const su = step.step_update
  if (su.step_type !== 'tool' || su.state !== 'ERROR') return null

  const message = su.tool_info?.error?.message ?? ''
  const tool = su.tool_name ?? su.tool_info?.name ?? 'unknown'
  const command = commandOf(su.tool_info)
  const required_rule = extractRequiredRule(message)
  const gatePayload = parseGateDenial(message)

  let source: DenialClass1['source'] = 'unknown'
  if (message.startsWith(HOOK_DENIAL_PREFIX)) {
    source = 'gate'
  } else if (su.tool_info?.error !== undefined) {
    source = 'agy'
  }

  return {
    class: 1,
    tool,
    command,
    required_rule,
    policy: gatePayload?.policy ?? null,
    source,
    message,
    step_idx: su.step_index ?? null,
  }
}

/** The only tool agy's OS sandbox wraps; every other tool runs outside it. */
const SANDBOXED_TOOL = 'run_command'

/**
 * Class 2 — a silent environment block.
 *
 * Signal: an ordinary successful `run_command` step whose `tool_info.output`
 * matches one of `ENVIRONMENT_BLOCK_SIGNATURES`. There is no error event at all.
 * This is the more dangerous class: an hour-long job can fail to install
 * anything and still return SUCCESS.
 *
 * Only `run_command` is scanned: the sandbox wraps the shell and nothing else,
 * and the output of `grep_search`/`view_file` over a source tree that merely
 * *contains* the words "Operation not permitted" is not a block (measured
 * 2026-09-03: a job grepping this very repository produced three false
 * blockers that way).
 */
export function detectClass2(step: AgyStepUpdateEvent): DenialClass2 | null {
  const su = step.step_update
  if (su.step_type !== 'tool') return null
  const tool = su.tool_name ?? su.tool_info?.name ?? 'unknown'
  if (tool !== SANDBOXED_TOOL) return null

  const output = su.tool_info?.output
  if (typeof output !== 'string' || output.length === 0) return null

  const signature = matchEnvironmentSignature(output)
  if (signature === null) return null

  const command = commandOf(su.tool_info)

  // The match is case-insensitive, so locate the excerpt the same way.
  const idx = output.toLowerCase().indexOf(signature.toLowerCase())
  const CONTEXT = 60
  const start = Math.max(0, idx - CONTEXT)
  const end = Math.min(output.length, idx + signature.length + CONTEXT)
  const excerpt = output.slice(start, end).replace(/\s+/g, ' ').trim()

  return {
    class: 2,
    tool,
    command,
    signature,
    excerpt,
    step_idx: su.step_index ?? null,
  }
}

/** Run both detectors over a whole event stream. */
export function scanDenials(events: AgyEvent[]): DenialScan {
  const permission_denials: DenialClass1[] = []
  const environment_blocks: DenialClass2[] = []

  for (const e of events) {
    if (e.event !== 'step_update') continue
    const c1 = detectClass1(e)
    if (c1 !== null) permission_denials.push(c1)
    const c2 = detectClass2(e)
    if (c2 !== null) environment_blocks.push(c2)
  }

  return { permission_denials, environment_blocks }
}

/**
 * Pull the machine payload our gate embedded after `GATE_DENIAL_MARKER`.
 * Null when the refusal did not come from us.
 *
 * Format authored by the gate: `<guidance> [agy-worker-denial:{"...json..."}]`.
 * The payload runs from right after the marker up to the closing `]` that wraps
 * it, so a trailing `]` (if present) is stripped before parsing.
 */
export function parseGateDenial(message: string): GateDenialPayload | null {
  const markerIdx = message.indexOf(GATE_DENIAL_MARKER)
  if (markerIdx === -1) return null

  let rest = message.slice(markerIdx + GATE_DENIAL_MARKER.length).trim()
  if (rest.endsWith(']')) rest = rest.slice(0, -1).trim()

  try {
    const payload = JSON.parse(rest) as unknown
    if (typeof payload === 'object' && payload !== null) {
      return payload as GateDenialPayload
    }
    return null
  } catch {
    return null
  }
}

// Greedy so a rule that itself contains parens — e.g. "command(echo x)" — keeps
// its own closing paren; only the outermost "(required rule: ...)" wrapper ends
// at the final ')' in the message.
const REQUIRED_RULE_PROSE = /\(required rule:\s*(.+)\)\s*$/

/**
 * Best-effort `required_rule` from a denial message.
 *
 * Prefers the embedded payload; falls back to the `(required rule: ...)` prose
 * form that appears in the measured transcript. The caller pastes the result
 * straight into the next `agy_start`'s `permissions.allow`, which is the whole
 * recovery loop (see docs/permissions.md).
 */
export function extractRequiredRule(message: string): string | null {
  const gate = parseGateDenial(message)
  if (gate !== null && typeof gate.required_rule === 'string' && gate.required_rule.length > 0) {
    return gate.required_rule
  }

  const match = message.match(REQUIRED_RULE_PROSE)
  const rule = match?.[1]
  return rule !== undefined ? rule.trim() : null
}

/**
 * Which signature, if any, a tool output contains. Case-insensitive: the same
 * seatbelt refusal surfaces as `Operation not permitted` from coreutils
 * (`mkdir: build: Operation not permitted`) and as `operation not permitted`
 * from zsh's own redirection error (`zsh:1: operation not permitted: note.txt`,
 * measured on agy 1.1.24), and as `sh: out.txt: Operation not permitted` — all
 * single-line or final-line. The canonical (capitalised) signature is returned.
 *
 * 0.3.0 PR5: Only inspects the last 5 non-empty lines of the output.
 * A real sandbox/network refusal is the failing command's final message;
 * a signature buried mid-output inside a test report is not.
 */
export function matchEnvironmentSignature(output: string): string | null {
  const lines = output.split('\n')
  const nonEmpty: string[] = []
  for (let i = lines.length - 1; i >= 0 && nonEmpty.length < 5; i--) {
    const line = lines[i]
    if (line !== undefined && line.trim().length > 0) {
      nonEmpty.push(line)
    }
  }
  const tail = nonEmpty.reverse().join('\n').toLowerCase()
  for (const sig of ENVIRONMENT_BLOCK_SIGNATURES) {
    if (tail.includes(sig.toLowerCase())) return sig
  }
  return null
}
