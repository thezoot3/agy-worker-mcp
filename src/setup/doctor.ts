/**
 * `agy-worker-setup --doctor` diagnostic checks (`src/setup/doctor.ts`).
 *
 * Why this exists: Diagnosing silent startup failures in GUI environments (where
 * PATH is stripped by launchd) previously required manual inspection of Node paths,
 * launcher scripts, version matches, config files, and worktree structures.
 * Doctor runs structured diagnostic checks and prints clear fixes on failure.
 */

import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { packageRoot, projectPaths, resolveProjectRoot, stateHome } from '../contract/paths.js'
import { ceilingPath, loadCeiling } from '../policy/ceiling.js'
import { resolveAgyBin } from '../runner/spawn.js'

export interface DoctorCheck {
  id: string
  name: string
  ok: boolean
  message: string
  fix?: string
}

export interface DoctorReport {
  ok: boolean
  checks: DoctorCheck[]
  text: string
}

export interface DoctorOptions {
  cwd?: string
  homeDir?: string
  codexHomeDir?: string
  stateHomeDir?: string
  packageSource?: string
  env?: NodeJS.ProcessEnv
}

/**
 * Simulate the launcher's Node resolution under launchd-like PATH (/usr/bin:/bin).
 * Avoids spawning a child shell so doctor stays fast, sandbox-safe, and pure.
 */
export function simulateLaunchdNodeResolution(opts: {
  env?: NodeJS.ProcessEnv
  homeDir: string
  recordedNode?: string | null
}): string | null {
  const env = opts.env ?? process.env

  // 1. $AGY_WORKER_NODE override
  if (env.AGY_WORKER_NODE && isExecutable(env.AGY_WORKER_NODE)) {
    return env.AGY_WORKER_NODE
  }

  // 2. Recorded install-time Node path
  if (opts.recordedNode && isExecutable(opts.recordedNode)) {
    return opts.recordedNode
  }

  // 3. System /usr/bin:/bin
  for (const sysPath of ['/usr/bin/node', '/bin/node']) {
    if (isExecutable(sysPath)) return sysPath
  }

  // 4. fnm: newest first via directory names
  const fnmVersionsDir = join(opts.homeDir, '.local', 'share', 'fnm', 'node-versions')
  if (existsSync(fnmVersionsDir)) {
    try {
      const versions = readdirSync(fnmVersionsDir).sort()
      for (let i = versions.length - 1; i >= 0; i--) {
        const candidate = join(fnmVersionsDir, versions[i] as string, 'installation', 'bin', 'node')
        if (isExecutable(candidate)) return candidate
      }
    } catch {}
  }

  // 5. nvm: newest first via directory names
  const nvmVersionsDir = join(opts.homeDir, '.nvm', 'versions', 'node')
  if (existsSync(nvmVersionsDir)) {
    try {
      const versions = readdirSync(nvmVersionsDir).sort()
      for (let i = versions.length - 1; i >= 0; i--) {
        const candidate = join(nvmVersionsDir, versions[i] as string, 'bin', 'node')
        if (isExecutable(candidate)) return candidate
      }
    } catch {}
  }

  // 6. volta: newest first via directory names
  const voltaVersionsDir = join(opts.homeDir, '.volta', 'tools', 'image', 'node')
  if (existsSync(voltaVersionsDir)) {
    try {
      const versions = readdirSync(voltaVersionsDir).sort()
      for (let i = versions.length - 1; i >= 0; i--) {
        const candidate = join(voltaVersionsDir, versions[i] as string, 'bin', 'node')
        if (isExecutable(candidate)) return candidate
      }
    } catch {}
  }

  // 7. Homebrew and standard locations
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    if (isExecutable(candidate)) return candidate
  }

  return null
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Execute all doctor diagnostic checks and return structured results.
 */
