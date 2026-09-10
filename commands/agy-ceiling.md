---
description: Draft this project's agy-worker permission ceiling (policy.json) from denial history and the repo, review it with me, and write it only after I approve
argument-hint: [commands the jobs will need, e.g. "cargo build, make test, git push"]
---

Draft the agy-worker-mcp project ceiling for this repository and write it only after I approve the draft you show me.

Context I am giving you: $ARGUMENTS

Do this, in order:

1. Call `agy_ceiling` with no arguments. Note `path`, whether the file is `present`, the current `ceiling`, the `effective` allow/deny/hard_deny lists, and `history.denied_rules` (what past jobs were refused, how often).
2. Read this repository to learn what a job here actually runs: build files, test runners, `package.json` scripts, `Makefile`, `Cargo.toml`, `build.gradle*`, `pyproject.toml`, CI config. Fold in the commands I listed above, if any.
3. Write a `version: 2` draft:
   - `allow`: build/test/read commands the profile does not already allow (`agy_ceiling` marks duplicates).
   - `exceptions`: only rules the profile denies that the task genuinely needs (`git push`, `npm install`, `curl`, …). One line of rationale each. Never `HARD_DENY` rules.
   - `read_roots`: toolchains outside the workspace a job must read (`~/.gradle`, `~/.jdks`, …).
   - `write_roots`: only if a sandboxed build must write outside the workspace.
   - `sandbox`: leave `"none"` unless I asked for `"seatbelt"` or `"agy"`.
   - Never set `command_policy: "denylist"` unless I explicitly asked for it.
4. Call `agy_ceiling({ draft, expected_commands })` with the draft and the commands from steps 1–2. Fix it until `review.ok` is true and every `expected_commands` entry you expect to run is `allow`. Keep the `review.rules[].risk` classes.
5. Show me the complete file as a fenced JSON block (a diff against the current file if one exists), with one line of rationale per rule and the risk class beside every `exceptions` entry and every `network` / `install` / `destructive` / `privilege` rule.
6. Ask me, in one line, whether to write it to `path`. Do not write before I answer. If I say yes, write exactly the shown JSON to that path and re-run `agy_ceiling()` to confirm it loads with no `warnings`. If I say no or change something, revise and show it again. If I want to write it myself, give me:

```sh
cat > <path> <<'JSON'
<the approved JSON>
JSON
```

Rules that do not bend: the server has no code path that writes this file, and neither do you without my in-conversation "yes" to the exact draft shown. `exceptions` and `command_policy: "denylist"` widen what an unattended job can do to the network, remote repositories, and the filesystem — call that out when you show them.
