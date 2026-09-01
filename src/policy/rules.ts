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

/**
 * Derive the subject from a hook payload's tool call.
 *
 * Only `run_command`'s `CommandLine` is measured (`docs/02` §9) — every other
 * agy tool's argument shape is unconfirmed, so guessing a field name for
 * `view_file` / `write_to_file` / etc. would be exactly the invented behaviour
 * `docs/04` rules out. Those calls come back null and fall through to the
 * profile default (`docs/03` §1.3 step 4), which is the documented, not guessed,
 * behaviour for "nothing matched".
 */
export function subjectFromToolCall(
  toolName: string,
  args: Record<string, unknown>,
): RuleSubject | null {
  if (toolName === 'run_command') {
    const commandLine = args.CommandLine
    if (typeof commandLine === 'string' && commandLine.length > 0) {
      return { verb: 'command', value: commandLine }
    }
  }
  return null
}

function escapeRegExpChar(c: string): string {
  return /[.+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c
}

/** `**` -> any depth, `*` -> one path segment / token, everything else literal. */
function globToRegex(pattern: string): RegExp {
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
 * `command(git status|log|diff)` means: first token exactly `git`, second token
 * one of `status|log|diff`, trailing tokens unconstrained. Extra pattern tokens
 * beyond the value's length never match (the value can't be too short).
 */
function matchCommandPattern(pattern: string, value: string): boolean {
  const patternTokens = pattern.trim().split(/\s+/).filter(Boolean)
  const valueTokens = value.trim().split(/\s+/).filter(Boolean)
  if (patternTokens.length === 0) return false
  if (valueTokens.length < patternTokens.length) return false
  for (let i = 0; i < patternTokens.length; i++) {
    const alternatives = (patternTokens[i] as string).split('|')
    if (!alternatives.includes(valueTokens[i] as string)) return false
  }
  return true
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

  if (valueTokens.length === 0) return false
  const head = basename(valueTokens[0] as string)

  if (SHELL_WRAPPERS.has(head)) {
    const cIdx = valueTokens.indexOf('-c')
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

/** First matching rule in order, or null. Deny lists are scanned before allow lists. */
export function firstMatch(rules: ParsedRule[], subject: RuleSubject): ParsedRule | null {
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
 * that stops a client widening the server's hard limit (`docs/03` §1.6).
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
  return `${subject.verb}(${subject.value})`
}
