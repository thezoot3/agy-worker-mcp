/**
 * Unit tests for `src/gate/hooks-file.ts`.
 *
 * Pins the lifecycle of `<workspace>/.agents/hooks.json`. Verifies that `ensureGateHook`
 * reliably installs our PreToolUse gate hook ahead of all user hooks, correctly quotes
 * paths, preserves user entries, and behaves idempotently. Verifies that `removeGateHook`
 * removes only our hook, preserves other keys, cleans up empty `.agents` directories,
 * and handles missing files silently.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ensureGateHook,
  GATE_HOOK_KEY,
  hooksFilePath,
  removeGateHook,
} from '../../../src/gate/hooks-file.js'

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'agy-hooks-test-'))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('hooksFilePath', () => {
  it('returns join(workspace, ".agents", "hooks.json")', () => {
    expect(hooksFilePath(workspace)).toBe(join(workspace, '.agents', 'hooks.json'))
  })
})

describe('ensureGateHook', () => {
  it('creates .agents/hooks.json and adds our gate entry', () => {
    const gatePath = '/path/to/gate.js'
    ensureGateHook(workspace, gatePath)

    const filePath = hooksFilePath(workspace)
    expect(existsSync(filePath)).toBe(true)

    const content = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(content).toHaveProperty(GATE_HOOK_KEY)
    expect(content[GATE_HOOK_KEY]).toEqual({
      PreToolUse: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: "node '/path/to/gate.js'", timeout: 15 }],
        },
      ],
    })
  })

  it('correctly single-quotes paths containing spaces and embedded single quotes', () => {
    const gatePath = "/path with spaces/and 'single quotes'/gate.js"
    ensureGateHook(workspace, gatePath)

    const filePath = hooksFilePath(workspace)
    const content = JSON.parse(readFileSync(filePath, 'utf8'))
    const expectedCommand = "node '/path with spaces/and '\\''single quotes'\\''/gate.js'"
    expect(content[GATE_HOOK_KEY].PreToolUse[0].hooks[0].command).toBe(expectedCommand)
  })

  it('preserves existing user hooks in hooks.json', () => {
    const filePath = hooksFilePath(workspace)
    mkdirSync(join(workspace, '.agents'), { recursive: true })
    const userHooks = {
      my_custom_hook: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
      },
    }
    writeFileSync(filePath, JSON.stringify(userHooks, null, 2), 'utf8')

    ensureGateHook(workspace, '/path/gate.js')

    const content = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(content).toHaveProperty(GATE_HOOK_KEY)
    expect(content).toHaveProperty('my_custom_hook')
    expect(content.my_custom_hook).toEqual(userHooks.my_custom_hook)
  })

  it('writes GATE_HOOK_KEY first in key order ahead of pre-existing keys', () => {
    const filePath = hooksFilePath(workspace)
    mkdirSync(join(workspace, '.agents'), { recursive: true })
    writeFileSync(
      filePath,
      JSON.stringify({ user_first: { foo: 'bar' }, user_second: { baz: 'qux' } }),
      'utf8',
    )

    ensureGateHook(workspace, '/path/gate.js')

    const content = JSON.parse(readFileSync(filePath, 'utf8'))
    const keys = Object.keys(content)
    expect(keys[0]).toBe(GATE_HOOK_KEY)
    expect(keys).toContain('user_first')
    expect(keys).toContain('user_second')
  })

  it('is idempotent: repeated calls do not duplicate entries and update gatePath', () => {
    ensureGateHook(workspace, '/first/gate.js')
    ensureGateHook(workspace, '/second/gate.js')

    const filePath = hooksFilePath(workspace)
    const content = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(Object.keys(content).filter((k) => k === GATE_HOOK_KEY)).toHaveLength(1)
    expect(content[GATE_HOOK_KEY].PreToolUse[0].hooks[0].command).toBe("node '/second/gate.js'")
  })
})

describe('removeGateHook', () => {
  it('silently passes when hooks.json does not exist', () => {
    expect(() => removeGateHook(workspace)).not.toThrow()
    expect(existsSync(hooksFilePath(workspace))).toBe(false)
  })

  it('silently passes and leaves file intact when hooks.json does not contain GATE_HOOK_KEY', () => {
    const filePath = hooksFilePath(workspace)
    mkdirSync(join(workspace, '.agents'), { recursive: true })
    const userOnly = { user_hook: { foo: 'bar' } }
    writeFileSync(filePath, JSON.stringify(userOnly), 'utf8')

    removeGateHook(workspace)

    expect(existsSync(filePath)).toBe(true)
    const content = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(content).toEqual(userOnly)
  })

  it('removes only GATE_HOOK_KEY and keeps user hooks intact when user hooks remain', () => {
    const filePath = hooksFilePath(workspace)
    mkdirSync(join(workspace, '.agents'), { recursive: true })
    const initial = {
      user_hook: { action: 'audit' },
    }
    writeFileSync(filePath, JSON.stringify(initial), 'utf8')

    ensureGateHook(workspace, '/path/gate.js')
    removeGateHook(workspace)

    expect(existsSync(filePath)).toBe(true)
    const content = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(content).not.toHaveProperty(GATE_HOOK_KEY)
    expect(content).toHaveProperty('user_hook')
    expect(content.user_hook).toEqual(initial.user_hook)
  })

  it('deletes hooks.json and removes .agents directory when GATE_HOOK_KEY was the only entry', () => {
    ensureGateHook(workspace, '/path/gate.js')
    expect(existsSync(hooksFilePath(workspace))).toBe(true)

    removeGateHook(workspace)

    expect(existsSync(hooksFilePath(workspace))).toBe(false)
    expect(existsSync(join(workspace, '.agents'))).toBe(false)
  })

  it('deletes hooks.json but keeps .agents directory if other files exist in .agents', () => {
    ensureGateHook(workspace, '/path/gate.js')
    const otherFile = join(workspace, '.agents', 'other.txt')
    writeFileSync(otherFile, 'hello', 'utf8')

    removeGateHook(workspace)

    expect(existsSync(hooksFilePath(workspace))).toBe(false)
    expect(existsSync(join(workspace, '.agents'))).toBe(true)
    expect(existsSync(otherFile)).toBe(true)
  })
})

