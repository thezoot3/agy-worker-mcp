import { ValidationError } from '../contract/errors.js'
import type { CeilingDraftReview, CeilingRuleRisk, CeilingRuleReview } from '../contract/types.js'
import { parseCeilingJson, type Ceiling } from './ceiling.js'
import { HARD_DENY } from './hard-deny.js'
import { getProfile } from './profiles.js'
import { parseRule } from './rules.js'

/**
 * Review a ceiling draft for `agy_ceiling` (0.3.0 PR3). Deterministic
 * and file-free: the same checks `loadCeiling` runs,
 * plus the advisory layer a human wants before approving the file — what is
 * redundant, what is being lifted, and how risky each rule is.
 *
 * The server never writes the ceiling. This module only tells the parent
 * agent what a human is about to be asked to approve.
 */

/**
 * Every concrete command a `command(...)` pattern names, lower-cased. `|` is
 * per-token alternation in `rules.ts` (`git status|log|diff` is three git
 * subcommands, not `git status` or a bare `log`), so expand it token by token.
 */
function commandHeads(pattern: string): string[] {
  const tokens = pattern.trim().toLowerCase().split(/\s+/)
  let heads: string[] = ['']
  for (const token of tokens) {
    const alternatives = token.split('|')
    heads = heads.flatMap((h) => alternatives.map((a) => (h ? `${h} ${a}` : a)))
  }
  return heads
}

const READ_UTILITY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'stat', 'sed', 'sed -n', 'sort', 'uniq', 'diff',
  'cut', 'tr', 'xargs', 'basename', 'dirname', 'realpath', 'which', 'echo', 'printf', 'test', 'true', 'false',
  'pwd', 'env', 'date', 'uname', 'file', 'less', 'more', 'tree', 'jq', 'awk',
])
const BUILD_HEADS = [
  'gradle', './gradlew', 'gradlew', 'mvn', './mvnw', 'make', 'cmake', 'ninja', 'cargo', 'go', 'npm', 'npx', 'pnpm', 'yarn',
  'node', 'node -e', 'python', 'python3', 'python -c', 'python3 -c', 'pytest', 'javac', 'java', 'tsc', 'vitest', 'jest',
  'dotnet', 'swift', 'rustc', 'gcc', 'clang', 'bash -c', 'sh -c', 'bash', 'sh', 'zsh',
]
const NETWORK_HEADS = ['curl', 'wget', 'ssh', 'scp', 'sftp', 'nc', 'ncat', 'telnet', 'rsync', 'ping', 'dig', 'nslookup']
const VCS_REMOTE_HEADS = ['git push', 'git fetch', 'git pull', 'git clone', 'git remote', 'git submodule', 'gh']
const INSTALL_HEADS = [
  'npm install', 'npm i', 'npm ci', 'npm add', 'pnpm install', 'pnpm add', 'yarn add', 'yarn install', 'pip install',
  'pip3 install', 'brew', 'apt', 'apt-get', 'yum', 'dnf', 'cargo install', 'go install', 'gem install',
]
const DESTRUCTIVE_HEADS = [
  'rm -rf', 'rm -r', 'git reset --hard', 'git clean', 'git filter-branch', 'git branch -d', 'git stash drop',
  'git checkout -- .', 'git restore .', 'git restore --staged .', 'git push --force', 'git push -f', 'mkfs', 'dd',
  'chmod -r', 'chown -r', 'kill', 'killall', 'pkill',
]
const PRIVILEGE_HEADS = ['sudo', 'doas', 'su', 'docker', 'podman', 'launchctl', 'systemctl']

function startsWithAny(head: string, list: readonly string[]): boolean {
  return list.some((h) => head === h || head.startsWith(`${h} `))
}

/**
 * Risk class of one rule string. Order matters: the most consequential class
 * wins when a pattern could be read two ways (`git push --force` is
 * destructive before it is vcs_remote; `sudo npm install` is privilege before
 * install). `filesystem` covers every non-command verb — the containment
 * roots, not the rule list, bound those.
 */
