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
| `dry_run` | boolean | `false` | Resolve config, argv, and policy — including `rejected_allow` — without spawning `agy`. Costs no quota. |

Returns `{ job_id, session_id, lifecycle: "queued", profile, cwd, session_mode, deadline_at, idle_timeout_ms }`,
or `{ dry_run: true, effective_config }` when `dry_run` is set.

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
`duration_ms`, `agent_status`, `contract_status`, counts of denials /
environment blocks / missing artifacts / tool errors / turns, and a capped log
tail. Never the full response text; use `agy_result` for that.

The returned `cursor` is safe to feed straight back into `agy_logs`.

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
- `verification` — `permission_denials[]` (each with a `required_rule` you can
  paste into the next `permissions.allow`), `environment_blocks[]` (each with a
  `signature` explaining a silent sandbox failure), missing artifacts, and
  warnings such as "this session was closed by its idle timeout, resume with
  `agy_start({ session_id })`".
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

### Two blocked classes

- **Class 1** — a structured denial from our permission gate. Recoverable:
  `verification.permission_denials[].required_rule` names the rule to allow.
  A denial whose `policy` field says `containment` is *not* recoverable by
  allowing a rule; it means the command tried to leave the workspace.
- **Class 2** — a silent environment block, e.g. a denied DNS lookup, with no
  structured error anywhere. Detected by matching known output signatures;
  `verification.environment_blocks[].signature` says which one matched.
