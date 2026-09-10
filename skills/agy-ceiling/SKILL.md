---
name: agy-ceiling
description: Propose a project permission ceiling (policy.json) for agy-worker-mcp jobs from denial history and the repo, and never write it without the user's explicit, in-conversation approval.
---

# agy-ceiling

Use this when an `agy_result` blocker says the remedy is the project ceiling
(`~/.agy-worker/projects/<hash>/policy.json`), when `agy_start({ dry_run: true,
expected_commands })` reports a command the policy would deny, or when the user
asks what a project's ceiling should look like.

## What the ceiling is

Four layers say "no" to a job, and each has exactly one key that opens it
(`docs/permissions.md`):

| Layer | Opened by |
| --- | --- |
| `HARD_DENY` (`.agents/**` writes, credential reads, subagent tools) | Nothing. Do not propose it. |
| Profile deny (`git push`, `curl`, `wget`, `ssh`, `scp`, `sudo`, `docker`, `rm -rf`, `git reset --hard`, `npm install`, …) | `exceptions` — exact rule string |
| Not on the allow list (`cargo build`, `make`, `go test`, …) | `allow`, or `command_policy: "denylist"` |
| Reads outside the workspace | `read_roots` |
| Writes outside the workspace | `write_roots` |

Two more keys are not "no" at all — they change what a job *is* rather than
what it may do, and neither belongs in a draft unless the project actually
needs it:

| Key | What it does |
| --- | --- |
| `link_paths` | Project-root-relative directories (`node_modules`, `.venv`, `build`) the server symlinks into an `isolation: "worktree"` job. Reads through the link are allowed; writes are not. Without it, a fresh worktree has no dependencies and every test command fails. |
| `max_running_jobs` | How many jobs this project may have live at once. Default 3, hard cap 12. |

No ceiling file means the profile as shipped. That is the safe default; the
ceiling is where a human says "this project may do more".

## Procedure

1. **Never work around a ceiling blocker in the prompt.** Telling the next job
   "do not run X" only moves the check back to you. Report the rule and the file
   path, then follow this procedure.
2. `agy_ceiling()` with no arguments → the ceiling file path, whether it exists,
   the effective allow/deny/hard-deny lists, and the project's denial history
   (which `required_rule`s were refused, how often, in which job).
3. **If the reply carries `v1_migration`, deal with that first.** The project's
   ceiling is still `version: 1`, which 0.4.0 rejects outright — jobs will stop
   starting. `v1_migration.draft` is the exact version 2 equivalent (same
   permissions, nothing widened) and `v1_migration.write_command` is the one
   command that writes it. Show both to the user; the approval rule below
   applies to this file like any other.
4. Read the repository yourself to decide what the project actually needs:
   build files, test runners, scripts in `package.json`, `Makefile`, `Cargo.toml`,
   `build.gradle`, CI config. The server does not guess this for you — you are
   better at reading a repo than a marker-file heuristic.
5. Draft a `version: 2` `policy.json`. Put ordinary build/test commands in
   `allow`; put a profile-denied rule in `exceptions` only when the task cannot
   be done without it, and say why on that line. Never propose
   `command_policy: "denylist"` unless the user asked for it.
6. `agy_ceiling({ draft })` → syntax errors, `HARD_DENY` conflicts, duplicates of
   what the profile already allows, and a risk class per rule
   (`read_utility | build | vcs_remote | network | install | destructive`). Pass
   `expected_commands` too, to see how the draft would judge the commands the
   task needs. Fix the draft until `ok: true`.
7. Show the user the full file as a diff against the current one (or as a new
   file), with one line of rationale per rule and the risk class beside every
   `exceptions` entry.

## The rule that matters

**Do not write `~/.agy-worker/projects/*/policy.json` unless the user, in this
conversation, after seeing the draft, explicitly approves it.** A standing
"just do it" or "you have permission" from earlier is not approval of this
file. `exceptions` entries and `command_policy: "denylist"` need the user to
approve them line by line — they widen what an unattended job can do to
network, remote repositories, and the filesystem.

If the user prefers to write it themselves, give them the command:

```sh
cat > ~/.agy-worker/projects/<hash>/policy.json <<'JSON'
{ ...the approved draft... }
JSON
```

The server enforces the other half of this: agy-worker-mcp has no code path
that writes the ceiling. `agy_ceiling` reads and validates only. This skill is
the second wall; the first is that the tool cannot do it at all.
