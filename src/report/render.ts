/**
 * Pure HTML renderers for `agy-worker-setup --report`
 * (docs/operations.md).
 *
 * Everything here is data in, one HTML document string out: no filesystem,
 * no `process`, no clock. `report.ts` is the only place that reads a job
 * directory or `usage.jsonl` and writes the result to disk — keeping the
 * split makes both halves golden-testable the way `trace/digest.ts` and
 * `policy/seatbelt.ts` already are.
 *
 * The one rule that matters more than any other in this file: nothing from a
 * job's own logs reaches the page without going through `redactText` first,
 * and nothing reaches the page without going through `layout.ts`'s escaping
 * primitives at the point it is written. This module never builds a `<tag>`
 * around a raw string itself — it hands plain, redacted values to `layout.ts`
 * and lets that module do the escaping, so there is exactly one place broken
 * escaping could hide.
 */

import type { Blocker, BrokerResult, EffectiveConfig, UsageRecord } from '../contract/types.js'
import { extractRequiredRule } from '../events/detect.js'
import type { DayTally, FailureRow, ModelTally, RuleTally, UsageRollup } from '../usage/read.js'
import {
  badge,
  type BadgeTone,
  cards,
  collapsible,
  esc,
  formatDuration,
  formatInstant,
  formatInteger,
  formatPercent,
  keyValueTable,
  plainList,
  preBlock,
  renderDocument,
  renderRedactionNotice,
  section,
  sortableTable,
  sparklineSvg,
  warningLine,
} from './layout.js'
import { redactText, type RedactOptions } from './redact.js'

/** Fixed left-to-right order for outcome columns, so two reports read the same way regardless of which outcomes happened to occur first. */
const OUTCOME_ORDER = [
  'verified_success',
  'success_unverified',
  'blocked',
  'failed',
  'timed_out',
  'canceled',
  'process_error',
  'orphaned',
]

function outcomeTone(outcome: string): BadgeTone {
  if (outcome === 'verified_success') return 'good'
  if (outcome === 'success_unverified') return 'default'
  return 'bad'
}

function orderedOutcomeKeys(present: Iterable<string>): string[] {
  const seen = new Set(present)
  const ordered = OUTCOME_ORDER.filter((o) => seen.has(o))
  const extra = [...seen].filter((o) => !OUTCOME_ORDER.includes(o)).sort()
  return [...ordered, ...extra]
}

/** Applies the report's one scrubbing pass. Every run-derived string flows through this before it reaches a layout primitive. */
function clean(text: string, redaction: RedactOptions): string {
  return redactText(text, redaction)
}

// ─────────────────────────────────────────────────────────────────────────────
// Project mode
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectReportInput {
  generatedAt: number
  /** Used only for the header's project name — shown as a basename, never the full path, since the full path is exactly the kind of thing this report exists to keep out of a bug report. */
  projectRoot: string
  redaction: RedactOptions
  /** From the same `readUsage` call the roll-up was built from. */
  read: { malformed: number; rotated: boolean }
  rollup: UsageRollup
  /** What the caller asked for, for the header line — not re-derived from the roll-up, since an empty window should still say what was requested. */
  request: { sinceMs: number | null; last: number }
}

function projectDisplayName(root: string): string {
  const parts = root.split('/').filter((p) => p.length > 0)
  return parts[parts.length - 1] ?? root
}

