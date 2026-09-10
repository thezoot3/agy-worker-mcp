import { ValidationError } from '../contract/errors.js'
import type { ParsedRule, RuleVerb } from '../contract/types.js'

/**
 * Permission rule strings, in agy's own vocabulary (§12):
 * `command(...)`, `read_file(...)`, `write_file(...)`, `fetch(...)`, `url(...)`,
 * `mcp(...)`, `browser(...)`. Matching is strict and non-regex by default;
 * `regex:` opts in. Wildcards `command(*)` and `read_file(/)` are recognized.
 */

export const RULE_VERBS: readonly RuleVerb[] = [
  'command',
  'read_file',
  'write_file',
  'fetch',
  'url',
  'mcp',
  'browser',
]

const REGEX_PREFIX = 'regex:'

/** @throws {import('../contract/errors.js').ValidationError} carrying `allowed_verbs`. */
export function parseRule(raw: string): ParsedRule {
  const trimmed = raw.trim()
  const openIdx = trimmed.indexOf('(')
  if (openIdx <= 0 || !trimmed.endsWith(')')) {
    throw new ValidationError({
      field: 'rule',
      value: raw,
      expected: 'a string shaped like verb(pattern)',
      allowed_verbs: [...RULE_VERBS],
    })
  }

  const verb = trimmed.slice(0, openIdx)
  if (!(RULE_VERBS as readonly string[]).includes(verb)) {
    throw new ValidationError({
      field: 'rule',
      value: raw,
      expected: `verb to be one of ${RULE_VERBS.join(', ')}`,
      allowed_verbs: [...RULE_VERBS],
    })
  }

  let pattern = trimmed.slice(openIdx + 1, -1)
  let regex = false
  if (pattern.startsWith(REGEX_PREFIX)) {
    regex = true
    pattern = pattern.slice(REGEX_PREFIX.length)
  }

  return { verb: verb as RuleVerb, pattern, regex, raw: trimmed }
}

/** Parses every rule; the first bad one throws, so a caller never gets a half set. */
export function parseRules(raws: string[]): ParsedRule[] {
  return raws.map(parseRule)
}

/** Same as {@link parseRules}, but a malformed entry is dropped instead of thrown. */
export function parseRulesLenient(raws: string[]): ParsedRule[] {
  const out: ParsedRule[] = []
  for (const raw of raws) {
    try {
      out.push(parseRule(raw))
    } catch {
      // Corrupted or hand-edited policy.json should degrade, not crash the gate.
    }
  }
  return out
}

/** What a rule is being matched against. */
export interface RuleSubject {
  verb: RuleVerb
  /** Command line, absolute path, or URL depending on the verb. */
  value: string
}

function escapeRegExpChar(c: string): string {
  return /[.+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c
}

/** `**` -> any depth, `*` -> one path segment / token, everything else literal. */
export function globToRegex(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*'
      i++
      continue
    }
    if (c === '*') {
      re += '[^/]*'
      continue
    }
    re += escapeRegExpChar(c)
  }
  return new RegExp(`^${re}$`)
}

/**
 * Environment variables that must never be assigned inline or via env/export.
 * Rationale:
 * - PATH: Binary resolution hijacking by prepending untrusted directories.
 * - LD_*, DYLD_*: Dynamic linker hijacking (preloading arbitrary shared libraries on Linux / macOS).
 * - NODE_OPTIONS: Node.js runtime flag / hook injection (e.g. --require, --inspect).
 * - BASH_ENV, ENV: Startup script execution on shell invocation.
 * - GIT_DIR, GIT_WORK_TREE: Redirects git repository / working tree outside the workspace.
 * - GIT_SSH, GIT_SSH_COMMAND: Arbitrary binary execution during git network operations.
 * - GIT_CONFIG*, GIT_EXEC_PATH: Git config override or custom hook/binary injection.
 * - PYTHONSTARTUP, PYTHONPATH: Arbitrary code execution or library hijacking at Python startup.
 * - PERL5OPT, RUBYOPT: Option/code injection at Perl/Ruby interpreter startup.
 * - JAVA_TOOL_OPTIONS, _JAVA_OPTIONS: JVM argument injection (e.g. -javaagent).
 */
export const DENIED_ENV_PATTERNS: readonly (string | RegExp)[] = [
  'PATH',
  /^LD_/,
  /^DYLD_/,
  'NODE_OPTIONS',
  'BASH_ENV',
  'ENV',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  /^GIT_CONFIG/,
  'GIT_EXEC_PATH',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PERL5OPT',
  'RUBYOPT',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
]

