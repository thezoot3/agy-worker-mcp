import { homedir } from 'node:os'

import { ValidationError } from '../contract/errors.js'
import { canonicalize } from '../contract/paths.js'
import type {
  EffectivePolicy,
  NetworkPolicy,
  OnDenial,
  Profile,
  RequestedPermissions,
} from '../contract/types.js'
import { buildRoots } from './containment.js'
import { intersectAllow } from './rules.js'

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
  network: NetworkPolicy
  /** Whether a client request may raise `network` to `allow` at all. */
  networkOptIn: boolean
  /** Verdict when nothing matched (`docs/03` §1.3 step 4). */
  defaultDecision: 'ask' | 'deny'
  /**
   * Whether a broad interpreter rule (`command(python)`) may be granted at all.
   * That is effectively arbitrary code execution, so `research_readonly` refuses
   * it outright (`docs/03` §1.8).
   */
  allowInterpreters: boolean
}

const HOME = homedir()

/**
 * Rules no client request can remove (`docs/03` §1.8). Applied after everything
 * else so a permissive profile or a crafted request cannot shadow them.
 *
 * `rm -rf`, `git push`, `sudo`, `curl` are named explicitly in the doc. The
 * credential paths are the ordinary, non-agy-specific locations "자격증명 경로" is
 * pointing at — not a guess about agy's own behaviour.
 */
export const HARD_DENY: readonly string[] = [
  'command(rm -rf)',
  'command(git push)',
  'command(sudo)',
  'command(curl)',
  `read_file(${HOME}/.ssh/**)`,
  `read_file(${HOME}/.aws/**)`,
  `read_file(${HOME}/.gnupg/**)`,
  `read_file(${HOME}/.netrc)`,
]

/** MVP ships exactly two (`docs/03` §1.7, `docs/04` scope cut). */
export const PROFILES: Readonly<Record<Profile, ProfileDef>> = Object.freeze({
  research_readonly: {
    name: 'research_readonly',
    description:
      '읽기 전용 조사. 워크스페이스 안 읽기와 얕은 git 조회만 허용하고, 쓰기와 인터프리터 실행은 전부 차단한다.',
    write: false,
    allow: [
      'read_file({workspace}/**)',
      'command(git status|log|diff)',
      'command(rg)',
      'command(ls)',
      'command(cat)',
      'command(wc)',
    ],
    deny: ['write_file(*)', 'command(python)', 'command(node)', 'command(pip)', 'fetch(*)'],
    network: 'deny',
    networkOptIn: false,
    defaultDecision: 'deny',
    allowInterpreters: false,
  },
  general_worker: {
    name: 'general_worker',
    description:
      '워크스페이스 안 읽기/쓰기와 git/pytest 를 허용하는 일반 작업 profile. push, 설치, 삭제, 권한 상승은 하드 차단된다. ⚠ 신뢰 경계가 아니다: default_decision 이 ask 라 deny 목록에 없는 임의 셸 명령이 통과하고, agy 의 --sandbox 는 워크스페이스 밖 파일 쓰기를 막지 않는다 (실측, docs/02 §4-c). 셸 리다이렉션으로 워크스페이스를 벗어나는 것은 게이트가 막지만, 허용된 인터프리터(python -c 등)를 통한 쓰기는 막지 못한다. 신뢰할 수 없는 프롬프트에는 research_readonly 를 쓸 것.',
    write: true,
    allow: [
      'read_file({workspace}/**)',
      'write_file({workspace}/**)',
      'command(git status|log|diff|add|commit)',
      'command(python -m pytest)',
    ],
    deny: ['command(git push)', 'command(pip install)', 'command(rm)', 'command(sudo)'],
    network: 'deny',
    networkOptIn: true,
    defaultDecision: 'ask',
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
}

/**
 * Merge profile ceiling with client request into the policy the gate will read.
 *
 * Direction is fixed: `allow` is the **intersection** of the request with the
 * profile ceiling, `deny` is the **union** of profile deny, `HARD_DENY`, and the
 * request. Clients narrow; they never widen. Requested allows that the ceiling
 * refuses come back in `rejected_allow` so the caller learns why.
 *
 * An absent `requested.allow` (as opposed to an empty array) means "no
 * narrowing requested" — the caller gets the full profile ceiling.
 */
export function resolvePolicy(input: ResolvePolicyInput): EffectivePolicy {
  const def = getProfile(input.profile)
  const workspace = canonicalize(input.workspace)
  const ceilingAllow = def.allow.map((rule) => rule.replaceAll('{workspace}', workspace))

  let allow: string[]
  let rejectedAllow: string[]
  if (input.requested?.allow === undefined) {
    allow = ceilingAllow
    rejectedAllow = []
  } else {
    const { allowed, rejected } = intersectAllow(input.requested.allow, ceilingAllow)
    allow = allowed
    rejectedAllow = rejected
  }

  const deny = Array.from(
    new Set([...def.deny, ...HARD_DENY, ...(input.requested?.deny ?? [])]),
  )

  let network: NetworkPolicy = def.network
  if (input.requested?.network === 'allow' && def.networkOptIn) network = 'allow'
  if (input.requested?.network === 'deny') network = 'deny'

  const roots = buildRoots(workspace)

  return {
    profile: def.name,
    workspace,
    read_roots: roots.read,
    write_roots: roots.write,
    allow,
    deny,
    network,
    default_decision: def.defaultDecision,
    on_denial: input.onDenial ?? 'continue',
    rejected_allow: rejectedAllow,
  }
}

/** Descriptor list for `agy_capabilities`. */
export function describeProfiles(): Array<{
  name: Profile
  description: string
  write: boolean
  network: NetworkPolicy
  default_decision: 'ask' | 'deny'
}> {
  return Object.values(PROFILES).map((def) => ({
    name: def.name,
    description: def.description,
    write: def.write,
    network: def.network,
    default_decision: def.defaultDecision,
  }))
}