function overviewSection(input: ProjectReportInput): string {
  const { rollup, read } = input
  const outcomeBadges = orderedOutcomeKeys(Object.keys(rollup.outcomes))
    .map((key) => badge(`${key}: ${formatInteger(rollup.outcomes[key] ?? 0)}`, outcomeTone(key)))
    .join(' ')

  const versionList = Object.entries(rollup.agy_versions)
    .sort((a, b) => b[1] - a[1])
    .map(([version, count]) => `${esc(clean(version, input.redaction))} (${formatInteger(count)})`)
    .join(', ')

  const cacheShare = formatPercent(rollup.tokens.cache_read, rollup.tokens.total)

  const overviewCards = cards([
    { label: 'Jobs in window', value: formatInteger(rollup.jobs) },
    { label: 'Window start', value: formatInstant(rollup.window.from) },
    { label: 'Window end', value: formatInstant(rollup.window.to) },
    { label: 'Total tokens', value: formatInteger(rollup.tokens.total) },
    { label: 'Cache-read share', value: cacheShare },
    { label: 'Median duration', value: formatDuration(rollup.duration_ms.median) },
    { label: 'P90 duration', value: formatDuration(rollup.duration_ms.p90) },
  ])

  const requested =
    (input.request.sinceMs !== null ? `since ${formatInstant(input.request.sinceMs)}, ` : '') +
    `capped at the last ${formatInteger(input.request.last)} job${input.request.last === 1 ? '' : 's'}`

  const warnings: string[] = []
  if (read.malformed > 0) {
    warnings.push(
      `${formatInteger(read.malformed)} line${read.malformed === 1 ? '' : 's'} of usage.jsonl could not be parsed and were skipped — this window is short by that many jobs.`,
    )
  }
  if (read.rotated) {
    warnings.push('usage.jsonl has rotated at least once; the very oldest jobs for this project are no longer on disk.')
  }

  return section(
    'Overview',
    [
      `<p class="muted">Requested window: ${esc(clean(requested, input.redaction))}.</p>`,
      overviewCards,
      `<p>Outcomes: ${outcomeBadges || '<span class="muted">none</span>'}</p>`,
      `<p>agy versions seen: ${versionList.length > 0 ? versionList : '<span class="muted">none recorded</span>'}</p>`,
      ...warnings.map(warningLine),
    ].join('\n'),
  )
}

function deniedRulesSection(rules: RuleTally[], redaction: RedactOptions): string {
  const rows = rules.map((rule) => ({
    required_rule: clean(rule.required_rule, redaction),
    count: rule.count,
    jobs: rule.jobs,
    last_seen: formatInstant(rule.last_ts),
    last_job_id: rule.last_job_id,
    replay: `agy-worker-setup --report --job ${rule.last_job_id}`,
  }))

  return section(
    'Denied-rule table',
    sortableTable(
      'denied-rules',
      [
        { key: 'required_rule', label: 'Required rule' },
        { key: 'count', label: 'Times required', numeric: true },
        { key: 'jobs', label: 'Distinct jobs', numeric: true },
        { key: 'last_seen', label: 'Last seen' },
        { key: 'last_job_id', label: 'Last job' },
        { key: 'replay', label: 'Job report command' },
      ],
      rows,
      'No denials in this window.',
    ),
    'These are the same rule strings agy_ceiling reads when it proposes a permission ceiling — a rule that shows up here is a candidate to add there.',
  )
}

function modelsSection(models: ModelTally[], redaction: RedactOptions): string {
  const outcomeKeys = orderedOutcomeKeys(models.flatMap((m) => Object.keys(m.outcomes)))
  const columns = [
    { key: 'model', label: 'Model' },
    { key: 'effort', label: 'Effort' },
    { key: 'jobs', label: 'Jobs', numeric: true },
    ...outcomeKeys.map((key) => ({ key: `outcome_${key}`, label: key, numeric: true })),
    { key: 'total_tokens', label: 'Total tokens', numeric: true },
  ]
  const rows = models.map((model) => {
    const row: Record<string, string | number | null> = {
      model: clean(model.model, redaction),
      effort: model.effort ?? 'n/a',
      jobs: model.jobs,
      total_tokens: model.total_tokens,
    }
    for (const key of outcomeKeys) row[`outcome_${key}`] = model.outcomes[key] ?? 0
    return row
  })
  return section('Model × outcome', sortableTable('models', columns, rows, 'No jobs in this window.'))
}

function dailySection(byDay: DayTally[]): string {
  const days = byDay.map((d) => d.day)
  const jobCounts = byDay.map((d) => d.jobs)
  const tokenCounts = byDay.map((d) => d.total_tokens)
  return section(
    'Daily activity',
    sparklineSvg(days, jobCounts, tokenCounts, { primary: 'jobs/day', secondary: 'tokens/day' }),
  )
}

