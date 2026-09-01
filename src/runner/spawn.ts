import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import type { Writable } from 'node:stream'

import { FORBIDDEN_AGY_FLAGS, ENV, type EffectiveConfig } from '../contract/types.js'
import { ValidationError } from '../contract/errors.js'
import type { JobPaths } from '../contract/paths.js'
import { getProcStartTime } from './reap.js'

/**
 * Typed allowlist for argv construction (`docs/01` 결정 7). There is no free-form
 * `extra_args` and no shell string anywhere; `spawn` always receives an array.
 */
export interface AgyArgvInput {
  /** Emitted as `--print=<prompt>`. Empty string is legal and is what stream-json input uses. */
  prompt: string
  /**
   * Canonical workspace. **Always emitted.** Without `--add-dir` the workspace is
   * never registered, tools run in agy's scratch directory, and
   * `<ws>/.agents/hooks.json` — our whole gate — is not loaded (§3).
   */
  addDir: string
  model?: string | null
  effort?: string | null
  mode?: string | null
  /** Emitted as the bare `--sandbox` flag. */
  sandbox: boolean
  /** Resume an existing conversation. Never `--continue`, which is global. */
  conversationId?: string | null
  /** Only for `session_mode: 'session'`; requires `--output-format stream-json`. */
  inputFormat?: 'stream-json' | null
  outputFormat: 'stream-json'
  /** Rendered as agy's duration syntax, e.g. `60m`. */
  printTimeoutMs: number
  jsonSchemaPath?: string | null
}

/**
 * Build the argv.
 *
 * ⚠ `--print` **must** use the `=` form. Measured: a bare `-p` / `--print`
 * swallows the next flag as its prompt and exits 2 (§2).
 *
 * @throws {ValidationError} if any member of `FORBIDDEN_AGY_FLAGS` would appear,
 * or if `addDir` is empty.
 */
export function buildAgyArgv(input: AgyArgvInput): string[] {
  if (!input.addDir || !input.addDir.trim()) {
    throw new ValidationError({
      field: 'addDir',
      value: input.addDir,
      expected: 'a non-empty absolute workspace path — required, or the workspace is never registered (docs/02 §3)',
    })
  }
  if (typeof input.prompt !== 'string') {
    throw new ValidationError({ field: 'prompt', value: input.prompt, expected: 'a string (may be empty)' })
  }
  // Measured against agy 1.1.23: the two are mutually exclusive, and agy says so
  // itself rather than silently ignoring one —
  //   Error: --input-format stream-json reads prompts from stdin, so a prompt
  //   given on the command line would be ignored
  // `docs/02` §2 already records the working shape (`--print=''` plus stdin);
  // this makes it impossible to build the combination that fails.
  if (input.inputFormat === 'stream-json' && input.prompt !== '') {
    throw new ValidationError({
      field: 'prompt',
      value: input.prompt,
      expected:
        'an empty string when inputFormat is stream-json — agy rejects a command-line prompt there; queue the turn on stdin instead (docs/02 §2, §5)',
    })
  }

  const argv: string[] = []
  argv.push(`--print=${input.prompt}`)
  argv.push('--add-dir', input.addDir)
  if (input.sandbox) argv.push('--sandbox')
  if (input.model) argv.push('--model', input.model)
  if (input.effort) argv.push('--effort', input.effort)
  if (input.mode) argv.push('--mode', input.mode)
  argv.push('--output-format', input.outputFormat)
  if (input.inputFormat) argv.push('--input-format', input.inputFormat)
  if (input.conversationId) argv.push('--conversation', input.conversationId)
  if (input.jsonSchemaPath) argv.push('--json-schema', input.jsonSchemaPath)
  argv.push('--print-timeout', formatDuration(input.printTimeoutMs))

  for (const forbidden of FORBIDDEN_AGY_FLAGS) {
    // Exact-match `includes` alone only catches a forbidden flag passed as its
    // own argv element; `model`/`effort`/`mode` land in argv as free-form
    // strings (e.g. `--model`, `<value>`), so a value shaped like
    // `--continue=1` or `--dangerously-skip-permissions=true` would pass the
    // exact check and still reach agy's own argv parser (finding 18). Also
    // reject anything that starts with the forbidden flag followed by `=`.
    if (argv.includes(forbidden) || argv.some((a) => a.startsWith(`${forbidden}=`))) {
      throw new ValidationError({
        field: 'argv',
        value: forbidden,
        expected: `never one of the forbidden flags`,
        allowed: FORBIDDEN_AGY_FLAGS.slice(),
      })
    }
  }

  return argv
}

