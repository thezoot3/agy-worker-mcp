/**
 * Frozen contract types for agy-worker-mcp.
 *
 * READ-ONLY after Stage 1. If a downstream module needs a change here, report it
 * through `contract_change_requests` instead of editing this file.
 *
 * Everything describing agy's own wire format is transcribed from measured
 * output and raw NDJSON transcripts. No field in the `Agy*` types is invented.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 0. Constants shared across processes
// ─────────────────────────────────────────────────────────────────────────────

/** Bumped whenever `schema.sql` changes shape. Stored in `meta.schema_version`. */
export const SCHEMA_VERSION = 1

/**
 * Hardest per-project concurrency the server will accept, whatever the project
 * ceiling asks for.
 *
 * Measured 2026-09-10: sixteen concurrent jobs on this machine still made
 * progress, so the wall is above that. Twelve sits deliberately below the
 * measured wall — the number that matters is not how many agy processes the
 * machine can hold but how many the *rest* of the system stays honest under:
 * every running job holds an open database handle, a detached runner, and a
 * gate the watchdog has to hear from. A ceiling asking for more than this is
 * more likely a typo than a plan.
 *
 * Lives here rather than beside `DEFAULT_MAX_RUNNING` in `store/locks.ts`
 * because `contract/errors.ts` names it in a remedy, and locks already imports
 * errors.
 */
export const MAX_RUNNING_JOBS_CAP = 12

/**
 * Shape version of `jobs/<id>/broker-result.json`, independent of the SQLite
 * `SCHEMA_VERSION` (that file is not a table).
 *
 * 1 → 2: `verification.permission_denials` + `verification.environment_blocks`
 * became the single `verification.blockers` list.
 * 2 → 3: `verification.verify` was added (PR6, `verify_command`) — `null` on a
 * migrated file, since no pre-0.2.0 job ever ran a verify command.
 * `loadBrokerResult` migrates an older file in memory rather than failing, so a
 * job directory written by an earlier release stays readable; an unknown
 * *newer* version is refused loudly instead.
 */
export const BROKER_RESULT_VERSION = 3

/** Environment variables this package reads. Nothing else may be consulted. */
export const ENV = {
  /** Overrides project-root discovery (see docs/operations.md). */
  PROJECT_ROOT: 'AGY_WORKER_PROJECT',
  /** Overrides `~/.agy-worker` as the state home. Tests set this. */
  STATE_HOME: 'AGY_WORKER_HOME',
  /** Absolute path to the `agy` executable. Tests point this at the fake. */
  AGY_BIN: 'AGY_WORKER_AGY_BIN',
  /**
   * Overrides `binPath('gate')`. Tests point this at a nonexistent path to
   * exercise `agy_start`'s `existsSync(gatePath)` check (PR3 §3.1) without
   * having to move the real `dist/gate.js` out from under a build every other
   * test also depends on.
   */
  GATE_BIN: 'AGY_WORKER_GATE_BIN',
  /** Job id the runner process is executing. Set by the server when spawning. */
  JOB_ID: 'AGY_WORKER_JOB_ID',
  /** Scenario file consumed by `test/fake-agy` only; never read by src/. */
  FAKE_SCENARIO: 'AGY_FAKE_SCENARIO',
} as const

/**
 * Flags that must never appear in a generated argv, at any call site.
 * `--continue` resumes a *global* "most recent conversation" which collides
 * head-on with multi-session operation; `--prompt-interactive` needs a TTY.
 *
 * `--dangerously-skip-permissions` was on this list until 0.2.0. It is now
 * emitted on every spawn (`buildAgyArgv`) — see the comment there for the
 * three invariants that make that safe and the measurement (M3) behind it.
 */
export const FORBIDDEN_AGY_FLAGS: readonly string[] = [
  '--continue',
  '-c',
  '--prompt-interactive',
  '-i',
  '--new-project',
]

/** agy's own prefix on a hook denial, measured in `.spike/out/run6.events.ndjson`. */
export const HOOK_DENIAL_PREFIX = 'tool call denied by pre-tool hook:'

/**
 * Marker the gate embeds in its `reason` string so `events/detect.ts` can parse a
 * denial losslessly instead of scraping prose. agy passes `reason` through to the
 * model verbatim (measured, §10), so the human-readable guidance comes first and
 * the machine payload trails it in brackets:
 *
 * `<guidance sentence> [agy-worker-denial:{"required_rule":"command(git push)",...}]`
 */
export const GATE_DENIAL_MARKER = 'agy-worker-denial:'

/** Output signatures that mean "the sandbox blocked this silently" (see docs/permissions.md). */
export const ENVIRONMENT_BLOCK_SIGNATURES: readonly string[] = [
  'Could not resolve host',
  'Temporary failure in name resolution',
  'Connection refused',
  'Operation not permitted',
  'Read-only file system',
  'EACCES',
]

/**
 * The subset of {@link ENVIRONMENT_BLOCK_SIGNATURES} that means "the sandbox
 * refused the network" rather than a filesystem or capability refusal. Since
 * 0.2.1 the two are lifted the same way — by not running the job sandboxed
 * (I2) — so this only shapes the blocker's wording.
 */
export const NETWORK_BLOCK_SIGNATURES: readonly string[] = [
  'Could not resolve host',
  'Temporary failure in name resolution',
  'Connection refused',
]

/**
 * Substrings that identify a refusal by agy's **own** permission engine, as
 * opposed to our gate.
 *
 * Both entries are verbatim fragments of a measured message; the observed line
 * was:
 *
 * `permission check failed for unsandboxed "ls -la /Users/<user>/.jdks/": user
 * denied permission to run command:\nls -la /Users/<user>/.jdks/`
 *
 * These refusals are not ours and no `permissions.allow` rule can lift them —
 * the gate never saw the call. Matching them only changes how the warning is
 * worded, never the outcome (they arrive as ordinary `state: 'ERROR'` tool
 * steps, which `decideOutcome` deliberately does not count as blocks).
 */
export const AGY_ENGINE_REFUSAL_SIGNATURES: readonly string[] = [
  'user denied permission to run command',
  'permission check failed for unsandboxed',
]

