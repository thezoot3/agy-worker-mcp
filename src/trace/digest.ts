import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { GATE_DENIAL_MARKER } from '../contract/types.js'
import { extractRequiredRule } from '../events/detect.js'

/**
 * Execution trace digest.
 *
 * Distills raw job logs (gate-log.jsonl, events.ndjson, broker-result.json)
 * into a compact, human-readable summary of commands, files touched,
 * gate denials, and tool errors. Pure functions, no I/O except the explicit
 * loader `loadJobDigest`.
 */

export interface DigestCommand {
  command: string
  count: number
  denied: number
}

export interface DigestFiles {
  read: string[]
  edited: string[]
  read_count: number
  edited_count: number
}

export interface DigestDenial {
  tool: string
  command: string | null
  stage: string
  required_rule: string | null
  count: number
}

export interface DigestToolError {
  step_idx: number | null
  tool: string
  message: string
}

export interface JobDigest {
  job_id: string
  outcome: string | null
  exit_code: number | null
  duration_ms: number | null
  turns: number | null
  commands: DigestCommand[]
  files: DigestFiles
  denials: DigestDenial[]
  tool_errors: DigestToolError[]
  trace: 'full' | 'no_gate_log' | 'empty'
}

export interface ProjectDigest {
  jobs: number
  outcomes: Record<string, number>
  denied_rules: Array<{ required_rule: string; count: number; last_job_id: string; last_ts: number }>
  top_commands: DigestCommand[]
}

/** Collapse runs of whitespace into a single space and trim. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Strip workspace prefix from a file path when contained under workspace. */
function toRelativePath(filePath: string, workspace: string | null): string {
  if (!workspace) return filePath
  const normalizedWs = workspace.replace(/\/+$/, '')
  const normalizedPath = filePath.replace(/\/+$/, '')
  if (normalizedPath === normalizedWs) return '.'
  const prefix = normalizedWs + '/'
  if (filePath.startsWith(prefix)) {
    return filePath.slice(prefix.length)
  }
  return filePath
}

/**
 * Extract target path from a tool's parameters.
 * Matches the file tools recognized across agy execution.
 */
function extractPathFromTool(tool: string, params: Record<string, unknown>): string | null {
  if (tool === 'view_file') {
    return typeof params.AbsolutePath === 'string' && params.AbsolutePath.length > 0 ? params.AbsolutePath : null
  }
  if (tool === 'grep_search') {
    return typeof params.SearchPath === 'string' && params.SearchPath.length > 0 ? params.SearchPath : null
  }
  if (tool === 'find_by_name') {
    return typeof params.SearchDirectory === 'string' && params.SearchDirectory.length > 0 ? params.SearchDirectory : null
  }
  if (tool === 'list_dir') {
    return typeof params.DirectoryPath === 'string' && params.DirectoryPath.length > 0 ? params.DirectoryPath : null
  }
  if (tool === 'write_to_file' || tool === 'replace_file_content') {
    return typeof params.TargetFile === 'string' && params.TargetFile.length > 0 ? params.TargetFile : null
  }
  return null
}

const READ_TOOLS = new Set(['view_file', 'grep_search', 'find_by_name', 'list_dir'])
const EDIT_TOOLS = new Set(['write_to_file', 'replace_file_content'])

/**
 * Pure digest computation over in-memory string captures.
 */
