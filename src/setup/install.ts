/**
 * `agy-worker-setup` installer (`src/setup/install.ts`).
 *
 * Why this exists: Neither Claude Code nor Codex provides a package hook to copy
 * skills or slash commands into their configuration trees, and writing into user
 * directories during `npm install` (postinstall) is unsafe and rejected.
 * This setup command plans and executes the installation explicitly:
 * - Writes the stable spawn-time launcher to `<stateHome>/bin/agy-worker-mcp`
 * - Copies or symlinks skills and commands into Claude Code and Codex trees
 * - Prints client registration instructions without touching config files directly
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { packageRoot, stateHome } from '../contract/paths.js'
import { parseReportArgs, type ReportOptions } from '../report/report.js'
import { writeLauncher } from './launcher.js'
import type { DoctorOptions } from './doctor.js'

export interface SetupOptions {
  /** Target client: 'claude', 'codex', or 'all' (default: 'all'). */
  client?: 'claude' | 'codex' | 'all'
  /** Target scope: 'user' or 'project' (default: 'user'). */
  scope: 'project' | 'user'
  /** Symlink files instead of copying (default: false). */
  link?: boolean
  /** Working directory for `project` scope. */
  cwd: string
  /** Print the plan, copy/link nothing. */
  dryRun: boolean
  /** Overwrite files that already exist (default: skip and say so). */
  force: boolean
  /** Explicit destination `.claude` directory; overrides scope for Claude. */
  dest?: string
  /** Where the package's `skills/` and `commands/` live; defaults to the installed package root. */
  source?: string
  /** Target state directory for launcher script; defaults to stateHome(). */
  stateHomeDir?: string
}

export type SetupAction =
  | 'copied'
  | 'linked'
  | 'skipped_exists'
  | 'overwritten'
  | 'missing_source'
  | 'planned'

export interface SetupItem {
  client: 'claude' | 'codex'
  kind: 'skill' | 'command'
  name: string
  from: string
  to: string
  action: SetupAction
}

export interface SetupReport {
  ok: boolean
  dest: string
  launcherPath?: string
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

export function codexHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CODEX_HOME && env.CODEX_HOME.trim()) return resolve(env.CODEX_HOME.trim())
  const home = env.HOME ?? homedir()
  return join(home, '.codex')
}

/**
 * Detect which clients are targeted. When set to 'all' (default), inspects
 * which client configuration roots exist on disk. If neither exists, targets
 * both so a new install is complete.
 */
export function detectClients(
  opts: Pick<SetupOptions, 'client' | 'scope' | 'cwd' | 'dest'>,
  env: NodeJS.ProcessEnv = process.env,
): Array<'claude' | 'codex'> {
  if (opts.client === 'claude') return ['claude']
  if (opts.client === 'codex') return ['codex']

  const home = env.HOME ? resolve(env.HOME) : homedir()
  const cHome = env.CODEX_HOME && env.CODEX_HOME.trim() ? resolve(env.CODEX_HOME.trim()) : join(home, '.codex')

  // Explicit dest indicates an intentional Claude target
  if (opts.dest) return ['claude']

  const claudeDir = opts.scope === 'user' ? join(home, '.claude') : join(resolve(opts.cwd), '.claude')
  const codexDir = opts.scope === 'user' ? cHome : join(resolve(opts.cwd), '.agents')

  const hasClaude = existsSync(claudeDir)
  const hasCodex = existsSync(codexDir)

  if (hasClaude && hasCodex) return ['claude', 'codex']
  if (hasClaude) return ['claude']
  if (hasCodex) return ['codex']

  // If neither directory exists yet, target both so whichever client the user launches works
  return ['claude', 'codex']
}

interface ItemPlan {
  client: 'claude' | 'codex'
  kind: 'skill' | 'command'
  name: string
  from: string
  to: string
}

