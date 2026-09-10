import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'

/**
 * Our own macOS seatbelt profile (0.3.0 PR6; measured in M9).
 *
 * Why not agy's sandbox: measured on agy 1.1.24 (M7), it refuses every shell
 * write inside the workspace, so "runs, but contained" was never on offer —
 * only "does not run". `sandbox-exec` with a profile of our own gives the
 * missing middle: the gate keeps judging intent (which command, which rule),
 * the kernel keeps the command's *effects* inside `write_roots`, including
 * writes made through an allowed interpreter (`python3 -c "open(...)"`) that
 * a string classifier cannot see.
 *
 * How it is applied: M9 showed the PreToolUse hook's `overwrite.CommandLine`
 * is honoured (the executed command changes; the model and the event stream
 * still see the original). So the gate rewrites an allowed `run_command` to
 * `sandbox-exec -p '<profile>' /bin/sh -c '<original>'` and sets
 * `BypassSandbox: true` so agy's own profile stays out of the way.
 *
 * Scope is deliberately narrow: **file writes only**. Reads are the gate's and
 * `read_roots`' business; network stays open unless the ceiling's exceptions
 * say otherwise (a later step). `(allow default)` first, then deny all writes,
 * then re-allow the roots — that ordering is what `sandbox-exec` evaluates
 * last-match-wins on.
 */

/** Write roots every command needs even when the workspace is the only real one. */
export function seatbeltImplicitWriteRoots(): string[] {
  const roots = ['/dev', '/private/tmp', '/private/var/folders']
  try {
    roots.push(realpathSync(tmpdir()))
  } catch {
    // tmpdir() unresolvable: the two /private entries cover macOS defaults.
  }
  return Array.from(new Set(roots))
}

function sbString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** The profile text for `sandbox-exec -p`. Pure: same roots, same text. */
export function seatbeltProfile(writeRoots: readonly string[]): string {
  const lines = ['(version 1)', '(allow default)', '(deny file-write*)']
  for (const root of writeRoots) {
    lines.push(`(allow file-write* (subpath ${sbString(root)}))`)
  }
  return lines.join('\n')
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** The rewritten `CommandLine` the gate hands back for an allowed command under seatbelt. */
export function seatbeltCommandLine(commandLine: string, writeRoots: readonly string[]): string {
  return `sandbox-exec -p ${shQuote(seatbeltProfile(writeRoots))} /bin/sh -c ${shQuote(commandLine)}`
}

/** `sandbox-exec` is macOS only; the policy resolver refuses seatbelt elsewhere. */
export function seatbeltAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin'
}
