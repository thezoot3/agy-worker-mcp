/**
 * Server instructions — returned in the MCP `initialize` response and injected
 * into the calling agent's system prompt.
 *
 * This is the top layer of the three-layer tool surface:
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
     nothing was checkable. blocked means something was denied (or, on a job
     that ran sandboxed, silently refused by the OS sandbox). Treat blocked as
     "did not do what you asked," not as a lesser success.

When a job is blocked
  agy_result -> verification.blockers[] is one list of everything that stood
  in the way. Read two fields first: "actionable" says whether a different
  agy_start can lift it, and "remedy" says what to change (a rule string like
  "command(python -m pytest)" for our gate; a rule the project ceiling lacks
  needs a human to widen the ceiling file, not agy_start).
  actionable: false means no agy_start argument will help — the command tried
  to leave the workspace, a subagent tool was used (subagents run outside this
  job's policy and are always denied), the ceiling refused the rule, or the
  ceiling forces the sandbox on. "source" says who refused: policy_ceiling,
  gate, agy_engine, sandbox, broker, tool_error. Our gate is the sole approval
  authority for a job (agy's own approval engine is disabled), so an
  agy_engine entry on a current job means something regressed — report it.
  Sandbox: allowed commands run WITHOUT agy's OS sandbox on general_worker
  (0.2.1) — the gate's allow list is the boundary, as in Claude Code — so an
  "Operation not permitted" there is the command's own failure and comes back
  as a warning, not a blocker. research_readonly is always sandboxed; a project
  can set sandbox: "seatbelt" (our write-only profile: writes stay inside the
  workspace and the ceiling's write_roots, builds still run) or sandbox: "agy"
  in its ceiling file, and the parent can raise it per job with
  permissions.sandbox. On agy 1.1.24 an agy-sandboxed job cannot
  write inside the workspace from a shell (builds, tests, git commit fail),
  though agy's own file tools still edit files. agy_start reports the same
  shape before a job runs:
  its policy_summary and blockers[] tell you if the ceiling rejected your
  permissions.allow. Note allow_count: 0 — a fully rejected request drops the
  profile's own defaults with it, and the fix is to start again with no
  permissions.allow at all.

What is not possible
  You cannot interrupt or redirect a turn that is already running. agy_send
  only queues: the current turn finishes first, then the queued one runs, on a
  job started with session_mode "session".
  Sessions resume losslessly, so a finished oneshot job can be continued at
  any time with agy_start({ session_id }) — no need to keep a session-mode job
  running just to preserve context.

Before agy_start on general_worker (measured 2026-09-08 across 35 real jobs)
  - Give it something checkable: verify_command (the build or test command),
    expected_artifacts, or json_schema. Without one the best possible outcome
    is success_unverified and you will end up re-running the checks yourself;
    12 of those 35 jobs went exactly that way.
  - Every shell command your prompt asks for must match the effective allow
    list (agy_capabilities: profiles[].allow plus ceiling.allow; a rule on
    profiles[].deny opens only through ceiling.exceptions). A prompt
    that says "run JAVA_HOME=... ./gradlew" against a list that only allows
    "./gradlew" guarantees a blocked job. Check with agy_start({ dry_run: true, expected_commands: [...] }).
  - One writing job per cwd at a time (a cwd_write lock; a second agy_start
    fails with LOCK_CONFLICT). For parallel work, give each job its own git
    worktree inside the project root as cwd.
  - When a blocker's remedy needs the ceiling (actionable: false, source
    policy_ceiling, or a rule the ceiling lacks), report the rule string and
    the ceiling file path (agy_capabilities -> ceiling.path) to the user
    verbatim and stop. Do not work around it by telling the next job not to
    run that command — that only moves the check back onto you. To propose a
    ceiling, call agy_ceiling (history + validation of a draft) and show the
    user the draft; never write policy.json without their explicit approval
    of that draft in the current conversation.
  - A warning starting "no project ceiling at" (agy_capabilities,
    agy_start, agy_result) means this project has no ceiling file and jobs
    get the profile as shipped. Not an error; do not repeat it to the user on
    every call. Mention it once when a job needs more than the profile
    allows, or when the user asks why something was denied: they can run
    /agy-ceiling themselves, or you can draft one via agy_ceiling / the
    agy-ceiling skill. Either way the user approves before anything is
    written.

Saving quota
  agy_start({ dry_run: true }) resolves cwd, profile, policy and argv and
  returns the effective config without launching agy or spending quota. Use it
  to settle permissions before a real run, especially after a blocked job.

verify_command
  agy_start({ verify_command }) runs a command once, after agy exits normally,
  against the final workspace state — outside the model's own decisions
  entirely; it cannot be skipped, reordered, or narrowed from inside the job.
  It is not a sandboxing feature: it runs as the user, unsandboxed, exactly the
  way the parent agent running the command itself would. A non-zero exit or a
  verify_timeout_ms timeout makes outcome "failed" — never a blocker, since
  nothing was refused. agy_result's verification.verify carries
  { command, exit_code, signal, duration_ms, timed_out, output_tail }, where
  output_tail is only the last 2 KiB; the full log is
  jobs/<job_id>/verify.log on disk. verify: null means no verify_command was
  configured (or the job's own deadline killed agy first, which skips verify
  entirely).`
