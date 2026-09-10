import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { canonicalize, isWithin, stateHome } from '../contract/paths.js'

function canonicalHome(): string {
  try {
    return realpathSync.native(homedir())
  } catch {
    return homedir()
  }
}

const HOME = canonicalHome()

/**
 * Rules nothing can remove — not a client request, not the human ceiling's
 * `exceptions` (see docs/permissions.md).
 *
 * 0.3.0 narrowed this list to what protects the gate itself. `rm -rf`,
 * `git push`, `sudo`, `curl` moved to `general_worker`'s own deny list, where a
 * project ceiling can lift them one by one: those are policy, and policy is
 * the human's call. What stays here is integrity, not policy:
 *
 * - the credential paths are standard, non-agy-specific credential locations —
 *   not a guess about agy's own behaviour;
 * - `write_file({workspace}/.agents/**)` is I6: the gate's own hook wiring
 *   must stay write-protected even under a
 *   hand-crafted `permissions.allow`. It is also enforced structurally in
 *   `decide()`'s containment stage (so it holds even if this entry were ever
 *   dropped), but belongs on the hard-deny list too since deny is checked
 *   ahead of allow;
 * - subagent tools are refused structurally (`unsupported`, M2), so they need
 *   no rule string here.
 *
 * Lives in its own module because `policy/ceiling.ts` must consult it (an
 * `exceptions` entry naming one of these is a file error) while
 * `policy/profiles.ts` imports `ceiling.ts` — a single home avoids the cycle.
 */
export const HARD_DENY: readonly string[] = [
  `read_file(${HOME}/.ssh/**)`,
  `read_file(${HOME}/.aws/**)`,
  `read_file(${HOME}/.gnupg/**)`,
  `read_file(${HOME}/.netrc)`,
  `read_file(${HOME}/.npmrc)`,
  `read_file(${HOME}/.git-credentials)`,
  `read_file(${HOME}/.config/gh/**)`,
  `read_file(${HOME}/.config/gcloud/**)`,
  `read_file(${HOME}/.docker/config.json)`,
  `read_file(${HOME}/.kube/**)`,
  'write_file({workspace}/.agents/**)',
]

export const COMMAND_CREDENTIAL_ROOTS: readonly string[] = [
  `${HOME}/.ssh`,
  `${HOME}/.aws`,
  `${HOME}/.gnupg`,
  `${HOME}/.config/gh`,
  `${HOME}/.config/gcloud`,
  `${HOME}/.npmrc`,
  `${HOME}/.git-credentials`,
  `${HOME}/.netrc`,
  `${HOME}/.docker/config.json`,
  `${HOME}/.kube`,
  `${HOME}/.gemini`,
  `${HOME}/.antigravity`,
  `${HOME}/.agy-worker`,
]

export function isCredentialPath(target: string): boolean {
  const resolved = canonicalize(target)
  const roots = [
    ...COMMAND_CREDENTIAL_ROOTS.map(canonicalize),
    canonicalize(stateHome()),
  ]
  for (const root of roots) {
    if (resolved === root || isWithin(resolved, root)) {
      return true
    }
  }
  return false
}

