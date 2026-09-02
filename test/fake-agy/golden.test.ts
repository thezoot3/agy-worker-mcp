/**
 * Contract drift guard for the fake agy.
 *
 * `test/fixtures/agy-1.1.23/*.events.ndjson` are raw output from the real `agy`
 * 1.1.23 (only the local workspace path was rewritten). If the fake ever stops
 * producing the same *shape* — same event order, same field sets, same types —
 * then every test built
 * on it is testing a fiction, and the failure would only surface against the real
 * binary. Values are free to differ; structure is not.
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const FAKE = join(HERE, 'agy.mjs')

const FIXTURES = join(REPO, 'test', 'fixtures', 'agy-1.1.23')

const GOLDEN = {
  happy: join(FIXTURES, 'happy.events.ndjson'),
  'hook-denied': join(FIXTURES, 'hook-denied.events.ndjson'),
} as const

const tempDirs: string[] = []

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-fake-ws-'))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  // Left in place on purpose when a test fails; the OS reclaims tmpdir anyway.
})

// ─────────────────────────────────────────────────────────────────────────────
// structural signature
// ─────────────────────────────────────────────────────────────────────────────

function typeName(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

/**
 * Flatten a value into sorted `path:type` leaves.
 *
 * An array collapses to its element type rather than its length, so a 57-tool
 * list and a 3-tool list compare equal while a list of objects never matches a
 * list of strings.
 */
function leaves(value: unknown, prefix: string, acc: string[]): void {
  const t = typeName(value)
  if (t === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    if (keys.length === 0) acc.push(`${prefix}:object{}`)
    for (const k of keys) leaves(obj[k], prefix ? `${prefix}.${k}` : k, acc)
    return
  }
  if (t === 'array') {
    const arr = value as unknown[]
    if (arr.length === 0) {
      acc.push(`${prefix}[]:empty`)
      return
    }
    acc.push(`${prefix}[]:${typeName(arr[0])}`)
    if (typeName(arr[0]) === 'object') leaves(arr[0], `${prefix}[]`, acc)
    return
  }
  acc.push(`${prefix}:${t}`)
}

/** One comparable string per NDJSON line. */
function lineShape(raw: string): string {
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const acc: string[] = []
  leaves(parsed, '', acc)
  return acc.sort().join(' | ')
}

function shapesOf(ndjson: string): string[] {
  return ndjson
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map(lineShape)
}

function eventNames(ndjson: string): string[] {
  return ndjson
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => (JSON.parse(l) as { event: string }).event)
}

// ─────────────────────────────────────────────────────────────────────────────
// running the fake
// ─────────────────────────────────────────────────────────────────────────────

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

