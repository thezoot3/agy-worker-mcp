#!/usr/bin/env node
/**
 * Entry point registered as `agy-worker-mcp`. Compiles to `dist/server.js`,
 * which is the path both Codex and Claude Code launch (`docs/01` 결정 6).
 */
import { main } from './server/server.js'

// Backstop for any promise (e.g. a `reconcile()` call an editor missed) that
// rejects without being awaited: without this, Node's default behavior is to
// crash the whole stdio server on the next microtask turn (finding 3/16).
process.on('unhandledRejection', (reason: unknown) => {
  process.stderr.write(
    `agy-worker-mcp: unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`,
  )
})

main().catch((e: unknown) => {
  process.stderr.write(`agy-worker-mcp: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
  process.exit(1)
})
