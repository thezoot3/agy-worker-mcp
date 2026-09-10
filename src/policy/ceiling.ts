import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import { canonicalize } from '../contract/paths.js'
import { ValidationError } from '../contract/errors.js'
import type { CeilingSummary, SandboxMode } from '../contract/types.js'
import { HARD_DENY } from './hard-deny.js'
import { matchesPathGlob, parseRule } from './rules.js'

/**
 * The human-owned permission ceiling (see docs/permissions.md
 * — the middle row of the three-owner table: code / **human** / parent agent).
 *
 * Lives at `<project state dir>/policy.json` — `projectPaths(root).dir` from
 * `contract/paths.ts`, i.e. `<AGY_WORKER_HOME or ~/.agy-worker>/projects/<hash>/`,
 * the very directory that already holds `project.json` and `index.db`. That
 * directory sits outside the workspace by construction: it is keyed by
 * `sha256(canonical_root)` under the user's home (or `AGY_WORKER_HOME`), never
 * under the project's own tree. This is what makes it an actual ceiling — I6
 * is exactly the invariant that a bound job
 * can write anywhere `{workspace}/**` a `write_file` rule permits, so a
 * ceiling file living inside the workspace could rewrite its own limits. Never
 * move this file, or look it up, anywhere under a job's `cwd`.
 */
export interface Ceiling {
  /** Whether a policy.json was actually found. False = the profile as shipped. */
  present: boolean
  /** Absolute path the ceiling was (or would be) read from; null for a draft or the frozen empty ceiling. */
  path: string | null
  /** Rules added to every profile's own allow ceiling (`{workspace}` left unsubstituted). */
  allow: string[]
  /** Rules added to every profile's own deny list (`{workspace}` left unsubstituted). */
  deny: string[]
  /**
   * Profile deny rules this project lifts (0.3.0). Matched by exact string
   * against the profile's `deny` in `resolvePolicy`; a rule on `HARD_DENY`
   * here is a file error, never a silent no-op.
   */
  exceptions: string[]
  /**
   * OS boundary for general_worker commands (0.3.0 PR6): `none` (default,
   * the 0.2.1 behaviour), `seatbelt` (our write-only `sandbox-exec` profile),
   * or `agy` (agy's own sandbox, the 0.2.0 behaviour). A v2 `sandboxed: true`
   * and every v1 `sandboxed: true` read as `agy`.
   */
  sandbox: SandboxMode
  /**
   * Read/exec roots outside the workspace (`--add-dir`). `~`-expanded,
   * best-effort canonicalized glob patterns (`*`, `**` allowed, `rules.ts`'s
   * own glob semantics — `matchesPathGlob`). Not job-specific, so resolved
   * once here rather than deferred like the rule strings above.
   */
  read_roots: string[]
  /**
   * Directories outside the workspace a job may write to. Canonical absolute
   * paths (no globs — a write root is a directory, not a pattern). Extends
   * `write_roots` for containment and the seatbelt profile alike.
   */
  write_roots: string[]
  /** Command evaluation mode: "allowlist" (default) or "denylist" (0.2.2 PR3). */
  command_policy: 'allowlist' | 'denylist'
  /** Schema version the file was written in; null when no file. */
  version: 1 | 2 | null
  /** Non-fatal notes for `agy_capabilities` (e.g. v1 key names). */
  warnings: string[]
}

export const EMPTY_CEILING: Ceiling = Object.freeze({
  present: false,
  path: null,
  allow: [],
  deny: [],
  exceptions: [],
  sandbox: 'none',
  read_roots: [],
  write_roots: [],
  command_policy: 'allowlist',
  version: null,
  warnings: [],
})

const ceilingSchemaV1 = z.object({
  version: z.literal(1),
  extra_allow: z.array(z.string()).optional(),
  extra_deny: z.array(z.string()).optional(),
  sandboxed: z.boolean().optional(),
  additional_dirs: z.array(z.string()).optional(),
  command_policy: z.enum(['allowlist', 'denylist']).optional(),
}).strict()

