# Documentation

- [`tools.md`](./tools.md) — the ten MCP tools, parameter by parameter, plus
  the result vocabulary (`outcome`, `contract_status`, the judgement packet).
- [`permissions.md`](./permissions.md) — the three-owner permission model
  (code, the project's own ceiling file, the parent agent's request), the
  gate's decision order, containment, `verify_command`, and denial recovery.
- [`operations.md`](./operations.md) — where state lives, job lifecycle,
  locks and concurrency, timeouts, retention, and the test suites.
- [`../CHANGELOG.md`](../CHANGELOG.md) — what changed in each version.

Also shipped in the package, outside `docs/`: `skills/agy-ceiling/SKILL.md`
(a Claude Code skill) and `commands/agy-ceiling.md` (a `/agy-ceiling` slash
command), both for proposing a project ceiling with the user's approval;
`agy-worker-setup` copies them into `.claude/`.

## A note on source comments

Historical design records and raw measurement notes cited in source comments are internal working documents and are not included in this repository. All documentation necessary to use, configure, and understand this server is contained in the files listed above.