export function digestJob(input: {
  job_id: string
  workspace: string | null
  gateLog: string | null
  events: string | null
  brokerResult: unknown | null
}): JobDigest {
  const hasGateLog = typeof input.gateLog === 'string' && input.gateLog.trim().length > 0
  const hasEvents = typeof input.events === 'string' && input.events.trim().length > 0

  let trace: JobDigest['trace']
  if (!hasGateLog && !hasEvents) {
    trace = 'empty'
  } else if (!hasGateLog) {
    trace = 'no_gate_log'
  } else {
    trace = 'full'
  }

  let outcome: string | null = null
  let exit_code: number | null = null
  let duration_ms: number | null = null
  let turns: number | null = null

  if (input.brokerResult && typeof input.brokerResult === 'object') {
    const br = input.brokerResult as Record<string, unknown>
    if (br.broker_summary && typeof br.broker_summary === 'object') {
      const bs = br.broker_summary as Record<string, unknown>
      outcome = typeof bs.outcome === 'string' ? bs.outcome : null
      exit_code = typeof bs.exit_code === 'number' ? bs.exit_code : null
      duration_ms = typeof bs.duration_ms === 'number' ? bs.duration_ms : null
      if (bs.counts && typeof bs.counts === 'object') {
        const counts = bs.counts as Record<string, unknown>
        turns = typeof counts.turns === 'number' ? counts.turns : null
      }
    }
  }

  interface ParsedGateEntry {
    ts?: number
    job_id?: string
    step_idx?: number | null
    tool?: string
    command?: string | null
    decision?: string
    policy?: string
    reason?: string | null
  }

  const gateEntries: ParsedGateEntry[] = []
  const gateByStep = new Map<number, ParsedGateEntry>()

  if (hasGateLog && input.gateLog) {
    const lines = input.gateLog.trim().split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as ParsedGateEntry
        gateEntries.push(parsed)
        if (typeof parsed.step_idx === 'number') {
          gateByStep.set(parsed.step_idx, parsed)
        }
      } catch {
        // Skip malformed gate log lines
      }
    }
  }

  // 1. Commands
  const cmdMap = new Map<string, { command: string; count: number; denied: number }>()

  if (hasGateLog) {
    for (const entry of gateEntries) {
      if (entry.tool === 'run_command' && typeof entry.command === 'string') {
        const cmd = collapseWhitespace(entry.command)
        if (cmd.length === 0) continue
        let item = cmdMap.get(cmd)
        if (!item) {
          item = { command: cmd, count: 0, denied: 0 }
          cmdMap.set(cmd, item)
        }
        item.count++
        if (entry.decision === 'deny') {
          item.denied++
        }
      }
    }
  } else if (hasEvents && input.events) {
    // Fallback when gate log is absent: scan events for run_command invocations
    const seenCommandStepIndices = new Set<number>()
    const lines = input.events.trim().split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line) as Record<string, unknown>
        if (ev.event !== 'step_update' || !ev.step_update || typeof ev.step_update !== 'object') continue
        const su = ev.step_update as Record<string, unknown>
        if (su.step_type !== 'tool') continue

        const tool = typeof su.tool_name === 'string' ? su.tool_name : undefined
        if (tool !== 'run_command') continue

        const stepIdx = typeof su.step_index === 'number' ? su.step_index : null
        if (stepIdx !== null) {
          if (seenCommandStepIndices.has(stepIdx)) continue
          seenCommandStepIndices.add(stepIdx)
        }

        const toolInfo = su.tool_info as Record<string, unknown> | undefined
        const params = toolInfo?.parameters as Record<string, unknown> | undefined
        const rawCmd = params?.CommandLine
        if (typeof rawCmd === 'string') {
          const cmd = collapseWhitespace(rawCmd)
          if (cmd.length > 0) {
            let item = cmdMap.get(cmd)
            if (!item) {
              item = { command: cmd, count: 0, denied: 0 }
              cmdMap.set(cmd, item)
            }
            item.count++
          }
        }
      } catch {
        // Skip malformed event lines
      }
    }
  }

  const commands: DigestCommand[] = Array.from(cmdMap.values()).sort(
    (a, b) => b.count - a.count || a.command.localeCompare(b.command),
  )

  // 2. Denials
  const denialMap = new Map<string, DigestDenial>()
  if (hasGateLog) {
    for (const entry of gateEntries) {
      if (entry.decision === 'deny') {
        const tool = entry.tool ?? 'unknown'
        const command = typeof entry.command === 'string' ? collapseWhitespace(entry.command) : null
        const stage = entry.policy ?? 'unknown'
        const required_rule = extractRequiredRule(entry.reason ?? '')
        const key = `${tool}::${command ?? ''}::${stage}::${required_rule ?? ''}`
        let item = denialMap.get(key)
        if (!item) {
          item = { tool, command, stage, required_rule, count: 0 }
          denialMap.set(key, item)
        }
        item.count++
      }
    }
  }

  const denials: DigestDenial[] = Array.from(denialMap.values()).sort(
    (a, b) => b.count - a.count || a.tool.localeCompare(b.tool) || (a.command ?? '').localeCompare(b.command ?? ''),
  )

  // 3. Files and Tool Errors
  const readSet = new Set<string>()
  const editedSet = new Set<string>()
  const toolErrors: DigestToolError[] = []
  const seenFileStepIndices = new Set<number>()

  if (hasEvents && input.events) {
    const lines = input.events.trim().split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line) as Record<string, unknown>
        if (ev.event !== 'step_update' || !ev.step_update || typeof ev.step_update !== 'object') continue
        const su = ev.step_update as Record<string, unknown>
        if (su.step_type !== 'tool') continue

        const stepIdx = typeof su.step_index === 'number' ? su.step_index : null
        const toolInfo = su.tool_info as Record<string, unknown> | undefined
        const tool =
          typeof su.tool_name === 'string'
            ? su.tool_name
            : typeof toolInfo?.name === 'string'
              ? toolInfo.name
              : 'unknown'

        // Tool errors: state === 'ERROR' that are NOT gate denials
        if (su.state === 'ERROR') {
          const errorInfo = toolInfo?.error as Record<string, unknown> | undefined
          const msg = typeof errorInfo?.message === 'string' ? errorInfo.message : ''
          if (!msg.includes(GATE_DENIAL_MARKER)) {
            if (stepIdx === null || !toolErrors.some((e) => e.step_idx === stepIdx)) {
              toolErrors.push({
                step_idx: stepIdx,
                tool,
                message: msg,
              })
            }
          }
        }

        // Dedupe step updates for file accounting
        if (stepIdx !== null) {
          if (seenFileStepIndices.has(stepIdx)) continue
          seenFileStepIndices.add(stepIdx)
        }

        // Join to gate log: only count if decision was allow (or no gate row)
        const gateRow = stepIdx !== null ? gateByStep.get(stepIdx) : undefined
        if (gateRow && gateRow.decision !== 'allow') {
          continue
        }

        const params = (toolInfo?.parameters as Record<string, unknown> | undefined) ?? {}
        const targetPath = extractPathFromTool(tool, params)

        if (targetPath) {
          const rel = toRelativePath(targetPath, input.workspace)
          if (EDIT_TOOLS.has(tool)) {
            editedSet.add(rel)
          } else if (READ_TOOLS.has(tool)) {
            readSet.add(rel)
          }
        }
      } catch {
        // Skip malformed event lines
      }
    }
  }

  const read = Array.from(readSet).sort()
  const edited = Array.from(editedSet).sort()

  return {
    job_id: input.job_id,
    outcome,
    exit_code,
    duration_ms,
    turns,
    commands,
    files: {
      read,
      edited,
      read_count: read.length,
      edited_count: edited.length,
    },
    denials,
    tool_errors: toolErrors,
    trace,
  }
}