const ceilingSchemaV2 = z.object({
  version: z.literal(2),
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  exceptions: z.array(z.string()).optional(),
  sandbox: z.enum(['none', 'seatbelt', 'agy']).optional(),
  /** Legacy spelling of `sandbox: 'agy'`; kept so a 0.2.x v2-shaped file still loads. */
  sandboxed: z.boolean().optional(),
  read_roots: z.array(z.string()).optional(),
  write_roots: z.array(z.string()).optional(),
  command_policy: z.enum(['allowlist', 'denylist']).optional(),
}).strict()

const ceilingSchema = z.discriminatedUnion('version', [ceilingSchemaV1, ceilingSchemaV2])

/** v1 → v2 key names, for the conversion warning and the error text. */
const V1_RENAMES: ReadonlyArray<readonly [string, string]> = [
  ['extra_allow', 'allow'],
  ['extra_deny', 'deny'],
  ['additional_dirs', 'read_roots'],
]

/** `<project state dir>/policy.json`. Exported so callers (capabilities, tests) don't hardcode the filename. */
export function ceilingPath(paths: { dir: string }): string {
  return join(paths.dir, 'policy.json')
}

function expandHome(p: string): string {
  const home = process.env.HOME ?? homedir()
  if (p === '~') return home
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return p
}

/**
 * Best-effort absolute form of a `read_roots` entry. `canonicalize()`
 * (`contract/paths.ts`) never treats `*`/`**` specially — it only resolves real
 * ancestors via `realpathSync` and appends whatever tail does not exist yet —
 * so a glob segment simply survives as literal path content, which is exactly
 * what `matchesPathGlob` expects to match against later.
 */
function resolveDirPattern(pattern: string): string {
  return canonicalize(expandHome(pattern))
}

/**
 * Convert a ceiling `read_roots` pattern (potentially a glob like `~/.jdks/**`)
 * into a concrete directory root for `--add-dir`.
 *
 * Takes the fixed prefix before the first wildcard (`*`), strips trailing `/`,
 * resolves home expansion and canonicalization via `resolveDirPattern`, and returns
 * the canonical directory path if it exists and is a directory; otherwise null.
 */
export function additionalDirRoot(pattern: string): string | null {
  const starIdx = pattern.indexOf('*')
  let prefix = starIdx === -1 ? pattern : pattern.slice(0, starIdx)
  while (prefix.length > 1 && prefix.endsWith('/')) {
    prefix = prefix.slice(0, -1)
  }
  if (prefix === '') return null
  const resolved = resolveDirPattern(prefix)
  try {
    if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      return canonicalize(resolved)
    }
  } catch {
    return null
  }
  return null
}

/** Every throw from `loadCeiling` goes through here so the shape stays uniform. */
function fail(path: string, expected: string, value?: unknown): never {
  throw new ValidationError({
    field: 'ceiling',
    value: value ?? path,
    expected: `${expected} — fix ${path}`,
  })
}

/**
 * Load and validate the project ceiling.
 *
 * Missing file → {@link EMPTY_CEILING} (a project with no ceiling file grants
 * nothing beyond the profiles' own defaults — narrower, not wider, than
 * having one). Present but invalid — bad JSON, `version` other than `1`/`2`, a
 * non-string entry, an entry that does not parse as `verb(pattern)`
 * (`parseRule`), or a legacy `unsandboxed` entry — throws
 * {@link ValidationError} with `field: 'ceiling'` and the file path, so
 * `agy_start` fails closed and tells the human what to fix instead of quietly
 * falling back to an empty ceiling (which would look like "nothing is
 * misconfigured" when something very much is).
 *
 * `{workspace}` substitution on `allow`/`deny`/`exceptions` is
 * deferred to `resolvePolicy` — this file has no workspace of its own; one
 * project can run jobs against several `cwd` values under the same ceiling.
 * `read_roots` entries are not job-specific, so they are `~`-expanded and
 * canonicalized once, here.
 */
export function loadCeiling(paths: { dir: string }): Ceiling {
  const path = ceilingPath(paths)
  if (!existsSync(path)) return { ...EMPTY_CEILING, path }

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    return fail(path, `policy.json exists but could not be read (${String(e)})`)
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return fail(path, 'policy.json is not valid JSON')
  }

  return parseCeilingJson(json, path)
}

