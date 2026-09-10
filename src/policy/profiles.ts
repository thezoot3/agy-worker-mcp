import { ValidationError } from '../contract/errors.js'
import { canonicalize } from '../contract/paths.js'
import type {
  EffectivePolicy,
  OnDenial,
  Profile,
  RequestedPermissions,
  SandboxMode,
} from '../contract/types.js'
import {
  additionalDirCovered,
  additionalDirRoot,
  EMPTY_CEILING,
  resolveRequestedDir,
  type Ceiling,
} from './ceiling.js'
import { buildRoots } from './containment.js'
import { HARD_DENY } from './hard-deny.js'
import { intersectAllow } from './rules.js'
import { seatbeltAvailable, seatbeltImplicitWriteRoots } from './seatbelt.js'

const SANDBOX_RANK: Record<SandboxMode, number> = { none: 0, seatbelt: 1, agy: 2 }

export interface ProfileDef {
  name: Profile
  description: string
  /** Whether jobs on this profile take the `cwd_write` lock. */
  write: boolean
  /** Ceiling. A client request can only intersect with this, never extend it.
   *  `{workspace}` is substituted with the job's canonical workspace at
   *  `resolvePolicy` time. */
  allow: string[]
  /** Always applied, on top of `HARD_DENY`. */
  deny: string[]
  /**
   * Whether allowed run_command calls on this profile emit `BypassSandbox: true` by default (I2).
   * True on general_worker; always false on research_readonly.
   */
  bypassSandbox: boolean
  /**
   * Whether a broad interpreter rule (`command(python)`) may be granted at all.
   * That is effectively arbitrary code execution, so `research_readonly` refuses
   * it outright (see docs/permissions.md).
   */
  allowInterpreters: boolean
}

export { HARD_DENY } from './hard-deny.js'

/** Built-in profiles (see docs/permissions.md). */
export const PROFILES: Readonly<Record<Profile, ProfileDef>> = Object.freeze({
  research_readonly: {
    name: 'research_readonly',
    description:
      'Read-only research. Allows reads inside the workspace and shallow git inspection; blocks all writes and interpreter execution. OS sandbox is always enabled (BypassSandbox: false).',
    write: false,
    allow: [
      // `{workspace}/**` covers everything *below* the root; the root itself is
      // what `list_dir`/`find_by_name`/`grep_search` name when they start at
      // the workspace, so it needs its own rule (measured 2026-09-03: without
      // it every top-level listing was denied).
      'read_file({workspace})',
      'read_file({workspace}/**)',
      'command(git status|log|diff)',
      'command(rg)',
      'command(ls)',
      'command(cat)',
      'command(wc)',
    ],
    deny: ['write_file(*)', 'command(python)', 'command(node)', 'command(pip)', 'fetch(*)'],
    bypassSandbox: false,
    allowInterpreters: false,
  },
  general_worker: {
    name: 'general_worker',
    description:
      'Workspace development worker. Network (curl/wget/ssh/scp), remote git (push), package managers, containers, sudo, and destructive git commands are blocked by default and can only be enabled via exceptions in the project ceiling policy.json (0.3.0). Reads/writes within the workspace, local git operations, common build/test commands (gradle, maven, npm test/run, javac/java, pytest), basic utilities, and python3 -c / node -e / bash -c are allowed. bash -c "<s>" undergoes recursive evaluation, so inner commands must also be allowed to pass. Any shell command not in this list is denied (allowlist; can be switched to ceiling command_policy: denylist) — a bound job\'s gate never issues an "ask" decision (I1). Subagent tools are always denied because they run in a separate conversation and can bypass this job\'s policy (M2). {workspace}/.agents is always write-protected against all writes including shell redirection because it holds the gate\'s own hook configuration (I6). Allowed run_command executions run without agy\'s OS sandbox by default (BypassSandbox: true, I2); sandboxing can be enforced by ceiling (sandbox: "agy") or request (permissions.sandbox: "agy").',
    write: true,
    // The build commands are here for `intersectAllow`, not just the gate:
    // without them in the ceiling, a client asking for them in
    // `permissions.allow` bounces into `rejected_allow` — which, measured,
    // collapsed the whole effective allow list to [] and silently took the
    // profile's own defaults with it.
    allow: [
      // `{workspace}/**` covers everything *below* the root; the root itself is
      // what `list_dir`/`find_by_name`/`grep_search` name when they start at
      // the workspace, so it needs its own rule (measured 2026-09-03: without
      // it every top-level listing was denied).
      'read_file({workspace})',
      'read_file({workspace}/**)',
      'write_file({workspace}/**)',
      'command(git)',
      'command(ls)',
      'command(cat)',
      'command(head)',
      'command(tail)',
      'command(wc)',
      'command(grep)',
      'command(rg)',
      'command(find)',
      'command(stat)',
      'command(sed)',
      'command(sort)',
      'command(uniq)',
      'command(diff)',
      'command(cut)',
      'command(tr)',
      'command(basename)',
      'command(dirname)',
      'command(realpath)',
      'command(which)',
      'command(pwd)',
      'command(echo)',
      'command(printf)',
      'command(test)',
      'command(true)',
      'command(false)',
      'command(mkdir)',
      'command(touch)',
      'command(cp)',
      'command(mv)',
      'command(rm)',
      'command(tee)',
      'command(python3 -c)',
      'command(python3)',
      'command(python -c)',
      'command(node -e)',
      'command(node)',
      'command(bash -c)',
      'command(sh -c)',
      'command(python -m pytest)',
      'command(pytest)',
      'command(./gradlew)',
      'command(gradle)',
      'command(mvn)',
      'command(npm test)',
      'command(npm run)',
      'command(javac)',
      'command(java)',
    ],
    // Everything here can be lifted, rule by rule, through the project
    // ceiling's `exceptions` (0.3.0). Grouped by why it is denied by default:
    deny: [
      // network / remote: data can leave the machine
      'command(curl)',
      'command(wget)',
      'command(ssh)',
      'command(scp)',
      'command(git push)',
      // privilege / containers
      'command(sudo)',
      'command(docker)',
      // destructive
      'command(rm -rf)',
      'command(git reset --hard)',
      'command(git clean)',
      'command(git filter-branch)',
      'command(git branch -D)',
      'command(git worktree)',
      'command(git stash drop)',
      'command(git remote add)',
      'command(git remote set-url)',
      'command(git config --global)',
      'command(git checkout -- .)',
      'command(git restore .)',
      'command(git restore --staged .)',
      // installs
      'command(pip install)',
      'command(npm install)',
    ],
    bypassSandbox: true,
    allowInterpreters: true,
  },
})