// ─────────────────────────────────────────────────────────────────────────────
// 1. agy raw wire format — transcribed, not designed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Token accounting attached to `step_update` and `result`.
 * `input_tokens` / `output_tokens` / `total_tokens` appear in every measured
 * sample; `thinking_tokens` / `cache_read_tokens` appear in every raw capture but
 * are not in the §4 excerpt, so they stay optional.
 */
export interface AgyUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  thinking_tokens?: number
  cache_read_tokens?: number
}

/** `tool_info.error` — the only structured failure signal agy emits (Class 1). */
export interface AgyToolError {
  type: string
  message: string
}

export interface AgyToolInfo {
  name?: string
  parameters?: Record<string, unknown>
  output?: string
  error?: AgyToolError
}

/** Measured values. Anything else must be treated as unknown, not as an error. */
export type AgyStepState = 'ACTIVE' | 'DONE' | 'ERROR'
export type AgyStepType = 'user_input' | 'agent_response' | 'tool' | 'system_message'
export type AgyResultStatus = 'SUCCESS' | 'ERROR'

/**
 * First line of every run. `conversation_id` sits on the *envelope*, not inside
 * `init` — this is what makes gate binding possible before the first tool call.
 */
export interface AgyInitEvent {
  event: 'init'
  conversation_id: string
  init: {
    model: string
    cwd: string
    permission_mode: string
    tools: string[]
  }
}

export interface AgyStepUpdateEvent {
  event: 'step_update'
  step_update: {
    conversation_id: string
    step_index: number
    state: AgyStepState | string
    step_type: AgyStepType | string
    tool_name?: string
    tool_info?: AgyToolInfo
    text_delta?: string
    duration_seconds?: number
    usage?: AgyUsage
  }
}

/** One per turn. `num_turns` increases and survives `--conversation` resume. */
export interface AgyResultEvent {
  event: 'result'
  result: {
    conversation_id: string
    status: AgyResultStatus | string
    response: string
    error?: string
    duration_seconds: number
    num_turns: number
    usage: AgyUsage
  }
}

export type AgyEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEvent

/** An envelope whose `event` we do not model. Preserved, never dropped. */
export interface AgyUnknownEvent {
  event: string
  [key: string]: unknown
}