export function isDeniedEnvVar(name: string): boolean {
  return DENIED_ENV_PATTERNS.some((pat) =>
    typeof pat === 'string' ? pat === name : pat.test(name),
  )
}

function matchCommandTokens(patternTokens: string[], valueTokens: string[]): boolean {
  if (patternTokens.length === 0) return false
  if (valueTokens.length < patternTokens.length) return false
  for (let i = 0; i < patternTokens.length; i++) {
    const alternatives = (patternTokens[i] as string).split('|')
    if (!alternatives.includes(valueTokens[i] as string)) return false
  }
  return true
}

/**
 * `command(git status|log|diff)` means: first token exactly `git`, second token
 * one of `status|log|diff`, trailing tokens unconstrained. Extra pattern tokens
 * beyond the value's length never match (the value can't be too short).
 */
function matchCommandPattern(pattern: string, value: string): boolean {
  if (pattern === '*') return true
  const valueTokens = tokenizeCommand(value)
  if (valueTokens.length === 0) return false

  const envRes = stripEnvPrefixTokens(valueTokens)
  if (envRes.deniedVar !== null) return false
  if (envRes.isExport && envRes.remainingTokens.length === 0) return true
  let tokens = envRes.remainingTokens
  if (tokens.length === 0) return false

  const head = basename(tokens[0] as string)
  if (['bash', 'sh'].includes(head)) {
    const cIdx = tokens.findIndex((t, idx) => idx > 0 && isShellCFlag(t))
    if (cIdx !== -1 && cIdx + 1 < tokens.length) {
      return matchCommandPattern(pattern, tokens[cIdx + 1] as string)
    }
    let sIdx = 1
    while (sIdx < tokens.length && (tokens[sIdx] as string).startsWith('-')) sIdx++
    if (sIdx < tokens.length) {
      tokens = [tokens[sIdx] as string, ...tokens.slice(sIdx + 1)]
    }
  }

  const patternTokens = pattern.trim().split(/\s+/).filter(Boolean)
  return matchCommandTokens(patternTokens, tokens)
}

/** Recognize -c inside short flag clusters, e.g. -c, -lc, -ec, -xc, -lec */
export function isShellCFlag(token: string): boolean {
  return /^-[a-zA-Z0-9]*c[a-zA-Z0-9]*$/.test(token)
}

/** Check if head token contains backslash, $, quote, or non-ASCII */
export function headTokenIsObfuscated(token: string): boolean {
  return /[\\$'"]|[^\x00-\x7F]/.test(token)
}

/** Tokenizer that preserves quote characters in tokens for obfuscation detection */
export function tokenizeCommandRaw(cmd: string): string[] {
  const tokens: string[] = []
  let i = 0
  const n = cmd.length
  while (i < n) {
    while (i < n && /\s/.test(cmd[i] as string)) i++
    if (i >= n) break
    let token = ''
    let quote: "'" | '"' | null = null
    while (i < n) {
      const c = cmd[i] as string
      if (quote === null && /\s/.test(c)) break
      if (c === "'" || c === '"') {
        if (quote === null) quote = c
        else if (quote === c) quote = null
      }
      token += c
      i++
    }
    tokens.push(token)
  }
  return tokens
}

/** Check if rm invocation has both recursive and force flags */
export function isRmRfTokens(tokens: string[]): boolean {
  if (tokens.length === 0) return false
  if (basename(tokens[0] as string) !== 'rm') return false

  let hasRecursive = false
  let hasForce = false

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i] as string
    if (tok === '--') {
      break
    }
    if (tok === '--recursive') {
      hasRecursive = true
    } else if (tok === '--force') {
      hasForce = true
    } else if (tok.startsWith('-') && !tok.startsWith('--')) {
      const flags = tok.slice(1)
      if (flags.includes('r') || flags.includes('R')) {
        hasRecursive = true
      }
      if (flags.includes('f')) {
        hasForce = true
      }
    }
  }

  return hasRecursive && hasForce
}

/** Keys that must not be written to in git config */
export function isDeniedGitConfigKey(key: string): boolean {
  const k = key.toLowerCase()
  if (
    k === 'core.hookspath' ||
    k === 'core.sshcommand' ||
    k === 'core.pager' ||
    k === 'core.editor' ||
    k === 'core.gitproxy' ||
    k === 'core.askpass'
  ) {
    return true
  }
  if (
    k.startsWith('credential.') ||
    k.startsWith('alias.') ||
    k.startsWith('filter.') ||
    k.startsWith('url.') ||
    k.startsWith('http.')
  ) {
    return true
  }
  if (/^diff\..+\.command$/.test(k)) {
    return true
  }
  if (/^merge\..+\.driver$/.test(k)) {
    return true
  }
  if (/^remote\..+\.url$/.test(k)) {
    return true
  }
  return false
}

