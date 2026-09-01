# fake agy

A stand-in for the real `agy` binary. Point `AGY_WORKER_AGY_BIN` at `agy.mjs` and
nothing in `src/` can tell the difference.

Never run the real `agy` in tests — it costs quota. Everything here is
transcribed from `docs/02-agy-cli-findings.md` and the raw captures in
`.spike/out/`; `golden.test.ts` fails if the shapes ever drift apart.

## Choosing a scenario

```
AGY_FAKE_SCENARIO=happy            # a name under scenarios/
AGY_FAKE_SCENARIO=/abs/path.json   # or an absolute path
AGY_FAKE_STATE_DIR=/tmp/whatever   # where --conversation resume state lives
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
  "duration_seconds": 0.09 }

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
- Without `--add-dir` no workspace hooks load at all (§3), and `toolCall.args.Cwd`
  in the hook payload points at agy's scratch directory.
- The global `~/.gemini/config/hooks.json` is deliberately **not** read, so tests
  never fire the developer's own hooks.
- Exit codes: 0 normally, 2 for a flag error, 1 for a stream-input schema error
  (which still emits a `result` event with `status: "ERROR"` first).