function failuresSection(failures: FailureRow[], redaction: RedactOptions): string {
  const rows = failures.map((f) => ({
    job_id: f.job_id,
    when: formatInstant(f.ts),
    outcome: f.outcome,
    profile: f.profile,
    model: f.model ?? 'n/a',
    remedy: f.remedy !== null ? clean(f.remedy, redaction) : 'not actionable — see the job report',
    replay: `agy-worker-setup --report --job ${f.job_id}`,
  }))
  return section(
    'Failures',
    sortableTable(
      'failures',
      [
        { key: 'job_id', label: 'Job' },
        { key: 'when', label: 'When' },
        { key: 'outcome', label: 'Outcome' },
        { key: 'profile', label: 'Profile' },
        { key: 'model', label: 'Model' },
        { key: 'remedy', label: 'Remedy' },
        { key: 'replay', label: 'Job report command' },
      ],
      rows,
      'No blocked or process_error jobs in this window.',
    ),
  )
}

export function renderProjectReport(input: ProjectReportInput): string {
  // The project's directory name is chosen by whoever created it on this
  // machine, not by an agy run — but a filesystem imposes no character
  // restrictions worth trusting, so it still goes through `esc()` here same
  // as everything else that ends up inside a tag.
  const title = `agy-worker report — ${projectDisplayName(input.projectRoot)}`
  const body = [
    `<h1>${esc(title)}</h1>`,
    `<p class="muted">Generated ${formatInstant(input.generatedAt)}.</p>`,
    renderRedactionNotice(input.redaction.level),
    overviewSection(input),
    deniedRulesSection(input.rollup.denied_rules, input.redaction),
    modelsSection(input.rollup.models, input.redaction),
    dailySection(input.rollup.by_day),
    failuresSection(input.rollup.failures, input.redaction),
    `<footer>agy-worker-mcp — local report, never transmitted.</footer>`,
  ].join('\n')
  return renderDocument(title, body)
}

// ─────────────────────────────────────────────────────────────────────────────
// Job mode
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedGateLogEntry {
  ts?: number
  step_idx?: number | null
  tool?: string
  command?: string | null
  decision?: string
  policy?: string
  reason?: string | null
}

/** Line-by-line, tolerant of a torn trailing write — same posture as `trace/digest.ts`'s own gate-log scan. */
function parseGateLog(text: string): ParsedGateLogEntry[] {
  const entries: ParsedGateLogEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      entries.push(JSON.parse(line) as ParsedGateLogEntry)
    } catch {
      // A malformed line is dropped from the table rather than the whole report — see missingFiles/notes for the count.
    }
  }
  return entries
}

export interface JobReportInput {
  generatedAt: number
  jobId: string
  redaction: RedactOptions
  includePrompt: boolean
  brokerResult: BrokerResult | null
  effectiveConfig: EffectiveConfig | null
  /** Enrichment only: `usage.jsonl`'s line for this job, when the project still has one. Supplies package/node/platform, which are not persisted anywhere inside the job directory itself. */
  usageRecord: UsageRecord | null
  /** From `state.json`, which the job directory always has while it exists; not one of §4's headline five files but the only place `gate_confirmed` lives. */
  gateConfirmed: boolean | null
  gateLogText: string | null
  /** Already formatted via `events/normalize.ts`'s `formatNormalized`, and already stripped of response text when `includePrompt` is false — `report.ts` does both so this module never has to know the raw event shape. */
  normalizedLogLines: string[]
  stderrText: string | null
  /** `request.json`'s prompt, only ever populated when `includePrompt` was passed. */
  promptText: string | null
  /** Expected files that were not found in the job directory, exactly as named on disk. */
  missingFiles: string[]
}

