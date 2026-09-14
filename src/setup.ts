#!/usr/bin/env node
/**
 * `agy-worker-setup` — put the package's Claude Code and Codex pieces where they
 * belong. Writes the stable spawn-time launcher to <stateHome>/bin/agy-worker-mcp,
 * installs skills and commands, and prints client configuration blocks.
 * Run with `--doctor` to diagnose installation issues.
 */
import { doctor } from './setup/doctor.js'
import { install, parseSetupArgs, usage } from './setup/install.js'
import { runReport } from './report/report.js'

const parsed = parseSetupArgs(process.argv.slice(2))
if (parsed.kind === 'help') {
  process.stdout.write(usage())
  process.exit(0)
}
if (parsed.kind === 'error') {
  process.stderr.write(`${parsed.message}\n\n${usage()}`)
  process.exit(2)
}
if (parsed.kind === 'doctor') {
  const report = doctor(parsed.options)
  process.stdout.write(report.text)
  process.exit(report.ok ? 0 : 1)
}
if (parsed.kind === 'report') {
  const result = runReport(parsed.options)
  process.stdout.write(result.ok ? result.text : '')
  if (!result.ok) process.stderr.write(result.text)
  process.exit(result.ok ? 0 : 1)
}
const report = install(parsed.options)
process.stdout.write(report.text)
process.exit(report.ok ? 0 : 1)
