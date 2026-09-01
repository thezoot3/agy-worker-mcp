# agy-worker-mcp

An MCP server that runs the Google Antigravity CLI (`agy`) as an asynchronous
worker agent, callable from Codex, Claude Code, and other MCP clients.

Jobs are detached from the client that started them: a job's process outlives
the MCP connection, its stdout/stderr are redirected to files rather than
piped, and its state lives in a project-local SQLite database. Any client
connected to the same project can start a job, watch it, take it over after
its original caller disconnected, or resume its conversation later.

The full design record — architecture decisions, the measured `agy` CLI facts
everything here is built on, the permission-gate and session model, and MVP
scope — lives in [`docs/`](./docs), starting at [`docs/README.md`](./docs/README.md).
This file is the practical, "how do I run and use it" entry point.

## Why detached jobs

`agy` runs turns that can take minutes to an hour. A plain stdio MCP server
tied to one client's process would lose the job the moment that client
disconnects, and would give a second client (say, Codex checking on a job
Claude Code started) no way to see it. Detaching the process, redirecting its
output to disk, and coordinating through SQLite makes the job durable and
visible independent of who is currently connected. See
[`docs/01-architecture.md`](./docs/01-architecture.md) for the full reasoning.

## The one fact that matters most

**`agy`'s own exit code and status cannot be trusted.** A permission denial
from the gate and a sandbox network block both surface as `exit 0` /
`status: SUCCESS` — `agy` itself does not know it was blocked, and will often
report success after quietly failing or working around the block. Every job
result this server returns carries a `broker`-computed `outcome` that is
derived from actual events, exit status, and filesystem checks, kept
deliberately separate from `agy`'s self-report (`agent_report`). Always read
`outcome` / `contract_status`, never `agent_report.status`, to decide whether
a job actually did what was asked. Details: [`docs/02-agy-cli-findings.md`](./docs/02-agy-cli-findings.md).

## Install and register

```bash
npm install
npm run build
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.agy]
command = "npx"
args = ["-y", "agy-worker-mcp"]
```

Claude Code:

```bash
claude mcp add agy -- npx -y agy-worker-mcp
```

The server discovers the project root by walking up from its `cwd` to a git
root, or honors `AGY_WORKER_PROJECT` as an override. Per-project state lives
under `~/.agy-worker/projects/<hash>/` — never inside the project itself, so
nothing here needs a `.gitignore` entry. `agy_capabilities` reports which
root was actually discovered.

## Tool surface

Nine tools, described in full (with parameter-level detail) in each server's
tool list — this is the map:

| Tool | Role |
| --- | --- |
| `agy_start` | Start a job, return `job_id` immediately. `dry_run: true` resolves policy and argv without spending quota. |
| `agy_wait` | Long-poll to the next state change or completion (`wait_ms: 0` = snapshot). Returns a compact judgement packet, not full logs. |
| `agy_result` | Full, paged result: broker verdict, `agent_report`, `verification` (denials, environment blocks, artifacts). |
| `agy_logs` | Raw or normalized event stream, by byte cursor or tail. The only way a client that did not start a job can see what it is doing. |
| `agy_send` | Queue a follow-up turn on a `session_mode: "session"` job. Queues only — cannot interrupt a running turn. |
| `agy_cancel` | Kill a running job and its whole process group. |
| `agy_list_jobs` | Running and recently finished jobs in this project. |
| `agy_sessions` | List, inspect, or close `agy` conversations. A session is one conversation; a job is one turn. |
| `agy_capabilities` | Models, profiles, limits, discovered project root, server version. |

## Recommended flow

```
agy_capabilities            -- see profiles, models, discovered root
agy_start                   -- returns job_id immediately
agy_wait (loop on cursor)   -- until lifecycle == "finished"
agy_result                  -- verdict, verification, response text
agy_logs                    -- only if you need the raw/normalized stream itself
```

When a job comes back `blocked`, `agy_result`'s
`verification.permission_denials[].required_rule` is a rule string
(e.g. `command(python -m pytest)`) — paste it into the next `agy_start`'s
`permissions.allow` and retry. `verification.environment_blocks[].signature`
explains a silent sandbox block such as a denied network lookup. Full detail
in [`docs/03-permissions-and-sessions.md`](./docs/03-permissions-and-sessions.md).

## Permissions

Two profiles ship in the MVP:

- **`research_readonly`** — read-only workspace access and shallow `git`
  inspection. No writes, no interpreters, no network. Default profile.
- **`general_worker`** — read/write inside the workspace, `git` and
  `pytest`, network opt-in. `git push`, package installs, `rm`, and `sudo`
  are hard-denied regardless of what a client requests.

A client's `permissions.allow` can only narrow a profile's ceiling, never
widen it — a request outside the ceiling comes back in the job's
`rejected_allow` rather than silently failing. `permissions.deny` always
wins. See [`docs/03-permissions-and-sessions.md`](./docs/03-permissions-and-sessions.md) §1.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run, against test/fake-agy — never the real agy binary
npm run build       # emits dist/server.js, dist/runner.js, dist/gate.js
```

Tests run exclusively against the scripted fake in [`test/fake-agy/`](./test/fake-agy);
the real `agy` CLI is never invoked by the test suite or by CI, since every
invocation spends real quota.