/**
 * The validation half of {@link loadCeiling}, separated so `agy_ceiling` can
 * check a draft that exists only in the caller's hands — same rules, same
 * error texts, no file. `path` only labels the error.
 */
export function parseCeilingJson(json: unknown, path: string): Ceiling {
  if (typeof json === 'object' && json !== null && 'unsandboxed' in json) {
    return fail(
      path,
      'the "unsandboxed" key was removed in 0.2.1; allowed commands now run without agy\'s OS sandbox by default. Delete "unsandboxed" from policy.json (and set "sandboxed": true if you want the old behaviour of forcing the sandbox on)',
    )
  }

  const parsed = ceilingSchema.safeParse(json)
  if (!parsed.success) {
    return fail(
      path,
      `policy.json must be { version: 2, allow?, deny?, exceptions?, sandbox?, read_roots?, write_roots?, command_policy? } (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')})`,
      json,
    )
  }

  const warnings: string[] = []
  let allow: string[]
  let deny: string[]
  let exceptions: string[]
  let readRoots: string[]
  let writeRoots: string[] = []
  let sandbox: SandboxMode
  const d = parsed.data
  if (d.version === 1) {
    sandbox = d.sandboxed ? 'agy' : 'none'
    allow = d.extra_allow ?? []
    deny = d.extra_deny ?? []
    exceptions = []
    readRoots = d.additional_dirs ?? []
    const present = V1_RENAMES.filter(([from]) => from in (json as Record<string, unknown>))
    warnings.push(
      `policy.json is version 1; rename ${present.length > 0 ? present.map(([a, b]) => `${a} → ${b}`).join(', ') : 'its keys'} and set "version": 2. Version 1 is read and converted in 0.3.x and REJECTED in 0.4.0 — a job will not start against it. Call agy_ceiling() for the converted file and the one command that writes it`,
    )
  } else {
    allow = d.allow ?? []
    deny = d.deny ?? []
    exceptions = d.exceptions ?? []
    readRoots = d.read_roots ?? []
    writeRoots = d.write_roots ?? []
    if (d.sandbox !== undefined && d.sandboxed !== undefined) {
      return fail(path, 'policy.json sets both "sandbox" and the legacy "sandboxed"; keep "sandbox" only')
    }
    sandbox = d.sandbox ?? (d.sandboxed ? 'agy' : 'none')
    if (d.sandboxed !== undefined) {
      warnings.push('policy.json uses the legacy "sandboxed" key; write "sandbox": "agy" (or "none") instead')
    }
  }
  const commandPolicy = d.command_policy ?? 'allowlist'
  for (const root of writeRoots) {
    if (root.includes('*')) {
      return fail(path, `write_roots entry is a glob (${root}); write roots are plain directories`)
    }
  }

  for (const rule of [...allow, ...deny, ...exceptions]) {
    try {
      parseRule(rule)
    } catch {
      return fail(path, `allow/deny/exceptions entry is not a valid "verb(pattern)" rule: ${rule}`)
    }
  }
  for (const rule of exceptions) {
    if (HARD_DENY.includes(rule)) {
      return fail(
        path,
        `exceptions may not lift a HARD_DENY rule (${rule}); those protect the gate itself (.agents, credentials, subagents) and cannot be opened by any file`,
      )
    }
  }

  return {
    present: true,
    path,
    allow,
    deny,
    exceptions,
    sandbox,
    read_roots: readRoots.map(resolveDirPattern),
    write_roots: Array.from(new Set(writeRoots.map(resolveDirPattern))),
    command_policy: commandPolicy,
    version: d.version,
    warnings,
  }
}

/**
 * Is `canonicalDir` (already `~`-expanded/canonicalized, e.g. via
 * {@link resolveDirPattern}) covered by some glob in the ceiling's
 * `read_roots`? The one place `read_roots` matching happens, so
 * `resolvePolicy` and any test never re-implement the glob semantics.
 */
export function additionalDirCovered(ceiling: Ceiling, canonicalDir: string): boolean {
  return ceiling.read_roots.some((pattern) => matchesPathGlob(pattern, canonicalDir))
}

