# Changelog

All notable changes to agy-worker-mcp. Dates are the day the version landed on
`main`. Measurements against the real `agy` CLI are noted with the agy version
they were taken on.

## 0.4.0 — 2026-09-14

The release that makes installing it and running the first job boring, and gives
a job somewhere of its own to work.

**Breaking.** Version 1 ceiling files are rejected, and the legacy
`permissions.sandboxed` request field is gone. Both have a one-command fix; see
the first two entries.

### Breaking

- **`policy.json` must be `version: 2`.** A version 1 file no longer loads, and
  no job starts against one. The refusal carries the whole conversion:
  `agy_ceiling()` returns `v1_migration` with the exact version 2 equivalent
  (same permissions, nothing widened) and the single `cat > … <<'JSON'` command
  that writes it. 0.3.3 shipped that migration helper so this could be done
  before upgrading rather than after. The server still has no code path that
  writes the ceiling.
- **`permissions.sandboxed` was removed.** Write `permissions.sandbox: "agy"`
  (or `"seatbelt"`). The `permissions` object is now strict, so the old
  spelling is rejected rather than dropped — a silently stripped
  `sandboxed: true` gave the job *less* sandboxing than the caller asked for,
  which is the one way for a permissions typo to be dangerous rather than
  merely annoying.

### Isolation

- **`agy_start({ isolation: 'worktree' })`** puts the job in its own git
  worktree at `<root>/.worktrees/agy-<job_id>`, on branch `agy/<job_id>`
  (`base_ref` to branch from something other than HEAD). Two jobs on one
  repository stop fighting over one tree, and a caller can look at a job's work
  without having already inherited it. The job still cannot commit: `git
  commit`, `git merge`, `git rebase`, `git cherry-pick`, `git revert` and `git
  stash` are denied for a worktree job, past anything a ceiling `exceptions`
  entry could lift, so the caller merges. That is the same rule as the
  `.agents` lockdown — no job promotes its own result — and it is what keeps
  the handoff legible: a commit makes `git status` report a clean tree, so a
  job that committed would look finished-and-empty to the two paths that delete
  the branch. Both of those also refuse a branch carrying commits the base
  lacks, which is what catches a human committing in the tree by hand.
- **Ceiling key `link_paths`.** A fresh worktree has no `node_modules`, so
  every test command in a JavaScript project fails on the first call. The
  server symlinks the listed project-root-relative directories in — and, because
  `canonicalize()` resolves symlinks, teaches containment and the allow list
  about the real directory behind the link. Reads through the link are allowed;
  writes are not, so one worktree job cannot corrupt what every other worktree
  and the user's own tree share. It is ceiling-only, with no request field: a
  link widens what an unattended job can read, and that is a human's call.
- **The handoff is reported, not remembered.** A `workspace` block — kind,
  path, branch, base and head commit, `committed: false`, changed-file count —
  rides along on `agy_start`'s reply, in `broker-result.json` (now version 4,
  with older files migrating as `in_place`), and in `agy_result`'s summary. A
  worktree job's headline ends by saying where its changes are and who merges
  them. `agy_wait`'s judgement packet is deliberately untouched: where the
  changes live is not a verdict.
- **`agy_release_workspace`** — the eleventh tool. Removes a finished job's
  worktree and deletes its branch once you have merged it. Refuses a live job,
  an `in_place` job, a dirty worktree, and a branch with unmerged commits
  without `force` — including the case where git will not report a status at
  all, which counts as dirty.
  `on_finish: 'remove'` does the same automatically for a job you already know
  you will not want the tree from; `keep` stays the default, because deleting an
  unmerged worktree destroys the job's whole output.
  `agy_capabilities.worktrees` lists whatever is still on disk, read from git's
  own worktree list so one whose job directory was cleaned up still shows up.
