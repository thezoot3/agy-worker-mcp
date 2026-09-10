import { isAbsolute, join } from 'node:path'

import { canonicalize } from '../contract/paths.js'
import type { RuleSubject } from './rules.js'
import { redirectionTargets } from './containment.js'

/**
 * What a hook payload's tool call actually is, for the gate's `decide()`.
 *
 * Table transcribed from measurements M1 (the 7 tools
 * a model actually calls, verbatim argument names) and M2 (the 4 subagent
 * tools, which run under a *different* `conversationId` the gate can never
 * bind).
 *
 * `manage_task` and `schedule` are `control`: they only ever touch
 * conversation-scoped task bookkeeping (§`status`/`send_input`, M1) or
 * agy's own task-scheduling helper without touching
 * files or running commands. Nothing a rule list or containment root could
 * meaningfully constrain, so they are always allowed rather than falling
 * through `unsupported` and denying the one tool a background command or
 * timeout retry needs.
 */
export type ToolClass =
  | { kind: 'subject'; subject: RuleSubject; read: string[]; write: string[] }
  | { kind: 'control' }
  | { kind: 'unsupported'; reason: string; subagent: boolean }

/** M2: these run their own tool calls under a fresh `conversationId` the gate cannot bind. */
const SUBAGENT_TOOLS = new Set(['define_subagent', 'invoke_subagent', 'manage_subagents', 'browser_subagent'])

const SUBAGENT_REASON =
  'Subagent tool denied. Subagents run under a separate conversationId, so policies bound to this job cannot govern their tool calls (M2). Do not define or invoke subagents; perform the required work directly within this conversation.'

const GENERIC_UNSUPPORTED_REASON =
  'This tool is not supported by agy-worker policy. Only the 7 observed tools (run_command, view_file, list_dir, find_by_name, grep_search, write_to_file, replace_file_content) along with manage_task and schedule can be classified by policy.'

function stringArg(args: Record<string, unknown>, key: string): string | null {
  const v = args[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Resolve a tool argument path against the call's own `Cwd` (present on every
 * hook payload, not just `run_command`'s — measured, M1) when it is relative,
 * falling back to `workspace`. Every path M1 actually captured was absolute
 * already; this only covers the possibility, not an observed case.
 */
function resolveArgPath(value: string, args: Record<string, unknown>, workspace: string): string {
  if (isAbsolute(value)) return canonicalize(value)
  const cwd = stringArg(args, 'Cwd') ?? workspace
  return canonicalize(join(cwd, value))
}

function unsupported(reason: string, subagent = false): ToolClass {
  return { kind: 'unsupported', reason, subagent }
}

function readOnlySubject(args: Record<string, unknown>, workspace: string, field: string): ToolClass {
  const raw = stringArg(args, field)
  if (raw === null) return unsupported(GENERIC_UNSUPPORTED_REASON)
  const resolved = resolveArgPath(raw, args, workspace)
  return { kind: 'subject', subject: { verb: 'read_file', value: resolved }, read: [resolved], write: [] }
}

function writeOnlySubject(args: Record<string, unknown>, workspace: string, field: string): ToolClass {
  const raw = stringArg(args, field)
  if (raw === null) return unsupported(GENERIC_UNSUPPORTED_REASON)
  const resolved = resolveArgPath(raw, args, workspace)
  return { kind: 'subject', subject: { verb: 'write_file', value: resolved }, read: [], write: [resolved] }
}

function readWriteSubject(args: Record<string, unknown>, workspace: string, field: string): ToolClass {
  const raw = stringArg(args, field)
  if (raw === null) return unsupported(GENERIC_UNSUPPORTED_REASON)
  const resolved = resolveArgPath(raw, args, workspace)
  return {
    kind: 'subject',
    subject: { verb: 'write_file', value: resolved },
    read: [resolved],
    write: [resolved],
  }
}

/**
 * Classify one hook payload's tool call. Never throws: a missing or
 * non-string required argument is `unsupported`, not a crash — the gate must
 * still emit a decision (`gate.ts`'s one absolute rule).
 */
export function classifyToolCall(
  name: string,
  args: Record<string, unknown>,
  workspace: string,
): ToolClass {
  switch (name) {
    case 'run_command': {
      const commandLine = stringArg(args, 'CommandLine')
      if (commandLine === null) return unsupported(GENERIC_UNSUPPORTED_REASON)
      const cwd = canonicalize(stringArg(args, 'Cwd') ?? workspace)
      const writeTargets = redirectionTargets(commandLine, workspace).map((t) => canonicalize(t))
      return {
        kind: 'subject',
        subject: { verb: 'command', value: commandLine },
        read: [cwd],
        write: [cwd, ...writeTargets],
      }
    }
    case 'view_file':
      return readOnlySubject(args, workspace, 'AbsolutePath')
    case 'list_dir':
      return readOnlySubject(args, workspace, 'DirectoryPath')
    case 'find_by_name':
      return readOnlySubject(args, workspace, 'SearchDirectory')
    case 'grep_search':
      return readOnlySubject(args, workspace, 'SearchPath')
    case 'write_to_file':
      return writeOnlySubject(args, workspace, 'TargetFile')
    case 'replace_file_content':
      return readWriteSubject(args, workspace, 'TargetFile')
    case 'manage_task':
    case 'schedule':
      return { kind: 'control' }
    default:
      if (SUBAGENT_TOOLS.has(name)) return unsupported(SUBAGENT_REASON, true)
      return unsupported(GENERIC_UNSUPPORTED_REASON, false)
  }
}
