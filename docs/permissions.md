# Permissions

Every tool call `agy` wants to make passes through our `PreToolUse` hook first, and the hook decides two things on every call: **allow or deny**, and whether the command runs inside the OS sandbox (`BypassSandbox`). Under a bound job the hook never answers "ask" — it is one or the other, always.

The gate is a string classifier over the call — the same kind of boundary Claude Code and Codex use. A `run_command` the effective policy allows runs **without** `agy`'s OS sandbox on `general_worker` (0.2.1). What bounds an allowed command is therefore the allow list itself, the deny lists, containment (`Cwd` and every redirect target pinned inside the workspace), the `.agents` lockdown, and subagent denial — not the kernel. The OS sandbox is an opt-in extra (`sandbox: "seatbelt"` or `"agy"` in the ceiling, or `permissions.sandbox` per job) and stays always-on for `research_readonly`.

## Why the sandbox is off by default

Measured on agy 1.1.24 (2026-09-02, nine variants — flag, `--sandbox`, hook `overwrite`, hook `ask`/`allow`, prompt shape, directory location): a sandboxed `run_command` cannot write **anywhere inside the `--add-dir` workspace** — no file creation, no `mkdir`, no `>` redirection, no `.git/index.lock`. `~/.gradle` stays writable, and `agy`'s own file tools (`write_to_file`, `replace_file_content`) are not sandboxed at all. So on a sandboxed job the gate says yes to `npm test` and the kernel says no; the sandbox never offered "runs, but contained", only "does not run". 0.2.0 papered over that with a per-command `unsandboxed` list in the ceiling, which was full filesystem and network access for that command anyway. 0.2.1 drops the pretence: an allowed command runs as the user, the way it would under Claude Code, and the ceiling's one sandbox switch is for projects that prefer a read-mostly job over a working one.

## Who sets the rules

| Owner | Location | Can |
| --- | --- | --- |
| Code | `HARD_DENY` (`src/policy/hard-deny.ts`), `PROFILES` (`src/policy/profiles.ts`) | `HARD_DENY` is fixed: nothing below can remove or shadow it. Profile deny rules are the default, liftable one by one through the ceiling's `exceptions`. |
| Human | `~/.agy-worker/projects/<hash>/policy.json` (project ceiling, outside the workspace) | Widen or narrow — grants what a job may ever ask for, lifts profile denies, adds denies, forces the sandbox. |
| Parent agent | `agy_start.permissions` | Narrow only, within the human ceiling. |

Four layers say "no", and each has exactly one key that opens it:

| Layer | Examples | Opened by |
| --- | --- | --- |
| `HARD_DENY` | `.agents/**` writes, credential reads, subagent tools | Nothing. |
| Profile deny | `git push`, `curl`, `wget`, `ssh`, `scp`, `sudo`, `docker`, `rm -rf`, `git reset --hard`, `npm install` | Ceiling `exceptions` (exact rule string). |
| Not on the allow list | `cargo build`, `make`, `go test` | Ceiling `allow`, or `command_policy: "denylist"`. |
| Containment | writes outside `write_roots`, reads outside `read_roots` | Ceiling `read_roots` for reads; writes never leave the workspace. |

No ceiling file means the profile as shipped: allowlist mode, nothing lifted. That is deliberate — a bound job has no "ask", so the allow list stands in for the human until the human writes the file. The server says so out loud rather than leaving the agent to discover it one denial at a time: `agy_capabilities.ceiling.warnings`, every `agy_start` reply's `warnings`, and a blocked job's `verification.warnings` each carry one "no project ceiling at <path>" line that names the file and the three ways to propose one (`agy_ceiling`, the `agy-ceiling` skill, `/agy-ceiling`). The agent may draft; only the user approves.

The ceiling file lives **outside the workspace** on purpose: a `general_worker` job can write anywhere `{workspace}/**` covers, and a ceiling file living inside the workspace would let a job rewrite its own limits. Hard denies, applied on top of everything:

```
read_file(~/.ssh/**)  read_file(~/.aws/**)  read_file(~/.gnupg/**)  read_file(~/.netrc)
read_file(~/.npmrc)  read_file(~/.git-credentials)  read_file(~/.config/gh/**)
read_file(~/.config/gcloud/**)  read_file(~/.docker/config.json)  read_file(~/.kube/**)
write_file({workspace}/.agents/**)
```

