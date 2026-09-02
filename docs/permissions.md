# Permissions and sessions

## How a decision is made

`agy_start` writes a `.agents/hooks.json` into the workspace registering
`dist/gate.js` as a `PreToolUse` hook, so every tool call `agy` wants to make
is handed to our gate first. The gate binds itself to the conversation of the
job that spawned it — a hook invocation from any other conversation (the
user's own interactive `agy`, for instance) gets exactly `{"decision":"ask"}`
and is never judged by this server's policy.

Order of evaluation:

1. **Containment** — before any rule matching. Redirection targets are
   extracted from the command line and checked against the workspace write
   root. This exists because rule matching is a token-prefix comparison and
   structurally cannot see a redirect appended to the end of a shell line:
   `cat secret > /tmp/evil` passes a `command(cat)` allow rule otherwise.
   Only redirection is parsed — that is the one piece of shell syntax small
   enough to parse reliably. `2>&1`, `> /dev/null`, and redirects that stay
   inside the workspace all pass.
2. **`deny`** — profile deny ∪ hard deny ∪ the client's requested deny.
3. **`allow`** — the profile ceiling intersected with the client's request.
4. **`default_decision`** — `deny` on `research_readonly`, `ask` on
   `general_worker` (which delegates to `agy`'s own engine).

A gate that crashes or prints non-JSON must not become an accidental `allow`,
so the hook command is wrapped to print `{"decision":"ask"}` on failure, and
the gate's stdout is write-once.

## Direction of merge

Clients narrow; they never widen.

- `allow` — **intersected** with the profile ceiling. Anything the ceiling
  refuses comes back in the job's `rejected_allow` rather than failing
  silently. Check it (a `dry_run` is enough) before assuming a retry will work.
- `deny` — **unioned**. Deny always wins.
- `network` — a request for `allow` only takes effect on a profile whose
  `networkOptIn` is true. Network is denied by default everywhere.

## Profiles

### `research_readonly` (default)

Read-only investigation. `default_decision: deny`.

- allow: reading inside the workspace, `git status|log|diff`, `rg`, `ls`,
  `cat`, `wc`
- deny: all writes, `python`, `node`, `pip`, `fetch`
- network: denied, no opt-in
- interpreters: refused outright — a broad `command(python)` grant is
  arbitrary code execution, so this profile will not issue one at all

### `general_worker`

Read/write work inside the workspace. `default_decision: ask`.

- allow: reading and writing inside the workspace,
  `git status|log|diff|add|commit`, `python -m pytest`
- deny: `git push`, `pip install`, `rm`, `sudo`
- network: denied, but a client may opt in

> ⚠ **`general_worker` is not a trust boundary.** Its `default_decision` is
> `ask`, which delegates to `agy`'s built-in engine, and that engine
> auto-approves under `proceed-in-sandbox` — so any shell command not on a deny
> list runs. `agy`'s own `--sandbox` does **not** confine writes outside the
> workspace (measured). Shell redirection out of the workspace *is* blocked by
> the containment step, but a write through an allowed interpreter
> (`python3 -c "open('/tmp/x','w')"`) is not. Run untrusted prompts under
> `research_readonly`.

## Hard denies

Applied last, on top of everything, so neither a permissive profile nor a
crafted request can shadow them:

```
command(rm -rf)   command(git push)   command(sudo)   command(curl)
read_file(~/.ssh/**)   read_file(~/.aws/**)   read_file(~/.gnupg/**)   read_file(~/.netrc)
```

## Recovering from a blocked job

```
agy_result(job_id, section: "verification")
  -> permission_denials[0].required_rule == "command(python -m pytest)"

agy_start({ ..., permissions: { allow: ["command(python -m pytest)"] }, dry_run: true })
  -> check rejected_allow is empty

agy_start({ ... })   # for real this time
```

If the denial's `policy` field says `containment`, no `allow` rule will fix it:
the command was trying to leave the workspace. Change the command, or the
workspace.

For an `environment_blocks[]` entry instead, the signature names a silent
sandbox failure — usually a denied DNS lookup. Retry on a profile that permits
`permissions.network: "allow"`.

## Sessions

A **session** is one `agy` conversation. A **job** is one turn of it.

- A `oneshot` job runs one turn and closes stdin.
- A `session` job keeps stdin open, so `agy_send` can queue further turns.
- Either way, `agy_start({ session_id })` resumes the conversation later —
  resume through `--conversation` is measured lossless, so a finished session
  is a perfectly good way to continue work tomorrow.

Two locks keep this honest: a `session` lock (one live job per conversation)
and a `cwd_write` lock (one writing job per workspace). Losing either is a
`LOCK_CONFLICT` error naming the holder, never a silent queue.

`agy_send` deliberately does **not** extend `deadline_at`. If it did, a session
nobody is watching could hold both locks forever, and reconcile only runs on
tool entry — nothing would reclaim it.

An idle `session` job closes its own stdin after `idle_timeout_ms` with no
follow-up, ending the process cleanly at EOF. That looks like an ordinary exit
0, so the result carries a `verification.warnings` entry saying the session was
closed by idle timeout and can be resumed with `agy_start({ session_id })`.