export function doctor(options?: DoctorOptions): DoctorReport {
  const env = options?.env ?? process.env
  const homeDir = options?.homeDir ?? (env.HOME ? resolve(env.HOME) : homedir())
  const codexHomeDir =
    options?.codexHomeDir ??
    (env.CODEX_HOME && env.CODEX_HOME.trim() ? resolve(env.CODEX_HOME.trim()) : join(homeDir, '.codex'))
  const stateHomeDir =
    options?.stateHomeDir ??
    (env.AGY_WORKER_HOME && env.AGY_WORKER_HOME.trim() ? resolve(env.AGY_WORKER_HOME.trim()) : stateHome())
  const packageSource = options?.packageSource ?? packageRoot()
  const cwd = options?.cwd ? resolve(options.cwd) : process.cwd()

  const checks: DoctorCheck[] = []

  // Check 1: Launcher exists, is executable, recorded server exists
  const launcherPath = join(stateHomeDir, 'bin', 'agy-worker-mcp')
  let recordedNodeFromLauncher: string | null = null
  if (!existsSync(launcherPath)) {
    checks.push({
      id: 'launcher_exists',
      name: 'Launcher script',
      ok: false,
      message: `Launcher script not found at ${launcherPath}`,
      fix: 'Run agy-worker-setup to install the launcher',
    })
  } else if (!isExecutable(launcherPath)) {
    checks.push({
      id: 'launcher_exists',
      name: 'Launcher script',
      ok: false,
      message: `Launcher script at ${launcherPath} is not executable`,
      fix: `Run chmod +x ${launcherPath}`,
    })
  } else {
    try {
      const scriptContent = readFileSync(launcherPath, 'utf8')
      // The launcher single-quotes these (a path may contain `$`), and a
      // literal `'` inside one is written as the POSIX `'\''` escape.
      const unquote = (raw: string): string => raw.replaceAll(`'\\''`, "'")
      const serverMatch = scriptContent.match(/RECORDED_SERVER='((?:[^']|'\\'')*)'/)
      const nodeMatch = scriptContent.match(/RECORDED_NODE='((?:[^']|'\\'')*)'/)
      if (nodeMatch?.[1]) recordedNodeFromLauncher = unquote(nodeMatch[1])

      const recordedServer = serverMatch?.[1] ? unquote(serverMatch[1]) : null
      if (!recordedServer || !existsSync(recordedServer)) {
        checks.push({
          id: 'launcher_exists',
          name: 'Launcher script',
          ok: false,
          message: `Recorded server entry point not found: ${recordedServer ?? 'unknown'}`,
          fix: 'Run agy-worker-setup --force to regenerate the launcher with valid paths',
        })
      } else {
        checks.push({
          id: 'launcher_exists',
          name: 'Launcher script',
          ok: true,
          message: `Launcher exists at ${launcherPath} and server entry point exists (${recordedServer})`,
        })
      }
    } catch (err) {
      checks.push({
        id: 'launcher_exists',
        name: 'Launcher script',
        ok: false,
        message: `Failed to read launcher script: ${String(err)}`,
        fix: 'Run agy-worker-setup --force to reinstall the launcher',
      })
    }
  }

  // Check 2: Launcher version matches installed package version
  const versionPath = join(stateHomeDir, 'bin', '.launcher-version')
  let packageVersion = '?'
  try {
    const pkg = JSON.parse(readFileSync(join(packageSource, 'package.json'), 'utf8')) as { version?: string }
    packageVersion = pkg.version ?? '?'
  } catch {}

  if (!existsSync(versionPath)) {
    checks.push({
      id: 'launcher_version',
      name: 'Launcher version',
      ok: false,
      message: `Launcher version file missing at ${versionPath}`,
      fix: 'Run agy-worker-setup to update the launcher',
    })
  } else {
    const launcherVersion = readFileSync(versionPath, 'utf8').trim()
    if (launcherVersion !== packageVersion) {
      checks.push({
        id: 'launcher_version',
        name: 'Launcher version',
        ok: false,
        message: `Launcher version (${launcherVersion}) differs from package version (${packageVersion})`,
        fix: 'Run agy-worker-setup to update the launcher to the current package version',
      })
    } else {
      checks.push({
        id: 'launcher_version',
        name: 'Launcher version',
        ok: true,
        message: `Launcher version matches installed package version (${packageVersion})`,
      })
    }
  }

  // Check 3: Launcher resolves Node under launchd PATH (/usr/bin:/bin)
  const resolvedNodeUnderLaunchd = simulateLaunchdNodeResolution({
    env,
    homeDir,
    recordedNode: recordedNodeFromLauncher,
  })
  if (resolvedNodeUnderLaunchd) {
    checks.push({
      id: 'launcher_node_resolution',
      name: 'Launchd Node resolution',
      ok: true,
      message: `Resolves Node at ${resolvedNodeUnderLaunchd} under launchd PATH (/usr/bin:/bin)`,
    })
  } else {
    checks.push({
      id: 'launcher_node_resolution',
      name: 'Launchd Node resolution',
      ok: false,
      message: 'Launcher cannot resolve Node under launchd PATH (/usr/bin:/bin)',
      fix: 'Install Node in /opt/homebrew/bin or configure AGY_WORKER_NODE in ~/.agy-worker/bin/agy-worker-mcp',
    })
  }

  // Check 4: agy binary is resolvable; report its version
  try {
    const agyBin = resolveAgyBin(env)
    let agyVersion = ''
    try {
      agyVersion = execFileSync(agyBin, ['--version'], { encoding: 'utf8', timeout: 2000 }).trim()
    } catch {}
    checks.push({
      id: 'agy_binary',
      name: 'agy binary',
      ok: true,
      message: agyVersion ? `Resolved at ${agyBin} (version ${agyVersion})` : `Resolved at ${agyBin}`,
    })
  } catch (err) {
    checks.push({
      id: 'agy_binary',
      name: 'agy binary',
      ok: false,
      message: `agy binary could not be resolved (${(err as Error).message})`,
      fix: 'Install the Antigravity CLI (agy) into ~/.local/bin/agy or add it to PATH',
    })
  }

  // Check 5: MCP server registration in Claude / Codex config files (read-only)
  const registrations: string[] = []

  // Claude Code: check user ~/.claude.json and project .claude.json
  const claudeUserConfig = join(homeDir, '.claude.json')
  const claudeProjectConfig = join(cwd, '.claude.json')
  if (hasMcpRegistration(claudeUserConfig, 'agy')) registrations.push('Claude Code (user)')
  if (hasMcpRegistration(claudeProjectConfig, 'agy')) registrations.push('Claude Code (project)')

  // Codex: check user $CODEX_HOME/config.toml and project config.toml
  const codexUserConfig = join(codexHomeDir, 'config.toml')
  const codexProjectConfig = join(cwd, '.codex', 'config.toml')
  if (hasTomlMcpRegistration(codexUserConfig, 'agy')) registrations.push('Codex (user)')
  if (hasTomlMcpRegistration(codexProjectConfig, 'agy')) registrations.push('Codex (project)')

  if (registrations.length > 0) {
    checks.push({
      id: 'mcp_registration',
      name: 'MCP registration',
      ok: true,
      message: `Registered for: ${registrations.join(', ')}`,
    })
  } else {
    checks.push({
      id: 'mcp_registration',
      name: 'MCP registration',
      ok: false,
      message: "MCP server 'agy' is not registered in Claude Code or Codex configuration files",
      fix: `Register with: claude mcp add agy --scope user -- ${launcherPath} or add to ${codexUserConfig}`,
    })
  }

  // Check 6: Where skill and command are installed; flag project copy duplicating user copy
  const claudeUserSkill = existsSync(join(homeDir, '.claude', 'skills', 'agy-ceiling'))
  const claudeProjectSkill = existsSync(join(cwd, '.claude', 'skills', 'agy-ceiling'))
  const codexUserSkill = existsSync(join(codexHomeDir, 'skills', 'agy-ceiling'))
  const codexProjectSkill = existsSync(join(cwd, '.agents', 'skills', 'agy-ceiling'))

  const isDuplicate = (claudeUserSkill && claudeProjectSkill) || (codexUserSkill && codexProjectSkill)
  if (isDuplicate) {
    const dupes: string[] = []
    if (claudeUserSkill && claudeProjectSkill) dupes.push('.claude/skills/agy-ceiling duplicates ~/.claude')
    if (codexUserSkill && codexProjectSkill) dupes.push('.agents/skills/agy-ceiling duplicates $CODEX_HOME')
    checks.push({
      id: 'skills_and_commands',
      name: 'Skills and commands',
      ok: false,
      message: `Project-scope skill duplicates user-scope installation: ${dupes.join(', ')}`,
      fix: 'Remove the project-scope copy to prevent shadowing user configuration across worktrees',
    })
  } else if (!claudeUserSkill && !claudeProjectSkill && !codexUserSkill && !codexProjectSkill) {
    checks.push({
      id: 'skills_and_commands',
      name: 'Skills and commands',
      ok: false,
      message: "Skill 'agy-ceiling' is not installed in any client directory",
      fix: 'Run agy-worker-setup to install skills and commands',
    })
  } else {
    const locations: string[] = []
    if (claudeUserSkill) locations.push('Claude Code (user)')
    if (claudeProjectSkill) locations.push('Claude Code (project)')
    if (codexUserSkill) locations.push('Codex (user)')
    if (codexProjectSkill) locations.push('Codex (project)')
    checks.push({
      id: 'skills_and_commands',
      name: 'Skills and commands',
      ok: true,
      message: `Installed for: ${locations.join(', ')}`,
    })
  }

  // Check 7: Node's global prefix is not root-owned
  const nodePrefix =
    env.PREFIX ?? (resolvedNodeUnderLaunchd ? dirname(dirname(resolvedNodeUnderLaunchd)) : dirname(dirname(process.execPath)))
  try {
    const prefixStat = statSync(nodePrefix)
    if (prefixStat.uid === 0) {
      checks.push({
        id: 'node_global_prefix',
        name: 'Node global prefix',
        ok: false,
        message: `Node global prefix (${nodePrefix}) is root-owned (uid 0); npm -g requires sudo or fails with EACCES`,
        fix: `Change ownership with: sudo chown -R $(whoami) "${nodePrefix}" or use a Node version manager`,
      })
    } else {
      checks.push({
        id: 'node_global_prefix',
        name: 'Node global prefix',
        ok: true,
        message: `Node global prefix (${nodePrefix}) is user-owned (uid ${prefixStat.uid})`,
      })
    }
  } catch {
    checks.push({
      id: 'node_global_prefix',
      name: 'Node global prefix',
      ok: true,
      message: `Node global prefix (${nodePrefix}) could not be inspected`,
    })
  }

  // Check 8: Current project root, ceiling presence, and git worktree status
  try {
    const resolution = resolveProjectRoot(cwd)
    const pPaths = projectPaths(resolution.root)
    const cPath = ceilingPath(pPaths)
    const ceilingPresent = existsSync(cPath)

    // Check if current directory is a git worktree
    const gitFile = join(resolution.root, '.git')
    let isWorktree = false
    if (existsSync(gitFile)) {
      try {
        isWorktree = statSync(gitFile).isFile()
      } catch {}
    }

    if (ceilingPresent) {
      try {
        loadCeiling(pPaths)
        checks.push({
          id: 'project_root_and_worktree',
          name: 'Project and ceiling',
          ok: true,
          message: `Project root: ${resolution.root} (ceiling present, worktree: ${isWorktree ? 'yes' : 'no'})`,
        })
      } catch (err) {
        checks.push({
          id: 'project_root_and_worktree',
          name: 'Project and ceiling',
          ok: false,
          message: `Ceiling at ${cPath} has errors: ${String((err as Error).message ?? err)}`,
          fix: `Fix syntax errors in ${cPath} or delete it`,
        })
      }
    } else {
      checks.push({
        id: 'project_root_and_worktree',
        name: 'Project and ceiling',
        ok: true,
        message: `Project root: ${resolution.root} (no ceiling, worktree: ${isWorktree ? 'yes' : 'no'})`,
      })
    }
  } catch (err) {
    checks.push({
      id: 'project_root_and_worktree',
      name: 'Project and ceiling',
      ok: false,
      message: `Failed to resolve project root: ${String(err)}`,
      fix: 'Run agy-worker-setup inside a valid project or git repository',
    })
  }

  const ok = checks.every((c) => c.ok)
  const report: DoctorReport = {
    ok,
    checks,
    text: renderDoctorReport({ ok, checks }),
  }
  return report
}