function planItems(opts: SetupOptions, source: string, clients: Array<'claude' | 'codex'>): ItemPlan[] {
  const plans: ItemPlan[] = []
  const cHome = codexHomeDir()

  for (const client of clients) {
    if (client === 'claude') {
      const dest = destinationDir(opts)
      plans.push({
        client: 'claude',
        kind: 'skill',
        name: 'agy-ceiling',
        from: join(source, 'skills', 'agy-ceiling'),
        to: join(dest, 'skills', 'agy-ceiling'),
      })
      plans.push({
        client: 'claude',
        kind: 'command',
        name: 'agy-ceiling',
        from: join(source, 'commands', 'agy-ceiling.md'),
        to: join(dest, 'commands', 'agy-ceiling.md'),
      })
    } else if (client === 'codex') {
      const skillTo =
        opts.scope === 'user'
          ? join(cHome, 'skills', 'agy-ceiling')
          : join(resolve(opts.cwd), '.agents', 'skills', 'agy-ceiling')
      const promptTo = join(cHome, 'prompts', 'agy-ceiling.md')

      plans.push({
        client: 'codex',
        kind: 'skill',
        name: 'agy-ceiling',
        from: join(source, 'skills', 'agy-ceiling'),
        to: skillTo,
      })
      plans.push({
        client: 'codex',
        kind: 'command',
        name: 'agy-ceiling',
        from: join(source, 'commands', 'agy-ceiling.md'),
        to: promptTo,
      })
    }
  }

  return plans
}

export function install(opts: SetupOptions): SetupReport {
  const source = opts.source ?? packageRoot()
  const dest = destinationDir(opts)
  const clients = detectClients(opts)
  const plans = planItems(opts, source, clients)

  const items: SetupItem[] = []
  let ok = true

  for (const plan of plans) {
    if (!existsSync(plan.from)) {
      items.push({ ...plan, action: 'missing_source' })
      ok = false
      continue
    }

    let exists = false
    try {
      lstatSync(plan.to)
      exists = true
    } catch {
      exists = false
    }

    if (opts.dryRun) {
      items.push({ ...plan, action: 'planned' })
      continue
    }

    if (exists && !opts.force) {
      items.push({ ...plan, action: 'skipped_exists' })
      continue
    }

    mkdirSync(dirname(plan.to), { recursive: true })

    if (opts.link) {
      if (exists) {
        rmSync(plan.to, { recursive: true, force: true })
      }
      symlinkSync(plan.from, plan.to)
      items.push({ ...plan, action: exists ? 'overwritten' : 'linked' })
    } else {
      if (exists) {
        rmSync(plan.to, { recursive: true, force: true })
      }
      cpSync(plan.from, plan.to, { recursive: statSync(plan.from).isDirectory(), force: true })
      items.push({ ...plan, action: exists ? 'overwritten' : 'copied' })
    }
  }

  const version = readVersion(source)

  // Write launcher and stamp version
  let launcherPath: string
  if (!opts.dryRun) {
    const launcherResult = writeLauncher({
      stateHomeDir: opts.stateHomeDir,
      version,
    })
    launcherPath = launcherResult.launcherPath
  } else {
    launcherPath = join(opts.stateHomeDir ?? stateHome(), 'bin', 'agy-worker-mcp')
  }

  const cConfigFile = join(codexHomeDir(), 'config.toml')
  const lines = [
    `agy-worker-mcp ${version} — Setup pieces${opts.dryRun ? ' (dry run)' : ''}`,
    `Launcher: ${launcherPath}${opts.dryRun ? ' (planned)' : ''}`,
    ...items.map((i) => `  ${i.action.padEnd(15)} ${i.client.padEnd(7)} ${i.kind.padEnd(7)} ${i.name.padEnd(12)} ${i.to}`),
    '',
    'Register the MCP server (once per project, or --scope user):',
    '  Claude Code:',
    `    claude mcp add agy --scope ${opts.scope} -- ${launcherPath}`,
    '',
    `  Codex (${cConfigFile}):`,
    '    [mcp_servers.agy]',
    `    command = "${launcherPath}"`,
    '',
    'Then in Claude Code or Codex: /agy-ceiling  (draft this project\'s permission ceiling; written only after you approve)',
    '',
  ]

  return { ok, dest, launcherPath, items, text: lines.join('\n') }
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
  | { kind: 'doctor'; options: DoctorOptions }
  | { kind: 'report'; options: ReportOptions }
  | { kind: 'run'; options: SetupOptions }

export function parseSetupArgs(argv: string[], cwd: string = process.cwd()): ParsedSetupArgs {
  // `-h`/`--help` wins outright, and `--report` opens a vocabulary
  // (`--job`, `--since`, …) this function's own flag loop below knows
  // nothing about — mixing the two loops would make report flags fail as
  // "unknown argument" and vice versa, so report parsing is delegated whole.
  if (argv.includes('-h') || argv.includes('--help')) return { kind: 'help' }
  if (argv.includes('--report')) {
    const parsed = parseReportArgs(argv, cwd)
    return parsed.kind === 'error' ? parsed : { kind: 'report', options: parsed.options }
  }

  let isDoctor = false
  const options: SetupOptions = { scope: 'user', client: 'all', link: false, cwd, dryRun: false, force: false }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '-h' || a === '--help') return { kind: 'help' }
    if (a === '--doctor') {
      isDoctor = true
      continue
    }
    if (a === '--dry-run') options.dryRun = true
    else if (a === '--force') options.force = true
    else if (a === '--link') options.link = true
    else if (a === '--scope') {
      const v = argv[++i]
      if (v !== 'project' && v !== 'user') {
        return { kind: 'error', message: `--scope must be project or user (got ${v ?? 'nothing'})` }
      }
      options.scope = v
    } else if (a.startsWith('--scope=')) {
      const v = a.slice('--scope='.length)
      if (v !== 'project' && v !== 'user') {
        return { kind: 'error', message: `--scope must be project or user (got ${v})` }
      }
      options.scope = v
    } else if (a === '--client') {
      const v = argv[++i]
      if (v !== 'claude' && v !== 'codex' && v !== 'all') {
        return { kind: 'error', message: `--client must be claude, codex, or all (got ${v ?? 'nothing'})` }
      }
      options.client = v
    } else if (a.startsWith('--client=')) {
      const v = a.slice('--client='.length)
      if (v !== 'claude' && v !== 'codex' && v !== 'all') {
        return { kind: 'error', message: `--client must be claude, codex, or all (got ${v})` }
      }
      options.client = v
    } else if (a === '--dest') {
      const v = argv[++i]
      if (!v) return { kind: 'error', message: '--dest needs a directory' }
      options.dest = v
    } else if (a.startsWith('--dest=')) {
      options.dest = a.slice('--dest='.length)
    } else {
      return { kind: 'error', message: `unknown argument: ${a}` }
    }
  }

  if (isDoctor) {
    return { kind: 'doctor', options: { cwd } }
  }

  return { kind: 'run', options }
}

