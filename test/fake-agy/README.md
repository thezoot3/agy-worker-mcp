# fake agy

A stand-in for the real `agy` binary. Point `AGY_WORKER_AGY_BIN` at `agy.mjs` and
nothing in `src/` can tell the difference.

Never run the real `agy` in tests — it costs quota. Everything here is
transcribed from the raw captures in `test/fixtures/agy-1.1.23/` and
the 1.1.24 follow-up measurements (M1-M6); `golden.test.ts` fails if the
shapes ever drift apart from the 1.1.23 captures.

## Choosing a scenario

```
AGY_FAKE_SCENARIO=happy            # a name under scenarios/
AGY_FAKE_SCENARIO=/abs/path.json   # or an absolute path
AGY_FAKE_STATE_DIR=/tmp/whatever   # where --conversation resume state lives
AGY_FAKE_SKIP_HOOKS=1              # fake-only: never load <ws>/.agents/hooks.json,
                                    # even with --add-dir (see "Fake-only env vars")
```

Default is `scenarios/happy.json`. Set `AGY_FAKE_STATE_DIR` per test so parallel
runs cannot resume each other's conversations.

## Scenario format

```jsonc
{
  "name": "happy",
  "model": "gemini-3.7-flash-low",   // overridden by --model
  "exit_code": 0,                     // process exit code, default 0
  "turns": [                          // turn N uses turns[N], last one repeats
    {
      "status": "SUCCESS",            // or "ERROR"
      "error": "...",                 // adds result.error
      "response": "final text",
      "response_if_denied": "...",    // used instead when a hook denied a step
      "duration_seconds": 2.8,
      "steps": [ /* see below */ ]
    }
  ]
}
```

### Step types

```jsonc
// agent_response — the chunk count picks the emitted shape, and all three occur
// in the goldens, so pick deliberately:
//   []          -> one DONE, no text_delta        (run1 step 1, run6 steps 1/3)
//   ["a"]       -> one DONE with text_delta       (run6 step 5)
//   ["a", "b"]  -> n-1 ACTIVE, then DONE          (run1 step 3)
{ "type": "agent_response", "chunks": [], "duration_seconds": 1.4, "usage": [16015, 80] }

// tool — emits ACTIVE, calls the PreToolUse hook, then DONE or ERROR
{ "type": "tool", "tool_name": "run_command",
  "parameters": { "CommandLine": "echo hi" },
  "output": "hi\n",
  "tool_action": "…", "tool_summary": "…",   // hook payload only
  "wait_ms_before_async": 5000,
  "duration_seconds": 0.09,

  // Fake-only extension (not part of agy's real wire format). Present only on
  // an `invoke_subagent`-shaped step, it reproduces M2: the subagent's own
  // run_command runs through the exact same ACTIVE/hook/DONE-or-ERROR path,
  // as its own step_update, but with a freshly generated conversationId
  // instead of the parent's. Same sub-object shape as a "tool" step itself
  // (parameters/output/tool_action/tool_summary/duration_seconds); tool_name
  // is always "run_command" and isn't repeated here. See scenarios/
  // subagent-bypass.json.
  "subagent_run_command": {
    "parameters": { "CommandLine": "echo from-subagent" },
    "output": "from-subagent\n",
    "duration_seconds": 0.06
  }
}

{ "type": "system_message", "duration_seconds": 0.0001 }
```

`usage` is `[input, output, thinking?, cache_read?]`. `result.usage` is the running
total for the conversation, which is what the real binary reports.

Every step accepts `delay_ms` for slow-job tests.

## Behaviour worth knowing before you write a scenario

- A tool step only becomes `state: "ERROR"` if a **real hook denies it**. There is
  no "pretend this was denied" field: the denial path is the thing under test.
  A denial scenario therefore needs `--add-dir <ws>` and `<ws>/.agents/hooks.json`.
- `{}`, unparsable output, and empty output from a hook all mean **deny**.
  `ask` and `force_ask` pass through.
- Two or more hook groups in `hooks.json` are evaluated **sequentially, in
  declaration order**. A `deny` short-circuits — no later group runs. An
  `allow` does **not** short-circuit — evaluation keeps going, so a later
  group's `deny` still wins (M6).
