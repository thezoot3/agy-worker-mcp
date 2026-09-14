#!/usr/bin/env node
/**
 * Fake `agy`.
 *
 * Honours the same contract as the real binary so nothing in `src/` ever needs to
 * know which one it is talking to. Every behaviour here is transcribed from
 * empirical measurements and the raw captures in `.spike/out/`:
 *
 *   - `--print` must use the `=` form; a bare one swallows the next flag (exit 2)
 *   - workspace hooks load only when `--add-dir` is given
 *   - `{"event": "init" | "step_update" | "result", ...}` envelopes, one per line
 *   - stream-json input, one line per turn, EOF ends the process
 *   - `num_turns` and `step_index` continue across a `--conversation` resume
 *   - output flushes incrementally even when redirected to a file
 *   - PreToolUse hooks, and `{}` means deny
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

import { AGY_TOOLS, brainDir, runFileTool } from './tools.mjs'
import { AGY_USAGE } from './usage.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Measured prefix agy puts on a hook denial. */
const HOOK_DENIAL_PREFIX = 'tool call denied by pre-tool hook:'

const DEFAULT_MODEL = 'gemini-3.7-flash-low'
const PERMISSION_MODE = 'proceed-in-sandbox'

// ─────────────────────────────────────────────────────────────────────────────
// tiny helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write one line and flush it — file redirection must stay incremental.
 *
 * EPIPE exits quietly rather than dumping a Node stack into what would be the
 * job's `stderr.log`. Real agy's behaviour on a closed stdout is unmeasured, so
 * nothing here should be read as a claim about it; the design never gives agy a
 * pipe in the first place, precisely to avoid this (daemon-less architecture with file-based IPC).
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

/** What this fake answers `--version` with. Shaped like a real agy version, never equal to one. */
const FAKE_AGY_VERSION = '1.1.27-fake'

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
    dangerouslySkipPermissions: false,
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
      if (name === 'dangerously-skip-permissions') opts.dangerouslySkipPermissions = true
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
  // Fake-only escape hatch (documented in README.md) so a test can reproduce
  // "hooks.json failed to load even though --add-dir was given" (I4)
  // without needing a real broken hooks.json.
  if (process.env.AGY_FAKE_SKIP_HOOKS === '1') return []
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
 * Hook groups are evaluated sequentially, in the order `loadHooks` flattened
 * them (which is `hooks.json`'s own group declaration order — §9, confirmed at
 * the payload level by M6).
 *
 * ⚠ `{}`, unparsable output, and empty output all mean **deny** with an empty
 * reason (§9), and deny short-circuits: no later group is consulted (M6 round
 * 1). `allow` does **not** short-circuit — evaluation keeps going so a later
 * group can still override it with `deny` (M6 round 2); the last `allow`'s
 * `overwrite` is what a subsequent `deny` would have discarded anyway, so only
 * the final verdict is returned. `ask` and `force_ask` pass through to the
 * built-in engine, which auto-approves under `proceed-in-sandbox`.
 *
 * Non-zero exit status is not something the spike measured; it is treated the same
 * as unusable output, which is the conservative reading of the `{}` result.
 */
function runHooks(hooks, payload) {
  let current = { allowed: true, reason: null, overwrite: null }
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
      current = { allowed: true, reason: null, overwrite: decision.overwrite ?? null }
      continue
    }
    // ask / force_ask: keep going, then fall through to the built-in engine.
  }
  return current
}

