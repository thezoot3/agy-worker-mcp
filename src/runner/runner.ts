import type { EffectiveConfig, JobStateFile } from '../contract/types.js'
import { ENV } from '../contract/types.js'
import {
  canonicalize,
  ensureJobDirs,
  jobPaths,
  projectPaths,
  readJsonIfExists,
  resolveProjectRoot,
  writeFileAtomic,
  writeJsonAtomic,
} from '../contract/paths.js'

import { startGateWatchdog, type GateWatchdog } from './gate-watchdog.js'
import { startIdleWatchdog, type IdleWatchdog } from './idle.js'
import { startInboxRelay, type InboxRelay } from './inbox.js'
import { killProcessGroup, sleep } from './reap.js'
import { spawnAgyDetached } from './spawn.js'
import { runVerifyCommand } from './verify.js'

/**
 * The runner: a standalone process that outlives whichever MCP server started it.
 *
 * ⚠ This module must not import anything from `src/server/**`. It has to run when
 * every server process is dead — that is its entire reason to exist.
 */
export interface RunJobOptions {
  jobId: string
  /** Canonical project root; the runner re-derives its own paths from this. */
  projectRoot: string
}

export interface RunJobResult {
  jobId: string
  exitCode: number
  /** True when the deadline fired and the process group was killed. */
  timedOut: boolean
  durationMs: number
}

function writeState(statePath: string, state: JobStateFile): void {
  writeJsonAtomic(statePath, state)
}

/**
 * Run one job to completion.
 *
 * Sequence: read `effective-config.json` → spawn detached with file-backed stdio →
 * start the inbox relay when `session_mode === 'session'` → wait for exit, racing
 * `deadline_at` → run `config.verify` once, if set and the deadline did not fire
 * (PR6 §6.2) → **always** write the final `jobs/<id>/state.json`, then
 * `jobs/<id>/exit_code`.
 *
 * `exit_code` existing is the finalization signal every server polls for; if
 * the runner can die without writing it, `reconcile` has to guess, and a job
 * that finished cleanly gets reported as `process_error`. Writing the final
 * `state.json` *first* is what makes that signal trustworthy the instant it
 * appears — see the comment at the write site.
 */
