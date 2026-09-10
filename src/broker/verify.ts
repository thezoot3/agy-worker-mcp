import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import type {
  AgyEvent,
  ArtifactCheck,
  Blocker,
  ContractStatus,
  EffectiveConfig,
  EffectivePolicy,
  JobRow,
  Verification,
  VerifyRecord,
  VerifyResult,
} from '../contract/types.js'
import { canonicalize, containedOrNull, jobPaths, readJsonIfExists } from '../contract/paths.js'
import { scanDenials } from '../events/detect.js'
import type { Store } from '../store/db.js'
import { now } from '../store/db.js'
import {
  blockerFromDenial,
  blockerFromEnvironmentBlock,
  blockerFromMissingArtifact,
  blockersFromGateLog,
  ceilingAbsenceWarning,
  renderBlockers,
} from './blockers.js'

/**
 * Independent checks the broker runs on its own, without asking agy anything.
 *
 * Verification scope: expected-artifact existence, `git status` changed files,
 * and Class 1 / Class 2 denial aggregation. Running arbitrary commands here in
 * the broker is deliberately out — that needs its own allowlist design; PR6's
 * `verify_command` instead runs once, in the *runner*, before this ever sees
 * the job. This module's only job re: that
 * is `readVerifyResult` below, which reads back what the runner already wrote.
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
  policy?: EffectivePolicy | null
}

export function verifyJob(store: Store, input: VerifyInput): Verification {
  const paths = jobPaths(store.paths, input.job.job_id)
  const policy =
    input.policy ??
    readJsonIfExists<EffectivePolicy>(paths.policy) ??
    readJsonIfExists<EffectiveConfig>(paths.effectiveConfig)?.policy ??
    null

  const denials = scanDenials(input.events)
  const artifacts = checkExpectedArtifacts(input.cwd, input.expectedArtifacts)
  const changed = changedFiles(input.cwd)
  const contractStatus = checkContract(input.structuredOutput, input.jsonSchemaPath ?? null)
  const verify = readVerifyResult(store, input.job.job_id)

  // One list, one vocabulary. Which of these force `outcome: 'blocked'` and
  // which are only reported is decided in `blockers.ts` and nowhere else.
  // A Class 2 signature only means "the sandbox refused" when the job actually
  // ran sandboxed. With `bypass_sandbox: true` there is no sandbox to refuse
  // anything, so the same text is an ordinary command failure (a real EACCES,
  // a network that is really down) — reported as a warning, never a blocker,
  // and never a reason to call the job `blocked`.
  let gateLogBlockers: Blocker[] = []
  if (existsSync(paths.gateLog)) {
    try {
      gateLogBlockers = blockersFromGateLog(readFileSync(paths.gateLog, 'utf8'))
    } catch {
      // tolerate missing or unreadable gate log
    }
  }

  // `sandbox` is the 0.3.0 field; a pre-0.3.0 policy file only has bypass_sandbox.
  const ranUnsandboxed = policy ? (policy.sandbox ?? (policy.bypass_sandbox ? 'none' : 'agy')) === 'none' : false
  const blockers: Blocker[] = [
    ...denials.permission_denials.map(blockerFromDenial),
    ...(ranUnsandboxed ? [] : denials.environment_blocks.map((b) => blockerFromEnvironmentBlock(b, policy))),
    ...artifacts.filter((a) => !a.exists).map(blockerFromMissingArtifact),
    ...gateLogBlockers,
  ]

  const warnings = renderBlockers(blockers)
  // A gate refusal whose remedy is a rule string is exactly what a ceiling
  // would open. Without a ceiling file the agent has no `agy_capabilities`
  // entry to point at, so say it here, once, next to the blocker.
  const ceilingHint = ceilingAbsenceWarning(policy, blockers)
  if (ceilingHint) warnings.push(ceilingHint)
  if (ranUnsandboxed) {
    for (const b of denials.environment_blocks) {
      warnings.push(
        `${b.tool}${b.command ? ` (${b.command})` : ''} printed sandbox signature "${b.signature}", but this job ran with no OS sandbox (sandbox: none), so it is the command's own failure, not a sandbox block: ${b.excerpt}`,
      )
    }
  }
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
    verify,
  }
}

/**
 * `Verification.verify` (PR6 §6.3): `null` when `jobs/<id>/verify.json` was
 * never written — no `verify_command` was requested, or the job's own
 * deadline killed agy before the runner could get to it (`runner.ts` skips
 * verify entirely when `timedOut === true`). Deliberately re-read from disk
 * rather than threaded through as an extra `VerifyInput` field: `jobPaths` is
 * already the one place that knows where the runner wrote it, and every
 * caller of `verifyJob` already has a `Store` (and so a `ProjectPaths`) in
 * hand.
 */
function readVerifyResult(store: Store, jobId: string): VerifyResult | null {
  const paths = jobPaths(store.paths, jobId)
  const record = readJsonIfExists<VerifyRecord>(paths.verifyJson)
  if (!record) return null
  return { ...record, output_tail: readOutputTail(paths.verifyLog) }
}

/** Last 2 KiB of `verify.log`, byte-accurate; `''` when the file is empty or missing. */
const OUTPUT_TAIL_BYTES = 2048

function readOutputTail(logPath: string): string {
  try {
    const buf = readFileSync(logPath)
    if (buf.length <= OUTPUT_TAIL_BYTES) return buf.toString('utf8')
    return buf.subarray(buf.length - OUTPUT_TAIL_BYTES).toString('utf8')
  } catch {
    return ''
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
    // This call runs inside `finalizeCore`'s `BEGIN IMMEDIATE` transaction,
    // so an unbounded `git status` — blocked on a network
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
 * ⚠ agy's actual `--json-schema` failure signalling is unmeasured.
 * This is a conservative, documented placeholder:
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
