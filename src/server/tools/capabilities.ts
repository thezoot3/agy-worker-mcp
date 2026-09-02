import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { z } from 'zod'

import { SCHEMA_VERSION, type Capabilities } from '../../contract/types.js'
import { describeProfiles } from '../../policy/profiles.js'
import { resolveAgyBin } from '../../runner/spawn.js'
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
 * Models and modes measured in `docs/02-agy-cli-findings.md` §1. Only the values
 * actually observed — no guessed suffixes for the `gemini-3.6-flash-*` family the
 * doc left as a wildcard.
 */
const MEASURED_MODELS: readonly string[] = [
  'gemini-3.7-flash-high',
  'gemini-3.7-flash-medium',
  'gemini-3.7-flash-low',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
]

/** Only `accept-edits` was actually observed (`docs/02` §1, `agentMode`). */
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
    const agyBin = resolveAgyBin()
    const caps: Capabilities = {
      server_version: ctx.version,
      schema_version: SCHEMA_VERSION,
      project_root: ctx.paths.root,
      project_key: ctx.paths.key,
      profiles: describeProfiles(),
      models: [...MEASURED_MODELS],
      efforts: ['low', 'medium', 'high'],
      modes: [...MEASURED_MODES],
      session_modes: ['oneshot', 'session'],
      on_denial: ['abort', 'continue', 'guide'],
      limits: ctx.limits,
      agy_bin: agyBin,
      agy_bin_present: checkAgyBinPresent(agyBin),
      client: ctx.getClient?.() ?? null,
    }
    return reply(caps)
  } catch (e) {
    return errorReply(e)
  }
}
