/**
 * Coverage for the fake-agy behaviour (PR1) added
 * on top of the M1-M6 measurements:
 * hook-group short-circuit semantics (M6) and the `run_command` BypassSandbox
 * simulation (M3/M4/M1). `golden.test.ts` covers shape-drift against the real
 * binary's raw captures; this file covers the fake's own new logic instead.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE = join(HERE, 'agy.mjs')

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'agy-fake-ws-'))
}

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

function runFake(
  args: string[],
  opts: { cwd: string; scenario?: string; env?: Record<string, string> },
): Run {
  const res = spawnSync(process.execPath, [FAKE, ...args], {
    cwd: opts.cwd,
    encoding: 'utf8',
    input: '',
    env: {
      ...process.env,
      ...(opts.scenario ? { AGY_FAKE_SCENARIO: opts.scenario } : {}),
      AGY_FAKE_STATE_DIR: join(opts.cwd, '.fake-state'),
      ...opts.env,
    },
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

function baseArgs(ws: string, extra: string[] = []): string[] {
  return [
    '--print=structural fidelity check',
    '--add-dir',
    ws,
    ...extra,
    '--model',
    'gemini-3.7-flash-low',
    '--output-format',
    'stream-json',
  ]
}

function toolSteps(stdout: string): any[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l: any) => l.event === 'step_update' && l.step_update.step_type === 'tool')
    .map((l: any) => l.step_update)
}

/** Installs one named PreToolUse hook group that always emits `decision` (plus `overwrite`/`reason`). */
function installHookGroup(
  ws: string,
  groupName: string,
  scriptName: string,
  decision: Record<string, unknown>,
  marker?: string,
): void {
  const agents = join(ws, '.agents')
  mkdirSync(agents, { recursive: true })
  const script = join(agents, scriptName)
  const markerLine = marker ? `echo ${marker} >> "${join(agents, 'called.log')}"\n` : ''
  writeFileSync(
    script,
    `#!/bin/sh\ncat >/dev/null\n${markerLine}printf '${JSON.stringify(decision).replace(/'/g, "'\\''")}'\n`,
    { mode: 0o755 },
  )

  const hooksFile = join(agents, 'hooks.json')
  const existing = existsSync(hooksFile) ? JSON.parse(readFileSync(hooksFile, 'utf8')) : {}
  existing[groupName] = {
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `./${scriptName}`, timeout: 15 }] }],
  }
  writeFileSync(hooksFile, JSON.stringify(existing))
}

function calledMarkers(ws: string): string[] {
  const log = join(ws, '.agents', 'called.log')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').split('\n').filter(Boolean)
}

// ─────────────────────────────────────────────────────────────────────────────

describe('M6: sequential hook groups, deny short-circuits, allow does not', () => {
  it('a deny from the first-declared group short-circuits — the later group never runs', () => {
    const ws = workspace()
    installHookGroup(ws, 'aaa', 'aaa.sh', { decision: 'deny', reason: 'denied-by-aaa' }, 'aaa')
    installHookGroup(ws, 'zzz', 'zzz.sh', { decision: 'allow' }, 'zzz')

    const run = runFake(baseArgs(ws), { cwd: ws, scenario: 'happy' })
    expect(run.status).toBe(0)

    const [tool] = toolSteps(run.stdout).filter((s) => s.state === 'ERROR')
    expect(tool.tool_info.error.message).toBe('tool call denied by pre-tool hook: denied-by-aaa')
    expect(calledMarkers(ws)).toEqual(['aaa']) // zzz never ran
  })

  it('an allow from the first group does not short-circuit — a later deny still wins', () => {
    const ws = workspace()
    installHookGroup(ws, 'aaa', 'aaa.sh', { decision: 'allow' }, 'aaa')
    installHookGroup(ws, 'zzz', 'zzz.sh', { decision: 'deny', reason: 'denied-by-zzz' }, 'zzz')

    const run = runFake(baseArgs(ws), { cwd: ws, scenario: 'happy' })
    expect(run.status).toBe(0)

    const [tool] = toolSteps(run.stdout).filter((s) => s.state === 'ERROR')
    expect(tool.tool_info.error.message).toBe('tool call denied by pre-tool hook: denied-by-zzz')
    expect(calledMarkers(ws)).toEqual(['aaa', 'zzz']) // both ran, in declaration order
  })
})

