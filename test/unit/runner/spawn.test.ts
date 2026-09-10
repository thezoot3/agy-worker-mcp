import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ValidationError } from '../../../src/contract/errors.js'
import { ensureJobDirs, ensureProjectDirs, jobPaths, projectPaths } from '../../../src/contract/paths.js'
import { FORBIDDEN_AGY_FLAGS, type EffectiveConfig } from '../../../src/contract/types.js'
import { buildAgyArgv, buildChildEnv, formatDuration, spawnAgyDetached } from '../../../src/runner/spawn.js'
import type { AgyArgvInput } from '../../../src/runner/spawn.js'

function baseInput(over: Partial<AgyArgvInput> = {}): AgyArgvInput {
  return {
    prompt: 'do the thing',
    addDirs: ['/abs/workspace'],
    outputFormat: 'stream-json',
    printTimeoutMs: 60_000,
    ...over,
  }
}

describe('buildAgyArgv — --print= must use the "=" form', () => {
  it('emits a single "--print=<prompt>" token, never a separate flag and value', () => {
    const argv = buildAgyArgv(baseInput({ prompt: 'hello world' }))
    expect(argv[0]).toBe('--print=hello world')
    // Never split into two argv entries — a bare --print swallows the next flag
    // as its prompt and exits 2.
    expect(argv).not.toContain('--print')
    expect(argv).not.toContain('-p')
  })

  it('an empty prompt is legal (used for stream-json input) and still uses "="', () => {
    const argv = buildAgyArgv(baseInput({ prompt: '' }))
    expect(argv[0]).toBe('--print=')
  })

  it('a prompt that itself starts with "--" cannot be mistaken for a flag', () => {
    const argv = buildAgyArgv(baseInput({ prompt: '--not-a-flag' }))
    expect(argv[0]).toBe('--print=--not-a-flag')
  })
})

describe('buildAgyArgv — --add-dir is always present, once per addDirs entry', () => {
  it('is included for every call with a valid workspace', () => {
    const argv = buildAgyArgv(baseInput({ addDirs: ['/abs/ws'] }))
    const idx = argv.indexOf('--add-dir')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(argv[idx + 1]).toBe('/abs/ws')
  })

  it('repeats --add-dir once per entry, in order', () => {
    const argv = buildAgyArgv(baseInput({ addDirs: ['/abs/ws', '/abs/extra1', '/abs/extra2'] }))
    const dirFlags = argv.reduce<number[]>((acc, tok, i) => {
      if (tok === '--add-dir') acc.push(i)
      return acc
    }, [])
    expect(dirFlags.length).toBe(3)
    expect(dirFlags.map((i) => argv[i + 1])).toEqual(['/abs/ws', '/abs/extra1', '/abs/extra2'])
  })

  it('dedupes repeated entries, preserving first-occurrence order', () => {
    const argv = buildAgyArgv(baseInput({ addDirs: ['/abs/ws', '/abs/extra', '/abs/ws', '/abs/extra'] }))
    const dirs = argv.reduce<string[]>((acc, tok, i) => {
      if (tok === '--add-dir') acc.push(argv[i + 1] as string)
      return acc
    }, [])
    expect(dirs).toEqual(['/abs/ws', '/abs/extra'])
  })

  it('throws ValidationError when addDirs is empty — never spawns workspace-less', () => {
    expect(() => buildAgyArgv(baseInput({ addDirs: [] }))).toThrow(ValidationError)
  })

  it('throws ValidationError when the first (workspace) element is not a non-empty absolute path', () => {
    expect(() => buildAgyArgv(baseInput({ addDirs: [''] }))).toThrow(ValidationError)
    expect(() => buildAgyArgv(baseInput({ addDirs: ['   '] }))).toThrow(ValidationError)
    expect(() => buildAgyArgv(baseInput({ addDirs: ['relative/path'] }))).toThrow(ValidationError)
  })

  it('throws ValidationError when a later element is not a non-empty absolute path', () => {
    expect(() => buildAgyArgv(baseInput({ addDirs: ['/abs/ws', 'relative'] }))).toThrow(ValidationError)
    expect(() => buildAgyArgv(baseInput({ addDirs: ['/abs/ws', ''] }))).toThrow(ValidationError)
  })
})

describe('buildAgyArgv — stream-json input and a command-line prompt are exclusive', () => {
  it('rejects a non-empty prompt when inputFormat is stream-json', () => {
    // agy 1.1.23 refuses this itself: "--input-format stream-json reads prompts
    // from stdin, so a prompt given on the command line would be ignored".
    // Building it is a bug, so it cannot be built.
    expect(() => buildAgyArgv(baseInput({ inputFormat: 'stream-json', prompt: 'hi' }))).toThrow(ValidationError)
  })

  it('accepts the empty prompt that pairs with stdin turns', () => {
    const argv = buildAgyArgv(baseInput({ inputFormat: 'stream-json', prompt: '' }))
    expect(argv[0]).toBe('--print=')
    expect(argv).toContain('--input-format')
  })
})

