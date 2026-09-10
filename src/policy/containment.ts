import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, parse as parsePath, resolve } from 'node:path'

import { assertContained, canonicalize, containedOrNull, isWithin, stateHome } from '../contract/paths.js'
import { ValidationError } from '../contract/errors.js'
import { isDeniedEnvVar, splitChainSegments, stripEnvPrefixTokens, tokenizeCommand } from './rules.js'

/**
 * Read/write root enforcement.
 *
 * The primitives live in `contract/paths.ts` (`canonicalize`, `isWithin`,
 * `assertContained`); this module is the policy layer that decides which roots a
 * job gets and pulls the paths out of a tool call.
 */

export interface ContainmentRoots {
  read: string[]
  write: string[]
}

/**
 * Roots for a job. Write is the workspace alone. Read may include a small set of
 * additional canonical directories, but never credential paths.
 */
export function buildRoots(workspace: string, extraRead?: string[]): ContainmentRoots {
  const canonicalWorkspace = canonicalize(workspace)
  const read = [canonicalWorkspace, ...(extraRead ?? []).map(canonicalize)]
  return { read, write: [canonicalWorkspace] }
}

/** @throws {import('../contract/errors.js').PathEscapeError} */
export function checkRead(path: string, roots: ContainmentRoots): string {
  return assertContained(path, roots.read, 'read')
}

/** @throws {import('../contract/errors.js').PathEscapeError} */
export function checkWrite(path: string, roots: ContainmentRoots): string {
  return assertContained(path, roots.write, 'write')
}

