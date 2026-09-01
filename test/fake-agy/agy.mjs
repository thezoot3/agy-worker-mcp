#!/usr/bin/env node
/**
 * Fake `agy`.
 *
 * Honours the same contract as the real binary so nothing in `src/` ever needs to
 * know which one it is talking to. Every behaviour here is transcribed from
 * `docs/02-agy-cli-findings.md` and the raw captures in `.spike/out/`:
 *
 *   §2  `--print` must use the `=` form; a bare one swallows the next flag (exit 2)
 *   §3  workspace hooks load only when `--add-dir` is given
 *   §4  `{"event": "init" | "step_update" | "result", ...}` envelopes, one per line
 *   §5  stream-json input, one line per turn, EOF ends the process
 *   §6  `num_turns` and `step_index` continue across a `--conversation` resume
 *   §8  output flushes incrementally even when redirected to a file
 *   §9  PreToolUse hooks, and `{}` means deny
 *
 * Deliberate deviations, both for safety:
 *   - the global `~/.gemini/config/hooks.json` is never read. Loading it would run
 *     the developer's own hooks during tests.
 *   - no network, no model. Behaviour comes from a scenario file
 *     (`AGY_FAKE_SCENARIO`, default `scenarios/happy.json`).
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { AGY_TOOLS } from './tools.mjs'
import { AGY_USAGE } from './usage.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Measured prefix agy puts on a hook denial (§9). */
const HOOK_DENIAL_PREFIX = 'tool call denied by pre-tool hook:'

const DEFAULT_MODEL = 'gemini-3.7-flash-low'
const PERMISSION_MODE = 'proceed-in-sandbox'

// ─────────────────────────────────────────────────────────────────────────────
// tiny helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write one line and flush it — file redirection must stay incremental (§8).
 *
 * EPIPE exits quietly rather than dumping a Node stack into what would be the
 * job's `stderr.log`. Real agy's behaviour on a closed stdout is unmeasured, so
 * nothing here should be read as a claim about it; the design never gives agy a
 * pipe in the first place, precisely to avoid this (`docs/01` 결정 1).
 */
function writeOrExit(fd, text) {
  try {
    fs.writeSync(fd, text)
  } catch (e) {
    if (e?.code === 'EPIPE') process.exit(0)
    throw e
  }
}

function out(obj) {
  writeOrExit(1, JSON.stringify(obj) + '\n')
}

function err(text) {
  writeOrExit(2, text.endsWith('\n') ? text : text + '\n')
}