/**
 * `60000` → `"1m"`-style duration string accepted by `--print-timeout`
 * (Go's `time.ParseDuration` syntax: `1h2m3s`, `500ms`, `0s`, ...).
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new ValidationError({ field: 'printTimeoutMs', value: ms, expected: 'a non-negative finite number of milliseconds' })
  }
  let totalMs = Math.round(ms)
  const hours = Math.floor(totalMs / 3_600_000)
  totalMs -= hours * 3_600_000
  const minutes = Math.floor(totalMs / 60_000)
  totalMs -= minutes * 60_000
  const seconds = totalMs / 1000

  let out = ''
  if (hours > 0) out += `${hours}h`
  if (minutes > 0 || hours > 0) out += `${minutes}m`
  if (Number.isInteger(seconds)) out += `${seconds}s`
  else out += `${Number(seconds.toFixed(3))}s`
  return out.length > 0 ? out : '0s'
}

/** Environment variable names allowed through to the child. Nothing else survives. */
const ALLOWED_ENV_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
]

/**
 * Environment for the child, built from an allowlist (PATH, HOME, locale, agy's
 * own config vars). The server's full environment is never inherited wholesale.
 *
 * `projectRoot`/`stateHome` are injected explicitly (not merely allowed through
 * from `base`) so the gate process agy spawns for every tool call resolves the
 * *same* project root and state home this server did — without them, the gate's
 * own `openStore()` re-derives its root from its own `process.cwd()` (the
 * workspace directory, not necessarily what `AGY_WORKER_PROJECT` pinned) and can
 * open a different, empty database, silently disabling the whole policy gate
 * (finding 10).
 */
export function buildChildEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides?: { projectRoot?: string; stateHome?: string },
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ALLOWED_ENV_KEYS) {
    const value = base[key]
    if (typeof value === 'string' && value.length > 0) env[key] = value
  }
  if (overrides?.projectRoot) env[ENV.PROJECT_ROOT] = overrides.projectRoot
  if (overrides?.stateHome) env[ENV.STATE_HOME] = overrides.stateHome
  return env
}

/** Resolved agy executable: `AGY_WORKER_AGY_BIN`, else `agy` from PATH. */
export function resolveAgyBin(): string {
  const override = process.env[ENV.AGY_BIN]
  return override && override.trim() ? override.trim() : 'agy'
}

export interface SpawnAgyOptions {
  config: EffectiveConfig
  paths: JobPaths
  /** Open a pipe on fd 0 so the inbox relay can write turns. Session mode only. */
  stdinPipe: boolean
}

export interface SpawnResult {
  pid: number
  /** Equals `pid` because `detached: true` makes the child a group leader. */
  pgid: number
  procStartTime: string | null
  startedAt: number
  /** The live child handle. The runner needs this to await exit and to end stdin. */
  child: ChildProcess
  /** agy's stdin, when `stdinPipe` was requested. Never a pipe for stdout/stderr. */
  stdin: Writable | null
}

/**
 * Spawn agy detached, with stdout and stderr pointed at real file descriptors.
 *
 * ⚠ Do not use `'pipe'` for stdout/stderr. Pass fds from `fs.openSync` directly in
 * the `stdio` array: with a pipe, the child dies of EPIPE the moment the client
 * that spawned it goes away, which destroys the entire detached design
 * (`docs/01` 결정 1). File redirection still flushes incrementally (§8).
 *
 * `detached: true` also gives the child its own process group, which is what makes
 * a whole-tree kill possible later.
 */
export function spawnAgyDetached(opts: SpawnAgyOptions): SpawnResult {
  const { config, stdinPipe } = opts
  const outFd = openSync(opts.paths.events, 'a')
  const errFd = openSync(opts.paths.stderr, 'a')

  let child: ChildProcess
  try {
    const stdio: StdioOptions = [stdinPipe ? 'pipe' : 'ignore', outFd, errFd]
    child = spawn(config.agy_bin, config.argv, {
      cwd: config.cwd,
      env: config.env,
      detached: true,
      stdio,
    })
  } finally {
    // Node dups fds passed as numbers into the child; closing our copies here
    // does not affect the child's descriptors and avoids leaking fds across the
    // lifetime of a long-running job.
    closeSync(outFd)
    closeSync(errFd)
  }

  const startedAt = Date.now()
  const pid = child.pid
  if (pid == null) {
    throw new Error(`agy-worker: spawn of "${config.agy_bin}" produced no pid`)
  }
  // detached:true makes the child the leader of a brand-new process group, so its
  // pgid equals its pid — this is what later lets us `kill(-pgid)` the whole tree.
  const pgid = pid
  const procStartTime = getProcStartTime(pid)

  return {
    pid,
    pgid,
    procStartTime,
    startedAt,
    child,
    stdin: stdinPipe ? (child.stdin ?? null) : null,
  }
}
