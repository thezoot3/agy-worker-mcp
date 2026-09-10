import { ceilingAbsenceHint } from '../policy/ceiling.js'
import {
  AGY_ENGINE_REFUSAL_SIGNATURES,
} from '../contract/types.js'
import type {
  ArtifactCheck,
  Blocker,
  BlockerSource,
  DenialClass1,
  DenialClass2,
  EffectivePolicy,
  GateLogEntry,
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
 * | `sandbox`        | Class 2 signature match, sandboxed job | depends    | why the job was sandboxed: `permissions.sandbox` (retry without it), `research_readonly` (use general_worker), ceiling `sandbox: "agy"` (human) | yes |
 * | `broker`         | missing `expected_artifacts` entry    | yes        | which artifact is missing     | yes            |
 * | `broker`         | I4: gate never confirmed itself (`gate_confirmed === false`) | **no** | none — hooks.json never loaded, nothing to fix by rule | yes (and forces `outcome: 'process_error'` directly, not just `blocked` — see `decideOutcome`) |
 * | `tool_error`     | a failing tool call, no signature     | no         | none — not a permission issue | **no**         |
 *
 * `agy_engine` and `tool_error` do not force `blocked` for the same reason:
 * a non-gate `state: 'ERROR'` step is indistinguishable from an ordinary
 * command failure by shape alone (finding 17), so treating them as blocks would
 * report every failing test as a permission problem.
 *
 * The two `broker` rows are deliberately different shapes (`blockerFromMissingArtifact`
 * is actionable, `blockerFromGateMissing` is not) — `source` alone does not
 * imply a fixed `actionable`/`remedy`; read the specific constructor.
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
    if (d.policy === 'unsupported') {
      // classifyToolCall (src/policy/tools.ts) marks this tool unconditionally —
      // a subagent tool (M2) or one outside the 7-tool + manage_task table —
      // before any rule list is even consulted, so no `permissions.allow`
      // entry changes the outcome. required_rule is always null here (gate.ts).
      return {
        ...base,
        source: 'gate',
        actionable: false,
        remedy: null,
        blocks_outcome: true,
        message: `our gate refused this because the tool itself is not one permissions.allow can grant (unsupported, checked before any rule list). ${d.message}`,
      }
    }
    return {
      ...base,
      source: 'gate',
      actionable: true,
      remedy: d.required_rule,
      blocks_outcome: true,
      message: d.required_rule
        ? `our permission gate refused this; nothing in the job's effective allow list covers it. Rule that would: ${d.required_rule}. If agy_capabilities shows the ceiling already covers it, retry without permissions.allow (allow only narrows); otherwise a human must add it to the ceiling's allow (or, for a rule the profile denies, exceptions). ${d.message}`
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
      message: `agy's own permission engine refused this. Since 0.2.0 that engine is disabled for our jobs (--dangerously-skip-permissions, measured on agy 1.1.24, M3), so this should not occur on a current job — if it does, the flag or the hook wiring regressed; report it. Seen on archived v1 results this is expected. No permissions.allow rule will help, and we cannot confirm it as a block either. ${d.message}`,
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

/** A Class 2 signature match. Recovery depends on whether and why the job ran sandboxed. */
export function blockerFromEnvironmentBlock(b: DenialClass2, policy?: EffectivePolicy | null): Blocker {
  const base = {
    source: 'sandbox' as const,
    blocks_outcome: true,
    tool: b.tool,
    command: b.command,
    detail: asDetail(b),
  }

  // `verify.ts` never calls this for a job that ran with `bypass_sandbox:
  // true` — without a sandbox the same signature is an ordinary command
  // failure and goes to `warnings` instead. So every blocker built here comes
  // from a job that really was sandboxed, and the only question is why.
  // Job ran sandboxed. Identify which sandbox and why: request, ceiling, or profile.
  if (policy?.sandbox === 'seatbelt') {
    const source = policy.sandbox_source
    return {
      ...base,
      actionable: source === 'request',
      remedy:
        source === 'request'
          ? 'retry without permissions.sandbox, or add the directory to write_roots in the project ceiling if the write is legitimate'
          : 'a human must add the directory to write_roots in the project ceiling (~/.agy-worker/projects/<hash>/policy.json), or set sandbox to "none" there',
      message: `our seatbelt profile refused a write outside write_roots (signature "${b.signature}"; sandbox: seatbelt set by ${source}): ${b.excerpt}`,
    }
  }
  const reason =
    policy?.sandbox_forced_by ??
    (policy?.profile === 'research_readonly' ? 'profile' : null)

  const additionalDirsGuidance =
    'add the path to read_roots in the project ceiling (~/.agy-worker/projects/<hash>/policy.json) if it is a blocked read/exec of a toolchain outside the workspace.'

  if (reason === 'request') {
    return {
      ...base,
      actionable: true,
      remedy: `retry without permissions.sandbox; ${additionalDirsGuidance}`,
      message: `agy's sandbox blocked this silently (signature "${b.signature}") because permissions.sandbox was set for this job: ${b.excerpt}`,
    }
  }

  if (reason === 'profile') {
    return {
      ...base,
      actionable: true,
      remedy: `start the job with profile "general_worker" if the task needs to write; ${additionalDirsGuidance}`,
      message: `agy's sandbox blocked this silently (signature "${b.signature}") because profile "${policy?.profile ?? 'research_readonly'}" is always sandboxed: ${b.excerpt}`,
    }
  }

  // reason === 'ceiling' or generic/unknown sandboxed (e.g. policy not provided)
  const isCeiling = reason === 'ceiling'
  return {
    ...base,
    actionable: false,
    remedy: `a human must set "sandbox": "none" (or "seatbelt") in the project ceiling (~/.agy-worker/projects/<hash>/policy.json); ${additionalDirsGuidance}`,
    message: isCeiling
      ? `agy's sandbox blocked this silently (signature "${b.signature}") because the project ceiling has sandbox: agy: ${b.excerpt}`
      : `agy's sandbox blocked this silently — signature "${b.signature}": ${b.excerpt}`,
  }
}

/**
 * I4: the runner's own gate watchdog
 * killed the job because `jobs/<id>/gate-log.jsonl` never received a line
 * within 3s of the first tool step — our PreToolUse hook never actually ran,
 * so nothing before the kill was policy-checked at all. Never actionable — no
 * `permissions.allow` entry fixes a hook that never loaded — and
 * `decideOutcome` forces `outcome: 'process_error'` for this directly, not
 * merely `blocked`, since `blocked` would imply the gate ran and refused.
 */
export function blockerFromGateMissing(): Blocker {
  return {
    source: 'broker',
    actionable: false,
    remedy: null,
    blocks_outcome: true,
    tool: null,
    command: null,
    message: 'gate hook never fired; hooks.json was not loaded',
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
 * Build blockers from gate-log entries.
 *
 * When an entry carries `abort_reason: 'max_denials'`, emit an extra blocker
 * reporting that the job was aborted after reaching the denial limit.
 */
export function blockersFromGateLog(log: string | readonly GateLogEntry[]): Blocker[] {
  let entries: GateLogEntry[]
  if (typeof log === 'string') {
    entries = []
    for (const line of log.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as GateLogEntry
        if (parsed && typeof parsed === 'object') {
          entries.push(parsed)
        }
      } catch {
        // tolerate malformed lines
      }
    }
  } else {
    entries = [...log]
  }

  const maxDenialEntry = entries.find((e) => e.abort_reason === 'max_denials')
  if (!maxDenialEntry) return []

  const denialCount = entries.filter((e) => e.decision === 'deny').length
  return [
    {
      source: 'gate',
      actionable: true,
      remedy: 'raise max_denials or fix the prompt so the job stops retrying denied actions',
      blocks_outcome: true,
      tool: null,
      command: null,
      message: `job aborted after ${denialCount} gate denials (max_denials)`,
      detail: asDetail(maxDenialEntry),
    },
  ]
}

/**
 * The "no project ceiling" line for a finished job, or null. Said only when a
 * gate blocker's remedy is a rule string — exactly what a ceiling `allow` /
 * `exceptions` entry would open — and the policy recorded that no ceiling
 * file existed. A foreign hook's denial (no rule), containment, unsupported
 * tools and sandbox blocks are not the ceiling's business, so they stay quiet.
 * Legacy job files without `ceiling_present` never trigger it.
 */
export function ceilingAbsenceWarning(policy: EffectivePolicy | null | undefined, blockers: readonly Blocker[]): string | null {
  if (!policy || policy.ceiling_present !== false) return null
  const opensWithRule = blockers.some((b) => b.source === 'gate' && b.actionable && typeof b.remedy === 'string' && /^\w+\(/.test(b.remedy))
  return opensWithRule ? ceilingAbsenceHint(policy.ceiling_path ?? null) : null
}

/**
 * Pre-flight blockers from a resolved policy: every `permissions.allow` entry
 * the profile ceiling refused, every `permissions.read_roots` entry the
 * human ceiling refused, plus the collapse case.
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

  for (const dir of policy.rejected_read_roots) {
    blockers.push({
      source: 'policy_ceiling',
      actionable: true,
      remedy: `add a glob covering ${dir} to the project ceiling's read_roots, in ~/.agy-worker/projects/<hash>/policy.json — or drop it from permissions.read_roots`,
      blocks_outcome: false,
      tool: null,
      command: null,
      message: `permissions.read_roots entry ${dir} matched no glob in the project ceiling's read_roots, so it was dropped`,
      detail: { dir, profile: policy.profile },
    })
  }

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
      bypass_sandbox: policy.bypass_sandbox,
      sandbox_forced_by: policy.sandbox_forced_by,
      sandbox: policy.sandbox,
      sandbox_source: policy.sandbox_source,
      add_dirs: policy.add_dirs,
      add_dirs_source: policy.add_dirs_source,
    },
    blockers,
    warnings: [...renderBlockers(blockers), ...(policy.warnings ?? [])],
  }
}
