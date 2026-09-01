#!/usr/bin/env node
/**
 * Entry point for the detached runner. Compiles to `dist/runner.js`.
 *
 * Spawned with `detached: true` by whichever server started the job, and expected
 * to keep running after that server is gone.
 */
import { main } from './runner/runner.js'

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    process.stderr.write(`agy-worker-runner: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
    process.exit(1)
  })
