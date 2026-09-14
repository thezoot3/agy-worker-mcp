/**
 * `agy-worker-setup --report` — the only place in `src/report/` that touches
 * a filesystem or a clock (docs/operations.md).
 * Everything that decides *what* the page says lives in the pure renderers
 * (`render.ts`); this file only decides *which files to read* and *where the
 * result goes*.
 *
 * Why a CLI and not an MCP tool: an MCP reply is capped by
 * `max_response_bytes` and no client renders HTML anyway. Writing a file and
 * printing its path is the only shape that makes sense here.
 */

import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

import { jobPaths, projectPaths, readJsonIfExists, resolveProjectRoot, type ProjectPaths } from '../contract/paths.js'
import type { BrokerResult, EffectiveConfig, JobStateFile, UsageRecord } from '../contract/types.js'
import { parseEventLines } from '../events/parse.js'
import { formatNormalized, normalizeParsed } from '../events/normalize.js'
import { readUsage, rollUp } from '../usage/read.js'
import { renderJobReport, renderProjectReport } from './render.js'
import type { RedactOptions } from './redact.js'

export interface ReportOptions {
  mode: 'project' | 'job'
  jobId: string | null
  /** Resolved epoch-ms cutoff from `--since`, or null when it was not given. */
  sinceMs: number | null
  /** Project-mode cap. Always set — defaults to 100 — even though job mode ignores it. */
  last: number
  /** Explicit `--out`, resolved against `cwd` at run time; null means use the computed default. */
  out: string | null
  open: boolean
  includePrompt: boolean
  redact: 'default' | 'strict'
  cwd: string
}

export type ParsedReportArgs = { kind: 'error'; message: string } | { kind: 'report'; options: ReportOptions }

const SINCE_PATTERN = /^(\d+)(m|h|d)$/

/**
 * A job id is `<base36 ms>-<8 hex>` (`newJobId`, `src/contract/paths.ts`), and
 * it is spliced into a directory path and into the default output filename.
 * Anything outside this shape is a typo, and left unchecked a `..` in it walks
 * `jobPaths` out of the jobs directory and reports on whatever happens to sit
 * there — a nonsense report instead of the "no such job" line the caller
 * needs.
 */
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]+$/

/** `30m`, `12h`, `7d` → an epoch-ms cutoff relative to `now`. Anything else is rejected outright. */
function parseSince(value: string, now: number): number | null {
  const match = SINCE_PATTERN.exec(value)
  if (!match) return null
  const amount = Number(match[1])
  const unitMs = match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 86_400_000
  return now - amount * unitMs
}

/**
 * Parses everything after `--report`. Kept separate from `setup/install.ts`'s
 * own flag loop because that loop's vocabulary (`--scope`, `--client`, …) and
 * this one's (`--job`, `--since`, …) share no flags and mixing them into one
 * loop would make each mode's errors bleed into the other's.
 */