export async function runJob(opts: RunJobOptions): Promise<RunJobResult> {
  const root = canonicalize(opts.projectRoot)
  const project = projectPaths(root)
  const paths = jobPaths(project, opts.jobId)
  ensureJobDirs(paths)

  const config = readJsonIfExists<EffectiveConfig>(paths.effectiveConfig)
  if (!config) {
    throw new Error(
      `agy-worker-runner: effective-config.json missing for job ${opts.jobId} at ${paths.effectiveConfig}`,
    )
  }

  const wallStart = Date.now()

  writeState(paths.state, {
    job_id: opts.jobId,
    lifecycle: 'starting',
    pid: null,
    pgid: null,
    proc_start_time: null,
    started_at: null,
    finished_at: null,
    updated_at: Date.now(),
    phase: 'agy',
    runner_pid: process.pid,
  })

  const stdinPipe = config.session_mode === 'session'
  const spawned = spawnAgyDetached({ config, paths, stdinPipe })

  writeState(paths.state, {
    job_id: opts.jobId,
    lifecycle: 'running',
    pid: spawned.pid,
    pgid: spawned.pgid,
    proc_start_time: spawned.procStartTime,
    started_at: spawned.startedAt,
    finished_at: null,
    updated_at: Date.now(),
    phase: 'agy',
    runner_pid: process.pid,
  })

  // I4: confirm the PreToolUse gate
  // actually loaded, for every job — not just session-mode ones. Started right
  // after `spawned.pgid` exists so `onMissing` always has something to kill.
  let gateConfirmed: boolean | null = null
  const gateWatchdog: GateWatchdog = startGateWatchdog({
    eventsPath: paths.events,
    gateLogPath: paths.gateLog,
    onConfirmed: () => {
      gateConfirmed = true
    },
    onMissing: () => {
      gateConfirmed = false
      // Fire-and-forget: the main await below (the deadline race, or the bare
      // `await exitPromise`) observes the resulting exit exactly like any other
      // kill — no separate wiring needed for the exit-code / state-write path.
      void killProcessGroup(spawned.pgid)
    },
  })

  let relay: InboxRelay | null = null
  let idleWatchdog: IdleWatchdog | null = null
  let idleClosed = false
  if (stdinPipe && spawned.stdin) {
    // Idle timeout only applies to session_mode:'session' (`idle_timeout_ms`
    // is null otherwise). Created before the relay so
    // `onUserLineSent` below always has something to call.
    if (config.idle_timeout_ms != null) {
      idleWatchdog = startIdleWatchdog({
        eventsPath: paths.events,
        idleTimeoutMs: config.idle_timeout_ms,
        stdin: spawned.stdin,
        onIdleClose: () => {
          idleClosed = true
        },
      })
    }
    relay = startInboxRelay({
      inboxPath: paths.inbox,
      stdin: spawned.stdin,
      onUserLineSent: () => idleWatchdog?.noteActivity(),
      // An explicit agy_send(close:true) ends the session on its own terms;
      // stop the idle watchdog so it cannot also race to end an already-ended
      // stdin.
      onClose: () => idleWatchdog?.stop(),
    })
  }

  // Signal agy died by, if any: an `agy_cancel` / `on_denial: 'abort'` kill
  // arrives as SIGTERM/SIGKILL on the process group, and verify must not run
  // after that (see the verify block below).
  let agySignal: string | null = null
  const exitPromise = new Promise<number>((resolveExit) => {
    spawned.child.once('exit', (code, signal) => {
      if (signal) agySignal = signal
      if (code !== null) resolveExit(code)
      else resolveExit(signal ? 128 : 1)
    })
    spawned.child.once('error', () => {
      // A post-spawn error (e.g. an EPIPE writing to a stdin pipe). The process
      // may or may not still be running; treat it as a failure exit and let the
      // deadline / pgid cleanup below reconcile the rest.
      resolveExit(1)
    })
  })

  let timedOut = false
  let exitCode: number

  try {
    if (config.deadline_at != null) {
      const remaining = Math.max(0, config.deadline_at - Date.now())
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null
      const deadlineHit = new Promise<'deadline'>((res) => {
        deadlineTimer = setTimeout(() => res('deadline'), remaining)
      })

      const winner = await Promise.race([
        exitPromise.then((code): { tag: 'exit'; code: number } => ({ tag: 'exit', code })),
        deadlineHit.then((): { tag: 'deadline' } => ({ tag: 'deadline' })),
      ])
      if (deadlineTimer) clearTimeout(deadlineTimer)

      if (winner.tag === 'deadline') {
        timedOut = true
        await killProcessGroup(spawned.pgid)
        exitCode = await exitPromise
      } else {
        exitCode = winner.code
      }
    } else {
      exitCode = await exitPromise
    }
  } finally {
    relay?.stop()
    idleWatchdog?.stop()
    // finalize(), not stop(): the process is known to be gone by this point,
    // so this does one last synchronous check instead of trusting a poll tick
    // or the grace/cap timer to have already fired — both races a fast job
    // can win (see `gate-watchdog.ts`'s own doc comment on `finalize`).
    gateWatchdog.finalize()
  }

  // PR6: `verify_command` runs once,
  // after agy has exited normally, against the final workspace state — before
  // the job is recorded as finished, so a caller can never observe
  // `lifecycle: 'finished'` without `verification.verify` already settled
  // (`jobs/<id>/exit_code` is the finalization signal every server polls for;
  // see the comment on that write below).
  //
  // Skipped when the deadline killed agy (`timedOut === true`): that already
  // means the job did not run to completion, so there is nothing meaningful
  // left to verify, and `config.verify.timeout_ms` is a separate clock from
  // `deadline_at` on purpose — running it anyway could keep the job alive
  // well past a timeout the caller already asked to be enforced.
  //
  // Also skipped when agy was killed by a signal (`agy_cancel`, the gate's
  // `on_denial: 'abort'` mark reconciled into a group kill) or exited non-zero:
  // `computeOutcome` already resolves those to `canceled` / `failed` ahead of
  // anything verify could say, so running it would only keep a job the caller
  // just cancelled alive for up to `verify.timeout_ms` more.
  let verifyDone = false
  if (!timedOut && agySignal === null && exitCode === 0 && config.verify) {
    // 0.2.2 (PR1): announce the phase *before* verify starts.
    // From here until the final write below, agy's pid is gone and `exit_code`
    // does not exist — indistinguishable, to a reconciler, from a runner that
    // was killed. `phase: 'verifying'` plus `runner_pid` is what lets it wait
    // for us instead (`reconcileJob`, row 2 / row 3).
    writeState(paths.state, {
      job_id: opts.jobId,
      lifecycle: 'running',
      pid: spawned.pid,
      pgid: spawned.pgid,
      proc_start_time: spawned.procStartTime,
      started_at: spawned.startedAt,
      finished_at: null,
      updated_at: Date.now(),
      idle_closed: idleClosed,
      gate_confirmed: gateConfirmed,
      phase: 'verifying',
      runner_pid: process.pid,
    })
    const verifyRecord = await runVerifyCommand({
      command: config.verify.command,
      cwd: config.cwd,
      env: config.env,
      timeoutMs: config.verify.timeout_ms,
      logPath: paths.verifyLog,
    })
    writeJsonAtomic(paths.verifyJson, verifyRecord)
    verifyDone = true
  }

  const finishedAt = Date.now()
  // `state.json` first, `exit_code` second — deliberately reordered from a
  // naive "write both" (PR3). `exit_code`
  // existing is the signal every reconciler polls for and finalizes on the
  // instant it sees it (`reconcileJob`'s own doc comment); `exit_code` written
  // first would leave a real window where a reconciler observes it, but reads
  // `state.json` before this call has landed and gets the *previous* write
  // (the plain 'running' state, with no `timed_out`/`idle_closed`/
  // `gate_confirmed` at all) — silently losing exactly the fact PR3 depends on
  // being there every time. Writing state first makes that window impossible:
  // by the time `exit_code` exists, `state.json` already carries the complete
  // final record.
  writeState(paths.state, {
    job_id: opts.jobId,
    lifecycle: 'finished',
    pid: spawned.pid,
    pgid: spawned.pgid,
    proc_start_time: spawned.procStartTime,
    started_at: spawned.startedAt,
    finished_at: finishedAt,
    updated_at: finishedAt,
    timed_out: timedOut,
    idle_closed: idleClosed,
    gate_confirmed: gateConfirmed,
    verify_done: verifyDone,
    phase: 'done',
    runner_pid: process.pid,
  })
  writeExitCode(paths.exitCode, exitCode)

  return {
    jobId: opts.jobId,
    exitCode,
    timedOut,
    durationMs: finishedAt - wallStart,
  }
}

