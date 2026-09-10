/**
 * Project discovery, on-disk layout, and path containment. READ-ONLY after Stage 1.
 *
 * Layout — deliberately outside the repo so nothing has to be
 * gitignored (see docs/operations.md):
 *
 * ```
 * ~/.agy-worker/projects/<sha256(canonical_root)[:16]>/
 *     project.json  index.db
 *     jobs/<job-id>/{request,effective-config,state}.json
 *                   events.ndjson stderr.log exit_code
 *                   inbox.jsonl policy.json gate-log.jsonl
 *                   agent-result.json broker-result.json verification.json
 *                   verify.log verify.json
 * ```
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PathEscapeError } from './errors.js'
import { ENV, type ProjectRootSource } from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Project root discovery
// ─────────────────────────────────────────────────────────────────────────────

export type { ProjectRootSource } from './types.js'

export interface ProjectRootResolution {
  root: string
  source: ProjectRootSource
  movedFrom?: string
}

export interface GitRootResolution {
  root: string
  source: 'git' | 'git-worktree' | 'git-submodule'
}

/**
 * When `.git` is a file rather than a directory, it either points to a linked
 * git worktree or to a submodule. For a worktree, git places a `commondir` file
 * inside the per-worktree git directory pointing back to the main repository's
 * `.git` — we follow that indirection to the common directory's parent so every
 * worktree of one repository shares a single lock domain, SQLite database, and
 * permission ceiling.
 *
 * For submodules, there is no `commondir` file: the git dir itself is the
 * submodule repository's git directory. We intentionally do not climb to the
 * superproject because a submodule is an independent repository with its own
 * history and permission boundary.
 *
 * Any parse failure or missing path falls back to the directory holding the
 * `.git` file without throwing, degrading safely to legacy behaviour.
 */
export function resolveGitFile(dir: string, gitEntry: string): GitRootResolution {
  const fallback: GitRootResolution = { root: canonicalize(dir), source: 'git' }
  try {
    const content = readFileSync(gitEntry, 'utf8').trim()
    const lines = content.split(/\r?\n/)
    if (lines.length !== 1) return fallback

    const match = /^gitdir:\s*(.+)$/.exec(lines[0]!)
    if (!match) return fallback

    const rawGitDir = match[1]!.trim()
    if (!rawGitDir) return fallback

    const gitDir = resolve(dir, rawGitDir)
    const gitDirStat = statSync(gitDir, { throwIfNoEntry: false })
    if (!gitDirStat || !gitDirStat.isDirectory()) return fallback

    const commonDirFile = join(gitDir, 'commondir')
    if (existsSync(commonDirFile)) {
      const commonDirRaw = readFileSync(commonDirFile, 'utf8').trim()
      if (!commonDirRaw) return fallback

      const commonGitDir = resolve(gitDir, commonDirRaw)
      const commonStat = statSync(commonGitDir, { throwIfNoEntry: false })
      if (!commonStat || !commonStat.isDirectory()) return fallback

      const parentDir = dirname(commonGitDir)
      const parentStat = statSync(parentDir, { throwIfNoEntry: false })
      if (!parentStat || !parentStat.isDirectory()) return fallback

      return { root: canonicalize(parentDir), source: 'git-worktree' }
    }

    return { root: canonicalize(dir), source: 'git-submodule' }
  } catch {
    return fallback
  }
}

/**
 * Resolve the project root.
 *
 * Precedence: `AGY_WORKER_PROJECT` (documented as an *override* in `docs/operations.md`) →
 * nearest ancestor containing `.git` → the starting directory itself. The last
 * branch ensures non-git directories are fully supported.
 *
 * The returned path is always canonical (symlinks resolved).
 */
export function resolveProjectRoot(startCwd: string = process.cwd()): ProjectRootResolution {
  const override = process.env[ENV.PROJECT_ROOT]
  if (override && override.trim()) {
    return { root: canonicalize(resolve(override.trim())), source: 'env' }
  }
  const start = canonicalize(resolve(startCwd))
  const gitRoot = findGitRoot(start)
  if (gitRoot) {
    return {
      root: gitRoot.root,
      source: gitRoot.source,
      ...(gitRoot.source === 'git-worktree' ? { movedFrom: start } : {}),
    }
  }
  return { root: start, source: 'cwd' }
}

/** Convenience wrapper when the caller does not care where the root came from. */
export function projectRoot(startCwd?: string): string {
  return resolveProjectRoot(startCwd).root
}

