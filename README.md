> **Important — under active development (0.4.x).** The permission model is a string classifier over
> tool calls — the same kind of boundary Claude Code and Codex use, not a kernel
> boundary. Allowed shell commands run **without** an OS sandbox by default since 0.2.1
> (can be enabled with `sandbox: "seatbelt"`). What the gate deliberately does not
> see is documented in [`docs/permissions.md`](https://github.com/thezoot3/agy-worker-mcp/blob/main/docs/permissions.md#what-the-gate-deliberately-does-not-see);
> read it before starting. Point it only at projects you would let Claude Code work on unattended.

# agy-worker-mcp

An MCP server that runs the Google Antigravity CLI (`agy`) as an asynchronous
worker agent, callable from Claude Code, Codex, and any other MCP client.

> **Unofficial.** agy-worker-mcp is an independent, third-party MCP server. It is not affiliated with, endorsed by, or supported by Google. "Google", "Antigravity", "Gemini", and the `agy` command name are trademarks or product names of Google LLC and are used here only to identify the CLI this server drives. See [Trademarks and terms](#trademarks-and-terms).

Jobs are detached from the client that started them: a job's process outlives
the MCP connection, its stdout/stderr are redirected to files rather than
piped, and its state lives in a project-local SQLite database. Any client
connected to the same project can start a job, watch it, take it over after its
original caller disconnected, or resume its conversation later.

How it keeps a job honest: every tool call `agy` makes passes through our own
`PreToolUse` gate, which is the sole approval authority (`agy`'s own engine is
off). What a job may do is set by two walls — the shipped profile, and a
human-owned per-project ceiling file that lives outside the workspace — and a
client request can only narrow within them. Allowed shell commands run without
an OS sandbox by default, as under Claude Code; a project can put a write-only
kernel boundary back with `sandbox: "seatbelt"`. `agy_ceiling`, the shipped
`agy-ceiling` skill and the `/agy-ceiling` slash command let an agent or a user
propose that ceiling from the project's denial history — and nothing writes
the file without your approval. Version-by-version detail is in
[`CHANGELOG.md`](https://github.com/thezoot3/agy-worker-mcp/blob/main/CHANGELOG.md).

## Why detached jobs

`agy` runs turns that take minutes to an hour. A plain stdio MCP server tied to
one client's process would lose the job the moment that client disconnects, and
would give a second client (Codex checking on a job Claude Code started) no way
to see it. Detaching the process, redirecting its output to disk, and
coordinating through SQLite makes the job durable and visible independent of
who is currently connected.

## The one fact that matters most

**`agy`'s own exit code and status cannot be trusted.** A permission denial —
and, on a job that runs sandboxed, an OS-sandbox block — surfaces as `exit 0`
/ `status: SUCCESS`. `agy` itself does not know it was blocked, and will often
report success after quietly failing or working around the block.

Every result this server returns carries a broker-computed `outcome`, derived
from actual events, exit status, and filesystem checks, kept deliberately
separate from `agy`'s self-report (`agent_report`). Read `outcome` and
`contract_status`; never `agent_report.status`.

## Requirements

- Node.js ≥ 22.5, installed with a version manager. A root-owned global prefix
  (the official `.pkg` installs into `/usr/local`) makes `npm install -g` fail
  with `EACCES`.
- The `agy` CLI on `PATH` (developed and measured against agy 1.1.24–1.1.27).
  `agy_capabilities` tells you whether the server can find it.

## Install

```bash
npm install -g agy-worker-mcp
agy-worker-setup
```

`npm install -g` puts `agy-worker-mcp`, `agy-worker-setup` and the two helper
binaries (`agy-worker-runner`, `agy-worker-gate`) on your `PATH`.
`agy-worker-setup` then does the two things npm cannot:

1. writes a **stable launcher** at `~/.agy-worker/bin/agy-worker-mcp` that
   finds Node and this server itself at spawn time, and
2. copies the `agy-ceiling` skill and the `/agy-ceiling` slash command into
   `~/.claude/` and `~/.codex/` (user scope by default; `--scope project` puts
   them in `./.claude/` instead).

It never writes a client's config file, never overwrites an existing file
without `--force`, and `--dry-run` prints the plan. `--link` symlinks instead
of copying, so a package upgrade is picked up without re-running it.
`--client claude|codex|all` narrows what it touches.

### Why the launcher

A GUI-launched client does not run your shell profile. It gets launchd's
`PATH` — `/usr/bin:/bin:/usr/sbin:/sbin` — where `node` does not exist if you
installed it with `fnm`, `nvm`, `volta`, `asdf` or `mise`. Registering the
command as `agy-worker-mcp` then works in a terminal and fails silently in the
app.

The launcher is a plain `sh` script with no dependency on `PATH`: it records
the Node and server paths that were live at install time, checks them, and
falls back to the newest version each common version manager has on disk. Point
your client at it rather than at a bare command:

```bash
claude mcp add agy --scope user -- ~/.agy-worker/bin/agy-worker-mcp
```

```toml
# ~/.codex/config.toml
[mcp_servers.agy]
command = "/Users/you/.agy-worker/bin/agy-worker-mcp"
```

`agy-worker-setup` prints both lines, filled in for your machine.

### When something is wrong

```bash
agy-worker-setup --doctor
```

checks the launcher, the Node it resolves, whether `agy` is reachable and from
where, and what each client's config actually points at — which is usually the
answer when a server "does not start" with no error anywhere.

<details>
<summary>From GitHub or a clone instead</summary>

```bash
npm install -g github:thezoot3/agy-worker-mcp   # builds on install (prepare)
```

```bash
git clone https://github.com/thezoot3/agy-worker-mcp.git
cd agy-worker-mcp
npm install          # `prepare` builds dist/ for you
claude mcp add agy --scope project -- node "$PWD/dist/server.js"
```

A clone registered this way cannot run jobs in that same clone: `agy_start`
refuses a workspace that contains the gate binary (`gate binary must not lie
inside the workspace`). Contributors who want to dogfood must register the
globally installed copy.

Registering by absolute path means the server runs whatever is in `dist/` —
re-run `npm run build` after editing `src/`.
</details>

Check the registration with `claude mcp list`, and remove it with
`claude mcp remove agy --scope user`.

The server discovers the project root by walking up from its `cwd` to a git
root — a linked worktree resolves to the repository it belongs to, so every
worktree of one repository shares one ceiling, one lock domain and one database
— or honors `AGY_WORKER_PROJECT` as an override. Per-project state lives under
`~/.agy-worker/projects/<hash>/`, never inside your repository.

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

Need a job to see a toolchain that lives outside the workspace — `./gradlew`
reading `~/.jdks`, say? Add it to the project's own permission ceiling file
(`~/.agy-worker/projects/<hash>/policy.json`, `agy_capabilities.ceiling.path`
tells you the exact path), then ask for it in `agy_start`:

```json
// ~/.agy-worker/projects/<hash>/policy.json
{ "version": 2, "read_roots": ["~/.jdks"] }
```

```
agy_start { profile: "general_worker", permissions: { read_roots: ["~/.jdks"] }, ... }
```

Without the matching ceiling entry, `read_roots` in the request is
dropped and reported in `rejected_read_roots` — see
[`docs/permissions.md`](https://github.com/thezoot3/agy-worker-mcp/blob/main/docs/permissions.md) for the full model.

When a job comes back `blocked`, `agy_result`'s `verification.blockers[]` says
who refused. Each entry carries `actionable` (can a different `agy_start` lift
it) and `remedy` (what to change — for our own gate, the rule string the
effective allow list was missing). `actionable: false` means no `agy_start`
argument will help: the command tried to leave the workspace, the rule is not
in the project ceiling, or the ceiling forces the sandbox on — each of those is
a human editing `policy.json`, or a different command.

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
| `agy_capabilities` | Models, profiles, the project ceiling as loaded, limits, discovered project root, server version. |
| `agy_ceiling` | Read-only: the ceiling, the effective policy, denial history, and a review of a draft ceiling. Never writes. |
| `agy_release_workspace` | Remove a finished worktree job's worktree and delete its branch, once you have merged it. |

Parameter-level detail, the `outcome` vocabulary, and the two "blocked" classes
are in [`docs/tools.md`](https://github.com/thezoot3/agy-worker-mcp/blob/main/docs/tools.md).

## Worktree isolation

```
agy_start { isolation: "worktree", prompt, profile: "general_worker" }
```

puts the job in a fresh git worktree at `<root>/.worktrees/agy-<job_id>`, on
branch `agy/<job_id>`. Two jobs on one repository stop fighting over one tree,
and you can read a job's work before deciding to take it.

The job **cannot commit** — on a worktree job the gate denies `git commit`,
`git merge`, `git rebase`, `git cherry-pick`, `git revert` and `git stash`, and
no ceiling can lift them — so the branch is a proposal, not a fact. You merge
it:

```bash
git merge --squash agy/<job_id>
agy_release_workspace { job_id }        # removes the worktree, deletes the branch
```

A fresh worktree has no `node_modules`, so a JavaScript project's tests fail on
the first call. List what to link in the project ceiling:

```json
{ "version": 2, "link_paths": ["node_modules"] }
```

The server symlinks those in and widens the job's **read** roots to the real
directory behind each link — writes through the link stay denied, so one job
cannot corrupt what every other worktree and your own tree share. It is a
ceiling key with no request field: a link is a read-root widening, and that is
yours to decide.

`agy_capabilities.worktrees` lists worktrees still on disk. `on_finish:
"remove"` cleans up automatically, but only when the worktree is clean *and*
its branch carries nothing the base does not already have — the default is
`keep`, because removal ends in `git branch -D` and deleting an unmerged
worktree destroys the job's entire output.

## Permissions

Every tool call `agy` makes passes through our own `PreToolUse` hook, which
decides allow/deny and OS-sandbox bypass on every single call — `agy`'s own
approval engine is disabled for every job (0.2.0), so our gate is the sole
authority. Three owners set the rules, each able to do one thing to the layer
below it: **code** (hard denies, the two shipped profiles — fixed), the
**project's own ceiling file** (`~/.agy-worker/projects/<hash>/policy.json`,
outside the workspace — widens what a job may ever ask for), and **the parent
agent's `agy_start.permissions`** (narrows within that ceiling, never widens
it).

Two profiles ship today:

- **`research_readonly`** (default) — read-only workspace access and shallow
  `git` inspection. No writes, no interpreters.
- **`general_worker`** — read/write inside the workspace, `git`, `pytest`, and
  the common build commands (`./gradlew`, `gradle`, `mvn`, `npm test`,
  `npm run`, `javac`, `java`). `git push`, `curl`, package installs, `rm -rf`, and `sudo`
  are denied by default — a project ceiling's `exceptions` can lift them, a
  client request never can — and an action that
  matches nothing is **denied**, never delegated to `agy`'s own engine — a
  bound job's gate never answers "ask".

Client-requested permissions can only **narrow** the ceiling: `allow` is
intersected with it, `deny` always wins, `sandbox: "seatbelt" | "agy"` raises the OS
sandbox on for the job, and `read_roots` (extra `--add-dir` roots for a
toolchain outside the workspace) is intersected with the ceiling's own list.

The OS sandbox is **off** for allowed commands on `general_worker` (0.2.1) —
the gate's string match, not the kernel, is what bounds an allowed command,
same as Claude Code. It stays on for `research_readonly`, and a project can
force it on for every job with `sandbox: "agy"` in its ceiling file; expect
in-workspace builds, tests, and `git commit` to fail there on agy 1.1.24.

`agy_start` reports what the ceiling did to your request —
`policy_summary` (`allow_count`, `bypass_sandbox`, `sandbox_forced_by`) and a
`source: "policy_ceiling"` blocker per rejected rule. Watch for
`allow_count: 0`: a fully rejected `allow` request collapses the effective
list to empty and takes the profile's own defaults with it.

Full model — the three owners, the ceiling file schema, the gate's decision
order, containment, `verify_command`, and denial recovery — is in
[`docs/permissions.md`](https://github.com/thezoot3/agy-worker-mcp/blob/main/docs/permissions.md).

### Proposing a ceiling (skill)

The package ships a Claude Code skill, `skills/agy-ceiling/SKILL.md`, that
walks the parent agent through drafting a project ceiling from denial history
and the repository, validating it with `agy_ceiling`, and showing it to you —
and that forbids writing the file without your explicit approval of that
draft. The server has no code path that writes the ceiling at all; the skill is
the second wall.

For the case where *you* want the ceiling, not the agent, there is a slash
command, `commands/agy-ceiling.md`: `/agy-ceiling cargo build, git push` runs
the same procedure on demand, seeded with the commands you name, and still
stops for your answer before writing. `agy-worker-setup` installs both (see
[Install](#install)); by hand it is a copy:

```bash
cp -R "$(npm root -g)/agy-worker-mcp/skills/agy-ceiling" .claude/skills/
cp "$(npm root -g)/agy-worker-mcp/commands/agy-ceiling.md" .claude/commands/
```

## Documentation

- [`docs/tools.md`](https://github.com/thezoot3/agy-worker-mcp/blob/main/docs/tools.md) — the eleven tools, parameter by parameter,
  and the result vocabulary
- [`docs/permissions.md`](https://github.com/thezoot3/agy-worker-mcp/blob/main/docs/permissions.md) — the three-owner permission
  model, the ceiling file, the gate's decision order, containment,
  `verify_command`, denial recovery
- [`docs/operations.md`](https://github.com/thezoot3/agy-worker-mcp/blob/main/docs/operations.md) — state layout, lifecycle, locks,
  timeouts, retention, test suites
- [`CHANGELOG.md`](https://github.com/thezoot3/agy-worker-mcp/blob/main/CHANGELOG.md) — what changed in each version

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest, against test/fake-agy — never the real agy binary
npm run build       # emits dist/server.js, dist/runner.js, dist/gate.js, dist/setup.js
```

`npm test` and CI run exclusively against the scripted fake in
[`test/fake-agy/`](https://github.com/thezoot3/agy-worker-mcp/blob/main/test/fake-agy); the real `agy` CLI is never invoked there,
since every invocation spends real quota. The real binary is exercised only by
the opt-in live suite:

```bash
npm run test:live   # spends real agy quota
```

## Trademarks and terms

agy-worker-mcp is an unofficial third-party integration; the name describes what
it drives, not who made it. Google, Antigravity, Gemini, and `agy` are Google LLC
trademarks; no license to those marks is granted or implied by this package.

This package launches the unmodified, officially installed `agy` binary as a
local subprocess on the user's own machine, using documented command-line flags
only (`--print`, `--output-format`, `--add-dir`, `--model`, `--effort`,
`--print-timeout`, `--dangerously-skip-permissions`) and the documented
`.agents/hooks.json` PreToolUse hook mechanism. Authentication stays entirely
inside `agy` (the user's own `agy` login); this package never reads, stores,
proxies, or forwards Antigravity credentials or tokens and never calls
Antigravity or Gemini backends itself. Model calls run inside agy's own harness,
and every job is charged to the user's own Antigravity plan quota. Multiple jobs
in parallel (limit `max_running_jobs`) consume quota faster than an interactive
session; keep parallelism modest.

Using this package means running agy under your own account. You are responsible
for complying with the [Google Antigravity Additional Terms of Service](https://antigravity.google/terms/)
and the [Antigravity FAQ on third-party tools](https://antigravity.google/docs/faq/).
Google's terms forbid using third-party software with an Antigravity login to
reach the models outside the official product, and Google has suspended accounts
for that. This package is designed to stay on the "spawn the official CLI" side
of that line, but the authors make no representation that Google agrees, and
Google may change its terms. Users needing a different harness should use a
Vertex AI or AI Studio API key as Google's FAQ suggests.

Provided "as is" under the [MIT license](#license); no warranty regarding
compliance with any third-party terms.

## License

MIT