/** stream-json *input*, one line = one turn (§5). Byte-identical to agy's schema. */
export interface AgyStreamUserInput {
  event: 'user'
  message: {
    role: 'user'
    content: Array<{ type: 'text'; text: string }>
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Job / session state machine
// ─────────────────────────────────────────────────────────────────────────────

export type Lifecycle = 'queued' | 'starting' | 'running' | 'canceling' | 'finished'

/**
 * Broker verdict. Distinct from `agent_status` on purpose: agy reports SUCCESS
 * with exit 0 for both permission denials and sandbox blocks (measured, §9/§11),
 * so its self-report can never produce `verified_success` on its own.
 */
export type Outcome =
  /** Finished, and every check the broker could run actually passed. */
  | 'verified_success'
  /** Finished with no detected block, but nothing verifiable was requested. */
  | 'success_unverified'
  /** Ran to completion but a Class 1 denial or Class 2 environment block bit. */
  | 'blocked'
  /** agy reported ERROR, or exited non-zero. */
  | 'failed'
  /** `deadline_at` passed and the process group was killed. */
  | 'timed_out'
  /** `agy_cancel` killed it. */
  | 'canceled'
  /** Runner vanished without writing `exit_code`. */
  | 'process_error'
  /** Recorded pid is alive but is a different process (pid reuse). */
  | 'orphaned'

/** agy's *unverified* self-report. Never drives `outcome` alone. */
export type AgentStatus = 'SUCCESS' | 'ERROR' | 'unknown'

/** Did the job honour the structured contract the caller asked for? */
export type ContractStatus =
  | 'not_required'
  | 'satisfied'
  | 'violated'
  | 'unknown'

/** Built-in profiles (see docs/permissions.md). */
export type Profile = 'research_readonly' | 'general_worker'

export type SessionMode = 'oneshot' | 'session'

export type OnDenial = 'abort' | 'continue' | 'guide'

/** Lock rows actually stored in the `locks` table. */
export type LockScope = 'cwd_write' | 'session'

/**
 * What an acquisition attempt was for. `running_limit` is the per-project
 * concurrency ceiling — it is enforced inside the same
 * `BEGIN IMMEDIATE` but owns no row, so it is not a `LockScope`.
 */
export type LockRequestScope = LockScope | 'running_limit'

export type SessionState = 'active' | 'closed'

/** Row shape of `jobs`. Column-for-column with `schema.sql`. */
export interface JobRow {
  job_id: string
  session_id: string | null
  lifecycle: Lifecycle
  outcome: Outcome | null
  headline: string | null
  cwd: string
  profile: Profile
  /** 0 = read-only, 1 = write. Stored as INTEGER because SQLite has no boolean. */
  write_mode: number
  session_mode: SessionMode
  pid: number | null
  pgid: number | null
  /** Opaque platform token guarding against pid reuse. Compared, never parsed. */
  proc_start_time: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
  deadline_at: number | null
  exit_code: number | null
  agent_status: AgentStatus | null
  contract_status: ContractStatus | null
  on_denial: OnDenial
  requested_by: string | null
  parent_task_id: string | null
}

/** Row shape of `sessions`. `conversation_id` is bound lazily from the first init event. */
export interface SessionRow {
  session_id: string
  conversation_id: string | null
  cwd: string
  model: string | null
  effort: string | null
  profile: Profile | null
  turn_count: number
  last_job_id: string | null
  created_at: number
  last_used_at: number
  state: SessionState
}

/** Row shape of `locks`. */
export interface LockRow {
  scope: LockScope
  key: string
  holder_job_id: string
  acquired_at: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Event normalization and block detection
// ─────────────────────────────────────────────────────────────────────────────

export type NormalizedKind =
  | 'session_start'
  | 'phase'
  | 'command_start'
  | 'command_end'
  | 'tool_error'
  | 'environment_block'
  | 'agent_message'
  | 'final_response'
  | 'system'
  | 'raw'

export type NormalizedSeverity = 'info' | 'warning' | 'error'

/**
 * One human-readable line derived from one or more raw events. Repeated token
 * deltas, blank lines and duplicates collapse away before this exists.
 */
export interface NormalizedEvent {
  kind: NormalizedKind
  severity: NormalizedSeverity
  /** `step_index` when the source was a `step_update`, else null. */
  step_idx: number | null
  /** Single-line, already truncated, safe to concatenate into a tail. */
  text: string
  /** Present for tool events. */
  tool?: string
  /** `run_command`'s `CommandLine`, when that is what happened. */
  command?: string
  /** Wall time agy attributed to the step. */
  duration_seconds?: number
  /** Byte offset of the source line in `events.ndjson`, when known. */
  offset?: number
}

/**
 * Class 1 — a structured refusal. Detected by
 * `step_type === 'tool' && state === 'ERROR'`; details in `tool_info.error.message`.
 * Our own gate authors that message, so `required_rule` round-trips losslessly.
 */
export interface DenialClass1 {
  class: 1
  tool: string
  command: string | null
  /** Rule string the caller can paste straight into the next `permissions.allow`. */
  required_rule: string | null
  /**
   * Which stage of the gate's decision order refused, when our own gate did.
   * Null for a refusal we did not author.
   *
   * The recovery differs by stage, so the caller needs it: `profile_allowlist`
   * and `default` are fixed by adding `required_rule` to `permissions.allow`,
   * while `containment` and `deny_list` cannot be — the first needs a different
   * path, the second is not narrowable at all.
   */
  policy: GateDenialPayload['policy'] | null
  /** Whether the refusal came from our gate (parsed marker) or elsewhere. */
  source: 'gate' | 'agy' | 'unknown'
  message: string
  step_idx: number | null
}

/**
 * Class 2 — a silent environment block. No error event, exit 0, status SUCCESS.
 * Only visible as ordinary command output, which is why this is the dangerous one.
 */
export interface DenialClass2 {
  class: 2
  tool: string
  command: string | null
  /** Which entry of `ENVIRONMENT_BLOCK_SIGNATURES` matched. */
  signature: string
  /** Short excerpt of the output around the match. */
  excerpt: string
  step_idx: number | null
}

export interface DenialScan {
  permission_denials: DenialClass1[]
  environment_blocks: DenialClass2[]
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Policy
// ─────────────────────────────────────────────────────────────────────────────

export type RuleVerb =
  | 'command'
  | 'read_file'
  | 'write_file'
  | 'fetch'
  | 'url'
  | 'mcp'
  | 'browser'

/** `command(git status)` / `regex:` opt-in, per §12. Strict non-regex by default. */
export interface ParsedRule {
  verb: RuleVerb
  pattern: string
  /** True when the pattern was written as `regex:...`. */
  regex: boolean
  raw: string
}

/**
 * What a client may ask for on `agy_start`. Narrowing only — never widening.
 * `sandbox: "agy"` forces agy's OS sandbox on for this job even on general_worker.
 * `read_roots` narrows the *human ceiling* (`policy/ceiling.ts`).
 */
/** OS boundary for an allowed `run_command` (0.3.0 PR6). Ordered: none < seatbelt < agy. */
export type SandboxMode = 'none' | 'seatbelt' | 'agy'

export interface RequestedPermissions {
  allow?: string[]
  deny?: string[]
  /**
   * @deprecated Removed in 0.4.0. Passing this field at runtime throws ValidationError naming `sandbox`.
   * Kept on the type interface so legacy test fixtures and external callers still typecheck.
   */
  sandboxed?: boolean
  /** Tightening only: `seatbelt` or `agy`. Never loosens what the profile or ceiling set. */
  sandbox?: 'seatbelt' | 'agy'
  /** Paths to add as extra read/exec roots (`--add-dir`, M4). Each must match a ceiling glob. */
  read_roots?: string[]
}

/**
 * The resolved policy written to `jobs/<id>/policy.json` and read by the gate on
 * every tool call. `allow` is already intersected with the profile ceiling and
 * `deny` already unions the profile's list with `HARD_DENY`.
 *
 * `network` and `default_decision` are gone: a bound job's gate never
 * answers `ask` (I1), so there is no verdict left for "nothing matched" to
 * fall back to — it is simply `deny`.
 * In 0.2.1, allowed commands run without agy's OS sandbox by default on general_worker.
 * `bypass_sandbox` determines `overwrite.BypassSandbox` for allowed run_command calls.
 */
export interface EffectivePolicy {
  profile: Profile
  /** Canonical workspace. The gate forces `overwrite.Cwd` to this. */
  workspace: string
  read_roots: string[]
  write_roots: string[]
  allow: string[]
  deny: string[]
  /**
   * Which OS boundary an allowed `run_command` runs under (0.3.0 PR6):
   * `none` (as the user, the 0.2.1 default), `seatbelt` (our own
   * `sandbox-exec` profile: writes only inside `seatbelt_write_roots`), or
   * `agy` (agy's sandbox, `BypassSandbox: false`; always on research_readonly).
   * The strictest of profile / ceiling / request wins.
   */
  sandbox: SandboxMode
  /** Who set `sandbox`: 'default' when nothing asked for more than none. */
  sandbox_source: 'profile' | 'ceiling' | 'request' | 'default'
  /** Directories the seatbelt profile lets commands write to: `write_roots` plus tmp/dev. */
  seatbelt_write_roots: string[]
  /**
   * Whether allowed run_command calls emit `overwrite.BypassSandbox: true` (I2).
   * Derived: `sandbox !== 'agy'`. Kept as its own field because the gate,
   * broker and every job policy file read it.
   */
  bypass_sandbox: boolean
  /** Records where bypass_sandbox: false came from, or null when bypassing. Derived from `sandbox_source`. */
  sandbox_forced_by: 'profile' | 'ceiling' | 'request' | null
  /**
   * Extra read-only roots beyond the workspace (`--add-dir`, M4). `[]` unless
   * `requested.read_roots` is given *and* each entry matches a glob in
   * the human ceiling's own `read_roots` (`policy/ceiling.ts`) — a
   * non-matching entry is dropped and reported in `rejected_read_roots`,
   * never silently widened.
   */
  add_dirs: string[]
  /** Where add_dirs came from: 'ceiling' (default applied), 'request' (narrowed subset), or 'none'. */
  add_dirs_source: 'ceiling' | 'request' | 'none'
  /** Whether commands default to allow when no allow rule matches (0.2.2 PR3). */
  command_policy: 'allowlist' | 'denylist'
  /** Shape version of this file. */
  policy_version: 3
  on_denial: OnDenial
  /**
   * Abort the job after this many gate denials regardless of on_denial. Null = never.
   * A middle ground between `abort` (one flaky-tool workaround kills the job) and
   * `continue` (unbounded denial loops).
   */
  max_denials: number | null
  /** Allow entries the client asked for that the profile ceiling refused. */
  rejected_allow: string[]
  /** Profile deny rules the ceiling's `exceptions` lifted for this job (0.3.0), `{workspace}`-substituted. */
  lifted: string[]
  /** `requested.read_roots` entries that matched no glob in the human ceiling's `read_roots`. */
  rejected_read_roots: string[]
  /** Whether a project ceiling file existed when this policy was resolved (0.3.0). */
  ceiling_present: boolean
  /** Where that file is (or would be); null when unknown (pre-0.3.0 job files). */
  ceiling_path: string | null
  /** Pre-flight warnings produced during policy resolution. */
  warnings?: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Gate (PreToolUse hook) — §9 measured payload, §1.3 decision order
// ─────────────────────────────────────────────────────────────────────────────

/** Exactly the JSON agy writes to the hook's stdin. */
/**
 * What `agy_start` tells the caller about the policy it just resolved.
 *
 * `agy_start`'s non-dry_run reply used to carry no policy information at all,
 * so a caller whose `permissions.allow` was rejected wholesale could not tell
 * (observed: a request of three build commands collapsed `allow` to `[]`,
 * silently dropping the profile's own defaults too). Both replies carry this
 * now, alongside `warnings` built by the same function.
 */
export interface PolicySummary {
  profile: Profile
  /**
   * Size of the effective `allow` list. `0` means nothing is explicitly
   * allowed — including the profile's own defaults, which a rejected
   * `permissions.allow` request silently takes with it. Rejected entries are
   * reported as `source: 'policy_ceiling'` blockers, not here.
   */
  allow_count: number
  /** Whether allowed commands run unsandboxed for this job. */
  bypass_sandbox: boolean
  /** Why the sandbox is forced on, or null when bypassing. */
  sandbox_forced_by: 'profile' | 'ceiling' | 'request' | null
  /** `EffectivePolicy.sandbox` / `sandbox_source`. */
  sandbox: SandboxMode
  sandbox_source: 'profile' | 'ceiling' | 'request' | 'default'
  /** `EffectivePolicy.add_dirs`, verbatim. */
  add_dirs: string[]
  /** Where add_dirs came from. */
  add_dirs_source: 'ceiling' | 'request' | 'none'
}

export interface GatePayload {
  conversationId: string
  stepIdx?: number
  modelName?: string
  toolCall: {
    name: string
    args?: Record<string, unknown>
  }
  workspacePaths?: string[]
  transcriptPath?: string
  artifactDirectoryPath?: string
}

/**
 * Documented values are `allow` / `deny` / `ask` / `force_ask`.
 *
 * `ask` is the pass-through: it delegates to agy's built-in engine, which
 * auto-approves under `proceed-in-sandbox`.
 */
export type GateVerdict = 'allow' | 'deny' | 'ask' | 'force_ask'

/**
 * What the gate writes to stdout.
 *
 * ⚠ `{}` IS A DENIAL (measured, §9). The gate must emit a `decision` on every
 * path including parse failure, DB failure and unhandled exception — otherwise it
 * breaks the user's own interactive agy sessions, the one place this package can
 * affect anything outside its own jobs.
 */
export interface GateDecision {
  decision: GateVerdict
  /** Passed to the model verbatim; used as an instruction channel, not just a reason. */
  reason?: string
  /** e.g. `["command(npm test)"]`. Scope of persistence is unmeasured — see §12. */
  permissionOverrides?: string[]
  /** Shallow-merged into the tool args. We use it to pin `Cwd`. */
  overwrite?: Record<string, unknown>
}

/**
 * Which stage of `decide()`'s fixed order produced a verdict.
 * `bound_passthrough`/`network` are gone with `ask` and
 * `default_decision` (I1: a bound job's gate never answers `ask`). `unsupported`
 * and `control` are new — every tool call is now classified, not just
 * `run_command`.
 */
export type GateDecisionStage =
  | 'unsupported'
  | 'control'
  | 'containment'
  | 'deny_list'
  | 'profile_allowlist'
  | 'default'
  | 'denylist_default'

/** Machine payload embedded after {@link GATE_DENIAL_MARKER} inside `reason`. */
export interface GateDenialPayload {
  job_id: string
  tool: string
  required_rule: string | null
  policy: GateDecisionStage
  on_denial: OnDenial
}

/** Row appended to `jobs/<id>/gate-log.jsonl` — every verdict, allow included. */
export interface GateLogEntry {
  ts: number
  job_id: string
  conversation_id: string
  step_idx: number | null
  tool: string
  command: string | null
  decision: GateVerdict
  policy: GateDecisionStage
  matched_rule: string | null
  reason: string | null
  abort_reason?: 'on_denial' | 'max_denials'
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Job request / effective configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Verbatim `agy_start` input, persisted to `jobs/<id>/request.json`. */
export interface JobRequest {
  prompt: string
  cwd?: string
  profile?: Profile
  model?: string
  effort?: string
  mode?: string
  session_id?: string
  session_mode?: SessionMode
  permissions?: RequestedPermissions
  on_denial?: OnDenial
  /**
   * Abort the job after this many gate denials regardless of on_denial. Null = never.
   * A middle ground between `abort` (one flaky-tool workaround kills the job) and
   * `continue` (unbounded denial loops).
   */
  max_denials?: number
  timeout_ms?: number
  /**
   * `session_mode: 'session'` only. Closes stdin (ending the process at EOF,
   * §6) after this many idle ms following a *completed* turn with no new
   * `agy_send` in between. Ignored for `oneshot`, which already closes stdin
   * after its one turn.
   *
   * Deliberately separate from `timeout_ms`/`deadline_at`: `agy_send` never
   * extends `deadline_at` (see the comment on `EffectiveConfig.deadline_at`
   * below), so this is the mechanism that lets a multi-turn session end
   * promptly instead of idling out the full hard timeout (a session-mode job
   * that finished its turn would otherwise sit until the hard deadline elapsed).
   */
  idle_timeout_ms?: number
  /** Workspace-relative paths that must exist when the job finishes. */
  expected_artifacts?: string[]
  /** Path or inline JSON schema for `--json-schema`. */
  json_schema?: string
  requested_by?: string
  parent_task_id?: string
  dry_run?: boolean
  /** `dry_run` only: shell commands to judge against the effective policy up front (0.2.2 PR5). */
  expected_commands?: string[]
  /**
   * A command the *runner* runs once, after agy exits normally, against the
   * final workspace state (PR6, see docs/permissions.md). Outside
   * the model's own decisions — it cannot skip, reorder or narrow it — which is
   * the whole reason it exists, not sandboxing: it runs as the user, with no
   * sandbox, at the same trust level as the parent agent running the command
   * itself. A failing verify is a job *failure* (`outcome: 'failed'`), never a
   * `Blocker` — that vocabulary means "who refused", and nothing refused here.
   */
  verify_command?: string
  /** Default 600000ms, clamped to `limits.max_timeout_ms`. Ignored without `verify_command`. */
  verify_timeout_ms?: number
}

/**
 * Everything resolved before spawning, persisted to
 * `jobs/<id>/effective-config.json`. `agy_start(dry_run: true)` returns this
 * without spawning so a caller can settle configuration without burning quota.
 */
export interface EffectiveConfig {
  job_id: string
  session_id: string
  /** Set only when resuming an existing conversation. */
  conversation_id: string | null
  /** Canonical, symlink-resolved workspace. Also the `--add-dir` value. */
  cwd: string
  profile: Profile
  model: string | null
  effort: string | null
  mode: string | null
  session_mode: SessionMode
  on_denial: OnDenial
  write_mode: boolean
  timeout_ms: number
  /**
   * Hard ceiling, set once from `timeout_ms` at `agy_start` and never touched
   * again — `agy_send` does not extend it.
   *
   * A queued turn keeps the *original* deadline. Pushing it out on
   * every `agy_send` would let an actively-fed session hold its `session` and
   * `cwd_write` locks indefinitely as long as something kept
   * calling `agy_send` faster than it decayed — and because `reconcile` only
   * runs from a tool entry point, nothing else would ever notice and
   * cut it off. A fixed ceiling is the backstop that guarantees a `session`
   * job eventually reconciles even if a client behaves badly.
   *
   * The intended way to run longer than one `deadline_at` window is not to
   * stretch it, but to let the job finish (or idle-close, see
   * `idle_timeout_ms`) and resume the same conversation with a fresh
   * `agy_start(session_id=...)` — conversation resume is lossless,
   * so nothing is lost by not stretching this field.
   */
  deadline_at: number
  /**
   * Resolved `idle_timeout_ms`, or `null` when `session_mode !== 'session'`
   * (a oneshot job has no idle window — its one turn's `result` is followed
   * immediately by stdin close). See `JobRequest.idle_timeout_ms`.
   */
  idle_timeout_ms: number | null
  expected_artifacts: string[]
  json_schema_path: string | null
  policy: EffectivePolicy
  /**
   * Every `--add-dir` value actually passed to `buildAgyArgv` — `[cwd,
   * ...policy.add_dirs]`. Kept
   * distinct from `policy.add_dirs` (which is only the *extra* roots
   * beyond the workspace) so this field is a direct, typed record of what the
   * argv actually contains, without a reader having to reconstruct it from
   * `cwd` + `policy`.
   */
  add_dirs: string[]
  /**
   * Resolved `verify_command`/`verify_timeout_ms`, or `null` when the job asked
   * for no verify command at all. `command` is validated at `agy_start` the
   * same way any other `command(...)` rule subject is — see `handleStart`'s
   * `firstMatchForDenial` check against the resolved `policy.deny` — but is
   * otherwise opaque here: the runner passes it to `sh -c` verbatim.
   */
  verify: { command: string; timeout_ms: number } | null
  /** Exact argv handed to `spawn`. No shell string exists anywhere. */
  argv: string[]
  /** Absolute path of the executable being spawned. */
  agy_bin: string
  /** Allowlisted environment passed to the child. */
  env: Record<string, string>
  created_at: number
}

/** `jobs/<id>/state.json` — written atomically by the runner. */
export interface JobStateFile {
  job_id: string
  lifecycle: Lifecycle
  pid: number | null
  pgid: number | null
  proc_start_time: string | null
  started_at: number | null
  finished_at: number | null
  updated_at: number
  /**
   * True when the runner's own deadline watchdog killed the process group.
   *
   * Without it the fact is lost: the runner kills agy, writes the resulting
   * `exit_code` (1, or a signal code), and `reconcile` — which only sees the
   * exit code — classifies a timeout as an ordinary `failed`. Measured live:
   * `timeout_ms: 25000` produced `outcome: "failed", exit_code: 1`.
   *
   * Optional because a `state.json` written by an older build will not have it.
   */
  timed_out?: boolean
  /**
   * True when the runner's idle watchdog closed stdin because
   * `idle_timeout_ms` elapsed with no `agy_send` after the last completed
   * turn. Distinct from `timed_out`: this is a clean
   * EOF close, not a `killpg` — the exit code it produces goes through the
   * ordinary `finalizeJob` path exactly as an explicit `agy_send(close:true)`
   * would, so it never forces `outcome`. Diagnostic only, so a caller can tell
   * "the session idled itself shut" apart from "the client closed it" or "the
   * process just exited on its own" after reading the exit code.
   *
   * Optional for the same reason as `timed_out`: an older `state.json` won't
   * have it, and jobs that never had an idle watchdog (oneshot, or a
   * `session` job the client closed itself) never set it either.
   */
  idle_closed?: boolean
  /**
   * I4: whether the runner's own gate
   * watchdog (`src/runner/gate-watchdog.ts`) saw `jobs/<id>/gate-log.jsonl`
   * receive a line by the time the first `step_type: 'tool'` step reached
   * DONE/ERROR (plus a short grace period), or within a long backstop cap if
   * that first step never finished.
   *
   * - `true` — the gate confirmed itself; nothing else changes.
   * - `false` — no gate-log line appeared even though a tool call completed
   *   (a PreToolUse hook gates execution, so a loaded gate must have logged
   *   before then), so the watchdog killed the process group:
   *   `hooks.json` never actually loaded and every
   *   tool call up to that point ran completely unguarded. `reconcile` forces
   *   `outcome: 'process_error'` for this, never `blocked` — a permission
   *   verdict implies the gate ran at all, which is exactly what did not
   *   happen here.
   * - `null` (or absent, for a `state.json` written before this field
   *   existed) — the job ended before any tool step ever ran, so there was
   *   nothing for the gate to confirm; this never forces an outcome.
   */
  gate_confirmed?: boolean | null
  /**
   * True once the runner has written `jobs/<id>/verify.json` (PR6 §6.2).
   * `false` or absent otherwise — including when `config.verify` is null (no
   * verify command was requested) or the deadline killed agy first
   * (`timedOut === true` skips verify entirely; `verify_done` stays falsy and
   * `verification.verify` reads `null`, exactly like "no verify configured").
   */
  verify_done?: boolean
  /**
   * Which process the runner is currently waiting on (0.2.2 PR1).
   *
   * - `'agy'` — the agy child is (or was just) running.
   * - `'verifying'` — agy has exited and the runner is running `verify_command`.
   *   agy's pid is gone in this phase and `exit_code` is not yet written, so a
   *   reconciler that reads only those two facts sees exactly what a lost
   *   runner looks like. Measured 2026-09-08 (audit `08`): every job that ran a
   *   multi-second verify (gradle build, `npm test`) came back `process_error`
   *   with a complete result landing a few seconds later.
   * - `'done'` — the final write; `exit_code` follows immediately.
   *
   * Optional because a `state.json` written by an older build will not have it.
   */
  phase?: 'agy' | 'verifying' | 'done'
  /**
   * The runner's own pid, as opposed to `pid` (agy's). Lets `reconcile` tell
   * "agy exited and the runner is still working" (`verifying`, or the short
   * writeback window) apart from "the runner itself is gone". Optional for the
   * same reason as `phase`.
   */
  runner_pid?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Inbox (follow-up turns)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A queued turn. Byte-identical to agy's stream-json input schema (§5) so the
 * runner can relay the line to stdin without re-encoding it.
 */
export type InboxUserLine = AgyStreamUserInput

/**
 * Control line the runner consumes and never relays. Uses a key agy would ignore
 * anyway, but the runner filters it out before stdin so that never matters.
 */
export interface InboxControlLine {
  agy_worker_control: 'close'
  ts: number
}

export type InboxLine = InboxUserLine | InboxControlLine

// ─────────────────────────────────────────────────────────────────────────────
// 8. Verification and broker judgement
// ─────────────────────────────────────────────────────────────────────────────

export interface ArtifactCheck {
  path: string
  absolute: string
  exists: boolean
  size: number | null
}

/**
 * Written verbatim to `jobs/<id>/verify.json` by the runner (PR6 §6.2), once,
 * right after `verify_command` exits or its own `verify_timeout_ms` fires.
 * Never written at all when no `verify_command` was requested, or when the
 * job's own deadline killed agy first (`timedOut === true` skips verify).
 */
export interface VerifyRecord {
  command: string
  exit_code: number | null
  /** Node's own signal name (e.g. `'SIGTERM'`), or null on an ordinary exit. */
  signal: string | null
  started_at: number
  duration_ms: number
  /** True when `verify_timeout_ms` fired and the runner killed the process group. */
  timed_out: boolean
}

/**
 * `Verification.verify` — {@link VerifyRecord} plus a display-sized excerpt of
 * its own log, read fresh from disk by `verifyJob` rather than carried through
 * the runner. `output_tail` is the last 2 KiB of `jobs/<id>/verify.log`, or
 * `''` when the file is empty or missing.
 */
export interface VerifyResult extends VerifyRecord {
  output_tail: string
}

/**
 * Where a refusal came from. The one axis that decides what a caller should do
 * next, so every judgement surface (outcome, counts, warnings, `agy_start`'s own
 * reply) is derived from this and nothing else. The authoritative
 * source → (`actionable`, `remedy`, `blocks_outcome`) table lives in
 * `src/broker/blockers.ts`; do not re-derive it anywhere.
 */
export type BlockerSource =
  /** A requested `permissions.allow` entry the profile ceiling refused. Pre-flight, from `resolvePolicy`. */
  | 'policy_ceiling'
  /** Our own PreToolUse gate refused the call. The only refusal we can confirm. */
  | 'gate'
  /** agy's own permission engine refused, outside our policy entirely (measured wording). */
  | 'agy_engine'
  /** agy's sandbox blocked it silently — a Class 2 signature match. */
  | 'sandbox'
  /** A broker-side check failed: a missing `expected_artifacts` entry. */
  | 'broker'
  /**
   * An ordinary failing tool call carrying no refusal signature at all.
   *
   * Not one of the five refusal sources — it exists because a non-gate
   * `state: 'ERROR'` step is indistinguishable from a real denial by shape
   * (finding 17), and dropping those events would lose their message entirely.
   * Never actionable through permissions, never `blocks_outcome`.
   */
  | 'tool_error'

/**
 * One thing that stood between the job and `verified_success` — or, for
 * `policy_ceiling`, between the request and the job it asked for.
 *
 * This is deliberately the same vocabulary as an error envelope
 * (`detail` + `remedy`, `contract/errors.ts`): a caller reads `actionable` to
 * decide whether retrying differently can possibly help, and `remedy` for what
 * to change. When nothing can help, `remedy` is null and `message` says why.
 */
export interface Blocker {
  source: BlockerSource
  /** Whether changing the next `agy_start` can lift this. */
  actionable: boolean
  /** What to change. Null when nothing will help — the reason is in `message`. */
  remedy: string | null
  /**
   * Whether this forces `outcome: 'blocked'`. True only for refusals we
   * confirmed ourselves (`gate`, `sandbox`, `broker`); an `agy_engine` or
   * `tool_error` entry cannot be told apart from an ordinary command failure,
   * and reporting those as `blocked` would call every failing test a block.
   */
  blocks_outcome: boolean
  tool: string | null
  command: string | null
  /** Human-readable, and carrying the measured message verbatim where there is one. */
  message: string
  /**
   * The full original record this was derived from — a `DenialClass1`,
   * `DenialClass2`, `ArtifactCheck`, or the rejected rule string. Nothing the
   * pre-0.1.1 `permission_denials` / `environment_blocks` lists carried
   * (`required_rule`, `signature`, `policy`, `step_idx`, …) is dropped.
   */
  detail?: Record<string, unknown>
}

/**
 * Written to `jobs/<id>/verification.json`. Facts only.
 *
 * `blockers` replaced the separate `permission_denials` / `environment_blocks`
 * lists in `BROKER_RESULT_VERSION` 2: the caller's real question is "who
 * refused, and can I fix it", which the split lists made them reassemble by
 * hand — and got wrong, since a non-gate tool error sat in a list named
 * `permission_denials` while never counting as a denial anywhere else.
 */
export interface Verification {
  blockers: Blocker[]
  expected_artifacts: ArtifactCheck[]
  /** `git status --porcelain` inside the workspace, when it is a repo. */
  changed_files: string[]
  /** Rendered `blockers`, plus non-blocker observations (an idle-closed session). */
  warnings: string[]
  contract_status: ContractStatus
  checked_at: number
  /**
   * `null` when no `verify_command` was requested, or the deadline killed agy
   * before it could run. Never a `Blocker` — a failing verify is a job
   * *failure*, not a refusal, and `hasOutcomeBlocker` must never see it
   * (`decideOutcome` reads this field directly instead — see `outcome.ts`).
   */
  verify: VerifyResult | null
}

/** agy's own claims. Kept quarantined from the broker's findings on purpose. */
export interface AgentReport {
  status: AgentStatus
  response: string | null
  error: string | null
  num_turns: number | null
  usage: AgyUsage | null
  conversation_id: string | null
}

/** Deterministically derived from events, exit status and filesystem checks. */
export interface BrokerSummary {
  /** One sentence. This is what a caller reads first. */
  headline: string
  outcome: Outcome
  exit_code: number | null
  duration_ms: number | null
  counts: {
    events: number
    steps: number
    tool_calls: number
    tool_errors: number
    turns: number
    malformed_lines: number
  }
  /** Last normalized lines, already size-capped. */
  log_tail: string[]
}

/**
 * `jobs/<id>/broker-result.json` — the single source of truth.
 * `agy_wait` projects a subset of this; `agy_result` pages all of it. Nothing
 * else recomputes `outcome`.
 */
export interface BrokerResult {
  schema_version: number
  job_id: string
  session_id: string | null
  conversation_id: string | null
  lifecycle: Lifecycle
  cwd: string
  profile: Profile
  session_mode: SessionMode
  created_at: number
  started_at: number | null
  finished_at: number | null
  /** Unverified self-report. Never read to decide `outcome`. */
  agent_report: AgentReport
  /** Verified facts. */
  broker_summary: BrokerSummary
  verification: Verification
  agent_status: AgentStatus
  contract_status: ContractStatus
  /** Raw structured output when `--json-schema` was used; preserved even if invalid. */
  structured_output: unknown
  finalized_at: number
}

/**
 * What `agy_wait` returns on completion — the judgement packet summary.
 * Deliberately excludes lists and raw text; those live in `agy_result`.
 */
export interface JudgementPacket {
  job_id: string
  lifecycle: Lifecycle
  outcome: Outcome | null
  headline: string
  exit_code: number | null
  duration_ms: number | null
  agent_status: AgentStatus | null
  contract_status: ContractStatus | null
  counts: {
    /**
     * Size of `verification.blockers`. The packet stays a verdict, not a
     * report: the per-item detail (source, remedy, verbatim message) is one
     * `agy_result({ section: "verification" })` away.
     *
     * Invariant, for a job that actually ran to a conclusion (i.e. not
     * `canceled` / `timed_out` / `failed`, which outrank verification in
     * `decideOutcome`'s precedence): `outcome === 'blocked'` ⟺ some blocker
     * has `blocks_outcome: true`. Both sides are computed from the same list.
     */
    blockers: number
    /** How many of those a different `agy_start` could lift (`actionable: true`). */
    actionable: number
    /** Every `step_type: 'tool'`, `state: 'ERROR'` step in the raw stream. */
    tool_errors: number
    /** `result` events, i.e. completed turns. */
    turns: number
  }
  warnings: string[]
  log_tail: string[]
  /** Byte offset to resume `agy_logs` / `agy_wait` from. */
  cursor: number
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Capabilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the connected MCP client told us at `initialize`.
 *
 * Reported so a caller can see, rather than guess, which optional protocol
 * features are actually negotiated on this connection — `capabilities.tasks`
 * in particular decides whether a long call can be handed to the client as a
 * background task instead of blocking its turn. Null before `initialize`
 * completes, or when the server is driven without a client (tests).
 */
export interface ClientSnapshot {
  name: string | null
  version: string | null
  /** Verbatim `ClientCapabilities` — an empty object means "declared nothing". */
  capabilities: Record<string, unknown> | null
}

/**
 * `agy_capabilities.ceiling` — the human-owned permission ceiling as loaded
 * from `<project state dir>/policy.json` (`policy/ceiling.ts`, see
 * `docs/permissions.md`). Rule strings are reported exactly as written in the
 * file: capabilities has no per-job workspace, so a `{workspace}` placeholder
 * inside `allow`/`deny`/`exceptions` is left literal rather than
 * substituted — a caller sees the resolved, job-real form in `agy_start`'s own
 * `policy_summary` instead.
 */
export interface CeilingSummary {
  /** Absolute path of the ceiling file, whether or not it exists. */
  path: string
  present: boolean
  /** Schema version the file was written in (version 2 current). Null when absent. */
  version: 1 | 2 | null
  allow: string[]
  deny: string[]
  /** Profile deny rules this project lifts (0.3.0). Exact-string matches only; never touches HARD_DENY. */
  exceptions: string[]
  /** OS boundary for general_worker commands in this project: none (default) | seatbelt | agy. */
  sandbox: SandboxMode
  /** `~`-expanded, canonicalized glob patterns, as loaded. Read/exec roots outside the workspace. */
  read_roots: string[]
  /** Extra directories jobs may write to (containment and, under seatbelt, the kernel). */
  write_roots: string[]
  command_policy: 'allowlist' | 'denylist'
  /** Per-project concurrency the ceiling sets, or null for the server default. */
  max_running_jobs: number | null
  /** Non-fatal notes about the file (e.g. a v1 file whose keys should be renamed). */
  warnings: string[]
  /** Present when the ceiling file exists on disk but failed to load (e.g. rejected version 1). */
  error?: string
}

/** Risk class `agy_ceiling` attaches to every rule in a draft (`policy/ceiling-review.ts`). */
export type CeilingRuleRisk =
  | 'read_utility'
  | 'build'
  | 'vcs_local'
  | 'vcs_remote'
  | 'network'
  | 'install'
  | 'destructive'
  | 'privilege'
  | 'filesystem'
  | 'other'

export interface CeilingRuleReview {
  key: 'allow' | 'deny' | 'exceptions'
  rule: string
  risk: CeilingRuleRisk
  /** Advisory notes: redundant, lifts nothing, needs explicit approval. */
  notes: string[]
}

/** `agy_ceiling({ draft })` — would the file load, and what is the human being asked to approve. */
export interface CeilingDraftReview {
  /** True when `loadCeiling` would accept this object. */
  ok: boolean
  errors: string[]
  warnings: string[]
  rules: CeilingRuleReview[]
}

/** `agy_ceiling` reply. Read-only: `writes_nothing` is literal. */
export interface CeilingReply {
  path: string
  present: boolean
  ceiling: CeilingSummary
  /** general_worker resolved against the draft (when it loads) or the current file. */
  effective: {
    profile: 'general_worker'
    allow: string[]
    deny: string[]
    hard_deny: string[]
    lifted: string[]
    read_roots: string[]
    command_policy: 'allowlist' | 'denylist'
    warnings: string[]
  }
  review: CeilingDraftReview | null
  preflight: Array<{ command: string; decision: 'allow' | 'deny'; stage: string; required_rule: string | null }> | null
  /** Denial history and command frequencies across this project's jobs; null when a draft was given. */
  history: import('../trace/digest.js').ProjectDigest | null
  /**
   * Present only when this project's ceiling file is still version 1, which
   * 0.4.0 rejects. Carries the version 2 equivalent and the single command
   * that writes it, so the deprecation comes with its own remedy.
   */
  v1_migration?: { draft: Record<string, unknown>; write_command: string; note: string }
  /** Present when the current ceiling file failed to load (e.g. version 1). */
  error?: string
  writes_nothing: true
}

/**
 * One entry of `Capabilities.models`: the `--effort` values agy accepts for
 * this model (measured, M8). Omitting `agy_start.effort` is
 * always allowed; an empty list means it must be omitted (`claude-*`), and a
 * name with the effort baked in (`gemini-*-high`) lists exactly that one
 * value — any other is rejected by agy before the turn starts.
 */
export interface ModelCapability {
  name: string
  efforts: readonly string[]
}

export type ProjectRootSource = 'env' | 'git' | 'git-worktree' | 'git-submodule' | 'cwd'

export interface Capabilities {
  server_version: string
  schema_version: number
  project_root: string
  project_root_source: ProjectRootSource
  project_root_moved_from?: string
  project_key: string
  profiles: Array<{
    name: Profile
    description: string
    write: boolean
    bypass_sandbox: boolean
  }>
  /** The human-owned ceiling this project's `agy_start` calls resolve against. */
  ceiling: CeilingSummary
  models: ModelCapability[]
  efforts: string[]
  modes: string[]
  session_modes: SessionMode[]
  on_denial: OnDenial[]
  limits: {
    max_running_jobs: number
    max_timeout_ms: number
    default_timeout_ms: number
    /**
     * `session_mode: 'session'` only. No live
     * measurement dictates this value — there is no recorded turn-cadence
     * data for how quickly a real caller re-sends after a turn finishes.
     * Chosen to comfortably outlast one round trip of "read the last turn,
     * decide the next prompt" without idling out a hard `timeout_ms`
     * (typically minutes) just to wait on a client that already went quiet.
     * Revisit if live use shows a different cadence.
     */
    default_idle_timeout_ms: number
    /** Ceiling `idle_timeout_ms` is clamped to, mirroring `max_timeout_ms`. */
    max_idle_timeout_ms: number
    /** `verify_timeout_ms` default (10 minutes) when `verify_command` is set but no timeout is given. Clamped to `max_timeout_ms`, same as `timeout_ms`. */
    default_verify_timeout_ms: number
    max_response_bytes: number
    max_log_tail_lines: number
  }
  /**
   * Which of the limits above the project ceiling moved. Reported separately
   * from `limits` so a caller reading the effective number can still tell
   * whether raising it is a server change or a one-line ceiling edit.
   */
  limits_source: {
    max_running_jobs: 'default' | 'ceiling'
  }
  /** The resolved agy executable, or null when none was found. */
  agy_bin: string | null
  /** Every location searched for it; present only when `agy_bin` is null. */
  agy_bin_searched?: string[]
  /** False when the configured binary is missing; `agy_start` will fail. */
  agy_bin_present: boolean
  /** The connected client's own `initialize` declaration. See {@link ClientSnapshot}. */
  client: ClientSnapshot | null
  /** Degenerate project root or configuration warnings. */
  warnings: string[]
}