/** `~`-expand and canonicalize a requested `read_roots` entry the same way ceiling entries are resolved. */
export function resolveRequestedDir(pattern: string): string {
  return resolveDirPattern(pattern)
}

/**
 * Render a loaded ceiling for `agy_capabilities`.
 *
 * No `{workspace}` substitution: capabilities has no per-job workspace (a
 * project can run jobs against several `cwd` values), so a rule string
 * carrying the literal `{workspace}` placeholder is returned exactly as
 * written in `policy.json`. A caller sees the substituted, job-real form in
 * `agy_start`'s own `policy_summary` instead.
 */
/**
 * The one sentence every surface says when there is no ceiling file. Not an
 * error — the profile as shipped is the safe default — but the agent and the
 * user should both know that the door exists and who holds the key: the user
 * approves, the agent (via `agy_ceiling` / the `agy-ceiling` skill) or the
 * user (via `/agy-ceiling`) drafts.
 */
export function ceilingAbsenceHint(path: string | null): string {
  const where = path ? ` at ${path}` : ''
  return (
    `no project ceiling${where}: jobs run with the profile as shipped (general_worker allows build/test tools and local git; ` +
    `git push, curl, wget, ssh, sudo, docker, npm/pip install and rm -rf are denied, and any other command is denied unless the ceiling allows it). ` +
    `If this project needs more, propose a ceiling: call agy_ceiling (or the user runs /agy-ceiling, or use the agy-ceiling skill), ` +
    `show the draft, and write the file only after the user approves it in this conversation.`
  )
}

export function describeCeiling(ceiling: Ceiling, path: string, present: boolean): CeilingSummary {
  return {
    path,
    present,
    version: ceiling.version,
    allow: ceiling.allow,
    deny: ceiling.deny,
    exceptions: ceiling.exceptions,
    sandbox: ceiling.sandbox,
    read_roots: ceiling.read_roots,
    write_roots: ceiling.write_roots,
    command_policy: ceiling.command_policy,
    warnings: present ? ceiling.warnings : [...ceiling.warnings, ceilingAbsenceHint(path)],
  }
}

/**
 * The version 2 equivalent of a loaded version 1 ceiling, plus the one command
 * that writes it.
 *
 * The conversion itself already happened in {@link parseCeilingJson} — a v1
 * file is read into the same {@link Ceiling} shape as a v2 one — so this is a
 * re-serialization, not a second parser. It exists because 0.4.0 rejects v1
 * outright: telling someone their file will stop working is only half an
 * answer, and this server will never write the file itself (the human owns it,
 * `docs/permissions.md`). So we hand over exactly what to write and let them
 * run it.
 *
 * Returns `null` for anything that is not a version 1 file, so the caller can
 * attach the result unconditionally.
 */
export function migrateV1ToV2(ceiling: Ceiling): { draft: Record<string, unknown>; write_command: string; note: string } | null {
  if (ceiling.version !== 1) return null

  // Only the keys that carry something. A converted file should read like one
  // a person would have written, not like a template with empty arrays.
  const draft: Record<string, unknown> = { version: 2 }
  if (ceiling.allow.length > 0) draft.allow = ceiling.allow
  if (ceiling.deny.length > 0) draft.deny = ceiling.deny
  if (ceiling.read_roots.length > 0) draft.read_roots = ceiling.read_roots
  if (ceiling.write_roots.length > 0) draft.write_roots = ceiling.write_roots
  if (ceiling.sandbox !== 'none') draft.sandbox = ceiling.sandbox
  if (ceiling.command_policy !== 'allowlist') draft.command_policy = ceiling.command_policy

  const path = ceiling.path ?? '<policy.json>'
  const write_command = `cat > ${path} <<'JSON'\n${JSON.stringify(draft, null, 2)}\nJSON`

  return {
    draft,
    write_command,
    note:
      'This project\'s ceiling is version 1, which 0.4.0 rejects: jobs will fail to start until it is converted. ' +
      'The draft below is the exact equivalent of the current file — same permissions, no widening. ' +
      'Show it to the user and let them run the command; this server never writes policy.json.',
  }
}
