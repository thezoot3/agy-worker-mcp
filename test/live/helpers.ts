/**
 * Harness for the **real** `agy` binary (`docs/05-live-verification.md`).
 *
 * Everything here differs from `test/integration/helpers.ts` in exactly one
 * way: `AGY_WORKER_AGY_BIN` is left **unset**, so `resolveAgyBin()`
 * (`src/runner/spawn.ts`) falls through to `agy` on `PATH`. The rest of the
 * stack — `agy_start`, the detached runner, the PreToolUse gate, reconcile —
 * is the same code the integration suite drives, so a difference in outcome
 * is a difference in agy, not in the wiring.
 *
 * These files are `*.live.ts`, not `*.test.ts`, so `vitest.config.ts`'s
 * `include` never picks them up. `npm run test:live` uses
 * `vitest.live.config.ts`. They additionally refuse to run without
 * `AGY_LIVE=1`, so an accidental invocation costs no quota.
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(HERE, '..', '..')

/** Every live test is gated on this. No env var, no quota spent. */
export const LIVE = process.env.AGY_LIVE === '1'

/**
 * Pinned for cost. `docs/05` §3: the point of these tests is agy's *protocol*
 * behaviour, which the cheapest model exercises exactly as well as the
 * expensive one.
 */
export const LIVE_MODEL = process.env.AGY_LIVE_MODEL ?? 'gemini-3.7-flash-low'
export const LIVE_EFFORT = 'low' as const
export const LIVE_TIMEOUT_MS = 90_000

const USAGE_LOG = join(HERE, '.usage.jsonl')

let built = false

export function ensureBuilt(): void {
  if (built) return
  if (!existsSync(join(REPO_ROOT, 'dist', 'runner.js'))) {
    execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'ignore' })
  }
  built = true
}

/** Fail loudly rather than silently falling back to something that isn't agy. */
export function requireAgyOnPath(): string {
  const path = execFileSync('sh', ['-c', 'command -v agy'], { encoding: 'utf8' }).trim()
  if (!path) throw new Error('agy is not on PATH; these tests are pointless without it')
  return path
}

export function agyVersion(): string {
  return execFileSync('agy', ['--version'], { encoding: 'utf8' }).trim()
}

export interface LiveProject {
  home: string
  root: string
}

let seq = 0

/**
 * A throwaway workspace and state home. Nothing here touches the user's real
 * project or `~/.gemini` — `docs/05` §4.
 */
export function makeLiveProject(opts?: { git?: boolean }): LiveProject {
  seq += 1
  const tag = `${process.pid.toString(36)}-${seq}`
  const home = mkdtempSync(join(tmpdir(), `agy-live-home-${tag}-`))
  const root = mkdtempSync(join(tmpdir(), `agy-live-proj-${tag}-`))
  if (opts?.git) {
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: root })
  }
  return { home, root }
}

/**
 * Point the stack at this project **and leave `AGY_WORKER_AGY_BIN` unset** so
 * the real binary is used. Deleting it matters: vitest reuses the process
 * across files in a fork, and an integration-style helper may have set it.
 */
export function applyLiveEnv(p: LiveProject): void {
  process.env.AGY_WORKER_HOME = p.home
  process.env.AGY_WORKER_PROJECT = p.root
  delete process.env.AGY_WORKER_AGY_BIN
  delete process.env.AGY_FAKE_SCENARIO
  delete process.env.AGY_FAKE_STATE_DIR
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function waitUntil<T>(
  fn: () => T | null | Promise<T | null>,
  opts: { timeoutMs: number; label: string; intervalMs?: number },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs
  for (;;) {
    const v = await fn()
    if (v !== null && v !== undefined && v !== false) return v as T
    if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${opts.label}`)
    await sleep(opts.intervalMs ?? 250)
  }
}

export function replyJson<T = Record<string, unknown>>(reply: { content: Array<{ type: string; text: string }> }): T {
  return JSON.parse(reply.content[0]!.text) as T
}

/** Raw NDJSON events a job produced, parsed. Empty array when the file is absent. */
export function readEvents(ctx: { paths: { jobsDir: string } }, jobId: string): Array<Record<string, unknown>> {
  const path = join(ctx.paths.jobsDir, jobId, 'events.ndjson')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>
      } catch {
        return { _unparsed: l }
      }
    })
}

/**
 * Append one row per real agy turn. `docs/05` §3 — there is no quota-readout
 * subcommand on the CLI, so consumption is tracked by counting here.
 */
export function recordUsage(row: {
  test: string
  job_id: string
  model: string
  events: Array<Record<string, unknown>>
  wall_ms: number
}): void {
  // agy's stream-json events carry the discriminator on `event`, not `type`
  // (docs/02 §4) — this used to read `e.type`, which is never set on a real
  // agy event, so `turns`/`usage` silently stayed 0/[] for every row ever
  // written here (including every prior live run's `.usage.jsonl`).
  const results = row.events.filter((e) => e.event === 'result')
  const usage = results.map((r) => (r as { result?: { usage?: unknown } }).result?.usage ?? null)
  mkdirSync(dirname(USAGE_LOG), { recursive: true })
  appendFileSync(
    USAGE_LOG,
    JSON.stringify({
      test: row.test,
      job_id: row.job_id,
      model: row.model,
      wall_ms: row.wall_ms,
      turns: results.length,
      usage,
    }) + '\n',
  )
}

/** Cumulative tally, for printing between groups. */
export function usageTotals(): { calls: number; turns: number; rows: unknown[] } {
  if (!existsSync(USAGE_LOG)) return { calls: 0, turns: 0, rows: [] }
  const rows = readFileSync(USAGE_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { turns: number })
  return { calls: rows.length, turns: rows.reduce((a, r) => a + (r.turns ?? 0), 0), rows }
}

/** Write a file into the live workspace (for path-containment probes). */
export function writeWorkspaceFile(p: LiveProject, rel: string, body: string): string {
  const abs = join(p.root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, body)
  return abs
}

export function processGroupAlive(pgid: number): boolean {
  try {
    const out = execFileSync('pgrep', ['-g', String(pgid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim().length > 0
  } catch {
    return false
  }
}
