# Changelog

All notable changes to agy-worker-mcp. Dates are the day the version landed on
`main`. Measurements against the real `agy` CLI are noted with the agy version
they were taken on.

## 0.3.3 — 2026-09-10

A deprecation notice with its own remedy. No behaviour changes.

- **Version 1 ceiling files now announce their removal, and hand you the
  replacement.** `agy_ceiling()` returns a `v1_migration` block when the
  project's `policy.json` is still `version: 1`: the exact version 2 equivalent
  (same permissions, nothing widened) and the single `cat > … <<'JSON'` command
  that writes it. 0.4.0 rejects version 1 outright — a job will not start
  against one — so the conversion has to be possible before that release, not
  after it.
- The `agy_capabilities.ceiling.warnings` text for a version 1 file says
  "rejected in 0.4.0" instead of "removed in 0.4", and points at `agy_ceiling()`.
- `skills/agy-ceiling` handles `v1_migration` as its first step. The approval
  rule is unchanged: this server has no code path that writes `policy.json`.

## 0.3.2 — 2026-09-10

Documentation only. No code changes.

- **README renders on npm** — GitHub alert syntax (`> [!WARNING]`, `> [!NOTE]`)
  is not supported by npm's markdown renderer and showed up literally on the
  package page. Both blocks are plain blockquotes with a bold label now, and the
  development-status block reads "Important" rather than "Warning".
- **Links work off GitHub** — every relative link in the README (`docs/`,
  `CHANGELOG.md`, `test/fake-agy`) is an absolute GitHub URL, since npm does not
  resolve relative links against the repository.

## 0.3.1 — 2026-09-09

Pre-publish audit. The gate is a string classifier; this release makes it
reject what it does not model instead of passing it, and says so in the docs.