const GIT_CONFIG_READ_FLAGS = new Set([
  '-l',
  '--list',
  '--get',
  '--get-all',
  '--get-regexp',
  '--get-urlmatch',
  '--get-color',
  '--get-colorbool',
])

function isForbiddenGitGlobalOption(tok: string): boolean {
  if (tok === '-c' || tok.startsWith('-c=') || tok.startsWith('-c')) return true
  if (tok === '-C' || tok.startsWith('-C=') || tok.startsWith('-C')) return true
  if (tok === '--git-dir' || tok.startsWith('--git-dir=')) return true
  if (tok === '--work-tree' || tok.startsWith('--work-tree=')) return true
  if (tok === '--exec-path' || tok.startsWith('--exec-path=')) return true
  if (tok === '--namespace' || tok.startsWith('--namespace=')) return true
  if (tok === '--config-env' || tok.startsWith('--config-env=')) return true
  return false
}

/** Check if git command uses forbidden global options or writes to sensitive config keys */
export function checkGitSegment(tokens: string[]): { denied: boolean; reason?: string } {
  if (tokens.length === 0 || basename(tokens[0] as string) !== 'git') {
    return { denied: false }
  }

  let subIdx = -1
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i] as string
    if (isForbiddenGitGlobalOption(tok)) {
      return { denied: true, reason: 'git_global_option_denied' }
    }
    if (!tok.startsWith('-')) {
      subIdx = i
      break
    }
  }

  if (subIdx !== -1 && tokens[subIdx] === 'config') {
    const configTokens = tokens.slice(subIdx + 1)
    const isRead = configTokens.some((t) => GIT_CONFIG_READ_FLAGS.has(t) || t.startsWith('--get='))
    if (!isRead) {
      for (let j = 0; j < configTokens.length; j++) {
        const t = configTokens[j] as string
        if (t === '--file' || t === '-f') {
          j++
          continue
        }
        if (t.startsWith('-')) {
          continue
        }
        const key = t.includes('=') ? t.slice(0, t.indexOf('=')) : t
        if (isDeniedGitConfigKey(key)) {
          return { denied: true, reason: 'git_config_key_denied' }
        }
      }
    }
  }

  return { denied: false }
}

const FORBIDDEN_FIND_PREDICATES = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
])

export function isDeniedFindSegment(tokens: string[]): boolean {
  if (tokens.length === 0 || basename(tokens[0] as string) !== 'find') return false
  return tokens.some((t) => FORBIDDEN_FIND_PREDICATES.has(t))
}

export function extractXargsTarget(tokens: string[]): string[] | null {
  if (tokens.length === 0 || basename(tokens[0] as string) !== 'xargs') return null

  let i = 1
  while (i < tokens.length) {
    const tok = tokens[i] as string
    if (tok === '--') {
      i++
      break
    }
    if (!tok.startsWith('-')) {
      break
    }
    if (/^-[InLsPEda]$/.test(tok)) {
      i += 2
      continue
    }
    if (
      [
        '--max-args',
        '--max-lines',
        '--max-chars',
        '--max-procs',
        '--replace',
        '--eof',
        '--delimiter',
        '--arg-file',
      ].includes(tok)
    ) {
      i += 2
      continue
    }
    i++
  }

  if (i >= tokens.length) {
    return null
  }

  return tokens.slice(i)
}

function basename(token: string): string {
  const idx = token.lastIndexOf('/')
  return idx === -1 ? token : token.slice(idx + 1)
}

/** A minimal shell-aware tokenizer: `'...'`/`"..."` groups survive as one token, quotes stripped. */
export function tokenizeCommand(cmd: string): string[] {
  const tokens: string[] = []
  let i = 0
  const n = cmd.length
  while (i < n) {
    while (i < n && /\s/.test(cmd[i] as string)) i++
    if (i >= n) break
    let token = ''
    while (i < n && !/\s/.test(cmd[i] as string)) {
      const c = cmd[i] as string
      if (c === "'" || c === '"') {
        const quote = c
        i++
        while (i < n && cmd[i] !== quote) {
          token += cmd[i]
          i++
        }
        i++
      } else {
        token += c
        i++
      }
    }
    tokens.push(token)
  }
  return tokens
}

export interface EnvPrefixResult {
  assignments: { name: string; value: string }[]
  deniedVar: string | null
  isExport: boolean
  isAssignmentOnly: boolean
  remainingTokens: string[]
}

