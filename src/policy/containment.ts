import { isAbsolute, join } from 'node:path'

import { assertContained, canonicalize, containedOrNull } from '../contract/paths.js'
import { tokenizeCommand } from './rules.js'

/**
 * Read/write root enforcement.
 *
 * The primitives live in `contract/paths.ts` (`canonicalize`, `isWithin`,
 * `assertContained`); this module is the policy layer that decides which roots a
 * job gets and pulls the paths out of a tool call.
 */

export interface ContainmentRoots {
  read: string[]
  write: string[]
}

/**
 * Roots for a job. Write is the workspace alone. Read may include a small set of
 * additional canonical directories, but never credential paths.
 */
export function buildRoots(workspace: string, extraRead?: string[]): ContainmentRoots {
  const canonicalWorkspace = canonicalize(workspace)
  const read = [canonicalWorkspace, ...(extraRead ?? []).map(canonicalize)]
  return { read, write: [canonicalWorkspace] }
}

/** @throws {import('../contract/errors.js').PathEscapeError} */
export function checkRead(path: string, roots: ContainmentRoots): string {
  return assertContained(path, roots.read, 'read')
}

/** @throws {import('../contract/errors.js').PathEscapeError} */
export function checkWrite(path: string, roots: ContainmentRoots): string {
  return assertContained(path, roots.write, 'write')
}

/** A bare, unquoted, absolute-looking token inside a shell command line. */
const ABS_PATH_TOKEN = /^\/[^\s'"]*$/

/**
 * Paths a tool call would touch, split by intent.
 *
 * For `run_command` this is `Cwd` plus whatever path-looking arguments can be
 * recovered from `CommandLine` — best effort, and explicitly not the security
 * boundary. The real boundary is the sandbox plus the allow/deny rules
 * (`docs/03` §1.8); this only catches the obvious escapes.
 */
export function pathsFromToolCall(
  toolName: string,
  args: Record<string, unknown>,
): { read: string[]; write: string[] } {
  const read: string[] = []
  const write: string[] = []

  const cwd = typeof args.Cwd === 'string' ? args.Cwd : null
  if (cwd) {
    read.push(cwd)
    write.push(cwd)
  }

  if (toolName === 'run_command' && typeof args.CommandLine === 'string') {
    for (const token of args.CommandLine.split(/\s+/)) {
      if (ABS_PATH_TOKEN.test(token)) read.push(token)
    }
  }

  return { read, write }
}

/** Non-throwing containment probe over both root sets. */
export function isContainedForKind(
  path: string,
  roots: ContainmentRoots,
  kind: 'read' | 'write',
): boolean {
  return containedOrNull(path, roots[kind]) !== null
}

// ─────────────────────────────────────────────────────────────────────────────
// Shell redirection targets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `>` / `>>` / `2>` / `&>` — with an optional `|` (noclobber override). Either
 * the target follows as its own token, or it is glued on (`>/tmp/x`).
 */
const REDIRECT = /^(?:&|\d+)?>{1,2}\|?/

/**
 * Redirection targets that are not files and so cannot escape anything.
 * `2>&1` is fd duplication; `/dev/null` and friends are the standard sinks.
 */
const NON_FILE_TARGET = /^(?:&\d+|&-|\/dev\/(?:null|stdout|stderr|tty|fd\/\d+))$/

/**
 * Write targets of shell output redirection inside a `run_command` line.
 *
 * ⚠ Scope, deliberately narrow. This does **not** try to recover every path an
 * arbitrary shell command touches — that is not decidable and pretending
 * otherwise buys a false sense of safety. It recovers exactly the redirection
 * grammar, which *is* small enough to parse, and which is the escape route
 * measured live on 2026-09-01: `printf hello > /tmp/x` ran to completion under
 * `--sandbox` with the workspace registered (`docs/02` §4-c).
 *
 * Still open after this: anything an allowed interpreter writes
 * (`python -c "open('/tmp/x','w')"`). That is the documented cost of opening
 * interpreters at all (`docs/03` §1.8), not something this can close.
 *
 * Relative targets resolve against `workspace`, because the gate pins the tool's
 * `Cwd` to it on every allow.
 */
export function redirectionTargets(commandLine: string, workspace: string): string[] {
  const tokens = tokenizeCommand(commandLine)
  const targets: string[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string
    const m = REDIRECT.exec(token)
    if (!m) continue

    // `2>&1` glues the target on; `> out.txt` puts it in the next token.
    const glued = token.slice(m[0].length)
    const target = glued.length > 0 ? glued : ((tokens[++i] as string | undefined) ?? '')
    if (target.length === 0) continue
    if (NON_FILE_TARGET.test(target)) continue

    targets.push(isAbsolute(target) ? target : join(workspace, target))
  }

  return targets
}

/**
 * The first redirection target that would write outside `workspace`, or null.
 * Null also when the line has no redirection at all, which is the common case.
 */
export function escapingRedirectTarget(commandLine: string, workspace: string): string | null {
  const roots = [canonicalize(workspace)]
  for (const target of redirectionTargets(commandLine, workspace)) {
    if (containedOrNull(target, roots) === null) return target
  }
  return null
}