- **Chain and wrapper parsing** — newline, `\r\n`, single `&` and `|&` split
  segments; `<( )` / `>( )` are judged like `$( )`; `bash -lc`-style clusters
  count as `-c`; only `bash`, `sh`, `env` act as wrappers (`zsh -c` needs its own
  rule); a head token carrying `\`, `$`, quotes or non-ASCII is a parse error.
- **`rm`, `git`, `find`, `xargs`** — `rm` denies on any `-r`/`-R` + `-f`
  combination; `git -c` / `-C` / `--git-dir` / `--work-tree` / `--exec-path` /
  `--config-env` and `git config` writes to executable keys are always denied;
  `find -exec` / `-execdir` / `-ok` / `-delete` are denied; `xargs` left the
  `general_worker` allow list and `xargs <cmd>` is judged as `<cmd>`.
- **Containment** — every path is resolved against the pinned workspace, never
  the model's `Cwd`; a leading `~/` expands to the real home, any other `~`,
  `$VAR` or backtick in a path is refused (`unexpanded_path`); globs are
  contained by their literal directory prefix; `sed -i`, `sort -o`, `tee`,
  `dd of=`, `tar -C`, `unzip -d`, `git clone/archive/init/worktree`, … count
  as writers; read utilities and script paths (`cat`, `grep`, `node x.js`, …)
  must stay inside the workspace or `read_roots` (`read_outside_workspace`).
- **Credential `HARD_DENY` for commands** — `~/.ssh`, `~/.aws`, `~/.gnupg`,
  `~/.netrc`, `~/.npmrc`, `~/.git-credentials`, `~/.config/gh`,
  `~/.config/gcloud`, `~/.docker/config.json`, `~/.kube`, `~/.gemini`,
  `~/.antigravity`, `~/.agy-worker` are refused as command arguments and
  redirection targets, not only through file tools; the file-tool list gained
  the same entries; the home directory is canonicalised before matching.
- **Self-protection** — `agy_start` refuses a workspace that contains the state
  home or the gate binary, and a ceiling `write_roots` entry of `/`, the home
  directory or the state home.
- **Hygiene** — job output files `0600`, job and project directories `0700`,
  `index.db` and its WAL/SHM `0600`.
- **Docs** — README carries an unofficial/trademark notice and a
  "Trademarks and terms" section on how the official `agy` binary is used;
  `docs/permissions.md` gains "What the gate deliberately does not see"
  (threat model, what allowed programs can do, sandbox default, local trust,
  where the string match ends).

## 0.3.0 — 2026-09-09

Two walls, kept apart: the profile (code) and the project ceiling (a human).

- **Ceiling file version 2** — `allow` / `deny` / `exceptions` / `read_roots` /
  `write_roots` / `sandbox` / `command_policy`. A version 1 file
  (`extra_allow`, `extra_deny`, `additional_dirs`, `sandboxed`) is still read,
  converted, and warned about; it stops loading in 0.4.
- **`HARD_DENY` narrowed** to what protects the gate itself (credential reads,
  writes into `{workspace}/.agents`). Everything else `general_worker` denies —
  `git push`, `curl`, `wget`, `ssh`, `scp`, `sudo`, `docker`, `rm -rf`,
  `git reset --hard`, `npm install`, `pip install`, … — can be lifted by a
  project through `exceptions`. By a human editing the file, never by a request.
- **`sandbox: "seatbelt"`** — our own write-only `sandbox-exec` profile (macOS):
  an allowed command runs with writes confined to the workspace and the
  ceiling's `write_roots`, even through interpreters, and still does the work.
  `"agy"` keeps agy's own sandbox; `"none"` stays the default. Strictest of
  profile / ceiling / request wins; the request's `sandbox` replaces the old
  boolean `sandboxed` (still accepted, means `"agy"`).
- **`agy_ceiling`** — a tenth tool. Read-only: the ceiling file as loaded, the
  effective policy, the project's denial history, a review of a draft (risk
  class per rule, `HARD_DENY` conflicts, duplicates of the profile) and how
  `expected_commands` would be judged. It has no write path.
- **`agy-ceiling` skill and `/agy-ceiling` slash command** (Claude Code),
  shipped in the package under `skills/` and `commands/`; both stop for the
  user's approval before the file is written. `agy-worker-setup` copies them
  into `./.claude` or `~/.claude`.
- **No-ceiling hint** — when a project has no ceiling file, `agy_capabilities`,
  `agy_start` and a blocked job's `verification.warnings` say so once, name
  the file, and point at the three ways to propose one.
- **`agy_logs({ stream: "digest" })`** — what a job actually ran and touched:
  commands with allow/deny, files written, denials, in order.
- **Denial policy** — `max_denials` aborts after N gate denials regardless of
  `on_denial`; an `unsupported` tool call no longer aborts a job on its own
  (subagent tools still do); `schedule` is a control tool; the environment-block
  detector reads only the last five lines of a tool's output, so a `git diff`
  that quotes an error message is no longer a "sandbox block".
- **Read roots that carry their own `.agents/hooks.json` are refused** at
  `agy_start` — agy loads hooks from every `--add-dir`, and a foreign deny runs
  ahead of our gate (measured, agy 1.1.27).
- Release workflow (`.github/workflows/release.yml`): tag `v*.*.*` matching
  `package.json`, or manual dispatch with `dry_run` (default true).

## 0.2.2 — 2026-09-08

From a usage audit of 35 real jobs.

- The broker no longer misjudges a job as `process_error` while its
  `verify_command` is still running; `duration_ms` is the runner's real end.
- The gate parses `ENV=… cmd`, `env`, `export`, `&&` / `|` / `;` chains and
  `bash -c` instead of denying them wholesale.
- The ceiling's read roots apply to every job by default; a request names
  them only to pick a subset.
- `general_worker` allows the ordinary POSIX utilities and inline
  interpreters, with `git` under a denylist; containment still bounds `rm`,
  `mv`, `cp`, `touch`, `mkdir` to the workspace.
- A ceiling can opt into `command_policy: "denylist"`.
- `agy_start` warns up front when a job has nothing checkable, judges
  `expected_commands` on a `dry_run`, and checks `model` / `effort` against
  what agy 1.1.27 accepts.
- `agy_wait` on a running job shows the tail of the log, not its head.

## 0.2.1 — 2026-09-03

- Allowed commands on `general_worker` run **without** agy's OS sandbox.
  Measured on agy 1.1.24, that sandbox refuses every write a shell command
  makes inside the workspace — `npm test`, `./gradlew build`, `git commit` all
  fail with `Operation not permitted` after the gate said yes. The gate's
  allow list is the boundary, as in Claude Code; `research_readonly` stays
  sandboxed; a ceiling can force the sandbox back on.
- The `unsandboxed` ceiling key was removed (a file carrying it fails closed
  with a migration message).

## 0.2.0 — 2026-09-02

- Permission enforcement rebuilt around a single `PreToolUse` gate that is the
  sole approval authority for every job; agy's own approval engine is disabled
  (`--dangerously-skip-permissions`). A bound job's gate never answers "ask".
- Human-owned per-project ceiling file, `~/.agy-worker/projects/<hash>/policy.json`,
  outside the workspace.
- `verify_command`: a command the runner runs once after agy exits, against
  the final tree; the job cannot skip or narrow it.
- The `network` permission field was dropped.
- Subagent tools are always denied; the runner kills a job whose gate never
  confirmed itself.

## 0.1.1 — 2026-09-02

- Build commands (`./gradlew`, `mvn`, `npm test`, `npm run`, `javac`, `java`)
  added to the `general_worker` ceiling so they stop bouncing.

## 0.1.0 — 2026-09-01

- MVP: detached `agy` jobs with state in a project-local SQLite database,
  `agy_start` / `agy_wait` / `agy_result` / `agy_logs` / `agy_send` /
  `agy_cancel` / `agy_list_jobs` / `agy_sessions` / `agy_capabilities`, and a
  broker-computed `outcome` kept separate from agy's self-report.