describe('buildAgyArgv — forbidden flags never appear', () => {
  it('the built argv never contains any FORBIDDEN_AGY_FLAGS entry, across option combinations', () => {
    const variants: Partial<AgyArgvInput>[] = [
      {},
      { model: 'gemini-3.7-flash-low', effort: 'high', mode: 'accept-edits' },
      { conversationId: 'conv-123' },
      { inputFormat: 'stream-json', prompt: '' }, // stream-json input forbids a command-line prompt
      { jsonSchemaPath: '/abs/schema.json' },
      { prompt: '--continue please' }, // even inside the prompt text this is one token
    ]
    for (const v of variants) {
      const argv = buildAgyArgv(baseInput(v))
      for (const forbidden of FORBIDDEN_AGY_FLAGS) {
        expect(argv).not.toContain(forbidden)
      }
    }
  })

  it('embedding forbidden text inside the prompt does not split into a separate forbidden argv entry', () => {
    const argv = buildAgyArgv(baseInput({ prompt: '--continue' }))
    expect(argv[0]).toBe('--print=--continue')
    expect(argv).not.toContain('--continue')
  })
})

describe('buildAgyArgv — agy\'s own approval engine is switched off (0.2.0 PR5, M3)', () => {
  it('emits --dangerously-skip-permissions exactly once, right after the --add-dir entries', () => {
    const argv = buildAgyArgv(baseInput({ addDirs: ['/ws', '/extra'] }))
    const occurrences = argv.filter((a) => a === '--dangerously-skip-permissions')
    expect(occurrences).toHaveLength(1)
    const lastAddDirValue = argv.lastIndexOf('/extra')
    expect(argv[lastAddDirValue + 1]).toBe('--dangerously-skip-permissions')
  })

  it('is no longer a forbidden flag, while --continue still is', () => {
    expect(FORBIDDEN_AGY_FLAGS).not.toContain('--dangerously-skip-permissions')
    expect(FORBIDDEN_AGY_FLAGS).toContain('--continue')
    expect(() => buildAgyArgv(baseInput({ model: '--continue=1' }))).toThrow()
  })
})

describe('buildAgyArgv — --sandbox is never emitted', () => {
  it('is absent from the argv (measured no-op in print mode, M4/M3) — there is no `sandbox` option any more', () => {
    const argv = buildAgyArgv(baseInput())
    expect(argv).not.toContain('--sandbox')
  })
})

describe('buildAgyArgv — other flags', () => {
  it('emits --conversation only when resuming', () => {
    const withConv = buildAgyArgv(baseInput({ conversationId: 'c-1' }))
    expect(withConv).toContain('--conversation')
    expect(withConv[withConv.indexOf('--conversation') + 1]).toBe('c-1')

    const withoutConv = buildAgyArgv(baseInput({ conversationId: null }))
    expect(withoutConv).not.toContain('--conversation')
  })

  it('emits --print-timeout using Go duration syntax', () => {
    const argv = buildAgyArgv(baseInput({ printTimeoutMs: 90_000 }))
    const idx = argv.indexOf('--print-timeout')
    expect(argv[idx + 1]).toBe('1m30s')
  })
})

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [1000, '1s'],
    [60_000, '1m0s'],
    [90_000, '1m30s'],
    [3_600_000, '1h0m0s'],
    [3_661_000, '1h1m1s'],
    [500, '0.5s'],
  ])('%i ms -> %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })

  it('rejects negative durations', () => {
    expect(() => formatDuration(-1)).toThrow(ValidationError)
  })
})

describe('buildChildEnv', () => {
  it('only allowlisted keys survive, nothing else from the parent env leaks through', () => {
    const env = buildChildEnv({
      PATH: '/usr/bin',
      HOME: '/home/x',
      SECRET_TOKEN: 'do-not-leak',
      AWS_SECRET_ACCESS_KEY: 'do-not-leak-either',
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/x')
    expect(env.SECRET_TOKEN).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
  })
})

describe('file and directory permission hygiene (0o600 / 0o700)', () => {
  it('creates job dirs with 0o700 and job files with 0o600', () => {
    if (process.platform === 'win32') return
    const tmp = mkdtempSync(join(tmpdir(), 'agy-perm-test-'))
    try {
      const proj = projectPaths(tmp)
      ensureProjectDirs(proj)
      expect(statSync(proj.dir).mode & 0o777).toBe(0o700)
      expect(statSync(proj.jobsDir).mode & 0o777).toBe(0o700)

      const paths = jobPaths(proj, 'test-job')
      ensureJobDirs(paths)
      expect(statSync(paths.dir).mode & 0o777).toBe(0o700)

      const dummyConfig = {
        agy_bin: process.execPath,
        argv: ['-e', 'process.exit(0)'],
        cwd: tmp,
        env: {},
      } as unknown as EffectiveConfig

      const res = spawnAgyDetached({
        config: dummyConfig,
        paths,
        stdinPipe: false,
      })

      expect(statSync(paths.events).mode & 0o777).toBe(0o600)
      expect(statSync(paths.stderr).mode & 0o777).toBe(0o600)

      res.child.kill()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