function runFake(args: string[], opts: { cwd: string; scenario?: string; input?: string }): Run {
  const res = spawnSync(process.execPath, [FAKE, ...args], {
    cwd: opts.cwd,
    encoding: 'utf8',
    input: opts.input ?? '',
    env: {
      ...process.env,
      ...(opts.scenario ? { AGY_FAKE_SCENARIO: opts.scenario } : {}),
      AGY_FAKE_STATE_DIR: join(opts.cwd, '.fake-state'),
    },
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/**
 * Install a PreToolUse hook that denies one command and allows everything else.
 * The hook-denied scenario has no built-in denial: the refusal has to come from a
 * real hook invocation, because that is the code path under test.
 */
function installGate(ws: string, denySubstring: string, reason: string): void {
  const agents = join(ws, '.agents')
  mkdirSync(agents, { recursive: true })
  const script = join(agents, 'gate.sh')
  writeFileSync(
    script,
    `#!/bin/sh
IN=$(cat)
case "$IN" in
  *${denySubstring}*) printf '{"decision":"deny","reason":"${reason}"}' ;;
  *) printf '{"decision":"allow"}' ;;
esac
`,
    { mode: 0o755 },
  )
  chmodSync(script, 0o755)
  writeFileSync(
    join(agents, 'hooks.json'),
    JSON.stringify({
      'agy-worker-gate': {
        PreToolUse: [
          { matcher: '*', hooks: [{ type: 'command', command: './gate.sh', timeout: 15 }] },
        ],
      },
    }),
  )
}

const BASE_ARGS = (ws: string) => [
  `--print=structural fidelity check`,
  '--add-dir',
  ws,
  '--sandbox',
  '--model',
  'gemini-3.7-flash-low',
  '--output-format',
  'stream-json',
  '--print-timeout',
  '60m',
]

// ─────────────────────────────────────────────────────────────────────────────

describe('fake agy matches the recorded shape of the real agy', () => {
  it('happy is structurally identical to run1', () => {
    const ws = workspace()
    const run = runFake(BASE_ARGS(ws), { cwd: ws, scenario: 'happy' })

    expect(run.status).toBe(0)
    expect(run.stderr).toBe('')

    const golden = readFileSync(GOLDEN.happy, 'utf8')
    expect(eventNames(run.stdout)).toEqual(eventNames(golden))
    expect(shapesOf(run.stdout)).toEqual(shapesOf(golden))
  })

  it('hook-denied is structurally identical to run6', () => {
    const ws = workspace()
    installGate(
      ws,
      'forbidden-marker',
      'agy-worker policy: command not in profile allowlist (required rule: command(echo forbidden-marker))',
    )
    const run = runFake(BASE_ARGS(ws), { cwd: ws, scenario: 'hook-denied' })

    expect(run.status).toBe(0)

    const golden = readFileSync(GOLDEN['hook-denied'], 'utf8')
    expect(eventNames(run.stdout)).toEqual(eventNames(golden))
    expect(shapesOf(run.stdout)).toEqual(shapesOf(golden))
  })
})

describe('invariants the rest of the system relies on', () => {
  it('init is the first line and carries conversation_id on the envelope', () => {
    const ws = workspace()
    const run = runFake(BASE_ARGS(ws), { cwd: ws, scenario: 'happy' })
    const first = JSON.parse(run.stdout.split('\n')[0]!) as Record<string, unknown>

    expect(first.event).toBe('init')
    // The gate binds a job by reading only this line, before any tool runs.
    expect(typeof first.conversation_id).toBe('string')
    const init = first.init as Record<string, unknown>
    expect(Object.keys(init).sort()).toEqual(['cwd', 'model', 'permission_mode', 'tools'])
    expect(init.conversation_id).toBeUndefined()
  })

  it('emits exactly one result per turn', () => {
    const ws = workspace()
    const run = runFake(BASE_ARGS(ws), { cwd: ws, scenario: 'happy' })
    expect(eventNames(run.stdout).filter((e) => e === 'result')).toHaveLength(1)
  })

  it('a denied tool call is exit 0 with status SUCCESS — only the step reveals it', () => {
    const ws = workspace()
    installGate(ws, 'forbidden-marker', 'denied for the test')
    const run = runFake(BASE_ARGS(ws), { cwd: ws, scenario: 'hook-denied' })

    // This is the whole reason the broker cannot trust agy's self-report.
    expect(run.status).toBe(0)
    expect(run.stderr).toBe('')

    const lines = run.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const result = lines.at(-1) as { result: { status: string } }
    expect(result.result.status).toBe('SUCCESS')

    const errored = lines.filter(
      (l: any) => l.event === 'step_update' && l.step_update.state === 'ERROR',
    )
    expect(errored).toHaveLength(1)
    expect(errored[0].step_update.step_type).toBe('tool')
    expect(errored[0].step_update.tool_info.error.message).toContain(
      'tool call denied by pre-tool hook:',
    )
    expect(errored[0].step_update.tool_info.output).toBeUndefined()
  })
})

describe('hook contract', () => {
  it('an empty object {} is a DENIAL, not a pass-through', () => {
    // docs/02 §9. Getting this backwards would break every interactive agy
    // session on the machine, so the fake has to reproduce it exactly.
    const ws = workspace()
    const agents = join(ws, '.agents')
    mkdirSync(agents, { recursive: true })
    writeFileSync(join(agents, 'gate.sh'), "#!/bin/sh\ncat >/dev/null\nprintf '{}'\n", {
      mode: 0o755,
    })
    writeFileSync(
      join(agents, 'hooks.json'),
      JSON.stringify({
        g: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: './gate.sh' }] }] },
      }),
    )

    const run = runFake(BASE_ARGS(ws), { cwd: ws, scenario: 'happy' })
    const errored = run.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l: any) => l.event === 'step_update' && l.step_update.state === 'ERROR')

    expect(errored).toHaveLength(1)
    // Measured: the message ends right after the colon, with no reason.
    expect(errored[0].step_update.tool_info.error.message).toBe(
      'tool call denied by pre-tool hook:',
    )
  })

  it('"ask" passes through to the built-in engine', () => {
    const ws = workspace()
    const agents = join(ws, '.agents')
    mkdirSync(agents, { recursive: true })
    writeFileSync(
      join(agents, 'gate.sh'),
      "#!/bin/sh\ncat >/dev/null\nprintf '{\"decision\":\"ask\",\"reason\":\"not ours\"}'\n",
      { mode: 0o755 },
    )
    writeFileSync(
      join(agents, 'hooks.json'),
      JSON.stringify({
        g: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: './gate.sh' }] }] },
      }),
    )

    const run = runFake(BASE_ARGS(ws), { cwd: ws, scenario: 'happy' })
    expect(run.stdout).not.toContain('"state":"ERROR"')
  })

  it('workspace hooks load only when --add-dir is given', () => {
    // docs/02 §3: without --add-dir the workspace is never registered, so
    // <ws>/.agents/hooks.json is not consulted at all.
    const ws = workspace()
    installGate(ws, 'print(41+1)', 'should not be reached')

    const withAddDir = runFake(BASE_ARGS(ws), { cwd: ws, scenario: 'happy' })
    expect(withAddDir.stdout).toContain('"state":"ERROR"')

    const withoutAddDir = runFake(
      ['--print=no workspace', '--sandbox', '--output-format', 'stream-json'],
      { cwd: ws, scenario: 'happy' },
    )
    expect(withoutAddDir.stdout).not.toContain('"state":"ERROR"')
  })
})