export function stripEnvPrefixTokens(tokens: string[]): EnvPrefixResult {
  const assignments: { name: string; value: string }[] = []
  let i = 0
  let isExport = false

  while (i < tokens.length) {
    const token = tokens[i] as string

    if (token === 'export') {
      isExport = true
      i++
      while (i < tokens.length) {
        const t = tokens[i] as string
        const eqIdx = t.indexOf('=')
        if (eqIdx > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.slice(0, eqIdx))) {
          assignments.push({ name: t.slice(0, eqIdx), value: t.slice(eqIdx + 1) })
          i++
        } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
          assignments.push({ name: t, value: '' })
          i++
        } else {
          break
        }
      }
      break
    }

    if (token === 'env') {
      i++
      if (i < tokens.length && (tokens[i] === '-i' || tokens[i] === '--ignore-environment')) {
        i++
      }
      while (i < tokens.length) {
        const t = tokens[i] as string
        const eqIdx = t.indexOf('=')
        if (eqIdx > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.slice(0, eqIdx))) {
          assignments.push({ name: t.slice(0, eqIdx), value: t.slice(eqIdx + 1) })
          i++
        } else {
          break
        }
      }
      break
    }

    const eqIdx = token.indexOf('=')
    if (eqIdx > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.slice(0, eqIdx))) {
      assignments.push({ name: token.slice(0, eqIdx), value: token.slice(eqIdx + 1) })
      i++
      continue
    }

    break
  }

  let deniedVar: string | null = null
  for (const a of assignments) {
    if (isDeniedEnvVar(a.name)) {
      deniedVar = a.name
      break
    }
  }

  const remainingTokens = tokens.slice(i)
  const isAssignmentOnly = remainingTokens.length === 0 && assignments.length > 0

  return {
    assignments,
    deniedVar,
    isExport,
    isAssignmentOnly,
    remainingTokens,
  }
}

/**
 * Split command line by delimiters `&&`, `||`, `;`, `|` outside quotes.
 * Returns `null` on syntax error (unbalanced quotes, heredoc `<<`).
 */
export function splitChainSegments(cmd: string): string[] | null {
  const segments: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let i = 0
  const n = cmd.length

  while (i < n) {
    const c = cmd[i] as string

    if (quote === '"' && c === '\\' && i + 1 < n) {
      current += c + (cmd[i + 1] as string)
      i += 2
      continue
    }

    if (c === "'" || c === '"') {
      if (quote === null) {
        quote = c
      } else if (quote === c) {
        quote = null
      }
      current += c
      i++
      continue
    }

    if (quote !== null) {
      current += c
      i++
      continue
    }

    // Heredoc check: << outside quotes
    if (c === '<' && i + 1 < n && cmd[i + 1] === '<') {
      return null
    }

    // CRLF (\r\n) or LF (\n)
    if (c === '\r' && i + 1 < n && cmd[i + 1] === '\n') {
      const trimmed = current.trim()
      if (trimmed.length > 0) segments.push(trimmed)
      current = ''
      i += 2
      continue
    }
    if (c === '\n') {
      const trimmed = current.trim()
      if (trimmed.length > 0) segments.push(trimmed)
      current = ''
      i++
      continue
    }

    // Check for && or ||
    if ((c === '&' && i + 1 < n && cmd[i + 1] === '&') || (c === '|' && i + 1 < n && cmd[i + 1] === '|')) {
      const trimmed = current.trim()
      if (trimmed.length > 0) segments.push(trimmed)
      current = ''
      i += 2
      continue
    }

    // Check for |&
    if (c === '|' && i + 1 < n && cmd[i + 1] === '&') {
      const trimmed = current.trim()
      if (trimmed.length > 0) segments.push(trimmed)
      current = ''
      i += 2
      continue
    }

    // Check for ;
    if (c === ';') {
      const trimmed = current.trim()
      if (trimmed.length > 0) segments.push(trimmed)
      current = ''
      i++
      continue
    }

    // Check for standalone | (not part of redirect >|)
    if (c === '|') {
      const prevNonSpace = current.trimEnd().slice(-1)
      if (prevNonSpace === '>') {
        current += c
        i++
        continue
      }
      const trimmed = current.trim()
      if (trimmed.length > 0) segments.push(trimmed)
      current = ''
      i++
      continue
    }

    // Check for single & (not part of &&, &>, or >&)
    if (c === '&') {
      const prevNonSpace = current.trimEnd().slice(-1)
      if (prevNonSpace === '>' || (i + 1 < n && cmd[i + 1] === '>')) {
        current += c
        i++
        continue
      }
      const trimmed = current.trim()
      if (trimmed.length > 0) segments.push(trimmed)
      current = ''
      i++
      continue
    }

    current += c
    i++
  }

  if (quote !== null) {
    return null
  }

  const trimmed = current.trim()
  if (trimmed.length > 0) {
    segments.push(trimmed)
  }

  return segments
}

