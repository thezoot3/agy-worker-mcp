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
the gate's stdout is write-once. Note what that fallback means once `agy`'s own
engine is in the picture — see "The hook wrapper is fail-open" below.

## Direction of merge

Clients narrow; they never widen.

- `allow` — **intersected** with the profile ceiling. Anything the ceiling
  refuses comes back as a `source: "policy_ceiling"` blocker on the `agy_start`
  reply (and in the job's `rejected_allow`) rather than failing silently. Read
  `policy_summary.allow_count` before assuming a retry will work — a `dry_run`
  is enough.
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
  `git status|log|diff|add|commit`, `python -m pytest`, and the common build
  commands — `./gradlew`, `gradle`, `mvn`, `npm test`, `npm run`, `javac`,
  `java`
- deny: `git push`, `pip install`, `npm install`, `rm`, `sudo`
- network: denied, but a client may opt in

The build commands are in the ceiling for `permissions.allow` intersection, not
for the gate: `default_decision: ask` means they already ran. What they change
is that asking for them by name no longer bounces — and a bounced request is
worse than it sounds, see the collapse below.

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

## Security model, end to end

Read this before deciding what a profile is worth.

### Two permission systems are stacked, and we own only one

1. **Our policy**, enforced by the `PreToolUse` gate described above. Profiles,
   containment, hard denies — everything in this document up to here.
2. **`agy`'s own permission engine and sandbox.** Undocumented, not
   configurable by us, and not switchable off. Its `permission_mode` is
   `proceed-in-sandbox` on every run we measured.

The second one is why `ask` is not a question. `ask` hands the decision to
`agy`, and under `proceed-in-sandbox` `agy` approves it. In seven consecutive
real jobs the gate emitted `decision: ask` for every single tool call and every
single one ran. It also refuses things we never see: a measured refusal read

```
permission check failed for unsandboxed "ls -la ~/.jdks/": user denied
permission to run command:
ls -la ~/.jdks/
```

That is `agy` refusing, not us. No `permissions.allow` entry affects it, which
is why the broker reports it as `source: "agy_engine"`, `actionable: false`.

### What we actually control

Three things, and nothing else:

- **argv** — which flags `agy` is started with. `--sandbox`, `--add-dir`,
  `--conversation`, and the refusal to ever pass
  `--dangerously-skip-permissions`.
- **the `PreToolUse` hook** — our gate, for the tool calls `agy` chooses to
  route through it.
- **the process boundary** — a detached process group we can kill, a workspace
  we canonicalize, and a fixed, small environment allowlist for the child.

Everything else — what the model decides to attempt, what `agy`'s own engine
permits, what the sandbox refuses — is outside this package.

### The gate only classifies `run_command`

`subjectFromToolCall` derives a rule subject from `run_command`'s `CommandLine`
and returns null for every other tool, because no other tool's argument shape
is measured. A null subject cannot match any rule, so **file tools are never
matched against `read_file(...)` / `write_file(...)` rules**; they fall through
to `default_decision`. On `research_readonly` that is `deny`, which holds. On
`general_worker` it is `ask`, which `agy` approves.

Consequence: `write_file({workspace}/**)` in the `general_worker` ceiling
describes an intent, not an enforced boundary.

### The hook wrapper is fail-open

The command written into `.agents/hooks.json` is:

```
node '<abs>/dist/gate.js' || printf '{"decision":"ask"}'
```

If the gate cannot start at all, the hook emits `ask` — and `ask` is
auto-approved under `proceed-in-sandbox`. **The net effect is fail-open.** The
alternative is worse and was measured: empty stdout from a `sh -c` that failed
is read by `agy` as an unconditional *deny* for every tool call in that
workspace, including the user's own unrelated interactive `agy` sessions. We
chose the failure mode that cannot brick someone's editor, and this is what it
costs.

### `agy`'s sandbox, measured

| Probe | Result |
| --- | --- |
| Read/write `~/.gradle` | passed — not blocked |
| `ls ~/.jdks` | refused by `agy`'s own engine (message above) |
| Loopback TCP `connect` | `EPERM` — so no Gradle daemon; `--no-daemon` behaves the same |
| Write a file outside the workspace | **not blocked** |
| Running with `--sandbox` vs. without | identical behaviour; `permission_mode` stayed `proceed-in-sandbox` either way |

So the sandbox is path-selective in ways we cannot predict, blocks local
sockets, and does not confine writes. Passing `--sandbox` changed nothing we
could observe — we keep passing it because removing a safety flag on the
strength of one negative measurement is not an improvement, but do not count on
it.

`agy --help` on `--add-dir` reads, verbatim:

```
--add-dir  Add a directory to the workspace (repeatable) (default [])
```

That flag is what makes `agy` load the workspace `.agents/hooks.json` at all —
without it our gate never runs.

### Conclusion

**`research_readonly` is the only profile that blocks anything for real.** Its
`default_decision` is `deny`, so the fall-through case — every tool we cannot
classify, every command not on its allow list — is refused by us before `agy`'s
engine is ever consulted.

`general_worker` is a **guardrail against accident, not an adversary**. Its
hard denies stop the specific commands they name (including through one layer
of `sh -c` or `env`), and containment stops a redirect out of the workspace.
Everything else runs. Run untrusted prompts under `research_readonly`, in a
workspace you would not mind losing.

## Recovering from a blocked job

Everything that stood in the way is one list: `verification.blockers[]`. Each
entry answers the two questions that decide your next call.

| Field | Means |
| --- | --- |
| `source` | Who refused: `policy_ceiling`, `gate`, `agy_engine`, `sandbox`, `broker`, `tool_error`. |
| `actionable` | Whether a different `agy_start` can lift it. |
| `remedy` | What to change. Null exactly when `actionable` is false. |
| `blocks_outcome` | Whether this is why `outcome` is `blocked`. |
| `detail` | The original record — `required_rule`, `signature`, `policy` stage, `step_idx`. |

```
agy_result(job_id, section: "verification")
  -> blockers[0] = { source: "gate", actionable: true,
                     remedy: "command(python -m pytest)", blocks_outcome: true }

agy_start({ ..., permissions: { allow: ["command(python -m pytest)"] }, dry_run: true })
  -> policy_summary.allow_count > 0, blockers == []

agy_start({ ... })   # for real this time
```

`actionable: false` is the answer to "should I retry with a wider `allow`?" —
no. Three ways it happens:

- `source: "gate"` with `detail.policy == "containment"` — the command tried to
  leave the workspace. Containment runs before rule matching, so no rule grants
  it. Change the command, or the workspace.
- `source: "agy_engine"` — agy's own permission engine refused
  (`user denied permission to run command`, `permission check failed for
  unsandboxed`). It never reached our gate; our policy has no say in it. This
  one also does **not** force `blocked`: a non-gate error step is
  indistinguishable from an ordinary failing command, so we report it without
  claiming it.
- `source: "sandbox"` with a non-network signature — agy's sandbox refused, and
  we cannot configure agy's sandbox. A network signature *is* actionable:
  `permissions.network: "allow"` on a profile that permits opting in.

### Check the ceiling before you spend a turn

`agy_start` answers in the same vocabulary before anything runs — on the real
call as well as `dry_run`:

```json
{ "policy_summary": { "profile": "general_worker", "allow_count": 0, ... },
  "blockers": [ { "source": "policy_ceiling", "actionable": true, ... } ],
  "warnings": [ "..." ] }
```

**`allow_count: 0` is the trap.** `allow` is the *intersection* of your request
with the ceiling, so a request the ceiling refuses wholesale leaves the
effective allow list empty — and takes the profile's own defaults (workspace
read/write, `git`, `pytest`, the build commands) with it. Measured: a client
asked for three build commands, all three landed in `rejected_allow`, and the
job ran with nothing explicitly allowed. The fix is to start again with no
`permissions.allow` at all, which restores the full ceiling.

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