function verdictSection(input: JobReportInput): string {
  const result = input.brokerResult
  if (!result) {
    return section(
      'Verdict',
      `<p class="muted">No broker-result.json for this job — it may still be running, or the job directory has aged out.</p>`,
    )
  }
  const summary = result.broker_summary
  // The one disagreement worth a visual flag: agy claiming SUCCESS while the
  // broker's own checks say the contract was violated is exactly the gap the
  // README's first principle exists for — agy's self-report is not evidence.
  const statusesDiffer = result.contract_status === 'violated' && result.agent_status === 'SUCCESS'
  const contractLine = `${result.contract_status} (agent self-report: ${result.agent_status})`
  const verify = result.verification.verify

  const rows: Array<[string, string | number | null]> = [
    ['Headline', clean(summary.headline, input.redaction)],
    ['Outcome', summary.outcome],
    ['Contract vs agent status', contractLine],
    ['Exit code', summary.exit_code],
    ['Gate confirmed', input.gateConfirmed === null ? 'n/a (no tool call ran)' : input.gateConfirmed ? 'yes' : 'no — gate never loaded'],
    ['Duration', formatDuration(summary.duration_ms)],
    ['Tokens', result.agent_report.usage ? formatInteger(result.agent_report.usage.total_tokens) : 'n/a'],
    ['Verify', verify ? `${verify.exit_code === 0 && !verify.timed_out ? 'passed' : 'failed'} (exit ${verify.exit_code})` : 'not requested'],
  ]

  const warning = statusesDiffer
    ? warningLine(
        "agy reported SUCCESS but the broker's own checks say the contract was violated — agy's self-report is not evidence; read outcome and contract_status from the broker.",
      )
    : ''

  return section('Verdict', [keyValueTable(rows), warning].filter((s) => s.length > 0).join('\n'))
}

function blockerTone(blocker: Blocker): BadgeTone {
  return blocker.blocks_outcome ? 'bad' : 'warn'
}

function blockersSection(input: JobReportInput): string {
  const blockers = input.brokerResult?.verification.blockers ?? []
  if (blockers.length === 0) {
    return section('Blockers', `<p class="muted">None recorded.</p>`)
  }
  const items = blockers.map((b) => {
    const remedy = b.remedy !== null ? clean(b.remedy, input.redaction) : 'nothing a different agy_start can fix'
    const message = clean(b.message, input.redaction)
    const actionableBadge = badge(b.actionable ? 'actionable' : 'not actionable', b.actionable ? 'good' : 'default')
    const rowClass = b.actionable ? '' : ' class="not-actionable"'
    // `message` carries the broker's verbatim text where it has one (see
    // `Blocker.message`'s own comment) — exactly the kind of run-derived
    // string that must be escaped at the point it is written, not trusted
    // because it already went through `clean()`.
    return `<li${rowClass}>${badge(b.source, blockerTone(b))} ${actionableBadge} — ${esc(message)}<br><span class="muted">remedy: ${esc(remedy)}</span></li>`
  })
  return section(
    'Blockers',
    `<ul class="plain">${items.join('\n')}</ul>`,
    '"not actionable" means no different agy_start argument can lift this one — the reader\'s next move is a human change (a wider ceiling, a different tool), not a retry.',
  )
}

function gateLogSection(input: JobReportInput): string {
  if (input.gateLogText === null) {
    return section('Gate-log table', `<p class="muted">gate-log.jsonl was not found for this job.</p>`)
  }
  const entries = parseGateLog(input.gateLogText)
  const rows = entries.map((e) => ({
    step: e.step_idx ?? null,
    tool: e.tool ? clean(e.tool, input.redaction) : 'n/a',
    command: e.command ? clean(e.command, input.redaction) : '',
    decision: e.decision ?? 'n/a',
    stage: e.policy ?? 'n/a',
    matched_rule: e.reason ? clean(extractRequiredRule(e.reason) ?? '', input.redaction) : '',
  }))
  return section(
    'Gate-log table',
    sortableTable(
      'gate-log',
      [
        { key: 'step', label: 'Step', numeric: true },
        { key: 'tool', label: 'Tool' },
        { key: 'command', label: 'Command' },
        { key: 'decision', label: 'Decision' },
        { key: 'stage', label: 'Policy stage' },
        { key: 'matched_rule', label: 'Matched rule' },
      ],
      rows,
      'gate-log.jsonl was empty.',
    ),
    'Every line is here, allows included — a parser bug tends to show up in what got through, not just in what was refused.',
  )
}

function timelineSection(input: JobReportInput): string {
  if (input.normalizedLogLines.length === 0) {
    return section('Timeline', `<p class="muted">No events recorded for this job.</p>`)
  }
  return section(
    'Timeline',
    collapsible(`${input.normalizedLogLines.length} normalized log lines`, preBlock(input.normalizedLogLines.join('\n'))),
  )
}

