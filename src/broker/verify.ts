import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import type {
  AgyEvent,
  ArtifactCheck,
  Blocker,
  ContractStatus,
  JobRow,
  Verification,
} from '../contract/types.js'
import { canonicalize, containedOrNull } from '../contract/paths.js'
import { scanDenials } from '../events/detect.js'
import type { Store } from '../store/db.js'
import { now } from '../store/db.js'
import {
  blockerFromDenial,
  blockerFromEnvironmentBlock,
  blockerFromMissingArtifact,
  renderBlockers,
} from './blockers.js'

/**
 * Independent checks the broker runs on its own, without asking agy anything.
 *
 * MVP scope (`docs/04`): expected-artifact existence, `git status` changed files,
 * and Class 1 / Class 2 denial aggregation. Running arbitrary `required_checks`
 * commands is deliberately out — that needs its own allowlist design.
 */

export interface VerifyInput {
  job: JobRow
  events: AgyEvent[]
  expectedArtifacts: string[]
  /** Canonical workspace. */
  cwd: string
  /** Raw structured output, when `--json-schema` was requested. */
  structuredOutput?: unknown
  jsonSchemaPath?: string | null
}

export function verifyJob(_store: Store, input: VerifyInput): Verification {
  const denials = scanDenials(input.events)
  const artifacts = checkExpectedArtifacts(input.cwd, input.expectedArtifacts)
  const changed = changedFiles(input.cwd)
  const contractStatus = checkContract(input.structuredOutput, input.jsonSchemaPath ?? null)

  // One list, one vocabulary. Which of these force `outcome: 'blocked'` and
  // which are only reported is decided in `blockers.ts` and nowhere else.
  const blockers: Blocker[] = [
    ...denials.permission_denials.map(blockerFromDenial),
    ...denials.environment_blocks.map(blockerFromEnvironmentBlock),
    ...artifacts.filter((a) => !a.exists).map(blockerFromMissingArtifact),
  ]

  const warnings = renderBlockers(blockers)
  if (contractStatus === 'violated') {
    // Not a blocker: `checkContract` never returns 'violated' on measured
    // evidence (see below), so there is nothing here we could claim to confirm.
    warnings.push('structured output did not honour the requested --json-schema')
  }

  return {
    blockers,
    expected_artifacts: artifacts,
    changed_files: changed,
    warnings,
    contract_status: contractStatus,
    checked_at: now(),
  }
}

/**
 * Existence and size of each expected artifact.
 *
 * Paths are workspace-relative and containment-checked before use, so a job
 * cannot claim success by writing outside its workspace. A path that escapes the
 * workspace is treated as missing, not as an error — the caller asked for a
 * verifiable fact, and "escaped the sandbox" is not a fact in its favour.
 */
export function checkExpectedArtifacts(cwd: string, expected: string[]): ArtifactCheck[] {
  const canonicalCwd = canonicalize(cwd)
  return expected.map((rel): ArtifactCheck => {
    const attempted = isAbsolute(rel) ? rel : join(canonicalCwd, rel)
    const contained = containedOrNull(attempted, [canonicalCwd])
    if (contained === null) {
      return { path: rel, absolute: canonicalize(attempted), exists: false, size: null }
    }
    try {
      const st = statSync(contained)
      return { path: rel, absolute: contained, exists: true, size: st.size }
    } catch {
      return { path: rel, absolute: contained, exists: false, size: null }
    }
  })
}

/**
 * `git status --porcelain` inside the workspace, via an argv array (never a shell
 * string). Empty when the workspace is not a git repo — that is not an error.
 */
export function changedFiles(cwd: string): string[] {
  try {
    // This call runs inside `finalizeCore`'s `BEGIN IMMEDIATE` transaction
    // (`docs/01` 결정 5), so an unbounded `git status` — blocked on a network
    // FS or an `index.lock` — would hold the SQLite write lock for as long as
    // git hangs. Bounding it here is a minimal mitigation for finding 7;
    // moving this work outside the transaction entirely is the fuller fix and
    // is not done here.
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: canonicalize(cwd),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      killSignal: 'SIGKILL',
    })
    return out
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0)
  } catch {
    // Not a git repo, git not installed, or the command failed. None of these
    // are fatal to the job — they just mean nothing to report here.
    return []
  }
}

/**
 * Whether the structured output honoured the requested schema. `not_required`
 * when no schema was asked for; `violated` keeps the raw payload regardless, since
 * a schema miss must never destroy the response.
 *
 * ⚠ agy's actual `--json-schema` failure signalling is unmeasured (`docs/02`
 * carries no findings on it). This is a conservative, documented placeholder:
 * presence of a non-null payload is treated as satisfying the schema; its
 * absence when one was requested is `unknown` rather than a confident
 * `violated`, since we have no measured evidence of what an actual schema
 * failure looks like on the wire.
 */
export function checkContract(
  structuredOutput: unknown,
  jsonSchemaPath: string | null,
): ContractStatus {
  if (!jsonSchemaPath) return 'not_required'
  if (structuredOutput === undefined || structuredOutput === null) return 'unknown'
  return 'satisfied'
}
