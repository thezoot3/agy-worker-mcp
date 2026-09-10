import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { packageRoot } from '../contract/paths.js'

/**
 * What `agy-worker-setup` copies and where. Pure planning + one copy step, so
 * a test can run it against temp directories.
 */
export interface SetupOptions {
  /** `project` → `<cwd>/.claude`, `user` → `~/.claude`, or an explicit `.claude` directory. */
  scope: 'project' | 'user'
  /** Working directory for `project` scope. */
  cwd: string
  /** Print the plan, copy nothing. */
  dryRun: boolean
  /** Overwrite files that already exist (default: skip and say so). */
  force: boolean
  /** Explicit destination `.claude` directory; overrides scope. */
  dest?: string
  /** Where the package's `skills/` and `commands/` live; defaults to the installed package root. */
  source?: string
}

export interface SetupItem {
  kind: 'skill' | 'command'
  name: string
  from: string
  to: string
  action: 'copied' | 'skipped_exists' | 'overwritten' | 'missing_source' | 'planned'
}

export interface SetupReport {
  ok: boolean
  dest: string
  items: SetupItem[]
  text: string
}

/** The pieces shipped with the package. Add here when a new skill or command lands. */
export const SETUP_ITEMS: ReadonlyArray<{ kind: 'skill' | 'command'; name: string; rel: string; destRel: string }> = [
  { kind: 'skill', name: 'agy-ceiling', rel: 'skills/agy-ceiling', destRel: 'skills/agy-ceiling' },
  { kind: 'command', name: 'agy-ceiling', rel: 'commands/agy-ceiling.md', destRel: 'commands/agy-ceiling.md' },
]

export function destinationDir(opts: Pick<SetupOptions, 'scope' | 'cwd' | 'dest'>): string {
  if (opts.dest) return resolve(opts.dest)
  return opts.scope === 'user' ? join(homedir(), '.claude') : join(resolve(opts.cwd), '.claude')
}

export function install(opts: SetupOptions): SetupReport {
  const source = opts.source ?? packageRoot()
  const dest = destinationDir(opts)
  const items: SetupItem[] = []
  let ok = true

  for (const item of SETUP_ITEMS) {
    const from = join(source, item.rel)
    const to = join(dest, item.destRel)
    if (!existsSync(from)) {
      items.push({ kind: item.kind, name: item.name, from, to, action: 'missing_source' })
      ok = false
      continue
    }
    const exists = existsSync(to)
    if (opts.dryRun) {
      items.push({ kind: item.kind, name: item.name, from, to, action: 'planned' })
      continue
    }
    if (exists && !opts.force) {
      items.push({ kind: item.kind, name: item.name, from, to, action: 'skipped_exists' })
      continue
    }
    mkdirSync(join(to, '..'), { recursive: true })
    cpSync(from, to, { recursive: statSync(from).isDirectory(), force: true })
    items.push({ kind: item.kind, name: item.name, from, to, action: exists ? 'overwritten' : 'copied' })
  }

  const version = readVersion(source)
  const lines = [
    `agy-worker-mcp ${version} — Claude Code pieces → ${dest}${opts.dryRun ? ' (dry run)' : ''}`,
    ...items.map((i) => `  ${i.action.padEnd(15)} ${i.kind.padEnd(7)} ${i.name.padEnd(12)} ${i.to}`),
    '',
    'Register the MCP server (once per project, or --scope user):',
    '  claude mcp add agy --scope project -- agy-worker-mcp',
    '',
    'Then in Claude Code: /agy-ceiling  (draft this project\'s permission ceiling; written only after you approve)',
    '',
  ]
  return { ok, dest, items, text: lines.join('\n') }
}

function readVersion(source: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? '?'
  } catch {
    return '?'
  }
}

export type ParsedSetupArgs =
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'run'; options: SetupOptions }

export function parseSetupArgs(argv: string[], cwd: string = process.cwd()): ParsedSetupArgs {
  const options: SetupOptions = { scope: 'project', cwd, dryRun: false, force: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '-h' || a === '--help') return { kind: 'help' }
    if (a === '--dry-run') options.dryRun = true
    else if (a === '--force') options.force = true
    else if (a === '--scope') {
      const v = argv[++i]
      if (v !== 'project' && v !== 'user') return { kind: 'error', message: `--scope must be project or user (got ${v ?? 'nothing'})` }
      options.scope = v
    } else if (a.startsWith('--scope=')) {
      const v = a.slice('--scope='.length)
      if (v !== 'project' && v !== 'user') return { kind: 'error', message: `--scope must be project or user (got ${v})` }
      options.scope = v
    } else if (a === '--dest') {
      const v = argv[++i]
      if (!v) return { kind: 'error', message: '--dest needs a directory' }
      options.dest = v
    } else if (a.startsWith('--dest=')) options.dest = a.slice('--dest='.length)
    else return { kind: 'error', message: `unknown argument: ${a}` }
  }
  return { kind: 'run', options }
}

export function usage(): string {
  return [
    'usage: agy-worker-setup [--scope project|user] [--dest <.claude dir>] [--dry-run] [--force]',
    '',
    'Copies the agy-ceiling skill and the /agy-ceiling slash command into a .claude directory',
    '(project: ./.claude, user: ~/.claude). Existing files are left alone unless --force.',
    'Prints the `claude mcp add` line; it does not run it.',
    '',
  ].join('\n')
}
