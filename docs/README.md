# Documentation

- [`tools.md`](./tools.md) — the nine MCP tools, parameter by parameter, plus
  the result vocabulary (`outcome`, `contract_status`, the judgement packet).
- [`permissions.md`](./permissions.md) — profiles, how a client request is
  merged with a profile ceiling, the containment check, denial recovery, and
  the security limits you must know before running untrusted prompts.
- [`operations.md`](./operations.md) — where state lives, job lifecycle,
  locks and concurrency, timeouts, retention, and the test suites.

## A note on source comments

Source comments cite internal design records as `docs/01`–`docs/05` — a design
record, the measured `agy` CLI findings, the permission/session model, MVP
scope, and the live-verification log. Those notes are working documents kept
out of this repository (`docs/.local/`, git-ignored); the material a user of
this server actually needs was rewritten into the three files above. A citation
you cannot follow is a pointer into that private record, not a missing file.