/** @throws {import('../contract/errors.js').ValidationError} listing the valid profiles. */
export function getProfile(name: string): ProfileDef {
  const def = (PROFILES as Record<string, ProfileDef>)[name]
  if (!def) {
    throw new ValidationError({
      field: 'profile',
      value: name,
      expected: 'a known profile',
      allowed: Object.keys(PROFILES),
    })
  }
  return def
}

export interface ResolvePolicyInput {
  profile: Profile
  /** Canonical workspace. Becomes the read/write root and the forced `Cwd`. */
  workspace: string
  requested?: RequestedPermissions
  onDenial?: OnDenial
  maxDenials?: number | null
  /**
   * The human-owned ceiling (`policy/ceiling.ts`, see `docs/permissions.md`).
   * Defaults to {@link EMPTY_CEILING} so a caller with no ceiling file — or
   * a unit test exercising `resolvePolicy` on its own — gets exactly PR2/PR3's
   * behaviour: `read_roots` resolves to `[]`, `sandboxed` to false,
   * `allow`/`deny` are unaffected. The gate's own v1-`policy.json` tolerance (a
   * missing `add_dirs` field reads as `[]`) is the same shape of
   * fallback, one layer further out.
   */
  ceiling?: Ceiling
  /**
   * Canonical directories outside the workspace that the server itself linked
   * into it (`isolation: 'worktree'`). Not caller-supplied: computed from the
   * ceiling's `link_paths` and the links actually created.
   */
  linkedRoots?: string[]
}