function workspaceSection(input: JobReportInput): string {
  const result = input.brokerResult
  if (!result) {
    return section('Changed files and workspace', `<p class="muted">No broker-result.json for this job.</p>`)
  }
  const workspace = result.workspace
  const changedFiles = result.verification.changed_files.map((f) => clean(f, input.redaction))
  const workspaceRows: Array<[string, string | number | null]> = [
    ['Kind', workspace.kind],
    ['Branch', workspace.branch ?? 'n/a'],
    ['Base commit', workspace.base_commit ?? 'n/a'],
    ['Head commit', workspace.head_commit ?? 'n/a'],
    ['Changed file count', workspace.changed_file_count],
  ]
  return section(
    'Changed files and workspace',
    [keyValueTable(workspaceRows), `<h3>Changed files</h3>`, plainList(changedFiles, 'No files changed.')].join('\n'),
  )
}

function environmentSection(input: JobReportInput): string {
  const config = input.effectiveConfig
  const usage = input.usageRecord
  const profile = input.brokerResult?.profile ?? config?.profile ?? null
  const rows: Array<[string, string | number | null]> = [
    ['agy version', config?.agy_version ?? usage?.env.agy ?? 'unknown'],
    ['Package version', usage?.env.pkg ?? 'not recorded for this job (usage.jsonl has aged out)'],
    ['Node version', usage?.env.node ?? 'not recorded for this job (usage.jsonl has aged out)'],
    ['Platform', usage?.env.platform ?? 'not recorded for this job (usage.jsonl has aged out)'],
    ['Profile', profile ?? 'unknown'],
    ['Sandbox', config?.policy.sandbox ?? usage?.sandbox ?? 'unknown'],
  ]
  const allow = (config?.policy.allow ?? []).map((r) => clean(r, input.redaction))
  const deny = (config?.policy.deny ?? []).map((r) => clean(r, input.redaction))
  return section(
    'Environment',
    [
      keyValueTable(rows),
      config
        ? [
            `<h3>Effective allow rules</h3>`,
            plainList(allow, 'none'),
            `<h3>Effective deny rules</h3>`,
            plainList(deny, 'none'),
          ].join('\n')
        : `<p class="muted">effective-config.json was not found for this job.</p>`,
    ].join('\n'),
  )
}

function rawSection(input: JobReportInput): string {
  const parts: string[] = []
  parts.push(
    collapsible(
      'Normalized log (full)',
      input.normalizedLogLines.length > 0 ? preBlock(input.normalizedLogLines.join('\n')) : '<p class="muted">empty</p>',
    ),
  )
  parts.push(
    collapsible(
      'stderr.log',
      input.stderrText !== null ? preBlock(clean(input.stderrText, input.redaction)) : '<p class="muted">not found</p>',
    ),
  )
  parts.push(
    collapsible(
      'effective-config.json',
      input.effectiveConfig
        ? preBlock(clean(JSON.stringify(input.effectiveConfig, null, 2), input.redaction))
        : '<p class="muted">not found</p>',
    ),
  )
  if (input.includePrompt) {
    parts.push(
      collapsible(
        'Prompt (request.json)',
        input.promptText !== null ? preBlock(clean(input.promptText, input.redaction)) : '<p class="muted">not found</p>',
      ),
    )
  }
  return section('Raw', parts.join('\n'))
}

export function renderJobReport(input: JobReportInput): string {
  const title = `agy-worker report — job ${input.jobId}`
  const missingLine =
    input.missingFiles.length > 0
      ? warningLine(
          `Not found in the job directory: ${input.missingFiles.map((f) => clean(f, input.redaction)).join(', ')}. A job directory older than seven days is deleted on a normal schedule — this is expected, not an error.`,
        )
      : ''
  const promptExcludedLine = !input.includePrompt
    ? `<p class="muted">Prompt and full agent response text are excluded — rerun with --include-prompt to include them.</p>`
    : ''

  const body = [
    `<h1>${esc(title)}</h1>`,
    `<p class="muted">Generated ${formatInstant(input.generatedAt)}.</p>`,
    renderRedactionNotice(input.redaction.level),
    missingLine,
    promptExcludedLine,
    verdictSection(input),
    blockersSection(input),
    gateLogSection(input),
    timelineSection(input),
    workspaceSection(input),
    environmentSection(input),
    rawSection(input),
    `<footer>agy-worker-mcp — local report, never transmitted.</footer>`,
  ]
    .filter((s) => s.length > 0)
    .join('\n')
  return renderDocument(title, body)
}