/**
 * Enforce the deadline: `SIGTERM` to the process group, grace period, then
 * `SIGKILL`. Signalling the *group* rather than the pid is what reaches agy's own
 * children (verified by checking `pgrep -g` afterwards).
 *
 * Standalone entry point for callers other than {@link runJob} (e.g. `reconcile`
 * discovering a job whose deadline has already passed). `runJob` itself does its
 * own cancellable wait so it is not left holding a dangling timer once the
 * process exits on its own — this function, called directly, always waits out
 * the deadline first.
 */
export async function enforceDeadline(pgid: number, deadlineAt: number, graceMs?: number): Promise<boolean> {
  const remaining = deadlineAt - Date.now()
  if (remaining > 0) await sleep(remaining)
  return killProcessGroup(pgid, { graceMs })
}

/** Write the exit code file atomically. Called on every exit path, including throws. */
export function writeExitCode(exitCodePath: string, code: number): void {
  writeFileAtomic(exitCodePath, `${code}\n`)
}

/** `dist/runner.js` entry point. Reads the job id from argv or `AGY_WORKER_JOB_ID`. */
export async function main(argv: string[] = []): Promise<number> {
  const jobId = argv[0] ?? process.env[ENV.JOB_ID]
  if (!jobId) {
    process.stderr.write(
      'agy-worker-runner: missing job id (pass it as argv[0] or set AGY_WORKER_JOB_ID)\n',
    )
    return 2
  }

  const projectRoot = resolveProjectRoot().root

  try {
    await runJob({ jobId, projectRoot })
    return 0
  } catch (e) {
    const detail = e instanceof Error ? (e.stack ?? e.message) : String(e)
    process.stderr.write(`agy-worker-runner: job ${jobId} failed: ${detail}\n`)
    return 1
  }
}