/** Synchronous sleep; the fake is intentionally single-threaded and blocking. */
function sleepSync(ms) {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function die(message, code) {
  err(message)
  process.exit(code)
}

// ─────────────────────────────────────────────────────────────────────────────
// argv
// ─────────────────────────────────────────────────────────────────────────────

const VALUE_FLAGS = new Set([
  'add-dir',
  'agent',
  'conversation',
  'effort',
  'input-format',
  'json-schema',
  'log-file',
  'mode',
  'model',
  'output-format',
  'print-timeout',
  'project',
])

const BOOL_FLAGS = new Set([
  'sandbox',
  'dangerously-skip-permissions',
  'disable-slash-commands',
  'new-project',
  'continue',
])

const PROMPT_FLAGS = new Set(['print', 'prompt', 'p'])

/**
 * Parse argv the way agy does, including its two measured failure modes.
 *
 * @returns parsed options; exits the process on a flag error.
 */
export function parseArgv(argv) {
  const opts = {
    prompt: null,
    addDirs: [],
    model: null,
    effort: null,
    mode: null,
    sandbox: false,
    conversation: null,
    inputFormat: 'text',
    outputFormat: 'text',
    printTimeout: null,
    jsonSchema: null,
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('-')) {
      // A bare positional. agy ignores it; §2's error text calls this
      // "left as an argument and ignored".
      continue
    }
    const body = token.replace(/^--?/, '')
    const eq = body.indexOf('=')
    const name = eq >= 0 ? body.slice(0, eq) : body
    const inlineValue = eq >= 0 ? body.slice(eq + 1) : null

    if (PROMPT_FLAGS.has(name)) {
      if (inlineValue !== null) {
        opts.prompt = inlineValue
        continue
      }
      const next = argv[i + 1]
      if (next === undefined) {
        // Measured in .spike/out/probeC.err.
        die(`flag needs an argument: -${name}\n${AGY_USAGE}`, 2)
      }
      if (next.startsWith('-')) {
        // Measured in .spike/out/probeA.err and probeB.err. The exact wording
        // matters: the server's error handling is tested against it.
        die(
          `Error: ${token} took "${next}" as its prompt, so the intended prompt was ` +
            `left as an argument and ignored.\n` +
            `Attach the prompt to the flag (${token}='your prompt') and move ${next} ` +
            `elsewhere on the command line.`,
          2,
        )
      }
      opts.prompt = next
      i++
      continue
    }

    if (BOOL_FLAGS.has(name)) {
      if (name === 'sandbox') opts.sandbox = true
      continue
    }

    if (VALUE_FLAGS.has(name)) {
      let value = inlineValue
      if (value === null) {
        value = argv[i + 1]
        if (value === undefined) die(`flag needs an argument: -${name}\n${AGY_USAGE}`, 2)
        i++
      }
      switch (name) {
        case 'add-dir':
          opts.addDirs.push(value)
          break
        case 'model':
          opts.model = value
          break
        case 'effort':
          opts.effort = value
          break
        case 'mode':
          opts.mode = value
          break
        case 'conversation':
          opts.conversation = value
          break
        case 'input-format':
          opts.inputFormat = value
          break
        case 'output-format':
          opts.outputFormat = value
          break
        case 'print-timeout':
          opts.printTimeout = value
          break
        case 'json-schema':
          opts.jsonSchema = value
          break
        default:
          break
      }
      continue
    }

    die(`unknown flag: ${token}\n${AGY_USAGE}`, 2)
  }

  return opts
}

// ─────────────────────────────────────────────────────────────────────────────
// scenario + conversation state
// ─────────────────────────────────────────────────────────────────────────────

function loadScenario() {
  const file = process.env.AGY_FAKE_SCENARIO || path.join(HERE, 'scenarios', 'happy.json')
  const resolved = path.isAbsolute(file)
    ? file
    : fs.existsSync(path.resolve(process.cwd(), file))
      ? path.resolve(process.cwd(), file)
      : path.join(HERE, 'scenarios', file.endsWith('.json') ? file : `${file}.json`)
  return JSON.parse(fs.readFileSync(resolved, 'utf8'))
}

/** Where resume state lives, so `--conversation` can continue counters (§6). */
function stateDir() {
  return process.env.AGY_FAKE_STATE_DIR || path.join(os.tmpdir(), 'agy-fake-state')
}

