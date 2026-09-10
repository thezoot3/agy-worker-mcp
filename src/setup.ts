#!/usr/bin/env node
/**
 * `agy-worker-setup` — put the package's Claude Code pieces where Claude Code
 * looks for them. The MCP server registers with `claude mcp add`; the skill
 * (`skills/agy-ceiling`) and the slash command (`commands/agy-ceiling.md`)
 * have to be copied into `.claude/` by hand — npm has no hook for that, and a
 * `postinstall` that wrote into the user's home would be exactly the kind of
 * unrequested write this project refuses to make. So it is a command you run
 * once, and it prints what it did.
 */
import { install, parseSetupArgs, usage } from './setup/install.js'

const parsed = parseSetupArgs(process.argv.slice(2))
if (parsed.kind === 'help') {
  process.stdout.write(usage())
  process.exit(0)
}
if (parsed.kind === 'error') {
  process.stderr.write(`${parsed.message}\n\n${usage()}`)
  process.exit(2)
}
const report = install(parsed.options)
process.stdout.write(report.text)
process.exit(report.ok ? 0 : 1)
