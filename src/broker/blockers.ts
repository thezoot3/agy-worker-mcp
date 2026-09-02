import {
  AGY_ENGINE_REFUSAL_SIGNATURES,
  NETWORK_BLOCK_SIGNATURES,
} from '../contract/types.js'
import type {
  ArtifactCheck,
  Blocker,
  BlockerSource,
  DenialClass1,
  DenialClass2,
  EffectivePolicy,
  PolicySummary,
} from '../contract/types.js'

/**
 * The single place that answers "who refused, and can the caller fix it".
 *
 * `outcome`, the judgement packet's `counts`, `verification.warnings` and
 * `agy_start`'s own reply are all projections of the `Blocker` list built here.
 * Before 0.1.1 each of those re-derived the rule for itself, and they disagreed:
 * one real job came back with `counts.permission_denials: 1` next to
 * `outcome: "success_unverified"`, because the packet counted every Class 1
 * event while `decideOutcome` counted only the ones our gate authored.
 *
 * The mapping, and nothing may re-implement a row of it:
 *
 * | source           | what                                  | actionable | remedy                        | blocks_outcome |
 * | ---------------- | ------------------------------------- | ---------- | ----------------------------- | -------------- |
 * | `policy_ceiling` | `rejected_allow` entry (pre-flight)   | yes        | drop it / change profile      | n/a (no job yet) |
 * | `gate`           | our gate's confirmed refusal          | yes        | its `required_rule`           | yes            |
 * | `gate` (containment) | command left the workspace        | **no**     | none — no rule grants this    | yes            |
 * | `agy_engine`     | agy's own permission engine refused   | no         | none — outside our policy     | **no**         |
 * | `sandbox`        | Class 2 signature match               | network only | `permissions.network: "allow"` | yes          |
 * | `broker`         | missing `expected_artifacts` entry    | yes        | which artifact is missing     | yes            |
 * | `tool_error`     | a failing tool call, no signature     | no         | none — not a permission issue | **no**         |
 *
 * `agy_engine` and `tool_error` do not force `blocked` for the same reason:
 * a non-gate `state: 'ERROR'` step is indistinguishable from an ordinary
 * command failure by shape alone (finding 17), so treating them as blocks would
 * report every failing test as a permission problem.
 */

/** Human label per source, used by both the warning lines and the headline. */
const LABEL: Record<BlockerSource, string> = {
  policy_ceiling: 'ceiling rejection',
  gate: 'gate denial',
  agy_engine: 'agy-engine refusal',
  sandbox: 'sandbox block',
  broker: 'broker check',
  tool_error: 'tool error',
}

/**
 * Whether a non-gate refusal came from agy's own permission engine.
 *
 * Substring match against measured wording, the same technique `detectClass2`
 * uses on environment blocks and for the same reason: agy emits no structured
 * field saying who refused.
 */
export function isAgyEngineRefusal(message: string): boolean {
  return AGY_ENGINE_REFUSAL_SIGNATURES.some((sig) => message.includes(sig))
}

function isNetworkSignature(signature: string): boolean {
  return NETWORK_BLOCK_SIGNATURES.includes(signature)
}

function asDetail(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}

/**
 * A Class 1 event → the blocker it actually is.
 *
 * Three outcomes, because three different next actions: our gate refused
 * (fixable with a rule), agy's own engine refused (nothing of ours applies), or
 * a command simply failed (not a permission matter at all).
 */
export function blockerFromDenial(d: DenialClass1): Blocker {
  const base = { tool: d.tool, command: d.command, detail: asDetail(d) }

  if (d.source === 'gate') {
    if (d.policy === 'containment') {
      return {
        ...base,
        source: 'gate',
        actionable: false,
        remedy: null,
        blocks_outcome: true,
        message: `our gate refused this because it wrote outside the workspace; containment is checked before any rule, so no permissions.allow entry can grant it — change the command or the workspace. ${d.message}`,
      }
    }
    return {
      ...base,
      source: 'gate',
      actionable: true,
      remedy: d.required_rule,
      blocks_outcome: true,
      message: d.required_rule
        ? `our permission gate refused this; it is allowed by the rule ${d.required_rule}. ${d.message}`
        : `our permission gate refused this. ${d.message}`,
    }
  }

  if (isAgyEngineRefusal(d.message)) {
    return {
      ...base,
      source: 'agy_engine',
      actionable: false,
      remedy: null,
      blocks_outcome: false,
      message: `agy's own permission engine refused this, before or beside our policy — no permissions.allow rule will help, and we cannot confirm it as a block either. ${d.message}`,
    }
  }

  return {
    ...base,
    source: 'tool_error',
    actionable: false,
    remedy: null,
    blocks_outcome: false,
    message: `the tool call failed with no refusal signature we recognize, so this is not a permission problem we can confirm. ${d.message}`,
  }
}

/** A Class 2 signature match. Only the network ones are recoverable. */
export function blockerFromEnvironmentBlock(b: DenialClass2): Blocker {
  const network = isNetworkSignature(b.signature)
  return {
    source: 'sandbox',
    actionable: network,
    remedy: network
      ? 'retry with permissions.network: "allow" on a profile whose networkOptIn is true (general_worker)'
      : null,
    blocks_outcome: true,
    tool: b.tool,
    command: b.command,
    message: network
      ? `agy's sandbox blocked the network silently — signature "${b.signature}": ${b.excerpt}`
      : `agy's sandbox blocked this silently — signature "${b.signature}". The sandbox is agy's own and we cannot configure it: ${b.excerpt}`,
    detail: asDetail(b),
  }
}

