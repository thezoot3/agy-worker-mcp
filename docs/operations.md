# Operations

## Where state lives

Nothing is written inside your repository. Per-project state lives under the
state home, keyed by a hash of the canonical project root:

```
~/.agy-worker/projects/<sha256(canonical_root)[:16]>/
    project.json  index.db  policy.json
    jobs/<job-id>/ request.json  effective-config.json  state.json
                   events.ndjson stderr.log exit_code
                   inbox.jsonl   policy.json  gate-log.jsonl
                   verify.log    verify.json
                   agent-result.json  broker-result.json  verification.json
```

`index.db` is SQLite: jobs, sessions, and locks. It is what makes a job
visible to a second client that did not start it.

`policy.json` at the project level (not to be confused with the per-job
`jobs/<id>/policy.json`, the *resolved* policy) is the human-owned permission
ceiling — one file per project, outside every workspace. See
[`permissions.md`](./permissions.md#the-project-ceiling-file) for its schema;
missing is treated as an empty ceiling, invalid fails `agy_start` closed.

`jobs/<id>/verify.log` and `verify.json` exist only when the job configured a
`verify_command` (and the job's own deadline did not kill agy first).
`verify.log` is the runner-captured stdout+stderr of that command, capped at 1
MiB; `verify.json` is `{ command, exit_code, signal, started_at, duration_ms,
timed_out }`, read back into `agy_result`'s `verification.verify`.
`state.json.verify_done` flips true once `verify.json` has been written;
`state.json.phase` is `verifying` for the whole time the command runs.

`broker-result.json` carries its own shape version, separate from the SQLite
schema version (currently 3). Job directories outlive a server upgrade, so a
result written by an older version is migrated in memory when it is read
(1's split `permission_denials` / `environment_blocks` lists become
`blockers[]`; 2's missing `verification.verify` reads back `null`), and a
version this server does not know is refused with a `VALIDATION` error rather
than half-read.

The one exception to "nothing is written inside your repository" is
`.agents/hooks.json`, written into the workspace so `agy` loads our
permission gate. It merges into an existing file rather than clobbering
unrelated keys, our own key is written first so no other hook group in that
file can short-circuit ours ahead of it, and it holds absolute paths — do not
commit it. It is removed (our key only; other keys survive) once no live job
on that workspace needs it any more — on `reconcile`, not immediately, so a
brief window can leave a stale key behind between one job finishing and the
next tool call touching the project.

`state.json.gate_confirmed` records whether the runner's own watchdog saw
`jobs/<id>/gate-log.jsonl` receive a line before the first tool call
completed: `true` confirmed, `false` forced `outcome: "process_error"` and
killed the job (the hook never actually loaded), `null`/absent means the job
ended before any tool call ran, so there was nothing to confirm.

## Project root discovery

`AGY_WORKER_PROJECT` (override) → nearest ancestor containing `.git` → the
starting directory itself. Always canonicalized. A non-git directory works.
`agy_capabilities` reports which root was actually chosen — check it there
rather than assuming.

## No daemon

There is no background process reconciling state. Every tool handler runs
`reconcile()` on entry, which is where a dead runner, a stale lock, or a passed
deadline gets noticed and finalized. A job whose client vanished sits in
whatever state it reached until the next tool call touches this project — the
job itself keeps running regardless, since it is detached with its own process
group and file-backed output.

## Job lifecycle

```
queued -> starting -> running -> finished
                          \-> canceling -> finished
```

`finished` is the only terminal state; the verdict lives in `outcome`
(`verified_success`, `success_unverified`, `blocked`, `failed`, `timed_out`,
`canceled`, `process_error`, `orphaned`), not in the lifecycle.

`process_error` is reconcile's word for "the runner is gone and never wrote
`exit_code`", decided from pid liveness plus a start-time token. A `ps` that
fails to run while the pid is demonstrably alive (measured 2026-09-03 with a
`verify_command` starting vitest on a fork-saturated machine) is treated as
"same process", never as "gone" — otherwise a healthy job finishing its checks
would be finalized as lost.

The pid the row tracks is agy's, not the runner's. After agy exits, the runner
may still be running `verify_command` for minutes — agy's pid gone, no
`exit_code` yet, exactly what a lost runner looks like. Measured 2026-09-08:
every job with a multi-second verify (gradle build, `npm test`) was judged
`process_error` a second and a half after agy exited, with a real exit 0
landing shortly after. Since 0.2.2 the runner writes `state.json.phase`
(`agy` → `verifying` → `done`) and `state.json.runner_pid`, and reconcile
defers to a live runner: pid gone but runner alive is "still running", and a
passed `deadline_at` during `verifying` waits out `verify_timeout_ms` plus a
one-minute backstop before enforcing. `agy_wait` on such a job says so in its
headline (`verify_command in progress`).

`finished_at` and `duration_ms` are the runner's recorded end
(`state.json.finished_at`), not the moment reconcile happened to look;
`finalized_at` is the latter. A job nobody polls for days keeps its real
duration.

## Locks and concurrency

| Lock | Key | Meaning |
| --- | --- | --- |
| `cwd_write` | canonical workspace | One writing job per workspace. Read-only profiles do not take it. |
| `session` | session id | One live job per conversation. |
| running limit | — | 3 live jobs per project by default. |

A lost race raises `LOCK_CONFLICT` naming the holder job, its pid, and when the
lock was acquired. Nothing is silently queued, and a losing `agy_start` leaves
no rows or directories behind — locks are taken before anything is created.

A lock held by a process that is gone is reclaimed on reconcile. Process
identity is checked with an opaque platform start-time token compared against
the recorded one, so a recycled pid is never mistaken for the original.

## Timeouts

| Limit | Default | Ceiling |
| --- | --- | --- |
| `timeout_ms` | 15 min | 1 h |
| `idle_timeout_ms` (session mode) | 2 min | 1 h |
| response bytes per reply | 32 KB | — |
| log tail lines | 30 | — |

`timeout_ms` becomes `deadline_at` and is enforced by the runner's watchdog,
which kills the whole process group and records `timed_out` so reconcile does
not misfile it as `failed`. `agy_send` never extends it.

The idle timeout is a judgement call, not a measurement: it exists so an
abandoned session cannot hold its locks indefinitely. It arms only after a
turn's `result` event, never mid-turn.

## Retention

`agy_start` opportunistically deletes job directories older than 7 days. There
is no scheduled cleanup — like everything else here, it happens on a tool call.

## Tests

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest, against test/fake-agy — never the real agy binary
npm run build       # emits dist/server.js, dist/runner.js, dist/gate.js
```

`npm test` and CI run exclusively against the scripted fake in
`test/fake-agy/`. The real `agy` CLI is never invoked, because every invocation
spends real account quota.

The real binary is exercised only by a separate live suite, opt-in twice over —
its files are `*.live.ts` (the default config collects only `*.test.ts`) and
every test skips without `AGY_LIVE=1`:

```bash
npm run test:live   # spends real agy quota
```

The live suite is what overturned several design assumptions that the fake
harness had been happily agreeing with: `--sandbox` not confining writes, shell
redirection escaping the workspace, session-mode turn 1 having to go through
stdin, timeouts being misfiled as failures, and — the one behind 0.2.1 — the
OS sandbox on agy 1.1.24 refusing every in-workspace shell write, which made a
sandboxed `general_worker` unable to build, test, or commit at all.

Running this server's own development through it (0.2.1 was drafted by an
`agy` job started from this repository) is the cheapest live test there is:
that one job surfaced a denied workspace-root listing, three false sandbox
blockers from `grep_search` output, and a `process_error` misfire during
`verify_command`, all fixed in the same release.