describe('argv contract', () => {
  it('a bare --print swallows the next flag and exits 2', () => {
    const ws = workspace()
    const run = runFake(['--print', '--model', 'x', '--output-format', 'stream-json'], { cwd: ws })

    expect(run.status).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain(
      'Error: --print took "--model" as its prompt, so the intended prompt was left as an argument and ignored.',
    )
    expect(run.stderr).toContain("Attach the prompt to the flag (--print='your prompt')")
  })

  it('the short alias reports itself, not --print', () => {
    const ws = workspace()
    const run = runFake(['-p', '--input-format', 'stream-json'], { cwd: ws })
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('Error: -p took "--input-format" as its prompt')
  })

  it('a trailing --print prints usage and exits 2', () => {
    const ws = workspace()
    const run = runFake(['--print'], { cwd: ws })
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('flag needs an argument: -print')
    expect(run.stderr).toContain('Usage of agy:')
  })

  it('--print= with an empty value is legal (stream-json input uses it)', () => {
    const ws = workspace()
    const run = runFake(
      ['--print=', '--add-dir', ws, '--input-format', 'stream-json', '--output-format', 'stream-json'],
      {
        cwd: ws,
        scenario: 'happy',
        input:
          JSON.stringify({
            event: 'user',
            message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          }) + '\n',
      },
    )
    expect(run.status).toBe(0)
    expect(eventNames(run.stdout)).toEqual(eventNames(readFileSync(GOLDEN.happy, 'utf8')))
  })
})

describe('stream-json input contract', () => {
  const streamArgs = (ws: string) => [
    '--print=',
    '--add-dir',
    ws,
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
  ]

  it('one line is one turn, and num_turns increases', () => {
    const ws = workspace()
    const line = (t: string) =>
      JSON.stringify({
        event: 'user',
        message: { role: 'user', content: [{ type: 'text', text: t }] },
      })
    const run = runFake(streamArgs(ws), {
      cwd: ws,
      scenario: 'happy',
      input: `${line('first')}\n${line('second')}\n`,
    })

    expect(run.status).toBe(0)
    const results = run.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l: any) => l.event === 'result')
      .map((l: any) => l.result.num_turns)
    expect(results).toEqual([1, 2])
  })

  it('resuming with --conversation continues num_turns', () => {
    const ws = workspace()
    const line = JSON.stringify({
      event: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'remember 7919' }] },
    })

    const first = runFake(streamArgs(ws), { cwd: ws, scenario: 'happy', input: `${line}\n` })
    const conversationId = (JSON.parse(first.stdout.split('\n')[0]!) as { conversation_id: string })
      .conversation_id

    const second = runFake([...streamArgs(ws), '--conversation', conversationId], {
      cwd: ws,
      scenario: 'happy',
      input: `${line}\n`,
    })

    const results = second.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l: any) => l.event === 'result')
    expect(results[0].result.num_turns).toBe(2)
    expect(results[0].result.conversation_id).toBe(conversationId)
    // step_index continues too, exactly as .spike/out/resume.out shows.
    const firstStep = second.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((l: any) => l.event === 'step_update')
    expect(firstStep.step_update.step_index).toBeGreaterThan(0)
  })

  it('a schema error emits a result with status ERROR and exits 1', () => {
    const ws = workspace()
    const run = runFake(streamArgs(ws), {
      cwd: ws,
      scenario: 'happy',
      input: JSON.stringify({ bogus: 1 }) + '\n',
    })

    // Measured in .spike/out/probeD: init, then result ERROR, exit 1.
    expect(run.status).toBe(1)
    const lines = run.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(lines.map((l: any) => l.event)).toEqual(['init', 'result'])
    expect(lines[1].result.status).toBe('ERROR')
    expect(lines[1].result.error).toBe('stream input message is missing the "event" field')
    expect(lines[1].result.num_turns).toBe(0)
  })

  it('a user message with no content is a schema error', () => {
    const ws = workspace()
    const run = runFake(streamArgs(ws), {
      cwd: ws,
      scenario: 'happy',
      input: JSON.stringify({ event: 'user', message: {} }) + '\n',
    })
    expect(run.status).toBe(1)
    const lines = run.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(lines[1].result.error).toBe('stream input "user" message has no content')
  })

  it('an unknown event is ignored, not fatal', () => {
    const ws = workspace()
    const run = runFake(streamArgs(ws), {
      cwd: ws,
      scenario: 'happy',
      input: JSON.stringify({ event: 'foo' }) + '\n',
    })
    expect(run.status).toBe(0)
    expect(run.stderr).toContain('ignoring unknown stream input message event')
    expect(eventNames(run.stdout)).toEqual(['init'])
  })
})
