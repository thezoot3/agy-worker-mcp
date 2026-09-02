# Tool surface

Nine tools. Every handler runs a reconcile pass first — there is no daemon, so
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
| `permissions` | `{ allow?, deny?, network? }` | profile ceiling | Narrowing only. `allow` is intersected with the ceiling, `deny` is unioned, `network: "allow"` works only on a profile that permits opting in. |
| `on_denial` | `abort` \| `continue` \| `guide` | `continue` | What to do at the first policy denial. |
| `timeout_ms` | int | 15 min | Clamped to 1 h. Becomes `deadline_at`; the runner kills the whole process group when it passes. |
| `idle_timeout_ms` | int | 2 min | `session` mode only. Closes stdin after this long with no `agy_send` following a completed turn. Never fires mid-turn. Ignored for `oneshot`. |
| `expected_artifacts` | string[] | `[]` | Workspace-relative paths that must exist afterwards. A missing one blocks `verified_success`. |
| `json_schema` | string | — | Path to a JSON schema for structured output. Must be inside the project root. |
| `requested_by`, `parent_task_id` | string | — | Free-form attribution, echoed back by `agy_list_jobs`. |
| `dry_run` | boolean | `false` | Resolve config, argv, and policy — including the ceiling's rejections — without spawning `agy`. Costs no quota. |

Returns `{ job_id, session_id, lifecycle: "queued", profile, cwd, session_mode, deadline_at, idle_timeout_ms }`,
or `{ dry_run: true, effective_config }` when `dry_run` is set.

Both replies also carry, in the same vocabulary a finished job is judged in:

| Field | Notes |
| --- | --- |
| `policy_summary` | `{ profile, allow_count, network, default_decision }` — what the policy actually resolved to. |
| `blockers` | One `source: "policy_ceiling"` entry per `permissions.allow` rule the ceiling refused, each with `actionable` and `remedy`. |
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

The returned `cursor` is safe to feed straight back into `agy_logs`.

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
  `changed_files[]`, and `warnings[]`: the blockers rendered as prose, plus
  observations that are not blockers, such as "this session was closed by its
  idle timeout, resume with `agy_start({ session_id })`".
- `response` — the agent's text, paged.

## `agy_logs`

The only way a client that did not start a job can watch it.

| Field | Type | Notes |
| --- | --- | --- |
| `job_id` | string, required | |
| `stream` | `events` \| `normalized` \| `stderr` | `events` is the raw NDJSON, `normalized` is one readable line per meaningful step. Defaults to `normalized`. |
| `after_cursor` | int | Byte offset. Mutually exclusive with `tail_lines`. |
| `tail_lines` | int | Last N lines. Mutually exclusive with `after_cursor`. |
| `max_bytes` | int | Defaults to the 32 KB response cap. |

Returns the slice plus the next cursor and an `eof` flag.

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

No parameters. Reports the observed models and modes, the two profiles with
their `write` / `network` / `default_decision` shape, limits, the **discovered
project root**, the server version, the schema version, and whether the `agy`
binary is reachable on `PATH` (checked without ever spawning it).

It also reports `client` — the name, version, and declared capabilities of the
MCP client on the other end of this connection, taken from the `initialize`
handshake. That is where to look before assuming an optional protocol feature
is available: `capabilities.tasks` is what decides whether a long call could be
handed back as a background task rather than held open. Measured: Codex
0.150.1 declares `elicitation` only, no `tasks`.

Call this first when a client's project root is in doubt.

---

## Result vocabulary

### `outcome` — the broker's verdict, derived from events, exit status, and filesystem checks

| Value | Meaning |
| --- | --- |
| `verified_success` | Finished, and every check the broker could run actually passed. |
| `success_unverified` | Finished with no detected block, but nothing was checkable. Ask for `expected_artifacts` if you want more than this. |
| `blocked` | Ran to completion, but a permission denial or a silent sandbox block bit. **Treat this as "did not do what you asked."** |
| `failed` | `agy` reported `ERROR`, or exited non-zero. |
| `timed_out` | `deadline_at` passed; the process group was killed. |
| `canceled` | `agy_cancel` killed it. |

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
| `remedy` | Exactly what to change. Null when — and only when — `actionable` is false. |
| `blocks_outcome` | Whether this is a reason `outcome` is `blocked`. |
| `tool`, `command` | The tool call it happened on, when there was one. |
| `message` | Human-readable, carrying the measured message verbatim where there is one. |
| `detail` | The original record: `required_rule`, `signature`, the gate `policy` stage, `step_idx`. Nothing is lost. |

| `source` | What it is | `actionable` | `blocks_outcome` |
| --- | --- | --- | --- |
| `policy_ceiling` | A `permissions.allow` entry the profile ceiling refused. Pre-flight, on `agy_start` only. | yes | n/a — there is no job yet |
| `gate` | Our own gate refused. The only refusal we can confirm. `remedy` is the rule to allow. | yes | yes |
| `gate`, `detail.policy: "containment"` | The command tried to leave the workspace. Containment runs before rule matching. | **no** | yes |
| `agy_engine` | `agy`'s own permission engine refused, outside our policy entirely. | no | **no** |
| `sandbox` | `agy`'s sandbox blocked it silently — a known output signature matched. | network signatures only | yes |
| `broker` | A broker-side check failed: an `expected_artifacts` entry that does not exist. | yes | yes |
| `tool_error` | An ordinary failing tool call with no refusal signature. Not a permission matter. | no | **no** |

Why `agy_engine` and `tool_error` do not force `blocked`: a non-gate error step
is indistinguishable from an ordinary failing command by its shape alone, so
counting them as blocks would report every failing test as a permission
problem. They are reported, they appear in `warnings` and in the headline's
`(non-blocking: …)` fragment, and they never overturn a success verdict.

Both are also the reason to read `actionable` before retrying: no
`permissions.allow` rule affects either one.
