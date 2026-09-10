/**
 * `agy-worker-setup` (`src/setup/install.ts`): copies or symlinks the shipped
 * skill and slash command into Claude Code and Codex directories, writes the
 * spawn-time launcher, never overwrites without --force, and reports exactly
 * what it did.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { destinationDir, install, parseSetupArgs, SETUP_ITEMS } from '../../../src/setup/install.js'

let base: string
let fakeHome: string
let fakeCodexHome: string
let fakeStateHome: string
let source: string
let dest: string

let originalHome: string | undefined
let originalCodexHome: string | undefined
let originalAgyWorkerHome: string | undefined

beforeEach(() => {
  originalHome = process.env.HOME
  originalCodexHome = process.env.CODEX_HOME
  originalAgyWorkerHome = process.env.AGY_WORKER_HOME

  base = mkdtempSync(join(tmpdir(), 'agy-setup-'))
  fakeHome = join(base, 'home')
  fakeCodexHome = join(fakeHome, '.codex')
  fakeStateHome = join(fakeHome, '.agy-worker')
  mkdirSync(fakeHome, { recursive: true })
  mkdirSync(fakeCodexHome, { recursive: true })
  mkdirSync(fakeStateHome, { recursive: true })

  process.env.HOME = fakeHome
  process.env.CODEX_HOME = fakeCodexHome
  process.env.AGY_WORKER_HOME = fakeStateHome

  source = join(base, 'pkg')
  dest = join(base, 'claude')
  mkdirSync(join(source, 'skills', 'agy-ceiling'), { recursive: true })
  mkdirSync(join(source, 'commands'), { recursive: true })
  writeFileSync(join(source, 'package.json'), JSON.stringify({ version: '9.9.9' }))
  writeFileSync(join(source, 'skills', 'agy-ceiling', 'SKILL.md'), '# skill')
  writeFileSync(join(source, 'commands', 'agy-ceiling.md'), '# command')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
  if (originalHome !== undefined) process.env.HOME = originalHome
  else delete process.env.HOME
  if (originalCodexHome !== undefined) process.env.CODEX_HOME = originalCodexHome
  else delete process.env.CODEX_HOME
  if (originalAgyWorkerHome !== undefined) process.env.AGY_WORKER_HOME = originalAgyWorkerHome
  else delete process.env.AGY_WORKER_HOME
})

describe('install', () => {
  it('copies every SETUP_ITEM into dest and reports copied', () => {
    const r = install({ scope: 'project', cwd: base, dryRun: false, force: false, dest, source })
    expect(r.ok).toBe(true)
    expect(r.items.map((i) => i.action)).toEqual(SETUP_ITEMS.map(() => 'copied'))
    expect(readFileSync(join(dest, 'skills', 'agy-ceiling', 'SKILL.md'), 'utf8')).toBe('# skill')
    expect(readFileSync(join(dest, 'commands', 'agy-ceiling.md'), 'utf8')).toBe('# command')
    expect(r.text).toContain('9.9.9')
    expect(r.text).toContain('claude mcp add agy')
    expect(r.text).toContain('Launcher:')
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

  it('idempotence: running install twice changes nothing and reports skips (Case 7)', () => {
    const first = install({ scope: 'user', cwd: base, dryRun: false, force: false, source })
    expect(first.ok).toBe(true)
    expect(first.items.some((i) => i.action === 'copied')).toBe(true)

    const second = install({ scope: 'user', cwd: base, dryRun: false, force: false, source })
    expect(second.ok).toBe(true)
    expect(second.items.every((i) => i.action === 'skipped_exists')).toBe(true)
  })

  it('--link produces symlinks (Case 8)', () => {
    const r = install({ scope: 'user', client: 'claude', cwd: base, dryRun: false, force: false, link: true, source })
    expect(r.ok).toBe(true)
    expect(r.items.every((i) => i.action === 'linked')).toBe(true)

    const skillLink = join(fakeHome, '.claude', 'skills', 'agy-ceiling')
    const commandLink = join(fakeHome, '.claude', 'commands', 'agy-ceiling.md')
    expect(lstatSync(skillLink).isSymbolicLink()).toBe(true)
    expect(lstatSync(commandLink).isSymbolicLink()).toBe(true)
    expect(readlinkSync(commandLink)).toBe(join(source, 'commands', 'agy-ceiling.md'))
  })

  it('--client combinations produce the right destination paths for both clients (Case 5)', () => {
    // 1. Claude only
    const claudeRun = install({ scope: 'user', client: 'claude', cwd: base, dryRun: false, force: false, source })
    expect(claudeRun.items.every((i) => i.client === 'claude')).toBe(true)
    expect(existsSync(join(fakeHome, '.claude', 'skills', 'agy-ceiling', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(fakeHome, '.claude', 'commands', 'agy-ceiling.md'))).toBe(true)

    // 2. Codex only in user scope
    const codexUser = install({ scope: 'user', client: 'codex', cwd: base, dryRun: false, force: false, source })
    expect(codexUser.items.every((i) => i.client === 'codex')).toBe(true)
    expect(existsSync(join(fakeCodexHome, 'skills', 'agy-ceiling', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(fakeCodexHome, 'prompts', 'agy-ceiling.md'))).toBe(true)

    // 3. Codex only in project scope: skill -> .agents/skills, prompt -> $CODEX_HOME/prompts
    const projectDir = join(base, 'proj')
    mkdirSync(projectDir, { recursive: true })
    const codexProject = install({ scope: 'project', client: 'codex', cwd: projectDir, dryRun: false, force: false, source })
    expect(codexProject.items.every((i) => i.client === 'codex')).toBe(true)
    expect(existsSync(join(projectDir, '.agents', 'skills', 'agy-ceiling', 'SKILL.md'))).toBe(true)
  })
})

describe('parseSetupArgs / destinationDir (Case 6: default scope user)', () => {
  it('defaults to user scope in home', () => {
    const p = parseSetupArgs([], '/w')
    expect(p.kind).toBe('run')
    if (p.kind === 'run') {
      expect(p.options.scope).toBe('user')
      expect(destinationDir(p.options)).toBe(join(fakeHome, '.claude'))
    }
  })

  it('accepts --scope project and resolves cwd', () => {
    const p = parseSetupArgs(['--scope', 'project'], '/w')
    expect(p.kind).toBe('run')
    if (p.kind === 'run') {
      expect(p.options.scope).toBe('project')
      expect(destinationDir(p.options)).toBe('/w/.claude')
    }
  })

  it('accepts --client, --link, --dest, --dry-run, --force; rejects junk', () => {
    const p = parseSetupArgs(['--client', 'codex', '--link', '--dry-run', '--force'], '/w')
    expect(p.kind).toBe('run')
    if (p.kind === 'run') {
      expect(p.options.client).toBe('codex')
      expect(p.options.link).toBe(true)
      expect(p.options.dryRun).toBe(true)
      expect(p.options.force).toBe(true)
    }
    expect(parseSetupArgs(['--client=invalid']).kind).toBe('error')
    expect(parseSetupArgs(['--scope=nope']).kind).toBe('error')
    expect(parseSetupArgs(['--wat']).kind).toBe('error')
    expect(parseSetupArgs(['--help']).kind).toBe('help')
    expect(parseSetupArgs(['--doctor']).kind).toBe('doctor')
    const d = parseSetupArgs(['--dest=/x/.claude'])
    if (d.kind === 'run') expect(destinationDir(d.options)).toBe('/x/.claude')
  })
})