/**
 * Extract command substitutions `$(...)` and ``` `...` ``` outside single quotes.
 * Returns `null` on unbalanced substitution or quote syntax error.
 */
export function extractCommandSubstitutions(segment: string): { sanitized: string; substitutions: string[] } | null {
  const substitutions: string[] = []
  let sanitized = ''
  let i = 0
  const n = segment.length
  let quote: "'" | '"' | null = null

  while (i < n) {
    const c = segment[i] as string

    if (quote === '"' && c === '\\' && i + 1 < n) {
      sanitized += c + (segment[i + 1] as string)
      i += 2
      continue
    }

    if (c === "'" || c === '"') {
      if (quote === null) {
        quote = c
      } else if (quote === c) {
        quote = null
      }
      sanitized += c
      i++
      continue
    }

    if (quote === "'") {
      sanitized += c
      i++
      continue
    }

    if ((c === '$' || c === '<' || c === '>') && i + 1 < n && segment[i + 1] === '(') {
      i += 2
      let depth = 1
      let subQuote: "'" | '"' | null = null
      let inner = ''
      while (i < n && depth > 0) {
        const sc = segment[i] as string
        if (subQuote === '"' && sc === '\\' && i + 1 < n) {
          inner += sc + (segment[i + 1] as string)
          i += 2
          continue
        }
        if (sc === "'" || sc === '"') {
          if (subQuote === null) subQuote = sc
          else if (subQuote === sc) subQuote = null
          inner += sc
          i++
          continue
        }
        if (subQuote === null) {
          if (sc === '(') {
            depth++
          } else if (sc === ')') {
            depth--
            if (depth === 0) {
              i++
              break
            }
          }
        }
        inner += sc
        i++
      }
      if (depth > 0 || subQuote !== null) {
        return null
      }
      substitutions.push(inner.trim())
      sanitized += '__SUBST__'
      continue
    }

    if (c === '`') {
      i++
      let inner = ''
      let closed = false
      while (i < n) {
        const bc = segment[i] as string
        if (bc === '\\' && i + 1 < n) {
          inner += bc + (segment[i + 1] as string)
          i += 2
          continue
        }
        if (bc === '`') {
          closed = true
          i++
          break
        }
        inner += bc
        i++
      }
      if (!closed) {
        return null
      }
      substitutions.push(inner.trim())
      sanitized += '__SUBST__'
      continue
    }

    sanitized += c
    i++
  }

  if (quote !== null) return null
  return { sanitized, substitutions }
}

const SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const EXEC_WRAPPERS = new Set(['env', 'xargs', 'nohup', 'nice', 'exec'])

function windowMatchesPattern(patternTokens: string[], valueTokens: string[], start: number): boolean {
  for (let i = 0; i < patternTokens.length; i++) {
    const alternatives = (patternTokens[i] as string).split('|')
    const valueTok = valueTokens[start + i] as string
    if (alternatives.includes(valueTok)) continue
    if (i === 0 && alternatives.includes(basename(valueTok))) continue
    return false
  }
  return true
}

/**
 * Does `value`, once tokenized, contain `patternTokens` as a contiguous run
 * anywhere — not just at position 0 — and, failing that, does unwrapping one
 * layer of `sh -c '...'` / `env` / `xargs` / `nohup` / `nice` reveal it? Used
 * only for deny-list matching (finding 15): a single shell wrapper must not be
 * enough to hide a HARD_DENY command from the gate.
 */
function commandLineContainsPattern(patternTokens: string[], value: string): boolean {
  const valueTokens = tokenizeCommand(value)

  for (let start = 0; start + patternTokens.length <= valueTokens.length; start++) {
    if (windowMatchesPattern(patternTokens, valueTokens, start)) return true
  }

  // Handle rm -rf flag sets
  if (patternTokens.length === 2 && patternTokens[0] === 'rm' && patternTokens[1] === '-rf') {
    for (let i = 0; i < valueTokens.length; i++) {
      if (basename(valueTokens[i] as string) === 'rm') {
        if (isRmRfTokens(valueTokens.slice(i))) return true
      }
    }
  }

  // Check command substitutions inside value
  const subst = extractCommandSubstitutions(value)
  if (subst && subst.substitutions.length > 0) {
    for (const inner of subst.substitutions) {
      if (commandLineContainsPattern(patternTokens, inner)) return true
    }
  }

  if (valueTokens.length === 0) return false
  const head = basename(valueTokens[0] as string)

  if (SHELL_WRAPPERS.has(head)) {
    const cIdx = valueTokens.findIndex((t, idx) => idx > 0 && isShellCFlag(t))
    if (cIdx !== -1 && cIdx + 1 < valueTokens.length) {
      const nested = valueTokens.slice(cIdx + 1).join(' ')
      if (commandLineContainsPattern(patternTokens, nested)) return true
    }
    return false
  }

  if (EXEC_WRAPPERS.has(head)) {
    let i = 1
    while (i < valueTokens.length && (valueTokens[i] as string).startsWith('-')) i++
    while (i < valueTokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(valueTokens[i] as string)) i++
    if (i < valueTokens.length) {
      const nested = valueTokens.slice(i).join(' ')
      if (commandLineContainsPattern(patternTokens, nested)) return true
    }
  }

  return false
}

