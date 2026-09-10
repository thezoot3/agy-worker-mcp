import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

import { ValidationError } from '../../contract/errors.js'
import { reconcile } from '../../broker/reconcile.js'
import type { CeilingReply, CeilingSummary } from '../../contract/types.js'
import { ceilingPath, describeCeiling, EMPTY_CEILING, loadCeiling, migrateV1ToV2, parseCeilingJson, type Ceiling } from '../../policy/ceiling.js'
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
    let current: Ceiling = { ...EMPTY_CEILING, path }
    let loadError: ValidationError | null = null
    let migration: ReturnType<typeof migrateV1ToV2> = null

    if (present) {
      try {
        current = loadCeiling(ctx.paths)
      } catch (e) {
        if (e instanceof ValidationError) {
          loadError = e
          try {
            const rawFileJson = JSON.parse(readFileSync(path, 'utf8'))
            migration = migrateV1ToV2(rawFileJson, path)
          } catch {
            // raw read failed or not valid JSON
          }
          if (!migration) {
            // Unreadable or invalid ceiling that is not a recoverable version 1 file;
            // fail closed rather than proceeding.
            throw e
          }
        } else {
          throw e
        }
      }
    }

    const review = input.draft !== undefined ? reviewCeilingDraft(input.draft) : null
    // The policy the commands are judged against: the draft when it loads,
    // else the current file (or null if the current file failed to load).
    let judged: Ceiling | null = loadError ? null : current
    if (review !== null) {
      judged = review.ok ? parseCeilingJson(input.draft, '<draft>') : judged
    }

    // Fail closed: if the ceiling failed to load and no valid draft was provided,
    // effective allow must be empty (never falling back to the shipped profile defaults).
    const effective = judged
      ? resolvePolicy({ profile: 'general_worker', workspace: ctx.paths.root, ceiling: judged })
      : {
          profile: 'general_worker' as const,
          workspace: ctx.paths.root,
          allow: [],
          deny: [],
          hard_deny: HARD_DENY.map((r) => r.replaceAll('{workspace}', ctx.paths.root)),
          lifted: [],
          read_roots: [],
          command_policy: 'allowlist' as const,
          warnings: [loadError!.message],
        }

    let preflight: CeilingReply['preflight'] = null
    if (input.expected_commands && judged !== null && (review === null || review.ok)) {
      const allowRules = parseRulesLenient(effective.allow)
      const denyRules = parseRulesLenient(effective.deny)
      preflight = input.expected_commands.map((command) => {
        const r = evaluateCommandPolicy(command, allowRules, denyRules, 0, effective.workspace)
        return {
          command,
          decision: r.allowed ? 'allow' : 'deny',
          stage: r.stage,
          required_rule: r.requiredRule,
        }
      })
    }

    const ceilingSummary: CeilingSummary = loadError
      ? {
          path,
          present: true,
          version: 1,
          allow: [],
          deny: [],
          exceptions: [],
          sandbox: 'none',
          read_roots: [],
          write_roots: [],
          command_policy: 'allowlist',
          warnings: [loadError.message],
          error: loadError.message,
        }
      : describeCeiling(current, path, present)

    const out: CeilingReply = {
      path,
      present,
      ceiling: ceilingSummary,
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
    if (migration) out.v1_migration = migration
    if (loadError) out.error = loadError.message
    return reply(out)
  } catch (e) {
    return errorReply(e)
  }
}