describe('run_command BypassSandbox simulation', () => {
  it('overwrite.BypassSandbox:false blocks a path outside every --add-dir root (M3-A)', () => {
    const ws = workspace()
    installHookGroup(ws, 'g', 'gate.sh', { decision: 'allow', overwrite: { BypassSandbox: false } })

    const run = runFake(baseArgs(ws), { cwd: ws, scenario: 'sandbox-escape' })
    expect(run.status).toBe(0)

    const tool = toolSteps(run.stdout).at(-1)!
    // Not a tool error: the step completes DONE, only the shell output reveals the block.
    expect(tool.state).toBe('DONE')
    expect(tool.tool_info.output).toMatch(/^ls: .*\.jdks: Operation not permitted\n$/)

    const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!)
    expect(result.result.status).toBe('SUCCESS')
  })

  it('overwrite.BypassSandbox:true runs normally regardless of the escaping path (M3-B)', () => {
    const ws = workspace()
    installHookGroup(ws, 'g', 'gate.sh', { decision: 'allow', overwrite: { BypassSandbox: true } })

    const run = runFake(baseArgs(ws), { cwd: ws, scenario: 'sandbox-escape' })
    expect(run.status).toBe(0)

    const tool = toolSteps(run.stdout).at(-1)!
    expect(tool.state).toBe('DONE')
    expect(tool.tool_info.output).not.toContain('Operation not permitted')
  })

  it('no overwrite + model BypassSandbox:true without --dangerously-skip-permissions hits the engine denial (M1/M3-C)', () => {
    const ws = workspace()
    installHookGroup(ws, 'g', 'gate.sh', { decision: 'allow' })

    const run = runFake(baseArgs(ws), { cwd: ws, scenario: 'sandbox-escape' })
    expect(run.status).toBe(0)

    const tool = toolSteps(run.stdout).at(-1)!
    expect(tool.state).toBe('ERROR')
    expect(tool.tool_info.error.message).toContain('user denied permission to run command')
    expect(tool.tool_info.error.message).toContain('permission check failed for unsandboxed')
  })

  it('no overwrite + model BypassSandbox:true WITH --dangerously-skip-permissions runs normally (M3-C)', () => {
    const ws = workspace()
    installHookGroup(ws, 'g', 'gate.sh', { decision: 'allow' })

    const run = runFake(baseArgs(ws, ['--dangerously-skip-permissions']), {
      cwd: ws,
      scenario: 'sandbox-escape',
    })
    expect(run.status).toBe(0)

    const tool = toolSteps(run.stdout).at(-1)!
    expect(tool.state).toBe('DONE')
  })

  it('overwrite.BypassSandbox:false blocks an in-workspace shell write (M7)', () => {
    const ws = workspace()
    installHookGroup(ws, 'g', 'gate.sh', { decision: 'allow', overwrite: { BypassSandbox: false } })
    const scenarioFile = join(ws, 'write-scenario.json')
    writeFileSync(
      scenarioFile,
      JSON.stringify({
        name: 'write-scenario',
        turns: [
          {
            steps: [
              {
                type: 'tool',
                tool_name: 'run_command',
                parameters: { CommandLine: 'touch out.txt' },
                duration_seconds: 0.06,
                output: 'ok\n',
              },
            ],
            status: 'SUCCESS',
          },
        ],
      }),
    )

    const run = runFake(baseArgs(ws), { cwd: ws, scenario: scenarioFile })
    expect(run.status).toBe(0)

    const tool = toolSteps(run.stdout).at(-1)!
    expect(tool.state).toBe('DONE')
    expect(tool.tool_info.output).toContain('Operation not permitted')
  })

  it('overwrite.BypassSandbox:true allows an in-workspace shell write (M7)', () => {
    const ws = workspace()
    installHookGroup(ws, 'g', 'gate.sh', { decision: 'allow', overwrite: { BypassSandbox: true } })
    const scenarioFile = join(ws, 'write-scenario.json')
    writeFileSync(
      scenarioFile,
      JSON.stringify({
        name: 'write-scenario',
        turns: [
          {
            steps: [
              {
                type: 'tool',
                tool_name: 'run_command',
                parameters: { CommandLine: 'touch out.txt' },
                duration_seconds: 0.06,
                output: 'ok\n',
              },
            ],
            status: 'SUCCESS',
          },
        ],
      }),
    )

    const run = runFake(baseArgs(ws), { cwd: ws, scenario: scenarioFile })
    expect(run.status).toBe(0)

    const tool = toolSteps(run.stdout).at(-1)!
    expect(tool.state).toBe('DONE')
    expect(tool.tool_info.output).toBe('ok\n')
  })
})

describe('M2: subagent tool calls arrive under a different conversationId', () => {
  it('subagent-bypass: the nested run_command carries a conversationId distinct from the parent', () => {
    const ws = workspace()
    const run = runFake(baseArgs(ws), { cwd: ws, scenario: 'subagent-bypass' })
    expect(run.status).toBe(0)

    const lines = run.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const init = lines[0]
    const parentConversationId = init.conversation_id as string
    expect(typeof parentConversationId).toBe('string')

    const tools = toolSteps(run.stdout)
    const invoke = tools.find((t) => t.tool_name === 'invoke_subagent')!
    const nestedRunCommand = tools.find(
      (t) => t.tool_name === 'run_command' && t.conversation_id !== parentConversationId,
    )

    expect(invoke.conversation_id).toBe(parentConversationId)
    expect(nestedRunCommand).toBeDefined()
    expect(nestedRunCommand!.conversation_id).not.toBe(parentConversationId)
  })
})

describe('AGY_FAKE_SKIP_HOOKS', () => {
  it('skips loading hooks.json even though --add-dir is present', () => {
    const ws = workspace()
    // A deny-everything hook that would fail the run if it were ever consulted.
    installHookGroup(ws, 'g', 'gate.sh', { decision: 'deny', reason: 'should not be reached' })

    const run = runFake(baseArgs(ws), {
      cwd: ws,
      scenario: 'hook-missing',
      env: { AGY_FAKE_SKIP_HOOKS: '1' },
    })
    expect(run.status).toBe(0)
    expect(run.stdout).not.toContain('"state":"ERROR"')
  })
})