export function parseReportArgs(
  argv: string[],
  cwd: string = process.cwd(),
  now: number = Date.now(),
): ParsedReportArgs {
  let jobId: string | null = null
  let lastExplicit: number | null = null
  let sinceMs: number | null = null
  let out: string | null = null
  let open = false
  let includePrompt = false
  let redact: 'default' | 'strict' = 'default'

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--report') continue // the dispatch flag itself; harmless wherever it appears

    if (a === '--job') {
      const v = argv[++i]
      if (!v) return { kind: 'error', message: '--job needs a job id' }
      jobId = v
    } else if (a.startsWith('--job=')) {
      jobId = a.slice('--job='.length)
    } else if (a === '--last' || a.startsWith('--last=')) {
      const v = a === '--last' ? argv[++i] : a.slice('--last='.length)
      const n = v ? Number(v) : NaN
      if (!Number.isInteger(n) || n <= 0) {
        return { kind: 'error', message: `--last must be a positive integer (got ${v ?? 'nothing'})` }
      }
      lastExplicit = n
    } else if (a === '--since' || a.startsWith('--since=')) {
      const v = a === '--since' ? argv[++i] : a.slice('--since='.length)
      const resolved = v ? parseSince(v, now) : null
      if (resolved === null) {
        return { kind: 'error', message: `--since must look like <N>m, <N>h, or <N>d (got ${v ?? 'nothing'})` }
      }
      sinceMs = resolved
    } else if (a === '--out') {
      const v = argv[++i]
      if (!v) return { kind: 'error', message: '--out needs a path' }
      out = v
    } else if (a.startsWith('--out=')) {
      out = a.slice('--out='.length)
    } else if (a === '--open') {
      open = true
    } else if (a === '--include-prompt') {
      includePrompt = true
    } else if (a === '--redact' || a.startsWith('--redact=')) {
      const v = a === '--redact' ? argv[++i] : a.slice('--redact='.length)
      if (v !== 'default' && v !== 'strict') {
        return { kind: 'error', message: `--redact must be default or strict (got ${v ?? 'nothing'})` }
      }
      redact = v
    } else {
      return { kind: 'error', message: `unknown argument: ${a}` }
    }
  }

  if (jobId !== null && (lastExplicit !== null || sinceMs !== null)) {
    return { kind: 'error', message: '--job cannot be combined with --last or --since' }
  }

  if (jobId !== null && !JOB_ID_PATTERN.test(jobId)) {
    return { kind: 'error', message: `--job must be a job id (letters, digits, dash, underscore); got '${jobId}'` }
  }

  return {
    kind: 'report',
    options: {
      mode: jobId !== null ? 'job' : 'project',
      jobId,
      sinceMs,
      last: lastExplicit ?? 100,
      out,
      open,
      includePrompt,
      redact,
      cwd,
    },
  }
}