function hookPayload(ctx, step, args) {
  const brain = brainDir(ctx.conversationId)
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
// run_command BypassSandbox simulation (M3, M4, M1's write_to_file workaround)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What actually happens to a `run_command` call once the hook has allowed it,
 * per §M3:
 *   - the hook's `overwrite.BypassSandbox` always wins when present, whether or
 *     not `--dangerously-skip-permissions` was passed (variants A/B).
 *   - with no overwrite, the model's own `BypassSandbox: true` is honoured only
 *     when `--dangerously-skip-permissions` is set (variant C vs. §M1's
 *     `write_to_file` workaround, which lacked the flag and hit agy's own
 *     permission engine instead).
 *   - with no overwrite and no `BypassSandbox: true` from the model, the call
 *     is sandboxed by default.
 *
 * @returns 'bypass' | 'sandboxed' | 'engine_denied'
 */
function resolveBypassSandbox(verdict, parameters, dangerouslySkipPermissions) {
  const overwriteBypass = verdict.overwrite?.BypassSandbox
  if (typeof overwriteBypass === 'boolean') return overwriteBypass ? 'bypass' : 'sandboxed'
  if (parameters.BypassSandbox === true) {
    return dangerouslySkipPermissions ? 'bypass' : 'engine_denied'
  }
  return 'sandboxed'
}

/** Verbatim shape from `AGY_ENGINE_REFUSAL_SIGNATURES`'s doc comment in src/contract/types.ts. */
function engineDenialMessage(commandLine) {
  return (
    `permission check failed for unsandboxed "${commandLine}": user denied permission to run command:\n` +
    commandLine
  )
}

/**
 * The simplest faithful read of M3/M4: a sandboxed `run_command` whose line
 * contains an absolute (or `~`-relative) path outside every `--add-dir` root
 * fails at the OS level, not at the tool layer. Token-splits on whitespace —
 * good enough for the commands the measurements used (`ls ~/.jdks`,
 * `<bin> -version`) without trying to be a real shell parser.
 *
 * @returns `{ cmd, path }` (the resolved, expanded path) for the first
 * offending token, or `null` if every absolute path in the command is under an
 * `--add-dir` root.
 */
function findEscapingPath(commandLine, addDirs) {
  const roots = addDirs.map((d) => path.resolve(d))
  const tokens = commandLine.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  const cmd = tokens[0]
  for (const token of tokens) {
    let candidate = token
    if (candidate.startsWith('~')) candidate = path.join(os.homedir(), candidate.slice(1))
    else if (!candidate.startsWith('/')) continue
    const resolved = path.resolve(candidate)
    const inside = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep))
    if (!inside) return { cmd, path: resolved }
  }
  return null
}

/**
 * Faithful read of M7: on agy 1.1.24, the seatbelt sandbox denies every shell
 * write inside the workspace (file creation, mkdir, redirection, git commit).
 */
function findWorkspaceWrite(commandLine) {
  if (/(?:^|[^<])(?:>>|>)\s*([^\s>&|;]+)/.test(commandLine)) {
    const match = commandLine.match(/(?:^|[^<])(?:>>|>)\s*([^\s>&|;]+)/)
    const target = match ? match[1] : 'file'
    if (target !== '/dev/null') {
      return { cmd: 'sh', path: target, message: `sh: ${target}: Operation not permitted\n` }
    }
  }
  const tokens = commandLine.trim().split(/\s+/)
  const cmd = tokens[0]
  if (cmd === 'touch' || cmd === 'mkdir') {
    const target = tokens[1] ?? 'file'
    return { cmd, path: target, message: `${cmd}: ${target}: Operation not permitted\n` }
  }
  if (cmd === 'git' && tokens.slice(1).some((t) => t === 'commit')) {
    return { cmd: 'git', path: '.git/index.lock', message: 'fatal: cannot create .git/index.lock: Operation not permitted\n' }
  }
  return null
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
    runToolStep(ctx, ctx.conversationId, idx, toolName, parameters, step)

    // §M2: a subagent's own tool calls
    // arrive at the hook under a *different* conversationId than its parent's.
    // `subagent_run_command` is this fake's one deliberate scenario-format
    // extension (documented in README.md) to reproduce that — a nested
    // `run_command` run through the exact same hook path, under a freshly
    // generated conversationId instead of ctx.conversationId.
    if (step.subagent_run_command) {
      const sub = step.subagent_run_command
      const nestedConversationId = randomUUID()
      const nestedIdx = ctx.stepIndex++
      runToolStep(ctx, nestedConversationId, nestedIdx, 'run_command', { ...(sub.parameters ?? {}) }, sub)
    }
    return
  }

  throw new Error(`fake-agy: unknown scenario step type "${step.type}"`)
}

/**
 * Run one tool call end-to-end: emit ACTIVE, run the PreToolUse hooks, then
 * either the hook's denial, `run_command`'s BypassSandbox handling, a real
 * filesystem op for the file/task tools (`tools.mjs`'s `runFileTool`), or the
 * scenario's scripted output.
 *
 * `conversationId` is a parameter rather than read off `ctx` so a subagent's
 * nested call (see `subagent_run_command` above) can run through this same
 * path under a different id, exactly as agy itself does (§M2).
 */
