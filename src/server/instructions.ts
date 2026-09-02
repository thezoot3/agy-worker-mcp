/**
 * Server instructions — returned in the MCP `initialize` response and injected
 * into the calling agent's system prompt.
 *
 * This is the top layer of the three-layer tool surface (`docs/04`, Stage 4):
 * this file sets orientation and the traps that matter before the first call;
 * per-tool `description` and per-parameter `.describe()` carry the call-by-call
 * detail; `contract/errors.ts` carries the in-the-moment repair. Two rules for
 * whoever edits it: never describe a capability that does not exist, and never
 * omit a trap that does.
 */
export const SERVER_INSTRUCTIONS = `agy-worker-mcp runs the Google Antigravity CLI (agy) as an asynchronous worker.
Jobs are detached: they survive this connection, and any client attached to the
same project can observe, wait on, or take over any job — including one another
client started.

Recommended flow
  agy_capabilities  -> profiles, models, limits, discovered project root
  agy_start         -> returns a job_id immediately; nothing blocks
  agy_wait          -> loop: call again with the returned cursor until
                        lifecycle is "finished" (wait_ms: 0 = snapshot, no block)
  agy_result        -> full verdict, denials, artifacts, response text
  agy_logs          -> only if you need the raw or normalized stream itself,
                        by cursor or tail

Two things that will mislead you if you forget them
  1. Do not trust agy's self-report. Permission denials and sandbox blocks both
     come back as exit 0 with status SUCCESS. Read outcome and contract_status
     from the broker instead; agent_report is an unverified claim, never the
     basis for outcome.
  2. verified_success means checks actually passed. success_unverified means
     nothing was checkable. blocked means something was denied or silently
     blocked by the sandbox. Treat blocked as "did not do what you asked," not
     as a lesser success.

When a job is blocked
  agy_result -> verification.blockers[] is one list of everything that stood
  in the way. Read two fields first: "actionable" says whether a different
  agy_start can lift it, and "remedy" says what to change (a rule string like
  "command(python -m pytest)" for our gate, permissions.network: "allow" for a
  blocked DNS lookup). actionable: false means no permissions.allow rule will
  help — agy's own permission engine refused, or the command tried to leave
  the workspace. "source" says who refused: policy_ceiling, gate, agy_engine,
  sandbox, broker, tool_error.
  agy_start reports the same shape before a job runs: its policy_summary and
  blockers[] tell you if the ceiling rejected your permissions.allow. Note
  allow_count: 0 — a fully rejected request drops the profile's own defaults
  with it, and the fix is to start again with no permissions.allow at all.

What is not possible
  You cannot interrupt or redirect a turn that is already running. agy_send
  only queues: the current turn finishes first, then the queued one runs, on a
  job started with session_mode "session".
  Sessions resume losslessly, so a finished oneshot job can be continued at
  any time with agy_start({ session_id }) — no need to keep a session-mode job
  running just to preserve context.

Saving quota
  agy_start({ dry_run: true }) resolves cwd, profile, policy and argv and
  returns the effective config without launching agy or spending quota. Use it
  to settle permissions before a real run, especially after a blocked job.`