/**
 * Merge profile ceiling, human ceiling, and client request into the policy the
 * gate will read.
 *
 * Direction is fixed throughout: a client only ever narrows within what the
 * human ceiling grants, and the human ceiling only ever narrows within (or
 * adds alongside) what the profile permits — nothing here can widen past
 * `HARD_DENY`. Concretely:
 *
 * - `allow` = intersection of `requested.allow` (or, absent, everything) with
 *   `profile.allow ∪ ceiling.allow` (the "allow ceiling"). Rejected
 *   entries land in `rejected_allow`.
 * - `deny` = union of `profile.deny`, `HARD_DENY`, `ceiling.deny`, and
 *   `requested.deny`. A client can only add to it, never remove from it.
 * - `sandbox` = strictest of profile (`agy` on research_readonly), ceiling
 *   `sandbox`, and request `sandbox` / `sandboxed`; `bypass_sandbox` and
 *   `sandbox_forced_by` are derived from it.
 * - `add_dirs` = when `requested.read_roots` is absent, all entries
 *   from `ceiling.read_roots` resolved via `additionalDirRoot`; when
 *   present, the requested list filtered to entries matching some glob in
 *   `ceiling.read_roots`. Non-matching entries land in `rejected_read_roots`.
 *
 * An absent `requested.allow` (as opposed to an empty array) means "no
 * narrowing requested" — the caller gets the full allow ceiling.
 */