/** A broker-side check that failed. Today that is only a missing expected artifact. */
export function blockerFromMissingArtifact(a: ArtifactCheck): Blocker {
  return {
    source: 'broker',
    actionable: true,
    remedy: `have the job create ${a.path}, or drop it from expected_artifacts`,
    blocks_outcome: true,
    tool: null,
    command: null,
    message: `expected artifact missing: ${a.path} (${a.absolute})`,
    detail: asDetail(a),
  }
}

/**
 * Pre-flight blockers from a resolved policy: every `permissions.allow` entry
 * the profile ceiling refused, plus the collapse case.
 *
 * `blocks_outcome` is false throughout — there is no job yet, so there is no
 * outcome to block; these never reach `verification`.
 */
export function policyCeilingBlockers(policy: EffectivePolicy): Blocker[] {
  const blockers: Blocker[] = policy.rejected_allow.map(
    (rule): Blocker => ({
      source: 'policy_ceiling',
      actionable: true,
      remedy: `drop ${rule} from permissions.allow, or start on a profile whose ceiling covers it`,
      blocks_outcome: false,
      tool: null,
      command: null,
      message: `permissions.allow entry ${rule} is outside the ${policy.profile} ceiling and was dropped; clients can only narrow a profile, never widen it`,
      detail: { rule, profile: policy.profile },
    }),
  )

  // The trap this exists for: `allow` is the *intersection* of the request with
  // the ceiling, so a request that the ceiling refuses wholesale leaves `allow`
  // empty — taking the profile's own defaults (read/write, git, pytest …) with
  // it. Measured: a request of three build commands collapsed a general_worker
  // job's allow list to [] and nothing in the reply said so.
  if (policy.allow.length === 0) {
    blockers.push({
      source: 'policy_ceiling',
      actionable: true,
      remedy: 'start again with no permissions.allow at all, which restores the full profile ceiling',
      blocks_outcome: false,
      tool: null,
      command: null,
      message: `the effective allow list is empty: allow is intersected with the ${policy.profile} ceiling, so a fully rejected request also drops the profile's own default allowances. Nothing is explicitly allowed on this job.`,
      detail: { profile: policy.profile, rejected_allow: policy.rejected_allow },
    })
  }

  return blockers
}

/**
 * One warning line per blocker. The only renderer — a caller must never have to
 * infer "can I fix this" from prose wording.
 */
export function renderBlocker(b: Blocker): string {
  const where = b.tool ? ` [${b.tool}${b.command ? `: ${b.command}` : ''}]` : ''
  const tail = b.actionable
    ? ` — remedy: ${b.remedy ?? 'see message'}`
    : ' — not actionable: no permissions.allow rule will change this.'
  return `${LABEL[b.source]}${where}: ${b.message}${tail}`
}

export function renderBlockers(blockers: Blocker[]): string[] {
  return blockers.map(renderBlocker)
}

/**
 * `1 gate denial (actionable), 1 sandbox block` — grouped by source, in first
 * appearance order, so a headline says who refused without listing everything.
 */
export function summarizeBlockers(blockers: Blocker[]): string {
  const order: BlockerSource[] = []
  const groups = new Map<BlockerSource, { count: number; actionable: number }>()
  for (const b of blockers) {
    let g = groups.get(b.source)
    if (!g) {
      g = { count: 0, actionable: 0 }
      groups.set(b.source, g)
      order.push(b.source)
    }
    g.count++
    if (b.actionable) g.actionable++
  }
  return order
    .map((source) => {
      const g = groups.get(source)!
      const label = `${g.count} ${LABEL[source]}${g.count === 1 ? '' : 's'}`
      return g.actionable > 0 ? `${label} (actionable)` : label
    })
    .join(', ')
}

export function countActionable(blockers: Blocker[]): number {
  return blockers.filter((b) => b.actionable).length
}

/** The single predicate `outcome` is decided by. */
export function hasOutcomeBlocker(blockers: Blocker[]): boolean {
  return blockers.some((b) => b.blocks_outcome)
}

/** What `agy_start` reports back about the policy it just resolved. */
export interface PolicyDescription {
  policy_summary: PolicySummary
  blockers: Blocker[]
  warnings: string[]
}

/**
 * Describe a resolved policy in the same vocabulary a finished job is judged
 * in, for both the `dry_run` and the real `agy_start` reply.
 *
 * Built in one place so the two replies cannot drift: before 0.1.1 the real
 * reply said nothing at all about permissions, and a caller whose
 * `permissions.allow` had been rejected wholesale had no way to notice.
 */
export function describePolicy(policy: EffectivePolicy): PolicyDescription {
  const blockers = policyCeilingBlockers(policy)
  return {
    policy_summary: {
      profile: policy.profile,
      allow_count: policy.allow.length,
      network: policy.network,
      default_decision: policy.default_decision,
    },
    blockers,
    warnings: renderBlockers(blockers),
  }
}
