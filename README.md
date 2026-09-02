> [!WARNING]
> This MCP is under development. there's a bunch of security issues and crashes. Don't use it on your project
# agy-worker-mcp

An MCP server that runs the Google Antigravity CLI (`agy`) as an asynchronous
worker agent, callable from Claude Code, Codex, and any other MCP client.

Jobs are detached from the client that started them: a job's process outlives
the MCP connection, its stdout/stderr are redirected to files rather than
piped, and its state lives in a project-local SQLite database. Any client
connected to the same project can start a job, watch it, take it over after its
original caller disconnected, or resume its conversation later.

## Why detached jobs

`agy` runs turns that take minutes to an hour. A plain stdio MCP server tied to
one client's process would lose the job the moment that client disconnects, and
would give a second client (Codex checking on a job Claude Code started) no way
to see it. Detaching the process, redirecting its output to disk, and
coordinating through SQLite makes the job durable and visible independent of
who is currently connected.

## The one fact that matters most

**`agy`'s own exit code and status cannot be trusted.** A permission denial and
a sandbox network block both surface as `exit 0` / `status: SUCCESS` — `agy`
itself does not know it was blocked, and will often report success after
quietly failing or working around the block.

Every result this server returns carries a broker-computed `outcome`, derived
from actual events, exit status, and filesystem checks, kept deliberately
separate from `agy`'s self-report (`agent_report`). Read `outcome` and
`contract_status`; never `agent_report.status`.

## Requirements

- Node.js ≥ 22.5
- The `agy` CLI on `PATH` (developed against 1.1.23).
  `agy_capabilities` tells you whether the server can find it.

## Install

Not published to npm yet. Install straight from GitHub:

```bash
npm install -g github:thezoot3/agy-worker-mcp
```

That builds on install (`prepare`) and puts `agy-worker-mcp` on your `PATH`.

Register it — Claude Code, project-scoped, which is easy to undo and affects
nothing else:

```bash
claude mcp add agy --scope project -- agy-worker-mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.agy]
command = "agy-worker-mcp"
```

<details>
<summary>From a clone instead</summary>

```bash
git clone https://github.com/thezoot3/agy-worker-mcp.git
cd agy-worker-mcp
npm install          # `prepare` builds dist/ for you
claude mcp add agy --scope project -- node "$PWD/dist/server.js"
```

Registering by absolute path means the server runs whatever is in `dist/` —
re-run `npm run build` after editing `src/`.
</details>

Check the registration with `claude mcp list`, and remove it with
`claude mcp remove agy --scope project`.

The server discovers the project root by walking up from its `cwd` to a git
root, or honors `AGY_WORKER_PROJECT` as an override. Per-project state lives
under `~/.agy-worker/projects/<hash>/` — never inside your repository, so
nothing here needs a `.gitignore` entry.

## Quick start

```
agy_capabilities                       -- profiles, models, discovered root
agy_start { prompt, profile }          -- returns job_id immediately
agy_wait  { job_id, wait_ms }          -- loop until lifecycle == "finished"
agy_result { job_id, section }         -- verdict, verification, response text
agy_logs  { job_id }                   -- only if you want the stream itself
```

`agy_start` with `dry_run: true` resolves configuration and policy without
spawning `agy`, so you can settle permissions before spending quota.

When a job comes back `blocked`, `agy_result`'s `verification.blockers[]` says
who refused. Each entry carries `actionable` (can a different `agy_start` lift
it) and `remedy` (what to change — for our own gate, the rule string to paste
into the next `permissions.allow`). `actionable: false` means no rule will
help: `agy`'s own permission engine refused, or the command tried to leave the
workspace.

## Tools

| Tool | Role |
| --- | --- |
| `agy_start` | Start a job, return `job_id` immediately. |
| `agy_wait` | Long-poll until the job **finishes** or `wait_ms` runs out. Returns a compact judgement packet, not logs. |
| `agy_result` | Full, paged result: broker verdict, agent self-report, verification. |
| `agy_logs` | Raw or normalized event stream, by byte cursor or tail. |
| `agy_send` | Queue a follow-up turn on a session-mode job. Cannot interrupt a running turn. |
| `agy_cancel` | Kill a running job and its whole process group. |
| `agy_list_jobs` | Running and recently finished jobs in this project. |
| `agy_sessions` | List, inspect, or close `agy` conversations. |
| `agy_capabilities` | Models, profiles, limits, discovered project root, server version. |

Parameter-level detail, the `outcome` vocabulary, and the two "blocked" classes
are in [`docs/tools.md`](./docs/tools.md).

## Permissions

Two profiles ship today:

- **`research_readonly`** (default) — read-only workspace access and shallow
  `git` inspection. No writes, no interpreters, no network.
- **`general_worker`** — read/write inside the workspace, `git`, `pytest`, and
  the common build commands (`./gradlew`, `gradle`, `mvn`, `npm test`,
  `npm run`, `javac`, `java`), network opt-in. `git push`, package installs,
  `rm`, and `sudo` are hard-denied regardless of what a client requests.

Client-requested permissions can only **narrow** a profile: `allow` is
intersected with the ceiling, `deny` always wins. `agy_start` reports what the
ceiling did to your request — `policy_summary.allow_count` and a
`source: "policy_ceiling"` blocker per rejected rule. Watch for
`allow_count: 0`: a fully rejected `allow` request collapses the effective list
to empty and takes the profile's own defaults with it.

> ⚠ **`general_worker` is not a trust boundary.** Its `default_decision` is
> `ask`, which delegates to `agy`'s own engine, and that engine auto-approves
> under `proceed-in-sandbox` — so any shell command not on a deny list runs, and
> an allowed interpreter can write anywhere. Shell redirection out of the
> workspace *is* blocked by the gate, but `agy`'s `--sandbox` does **not**
> confine writes (measured). Only `research_readonly`, whose fall-through
> verdict is `deny`, blocks anything for real. Run untrusted prompts under it.
> [`docs/permissions.md`](./docs/permissions.md#security-model-end-to-end) has
> the whole model, including what the gate does not see and where it fails
> open.

Full model — evaluation order, containment, denial recovery, sessions and locks
— in [`docs/permissions.md`](./docs/permissions.md).

## Documentation

- [`docs/tools.md`](./docs/tools.md) — the nine tools, parameter by parameter,
  and the result vocabulary
- [`docs/permissions.md`](./docs/permissions.md) — profiles, gate, containment,
  denial recovery, sessions
- [`docs/operations.md`](./docs/operations.md) — state layout, lifecycle, locks,
  timeouts, retention, test suites

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest, against test/fake-agy — never the real agy binary
npm run build       # emits dist/server.js, dist/runner.js, dist/gate.js
```

`npm test` and CI run exclusively against the scripted fake in
[`test/fake-agy/`](./test/fake-agy); the real `agy` CLI is never invoked there,
since every invocation spends real quota. The real binary is exercised only by
the opt-in live suite:

```bash
npm run test:live   # spends real agy quota
```

## License

MIT