export interface ReportRunResult {
  ok: boolean
  /** Success: the absolute path written, one line, newline-terminated — meant for stdout. Failure: a message meant for stderr. */
  text: string
  outPath?: string
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** `YYYYMMDD-HHmm` in local time, since the default filename is for the person who just ran the command. */
function defaultProjectOutPath(cwd: string, generatedAt: number): string {
  const d = new Date(generatedAt)
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`
  return resolve(cwd, `agy-worker-report-${stamp}.html`)
}

function defaultJobOutPath(cwd: string, jobId: string): string {
  return resolve(cwd, `agy-worker-report-${jobId}.html`)
}

/** Reports are a local snapshot, not a shared log — 0600 matches the rest of this package's on-disk state. */
function writeReportFile(path: string, html: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, html, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // best-effort, matching writeFileAtomic's own posture elsewhere in the package
  }
}

/**
 * Best-effort only (§4): a report that generated correctly is not a failure
 * just because there was nothing to hand it to on this machine.
 */
function maybeOpen(open: boolean, path: string): void {
  if (!open) return
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null
  if (!command) return
  try {
    const child = spawn(command, [path], { detached: true, stdio: 'ignore' })
    child.unref()
    child.on('error', () => {
      // Nothing to do — the report is already on disk regardless of whether a viewer opened it.
    })
  } catch {
    // Same posture: opening is a courtesy, not part of the contract.
  }
}

/** The one line `usage.jsonl` can still contribute for a job whose own directory is missing package/node/platform. */
function findUsageRecord(paths: ProjectPaths, jobId: string): UsageRecord | null {
  const { records } = readUsage(paths)
  return records.find((r) => r.job_id === jobId) ?? null
}

function runProjectReport(
  options: ReportOptions,
  paths: ProjectPaths,
  redaction: RedactOptions,
  generatedAt: number,
): ReportRunResult {
  const read = readUsage(paths, { since: options.sinceMs ?? undefined, limit: options.last })
  const rollup = rollUp(read.records)

  const html = renderProjectReport({
    generatedAt,
    projectRoot: paths.root,
    redaction,
    read: { malformed: read.malformed, rotated: read.rotated },
    rollup,
    request: { sinceMs: options.sinceMs, last: options.last },
  })

  const outPath = options.out ? resolve(options.cwd, options.out) : defaultProjectOutPath(options.cwd, generatedAt)
  writeReportFile(outPath, html)
  maybeOpen(options.open, outPath)
  return { ok: true, text: `${outPath}\n`, outPath }
}

function runJobReport(
  options: ReportOptions,
  paths: ProjectPaths,
  redaction: RedactOptions,
  generatedAt: number,
): ReportRunResult {
  const jobId = options.jobId as string
  const jobDirPaths = jobPaths(paths, jobId)

  if (!existsSync(jobDirPaths.dir)) {
    return {
      ok: false,
      text: `agy-worker-setup --report: no job directory for '${jobId}' under ${paths.jobsDir} — a job directory older than seven days is deleted on a normal schedule\n`,
    }
  }

  const missingFiles: string[] = []

  const brokerResult = readJsonIfExists<BrokerResult>(jobDirPaths.brokerResult)
  if (brokerResult === null) missingFiles.push('broker-result.json')

  const effectiveConfig = readJsonIfExists<EffectiveConfig>(jobDirPaths.effectiveConfig)
  if (effectiveConfig === null) missingFiles.push('effective-config.json')

  const state = readJsonIfExists<JobStateFile>(jobDirPaths.state)
  const gateConfirmed = state?.gate_confirmed ?? null

  const gateLogText = existsSync(jobDirPaths.gateLog) ? readFileSync(jobDirPaths.gateLog, 'utf8') : null
  if (gateLogText === null) missingFiles.push('gate-log.jsonl')

  const stderrText = existsSync(jobDirPaths.stderr) ? readFileSync(jobDirPaths.stderr, 'utf8') : null
  if (stderrText === null) missingFiles.push('stderr.log')

  let normalizedLogLines: string[] = []
  if (existsSync(jobDirPaths.events)) {
    const lines = readFileSync(jobDirPaths.events, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
    const normalized = normalizeParsed(parseEventLines(lines))
    // Excluding response text is the report's job, not the shared normalizer's
    // — `formatNormalized` has no idea `--include-prompt` exists.
    normalizedLogLines = normalized
      .map((event) =>
        event.kind === 'final_response' && !options.includePrompt
          ? { ...event, text: '[response text omitted — rerun with --include-prompt to include it]' }
          : event,
      )
      .map(formatNormalized)
  } else {
    missingFiles.push('events.ndjson')
  }

  let promptText: string | null = null
  if (options.includePrompt) {
    if (existsSync(jobDirPaths.request)) {
      const request = readJsonIfExists<{ prompt?: unknown }>(jobDirPaths.request)
      promptText = request && typeof request.prompt === 'string' ? request.prompt : null
    } else {
      missingFiles.push('request.json')
    }
  }

  const usageRecord = findUsageRecord(paths, jobId)

  const html = renderJobReport({
    generatedAt,
    jobId,
    redaction,
    includePrompt: options.includePrompt,
    brokerResult,
    effectiveConfig,
    usageRecord,
    gateConfirmed,
    gateLogText,
    normalizedLogLines,
    stderrText,
    promptText,
    missingFiles,
  })

  const outPath = options.out ? resolve(options.cwd, options.out) : defaultJobOutPath(options.cwd, jobId)
  writeReportFile(outPath, html)
  maybeOpen(options.open, outPath)
  return { ok: true, text: `${outPath}\n`, outPath }
}

/**
 * Resolves the project, reads whatever L1/L2 data exists, renders, and
 * writes. The project directory itself not existing yet is not a failure —
 * an empty `UsageRollup` renders a valid report that says the window is
 * empty (see `renderProjectReport`); only a genuine failure to resolve a
 * project root, or a `--job` id with no matching directory, exits non-zero.
 */
export function runReport(options: ReportOptions): ReportRunResult {
  let root: string
  try {
    root = resolveProjectRoot(options.cwd).root
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, text: `agy-worker-setup --report: could not resolve a project root: ${message}\n` }
  }

  const paths = projectPaths(root)
  const redaction: RedactOptions = { level: options.redact, home: homedir(), workspace: root }
  const generatedAt = Date.now()

  return options.mode === 'job'
    ? runJobReport(options, paths, redaction, generatedAt)
    : runProjectReport(options, paths, redaction, generatedAt)
}