/**
 * Deny-only matcher. Unlike {@link matchRule} (used for allow-list matching,
 * where anchoring the pattern at the command's first token is intentional
 * precision — an allow rule must never widen because it happens to appear
 * mid-command), this scans every token window of the (tokenized, quote-aware)
 * command line and unwraps one layer of a shell/exec wrapper before giving up,
 * so `sh -c 'git push origin main'`, `/usr/bin/curl ...` and `env curl ...`
 * cannot slip past a `command(git push)` / `command(curl)` HARD_DENY entry
 * (finding 15).
 */
export function matchRuleForDenial(rule: ParsedRule, subject: RuleSubject): boolean {
  if (rule.verb !== subject.verb) return false

  if (rule.regex) {
    try {
      return new RegExp(rule.pattern).test(subject.value)
    } catch {
      return false
    }
  }

  if (rule.pattern === '*') return true
  if (rule.verb === 'command') {
    const patternTokens = rule.pattern.trim().split(/\s+/).filter(Boolean)
    if (patternTokens.length === 0) return false
    return commandLineContainsPattern(patternTokens, subject.value)
  }
  if (rule.pattern === '/') return true
  return globToRegex(rule.pattern).test(subject.value)
}

/** Deny-list form of {@link firstMatch}, using {@link matchRuleForDenial}. */
export function firstMatchForDenial(rules: ParsedRule[], subject: RuleSubject): ParsedRule | null {
  for (const rule of rules) {
    if (matchRuleForDenial(rule, subject)) return rule
  }
  return null
}

/**
 * Bare glob matching against a filesystem path — no `verb(pattern)` rule
 * envelope. Used for `Ceiling.read_roots`, which is a list of glob patterns,
 * not permission rules, so it
 * has no verb to check. Same `**`/`*` semantics `matchRule` already uses for
 * `read_file`/`write_file` patterns (`globToRegex`) — exported here instead of
 * a second implementation living in `policy/ceiling.ts`.
 */
export function matchesPathGlob(pattern: string, value: string): boolean {
  if (pattern === '/') return true
  return globToRegex(pattern).test(value)
}

export function matchRule(rule: ParsedRule, subject: RuleSubject): boolean {
  if (rule.verb !== subject.verb) return false

  if (rule.regex) {
    try {
      return new RegExp(rule.pattern).test(subject.value)
    } catch {
      return false
    }
  }

  if (rule.pattern === '*') return true
  if (rule.verb === 'command') return matchCommandPattern(rule.pattern, subject.value)
  // `read_file(/)` etc.: `/` is the filesystem root, i.e. "matches everything".
  if (rule.pattern === '/') return true
  return globToRegex(rule.pattern).test(subject.value)
}

export interface CommandPolicyResult {
  allowed: boolean
  stage: 'profile_allowlist' | 'deny_list' | 'default'
  matchedRule: string | null
  requiredRule: string | null
  reason?: string
}

function requiredRuleForTokens(tokens: string[]): string {
  if (tokens[0] === 'git' && tokens.length >= 2 && !tokens[1]?.startsWith('-')) {
    return `command(git ${tokens[1]})`
  }
  return `command(${tokens.join(' ')})`
}

