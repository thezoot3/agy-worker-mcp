import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { z } from 'zod'

import type { ToolContext, ToolReply } from '../context.js'

import { startInput, handleStart } from './start.js'
import { waitInput, handleWait } from './wait.js'
import { resultInput, handleResult } from './result.js'
import { logsInput, handleLogs } from './logs.js'
import { sendInput, handleSend } from './send.js'
import { cancelInput, handleCancel } from './cancel.js'
import { listJobsInput, handleListJobs } from './listJobs.js'
import { sessionsInput, handleSessions } from './sessions.js'
import { capabilitiesInput, handleCapabilities } from './capabilities.js'

export * from './start.js'
export * from './wait.js'
export * from './result.js'
export * from './logs.js'
export * from './send.js'
export * from './cancel.js'
export * from './listJobs.js'
export * from './sessions.js'
export * from './capabilities.js'

/**
 * MCP tool annotations for the nine tools.
 *
 * Read-only: wait, result, logs, list_jobs, sessions, capabilities.
 * Idempotent: everything except `agy_start` and `agy_send`, which each append.
 * Destructive: `agy_cancel`. Open-world: `agy_start`, which runs an external agent.
 */
export interface ToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  idempotentHint?: boolean
  destructiveHint?: boolean
  openWorldHint?: boolean
}

export const TOOL_NAMES = [
  'agy_start',
  'agy_wait',
  'agy_result',
  'agy_logs',
  'agy_send',
  'agy_cancel',
  'agy_list_jobs',
  'agy_sessions',
  'agy_capabilities',
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

export const TOOL_ANNOTATIONS: Readonly<Record<ToolName, ToolAnnotations>> = Object.freeze({
  agy_start: {
    title: 'Start agy job',
    openWorldHint: true,
  },
  agy_wait: {
    title: 'Wait for job state',
    readOnlyHint: true,
    idempotentHint: true,
  },
  agy_result: {
    title: 'Get job result',
    readOnlyHint: true,
    idempotentHint: true,
  },
  agy_logs: {
    title: 'Read job logs',
    readOnlyHint: true,
    idempotentHint: true,
  },
  agy_send: {
    title: 'Queue follow-up turn',
  },
  agy_cancel: {
    title: 'Cancel job',
    destructiveHint: true,
    idempotentHint: true,
  },
  agy_list_jobs: {
    title: 'List jobs',
    readOnlyHint: true,
    idempotentHint: true,
  },
  agy_sessions: {
    title: 'Manage sessions',
    readOnlyHint: true,
    idempotentHint: true,
  },
  agy_capabilities: {
    title: 'Server capabilities',
    readOnlyHint: true,
    idempotentHint: true,
  },
})

/**
 * Register all nine tools.
 *
 * Every handler must call `broker.reconcile()` on entry — that is the only thing
 * standing in for a daemon (`docs/01` 결정 5). Each `handle*` function in this
 * directory does that itself, so registration here is pure wiring.
 */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  // The SDK's `registerTool` generics (`ZodRawShapeCompat`, its own zod-compat
  // layer) do not infer cleanly against a locally generic wrapper. Registration
  // is one-shot, boring wiring, so the loose cast here buys straightforward code
  // over fighting the SDK's overload resolution; each `handle*` function is fully
  // typed on its own, which is where a real mistake would actually be caught.
  function register(
    name: ToolName,
    description: string,
    inputSchema: z.ZodRawShape,
    handler: (ctx: ToolContext, input: never) => Promise<ToolReply>,
  ): void {
    ;(
      server as unknown as {
        registerTool: (
          n: string,
          c: { title?: string; description?: string; inputSchema?: z.ZodRawShape; annotations?: ToolAnnotations },
          cb: (args: Record<string, unknown>) => Promise<ToolReply>,
        ) => void
      }
    ).registerTool(
      name,
      {
        title: TOOL_ANNOTATIONS[name].title,
        description,
        inputSchema,
        annotations: TOOL_ANNOTATIONS[name],
      },
      async (args) => handler(ctx, args as never),
    )
  }

  register(
    'agy_start',
    'Begin a new agy job. Returns job_id immediately; never blocks — plus policy_summary and blockers[] for what the profile ceiling did to your permissions request. Use dry_run to resolve config and policy without spawning agy or spending quota.',
    startInput.shape,
    handleStart,
  )
  register(
    'agy_wait',
    'Long-poll a job until it FINISHES or wait_ms runs out — it does not return early on intermediate transitions like queued->running (200ms internal polling; wait_ms=0 for an immediate snapshot). A short wait_ms is a poll interval, not a change notification: each call blocks for the whole budget unless the job finished. Returns the judgement packet only, not full logs or the response text.',
    waitInput.shape,
    handleWait,
  )
  register(
    'agy_result',
    'Full, paged result of a finished job: broker summary, agent self-report, and verification (blockers[] with source / actionable / remedy for each thing that stood in the way).',
    resultInput.shape,
    handleResult,
  )
  register(
    'agy_logs',
    'Read raw events, normalized human-readable lines, or stderr for a job, by byte cursor or tail.',
    logsInput.shape,
    handleLogs,
  )
  register(
    'agy_send',
    'Queue a follow-up turn on a session-mode job. Only takes effect after the in-flight turn finishes; there is no way to interrupt a running turn.',
    sendInput.shape,
    handleSend,
  )
  register(
    'agy_cancel',
    'Kill a running job and its whole process group.',
    cancelInput.shape,
    handleCancel,
  )
  register(
    'agy_list_jobs',
    'List running and recently finished jobs in this project.',
    listJobsInput.shape,
    handleListJobs,
  )
  register(
    'agy_sessions',
    'List, inspect, or close agy conversations (sessions). A session is one agy conversation; a job is one turn.',
    sessionsInput.shape,
    handleSessions,
  )
  register(
    'agy_capabilities',
    'Report models, profiles, limits, discovered project root, and server version.',
    capabilitiesInput.shape,
    handleCapabilities,
  )
}