function loadState(conversationId) {
  const file = path.join(stateDir(), `${conversationId}.json`)
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function saveState(conversationId, state) {
  const dir = stateDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${conversationId}.json`)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state))
  fs.renameSync(tmp, file)
}

// ─────────────────────────────────────────────────────────────────────────────
// PreToolUse hooks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load `<workspace>/.agents/hooks.json` for each `--add-dir`.
 *
 * Without `--add-dir` nothing is loaded (§3) — that asymmetry is exactly what
 * makes the workspace-scoped gate possible, so the fake has to reproduce it.
 */
function loadHooks(addDirs) {
  const entries = []
  for (const dir of addDirs) {
    const file = path.join(dir, '.agents', 'hooks.json')
    let doc
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    // Several named hook groups merge and run in order (§9).
    for (const group of Object.values(doc)) {
      for (const entry of group?.PreToolUse ?? []) {
        for (const hook of entry.hooks ?? []) {
          entries.push({
            matcher: entry.matcher ?? '*',
            command: hook.command,
            timeout: hook.timeout ?? 30,
            // The command runs with the hooks.json directory as cwd (§9).
            cwd: path.dirname(file),
          })
        }
      }
    }
  }
  return entries
}

function matcherApplies(matcher, toolName) {
  return matcher === '*' || matcher === toolName
}

/**
 * Run the applicable hooks and fold their verdicts.
 *
 * ⚠ `{}`, unparsable output, and empty output all mean **deny** with an empty
 * reason (§9). `ask` and `force_ask` pass through to the built-in engine, which
 * auto-approves under `proceed-in-sandbox`.
 *
 * Non-zero exit status is not something the spike measured; it is treated the same
 * as unusable output, which is the conservative reading of the `{}` result.
 */
function runHooks(hooks, payload) {
  const merged = { allowed: true, reason: null, overwrite: null }
  for (const hook of hooks) {
    if (!matcherApplies(hook.matcher, payload.toolCall.name)) continue

    const res = spawnSync('sh', ['-c', hook.command], {
      cwd: hook.cwd,
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: hook.timeout * 1000,
    })

    let decision = null
    try {
      const parsed = JSON.parse((res.stdout ?? '').trim())
      if (parsed && typeof parsed === 'object') decision = parsed
    } catch {
      decision = null
    }

    if (decision === null || typeof decision.decision !== 'string') {
      return { allowed: false, reason: '', overwrite: null }
    }
    if (decision.decision === 'deny') {
      return { allowed: false, reason: decision.reason ?? '', overwrite: null }
    }
    if (decision.decision === 'allow') {
      return { allowed: true, reason: null, overwrite: decision.overwrite ?? null }
    }
    // ask / force_ask: keep going, then fall through to the built-in engine.
  }
  return merged
}

function hookPayload(ctx, step, args) {
  const brain = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', ctx.conversationId)
  return {
    conversationId: ctx.conversationId,
    stepIdx: step,
    modelName: ctx.model,
    toolCall: { name: args.name, args: args.args },
    workspacePaths: ctx.addDirs,
    transcriptPath: path.join(brain, '.system_generated', 'logs', 'transcript_full.jsonl'),
    artifactDirectoryPath: brain,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// event emission
// ─────────────────────────────────────────────────────────────────────────────

function usage(input, output, thinking = 0, cacheRead = 0) {
  return {
    input_tokens: input,
    output_tokens: output,
    thinking_tokens: thinking,
    cache_read_tokens: cacheRead,
    total_tokens: input + output,
  }
}

function emitStep(body) {
  out({ event: 'step_update', step_update: body })
}

/**
 * Play one scenario step.
 *
 * The three `agent_response` shapes below are not stylistic — each one occurs in
 * the goldens, and the golden test compares field sets line by line:
 *   0 chunks → one DONE with no `text_delta` (run1 step 1, run6 steps 1 and 3)
 *   1 chunk  → one DONE with `text_delta`    (run6 step 5)
 *   n chunks → n-1 ACTIVE then a DONE        (run1 step 3)
 */
function playStep(ctx, step) {
  const idx = ctx.stepIndex++
  if (step.delay_ms) sleepSync(step.delay_ms)

  if (step.type === 'system_message') {
    emitStep({
      conversation_id: ctx.conversationId,
      step_index: idx,
      state: 'DONE',
      step_type: 'system_message',
      duration_seconds: step.duration_seconds ?? 0.00016,
    })
    return
  }

  if (step.type === 'agent_response') {
    const chunks = step.chunks ?? []
    for (let i = 0; i < chunks.length - 1; i++) {
      emitStep({
        conversation_id: ctx.conversationId,
        step_index: idx,
        state: 'ACTIVE',
        step_type: 'agent_response',
        text_delta: chunks[i],
      })
    }
    const done = {
      conversation_id: ctx.conversationId,
      step_index: idx,
      state: 'DONE',
      step_type: 'agent_response',
    }
    if (chunks.length > 0) done.text_delta = chunks[chunks.length - 1]
    done.duration_seconds = step.duration_seconds ?? 1.4
    const u = step.usage ?? [16000, 70]
    done.usage = usage(u[0], u[1], u[2] ?? 0, u[3] ?? 0)
    ctx.inputTokens += u[0]
    ctx.outputTokens += u[1]
    emitStep(done)
    return
  }

  if (step.type === 'tool') {
    const toolName = step.tool_name ?? 'run_command'
    const parameters = { ...(step.parameters ?? {}) }

    // The args agy hands the hook carry more than the model's parameters (§9).
    const hookArgs = {
      ...parameters,
      Cwd: ctx.toolCwd,
      WaitMsBeforeAsync: step.wait_ms_before_async ?? 5000,
      toolAction: step.tool_action ?? 'Running tool',
      toolSummary: step.tool_summary ?? toolName,
    }

    emitStep({
      conversation_id: ctx.conversationId,
      step_index: idx,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: toolName,
      tool_info: { name: toolName, parameters },
    })

    const verdict = runHooks(ctx.hooks, hookPayload(ctx, idx, { name: toolName, args: hookArgs }))

    if (!verdict.allowed) {
      ctx.denied = true
      const message = verdict.reason
        ? `${HOOK_DENIAL_PREFIX} ${verdict.reason}`
        : HOOK_DENIAL_PREFIX
      emitStep({
        conversation_id: ctx.conversationId,
        step_index: idx,
        state: 'ERROR',
        step_type: 'tool',
        tool_name: toolName,
        duration_seconds: step.duration_seconds ?? 0.06,
        tool_info: {
          name: toolName,
          parameters,
          error: { type: 'TOOL_ERROR', message },
        },
      })
      return
    }

    emitStep({
      conversation_id: ctx.conversationId,
      step_index: idx,
      state: 'DONE',
      step_type: 'tool',
      tool_name: toolName,
      duration_seconds: step.duration_seconds ?? 0.09,
      tool_info: { name: toolName, parameters, output: step.output ?? '' },
    })
    return
  }

  throw new Error(`fake-agy: unknown scenario step type "${step.type}"`)
}

/** One turn: the `user_input` step, the scenario's steps, then exactly one `result`. */
function playTurn(ctx, turn) {
  ctx.denied = false

  emitStep({
    conversation_id: ctx.conversationId,
    step_index: ctx.stepIndex++,
    state: 'DONE',
    step_type: 'user_input',
  })

  for (const step of turn.steps ?? []) playStep(ctx, step)

  ctx.numTurns += 1
  const response = (ctx.denied ? turn.response_if_denied : null) ?? turn.response ?? ''
  const status = turn.status ?? 'SUCCESS'

  const result = {
    conversation_id: ctx.conversationId,
    status,
    response,
  }
  if (turn.error) result.error = turn.error
  result.duration_seconds = turn.duration_seconds ?? 2.8
  result.num_turns = ctx.numTurns
  result.usage = usage(ctx.inputTokens, ctx.outputTokens)
  out({ event: 'result', result })
}

/** Schema failure: agy still emits a `result`, then exits 1 (`.spike/out/probeD`). */
function failStream(ctx, message) {
  out({
    event: 'result',
    result: {
      conversation_id: ctx.conversationId,
      status: 'ERROR',
      response: '',
      error: message,
      duration_seconds: 0,
      num_turns: ctx.numTurns,
      usage: usage(0, 0),
    },
  })
  process.exit(1)
}

// ─────────────────────────────────────────────────────────────────────────────
// stdin (stream-json input, §5)
// ─────────────────────────────────────────────────────────────────────────────

function* stdinLines() {
  const buf = Buffer.alloc(65536)
  let pending = ''
  for (;;) {
    let n
    try {
      n = fs.readSync(0, buf, 0, buf.length, null)
    } catch (e) {
      if (e.code === 'EAGAIN') {
        sleepSync(10)
        continue
      }
      if (e.code === 'EOF') break
      throw e
    }
    if (n === 0) break
    pending += buf.subarray(0, n).toString('utf8')
    let idx
    while ((idx = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, idx)
      pending = pending.slice(idx + 1)
      if (line.trim()) yield line
    }
  }
  if (pending.trim()) yield pending
}

/**
 * Validate one input line. Returns the text of the turn, or exits with the
 * measured error. Unknown event names are ignored rather than fatal (§5).
 */
function turnTextFrom(ctx, line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    failStream(ctx, 'stream input message is missing the "event" field')
    return null
  }
  if (!msg || typeof msg !== 'object' || typeof msg.event !== 'string') {
    failStream(ctx, 'stream input message is missing the "event" field')
    return null
  }
  if (msg.event !== 'user') {
    err('ignoring unknown stream input message event')
    return null
  }
  if (!msg.message || typeof msg.message !== 'object') {
    failStream(ctx, 'stream input "user" message is missing the "message" field')
    return null
  }
  const content = msg.message.content
  if (!Array.isArray(content) || content.length === 0) {
    failStream(ctx, 'stream input "user" message has no content')
    return null
  }
  return content.map((c) => c?.text ?? '').join('')
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

function main(argv) {
  const opts = parseArgv(argv)
  const scenario = loadScenario()

  const conversationId = opts.conversation ?? randomUUID()
  const prior = opts.conversation ? loadState(conversationId) : null

  const ctx = {
    conversationId,
    model: opts.model ?? scenario.model ?? DEFAULT_MODEL,
    addDirs: opts.addDirs,
    // Without --add-dir tools run in agy's scratch directory (§3).
    toolCwd:
      opts.addDirs[0] ?? path.join(os.homedir(), '.gemini', 'antigravity-cli', 'scratch'),
    hooks: loadHooks(opts.addDirs),
    stepIndex: prior?.step_index ?? 0,
    numTurns: prior?.num_turns ?? 0,
    inputTokens: prior?.input_tokens ?? 0,
    outputTokens: prior?.output_tokens ?? 0,
    denied: false,
  }

  // init is always the first line, and carries conversation_id on the envelope.
  out({
    event: 'init',
    conversation_id: ctx.conversationId,
    init: {
      model: ctx.model,
      cwd: process.cwd(),
      tools: AGY_TOOLS,
      permission_mode: PERMISSION_MODE,
    },
  })

  const turns = scenario.turns ?? []
  const turnAt = (i) => turns[Math.min(i, turns.length - 1)] ?? { steps: [], response: '' }

  if (opts.inputFormat === 'stream-json') {
    let i = 0
    for (const line of stdinLines()) {
      const text = turnTextFrom(ctx, line)
      if (text === null) continue
      const turn = turnAt(prior ? (prior.turns_played ?? 0) + i : i)
      playTurn(ctx, { ...turn, prompt: text })
      i++
      saveState(ctx.conversationId, {
        num_turns: ctx.numTurns,
        step_index: ctx.stepIndex,
        input_tokens: ctx.inputTokens,
        output_tokens: ctx.outputTokens,
        turns_played: (prior?.turns_played ?? 0) + i,
      })
    }
  } else {
    playTurn(ctx, turnAt(prior?.turns_played ?? 0))
    saveState(ctx.conversationId, {
      num_turns: ctx.numTurns,
      step_index: ctx.stepIndex,
      input_tokens: ctx.inputTokens,
      output_tokens: ctx.outputTokens,
      turns_played: (prior?.turns_played ?? 0) + 1,
    })
  }

  process.exit(scenario.exit_code ?? 0)
}

// Only run when executed, so tests can import `parseArgv` without launching a turn.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
