import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, parse as parsePath } from 'node:path'
import { z } from 'zod'

import { canonicalize } from '../../contract/paths.js'
import { SCHEMA_VERSION, type Capabilities, type ModelCapability } from '../../contract/types.js'
import { ceilingPath, describeCeiling, loadCeiling } from '../../policy/ceiling.js'
import { describeProfiles } from '../../policy/profiles.js'
import { agySearchLocations, resolveAgyBin } from '../../runner/spawn.js'
import { reconcile } from '../../broker/reconcile.js'
import { errorReply, reply, type ToolContext, type ToolReply } from '../context.js'

/**
 * `agy_capabilities` — models, profiles, limits, and server version.
 *
 * Worth calling before the first `agy_start`: it reports the project root that was
 * discovered, whether the agy binary is actually present, and the profile ceilings
 * a `permissions.allow` request will be intersected against.
 */
export const capabilitiesInput = z.object({})

export type CapabilitiesInput = z.infer<typeof capabilitiesInput>

/**
 * Models `agy models` lists (agy 1.1.27, 2026-09-08) with the `--effort`
 * values each one accepts — measured, not inferred (M8, one
 * trivial print-mode run per cell):
 *
 * - a name ending in `-high|-medium|-low` accepts exactly that effort, or
 *   none; any other value fails with "conflicts with --effort=…";
 * - `claude-*` accepts no `--effort` at all ("--effort is not supported for
 *   model …").
 *
 * `efforts` therefore lists what may be *passed*; omitting `effort` is always
 * fine. An empty list means "never pass it".
 */
export const MEASURED_MODELS: readonly ModelCapability[] = [
  { name: 'gemini-3.8-flash-high', efforts: ['high'] },
  { name: 'gemini-3.8-flash-medium', efforts: ['medium'] },
  { name: 'gemini-3.8-flash-low', efforts: ['low'] },
  { name: 'gemini-3.7-flash-high', efforts: ['high'] },
  { name: 'gemini-3.7-flash-medium', efforts: ['medium'] },
  { name: 'gemini-3.7-flash-low', efforts: ['low'] },
  { name: 'gemini-3.6-flash-high', efforts: ['high'] },
  { name: 'gemini-3.6-flash-medium', efforts: ['medium'] },
  { name: 'gemini-3.6-flash-low', efforts: ['low'] },
  { name: 'gemini-3.1-pro-high', efforts: ['high'] },
  { name: 'gemini-3.1-pro-low', efforts: ['low'] },
  { name: 'claude-sonnet-4-6', efforts: [] },
  { name: 'claude-opus-4-6-thinking', efforts: [] },
  { name: 'gpt-oss-120b-medium', efforts: ['medium'] },
]

const EFFORT_SUFFIX = /-(low|medium|high)$/

/**
 * The `--effort` values agy accepts for `model`, or `null` when we cannot
 * tell. Measured models answer from the table; an unmeasured name that still
 * carries an effort suffix follows the measured suffix rule (M8 held for every
 * suffixed model, across three families); anything else is unknown and the
 * caller must let agy decide.
 */
export function acceptedEfforts(model: string): readonly string[] | null {
  const measured = MEASURED_MODELS.find((m) => m.name === model)
  if (measured) return measured.efforts
  const suffix = EFFORT_SUFFIX.exec(model)
  return suffix ? [suffix[1] as string] : null
}

/** Only `accept-edits` was actually observed (`agentMode`). */
const MEASURED_MODES: readonly string[] = ['accept-edits']

/** Never spawns `agy` — only checks whether the binary is reachable on PATH. */
function checkAgyBinPresent(bin: string): boolean {
  try {
    if (bin.includes('/')) return existsSync(bin)
    const pathEnv = process.env.PATH ?? ''
    for (const dir of pathEnv.split(delimiter)) {
      if (!dir) continue
      if (existsSync(join(dir, bin))) return true
    }
    return false
  } catch {
    return false
  }
}

export async function handleCapabilities(
  ctx: ToolContext,
  _input: CapabilitiesInput,
): Promise<ToolReply> {
  try {
    await reconcile(ctx.store)
    // `resolveAgyBin` throws when nothing is found, which is right for a job
    // that is about to spawn it and wrong here: "agy is not installed" is one
    // of the facts this call exists to report, and a caller who cannot see
    // profiles or limits because of it is worse off, not safer.
    let agyBin: string | null = null
    try {
      agyBin = resolveAgyBin()
    } catch {
      agyBin = null
    }
    const ceilingFile = ceilingPath(ctx.paths)
    const ceilingPresent = existsSync(ceilingFile)
    // Not wrapped separately: an invalid policy.json should surface here too
    // (fails the whole call closed via the outer try/catch below), the same
    // as it fails `agy_start` — a caller should never see a capabilities
    // reply that quietly hid a broken ceiling file.
    const ceiling = loadCeiling(ctx.paths)

    const warnings: string[] = []
    const root = ctx.paths.root
    let home: string
    try {
      home = canonicalize(homedir())
    } catch {
      home = homedir()
    }
    const isRoot = root === '/' || root === parsePath(root).root
    const isHome = root === home || root === homedir()

    if (isRoot) {
      warnings.push(
        `resolved project root is the filesystem root (${root}); jobs cannot run here. Set AGY_WORKER_PROJECT to the target project directory.`,
      )
    } else if (isHome) {
      warnings.push(
        `resolved project root is the home directory (${root}); jobs cannot run here. Set AGY_WORKER_PROJECT to the target project directory.`,
      )
    }
    if (ctx.paths.source === 'cwd') {
      warnings.push(
        `no git root found; resolved project root from current working directory (${root}). Set AGY_WORKER_PROJECT to the target project directory.`,
      )
    }

    const caps: Capabilities = {
      server_version: ctx.version,
      schema_version: SCHEMA_VERSION,
      project_root: ctx.paths.root,
      project_root_source: ctx.paths.source,
      ...(ctx.paths.source === 'git-worktree' && ctx.paths.movedFrom
        ? { project_root_moved_from: ctx.paths.movedFrom }
        : {}),
      project_key: ctx.paths.key,
      profiles: describeProfiles(),
      ceiling: describeCeiling(ceiling, ceilingFile, ceilingPresent),
      models: [...MEASURED_MODELS],
      efforts: ['low', 'medium', 'high'],
      modes: [...MEASURED_MODES],
      session_modes: ['oneshot', 'session'],
      on_denial: ['abort', 'continue', 'guide'],
      limits: ctx.limits,
      agy_bin: agyBin,
      agy_bin_present: agyBin !== null && checkAgyBinPresent(agyBin),
      ...(agyBin === null ? { agy_bin_searched: agySearchLocations() } : {}),
      client: ctx.getClient?.() ?? null,
      warnings,
    }
    return reply(caps)
  } catch (e) {
    return errorReply(e)
  }
}
