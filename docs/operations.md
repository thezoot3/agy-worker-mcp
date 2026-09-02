# Operations

## Where state lives

Nothing is written inside your repository. Per-project state lives under the
state home, keyed by a hash of the canonical project root:

```
~/.agy-worker/projects/<sha256(canonical_root)[:16]>/
    project.json  index.db
    jobs/<job-id>/ request.json  effective-config.json  state.json
                   events.ndjson stderr.log exit_code
                   inbox.jsonl   policy.json  gate-log.jsonl
                   agent-result.json  broker-result.json  verification.json
```

`index.db` is SQLite: jobs, sessions, and locks. It is what makes a job
visible to a second client that did not start it.

The one exception is `.agents/hooks.json`, written into the workspace so `agy`
loads our permission gate. It merges into an existing file rather than
clobbering unrelated keys, and it holds absolute paths — do not commit it.

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
`canceled`), not in the lifecycle.

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
stdin, and timeouts being misfiled as failures.
