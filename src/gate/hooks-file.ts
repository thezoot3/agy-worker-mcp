import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { readJsonIfExists, writeJsonAtomic } from '../contract/paths.js'

/**
 * Single owner of `<workspace>/.agents/hooks.json`'s lifecycle: `start.ts` writes
 * our entry when a job spawns, `reconcile.ts` removes it once no live job on that
 * `cwd` needs it any more. Kept in one module — with the key constant — so the two
 * call sites can never drift on what "our entry" means.
 */

/** The one key this package ever writes into `hooks.json`. Never touch any other key. */
export const GATE_HOOK_KEY = 'agy-worker-gate'

export function hooksFilePath(workspace: string): string {
  return join(workspace, '.agents', 'hooks.json')
}

/** Single-quote for a POSIX `sh -c` string, escaping any embedded `'`. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Write (merging, never clobbering unrelated keys) `<workspace>/.agents/hooks.json`
 * so the PreToolUse gate loads for this workspace. `--add-dir` is what makes agy
 * load it at all (see docs/permissions.md) — this is the piece that puts the
 * file there in the first place, since nothing else in the package owns it.
 *
 * The command is just `node '<gatePath>'` — quoted (an unquoted absolute path
 * breaks on any install path containing a space). There used to be a
 * `|| printf '{"decision":"ask"}'` fallback here; it is gone. agy already fails closed on its own —
 * empty/non-JSON stdout or a non-zero exit is a *denial*, not a pass-through
 * (measured against 1.1.23, `src/gate/gate.ts`'s own header comment) — so the
 * fallback never protected anything: its only effect was to convert that
 * already-safe failure into `{"decision":"ask"}`, which in print mode reaches
 * agy's built-in engine and lets a `run_command` call proceed with whatever
 * `BypassSandbox` value the model itself asked for (M3-C) — the exact hole I2 exists to close.
 * Losing the fallback also means `ensureGateHook` must only ever be called once
 * `gatePath` is confirmed to exist (`agy_start`'s own `existsSync` check).
 *
 * Our key is written **first** in the object, ahead of every pre-existing key.
 * Measured (M6): agy evaluates
 * `hooks.json`'s PreToolUse groups in declaration order and a `deny` from an
 * earlier group short-circuits the rest — a group installed ahead of ours that
 * denies would mean our gate never runs at all for that call, and the runtime
 * watchdog (`src/runner/gate-watchdog.ts`) would misread the resulting silence
 * in `gate-log.jsonl` as "hooks never loaded". Writing ours first guarantees it
 * runs on every tool call regardless of what else is declared in this file.
 * (A hook group installed *outside* this file entirely — e.g. a user's global
 * `~/.gemini/config/hooks.json` — that denies ahead of ours is the one case
 * this cannot cover; the watchdog still reports it correctly if bluntly, as
 * "gate never fired", which is safe — fail closed — just imprecise about why.
 * Not handled here, by design.)
 */
export function ensureGateHook(workspace: string, gatePath: string): void {
  const hooksPath = hooksFilePath(workspace)
  const existing = readJsonIfExists<Record<string, unknown>>(hooksPath) ?? {}
  const command = `node ${shQuote(gatePath)}`
  const ours = {
    PreToolUse: [
      {
        matcher: '*',
        hooks: [{ type: 'command', command, timeout: 15 }],
      },
    ],
  }
  delete existing[GATE_HOOK_KEY]
  const merged: Record<string, unknown> = { [GATE_HOOK_KEY]: ours, ...existing }
  writeJsonAtomic(hooksPath, merged)
}

/**
 * Remove only {@link GATE_HOOK_KEY} from `<workspace>/.agents/hooks.json`,
 * preserving every other key untouched. Deletes the file when it held nothing
 * else, and the `.agents` directory when that leaves it empty. A no-op when the
 * file does not exist or never carried our key.
 *
 * Best effort by design: called from
 * `reconcile`, which must never fail a tool call over hook-file housekeeping. A
 * stale entry left behind by a failure here is harmless until the next
 * `agy_start` on the same workspace, which overwrites it unconditionally.
 */
export function removeGateHook(workspace: string): void {
  try {
    const hooksPath = hooksFilePath(workspace)
    const existing = readJsonIfExists<Record<string, unknown>>(hooksPath)
    if (!existing || !(GATE_HOOK_KEY in existing)) return

    delete existing[GATE_HOOK_KEY]

    if (Object.keys(existing).length > 0) {
      writeJsonAtomic(hooksPath, existing)
      return
    }

    rmSync(hooksPath, { force: true })
    const agentsDir = join(workspace, '.agents')
    try {
      if (existsSync(agentsDir) && readdirSync(agentsDir).length === 0) {
        rmSync(agentsDir, { recursive: true, force: true })
      }
    } catch {
      // Best effort — an unreadable/already-gone directory is not a failure.
    }
  } catch {
    // Best effort — reconcile must never break over hook-file housekeeping.
  }
}
