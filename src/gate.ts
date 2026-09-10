#!/usr/bin/env node
/**
 * Entry point for the PreToolUse hook. Compiles to `dist/gate.js`, the path
 * written into `<workspace>/.agents/hooks.json`.
 *
 * ⚠ Never exit without printing a decision. `{}` and empty output are treated
 * as denials by agy, and this process also runs for the user's own interactive agy
 * sessions whenever a conversation cannot be matched to one of our jobs.
 */
import { PASSTHROUGH, emit, guardStdout, main } from './gate/gate.js'

// Before anything else can print. A hook that exits 0 with unparseable stdout
// is treated as a denial by agy, and this process always exits 0.
guardStdout()

main()
  .then((code) => process.exit(code))
  .catch(() => {
    emit(PASSTHROUGH)
    process.exit(0)
  })