export function resolvePolicy(input: ResolvePolicyInput): EffectivePolicy {
  const def = getProfile(input.profile)
  const workspace = canonicalize(input.workspace)
  const substitute = (rule: string) => rule.replaceAll('{workspace}', workspace)
  const ceiling = input.ceiling ?? EMPTY_CEILING
  const linkedRoots = (input.linkedRoots ?? []).map(canonicalize)
  const linkedRules = linkedRoots.flatMap((r) => [
    `read_file(${r})`,
    `read_file(${r}/**)`,
  ])
  const ceilingAllow = [...def.allow, ...ceiling.allow].map(substitute).concat(linkedRules)
  // HARD_DENY carries `write_file({workspace}/.agents/**)` (I6), so it needs
  // the same substitution the allow ceiling already got — unsubstituted, the
  // literal string `{workspace}` would never match any real path.
  const hardDeny = HARD_DENY.map(substitute)

  let allow: string[]
  let rejectedAllow: string[]
  if (input.requested?.allow === undefined) {
    allow = ceilingAllow
    rejectedAllow = []
  } else {
    const { allowed, rejected } = intersectAllow(input.requested.allow, ceilingAllow)
    allow = Array.from(new Set([...allowed, ...linkedRules]))
    rejectedAllow = rejected
  }

  // `exceptions` (0.3.0): the human ceiling lifts profile deny rules by exact
  // string match — `command(git)` does not lift `command(git push)`, so no
  // specificity comparison is needed. HARD_DENY is unioned *after* the
  // subtraction and `loadCeiling` already refuses a file naming one of its
  // rules, so nothing here can widen past it. `research_readonly` ignores
  // exceptions entirely: a read-only profile has nothing to lift.
  const exceptions = def.write ? new Set(ceiling.exceptions) : new Set<string>()
  const profileDeny = def.deny.filter((rule) => !exceptions.has(rule))
  const lifted = def.deny.filter((rule) => exceptions.has(rule))
  const ignoredExceptions = ceiling.exceptions.filter((rule) => !def.deny.includes(rule))
  const deny = Array.from(
    new Set([
      ...profileDeny,
      ...hardDeny,
      ...ceiling.deny.map(substitute),
      ...(input.requested?.deny ?? []),
    ]),
  )

  // `sandbox` (0.3.0 PR6): the strictest of profile / ceiling / request wins,
  // ordered none < seatbelt < agy. research_readonly is always `agy` (the OS
  // enforces read-only for free, 0.2.1). `bypass_sandbox` / `sandbox_forced_by`
  if (input.requested && 'sandboxed' in input.requested && (input.requested as Record<string, unknown>).sandboxed !== undefined) {
    throw new ValidationError({
      field: 'permissions.sandbox',
      value: (input.requested as Record<string, unknown>).sandboxed,
      expected: 'the legacy "sandboxed" request field was removed in 0.4.0; write "sandbox": "agy" (or "seatbelt") instead',
    })
  }
  const requestedSandbox: SandboxMode | null = input.requested?.sandbox ?? null
  let sandbox: SandboxMode
  let sandboxSource: 'profile' | 'ceiling' | 'request' | 'default'
  if (!def.write) {
    sandbox = 'agy'
    sandboxSource = 'profile'
  } else {
    sandbox = 'none'
    sandboxSource = 'default'
    if (SANDBOX_RANK[ceiling.sandbox] > SANDBOX_RANK[sandbox]) {
      sandbox = ceiling.sandbox
      sandboxSource = 'ceiling'
    }
    if (requestedSandbox !== null && SANDBOX_RANK[requestedSandbox] > SANDBOX_RANK[sandbox]) {
      sandbox = requestedSandbox
      sandboxSource = 'request'
    }
  }
  if (sandbox === 'seatbelt' && !seatbeltAvailable()) {
    throw new ValidationError({
      field: 'sandbox',
      value: 'seatbelt',
      expected: `sandbox-exec is macOS only (platform ${process.platform}); set sandbox to "none" or "agy" in ${sandboxSource === 'ceiling' ? 'the project ceiling' : 'permissions.sandbox'}`,
    })
  }
  const bypassSandbox = sandbox !== 'agy'
  const sandboxForcedBy = sandbox === 'agy' && sandboxSource !== 'default' ? sandboxSource : null

  // `read_roots` (0.2.2 PR4, renamed 0.3.0): applied from ceiling by default when absent.
  // When present, narrows within ceiling globs (subset only).
  const additionalDirs: string[] = []
  const rejectedAdditionalDirs: string[] = []
  const warnings: string[] = [...ceiling.warnings]
  if (!def.write && ceiling.exceptions.length > 0) {
    warnings.push(`ceiling exceptions do not apply to ${def.name} (read-only profiles have no deny rules to lift)`)
  }
  for (const rule of ignoredExceptions) {
    if (def.write) warnings.push(`ceiling exceptions entry ${rule} is not in ${def.name}'s deny list and was ignored`)
  }
  let additionalDirsSource: 'ceiling' | 'request' | 'none'

  if (input.requested?.read_roots === undefined) {
    for (const pattern of ceiling.read_roots) {
      const root = additionalDirRoot(pattern)
      if (root !== null) {
        if (!additionalDirs.includes(root)) {
          additionalDirs.push(root)
        }
      } else {
        warnings.push(`ceiling read_roots entry ${pattern} does not exist and was skipped`)
      }
    }
    additionalDirsSource = additionalDirs.length > 0 ? 'ceiling' : 'none'
  } else {
    for (const raw of input.requested.read_roots) {
      const resolved = resolveRequestedDir(raw)
      if (additionalDirCovered(ceiling, resolved)) {
        if (!additionalDirs.includes(resolved)) {
          additionalDirs.push(resolved)
        }
      } else {
        rejectedAdditionalDirs.push(raw)
      }
    }
    additionalDirsSource = 'request'
  }
  for (const root of linkedRoots) {
    if (!additionalDirs.includes(root)) {
      additionalDirs.push(root)
    }
  }
  const roots = buildRoots(workspace, additionalDirs)
  // Ceiling `write_roots` widen containment (and the seatbelt) beyond the
  // workspace. A write root is also readable — you cannot edit what you
  // cannot see — so it joins read_roots too.
  const writeRoots = Array.from(new Set([...roots.write, ...ceiling.write_roots]))
  const readRoots = Array.from(new Set([...roots.read, ...ceiling.write_roots]))
  const seatbeltWriteRoots = Array.from(new Set([...writeRoots, ...seatbeltImplicitWriteRoots()]))

  return {
    profile: def.name,
    workspace,
    read_roots: readRoots,
    write_roots: writeRoots,
    allow,
    deny,
    sandbox,
    sandbox_source: sandboxSource,
    seatbelt_write_roots: seatbeltWriteRoots,
    bypass_sandbox: bypassSandbox,
    sandbox_forced_by: sandboxForcedBy,
    add_dirs: additionalDirs,
    add_dirs_source: additionalDirsSource,
    command_policy: ceiling.command_policy,
    ceiling_present: ceiling.present,
    ceiling_path: ceiling.path,
    policy_version: 3,
    on_denial: input.onDenial ?? 'continue',
    max_denials: input.maxDenials ?? null,
    lifted: lifted.map(substitute),
    rejected_allow: rejectedAllow,
    rejected_read_roots: rejectedAdditionalDirs,
    warnings: warnings.length > 0 ? warnings : undefined,
  }
}

/** Descriptor list for `agy_capabilities`. */
export function describeProfiles(): Array<{
  name: Profile
  description: string
  write: boolean
  bypass_sandbox: boolean
}> {
  return Object.values(PROFILES).map((def) => ({
    name: def.name,
    description: def.description,
    write: def.write,
    bypass_sandbox: def.bypassSandbox,
  }))
}