export function evaluateCommandPolicy(
  commandLine: string,
  allowRules: ParsedRule[],
  denyRules: ParsedRule[],
  depth: number = 0,
): CommandPolicyResult {
  if (depth > 4) {
    return {
      allowed: false,
      stage: 'default',
      matchedRule: null,
      requiredRule: null,
      reason: 'recursion_limit_exceeded',
    }
  }

  // Deny scan across whole command string (maintain existing window scan behavior)
  for (const rule of denyRules) {
    if (matchRuleForDenial(rule, { verb: 'command', value: commandLine })) {
      return {
        allowed: false,
        stage: 'deny_list',
        matchedRule: rule.raw,
        requiredRule: null,
      }
    }
  }

  // Split chain by delimiters (&&, ||, ;, |, \n, \r\n, &, |&)
  const segments = splitChainSegments(commandLine)
  if (segments === null || segments.length === 0) {
    return {
      allowed: false,
      stage: 'deny_list',
      matchedRule: null,
      requiredRule: null,
      reason: 'parse_error',
    }
  }

  let firstMatchedRule: string | null = null

  for (const segment of segments) {
    // Check command substitutions: $(...), `...`, <(...), >(...)
    const subst = extractCommandSubstitutions(segment)
    if (subst === null) {
      return {
        allowed: false,
        stage: 'deny_list',
        matchedRule: null,
        requiredRule: null,
        reason: 'parse_error',
      }
    }

    for (const inner of subst.substitutions) {
      const innerResult = evaluateCommandPolicy(inner, allowRules, denyRules, depth + 1)
      if (!innerResult.allowed) {
        return innerResult
      }
    }

    // Tokenize sanitized segment
    const tokens = tokenizeCommand(subst.sanitized)
    if (tokens.length === 0) continue

    const rawTokens = tokenizeCommandRaw(subst.sanitized)

    // Strip env prefix
    const envRes = stripEnvPrefixTokens(tokens)
    if (envRes.deniedVar !== null) {
      return {
        allowed: false,
        stage: 'deny_list',
        matchedRule: null,
        requiredRule: null,
        reason: 'env_assignment_denied',
      }
    }

    if (envRes.remainingTokens.length === 0) {
      if (envRes.isExport || envRes.isAssignmentOnly) {
        if (!firstMatchedRule) firstMatchedRule = 'command(export)'
        continue
      }
      return {
        allowed: false,
        stage: 'default',
        matchedRule: null,
        requiredRule: null,
      }
    }

    let segTokens = envRes.remainingTokens

    const strippedCount = tokens.length - segTokens.length
    const rawHead = rawTokens.length > strippedCount ? (rawTokens[strippedCount] as string) : null

    if (headTokenIsObfuscated(segTokens[0] as string) || (rawHead !== null && headTokenIsObfuscated(rawHead))) {
      return {
        allowed: false,
        stage: 'deny_list',
        matchedRule: null,
        requiredRule: null,
        reason: 'parse_error',
      }
    }

    let head = basename(segTokens[0] as string)

    if (head === 'xargs') {
      const target = extractXargsTarget(segTokens)
      if (target === null || target.length === 0) {
        return {
          allowed: false,
          stage: 'deny_list',
          matchedRule: null,
          requiredRule: null,
          reason: 'xargs_target_missing',
        }
      }
      const targetResult = evaluateCommandPolicy(target.join(' '), allowRules, denyRules, depth + 1)
      if (!targetResult.allowed) {
        return targetResult
      }
      if (!firstMatchedRule) firstMatchedRule = targetResult.matchedRule
      continue
    }

    if (['bash', 'sh'].includes(head)) {
      const cIdx = segTokens.findIndex((t, idx) => idx > 0 && isShellCFlag(t))
      if (cIdx !== -1) {
        if (cIdx + 1 < segTokens.length) {
          const inner = segTokens[cIdx + 1] as string
          const innerResult = evaluateCommandPolicy(inner, allowRules, denyRules, depth + 1)
          if (!innerResult.allowed) {
            return innerResult
          }
          if (!firstMatchedRule) firstMatchedRule = innerResult.matchedRule
          continue
        } else {
          return {
            allowed: false,
            stage: 'default',
            matchedRule: null,
            requiredRule: `command(${head} -c)`,
          }
        }
      } else {
        // bash <script> without -c
        let sIdx = 1
        while (sIdx < segTokens.length && (segTokens[sIdx] as string).startsWith('-')) sIdx++
        if (sIdx < segTokens.length) {
          segTokens = [segTokens[sIdx] as string, ...segTokens.slice(sIdx + 1)]
          head = basename(segTokens[0] as string)
        }
      }
    }

    if (['zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh'].includes(head)) {
      const hasC = segTokens.some((t, idx) => idx > 0 && isShellCFlag(t))
      if (hasC) {
        let shellWrapperAllowed = false
        for (const rule of allowRules) {
          if (matchRule(rule, { verb: 'command', value: segTokens.join(' ') })) {
            shellWrapperAllowed = true
            if (!firstMatchedRule) firstMatchedRule = rule.raw
            break
          }
        }
        if (!shellWrapperAllowed) {
          return {
            allowed: false,
            stage: 'deny_list',
            matchedRule: null,
            requiredRule: `command(${head} -c)`,
            reason: 'shell_wrapper_denied',
          }
        }
        continue
      }
    }

    if (isRmRfTokens(segTokens)) {
      const rmRfRule = denyRules.find((r) => r.verb === 'command' && r.pattern === 'rm -rf')
      if (rmRfRule) {
        return {
          allowed: false,
          stage: 'deny_list',
          matchedRule: rmRfRule.raw,
          requiredRule: null,
        }
      }
    }

    const gitCheck = checkGitSegment(segTokens)
    if (gitCheck.denied) {
      return {
        allowed: false,
        stage: 'deny_list',
        matchedRule: null,
        requiredRule: null,
        reason: gitCheck.reason,
      }
    }

    if (isDeniedFindSegment(segTokens)) {
      return {
        allowed: false,
        stage: 'deny_list',
        matchedRule: null,
        requiredRule: null,
        reason: 'find_predicate_denied',
      }
    }

    const segCmd = segTokens.join(' ')

    // Check deny list for this segment
    for (const rule of denyRules) {
      if (matchRuleForDenial(rule, { verb: 'command', value: segCmd })) {
        return {
          allowed: false,
          stage: 'deny_list',
          matchedRule: rule.raw,
          requiredRule: null,
        }
      }
    }

    // Check allow list for this segment
    let matched = false
    for (const rule of allowRules) {
      if (matchRule(rule, { verb: 'command', value: segCmd })) {
        matched = true
        if (!firstMatchedRule) firstMatchedRule = rule.raw
        break
      }
    }

    if (!matched) {
      const required = requiredRuleForTokens(segTokens)
      return {
        allowed: false,
        stage: 'default',
        matchedRule: null,
        requiredRule: required,
      }
    }
  }

  return {
    allowed: true,
    stage: 'profile_allowlist',
    matchedRule: firstMatchedRule ?? (allowRules[0]?.raw ?? null),
    requiredRule: null,
  }
}