- Measured on the first live worktree run (agy 1.1.27, 2026-09-11): the link is
  created **relative**, not absolute, and the symlink the server made no longer
  counts as one of the job's changed files. A repository whose `.gitignore`
  says `node_modules/` — trailing slash, which matches a directory and not a
  symlink to one — reported it as untracked work, which would have meant
  `on_finish: "remove"` never fired and `agy_release_workspace` demanded
  `force` for a job that changed nothing. The same run also showed agy
  addressing the base repository after reading a resolved path through the
  link; the gate refuses that, and `docs/permissions.md` says so rather than
  the boundary being widened to hide it.
- **`command(git worktree)` is denied** for `general_worker`. A job that can add
  or remove worktrees can move its own workspace out from under the gate.
- **A linked worktree resolves to its main repository.** `.git` as a *file*
  used to make each worktree its own project — its own ceiling, its own lock
  domain, its own database. `agy_capabilities` reports
  `project_root_source: "git-worktree"` and the path it moved from. Submodules
  stay their own project, which is what they are.

### Install and first run

- **A stable launcher at `~/.agy-worker/bin/agy-worker-mcp`.** A GUI-launched
  client does not run your shell profile; it gets launchd's `PATH`, where a
  version-manager Node does not exist. Registering `agy-worker-mcp` as a bare
  command therefore worked in a terminal and failed silently in the app. The
  launcher is plain `sh` with no `PATH` dependency: it records the Node and
  server paths from install time, checks them, and falls back to the newest
  version each common version manager has on disk.
- **`agy-worker-setup` grew up** — `--client claude|codex|all`, user scope by
  default, `--link` to symlink instead of copy so upgrades are picked up, and
  `--doctor`, which checks the launcher, the Node it resolves, whether `agy` is
  reachable and from where, and what each client's config actually points at.
  It still never writes a client config file.
- **The gate hook records `process.execPath`**, not `node`. The hook file is
  written by this server and read by an `agy` the client spawned; the two do not
  share a `PATH`.
- **`.agents/hooks.json` and `.worktrees/` are added to `.git/info/exclude`**
  on the first job, so the tree we write into does not dirty the user's
  `git status` and does not touch their `.gitignore`. `changed_files` filters
  both out too — a job that changed nothing used to report our own housekeeping
  as its work.
- **A degenerate project root is reported, not run.** `/`, the home directory,
  or a root resolved from `cwd` with no git anywhere now come back as
  `agy_capabilities.warnings` naming `AGY_WORKER_PROJECT`.
- **`agy_capabilities` survives a missing `agy`.** Reporting that the binary is
  not installed is one of the things that call exists for; it used to fail
  outright instead, hiding profiles and limits at the moment they were most
  needed.

### Gate

- **Heredocs are parsed, not split.** `cat <<'EOF' > file` used to have its body
  chopped into lines and judged as commands, so a body containing the word
  `curl` was a denial and a perfectly ordinary file write was impossible. The
  body is data now. The redirect target still gets full containment: writing to
  `.agents/hooks.json`, outside the workspace, or through `..` is refused
  exactly as before, and an unterminated heredoc is still an error.
- **Allow-list gaps closed** — `pwd`, `tee`, `pytest`, and `node <script>` /
  `python3 <script>` for a script path inside the workspace. `npx` stays out;
  it is an install and network path, and belongs in a project's own ceiling.
- **Interpreter preload flags are refused** — `node --require=/tmp/x`,
  `python3 -X importtime /tmp/x` and their kin, which slipped past the script
  path check.
- **The workspace is never guessed.** The interpreter rules used to fall back to
  `process.cwd()` when no workspace was passed — a security boundary from a
  default. It fails closed now, and every call site passes the real workspace.
- **A refusal is recognised whatever case agy writes it in.** agy 1.2.1
  carries its "tool call denied by pre-tool hook:" sentence in both a
  lower-case and a capitalised form; the match was case-sensitive against the
  lower-case one. The denial itself was never at risk — the machine payload is
  parsed out of the same string either way — but the capitalised form would
  have been attributed to agy's own engine rather than to our gate, which is
  the one attribution callers are told to report as a regression.
  The same fix covers `agy_engine` refusals, which 1.2.1 also capitalises: a
  missed one is filed as "failed for a reason we do not recognise", and that
  event is how a regression in `--dangerously-skip-permissions` would announce
  itself.
