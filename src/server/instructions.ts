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
  agy_result -> verification.permission_denials[].required_rule is a rule
  string, e.g. "command(python -m pytest)". Put it into the next agy_start's
  permissions.allow and retry. allow is intersected with the profile ceiling,
  so a rejected entry comes back in rejected_allow rather than failing
  silently — check that before assuming the retry will work.
  verification.environment_blocks[].signature explains a silent sandbox
  failure such as a blocked DNS lookup (network is denied by default; ask for
  permissions.network: "allow" on a profile that permits opting in).

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