/**
 * Cross-job roll-up across multiple job digests and their gate logs.
 */
export function digestProject(
  digests: JobDigest[],
  gateLogsById: Record<string, string | null>,
): ProjectDigest {
  const outcomes: Record<string, number> = {}
  for (const d of digests) {
    if (d.outcome !== null) {
      outcomes[d.outcome] = (outcomes[d.outcome] ?? 0) + 1
    }
  }

  // Aggregate denied rules with last seen job_id and timestamp
  const ruleMap = new Map<string, { required_rule: string; count: number; last_job_id: string; last_ts: number }>()

  for (const [jobId, gateLog] of Object.entries(gateLogsById)) {
    if (!gateLog) continue
    const lines = gateLog.trim().split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        if (entry.decision !== 'deny') continue
        const reason = typeof entry.reason === 'string' ? entry.reason : ''
        const requiredRule = extractRequiredRule(reason)
        if (!requiredRule) continue

        const entryJobId = typeof entry.job_id === 'string' ? entry.job_id : jobId
        const entryTs = typeof entry.ts === 'number' ? entry.ts : 0

        const existing = ruleMap.get(requiredRule)
        if (!existing) {
          ruleMap.set(requiredRule, {
            required_rule: requiredRule,
            count: 1,
            last_job_id: entryJobId,
            last_ts: entryTs,
          })
        } else {
          existing.count++
          if (entryTs >= existing.last_ts) {
            existing.last_ts = entryTs
            existing.last_job_id = entryJobId
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  const denied_rules = Array.from(ruleMap.values()).sort(
    (a, b) => b.count - a.count || b.last_ts - a.last_ts || a.required_rule.localeCompare(b.required_rule),
  )

  // Top commands across jobs
  const commandMap = new Map<string, { command: string; count: number; denied: number }>()
  for (const d of digests) {
    for (const cmd of d.commands) {
      const existing = commandMap.get(cmd.command)
      if (!existing) {
        commandMap.set(cmd.command, { ...cmd })
      } else {
        existing.count += cmd.count
        existing.denied += cmd.denied
      }
    }
  }

  const top_commands = Array.from(commandMap.values())
    .sort((a, b) => b.count - a.count || a.command.localeCompare(b.command))
    .slice(0, 20)

  return {
    jobs: digests.length,
    outcomes,
    denied_rules,
    top_commands,
  }
}

/**
 * Load a job's files from its job directory and compute its digest.
 */
export function loadJobDigest(jobDir: string, workspace: string | null): JobDigest {
  const gateLogPath = join(jobDir, 'gate-log.jsonl')
  const eventsPath = join(jobDir, 'events.ndjson')
  const brokerResultPath = join(jobDir, 'broker-result.json')

  const gateLog = existsSync(gateLogPath) ? readFileSync(gateLogPath, 'utf8') : null
  const events = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : null
  let brokerResult: unknown | null = null
  if (existsSync(brokerResultPath)) {
    try {
      brokerResult = JSON.parse(readFileSync(brokerResultPath, 'utf8'))
    } catch {
      brokerResult = null
    }
  }

  let resolvedWorkspace = workspace
  if (!resolvedWorkspace) {
    if (
      brokerResult &&
      typeof brokerResult === 'object' &&
      'cwd' in brokerResult &&
      typeof brokerResult.cwd === 'string'
    ) {
      resolvedWorkspace = brokerResult.cwd
    } else {
      const requestPath = join(jobDir, 'request.json')
      if (existsSync(requestPath)) {
        try {
          const req = JSON.parse(readFileSync(requestPath, 'utf8')) as Record<string, unknown>
          if (typeof req.cwd === 'string') {
            resolvedWorkspace = req.cwd
          }
        } catch {
          // Ignore
        }
      }
    }
  }

  const jobId =
    brokerResult &&
    typeof brokerResult === 'object' &&
    'job_id' in brokerResult &&
    typeof brokerResult.job_id === 'string'
      ? brokerResult.job_id
      : basename(jobDir)

  return digestJob({
    job_id: jobId,
    workspace: resolvedWorkspace,
    gateLog,
    events,
    brokerResult,
  })
}

/** Format milliseconds into a readable duration (s or min). */
function formatDuration(ms: number | null): string {
  if (ms === null || ms < 0) return '?min'
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}min`
}

/** Truncate a single line to max characters, appending an ellipsis if truncated. */
function truncateLine(line: string, max = 200): string {
  if (line.length <= max) return line
  return line.slice(0, max - 1) + '…'
}

/** Format file list showing at most 8 items, collapsing the rest into `… +N more`. */
function formatFileList(paths: string[]): string {
  if (paths.length === 0) return 'none'
  const MAX_SHOWN = 8
  if (paths.length <= MAX_SHOWN) {
    return paths.join(', ')
  }
  const shown = paths.slice(0, MAX_SHOWN).join(', ')
  const remaining = paths.length - MAX_SHOWN
  return `${shown}, … +${remaining} more`
}

/**
 * Render a JobDigest into human-readable text layout under ~40 lines.
 */
export function renderDigest(d: JobDigest): string {
  const lines: string[] = []

  // Header line: job <id> · <outcome> · exit <code|?> · <duration> · <N> turn(s)
  const outcomeStr = d.outcome ?? 'unknown'
  const exitStr = d.exit_code !== null ? `exit ${d.exit_code}` : 'exit ?'
  const durStr = formatDuration(d.duration_ms)
  const turnsCount = d.turns ?? 0
  const turnsStr = `${turnsCount} turn${turnsCount === 1 ? '' : 's'}`
  lines.push(`job ${d.job_id} · ${outcomeStr} · ${exitStr} · ${durStr} · ${turnsStr}`)

  // Commands section
  const totalAllowed = d.commands.reduce((sum, c) => sum + (c.count - c.denied), 0)
  const totalDenied = d.commands.reduce((sum, c) => sum + c.denied, 0)
  lines.push(`commands (${totalAllowed} allowed, ${totalDenied} denied)`)

  const MAX_COMMANDS = 15
  const shownCommands = d.commands.slice(0, MAX_COMMANDS)
  for (const c of shownCommands) {
    const deniedStr = c.denied > 0 ? ` (${c.denied} denied)` : ''
    lines.push(`  ×${c.count}  ${c.command}${deniedStr}`)
  }
  if (d.commands.length > MAX_COMMANDS) {
    lines.push(`  … +${d.commands.length - MAX_COMMANDS} more`)
  }

  // Files section
  lines.push('files')
  lines.push(`  read ${d.files.read_count}: ${formatFileList(d.files.read)}`)
  lines.push(`  edited ${d.files.edited_count}: ${formatFileList(d.files.edited)}`)

  // Denials section
  if (d.denials.length === 0) {
    lines.push('denials 0')
  } else {
    const totalDenials = d.denials.reduce((sum, den) => sum + den.count, 0)
    lines.push(`denials ${totalDenials}`)
    for (const den of d.denials) {
      const cmdStr = den.command ? `: ${den.command}` : ''
      const ruleStr = den.required_rule ? ` [${den.required_rule}]` : ''
      lines.push(`  ×${den.count}  ${den.tool}${cmdStr}${ruleStr} (${den.stage})`)
    }
  }

  // Tool errors section
  if (d.tool_errors.length === 0) {
    lines.push('tool_errors 0')
  } else {
    lines.push(`tool_errors ${d.tool_errors.length}`)
    for (const err of d.tool_errors) {
      const stepStr = err.step_idx !== null ? `#${err.step_idx} ` : ''
      lines.push(`  ${stepStr}${err.tool}: ${err.message}`)
    }
  }

  return lines.map((l) => truncateLine(l, 200)).join('\n')
}
