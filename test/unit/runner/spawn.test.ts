import { describe, expect, it } from 'vitest'

import { ValidationError } from '../../../src/contract/errors.js'
import { FORBIDDEN_AGY_FLAGS } from '../../../src/contract/types.js'
import { buildAgyArgv, buildChildEnv, formatDuration } from '../../../src/runner/spawn.js'
import type { AgyArgvInput } from '../../../src/runner/spawn.js'

function baseInput(over: Partial<AgyArgvInput> = {}): AgyArgvInput {
  return {
    prompt: 'do the thing',
    addDir: '/abs/workspace',
    sandbox: true,
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
    // as its prompt and exits 2 (docs/02 §2).
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

describe('buildAgyArgv — --add-dir is always present', () => {
  it('is included for every call with a valid workspace', () => {
    const argv = buildAgyArgv(baseInput({ addDir: '/abs/ws' }))
    const idx = argv.indexOf('--add-dir')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(argv[idx + 1]).toBe('/abs/ws')
  })

  it('throws ValidationError when addDir is empty — never spawns workspace-less', () => {
    expect(() => buildAgyArgv(baseInput({ addDir: '' }))).toThrow(ValidationError)
  })

  it('throws ValidationError when addDir is only whitespace', () => {
    expect(() => buildAgyArgv(baseInput({ addDir: '   ' }))).toThrow(ValidationError)
  })
})

describe('buildAgyArgv — stream-json input and a command-line prompt are exclusive', () => {
  it('rejects a non-empty prompt when inputFormat is stream-json', () => {
    // agy 1.1.23 refuses this itself: "--input-format stream-json reads prompts
    // from stdin, so a prompt given on the command line would be ignored"
    // (docs/02 §2). Building it is a bug, so it cannot be built.
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
    const argv = buildAgyArgv(baseInput({ prompt: '--dangerously-skip-permissions' }))
    expect(argv[0]).toBe('--print=--dangerously-skip-permissions')
    expect(argv).not.toContain('--dangerously-skip-permissions')
  })
})

describe('buildAgyArgv — other flags', () => {
  it('emits --sandbox as a bare flag when requested, omits it otherwise', () => {
    expect(buildAgyArgv(baseInput({ sandbox: true }))).toContain('--sandbox')
    expect(buildAgyArgv(baseInput({ sandbox: false }))).not.toContain('--sandbox')
  })

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
