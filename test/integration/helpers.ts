/**
 * Shared harness for the integration suite.
 *
 * These tests exercise the real stack end to end: the actual `handle*` tool
 * functions from `src/server/tools/**`, the real detached runner
 * (`dist/runner.js`, spawned exactly the way `agy_start` spawns it), the real
 * PreToolUse gate (`dist/gate.js`), a real per-project SQLite file, and
 * `test/fake-agy/agy.mjs` standing in for `agy` itself.
 *
 * IMPORTANT — a build is required. `agy_start` spawns `binPath('runner')`,
 * which resolves to `dist/runner.js` when present and falls back to
 * `src/runner.ts` otherwise. Plain `node` cannot resolve the `.js`-suffixed
 * relative imports inside the TypeScript sources (only vitest's
 * `jsToTsResolver` plugin does that rewrite, and only for modules vitest
 * itself loads — not for a separate `node dist/runner.js` child process), so
 * without `dist/` the spawned runner exits immediately with
 * `ERR_MODULE_NOT_FOUND` and every job sits in `queued` forever. `beforeAll`
 * below builds once per test file if `dist/runner.js` is missing.
 *
 * Two "clients" in this suite means two independent `ToolContext` objects
 * (each opening its own `DatabaseSync` connection to the same `index.db`),
 * which is exactly what two separate MCP server processes attached to the
 * same project would each hold. That is the realistic unit of "a client" in
 * this daemon-less design (`docs/01` 결정 1) — there is no in-process handle
 * to share between them even in the real deployment.
 */

import { execFileSync, execSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(HERE, '..', '..')

let built = false

/** Build once per process if `dist/` is stale or missing. Idempotent. */
export function ensureBuilt(): void {
  if (built) return
  const runnerJs = join(REPO_ROOT, 'dist', 'runner.js')
  if (!existsSync(runnerJs)) {
    execSync('npm run build', { cwd: REPO_ROOT, stdio: 'ignore' })
  }
  built = true
}

export interface TestProject {
  home: string
  root: string
  agyBin: string
  fakeStateDir: string
}

let seq = 0

/** A fresh, isolated project: its own `AGY_WORKER_HOME`, its own workspace root. */
export function makeProject(opts?: { git?: boolean }): TestProject {
  seq += 1
  const tag = `${Date.now().toString(36)}-${seq}`
  const home = mkdtempSync(join(tmpdir(), `agy-home-${tag}-`))
  const root = mkdtempSync(join(tmpdir(), `agy-proj-${tag}-`))
  const fakeStateDir = mkdtempSync(join(tmpdir(), `agy-fakestate-${tag}-`))
  if (opts?.git) {
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: root })
  }
  return {
    home,
    root,
    agyBin: join(REPO_ROOT, 'test', 'fake-agy', 'agy.mjs'),
    fakeStateDir,
  }
}

/**
 * `AGY_FAKE_SCENARIO` / `AGY_FAKE_STATE_DIR` select which scenario the fake
 * binary plays, but they can never reach it through the real `agy_start` →
 * runner → `spawnAgyDetached` path: `buildChildEnv()`
 * (`src/runner/spawn.ts`) allowlists a fixed, small set of environment keys
 * for the spawned agy process (`PATH`, `HOME`, locale, …) and deliberately
 * does not include them — `contract/types.ts`'s own comment on `ENV.FAKE_SCENARIO`
 * says as much ("never read by src/"). That allowlist is correct production
 * behaviour, not a bug to route around by weakening it.
 *
 * So instead of pointing `AGY_WORKER_AGY_BIN` straight at `agy.mjs`, this
 * writes a tiny per-scenario wrapper *executable* (a shebang script, spawned
 * directly via argv — no `shell: true` anywhere) that exports the scenario
 * selection itself before exec'ing the real fake binary. That keeps every
 * test going through the exact spawn path `agy_start` really uses.
 */
export function writeAgyWrapper(p: TestProject, scenario: string): string {
  const wrapperPath = join(p.home, `agy-wrapper-${scenario}.sh`)
  const script = `#!/bin/sh
export AGY_FAKE_SCENARIO="${scenario}"
export AGY_FAKE_STATE_DIR="${p.fakeStateDir}"
exec node "${p.agyBin}" "$@"
`
  writeFileSync(wrapperPath, script, { mode: 0o700 })
  chmodSync(wrapperPath, 0o700)
  return wrapperPath
}

/**
 * Point the environment every downstream module reads (`contract/types.ts`
 * `ENV`) at this project and scenario. All of `resolveProjectRoot`,
 * `stateHome`, `resolveAgyBin` re-read `process.env` on every call — nothing
 * caches at import time — so this is safe to call fresh before each test.
 *
 * `AGY_WORKER_AGY_BIN` is read by `resolveAgyBin()` **in the server process**
 * at `agy_start` time (not by the spawned child), so it is not subject to
 * the child-env allowlist — pointing it at the per-scenario wrapper here is
 * what actually makes scenario selection reach the fake binary.
 */
export function applyEnv(p: TestProject, scenario: string): void {
  process.env.AGY_WORKER_HOME = p.home
  process.env.AGY_WORKER_PROJECT = p.root
  process.env.AGY_WORKER_AGY_BIN = writeAgyWrapper(p, scenario)
  // Harmless to also set these: they matter for the handful of tests (and
  // `test/fake-agy/golden.test.ts`-style callers) that invoke `agy.mjs`
  // directly rather than through `agy_start`.
  process.env.AGY_FAKE_SCENARIO = scenario
  process.env.AGY_FAKE_STATE_DIR = p.fakeStateDir
}

/** Poll `fn` until it returns truthy or `timeoutMs` elapses. Throws on timeout. */
export async function waitUntil<T>(
  fn: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  opts?: { timeoutMs?: number; intervalMs?: number; label?: string },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? 15_000
  const intervalMs = opts?.intervalMs ?? 100
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() >= deadline) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms${opts?.label ? `: ${opts.label}` : ''}`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Parse a tool reply's JSON text content — every `handle*` function returns this shape. */
export function replyJson<T = Record<string, unknown>>(reply: { content: Array<{ type: string; text: string }> }): T {
  return JSON.parse(reply.content[0]!.text) as T
}

/** True when the OS reports at least one live pid in this process group. */
export function processGroupAlive(pgid: number): boolean {
  try {
    const out = execFileSync('pgrep', ['-g', String(pgid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split('\n').some((l) => l.trim().length > 0)
  } catch {
    return false
  }
}

export function isPidAliveOs(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Read `jobs/<id>/state.json`, written by the runner. Null if it doesn't exist yet. */
export function readJobState(project: { paths: { jobsDir: string } }, jobId: string): { pid: number | null; pgid: number | null; lifecycle: string } | null {
  try {
    const raw = readFileSync(join(project.paths.jobsDir, jobId, 'state.json'), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function fileExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}