- **The `PreToolUse` contract was re-checked against agy 1.2.1** (docs/permissions.md,
  "Which agy version this was measured against"). Every field the gate depends
  on is unchanged. The hook's *failure* semantics — that empty or non-JSON
  output is a denial — remain measured on 1.1.23 only; a live run on a new agy
  minor version is what clears them, and the gate watchdog is the backstop
  until then.

### Concurrency and reporting

- **Ceiling key `max_running_jobs`**, default 3, hard cap 12. A number above
  the cap fails the file closed rather than being clamped: a ceiling that says
  forty while the server runs twelve only ever surfaces as an unexplained lock
  conflict. `LOCK_CONFLICT`'s remedy now names the key and the file, and
  `agy_capabilities.limits_source` says whether the effective number came from
  the ceiling or the default.
- **A stream interruption is classified.** agy sometimes reports
  `status: ERROR` with "The stream was interrupted" after a complete response.
  The outcome stays `failed` — agy's self-report is never the basis for a
  verdict — but the warning now says it is the retryable kind, so a caller can
  decide instead of guessing.

### Usage log and reports

- **`usage.jsonl`** — every finished job appends one ~600-byte line to
  `~/.agy-worker/projects/<key>/usage.jsonl`. Everything this package knew
  about its own use was seven days old, because the job directory
  `cleanupOldJobs` deletes is where the denial history, the timings and the
  token counts lived — and `agy_ceiling`'s recommendations are only as good as
  the history still on disk. A line carries the shape of a job, never its
  content: profile, model, effort, isolation, sandbox, outcome,
  `contract_status` beside `agent_status`, durations, the broker's counts,
  tokens, denied rules, blockers, and the agy, package, Node and platform
  versions. No prompt, no response, no file path, no command line. The two
  fields built out of the run rather than a fixed vocabulary — a denial's
  `required_rule`, which agy spells as the whole command line, and a blocker's
  `remedy`, which can name a path — are scrubbed for secrets and clipped
  before they are written, so a token typed into a denied `curl` does not end
  up in a file that outlives everything. Lines stay under 4 KiB so concurrent
  appends from several server processes cannot interleave; the file rotates
  once at 5 MiB. Nothing leaves the machine, and `AGY_WORKER_USAGE=off` turns
  it off.
- **The agy version is recorded per job.** `agy --version` is probed once per
  server process and stamped onto every `effective-config.json`. Until now
  `--doctor` was the only thing that ever asked, so no regression could be
  tied to the build that caused it.
- **`agy-worker-setup --report`** writes one self-contained HTML file and
  prints its path. No CDN, no font, no external request of any kind: it opens
  on a machine with no network, and no log content can leave over one.
  Project mode (`--last N`, `--since 7d`) reads `usage.jsonl` — outcome mix,
  tokens, median and p90 duration, model × outcome, jobs per day, failures,
  and the denied-rule table in the same vocabulary `agy_ceiling` reads.
  `--job <id>` is the bug-report bundle in place of a tarball: the verdict
  with `contract_status` shown against `agent_status`, blockers split by
  whether a different `agy_start` could lift them, the whole gate log
  including the allows — a gate parser bug shows up more often in what was let
  through than in what was stopped — the timeline, the changed files and the
  raw logs. Prompts and response text are excluded unless `--include-prompt`;
  paths are rewritten, recognisable secrets masked, and `--redact strict` goes
  further. Every report opens by stating what it contains, because asking a
  person to read that before attaching the file is a better safeguard than the
  pattern list behind it.

### Release

- **CI stages; a human publishes.** The release workflow runs
  `npm stage publish --provenance` and stops. Nothing reaches the registry until
  someone approves it with interactive 2FA. OIDC trusted publishing removed the
  long-lived token but made the workflow file itself a publishing credential,
  and this package spawns agents on a user's machine with
  `--dangerously-skip-permissions` — that is worth one approval per release.

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