export function usage(): string {
  return [
    'usage: agy-worker-setup [--scope project|user] [--client claude|codex|all] [--link] [--dest <dir>] [--doctor] [--dry-run] [--force]',
    '       agy-worker-setup --report [--job <id> | --last <N> | --since <30m|12h|7d>] [--out <path>] [--open] [--include-prompt] [--redact default|strict]',
    '',
    'Installs the spawn-time launcher to <stateHome>/bin/agy-worker-mcp, and copies or symlinks',
    'the agy-ceiling skill and slash command for Claude Code and Codex.',
    '',
    'Options:',
    '  --scope project|user   Scope of installed pieces (default: user)',
    '  --client claude|codex|all  Target client(s) (default: all, detecting existing directories)',
    '  --link                 Symlink instead of copying so package upgrades are reflected',
    '  --doctor               Run diagnostic health checks on launcher, Node, agy, and client configs',
    '  --dest <dir>           Explicit destination directory for Claude Code pieces',
    '  --dry-run              Show planned actions without writing anything',
    '  --force                Overwrite existing files instead of skipping',
    '',
    'Prints MCP server registration commands without modifying client config files.',
    '',
    '--report generates a self-contained HTML usage and debug report:',
    '  --job <id>             Job mode: one job\'s full bug-report bundle, in one HTML file',
    '  --last <N>             Project mode: cap the window to the last N jobs (default: 100)',
    '  --since <30m|12h|7d>   Project mode: only jobs at or after this long ago; combines with --last',
    '  --out <path>           Output path (default: ./agy-worker-report-<timestamp|job-id>.html)',
    '  --open                 Best-effort open in the OS default browser after writing',
    '  --include-prompt       Include the prompt and full agent response text (excluded by default)',
    '  --redact default|strict  Secret-scrubbing strength (default: default)',
    '',
  ].join('\n')
}