- Without `--add-dir` no workspace hooks load at all, and `toolCall.args.Cwd`
  in the hook payload points at agy's scratch directory. `AGY_FAKE_SKIP_HOOKS=1`
  (fake-only) forces the same "no hooks loaded" outcome even *with* `--add-dir`,
  for testing what happens when hooks.json fails to load (I4: runtime gate confirmation).
- The global `~/.gemini/config/hooks.json` is deliberately **not** read, so tests
  never fire the developer's own hooks.
- Exit codes: 0 normally, 2 for a flag error, 1 for a stream-input schema error
  (which still emits a `result` event with `status: "ERROR"` first).
- `--dangerously-skip-permissions` is accepted and its value is read (it feeds
  the `run_command` BypassSandbox handling below); `--add-dir` may repeat.

### `run_command`'s BypassSandbox simulation (M3, M4, M1)

Once a `run_command` call is hook-allowed, the fake works out whether it
actually runs sandboxed, exactly as the real binary was measured to:

1. If the hook's `overwrite.BypassSandbox` is `true` or `false`, that value
   wins outright — regardless of `--dangerously-skip-permissions` (M3-A/B).
2. Otherwise, if the scenario's `parameters.BypassSandbox` is `true` (the
   model asking for an unsandboxed run), `--dangerously-skip-permissions`
   decides: present -> runs normally (M3-C); absent -> the step ends
   `state: "ERROR"` with agy's own permission-engine refusal text (`user
   denied permission to run command` / `permission check failed for
   unsandboxed`, matching `AGY_ENGINE_REFUSAL_SIGNATURES` in
   `src/contract/types.ts` — not a hook denial, so it's not prefixed with
   `tool call denied by pre-tool hook:`).
3. Otherwise the call is sandboxed. The fake then checks `CommandLine` for:
   - an absolute (or `~`-relative) path outside every `--add-dir` root
     (whitespace-tokenized, not a real shell parser). If found, the step
     stays `state: "DONE"` with `tool_info.output` synthesized as
     `` `<cmd>: <path>: Operation not permitted\n` `` (M3-A).
   - an in-workspace shell write (file creation via redirection `> file`,
     `touch`, `mkdir`, `git commit` — M7). If found, the step stays
     `state: "DONE"` with `tool_info.output` synthesized as an
     `Operation not permitted` failure.
   The scenario's own `output` is ignored in either case. If neither condition
   trips (or if `BypassSandbox` is `true`), the scenario's scripted `output` is
   used as normal.

`run_command` never actually execs a shell — this only decides which of
"scripted output" / "synthesized OS failure" / "engine refusal" applies.

### The file/task tools operate on the real filesystem

`view_file`, `list_dir`, `find_by_name`, `grep_search`, `replace_file_content`,
`write_to_file`, and `manage_task` are **not** scripted through a step's
`output` field. `tools.mjs`'s `runFileTool` actually reads/writes/greps the
real filesystem using the tool's own argument names (verbatim from M1:
`AbsolutePath`, `DirectoryPath`, `SearchDirectory` + `Pattern`, `SearchPath` +
`Query` + `MatchPerLine`, `TargetFile` + `TargetContent`/`ReplacementContent`/
`StartLine`/`EndLine`, `TargetFile` + `CodeContent`/`Overwrite`, `Action` +
`TaskId` + `Input`). A scenario step for one of these tools only needs
`parameters`; any `output` field is ignored.

`write_to_file` reproduces M1's headline finding: it only succeeds under
`~/.gemini/antigravity-cli/brain/<conversationId>/`, and otherwise the step
ends `state: "ERROR"` with the verbatim message measured for
§M1 (`... is not a valid artifact
path; artifacts must be in .../brain/<conversationId>/`). `manage_task` with
`Action: "send_input"` and no `Input` fails with `Input is required for
send_input action`, also verbatim from M1.

These are deliberately simple, not full reimplementations: `find_by_name`
matches file names only (not directories); `grep_search` does a plain
substring search per line, not a regex engine.
