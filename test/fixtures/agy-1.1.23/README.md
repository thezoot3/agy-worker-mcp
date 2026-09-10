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

## 1.1.24 차이

`docs/.local/06-0.2.0-measurements.md`가 agy 1.1.24에서 재측정한 결과, 이 두
캡처(`happy`/`hook-denied`, 둘 다 `run_command` 단일 스텝)의 이벤트 shape과
`init.tools` 도구 목록은 1.1.23과 동일하다 — 여기 있는 골든 파일을 다시 캡처할
필요는 없다. 달라진 것은 이 두 캡처가 다루지 않는 영역(다른 도구의 인자 스키마,
서브에이전트, `BypassSandbox`, 훅 로딩 로그, 다중 훅 그룹 판정)에 대한 새 관측
6건(M1-M6)이며, 세부 내용과 근거는 `docs/.local/06`을 참조.
