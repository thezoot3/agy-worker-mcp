# Raw `agy` 1.1.23 captures

Unedited `--output-format stream-json` output from the real `agy` CLI, kept so
`test/fake-agy/golden.test.ts` can prove the fake still emits the same *shape*:
same event order, same field sets, same types. Values are free to differ.

| File | Scenario |
| --- | --- |
| `happy.events.ndjson` | One turn, one allowed `run_command`. |
| `hook-denied.events.ndjson` | Two `run_command` steps, the second refused by a `PreToolUse` hook. |

The only edit is the capture workspace path, rewritten from a local home
directory to `/tmp/agy-spike`.

Source comments elsewhere cite other captures (`.spike/out/probeA.err` and
friends) as provenance for a specific measured behaviour. Those belong to the
private capture set that produced the internal findings notes and are not
published; the two files here are the ones any test actually reads.
