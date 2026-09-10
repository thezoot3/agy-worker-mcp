/**
 * `agy-worker-setup` (`src/setup/install.ts`): copies the shipped skill and
 * slash command into a `.claude` directory, never overwrites without --force,
 * and reports exactly what it did.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { destinationDir, install, parseSetupArgs, SETUP_ITEMS } from '../../../src/setup/install.js'

let base: string
let source: string
let dest: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'agy-setup-'))
  source = join(base, 'pkg')
  dest = join(base, 'claude')
  mkdirSync(join(source, 'skills', 'agy-ceiling'), { recursive: true })
  mkdirSync(join(source, 'commands'), { recursive: true })
  writeFileSync(join(source, 'package.json'), JSON.stringify({ version: '9.9.9' }))
  writeFileSync(join(source, 'skills', 'agy-ceiling', 'SKILL.md'), '# skill')
  writeFileSync(join(source, 'commands', 'agy-ceiling.md'), '# command')
})

afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('install', () => {
  it('copies every SETUP_ITEM into dest and reports copied', () => {
    const r = install({ scope: 'project', cwd: base, dryRun: false, force: false, dest, source })
    expect(r.ok).toBe(true)
    expect(r.items.map((i) => i.action)).toEqual(SETUP_ITEMS.map(() => 'copied'))
    expect(readFileSync(join(dest, 'skills', 'agy-ceiling', 'SKILL.md'), 'utf8')).toBe('# skill')
    expect(readFileSync(join(dest, 'commands', 'agy-ceiling.md'), 'utf8')).toBe('# command')
    expect(r.text).toContain('9.9.9')
    expect(r.text).toContain('claude mcp add agy')
  })

  it('skips existing files unless --force, then overwrites', () => {
    mkdirSync(join(dest, 'commands'), { recursive: true })
    writeFileSync(join(dest, 'commands', 'agy-ceiling.md'), 'mine')
    const a = install({ scope: 'project', cwd: base, dryRun: false, force: false, dest, source })
    expect(a.items.find((i) => i.kind === 'command')?.action).toBe('skipped_exists')
    expect(readFileSync(join(dest, 'commands', 'agy-ceiling.md'), 'utf8')).toBe('mine')
    const b = install({ scope: 'project', cwd: base, dryRun: false, force: true, dest, source })
    expect(b.items.find((i) => i.kind === 'command')?.action).toBe('overwritten')
    expect(readFileSync(join(dest, 'commands', 'agy-ceiling.md'), 'utf8')).toBe('# command')
  })

  it('dry run plans and touches nothing', () => {
    const r = install({ scope: 'project', cwd: base, dryRun: true, force: false, dest, source })
    expect(r.items.every((i) => i.action === 'planned')).toBe(true)
    expect(existsSync(dest)).toBe(false)
  })

  it('a missing source item is reported and fails the run', () => {
    rmSync(join(source, 'commands'), { recursive: true })
    const r = install({ scope: 'project', cwd: base, dryRun: false, force: false, dest, source })
    expect(r.ok).toBe(false)
    expect(r.items.find((i) => i.kind === 'command')?.action).toBe('missing_source')
  })

  it('the shipped package really has every SETUP_ITEM (source = repo root)', () => {
    const r = install({ scope: 'project', cwd: base, dryRun: true, force: false, dest })
    expect(r.ok).toBe(true)
  })
})

describe('parseSetupArgs / destinationDir', () => {
  it('defaults to project scope in cwd', () => {
    const p = parseSetupArgs([], '/w')
    expect(p.kind).toBe('run')
    if (p.kind === 'run') expect(destinationDir(p.options)).toBe('/w/.claude')
  })

  it('accepts --scope user, --dest, --dry-run, --force; rejects junk', () => {
    const p = parseSetupArgs(['--scope', 'user', '--dry-run', '--force'], '/w')
    expect(p.kind).toBe('run')
    if (p.kind === 'run') {
      expect(p.options.scope).toBe('user')
      expect(p.options.dryRun).toBe(true)
      expect(p.options.force).toBe(true)
      expect(destinationDir(p.options).endsWith('/.claude')).toBe(true)
    }
    expect(parseSetupArgs(['--scope=nope']).kind).toBe('error')
    expect(parseSetupArgs(['--wat']).kind).toBe('error')
    expect(parseSetupArgs(['--help']).kind).toBe('help')
    const d = parseSetupArgs(['--dest=/x/.claude'])
    if (d.kind === 'run') expect(destinationDir(d.options)).toBe('/x/.claude')
  })
})
