import { assertContained, canonicalize, containedOrNull } from '../contract/paths.js'

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
