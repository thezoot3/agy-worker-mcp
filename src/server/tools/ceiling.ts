import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

import { reconcile } from '../../broker/reconcile.js'
import type { CeilingReply } from '../../contract/types.js'
import { ceilingPath, describeCeiling, loadCeiling, migrateV1ToV2, parseCeilingJson } from '../../policy/ceiling.js'
import { reviewCeilingDraft } from '../../policy/ceiling-review.js'
import { HARD_DENY } from '../../policy/hard-deny.js'
import { resolvePolicy } from '../../policy/profiles.js'
import { evaluateCommandPolicy, parseRulesLenient } from '../../policy/rules.js'
import { digestProject, loadJobDigest, type JobDigest } from '../../trace/digest.js'
import { errorReply, reply, type ToolContext, type ToolReply } from '../context.js'

/**
 * `agy_ceiling` — everything a parent agent needs to propose a project
 * ceiling, and nothing that writes one (0.3.0 PR3, `skills/agy-ceiling/SKILL.md`).
 *
 * Without `draft`: the ceiling file's path and contents, the effective
 * general_worker policy it produces, and the project's denial history
 * (`digestProject` over every job directory). With `draft`: the review of
 * that draft (`loadCeiling`'s own errors, advisory warnings, a risk class
 * per rule) and, optionally, how the draft would judge `expected_commands`.
 *
 * Read-only by construction — there is no code path in this server that
 * writes `policy.json`; the skill's approval rule is the second wall.
 */
export const ceilingInput = z.object({
  draft: z
    .unknown()
    .optional()
    .describe('A candidate policy.json object (version 2). When given, the reply carries its review instead of the current file\'s history.'),
  expected_commands: z
    .array(z.string())
    .optional()
    .describe('Shell commands to judge against the draft (or, without a draft, the current ceiling) as general_worker.'),
  history_limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe('How many of the most recent jobs feed the denial history. Default 100.'),
})

export type CeilingInput = z.infer<typeof ceilingInput>

function projectHistory(jobsDir: string, limit: number): ReturnType<typeof digestProject> {
  if (!existsSync(jobsDir)) return digestProject([], {})
  const dirs = readdirSync(jobsDir)
    .map((name) => join(jobsDir, name))
    .filter((d) => {
      try {
        return statSync(d).isDirectory()
      } catch {
        return false
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, limit)
  const digests: JobDigest[] = []
  const gateLogs: Record<string, string | null> = {}
  for (const dir of dirs) {
    const d = loadJobDigest(dir, null)
    digests.push(d)
    const gl = join(dir, 'gate-log.jsonl')
    gateLogs[d.job_id] = existsSync(gl) ? readFileSync(gl, 'utf8') : null
  }
  return digestProject(digests, gateLogs)
}

export async function handleCeiling(ctx: ToolContext, input: CeilingInput): Promise<ToolReply> {
  try {
    await reconcile(ctx.store)
    const path = ceilingPath(ctx.paths)
    const present = existsSync(path)
    const current = loadCeiling(ctx.paths)

    const review = input.draft !== undefined ? reviewCeilingDraft(input.draft) : null
    // The policy the commands are judged against: the draft when it loads,
    // else the current file. A draft that fails review still gets a reply —
    // the errors are the point — but no preflight (there is no policy).
    let judged = current
    if (review !== null) {
      judged = review.ok ? parseCeilingJson(input.draft, '<draft>') : current
    }
    const effective = resolvePolicy({ profile: 'general_worker', workspace: ctx.paths.root, ceiling: judged })

    let preflight: CeilingReply['preflight'] = null
    if (input.expected_commands && (review === null || review.ok)) {
      const allowRules = parseRulesLenient(effective.allow)
      const denyRules = parseRulesLenient(effective.deny)
      preflight = input.expected_commands.map((command) => {
        const r = evaluateCommandPolicy(command, allowRules, denyRules)
        return {
          command,
          decision: r.allowed ? 'allow' : 'deny',
          stage: r.stage,
          required_rule: r.requiredRule,
        }
      })
    }

    const out: CeilingReply = {
      path,
      present,
      ceiling: describeCeiling(current, path, present),
      effective: {
        profile: 'general_worker',
        allow: effective.allow,
        deny: effective.deny,
        hard_deny: HARD_DENY.map((r) => r.replaceAll('{workspace}', ctx.paths.root)),
        lifted: effective.lifted,
        read_roots: effective.read_roots,
        command_policy: effective.command_policy,
        warnings: effective.warnings ?? [],
      },
      review,
      preflight,
      history: review === null ? projectHistory(ctx.paths.jobsDir, input.history_limit ?? 100) : null,
      writes_nothing: true,
    }
    // Attached whatever the caller asked for: someone reviewing a draft still
    // needs to know the file they are about to replace stops loading in 0.4.0.
    const migration = migrateV1ToV2(current)
    if (migration) out.v1_migration = migration
    return reply(out)
  } catch (e) {
    return errorReply(e)
  }
}
