#!/usr/bin/env node
/**
 * Entry point for the PreToolUse hook. Compiles to `dist/gate.js`, the path
 * written into `<workspace>/.agents/hooks.json`.
 *
 * ⚠ Never exit without printing a decision. `{}` and empty output are denials
 * (docs/02 §9), and this process also runs for the user's own interactive agy
 * sessions whenever a conversation cannot be matched to one of our jobs.
 */
import { PASSTHROUGH, main } from './gate/gate.js'

main()
  .then((code) => process.exit(code))
  .catch(() => {
    process.stdout.write(JSON.stringify(PASSTHROUGH))
    process.exit(0)
  })