export function classifyRuleRisk(rule: string): CeilingRuleRisk {
  let parsed
  try {
    parsed = parseRule(rule)
  } catch {
    return 'other'
  }
  if (parsed.verb !== 'command') return parsed.verb === 'fetch' || parsed.verb === 'url' ? 'network' : 'filesystem'
  if (parsed.regex || parsed.pattern === '*') return 'other'
  const heads = commandHeads(parsed.pattern)
  const classes = heads.map((head): CeilingRuleRisk => {
    if (startsWithAny(head, PRIVILEGE_HEADS)) return 'privilege'
    if (startsWithAny(head, DESTRUCTIVE_HEADS)) return 'destructive'
    if (startsWithAny(head, INSTALL_HEADS)) return 'install'
    if (startsWithAny(head, NETWORK_HEADS)) return 'network'
    if (startsWithAny(head, VCS_REMOTE_HEADS)) return 'vcs_remote'
    if (head.startsWith('git ') || head === 'git') return 'vcs_local'
    if (READ_UTILITY.has(head) || startsWithAny(head, [...READ_UTILITY])) return 'read_utility'
    if (startsWithAny(head, BUILD_HEADS)) return 'build'
    return 'other'
  })
  const order: CeilingRuleRisk[] = [
    'privilege', 'destructive', 'install', 'network', 'vcs_remote', 'other', 'build', 'vcs_local', 'read_utility', 'filesystem',
  ]
  for (const c of order) if (classes.includes(c)) return c
  return 'other'
}

/** Rules a human should read twice before approving. */
export const ELEVATED_RISK: ReadonlySet<CeilingRuleRisk> = new Set<CeilingRuleRisk>([
  'privilege', 'destructive', 'install', 'network', 'vcs_remote',
])

/**
 * Validate and annotate a draft `policy.json`.
 *
 * `errors` are exactly what `loadCeiling` would refuse (so `ok: true` means
 * the file would load). `warnings` are advisory: redundant rules, exceptions
 * that lift nothing, `denylist` mode. `rules` carries one row per rule with
 * its risk class, so the parent agent can put the class next to every line
 * it shows the user.
 */
export function reviewCeilingDraft(draft: unknown): CeilingDraftReview {
  const errors: string[] = []
  let ceiling: Ceiling | null = null
  try {
    ceiling = parseCeilingJson(draft, '<draft>')
  } catch (e) {
    errors.push(e instanceof ValidationError ? e.message : String(e))
  }

  const warnings: string[] = []
  const rules: CeilingRuleReview[] = []
  if (ceiling) {
    warnings.push(...ceiling.warnings)
    const profile = getProfile('general_worker')
    const profileAllow = new Set(profile.allow)
    const profileDeny = new Set(profile.deny)
    const hardDeny = new Set(HARD_DENY)

    for (const rule of ceiling.allow) {
      const notes: string[] = []
      if (profileAllow.has(rule)) notes.push('already in the general_worker allow list')
      if (profileDeny.has(rule)) notes.push('general_worker denies this; allow does not override deny — use exceptions')
      if (hardDeny.has(rule)) notes.push('HARD_DENY; no file can allow this')
      rules.push({ key: 'allow', rule, risk: classifyRuleRisk(rule), notes })
    }
    for (const rule of ceiling.deny) {
      const notes: string[] = []
      if (profileDeny.has(rule)) notes.push('already denied by general_worker')
      if (hardDeny.has(rule)) notes.push('already on HARD_DENY')
      if (ceiling.exceptions.includes(rule)) notes.push('also listed in exceptions; deny wins, net effect denied')
      rules.push({ key: 'deny', rule, risk: classifyRuleRisk(rule), notes })
    }
    for (const rule of ceiling.exceptions) {
      const notes: string[] = []
      if (!profileDeny.has(rule)) notes.push('not on the general_worker deny list; lifts nothing (exact-string match)')
      const risk = classifyRuleRisk(rule)
      if (ELEVATED_RISK.has(risk)) notes.push(`${risk}: needs explicit line-by-line approval`)
      rules.push({ key: 'exceptions', rule, risk, notes })
    }
    for (const r of rules) {
      for (const n of r.notes) warnings.push(`${r.key}: ${r.rule} — ${n}`)
    }
    if (ceiling.command_policy === 'denylist') {
      warnings.push('command_policy: denylist lets every command not on a deny list run; needs explicit approval')
    }
  }

  return { ok: errors.length === 0, errors, warnings, rules }
}