/** First matching rule in order, or null. Deny lists are scanned before allow lists. */
export function firstMatch(rules: ParsedRule[], subject: RuleSubject): ParsedRule | null {
  if (subject.verb === 'command') {
    const evalResult = evaluateCommandPolicy(subject.value, rules, [])
    if (evalResult.allowed) {
      if (evalResult.matchedRule) {
        try {
          return parseRule(evalResult.matchedRule)
        } catch {
          // fallback
        }
      }
      return rules[0] ?? null
    }
    return null
  }
  for (const rule of rules) {
    if (matchRule(rule, subject)) return rule
  }
  return null
}

export interface IntersectResult {
  /** Requested entries the ceiling covers. */
  allowed: string[]
  /** Requested entries the ceiling refuses, reported back to the caller. */
  rejected: string[]
}

/**
 * Intersect a client's requested allow list with a profile ceiling.
 *
 * A request is kept only when some ceiling rule of the same verb covers it — an
 * unrelated rule can never let something new through. This is the single place
 * that stops a client widening the server's hard limit (see docs/permissions.md).
 *
 * "Covers" is checked by matching the *ceiling* rule against the *requested*
 * rule's own pattern treated as a subject value — the requested rule must be at
 * least as narrow as something the ceiling already allows.
 */
export function intersectAllow(requested: string[], ceiling: string[]): IntersectResult {
  const parsedCeiling = parseRulesLenient(ceiling)
  const allowed: string[] = []
  const rejected: string[] = []

  for (const raw of requested) {
    let req: ParsedRule
    try {
      req = parseRule(raw)
    } catch {
      rejected.push(raw)
      continue
    }
    const covered = parsedCeiling.some(
      (c) => c.verb === req.verb && matchRule(c, { verb: req.verb, value: req.pattern }),
    )
    if (covered) allowed.push(raw)
    else rejected.push(raw)
  }

  return { allowed, rejected }
}

/**
 * The narrowest rule string that would have permitted `subject`.
 * Surfaced as `required_rule` so the calling agent can retry without a round trip.
 */
export function requiredRuleFor(subject: RuleSubject): string {
  if (subject.verb === 'command') {
    const tokens = tokenizeCommand(subject.value)
    const stripped = stripEnvPrefixTokens(tokens).remainingTokens
    if (stripped[0] === 'git' && stripped.length >= 2 && !stripped[1]?.startsWith('-')) {
      return `command(git ${stripped[1]})`
    }
    if (stripped.length > 0) {
      return `command(${stripped.join(' ')})`
    }
  }
  return `${subject.verb}(${subject.value})`
}
