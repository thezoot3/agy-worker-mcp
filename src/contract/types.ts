/**
 * Frozen contract types for agy-worker-mcp.
 *
 * READ-ONLY after Stage 1. If a downstream module needs a change here, report it
 * through `contract_change_requests` instead of editing this file.
 *
 * Everything describing agy's own wire format is transcribed from measured
 * output (`docs/02-agy-cli-findings.md` §4/§5/§9 and the raw NDJSON in
 * `.spike/out/`). No field in the `Agy*` types is invented.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 0. Constants shared across processes
// ─────────────────────────────────────────────────────────────────────────────

/** Bumped whenever `schema.sql` changes shape. Stored in `meta.schema_version`. */
export const SCHEMA_VERSION = 1

/** Environment variables this package reads. Nothing else may be consulted. */
export const ENV = {
  /** Overrides project-root discovery (`docs/01` decision 2). */
  PROJECT_ROOT: 'AGY_WORKER_PROJECT',
  /** Overrides `~/.agy-worker` as the state home. Tests set this. */
  STATE_HOME: 'AGY_WORKER_HOME',
  /** Absolute path to the `agy` executable. Tests point this at the fake. */
  AGY_BIN: 'AGY_WORKER_AGY_BIN',
  /** Job id the runner process is executing. Set by the server when spawning. */
  JOB_ID: 'AGY_WORKER_JOB_ID',
  /** Scenario file consumed by `test/fake-agy` only; never read by src/. */
  FAKE_SCENARIO: 'AGY_FAKE_SCENARIO',
} as const

/**
 * Flags that must never appear in a generated argv, at any call site.
 * `--continue` resumes a *global* "most recent conversation" which collides
 * head-on with multi-session operation; the other two remove the safety net.
 */
export const FORBIDDEN_AGY_FLAGS: readonly string[] = [
  '--dangerously-skip-permissions',
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

/** Output signatures that mean "the sandbox blocked this silently" (`docs/03` §2). */
export const ENVIRONMENT_BLOCK_SIGNATURES: readonly string[] = [
  'Could not resolve host',
  'Temporary failure in name resolution',
  'Connection refused',
  'Operation not permitted',
  'Read-only file system',
  'EACCES',
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

/** MVP ships two (`docs/04` scope cut). */
export type Profile = 'research_readonly' | 'general_worker'

export type SessionMode = 'oneshot' | 'session'

export type OnDenial = 'abort' | 'continue' | 'guide'

/** Lock rows actually stored in the `locks` table. */
export type LockScope = 'cwd_write' | 'session'

/**
 * What an acquisition attempt was for. `running_limit` is the per-project
 * concurrency ceiling from `docs/01` decision 4 — it is enforced inside the same
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

export type NetworkPolicy = 'allow' | 'deny'

/** What a client may ask for on `agy_start`. Narrowing only — never widening. */
export interface RequestedPermissions {
  allow?: string[]
  deny?: string[]
  network?: NetworkPolicy
}

/**
 * The resolved policy written to `jobs/<id>/policy.json` and read by the gate on
 * every tool call. `allow` is already intersected with the profile ceiling and
 * `deny` already unions the profile's list with `HARD_DENY`.
 */
export interface EffectivePolicy {
  profile: Profile
  /** Canonical workspace. The gate forces `overwrite.Cwd` to this. */
  workspace: string
  read_roots: string[]
  write_roots: string[]
  allow: string[]
  deny: string[]
  network: NetworkPolicy
  /** Verdict when nothing matched: read-only profiles deny, worker profiles ask. */
  default_decision: 'ask' | 'deny'
  on_denial: OnDenial
  /** Allow entries the client asked for that the profile ceiling refused. */
  rejected_allow: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Gate (PreToolUse hook) — §9 measured payload, §1.3 decision order
// ─────────────────────────────────────────────────────────────────────────────

/** Exactly the JSON agy writes to the hook's stdin. */
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

/** Machine payload embedded after {@link GATE_DENIAL_MARKER} inside `reason`. */
export interface GateDenialPayload {
  job_id: string
  tool: string
  required_rule: string | null
  /** Which stage of the §1.3 order produced the verdict. */
  policy: 'deny_list' | 'profile_allowlist' | 'containment' | 'network' | 'default'
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
  policy: GateDenialPayload['policy'] | 'bound_passthrough'
  matched_rule: string | null
  reason: string | null
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
  timeout_ms?: number
  /** Workspace-relative paths that must exist when the job finishes. */
  expected_artifacts?: string[]
  /** Path or inline JSON schema for `--json-schema`. */
  json_schema?: string
  requested_by?: string
  parent_task_id?: string
  dry_run?: boolean
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
  deadline_at: number
  expected_artifacts: string[]
  json_schema_path: string | null
  policy: EffectivePolicy
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

/** Written to `jobs/<id>/verification.json`. Facts only. */
export interface Verification {
  permission_denials: DenialClass1[]
  environment_blocks: DenialClass2[]
  expected_artifacts: ArtifactCheck[]
  /** `git status --porcelain` inside the workspace, when it is a repo. */
  changed_files: string[]
  /** Non-fatal observations that block `verified_success`. */
  warnings: string[]
  contract_status: ContractStatus
  checked_at: number
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
 * What `agy_wait` returns on completion — the "judgement packet" of `docs/04` #17.
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
    permission_denials: number
    environment_blocks: number
    missing_artifacts: number
    tool_errors: number
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

export interface Capabilities {
  server_version: string
  schema_version: number
  project_root: string
  project_key: string
  profiles: Array<{
    name: Profile
    description: string
    write: boolean
    network: NetworkPolicy
    default_decision: 'ask' | 'deny'
  }>
  models: string[]
  efforts: string[]
  modes: string[]
  session_modes: SessionMode[]
  on_denial: OnDenial[]
  limits: {
    max_running_jobs: number
    max_timeout_ms: number
    default_timeout_ms: number
    max_response_bytes: number
    max_log_tail_lines: number
  }
  agy_bin: string
  /** False when the configured binary is missing; `agy_start` will fail. */
  agy_bin_present: boolean
}