/** A bare, unquoted, absolute-looking token or NAME=/abs/path assignment inside a shell command line. */
export const ABS_PATH_TOKEN = /^(?:[A-Za-z_][A-Za-z0-9_]*=)?["']?(\/[^\s'"]*)["']?$/

/**
 * Allowed non-workspace read targets (special pseudo-devices).
 * Kept strictly to the standard dev sinks/sources documented in gate policy:
 * /dev/null, /dev/stdin, /dev/stdout, /dev/stderr.
 * All other paths outside workspace/read_roots are denied.
 */
export const ALLOWED_DEV_READS = new Set([
  '/dev/null',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
])

export function getCanonicalHome(): string {
  try {
    return canonicalize(homedir())
  } catch {
    return homedir()
  }
}

/**
 * Normalises a path token before containment:
 * - a leading `~/` or bare `~` is expanded to the real home directory;
 * - a glob (`*`, `?`, `[`) is cut back to its literal directory prefix
 *   (`src/*.ts` → `src`, `*.ts` → `.`, `dist/**​/x` → `dist`), because a shell
 *   glob can only ever expand inside the directory named before the first
 *   glob character — containing that directory contains every match.
 * Anything else (`$VAR`, backticks, a non-leading `~`) is left as is for
 * {@link hasUnexpandedChars} to reject.
 */
export function expandLeadingTilde(token: string): string {
  const home = getCanonicalHome()
  let t = token
  if (t === '~') t = home
  else if (t.startsWith('~/')) t = join(home, t.slice(2))
  const glob = t.search(/[*?[]/)
  if (glob !== -1) {
    const prefix = t.slice(0, glob)
    const slash = prefix.lastIndexOf('/')
    t = slash === -1 ? '.' : slash === 0 ? '/' : prefix.slice(0, slash)
  }
  return t
}

/**
 * True when a token still carries a shell expansion the gate cannot resolve:
 * `$VAR`/`$HOME`/`$(…)`, backticks, or a `~` that is not the leading one
 * (checked after {@link expandLeadingTilde}). Globs are not listed — they are
 * cut back to their literal directory by `expandLeadingTilde` instead.
 */
export function hasUnexpandedChars(token: string): boolean {
  return /[$`~]/.test(token)
}

/**
 * Tests whether a token looks like a path argument:
 * - absolute (starts with / or isAbsolute)
 * - starts with ~/ or is ~
 * - starts with ./ or ../
 * - contains /
 * - matches an existing file relative to the workspace
 */
export function isPathLike(token: string, workspace?: string): boolean {
  if (!token || token === '-' || token === '--') return false
  if (token.startsWith('-')) return false
  if (token === '~' || token.startsWith('~/')) return true
  if (isAbsolute(token) || token.startsWith('/')) return true
  if (token.startsWith('./') || token.startsWith('../')) return true
  if (token.includes('/')) return true
  if (workspace) {
    try {
      if (existsSync(resolve(workspace, token))) return true
    } catch {
      // ignore
    }
  }
  return false
}

export const MUTATION_COMMANDS = new Set([
  'rm',
  'mv',
  'cp',
  'touch',
  'mkdir',
  'install',
  'ln',
  'truncate',
  'rsync',
  'tee',
])

export const READ_UTILITIES = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'sed',
  'awk',
  'wc',
  'sort',
  'uniq',
  'cut',
  'diff',
  'cmp',
  'find',
  'od',
  'xxd',
  'hexdump',
  'strings',
])

function extractBasename(token: string): string {
  const idx = token.lastIndexOf('/')
  return idx === -1 ? token : token.slice(idx + 1)
}

function extractSedWriteTargets(tokens: string[]): string[] {
  const hasInPlace = tokens.some(
    (t) => t === '-i' || t.startsWith('-i') || t === '--in-place' || t.startsWith('--in-place='),
  )
  if (!hasInPlace) return []

  const targets: string[] = []
  let i = 1
  let hasScript = false
  while (i < tokens.length) {
    const token = tokens[i]!
    if (token === '--') {
      i++
      while (i < tokens.length) targets.push(tokens[i++]!)
      break
    }
    if (token === '-i') {
      i++
      if (i < tokens.length) {
        const next = tokens[i]!
        if (next === '' || /^\.[A-Za-z0-9_-]+$/.test(next)) {
          i++
        }
      }
      continue
    }
    if (token.startsWith('-i') || token.startsWith('--in-place')) {
      i++
      continue
    }
    if (token === '-e' || token === '--expression') {
      i += 2
      hasScript = true
      continue
    }
    if (token.startsWith('-e') || token.startsWith('--expression=')) {
      i++
      hasScript = true
      continue
    }
    if (token === '-f' || token === '--file') {
      i += 2
      hasScript = true
      continue
    }
    if (token.startsWith('-f') || token.startsWith('--file=')) {
      i++
      hasScript = true
      continue
    }
    if (token.startsWith('-')) {
      i++
      continue
    }
    if (!hasScript) {
      hasScript = true
      i++
      continue
    }
    targets.push(token)
    i++
  }
  return targets
}

function extractSortWriteTargets(tokens: string[]): string[] {
  const targets: string[] = []
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '-o' && i + 1 < tokens.length) {
      targets.push(tokens[++i]!)
    } else if (token.startsWith('-o') && token.length > 2) {
      targets.push(token.slice(2))
    } else if (token === '--output' && i + 1 < tokens.length) {
      targets.push(tokens[++i]!)
    } else if (token.startsWith('--output=')) {
      targets.push(token.slice('--output='.length))
    }
  }
  return targets
}

function extractTeeWriteTargets(tokens: string[]): string[] {
  const targets: string[] = []
  let afterDoubleDash = false
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!
    if (!afterDoubleDash) {
      if (token === '--') {
        afterDoubleDash = true
        continue
      }
      if (token.startsWith('-')) continue
    }
    targets.push(token)
  }
  return targets
}

function extractGitWriteTargets(tokens: string[], cwd?: string | null): string[] {
  const targets: string[] = []
  let subCmdIdx = 1
  while (subCmdIdx < tokens.length && tokens[subCmdIdx]!.startsWith('-')) {
    subCmdIdx++
  }
  if (subCmdIdx >= tokens.length) return []
  const subCmd = tokens[subCmdIdx]!
  const rest = tokens.slice(subCmdIdx + 1)

  if (subCmd === 'archive') {
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i]!
      if ((t === '-o' || t === '--output') && i + 1 < rest.length) {
        targets.push(rest[++i]!)
      } else if (t.startsWith('--output=')) {
        targets.push(t.slice('--output='.length))
      } else if (t.startsWith('-o') && t.length > 2) {
        targets.push(t.slice(2))
      }
    }
  } else if (subCmd === 'clone') {
    const positionals = rest.filter((t) => !t.startsWith('-'))
    if (positionals.length >= 2) {
      targets.push(positionals[1]!)
    } else if (positionals.length === 1) {
      const repoName = extractBasename(positionals[0]!).replace(/\.git$/, '')
      if (repoName) targets.push(repoName)
    }
  } else if (subCmd === 'init') {
    const positionals = rest.filter((t) => !t.startsWith('-'))
    if (positionals.length >= 1) {
      targets.push(positionals[0]!)
    } else if (cwd) {
      targets.push(cwd)
    }
  } else if (subCmd === 'worktree') {
    if (rest[0] === 'add') {
      const positionals = rest.slice(1).filter((t) => !t.startsWith('-'))
      if (positionals.length >= 1) {
        targets.push(positionals[0]!)
      }
    }
  }
  return targets
}

function extractDdWriteTargets(tokens: string[]): string[] {
  const targets: string[] = []
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.startsWith('of=')) {
      targets.push(t.slice(3))
    }
  }
  return targets
}

function extractTarWriteTargets(tokens: string[]): string[] {
  const targets: string[] = []
  const isExtract = tokens.some((t) => t.includes('x'))
  const isCreate = tokens.some((t) => t.includes('c'))

  if (isExtract) {
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i]!
      if ((t === '-C' || t === '--directory') && i + 1 < tokens.length) {
        targets.push(tokens[++i]!)
      } else if (t.startsWith('--directory=')) {
        targets.push(t.slice('--directory='.length))
      }
    }
  } else if (isCreate) {
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i]!
      if ((t === '-f' || t === '--file') && i + 1 < tokens.length) {
        targets.push(tokens[++i]!)
      } else if (t.startsWith('--file=')) {
        targets.push(t.slice('--file='.length))
      } else if (t.startsWith('-') && t.includes('f') && i + 1 < tokens.length) {
        targets.push(tokens[++i]!)
      }
    }
  }
  return targets
}

function extractUnzipWriteTargets(tokens: string[]): string[] {
  const targets: string[] = []
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '-d' && i + 1 < tokens.length) {
      targets.push(tokens[++i]!)
    }
  }
  return targets
}

function extractJavacWriteTargets(tokens: string[]): string[] {
  const targets: string[] = []
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '-d' && i + 1 < tokens.length) {
      targets.push(tokens[++i]!)
    }
  }
  return targets
}

function extractInstallWriteTargets(tokens: string[]): string[] {
  const positionals = tokens.slice(1).filter((t) => !t.startsWith('-'))
  const hasD = tokens.some((t) => t === '-d' || t === '--directory')
  if (hasD) return positionals
  const targetDirIdx = tokens.findIndex((t) => t === '-t' || t === '--target-directory')
  if (targetDirIdx !== -1 && targetDirIdx + 1 < tokens.length) {
    return [tokens[targetDirIdx + 1]!]
  }
  if (positionals.length >= 1) {
    return [positionals[positionals.length - 1]!]
  }
  return []
}

function extractLnWriteTargets(tokens: string[]): string[] {
  const positionals = tokens.slice(1).filter((t) => !t.startsWith('-'))
  const targetDirIdx = tokens.findIndex((t) => t === '-t' || t === '--target-directory')
  if (targetDirIdx !== -1 && targetDirIdx + 1 < tokens.length) {
    return [tokens[targetDirIdx + 1]!]
  }
  if (positionals.length >= 1) {
    return [positionals[positionals.length - 1]!]
  }
  return []
}

function extractTruncateWriteTargets(tokens: string[]): string[] {
  const targets: string[] = []
  let i = 1
  while (i < tokens.length) {
    const t = tokens[i]!
    if (t === '-s' || t === '--size') {
      i += 2
      continue
    }
    if (t.startsWith('-')) {
      i++
      continue
    }
    targets.push(t)
    i++
  }
  return targets
}

function extractRsyncWriteTargets(tokens: string[]): string[] {
  const positionals = tokens.slice(1).filter((t) => !t.startsWith('-'))
  if (positionals.length >= 2) {
    return [positionals[positionals.length - 1]!]
  }
  return []
}

/**
 * Extract target write paths for mutating commands.
 * Includes rm, mv, cp, touch, mkdir, sed -i, sort -o, tee, git archive/clone/init/worktree,
 * install, ln, truncate, dd of=, tar -C/-f, unzip -d, rsync, javac -d.
 * Recurses into bash -c / sh -c.
 */
export function commandMutationWritePaths(commandLine: string, cwd?: string | null): string[] {
  const segments = splitChainSegments(commandLine) ?? [commandLine]
  const writePaths: string[] = []

  for (const segment of segments) {
    const tokens = tokenizeCommand(segment)
    if (tokens.length === 0) continue

    const stripped = stripEnvPrefixTokens(tokens)
    if (stripped.remainingTokens.length === 0) continue

    const head = extractBasename(stripped.remainingTokens[0] as string)
    if (['bash', 'sh', 'zsh'].includes(head)) {
      const cIdx = stripped.remainingTokens.indexOf('-c')
      if (cIdx !== -1 && cIdx + 1 < stripped.remainingTokens.length) {
        writePaths.push(...commandMutationWritePaths(stripped.remainingTokens[cIdx + 1] as string, cwd))
      }
      continue
    }

    let rawTargets: string[] = []

    if (head === 'sed') {
      rawTargets = extractSedWriteTargets(stripped.remainingTokens)
    } else if (head === 'sort') {
      rawTargets = extractSortWriteTargets(stripped.remainingTokens)
    } else if (head === 'tee') {
      rawTargets = extractTeeWriteTargets(stripped.remainingTokens)
    } else if (head === 'git') {
      rawTargets = extractGitWriteTargets(stripped.remainingTokens, cwd)
    } else if (head === 'dd') {
      rawTargets = extractDdWriteTargets(stripped.remainingTokens)
    } else if (head === 'tar') {
      rawTargets = extractTarWriteTargets(stripped.remainingTokens)
    } else if (head === 'unzip') {
      rawTargets = extractUnzipWriteTargets(stripped.remainingTokens)
    } else if (head === 'javac') {
      rawTargets = extractJavacWriteTargets(stripped.remainingTokens)
    } else if (head === 'install') {
      rawTargets = extractInstallWriteTargets(stripped.remainingTokens)
    } else if (head === 'ln') {
      rawTargets = extractLnWriteTargets(stripped.remainingTokens)
    } else if (head === 'truncate') {
      rawTargets = extractTruncateWriteTargets(stripped.remainingTokens)
    } else if (head === 'rsync') {
      rawTargets = extractRsyncWriteTargets(stripped.remainingTokens)
    } else if (head === 'cp') {
      const positionals = stripped.remainingTokens.slice(1).filter((t) => !t.startsWith('-'))
      if (positionals.length >= 1) {
        rawTargets = [positionals[positionals.length - 1]!]
      }
    } else if (head === 'rm' || head === 'touch' || head === 'mkdir' || head === 'mv') {
      let afterDoubleDash = false
      for (let i = 1; i < stripped.remainingTokens.length; i++) {
        const token = stripped.remainingTokens[i] as string
        if (!token) continue
        if (!afterDoubleDash) {
          if (token === '--') {
            afterDoubleDash = true
            continue
          }
          if (token.startsWith('-')) {
            continue
          }
        }
        rawTargets.push(token)
      }
    }

    for (const raw of rawTargets) {
      if (hasUnexpandedChars(expandLeadingTilde(raw))) {
        writePaths.push(raw)
      } else {
        const exp = expandLeadingTilde(raw)
        if (isAbsolute(exp)) {
          writePaths.push(exp)
        } else if (cwd) {
          writePaths.push(resolve(cwd, exp))
        } else {
          writePaths.push(exp)
        }
      }
    }
  }

  return writePaths
}

function extractGrepReadPaths(tokens: string[]): string[] {
  const paths: string[] = []
  let hasPattern = false
  let i = 1
  while (i < tokens.length) {
    const t = tokens[i]!
    if (t === '--') {
      i++
      while (i < tokens.length) {
        if (!hasPattern) {
          hasPattern = true
        } else {
          paths.push(tokens[i]!)
        }
        i++
      }
      break
    }
    if (t === '-e' || t === '--regexp') {
      hasPattern = true
      i += 2
      continue
    }
    if (t.startsWith('-e') || t.startsWith('--regexp=')) {
      hasPattern = true
      i++
      continue
    }
    if (t === '-f' || t === '--file') {
      if (i + 1 < tokens.length) paths.push(tokens[i + 1]!)
      hasPattern = true
      i += 2
      continue
    }
    if (t.startsWith('-f') || t.startsWith('--file=')) {
      paths.push(t.startsWith('-f') ? t.slice(2) : t.slice('--file='.length))
      hasPattern = true
      i++
      continue
    }
    if (t.startsWith('-')) {
      i++
      continue
    }
    if (!hasPattern) {
      hasPattern = true
      i++
      continue
    }
    paths.push(t)
    i++
  }
  return paths
}

function extractFindReadPaths(tokens: string[]): string[] {
  const paths: string[] = []
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.startsWith('-') || t === '(' || t === '!' || t === ')') {
      break
    }
    paths.push(t)
  }
  return paths
}

function extractAwkReadPaths(tokens: string[]): string[] {
  const paths: string[] = []
  let hasProgram = false
  let i = 1
  while (i < tokens.length) {
    const t = tokens[i]!
    if (t === '-f') {
      if (i + 1 < tokens.length) paths.push(tokens[i + 1]!)
      hasProgram = true
      i += 2
      continue
    }
    if (t.startsWith('-f')) {
      paths.push(t.slice(2))
      hasProgram = true
      i++
      continue
    }
    if (t.startsWith('-')) {
      if ((t === '-F' || t === '-v') && i + 1 < tokens.length) i += 2
      else i++
      continue
    }
    if (!hasProgram) {
      hasProgram = true
      i++
      continue
    }
    paths.push(t)
    i++
  }
  return paths
}

function extractSedReadPaths(tokens: string[]): string[] {
  const hasInPlace = tokens.some(
    (t) => t === '-i' || t.startsWith('-i') || t === '--in-place' || t.startsWith('--in-place='),
  )
  if (hasInPlace) return []

  const paths: string[] = []
  let hasScript = false
  let i = 1
  while (i < tokens.length) {
    const t = tokens[i]!
    if (t === '--') {
      i++
      while (i < tokens.length) paths.push(tokens[i++]!)
      break
    }
    if (t === '-e' || t === '--expression') {
      hasScript = true
      i += 2
      continue
    }
    if (t.startsWith('-e') || t.startsWith('--expression=')) {
      hasScript = true
      i++
      continue
    }
    if (t === '-f' || t === '--file') {
      if (i + 1 < tokens.length) paths.push(tokens[i + 1]!)
      hasScript = true
      i += 2
      continue
    }
    if (t.startsWith('-f') || t.startsWith('--file=')) {
      paths.push(t.startsWith('-f') ? t.slice(2) : t.slice('--file='.length))
      hasScript = true
      i++
      continue
    }
    if (t.startsWith('-')) {
      i++
      continue
    }
    if (!hasScript) {
      hasScript = true
      i++
      continue
    }
    paths.push(t)
    i++
  }
  return paths
}

function extractGenericReadPaths(tokens: string[]): string[] {
  const paths: string[] = []
  let afterDoubleDash = false
  let i = 1
  while (i < tokens.length) {
    const t = tokens[i]!
    if (!afterDoubleDash) {
      if (t === '--') {
        afterDoubleDash = true
        i++
        continue
      }
      if (
        t === '-n' ||
        t === '-C' ||
        t === '-B' ||
        t === '-A' ||
        t === '-d' ||
        t === '-f' ||
        t === '-s' ||
        t === '-o' ||
        t === '--output'
      ) {
        i += 2
        continue
      }
      if (t.startsWith('-o') && t.length > 2) {
        i++
        continue
      }
      if (t.startsWith('--output=')) {
        i++
        continue
      }
      if (t.startsWith('-')) {
        i++
        continue
      }
    }
    paths.push(t)
    i++
  }
  return paths
}

function extractScriptReadPaths(head: string, tokens: string[]): string[] {
  if (head === 'python' || head === 'python3') {
    let i = 1
    while (i < tokens.length) {
      const t = tokens[i]!
      if (t === '-c' || t === '-m') return []
      if (t.startsWith('-c') || t.startsWith('-m')) return []
      if (t.startsWith('-')) {
        i++
        continue
      }
      return [t]
    }
  } else if (head === 'node') {
    let i = 1
    while (i < tokens.length) {
      const t = tokens[i]!
      if (t === '-e' || t === '--eval' || t === '-p' || t === '--print') return []
      if (t.startsWith('-')) {
        i++
        continue
      }
      return [t]
    }
  } else if (head === 'java') {
    const paths: string[] = []
    let i = 1
    while (i < tokens.length) {
      const t = tokens[i]!
      if (t === '-jar' && i + 1 < tokens.length) {
        paths.push(tokens[i + 1]!)
        return paths
      }
      if ((t === '-cp' || t === '-classpath' || t === '--class-path') && i + 1 < tokens.length) {
        i += 2
        continue
      }
      if (t.startsWith('-')) {
        i++
        continue
      }
      if (t.endsWith('.java') || t.endsWith('.jar') || t.includes('/')) {
        paths.push(t)
      }
      break
    }
    return paths
  }
  return []
}

export interface CommandContainmentAnalysis {
  writePaths: string[]
  readPaths: string[]
  unexpandedPath: string | null
  candidatePaths: string[]
}

/**
 * Full structural extraction of paths from a command line.
 * Extracts mutation targets, redirection targets, and read targets.
 * Detects unexpanded shell expansions and collects candidate paths for credential checks.
 */
export function extractCommandContainment(commandLine: string, workspace: string): CommandContainmentAnalysis {
  const segments = splitChainSegments(commandLine) ?? [commandLine]
  const writePaths: string[] = []
  const readPaths: string[] = []
  let unexpandedPath: string | null = null
  const candidatePaths: string[] = []

  const registerCandidate = (token: string): void => {
    if (hasUnexpandedChars(expandLeadingTilde(token))) {
      return
    }
    const exp = expandLeadingTilde(token)
    candidatePaths.push(isAbsolute(exp) ? resolve(exp) : resolve(workspace, exp))
  }

  for (const segment of segments) {
    const tokens = tokenizeCommand(segment)
    if (tokens.length === 0) continue

    const stripped = stripEnvPrefixTokens(tokens)
    if (stripped.remainingTokens.length === 0) continue

    const head = extractBasename(stripped.remainingTokens[0] as string)
    if (['bash', 'sh', 'zsh'].includes(head)) {
      const cIdx = stripped.remainingTokens.indexOf('-c')
      if (cIdx !== -1 && cIdx + 1 < stripped.remainingTokens.length) {
        const inner = extractCommandContainment(stripped.remainingTokens[cIdx + 1] as string, workspace)
        writePaths.push(...inner.writePaths)
        readPaths.push(...inner.readPaths)
        if (!unexpandedPath && inner.unexpandedPath) unexpandedPath = inner.unexpandedPath
        candidatePaths.push(...inner.candidatePaths)
      }
      continue
    }

    // 1. Redirections in this segment
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] as string
      const m = REDIRECT.exec(token)
      if (!m) continue

      const glued = token.slice(m[0].length)
      const target = glued.length > 0 ? glued : ((tokens[++i] as string | undefined) ?? '')
      if (target.length === 0 || NON_FILE_TARGET.test(target)) continue

      if (hasUnexpandedChars(expandLeadingTilde(target))) {
        if (!unexpandedPath) unexpandedPath = target
      } else {
        const exp = expandLeadingTilde(target)
        const resolved = isAbsolute(exp) ? resolve(exp) : resolve(workspace, exp)
        writePaths.push(resolved)
        candidatePaths.push(resolved)
      }
    }

    // 2. Mutation write targets
    const mutTargets = commandMutationWritePaths(segment, null)
    for (const raw of mutTargets) {
      if (hasUnexpandedChars(expandLeadingTilde(raw))) {
        if (!unexpandedPath) unexpandedPath = raw
      } else {
        const exp = expandLeadingTilde(raw)
        const resolved = isAbsolute(exp) ? resolve(exp) : resolve(workspace, exp)
        writePaths.push(resolved)
        candidatePaths.push(resolved)
      }
    }

    // 3. Read utility targets
    let rawReadCandidates: string[] = []
    if (READ_UTILITIES.has(head)) {
      if (head === 'grep' || head === 'egrep' || head === 'fgrep' || head === 'rg') {
        rawReadCandidates = extractGrepReadPaths(stripped.remainingTokens)
      } else if (head === 'find') {
        rawReadCandidates = extractFindReadPaths(stripped.remainingTokens)
      } else if (head === 'sed') {
        rawReadCandidates = extractSedReadPaths(stripped.remainingTokens)
      } else if (head === 'awk') {
        rawReadCandidates = extractAwkReadPaths(stripped.remainingTokens)
      } else {
        rawReadCandidates = extractGenericReadPaths(stripped.remainingTokens)
      }
    } else if (head === 'cp' || head === 'mv') {
      const positionals = stripped.remainingTokens.slice(1).filter((t) => !t.startsWith('-'))
      if (positionals.length >= 2) {
        rawReadCandidates = positionals.slice(0, -1)
      }
    } else if (head === 'python' || head === 'python3' || head === 'node' || head === 'java') {
      rawReadCandidates = extractScriptReadPaths(head, stripped.remainingTokens)
    }

    for (const cand of rawReadCandidates) {
      if (!cand || cand === '-' || cand === '--' || cand.startsWith('-')) continue
      if (hasUnexpandedChars(expandLeadingTilde(cand))) {
        if (!unexpandedPath) unexpandedPath = cand
      } else if (ALLOWED_DEV_READS.has(cand)) {
        readPaths.push(cand)
      } else {
        const exp = expandLeadingTilde(cand)
        const resolved = isAbsolute(exp) ? resolve(exp) : resolve(workspace, exp)
        readPaths.push(resolved)
        candidatePaths.push(resolved)
      }
    }

    // 4. Collect any path-looking arguments across any command for credential HARD_DENY
    for (let i = 1; i < stripped.remainingTokens.length; i++) {
      const t = stripped.remainingTokens[i]!
      if (!t) continue
      const eqIdx = t.indexOf('=')
      const val = eqIdx !== -1 && !t.startsWith('-') ? t.slice(eqIdx + 1) : t
      if (isPathLike(val, workspace)) {
        registerCandidate(val)
      }
    }
  }

  return {
    writePaths: Array.from(new Set(writePaths)),
    readPaths: Array.from(new Set(readPaths)),
    unexpandedPath,
    candidatePaths: Array.from(new Set(candidatePaths)),
  }
}

export function pathsFromToolCall(
  toolName: string,
  args: Record<string, unknown>,
): { read: string[]; write: string[] } {
  const read: string[] = []
  const write: string[] = []

  const cwd = typeof args.Cwd === 'string' ? args.Cwd : null
  if (cwd) {
    read.push(cwd)
    write.push(cwd)
  }

  if (toolName === 'run_command' && typeof args.CommandLine === 'string') {
    for (const token of args.CommandLine.split(/\s+/)) {
      const m = ABS_PATH_TOKEN.exec(token)
      if (m && m[1]) {
        const eqIdx = token.indexOf('=')
        if (eqIdx > 0) {
          const varName = token.slice(0, eqIdx)
          if (isDeniedEnvVar(varName)) {
            continue
          }
        }
        const parts = m[1].split(':')
        for (const p of parts) {
          if (p.startsWith('/') && !NON_FILE_TARGET.test(p)) {
            read.push(p)
          }
        }
      }
    }
    const mutTargets = commandMutationWritePaths(args.CommandLine, cwd)
    for (const p of mutTargets) {
      write.push(p)
    }
  }

  return { read, write }
}

/** `NAME=/abs/path` at the start of a command line (or after `env` / `export`). */
const ENV_ASSIGNMENT_PATH = /^([A-Za-z_][A-Za-z0-9_]*)=["']?(\/[^\s'"]*)["']?$/

export function assignmentReadPaths(commandLine: string): string[] {
  const out: string[] = []
  const tokens = commandLine.split(/\s+/)
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i] as string
    if (token === 'env' || token === 'export' || token === '-i' || token === '--ignore-environment') {
      i++
      continue
    }
    const m = ENV_ASSIGNMENT_PATH.exec(token)
    const plainAssignment = /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
    if (!plainAssignment) break
    i++
    if (!m || !m[1] || !m[2]) continue
    if (isDeniedEnvVar(m[1])) continue
    for (const part of m[2].split(':')) {
      if (part.startsWith('/') && !NON_FILE_TARGET.test(part)) out.push(part)
    }
  }
  return out
}

/** Non-throwing containment probe over both root sets. */
export function isContainedForKind(
  path: string,
  roots: ContainmentRoots,
  kind: 'read' | 'write',
): boolean {
  return containedOrNull(path, roots[kind]) !== null
}

/**
 * I6: `{workspace}/.agents/**` holds the
 * gate's own `hooks.json`, so it is write-protected even though it sits
 * *inside* the workspace and would otherwise pass ordinary containment.
 */
export function isAgentsPath(path: string, workspace: string): boolean {
  const agentsDir = canonicalize(join(canonicalize(workspace), '.agents'))
  return isWithin(canonicalize(path), agentsDir)
}

// ─────────────────────────────────────────────────────────────────────────────
// Shell redirection targets
// ─────────────────────────────────────────────────────────────────────────────

const REDIRECT = /^(?:&|\d+)?>{1,2}\|?/
const NON_FILE_TARGET = /^(?:&\d+|&-|\/dev\/(?:null|stdout|stderr|tty|fd\/\d+))$/

export function redirectionTargets(commandLine: string, workspace: string): string[] {
  const segments = splitChainSegments(commandLine) ?? [commandLine]
  const targets: string[] = []

  for (const segment of segments) {
    const tokens = tokenizeCommand(segment)
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] as string
      const m = REDIRECT.exec(token)
      if (!m) continue

      const glued = token.slice(m[0].length)
      const target = glued.length > 0 ? glued : ((tokens[++i] as string | undefined) ?? '')
      if (target.length === 0) continue
      if (NON_FILE_TARGET.test(target)) continue

      const exp = expandLeadingTilde(target)
      if (hasUnexpandedChars(exp)) {
        targets.push(target)
      } else {
        targets.push(isAbsolute(exp) ? exp : join(workspace, exp))
      }
    }
  }

  return targets
}

export function escapingRedirectTarget(commandLine: string, workspace: string): string | null {
  const roots = [canonicalize(workspace)]
  for (const target of redirectionTargets(commandLine, workspace)) {
    if (hasUnexpandedChars(expandLeadingTilde(target))) return target
    if (containedOrNull(target, roots) === null) return target
    if (isAgentsPath(target, workspace)) return target
  }
  return null
}

/**
 * Ceiling write_roots sanity.
 * If an effective write root is /, the home directory, contains ~/.agy-worker,
 * or contains the gate binary, refuse with ValidationError.
 */
export function validateWriteRoots(writeRoots: string[], gatePath?: string): void {
  const sHome = canonicalize(stateHome())
  const home = canonicalize(homedir())
  const gPath = gatePath ? canonicalize(gatePath) : null

  for (const root of writeRoots) {
    const cRoot = canonicalize(root)
    const rootOf = parsePath(cRoot).root
    if (cRoot === rootOf || cRoot === '/') {
      throw new ValidationError({
        field: 'write_roots',
        value: root,
        expected:
          'effective write root must not be root directory (/) — resolved from client working directory; set AGY_WORKER_PROJECT to the target project directory',
      })
    }
    if (cRoot === home) {
      throw new ValidationError({
        field: 'write_roots',
        value: root,
        expected:
          'effective write root must not be home directory — resolved from client working directory; set AGY_WORKER_PROJECT to the target project directory',
      })
    }
    if (cRoot === sHome || isWithin(sHome, cRoot)) {
      throw new ValidationError({
        field: 'write_roots',
        value: root,
        expected: 'effective write root must not contain state home (~/.agy-worker)',
      })
    }
    if (gPath && (cRoot === gPath || isWithin(gPath, cRoot))) {
      throw new ValidationError({
        field: 'write_roots',
        value: root,
        expected: 'effective write root must not contain gate binary',
      })
    }
  }
}

