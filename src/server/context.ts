import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Capabilities } from '../contract/types.js'
import type { ProjectPaths } from '../contract/paths.js'
import { packageRoot } from '../contract/paths.js'
import { toErrorEnvelope } from '../contract/errors.js'
import { openStore, type Store } from '../store/db.js'

/** Shared state every tool handler receives. One per server process. */
export interface ToolContext {
  store: Store
  paths: ProjectPaths
  version: string
  limits: Capabilities['limits']
}

/**
 * Standard MCP tool return. The JSON goes out as text content *and* as
 * `structuredContent`: Codex's structured-output support is uneven, so text is
 * the safe default while structured stays available for clients that use it
 * (`docs/01`, tool surface).
 */
export interface ToolReply {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/** Wrap a JSON-serializable payload as text content plus structuredContent. */
export function reply(payload: unknown): ToolReply {
  const text = JSON.stringify(payload, null, 2)
  const structuredContent =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : { value: payload }
  return { content: [{ type: 'text', text }], structuredContent }
}

/**
 * Turn any throw into a teaching error reply: the structured `detail` from
 * `contract/errors.ts` plus its `remedy`, so the calling agent can self-correct
 * without another round trip.
 */
export function errorReply(e: unknown): ToolReply {
  const envelope = toErrorEnvelope(e)
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
    isError: true,
  }
}

function readPackageVersion(): string {
  try {
    const raw = readFileSync(join(packageRoot(), 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { version?: string }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const DEFAULT_LIMITS: Capabilities['limits'] = {
  max_running_jobs: 3,
  max_timeout_ms: 60 * 60 * 1000,
  default_timeout_ms: 15 * 60 * 1000,
  max_response_bytes: 32_000,
  max_log_tail_lines: 30,
}

/** Build the context, opening the store for the discovered project root. */
export function createContext(cwd?: string): ToolContext {
  const store = openStore({ cwd })
  return {
    store,
    paths: store.paths,
    version: readPackageVersion(),
    limits: DEFAULT_LIMITS,
  }
}
