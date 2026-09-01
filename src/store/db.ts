import { DatabaseSync } from 'node:sqlite'

import { SCHEMA_VERSION } from '../contract/types.js'
import {
  ensureProjectDirs,
  loadSchemaSql,
  projectPaths,
  resolveProjectRoot,
  type ProjectPaths,
} from '../contract/paths.js'

/**
 * An open per-project database plus the paths it belongs to.
 *
 * Synchronous on purpose (`docs/01` 결정 6): with `DatabaseSync` no `await` can
 * interleave between `BEGIN IMMEDIATE` and `COMMIT`, so the lock critical section
 * cannot be preempted by another task in the same process.
 */
export interface Store {
  db: DatabaseSync
  paths: ProjectPaths
  /** Canonical project root. */
  root: string
  close(): void
}

export interface OpenStoreOptions {
  /** Directory to start project discovery from. Defaults to `process.cwd()`. */
  cwd?: string
  /** Skip `ensureProjectDirs`. Only useful for read-only probes. */
  readOnly?: boolean
}

/**
 * Open (creating if needed) the project database.
 *
 * Must, in this order: resolve the project root, create the project directory,
 * open `index.db`, apply `PRAGMA journal_mode = WAL` and
 * `PRAGMA busy_timeout = 5000` on *this connection* (pragmas are per-connection,
 * so running `schema.sql` alone is not enough), then {@link migrate}.
 */
export function openStore(opts?: OpenStoreOptions): Store {
  const { root } = resolveProjectRoot(opts?.cwd)
  const paths = projectPaths(root)
  const readOnly = opts?.readOnly ?? false
  if (!readOnly) {
    ensureProjectDirs(paths)
  }

  // `readOnly` used to only skip `ensureProjectDirs` while still opening a
  // read-write connection and running `migrate()` — every gate hook
  // invocation (one per tool call, including a user's own unrelated
  // interactive agy session) was therefore taking the SQLite write lock and
  // re-running the whole `schema.sql` (finding 19). A genuinely read-only
  // connection cannot migrate, so skip that too; the gate does not need to.
  const db = new DatabaseSync(paths.db, { readOnly, open: true })
  // Pragmas are per-connection: schema.sql also sets them, but a fresh
  // connection reopening an existing file must set them again here.
  // `busy_timeout` is kept short for a read-only (gate) connection so a
  // concurrent writer never eats into the hook's ~15s budget — a timeout here
  // must fall through to PASSTHROUGH, not hang.
  db.exec(`PRAGMA busy_timeout = ${readOnly ? 2000 : 5000}`)
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA synchronous = NORMAL')
    migrate(db, root)
  }

  return {
    db,
    paths,
    root,
    close(): void {
      db.close()
    },
  }
}

/**
 * Apply `schema.sql` and bring `meta.schema_version` up to
 * {@link import('../contract/types.js').SCHEMA_VERSION}. Idempotent and safe when
 * several server processes race to open the same file.
 */
export function migrate(db: DatabaseSync, root: string): void {
  const sql = loadSchemaSql()
  db.exec(sql)

  const existing = getMeta(db, 'schema_version')
  if (existing === null) {
    setMeta(db, 'schema_version', String(SCHEMA_VERSION))
  }
  // No prior versions to migrate from yet (SCHEMA_VERSION === 1). Future bumps
  // add branches here, keyed off the value actually stored.

  const existingRoot = getMeta(db, 'project_root')
  if (existingRoot === null) {
    setMeta(db, 'project_root', root)
  }
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? row.value : null
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value)
}

/**
 * Run `fn` inside a single `BEGIN IMMEDIATE` … `COMMIT`, rolling back on throw.
 *
 * `fn` is synchronous by signature and must stay that way — returning a promise
 * from it would reopen exactly the interleaving this design rules out.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // If ROLLBACK itself fails the connection is in a bad state; the
      // original error is what the caller needs to see.
    }
    throw err
  }
}

/** Wall clock in ms. Centralized so tests can freeze it. */
export function now(): number {
  return Date.now()
}