function hasMcpRegistration(filePath: string, serverName: string): boolean {
  if (!existsSync(filePath)) return false
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8')) as {
      mcpServers?: Record<string, unknown>
    }
    return Boolean(data?.mcpServers && (data.mcpServers[serverName] || data.mcpServers[`${serverName}-mcp`]))
  } catch {
    return false
  }
}

function hasTomlMcpRegistration(filePath: string, serverName: string): boolean {
  if (!existsSync(filePath)) return false
  try {
    const content = readFileSync(filePath, 'utf8')
    const regex = new RegExp(`\\[mcp_servers\\.(?:${serverName}|${serverName}-mcp)\\]`)
    return regex.test(content)
  } catch {
    return false
  }
}

/**
 * Render structured doctor results into human-readable terminal output.
 */
export function renderDoctorReport(report: Pick<DoctorReport, 'ok' | 'checks'>): string {
  const lines: string[] = ['agy-worker-setup --doctor', '']
  for (const check of report.checks) {
    const badge = check.ok ? '[PASS]' : '[FAIL]'
    lines.push(`  ${badge} ${check.name.padEnd(24)} ${check.message}`)
    if (!check.ok && check.fix) {
      lines.push(`         Fix: ${check.fix}`)
    }
  }
  lines.push('')
  lines.push(report.ok ? 'All checks passed.' : 'Some checks failed; see fixes above.')
  lines.push('')
  return lines.join('\n')
}