/** Walks up looking for `.git` (a directory *or* a worktree/submodule file). */
export function findGitRoot(startCanonical: string): GitRootResolution | null {
  let dir = startCanonical
  for (;;) {
    const gitEntry = join(dir, '.git')
    try {
      const stat = statSync(gitEntry, { throwIfNoEntry: false })
      if (stat) {
        if (stat.isDirectory()) {
          return { root: canonicalize(dir), source: 'git' }
        }
        if (stat.isFile()) {
          return resolveGitFile(dir, gitEntry)
        }
      }
    } catch {
      return { root: canonicalize(dir), source: 'git' }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// State home and per-project directories
// ─────────────────────────────────────────────────────────────────────────────

/** `~/.agy-worker`, or `AGY_WORKER_HOME` when set (tests always set it). */
export function stateHome(): string {
  const override = process.env[ENV.STATE_HOME]
  if (override && override.trim()) return resolve(override.trim())
  return join(homedir(), '.agy-worker')
}

/** `sha256(canonical_root)` truncated to 16 hex chars — the per-project directory name. */
export function projectKey(canonicalRoot: string): string {
  return createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16)
}

export interface ProjectPaths {
  /** Canonical project root inside the user's filesystem. */
  root: string
  source: ProjectRootSource
  movedFrom?: string
  key: string
  /** `<stateHome>/projects/<key>` */
  dir: string
  projectJson: string
  db: string
  jobsDir: string
}

export function projectPaths(
  canonicalRoot: string,
  source: ProjectRootSource = 'cwd',
  movedFrom?: string,
): ProjectPaths {
  const key = projectKey(canonicalRoot)
  const dir = join(stateHome(), 'projects', key)
  return {
    root: canonicalRoot,
    source,
    ...(movedFrom ? { movedFrom } : {}),
    key,
    dir,
    projectJson: join(dir, 'project.json'),
    db: join(dir, 'index.db'),
    jobsDir: join(dir, 'jobs'),
  }
}

/** Chmod SQLite db and WAL/SHM files to 0o600. */
export function chmodDbFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = `${dbPath}${suffix}`
    if (existsSync(p)) {
      try {
        chmodSync(p, 0o600)
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Creates the project directory tree and writes `project.json` (the reverse
 * lookup from hash back to path). Idempotent and safe to race.
 */
export function ensureProjectDirs(paths: ProjectPaths): ProjectPaths {
  mkdirSync(paths.jobsDir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(paths.dir, 0o700)
    chmodSync(paths.jobsDir, 0o700)
  } catch {
    // best-effort
  }
  if (!existsSync(paths.projectJson)) {
    writeJsonAtomic(paths.projectJson, { root: paths.root, key: paths.key })
  }
  chmodDbFiles(paths.db)
  return paths
}

// ─────────────────────────────────────────────────────────────────────────────
// Job directory
// ─────────────────────────────────────────────────────────────────────────────

export interface JobPaths {
  jobId: string
  dir: string
  request: string
  effectiveConfig: string
  state: string
  /** agy stdout, redirected straight to this fd. Cursors are byte offsets into it. */
  events: string
  stderr: string
  /** Written by the runner on exit. Its presence is what makes a job finalizable. */
  exitCode: string
  inbox: string
  policy: string
  gateLog: string
  agentResult: string
  brokerResult: string
  verification: string
  /** stdout+stderr of `verify_command`, capped at 1 MiB (PR6 §6.2). */
  verifyLog: string
  /** `VerifyRecord`, written once after `verify_command` exits (PR6 §6.2). */
  verifyJson: string
}

export function jobPaths(project: ProjectPaths, jobId: string): JobPaths {
  const dir = join(project.jobsDir, jobId)
  return {
    jobId,
    dir,
    request: join(dir, 'request.json'),
    effectiveConfig: join(dir, 'effective-config.json'),
    state: join(dir, 'state.json'),
    events: join(dir, 'events.ndjson'),
    stderr: join(dir, 'stderr.log'),
    exitCode: join(dir, 'exit_code'),
    inbox: join(dir, 'inbox.jsonl'),
    policy: join(dir, 'policy.json'),
    gateLog: join(dir, 'gate-log.jsonl'),
    agentResult: join(dir, 'agent-result.json'),
    brokerResult: join(dir, 'broker-result.json'),
    verification: join(dir, 'verification.json'),
    verifyLog: join(dir, 'verify.log'),
    verifyJson: join(dir, 'verify.json'),
  }
}

export function ensureJobDirs(paths: JobPaths): JobPaths {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(paths.dir, 0o700)
  } catch {
    // best-effort
  }
  chmodDbFiles(join(paths.dir, '..', '..', 'index.db'))
  return paths
}

/** Sortable id: `<base36 ms>-<8 hex>`. Lexical order matches creation order. */
export function newJobId(now: number = Date.now()): string {
  return `${now.toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`
}

/** Session ids are opaque; they never appear in a filesystem path. */
export function newSessionId(): string {
  return randomUUID()
}

// ─────────────────────────────────────────────────────────────────────────────
// Package-relative resources
// ─────────────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The DDL text. Resolved next to this module (`dist/contract/schema.sql` after a
 * build, `src/contract/schema.sql` under vitest), with the source tree as fallback.
 */
export function loadSchemaSql(): string {
  const candidates = [
    join(HERE, 'schema.sql'),
    join(HERE, '..', '..', 'src', 'contract', 'schema.sql'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, 'utf8')
  }
  throw new Error(`schema.sql not found; looked in: ${candidates.join(', ')}`)
}

/** Installed package root (the directory holding `package.json`). */
export function packageRoot(): string {
  let dir = HERE
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return HERE
    dir = parent
  }
}

/**
 * Absolute path to one of the three entry points. The gate path is written into
 * generated `hooks.json` files, so it must be stable and absolute.
 *
 * `ENV.GATE_BIN` overrides the `'gate'` case only — a test-only escape hatch
 * (`ENV.GATE_BIN`'s own comment) so a test can point `agy_start` at a
 * nonexistent gate binary and exercise its `existsSync` failure path without
 * disturbing the real `dist/gate.js` every other test also depends on.
 */
export function binPath(which: 'server' | 'runner' | 'gate'): string {
  if (which === 'gate') {
    const override = process.env[ENV.GATE_BIN]
    if (override && override.trim()) return override.trim()
  }
  const root = packageRoot()
  const dist = join(root, 'dist', `${which}.js`)
  if (existsSync(dist)) return dist
  return join(root, 'src', `${which}.ts`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonicalization and containment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Absolute, `..`-free, symlink-resolved path.
 *
 * When the path does not exist yet (a file the job is about to write) the deepest
 * existing ancestor is resolved and the remaining segments are appended. That is
 * what makes containment checks meaningful for not-yet-created files: the
 * *directory* they would land in is what actually decides the answer.
 */
export function canonicalize(input: string): string {
  const abs = isAbsolute(input) ? resolve(input) : resolve(process.cwd(), input)
  try {
    return realpathSync.native(abs)
  } catch {
    // fall through to the partial-resolution path
  }
  const rootOf = parsePath(abs).root
  const tail: string[] = []
  let dir = abs
  for (;;) {
    const parent = dirname(dir)
    tail.unshift(dir.slice(parent === rootOf ? parent.length : parent.length + 1))
    dir = parent
    if (dir === rootOf) break
    try {
      return join(realpathSync.native(dir), ...tail)
    } catch {
      continue
    }
  }
  try {
    return join(realpathSync.native(rootOf), ...tail)
  } catch {
    return abs
  }
}

/** True when `candidate` is `root` itself or lives beneath it. Both must be canonical. */
export function isWithin(candidate: string, root: string): boolean {
  if (candidate === root) return true
  const rel = relative(root, candidate)
  return rel !== '' && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel)
}

/** True when the path traverses a symlink anywhere below `root`. */
export function traversesSymlink(input: string): boolean {
  const abs = isAbsolute(input) ? resolve(input) : resolve(process.cwd(), input)
  return canonicalize(abs) !== abs
}

/**
 * Canonicalize then check containment; throw {@link PathEscapeError} on escape.
 *
 * ⚠ Order matters and is the whole point: resolving *after* the check would let a
 * symlink inside the workspace point anywhere (see docs/permissions.md). Returns the
 * canonical path so callers use the resolved form from here on.
 */
export function assertContained(
  input: string,
  roots: string[],
  kind: 'read' | 'write',
): string {
  const resolved = canonicalize(input)
  const canonicalRoots = roots.map(canonicalize)
  for (const root of canonicalRoots) {
    if (isWithin(resolved, root)) return resolved
  }
  const abs = isAbsolute(input) ? resolve(input) : resolve(process.cwd(), input)
  throw new PathEscapeError({
    input_path: input,
    resolved_path: resolved,
    kind,
    roots: canonicalRoots,
    via_symlink: resolved !== abs,
  })
}

/** Non-throwing form of {@link assertContained}. */
export function containedOrNull(input: string, roots: string[]): string | null {
  const resolved = canonicalize(input)
  for (const root of roots) {
    if (isWithin(resolved, canonicalize(root))) return resolved
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Atomic file helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write via a sibling temp file plus `rename`, so a concurrent reader either sees
 * the previous complete version or the new one — never a torn file. Several
 * processes read `state.json` and `broker-result.json` without coordination.
 */
export function writeFileAtomic(target: string, data: string | Uint8Array): void {
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    if (typeof data === 'string') writeSync(fd, data)
    else writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    chmodSync(tmp, 0o600)
  } catch {
    // best-effort
  }
  renameSync(tmp, target)
}

export function writeJsonAtomic(target: string, value: unknown): void {
  writeFileAtomic(target, JSON.stringify(value, null, 2) + '\n')
}

/** Returns null for a missing *or* unparsable file; a torn read is not fatal. */
export function readJsonIfExists<T>(target: string): T | null {
  try {
    return JSON.parse(readFileSync(target, 'utf8')) as T
  } catch {
    return null
  }
}

/** Appends one NDJSON line with a single `O_APPEND` write, which is atomic for small lines. */
export function appendJsonLine(target: string, value: unknown): void {
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify(value) + '\n', { flag: 'a', mode: 0o600 })
  try {
    chmodSync(target, 0o600)
  } catch {
    // best-effort
  }
}

/** Current byte length, or 0 when the file does not exist yet. */
export function fileSize(target: string): number {
  try {
    return statSync(target).size
  } catch {
    return 0
  }
}