function runToolStep(ctx, conversationId, idx, toolName, parameters, meta) {
  // The args agy hands the hook carry more than the model's parameters (§9).
  const hookArgs = {
    ...parameters,
    Cwd: ctx.toolCwd,
    WaitMsBeforeAsync: meta.wait_ms_before_async ?? 5000,
    toolAction: meta.tool_action ?? 'Running tool',
    toolSummary: meta.tool_summary ?? toolName,
  }

  emitStep({
    conversation_id: conversationId,
    step_index: idx,
    state: 'ACTIVE',
    step_type: 'tool',
    tool_name: toolName,
    tool_info: { name: toolName, parameters },
  })

  const verdict = runHooks(
    ctx.hooks,
    hookPayload({ conversationId, model: ctx.model, addDirs: ctx.addDirs }, idx, {
      name: toolName,
      args: hookArgs,
    }),
  )

  const toolError = (durationSeconds, message) => {
    ctx.denied = true
    emitStep({
      conversation_id: conversationId,
      step_index: idx,
      state: 'ERROR',
      step_type: 'tool',
      tool_name: toolName,
      duration_seconds: durationSeconds,
      tool_info: { name: toolName, parameters, error: { type: 'TOOL_ERROR', message } },
    })
  }
  const toolDone = (durationSeconds, output) => {
    emitStep({
      conversation_id: conversationId,
      step_index: idx,
      state: 'DONE',
      step_type: 'tool',
      tool_name: toolName,
      duration_seconds: durationSeconds,
      tool_info: { name: toolName, parameters, output },
    })
  }

  if (!verdict.allowed) {
    const message = verdict.reason ? `${HOOK_DENIAL_PREFIX} ${verdict.reason}` : HOOK_DENIAL_PREFIX
    toolError(meta.duration_seconds ?? 0.06, message)
    return
  }

  if (toolName === 'run_command') {
    const mode = resolveBypassSandbox(verdict, parameters, ctx.dangerouslySkipPermissions)

    if (mode === 'engine_denied') {
      // Not our hook's denial — agy's own permission engine, refusing an
      // unsandboxed run without --dangerously-skip-permissions (§M1, §M3-C).
      // AGY_ENGINE_REFUSAL_SIGNATURES in src/contract/types.ts matches this.
      toolError(meta.duration_seconds ?? 0.06, engineDenialMessage(parameters.CommandLine ?? ''))
      return
    }

    if (mode === 'sandboxed') {
      const escape = findEscapingPath(parameters.CommandLine ?? '', ctx.addDirs)
      if (escape) {
        // OS-level sandbox-exec failure, not a tool error: DONE, not ERROR
        // (§M3 variant A / §M4). result.status stays SUCCESS.
        toolDone(meta.duration_seconds ?? 0.09, `${escape.cmd}: ${escape.path}: Operation not permitted\n`)
        return
      }
      const write = findWorkspaceWrite(parameters.CommandLine ?? '')
      if (write) {
        toolDone(meta.duration_seconds ?? 0.09, write.message)
        return
      }
    }
    // mode 'bypass', or 'sandboxed' with nothing escaping the allowed roots.
    toolDone(meta.duration_seconds ?? 0.09, meta.output ?? '')
    return
  }

  const real = runFileTool(toolName, parameters, ctx)
  if (real) {
    if (real.error) toolError(meta.duration_seconds ?? 0.06, real.error)
    else toolDone(meta.duration_seconds ?? 0.09, real.output)
    return
  }

  toolDone(meta.duration_seconds ?? 0.09, meta.output ?? '')
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
  // `agy --version` is probed once per server process (`agyVersion`,
  // src/runner/spawn.ts) and stamped onto every job so a regression can be
  // tied to an agy build. Answering it here keeps every `agy_start` in the
  // suite from spending a failing subprocess on the probe, and lets a test
  // assert on what ends up in `usage.jsonl`.
  if (argv.includes('--version')) {
    process.stdout.write(`${FAKE_AGY_VERSION}\n`)
    process.exit(0)
  }

  const opts = parseArgv(argv)

  // Measured against agy 1.1.23: a command-line prompt and
  // stream-json input are mutually exclusive, and agy refuses the combination
  // outright rather than ignoring one of them. The fake used to ignore
  // `--print` here, which quietly agreed with an assumption the real binary
  // rejects — the one class of fake behaviour that is worse than none.
  if (opts.inputFormat === 'stream-json' && opts.prompt) {
    process.stderr.write(
      'Error: --input-format stream-json reads prompts from stdin, so a prompt given on the command line would be ignored\n',
    )
    process.exit(2)
  }

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
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
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
