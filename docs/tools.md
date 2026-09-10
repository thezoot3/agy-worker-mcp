# Tool surface

Ten tools. Every handler runs a reconcile pass first — there is no daemon, so
state is repaired lazily on tool entry (a runner that died without writing an
exit code, a lock whose owner is gone, a job past its deadline).

Every reply is returned twice: as JSON text content, and as
`structuredContent`. Errors come back as `isError: true` with a structured
`{ code, ... }` payload rather than as a thrown transport error.

---

## `agy_start`

Starts a job and returns immediately with a `job_id`. Nothing blocks: the
`agy` process is spawned detached, in its own process group, with its output
redirected to files in the job directory.

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `prompt` | string, required | — | The task. Passed as `--print=<prompt>`; in `session_mode: "session"` it is seeded as turn 1 on stdin instead, because `agy` refuses both at once. |
| `cwd` | string | project root | Workspace. Must resolve inside the project root, symlinks included. |
| `profile` | `research_readonly` \| `general_worker` | `research_readonly` | Permission ceiling. See [`permissions.md`](./permissions.md). |
| `model` | string | agy's default | e.g. `gemini-3.7-flash-low`. `agy_capabilities` lists the models actually observed. |
| `effort` | `low` \| `medium` \| `high` | agy's default | |
| `mode` | string | agy's default | agy execution mode, e.g. `accept-edits`. |
| `session_id` | string | new session | Continue an existing conversation. Resume is lossless (measured). |
| `session_mode` | `oneshot` \| `session` | `oneshot` | `oneshot` closes stdin after one turn; `session` keeps it open for `agy_send`. |
| `permissions` | `{ allow?, deny?, sandbox?, read_roots? }` | profile ceiling | Narrowing only, within the three-owner model (code / project ceiling / this field) — see [`permissions.md`](./permissions.md). `allow` is intersected with the ceiling, `deny` is unioned, `sandbox` (`"seatbelt"` \| `"agy"`) raises the OS boundary for this job and never lowers it — `"agy"` on agy 1.1.24 means no in-workspace shell writes, so builds and `git commit` fail; the pre-0.3.0 boolean `sandboxed: true` is still read as `"agy"` — and `read_roots` (extra `--add-dir` roots) applies the project ceiling's entries by default; list entries here only to use a subset of them (entries outside the ceiling are dropped and reported in `rejected_read_roots`). |
| `on_denial` | `abort` \| `continue` \| `guide` | `continue` | What to do at the first policy denial. |
| `max_denials` | int | none | Abort after this many gate denials regardless of `on_denial`. The middle ground between `abort` (one flaky-tool retry ends the job) and `continue` (unbounded). An `unsupported` tool call (anything but a subagent tool) no longer triggers `abort` on its own. |
| `timeout_ms` | int | 15 min | Clamped to 1 h. Becomes `deadline_at`; the runner kills the whole process group when it passes. |
| `idle_timeout_ms` | int | 2 min | `session` mode only. Closes stdin after this long with no `agy_send` following a completed turn. Never fires mid-turn. Ignored for `oneshot`. |
| `expected_artifacts` | string[] | `[]` | Workspace-relative paths that must exist afterwards. A missing one blocks `verified_success`. |
| `json_schema` | string | — | Path to a JSON schema for structured output. Must be inside the project root. |
| `verify_command` | string | — | A command the *runner* — not agy — runs once, after agy exits normally, against the final workspace state. Not sandboxed, not a security boundary: it runs as the user, at the same trust level as the parent agent running the command itself. A non-zero exit or a `verify_timeout_ms` timeout makes `outcome` `"failed"`, never a blocker. See [`permissions.md`](./permissions.md#verify_command). |
| `verify_timeout_ms` | int | 10 min | Independent of `timeout_ms`/`deadline_at` — `verify_command` may run past the job's own deadline. Clamped to `limits.max_timeout_ms`. Ignored without `verify_command`. |
| `requested_by`, `parent_task_id` | string | — | Free-form attribution, echoed back by `agy_list_jobs`. |
| `dry_run` | boolean | `false` | Resolve config, argv, and policy — including the ceiling's rejections — without spawning `agy`. Costs no quota. |
| `expected_commands` | string[] | — | `dry_run` only: shell commands to evaluate against the effective policy. Returned in `preflight.commands` with allow/deny decisions. |

Returns `{ job_id, session_id, lifecycle: "queued", profile, cwd, session_mode, deadline_at, idle_timeout_ms }`,
or `{ dry_run: true, effective_config, preflight? }` when `dry_run` is set.

Both replies also carry, in the same vocabulary a finished job is judged in:

| Field | Notes |
| --- | --- |
| `policy_summary` | `{ profile, allow_count, bypass_sandbox, sandbox_forced_by, sandbox, sandbox_source, add_dirs, add_dirs_source }` — what the policy actually resolved to. `bypass_sandbox` is what every allowed `run_command` will get as `BypassSandbox`; `sandbox_forced_by` says why it is `false` when it is (`"profile"`, `"ceiling"`, `"request"`) and is `null` otherwise; `add_dirs_source` records where `add_dirs` came from (`"ceiling"`, `"request"`, `"none"`); `sandbox` / `sandbox_source` say which OS boundary the job runs under and who asked for it. |
| `blockers` | One `source: "policy_ceiling"` entry per `permissions.allow` / `read_roots` rule the ceiling refused, each with `actionable` and `remedy`. |
| `warnings` | Those blockers rendered as prose. |

**Read `policy_summary.allow_count`.** `allow` is intersected with the ceiling,
so a request the ceiling refuses wholesale collapses the effective list to
empty — profile defaults included — and the job then runs with nothing
explicitly allowed. `allow_count: 0` comes with its own blocker saying so, and
the remedy is to start again with no `permissions.allow` at all.

Use `dry_run` to settle permissions before spending a real turn, especially
when retrying a job that came back `blocked`.

## `agy_wait`

Long-polls until the job **finishes** or the budget runs out. It does not
return early on `queued` → `running`: a short `wait_ms` is a poll interval, not
a change notification, and each call blocks for its whole budget unless the job
is done.

| Field | Type | Notes |
| --- | --- | --- |
| `job_id` | string, required | |
| `wait_ms` | int | Max time to block, clamped to the 1 h ceiling. `0` = immediate snapshot. |
| `after_cursor` | int | Byte offset from a previous call, applied to the in-progress log tail. A finished job returns the full judgement packet and its end-of-stream cursor regardless. |

Returns the judgement packet — `outcome`, `headline`, `exit_code`,
`duration_ms`, `agent_status`, `contract_status`, `counts`
(`{ blockers, actionable, tool_errors, turns }`), `warnings`, and a capped log
tail. Never the full response text, and never the blocker list itself; use
`agy_result` for those.

`counts.blockers` is how many things stood in the way, `counts.actionable` how
many of them a different `agy_start` could lift. The `headline` names the
sources (`blocked … : 1 gate denial (actionable), 1 sandbox block`). For a job
that ran to a conclusion — not `canceled` / `timed_out` / `failed`, which
outrank verification — `outcome === "blocked"` exactly when some blocker has
`blocks_outcome: true`.

The returned `cursor` is safe to feed straight back into `agy_logs`. Calling `agy_wait` without `after_cursor` (or with `0`) reads backwards from the end of the events file to summarize the tail of the log, and returns `cursor` at the end of the file.

**How long to wait depends on your client, not on the job.** The job is
detached either way: it survives the call, the connection, and the client
process, so blocking is a convenience and never a requirement.

- Claude Code moves an MCP call that outlives its tool timeout (observed at
  120 s, `MCP_TOOL_TIMEOUT`) into a background task and notifies you when it
  returns — a long `wait_ms` costs one round trip and does not block the
  session. The backgrounded *call* does not survive leaving the session; the
  job does, and `agy_wait` picks it back up.
- Codex has no such backgrounding: a call that outlives `tool_timeout_sec`
  fails. Use a `wait_ms` inside that budget, or `wait_ms: 0` snapshots.

Polling costs tokens, not processes. `wait_ms: 0` returns the judgement packet
only, so it is the cheap way to check on several jobs at once.

## `agy_result`

Full result of a finished job. Returns a "not finished yet" reply instead of
an error while the job is still live.

| Field | Type | Notes |
| --- | --- | --- |
| `job_id` | string, required | |
| `section` | `summary` \| `agent_report` \| `verification` \| `response` \| `all` | Defaults to `summary`. |
| `offset`, `limit` | int | Character paging into the `response` section (8000 chars per page by default). |

- `summary` — the broker's verdict.
- `agent_report` — `agy`'s own claim. Unverified. Never decide anything from
  its `status` alone.
- `verification` — `blockers[]` (see below), `expected_artifacts[]`,
  `changed_files[]`, `verify` (below), and `warnings[]`: the blockers rendered
  as prose, plus observations that are not blockers, such as "this session
  was closed by its idle timeout, resume with `agy_start({ session_id })`".
- `response` — the agent's text, paged.

`verification.verify` — `null` when no `verify_command` was configured (or
the job's own deadline killed agy first, skipping verify entirely).
Otherwise `{ command, exit_code, signal, started_at, duration_ms, timed_out,
output_tail }` — `output_tail` is the last 2 KiB of `jobs/<id>/verify.log`;
the full log is that file, on disk, uncapped except at 1 MiB.

## `agy_logs`

The only way a client that did not start a job can watch it.

| Field | Type | Notes |
| --- | --- | --- |
| `job_id` | string, required | |
| `stream` | `events` \| `normalized` \| `stderr` \| `digest` | `events` is the raw NDJSON, `normalized` is one readable line per meaningful step, `digest` is the whole job on one screen (below). Defaults to `normalized`. |
| `after_cursor` | int | Byte offset. Mutually exclusive with `tail_lines`. |
| `tail_lines` | int | Last N lines. Mutually exclusive with `after_cursor`. |
| `max_bytes` | int | Defaults to the 32 KB response cap. |

Returns the slice plus the next cursor and an `eof` flag.

`stream: "digest"` returns `{ digest, text }` instead of lines: commands merged
with counts, files read/edited (workspace-relative), denials merged by rule,
tool errors that were not gate denials, and the outcome line — one screen for
"what did this job actually do". `after_cursor` / `tail_lines` are rejected
with that stream.

## `agy_send`

Queues a follow-up turn on a `session_mode: "session"` job by appending to the
job's inbox file, which the runner relays to `agy`'s stdin.

| Field | Type | Notes |
| --- | --- | --- |
| `job_id` | string, required | Must be a live `session` job. |
| `text` | string | The follow-up turn. Omit when only closing. |
| `close` | boolean | Close stdin after this turn, ending the process at EOF. |

At least one of `text` / `close` is required. **Queues only** — there is no way
to interrupt or redirect a turn already running, and `agy_send` does **not**
extend `deadline_at`. To keep working past the deadline, let the job finish and
resume with `agy_start({ session_id })`.

## `agy_cancel`

| Field | Type | Notes |
| --- | --- | --- |
| `job_id` | string, required | |
| `reason` | string | Recorded on the job. |
| `grace_ms` | int | Milliseconds between `SIGTERM` and `SIGKILL`. |

Kills the whole process group, not just the direct child. The recorded pgid is
signalled only when the pid still matches the recorded process start token, so
a recycled pid can never make this kill an unrelated process tree. The job
finalizes as `canceled` on the next reconcile.

## `agy_list_jobs`

Filters: `lifecycle[]`, `session_id`, `cwd` (exact canonical path), `since_ms`,
`limit`. Returns rows with lifecycle, outcome, headline, profile, timing, and
the attribution fields from `agy_start`.

## `agy_sessions`

`action`: `list` (default), `get`, `close`. `session_id` is required for `get`
and `close`; `list` also takes `state` (`active` / `closed`) and `limit`.

A session is one `agy` conversation; a job is one turn of it. Closing a session
marks it closed for bookkeeping — it does not kill a running job.

## `agy_capabilities`

No parameters. Reports the models `agy models` lists, each as
`{ name, efforts }` where `efforts` is the set of `--effort` values agy
accepts for that model (measured, agy 1.1.27: a name ending in
`-high|-medium|-low` accepts exactly that one, `claude-*` accepts none;
omitting `effort` is always fine), the modes, the two profiles with
their `write` / `bypass_sandbox` shape, the project's own permission
`ceiling` (see below), limits, the **discovered project root**, the server
version, the schema version, and whether the `agy` binary is reachable on
`PATH` (checked without ever spawning it).

`ceiling` — `{ path, present, version, allow, deny, exceptions, sandbox, read_roots, write_roots, command_policy, warnings }`,
loaded from `<project state dir>/policy.json` (see
[`permissions.md`](./permissions.md#the-project-ceiling-file)). `present:
false` means no ceiling file exists yet — every field then reads as empty,
which is narrower than having one, not wider, and `warnings` then carries one
"no project ceiling at <path>" line saying what the profile alone permits and
how to propose a ceiling (`agy_ceiling`, the `agy-ceiling` skill, or the user's
`/agy-ceiling`). The same line appears in `agy_start`'s `warnings` on every
call, and in `agy_result`'s `verification.warnings` when a gate blocker names a
rule the ceiling would carry. It is a hint, not an error: the user decides
whether the project needs more, and approves the file. Rule strings are reported
exactly as written in the file, `{workspace}` placeholder included; a
per-job `agy_start` call substitutes it into the real workspace path in its
own `policy_summary`. An invalid ceiling file fails this call the same way
it fails `agy_start` — never silently hidden behind an empty `ceiling`.

It also reports `client` — the name, version, and declared capabilities of the
MCP client on the other end of this connection, taken from the `initialize`
handshake. That is where to look before assuming an optional protocol feature
is available: `capabilities.tasks` is what decides whether a long call could be
handed back as a background task rather than held open. Measured: Codex
0.150.1 declares `elicitation` only, no `tasks`.

Call this first when a client's project root is in doubt.

## `agy_ceiling`

Read-only helper for proposing the project ceiling (`policy.json`). It has no
write path; the skill in `skills/agy-ceiling/SKILL.md` is the procedure
around it (and `/agy-ceiling`, from `commands/agy-ceiling.md`, is the same
procedure started by the user), and its rule is that the file is written only
after the user approves the shown draft. `agy-worker-setup` installs both into
`.claude/`.

| Field | Meaning |
| --- | --- |
| `draft` | Optional candidate `policy.json` object. With it, the reply reviews the draft instead of reporting history. |
| `expected_commands` | Optional. Judged as `general_worker` against the draft (when it loads) or the current file. |
| `history_limit` | Most recent jobs to fold into `history`. Default 100. |

Reply: `path` / `present` / `ceiling` (as `agy_capabilities` reports it);
`effective` — `general_worker` resolved against the draft or current file:
`allow`, `deny`, `hard_deny`, `lifted` (profile deny rules the ceiling's
`exceptions` removed), `read_roots`, `command_policy`, `warnings`; `review`
(draft only) — `{ ok, errors, warnings, rules[] }` where `ok` means
`loadCeiling` would accept the object, `errors` are its exact refusals, and
`rules[]` carries one row per rule with a risk class
(`read_utility | build | vcs_local | vcs_remote | network | install | destructive | privilege | filesystem | other`)
and advisory notes (already allowed by the profile, lifts nothing, needs
explicit approval); `preflight[]` — `{ command, decision, stage, required_rule }`
per expected command; `history` (no draft) — `agy_logs digest` aggregated
across the project's jobs: `outcomes`, `denied_rules[]` (`required_rule`,
count, last job), `top_commands[]`; `writes_nothing: true`, literally.

---

## The parent agent's side of the contract

What the caller — Claude Code, Codex, whoever holds the `agy_*` tools — has to
do for a job to be worth running. Distilled from a usage audit of 35 real jobs
(2026-09-08):

1. **Give every `general_worker` job something checkable.** `verify_command`
   (the build or test command), `expected_artifacts`, or `json_schema`. Without
   one the best outcome is `success_unverified`, and the caller ends up
   re-running the checks by hand. Twelve of the 35 audited jobs did.
2. **Match the prompt to the allow list.** Every shell command the prompt asks
   for must match `agy_capabilities`' `profiles[].allow` ∪ `ceiling.allow`; a rule on `profiles[].deny` needs `ceiling.exceptions`.
   A prompt demanding `JAVA_HOME=… ./gradlew` against a list that only allows
   `./gradlew` produced nine to ten denials per job before anyone noticed.
3. **One writing job per `cwd`.** A second `agy_start` on the same workspace
   fails with `LOCK_CONFLICT`. Parallel work goes into separate git worktrees
   inside the project root, one per job.
4. **Read `outcome`, never `agent_report.status`.** Then `verification.blockers[]`
   with `actionable` and `remedy`. When the remedy needs the ceiling, report
   the rule string and `ceiling.path` to the user verbatim and stop; telling
   the next job "don't run gradle" is not a fix, it moves the check back onto
   the caller.
5. **Pass `effort` only if `agy_capabilities.models[].efforts` lists it.**
   A model with the effort in its name (`gemini-3.8-flash-high`) accepts only
   that value, `claude-*` accepts none; anything else is a `ValidationError`
   before any job is created, and would have been a 5-second `failed` job.
6. **`dry_run` first after a blocked job.** It resolves the policy without
   spending a turn.

## Result vocabulary

### `outcome` — the broker's verdict, derived from events, exit status, and filesystem checks

| Value | Meaning |
| --- | --- |
| `verified_success` | Finished, and every check the broker could run actually passed — `expected_artifacts`/`json_schema` all satisfied, or a passing `verify_command` on its own. |
| `success_unverified` | Finished with no detected block, but nothing was checkable. Ask for `expected_artifacts` or a `verify_command` if you want more than this. |
| `blocked` | Ran to completion, but a permission denial or a silent sandbox block bit. **Treat this as "did not do what you asked."** Outranks a failing `verify_command` — a denial is reported before a check result. |
| `failed` | `agy` reported `ERROR`, exited non-zero, or a configured `verify_command` exited non-zero / timed out. |
| `timed_out` | `deadline_at` passed; the process group was killed. |
| `canceled` | `agy_cancel` killed it. |
| `process_error` | The runner itself failed: `hooks.json` never loaded (gate never confirmed within a few seconds of the first tool call — see [`permissions.md`](./permissions.md#what-the-runtime-guarantees)), or the runner process vanished without recording an exit code. |
| `orphaned` | The recorded pid is alive but is provably a different process (pid reuse); the job was abandoned. |

Precedence, most certain fact first: `canceled` → `timed_out` → `process_error` (gate missing / runner lost) → `orphaned` → agy's own exit/status → `blocked` (a confirmed refusal) → `verify_command` result → `verified_success` / `success_unverified`.

### `agent_status` — `agy`'s own self-report

`SUCCESS` / `ERROR` / `unknown`. Informational only. A permission denial and a
sandbox block both surface here as `SUCCESS` with `exit 0`, which is exactly why
`outcome` exists.

### `contract_status`

`not_required` / `satisfied` / `violated` / `unknown` — whether the job honoured
the structured-output contract (`json_schema`, `expected_artifacts`) the caller
asked for.

### `blockers[]` — what stood in the way

One list, one vocabulary, on `agy_result`'s `verification` and (for the
pre-flight case) on `agy_start`'s reply.

| Field | Notes |
| --- | --- |
| `source` | Who refused. See the table below. |
| `actionable` | Whether a different `agy_start` can lift it. |
| `remedy` | Exactly what to change. Present whenever someone can change something — a human editing the ceiling counts, so `actionable: false` may still carry one. Null only when nothing would help. |
| `blocks_outcome` | Whether this is a reason `outcome` is `blocked`. |
| `tool`, `command` | The tool call it happened on, when there was one. |
| `message` | Human-readable, carrying the measured message verbatim where there is one. |
| `detail` | The original record: `required_rule`, `signature`, the gate `policy` stage, `step_idx`. Nothing is lost. |

| `source` | What it is | `actionable` | `blocks_outcome` |
| --- | --- | --- | --- |
| `policy_ceiling` | A `permissions.allow` / `read_roots` entry the project ceiling refused, or the allow-collapse trap. Pre-flight, on `agy_start` only. | yes | n/a — there is no job yet |
| `gate` | Our own gate refused. The only refusal we can confirm. `remedy` is the rule to allow. | yes | yes |
| `gate`, `detail.policy: "containment"` | The command tried to write outside the workspace / `write_roots`, write into `{workspace}/.agents`, read outside the workspace / `read_roots` (`read_outside_workspace`), or used a path argument the gate cannot resolve (`unexpanded_path`: `$VAR`, backticks, non-leading `~`). Containment runs before rule matching. | **no** | yes |
| `gate`, `detail.policy: "unsupported"` | The tool itself is not one `permissions.allow` can grant (a subagent tool, or one outside the classified set). | **no** | yes |
| `agy_engine` | `agy`'s own permission engine refused, outside our policy entirely. Should not occur since 0.2.0 (agy's own engine is disabled for every job) — report it if it does. | no | **no** |
| `sandbox` | A known OS-sandbox signature in a `run_command`'s output, on a job that ran sandboxed. A job with `bypass_sandbox: true` gets a warning instead, never this blocker — there was no sandbox to blame. `actionable` is true when `permissions.sandbox` or `research_readonly` forced the sandbox (retry without / on `general_worker`), false when the ceiling's `sandbox` did (a human flips it to `"none"` or `"seatbelt"`, or adds the directory to `write_roots`); `remedy` names the lever, plus `read_roots` for a blocked toolchain path. | depends | yes |
| `broker` | A broker-side check failed: a missing `expected_artifacts` entry, or (never actionable) the gate never confirmed itself at all — see `process_error` above. | yes for a missing artifact, **no** for a missing gate confirmation | yes |
| `tool_error` | An ordinary failing tool call with no refusal signature. Not a permission matter. | no | **no** |

Why `agy_engine` and `tool_error` do not force `blocked`: a non-gate error step
is indistinguishable from an ordinary failing command by its shape alone, so
counting them as blocks would report every failing test as a permission
problem. They are reported, they appear in `warnings` and in the headline's
`(non-blocking: …)` fragment, and they never overturn a success verdict.

Both are also the reason to read `actionable` before retrying: no
`permissions.allow` rule affects either one.