Since 0.3.1 the same locations — plus `~/.gemini`, `~/.antigravity` and the state home `~/.agy-worker` — are also refused when they appear as a path argument or redirection target of any `run_command` (`hard_deny: credential path protected`), through `bash -c` and after `~/` expansion. `$HOME` is not expanded; a path argument carrying `$`, a backtick or a non-leading `~` is refused as `unexpanded_path` instead.

Before 0.3.0 `rm -rf`, `git push`, `sudo` and `curl` were here too. They are policy, not integrity, so they moved to `general_worker`'s own deny list where a project can lift them.

Two profiles ship (`research_readonly`, `general_worker`); read their live allow/deny lists from `agy_capabilities.profiles` rather than here, so this doc cannot drift from the code.

- `research_readonly` allows workspace reading and shallow git queries (`git status|log|diff`) with OS sandboxing always on, denying writes and interpreters.
- `general_worker` is a workspace-scoped developer, not a general shell: network (`curl`, `wget`, `ssh`, `scp`), remote git (`git push`), package installs, containers (`docker`), `sudo` and destructive git are denied by default and open only through the ceiling's `exceptions`. It allows workspace read/write and an expanded set of standard POSIX utilities (`ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find`, `stat`, `sed`, `sort`, `uniq`, `diff`, `cut`, `tr`, `basename`, `dirname`, `realpath`, `which`, `echo`, `printf`, `test`, `true`, `false`, `mkdir`, `touch`, `cp`, `mv`, `rm`), common build/test commands (`gradle`, `mvn`, `npm test/run`, `javac/java`, `pytest`), and inline interpreters (`python3 -c`, `python -c`, `node -e`, `bash -c`, `sh -c` — inner commands must also pass policy; `zsh -c` and other shells are not wrappers and need their own rule). `find` may not carry `-exec`, `-execdir`, `-ok`, `-okdir` or `-delete`; `xargs` is off the list and `xargs <cmd>` is judged as `<cmd>` (0.3.1). Git commands are permitted under a denylist: `git -c` / `git -C` / `--git-dir` / `--work-tree` global options and `git config` writes to executable keys (`core.hooksPath`, `core.sshCommand`, `core.pager`, `core.editor`, `alias.*`, `credential.*`, `filter.*`, `url.*`, `http.*`, …) are always denied (0.3.1), as are `git reset --hard`, `git clean`, `git filter-branch`, `git branch -D`, `git stash drop`, `git remote add/set-url`, `git config --global`, and bulk checkouts/restores (`git checkout -- .`, `git restore .`, `git restore --staged .`) are denied. Mutating commands (`rm`, `mv`, `cp`, `touch`, `mkdir`, `ln`, `install`, `truncate`, `rsync`, `tee`, `sed -i`, `sort -o`, `dd of=`, `tar -C`, `unzip -d`, `javac -d`, `git archive/clone/init/worktree`) are restricted by filesystem containment: every write target, resolved against the pinned workspace, must stay inside the workspace or the ceiling's `write_roots`. Read utilities (`cat`, `head`, `grep`, `sed`, `awk`, `find`, `diff`, …) and script arguments to `python3` / `node` / `java` are contained the same way on the read side: a path outside the workspace and `read_roots` is refused (`read_outside_workspace`), except `/dev/null`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`. A glob is contained by the directory before its first `*`/`?`/`[` (`src/*.ts` → `src`).

## The project ceiling file

Version 2 since 0.3.0. A `version: 1` file (`extra_allow` / `extra_deny` / `additional_dirs`) is still read and converted, with a warning in `agy_capabilities.ceiling.warnings` naming the renames; it is **rejected** in 0.4.0 — a job will not start against a version 1 file. `agy_ceiling()` returns `v1_migration` with the version 2 equivalent and the one command that writes it; convert before upgrading.

`<state home>/projects/<sha256(canonical_root)[:16]>/policy.json`. Missing file → empty ceiling (narrower, not wider, than having one). Present but invalid — bad JSON, wrong `version`, an unparsable rule, an `exceptions` entry naming a `HARD_DENY` rule, or a legacy `unsandboxed` key — and `agy_start` fails closed with a `ValidationError` naming the file.

```json
{
  "version": 2,
  "allow": ["command(./gradlew)", "command(mvn)"],
  "deny": [],
  "exceptions": ["command(git push)"],
  "sandbox": "none",
  "write_roots": [],
  "read_roots": ["~/.jdks", "~/.gradle"],
  "command_policy": "allowlist"
}
```

- `allow` / `deny` — added to the profile's own allow/deny.
- `exceptions` — profile deny rules this project lifts, matched by exact string (`command(git)` does not lift `command(git push)`). Cannot name a `HARD_DENY` rule (the file is rejected). Ignored, with a warning, on `research_readonly`. Lifted rules are reported per job in `effective_config.policy.lifted`.
- `sandbox` — `"none"` (default) \| `"seatbelt"` \| `"agy"`. The OS boundary for every allowed `run_command` on `general_worker`; the strictest of profile / ceiling / request wins. `seatbelt` (macOS, 0.3.0) wraps the command in our own `sandbox-exec` profile that allows everything except file writes outside `write_roots` (plus tmp) — so a write through an allowed interpreter (`python3 -c "open('../x','w')"`) is refused by the kernel, not just unseen by the gate. The gate keeps judging *which* command runs; the seatbelt bounds what it can *touch*. `agy` is agy's own sandbox (the 0.2.0 behaviour; the legacy `sandboxed: true` still reads as this). On agy 1.1.24 that means in-workspace builds, test runs, and `git commit` fail with `Operation not permitted` while code edits through `agy`'s file tools still land — pair it with `verify_command` if you need checks. A `policy.json` that still carries the 0.2.0 `unsandboxed` list fails closed, with a message telling the human to delete the key (and set `sandboxed: true` if they want the sandbox on).
- `read_roots` — extra `--add-dir` roots, read/exec only.
- `write_roots` — directories outside the workspace jobs may write to (plain directories, no globs). Widens containment for the file tools and the seatbelt profile alike; the usual entries are build caches (`~/.gradle`, `~/.npm`, `~/.m2`) a sandboxed build needs. A write root is readable too. Measured (M4): the registered path is opened inside the OS sandbox for **reading and executing**, not just for our own containment — the primary lever for a toolchain outside the workspace, e.g. letting `./gradlew` see `~/.jdks`.
- `command_policy` — optional `"allowlist" | "denylist"`, default `"allowlist"`. Controls the gate's default decision when a command matches no rule in the allow list.
- Globs match exactly or via `*` / `**`; a subdirectory needs `**` (`~/.jdks/**`, not `~/.jdks/*`).
- `~` expands to home. `{workspace}` is substituted per job for `allow`/`deny`/`exceptions` — the file itself has no workspace, since one project can run jobs against several `cwd`s.

### Command policy mode (`command_policy`)

When `command_policy` is set to `"denylist"`, any command that reaches the default evaluation stage (i.e. not matched by any explicit allow rule) is allowed (`policy: "denylist_default"`) instead of rejected. This allows unlisted commands to run without requiring individual `allow` rules. What it does **not** change: `HARD_DENY` (credential path reads, `.agents` writes), profile-level deny rules (`git push`, `curl`, `git reset --hard`, etc. — lift them with `exceptions`), ceiling `deny`, containment checks (writes outside `write_roots` or into `{workspace}/.agents/**`, reads outside `read_roots`), subagent tool refusals, and dangerous environment variable injection vectors (`PATH`, `LD_*`, `GIT_*`, etc.) continue to be strictly denied regardless of mode.

## `agy_start.permissions`

| Field | Narrows |
| --- | --- |
| `allow` | Intersected with the ceiling's allow list. |
| `deny` | Unioned — always adds, never removes. |
| `sandbox` | `"seatbelt"` \| `"agy"`. Tightening only: raises the OS boundary for this job above what the profile/ceiling set, never lowers it. `sandboxed: true` is the legacy spelling of `"agy"`. Always `agy` on `research_readonly`. |
| `read_roots` | Narrowing only: the project ceiling's entries apply by default; list entries here only to use a subset of them (non-matching entries are dropped). |

The reply carries `policy_summary` (`{ profile, allow_count, bypass_sandbox, sandbox_forced_by, add_dirs, add_dirs_source }` — `sandbox_forced_by` is `null`, `"profile"`, `"ceiling"`, or `"request"`; `add_dirs_source` is `"ceiling"`, `"request"`, or `"none"`) and `blockers[]` with `source: "policy_ceiling"` per rejected entry. Use `dry_run: true` to see this before spending a turn.

**The allow-collapse trap.** `allow` is an *intersection*, not an addition — a request the ceiling refuses wholesale collapses the entire effective allow list to empty, taking the profile's own defaults (workspace read/write, `git`, `pytest`, ...) with it. `allow_count: 0` comes with its own blocker; the fix is to retry with no `permissions.allow` at all.

## How a call is decided

`decide()` (`src/gate/gate.ts`), fixed order:

1. Not one of our jobs → `ask`, no log line — must never touch someone's own interactive `agy` session.
2. Unclassifiable tool, or a subagent tool → `deny`, no `required_rule`.
3. `manage_task` → `allow`, unconditionally.
4. Containment → `deny`: write outside `write_roots` or into `{workspace}/.agents/**` (write-protected regardless of any rule — the gate's own hook config lives there); read outside `read_roots`.
5. Deny list match → `deny`.
6. Allow list match → `allow`. For `run_command` the gate also pins `Cwd` to the workspace and sets `BypassSandbox` explicitly from `policy.bypass_sandbox` (I2) — every allow decides sandboxing itself, never leaves it to the model.
7. Nothing matched → `deny`, with `required_rule` naming what would have allowed it. A bound job's gate never falls back to `ask` here.

Tool classification (`src/policy/tools.ts`, measured M1/M2):

| Tool | Class | Subject |
| --- | --- | --- |
| `run_command` | subject | `command(CommandLine)` |
| `view_file`, `list_dir`, `find_by_name`, `grep_search` | subject | `read_file(<path>)` |
| `write_to_file`, `replace_file_content` | subject | `write_file(<path>)` |
| `manage_task` | control | always allowed |
| `define_subagent`, `invoke_subagent`, `manage_subagents`, `browser_subagent` | unsupported | denied — runs under a different `conversationId` the gate can't bind (M2) |
| everything else | unsupported | denied by name |

## What the runtime guarantees

`agy`'s own approval engine is disabled for every job (`--dangerously-skip-permissions`, every spawn since 0.2.0) — our gate is the sole authority. Safe only because three invariants hold together (`src/runner/spawn.ts`):

- **I1** — a bound job's gate never answers `ask`.
- **I2** — every `run_command` allow sets `BypassSandbox` explicitly: `true` on `general_worker` unless the ceiling (`sandbox: "agy"`) or the request (`permissions.sandbox: "agy"`) forces agy's sandbox, `false` always on `research_readonly`. `sandbox: "seatbelt"` keeps `BypassSandbox: true` and rewrites the command line through `sandbox-exec` instead. The model's own `BypassSandbox` argument is never consulted.
- **I4** — the runner watches `jobs/<id>/gate-log.jsonl`; if the first tool call completes with no line there, it kills the job (`process_error`, not `blocked` — the gate never ran at all).

The invariants guarantee the gate is consulted and answers deterministically; they do not guarantee that the gate's answer is right for shell syntax it does not model (see [Where the string match ends](#where-the-string-match-ends)).

Hook failure is deny, except for the two cases where we genuinely cannot tell whose call it is (unparsable payload, unbound conversation) — those pass through as `ask`. Our `hooks.json` key is written first in the file, ahead of any other group, and removed once no live job on that workspace needs it.

## What the gate deliberately does not see

The gate is a string classifier over each tool call, decided once before the call runs. It is designed to bound a cooperative but fallible model (wrong command, wrong directory, an unrequested `git push`), not a hostile one. A prompt injection carried by the repository can reach anything an allowed program can reach. For untrusted repositories, narrow the ceiling and use `sandbox: "seatbelt"` or `"agy"`.

### Inside an allowed command

Allowing a command allows everything that program does. The gate sees the command line only, before execution:

- `python3 script.py`, `node script.js`, `pytest`, `npm test`, `npm run <script>`, `./gradlew build`, `mvn`, `make`: the gate sees the command line only. The script, the test suite, `package.json` scripts, `conftest.py`, Gradle build scripts, git hooks in `.git/hooks`, and any subprocess they start run unsandboxed as the user, may open network connections, and may write anywhere the user can. Denying `curl` in the profile does not stop `python3 -c "import urllib.request; ..."`.
- `python3 -c`, `node -e`: allowed on `general_worker` with arbitrary code; only `bash -c` / `sh -c` strings are re-judged recursively (the inner commands must also be allowed).
- Interpreters and build tools are on the allow list precisely because a worker that cannot run tests is useless; the price is that everything behind them is opaque to the gate.
- Reads of files the OS lets the user read are only checked when the path appears literally on the command line; a program that opens `~/.aws/credentials` itself is not seen. The `HARD_DENY` credential list applies to agy's file tools and to literal path arguments, and it is a list of common locations, not an inventory of every secret on the machine.

### Sandbox off by default

On `general_worker` (since 0.2.1), every allowed `run_command` runs with `BypassSandbox: true`. The kernel is not involved; what bounds an allowed command is the allow list itself, the deny lists, and containment. In contrast, `research_readonly` keeps the OS sandbox on (`BypassSandbox: false`).

Ceiling `sandbox: "seatbelt"` restores a write-only kernel boundary via `sandbox-exec` (macOS), ensuring file writes cannot leave `write_roots` (plus temporary directories) even if an allowed interpreter or build tool attempts them. `sandbox: "agy"` uses agy's own sandbox profile, which was measured unusable for anything that writes on 1.1.24 (in-workspace builds, file creation, and `git commit` fail with `Operation not permitted`). Fine-grained sandbox profile tuning is not supported; we only control `--add-dir` and the on/off `BypassSandbox`.

`read_roots` (`--add-dir`) widen the sandbox allowlist for reading and executing outside the workspace, as well as the gate's read set.

### Trust between local parties

The intended assumption is one user per machine account:

- `verify_command` runs unsandboxed at parent trust, executed directly by the runner at the full trust level of the parent agent running the command itself.
- Any MCP client attached to the same project (same user, same machine, same project root) can observe, take over, or `agy_send` into any job by design. There is no cryptographic isolation or token authentication between local client connections to the server.
- Job directories under `~/.agy-worker` contain the prompt, the agent transcript, and the gate log in plaintext.
- The prompt is passed to agy as an argv value (`--print=<prompt>`) on oneshot runs and is visible to other local users through `ps`.

### Where the string match ends

The classifier models a subset of shell grammar (`;`, `&&`, `||`, `|`, `$( )`, backticks, quoting, `bash -c` recursion, redirections). Shell syntax it does not model must be rejected (fail closed) rather than passed.

The 0.3.0 pre-publish audit found these slipping through; 0.3.1 closes each of them, and the rule that now applies is listed beside it:

- Newline, `\r\n`, single `&` and `|&` — now chain separators; every segment is judged.
- Process substitution `<( )` / `>( )` — judged like `$( )`; the inner command must be allowed.
- Combined short flags (`bash -lc`, `-ec`, `-xc`) — recognised as `-c`; the string is re-judged. Only `bash`, `sh` and `env` act as wrappers; `zsh -c` and other shells need their own rule.
- `~` / `$HOME` / `$PWD` / backticks in a path argument or redirection target — a leading `~/` is expanded to the real home; anything else is refused as `unexpanded_path`. Globs are contained by their literal directory prefix instead of refused.
- `rm` flag sets — any combination of `-r`/`-R`/`--recursive` with `-f`/`--force`, in any order, matches the `command(rm -rf)` deny.
- `git -c` / `git -C` / `--git-dir` / `--work-tree` / `--exec-path` / `--config-env`, and `git config` writes to executable keys (`core.hooksPath`, `core.sshCommand`, `core.pager`, `core.editor`, `alias.*`, `credential.*`, `filter.*`, `url.*`, `http.*`, `remote.*.url`, …) — always denied. Reads (`git config --get`, `--list`) stay allowed.
- `find -exec` / `-execdir` / `-ok` / `-okdir` / `-delete` — denied. `xargs` is off the allow list; `xargs <cmd>` is judged as `<cmd>`, bare `xargs` is denied.
- `sed -i`, `sort -o`, `tee`, `dd of=`, `tar -C`, `unzip -d`, `git clone/archive/init/worktree`, … — classified as writers; targets go through containment.
- Paths resolved against the model-supplied `Cwd` — every path is now resolved against the pinned workspace, the directory the command actually runs in.
- Read utilities with a path outside the workspace (`cat /etc/passwd`, `node /tmp/x.js`) — refused unless a `read_root` covers it.
- Denylist-mode obfuscation (`\curl`, `$'\x63url'`) — a head token containing a backslash, `$`, a quote or a non-ASCII character is a parse error, hence a deny.

What remains, by design or as a known limit:

- Heredocs (`cat <<EOF … EOF`) are not modelled: the body is split on newlines and judged as commands, which almost always denies. Use agy's file tools to write files.
- A head token that is itself a variable (`$BIN/tool`) is refused rather than resolved.
- Everything in [Inside an allowed command](#inside-an-allowed-command): the classifier never looks past the command line.
- A project ceiling in `denylist` mode is inherently weaker than allowlist mode and exists for projects that accept that.

The general lesson stands: a new shell construct is a new hole until the parser rejects it.

### Foreign hooks

The PreToolUse hook mechanism has interaction points with external configuration outside our repository:

- A hook in a user's global `~/.gemini/config/hooks.json` that denies ahead of ours is invisible to us; the watchdog reports it as "gate never fired" (`process_error`), safe (fail closed) but imprecise about why.
- `hooks.json` files inside a `read_roots` root: measured on agy 1.1.27 (M10), agy loads them from every `--add-dir`, and a foreign deny runs ahead of our gate. `agy_start` therefore refuses a read root that carries `.agents/hooks.json` (`ValidationError`, field `read_roots`). Whether a foreign `overwrite` could merge over ours is still unmeasured, which is why the refusal is unconditional.

## `verify_command`

A command the **runner** — not agy, not the model — runs once after agy exits 0, against the final workspace tree. Outside the model's own decisions: cannot be skipped, reordered, or narrowed from inside the job. Not sandboxed and not a security boundary — it runs unsandboxed, as the user, at exactly the trust level of the parent agent running the same command itself.

- Non-zero exit or a `verify_timeout_ms` timeout → `outcome: "failed"`, never a blocker.
- Exit 0 → counts toward `outcome: "verified_success"`.
- Lands in `agy_result`'s `verification.verify`: `{ command, exit_code, signal, duration_ms, timed_out, output_tail }` — `output_tail` is the last 2 KiB; the full log is `jobs/<id>/verify.log` on disk.

## Recovering from a blocked job

Everything that stood in the way is one list: `verification.blockers[]`.

| Field | Means |
| --- | --- |
| `source` | Who refused: `policy_ceiling`, `gate`, `agy_engine`, `sandbox`, `broker`, `tool_error`. |
| `actionable` | Whether a different `agy_start` can lift it. |
| `remedy` | What to change. Present whenever *someone* can change something — a human editing the ceiling counts, so `actionable: false` can still carry a remedy. Null only when nothing would help. |
| `blocks_outcome` | Whether this is why `outcome` is `blocked`. |

A `source: "gate"` blocker with `detail.policy: "default"` means the action matched nothing in the job's effective allow list. `remedy` names the rule. Where to put it depends on the ceiling, because `permissions.allow` can only narrow:

1. `agy_capabilities` → is the rule covered by `profiles[].allow` or `ceiling.allow`? Is it on `profiles[].deny` (then it needs `ceiling.exceptions`)?
2. Covered → the job narrowed it away. Retry **without** `permissions.allow` (full ceiling), or with a list that still includes the defaults you need.
3. Not covered → a human adds it to the ceiling's `allow` (or `exceptions` for a profile-denied rule). No `agy_start` argument can do this.

```
agy_result(job_id, section: "verification")
  -> blockers[0] = { source: "gate", actionable: true,
                     remedy: "command(python -m pytest)", blocks_outcome: true }

agy_start({ ..., dry_run: true })          # no permissions.allow: full ceiling
  -> policy_summary.allow_count > 0, blockers == []
```

The other sources:

- `source: "gate"`, `detail.policy: "containment"` — the command left the workspace, or wrote into `{workspace}/.agents`. Change the command or the workspace, not the rules. Never actionable.
- `source: "gate"`, `detail.policy: "unsupported"` — a subagent tool, or a tool outside the classified set. Never actionable.
- `source: "policy_ceiling"` — the ceiling itself refused; the fix is a human editing `policy.json`, not a different `agy_start`.
- `source: "agy_engine"` — should not occur since 0.2.0 (agy's own engine is disabled for every job); report it if it does.
- `source: "sandbox"` — a known OS-sandbox signature (`Operation not permitted`, `Could not resolve host`, …) in a `run_command`'s output, on a job that actually ran sandboxed. Which lever lifts it is whatever forced the sandbox on:
  - `permissions.sandbox` / `permissions.sandboxed` — retry without it (`actionable: true`).
  - profile `research_readonly` — use `general_worker` if the task needs to write (`actionable: true`).
  - the ceiling's `sandbox: "agy"` — a human sets it to `"none"` or `"seatbelt"` (`actionable: false`, remedy says so).
  - the ceiling's `sandbox: "seatbelt"` — the message says `seatbelt`; the remedy is a `write_roots` entry for the directory (`actionable: false`), or `actionable: true` when the request asked for the seatbelt.
  - In every case, a blocked read/exec of a toolchain outside the workspace is `read_roots` in the ceiling, not the sandbox switch.

  A job that ran with `bypass_sandbox: true` never gets this blocker: there was no sandbox, so the same output is the command's own failure (a real permission error, a network that is really down). It is reported in `warnings` and does not make the job `blocked`.
