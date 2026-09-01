/**
 * 그룹 2 — 게이트 (`docs/05` §2). 이 프로젝트의 핵심 주장이 실제 agy 에서
 * 성립하는지. 해소 대상: A3 (훅 실패 모드), A5 (`permissionOverrides` 범위).
 *
 * L6/L7 은 우리 스택을 거치지 않고 `agy` 를 직접 spawn 한다. 우리 `agy_start`
 * 는 항상 자기 게이트를 설치하므로, 일부러 망가진 훅을 관측하려면 워크스페이스와
 * `hooks.json` 을 직접 만드는 수밖에 없다.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  LIVE,
  LIVE_EFFORT,
  LIVE_MODEL,
  LIVE_TIMEOUT_MS,
  REPO_ROOT,
  applyLiveEnv,
  ensureBuilt,
  makeLiveProject,
  readEvents,
  recordUsage,
  replyJson,
  type LiveProject,
} from './helpers.js'

const live = LIVE ? describe : describe.skip

let project: LiveProject

beforeAll(() => {
  if (LIVE) ensureBuilt()
})

beforeEach(() => {
  if (!LIVE) return
  project = makeLiveProject()
  applyLiveEnv(project)
})

live('L4 — our gate binds a real agy conversation and its denial survives exit 0 / SUCCESS', () => {
  it('research_readonly refuses an interpreter and the broker reports blocked', async () => {
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')
    const { getSession } = await import('../../src/store/sessions.js')

    const ctx = createContext()
    const t0 = Date.now()
    const started = replyJson(
      await handleStart(ctx, {
        prompt:
          'Run the shell command: python3 -c "print(41+1)" — then tell me the number it printed. Use the terminal, do not compute it yourself.',
        profile: 'research_readonly',
        model: LIVE_MODEL,
        effort: LIVE_EFFORT,
        timeout_ms: LIVE_TIMEOUT_MS,
      } as never),
    ) as { job_id: string; session_id: string }

    const waited = replyJson(
      await handleWait(ctx, { job_id: started.job_id, wait_ms: LIVE_TIMEOUT_MS } as never),
    ) as { lifecycle: string; outcome: string }

    const events = readEvents(ctx, started.job_id)
    recordUsage({ test: 'L4', job_id: started.job_id, model: LIVE_MODEL, events, wall_ms: Date.now() - t0 })

    const full = replyJson(await handleResult(ctx, { job_id: started.job_id } as never)) as {
      broker?: { outcome?: string; exit_code?: number | null; agent_status?: string | null }
      verification?: { permission_denials?: unknown[] }
    }
    const session = getSession(ctx.store, started.session_id)
    // eslint-disable-next-line no-console
    console.log(
      '[L4]',
      JSON.stringify({
        outcome: waited.outcome,
        broker: full.broker,
        denials: full.verification?.permission_denials,
        conversation_id: session?.conversation_id,
      }),
    )

    // The gate can only have denied if it bound the conversation, which is the
    // whole daemon-less binding claim (docs/01 결정 5, docs/03 §1.4).
    expect(session?.conversation_id).toBeTruthy()
    expect(waited.lifecycle).toBe('finished')
    expect(full.verification?.permission_denials?.length ?? 0).toBeGreaterThan(0)
    expect(waited.outcome).toBe('blocked')

    ctx.store.close()
  })
})

live('L5 — the gate answers a foreign conversation with exactly the passthrough (no agy call)', () => {
  it('dist/gate.js prints {"decision":"ask"} for a conversationId that is not one of our jobs', async () => {
    const { createContext } = await import('../../src/server/context.js')
    const ctx = createContext()
    ctx.store.close()

    const payload = JSON.stringify({
      conversationId: 'not-ours-00000000-0000-0000-0000-000000000000',
      toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf /' } },
      workspacePaths: [project.root],
    })
    const res = spawnSync(process.execPath, [join(REPO_ROOT, 'dist', 'gate.js')], {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env },
    })
    // eslint-disable-next-line no-console
    console.log('[L5]', JSON.stringify({ status: res.status, stdout: res.stdout, stderr: res.stderr.slice(0, 200) }))

    // ⚠ Anything but this — `{}`, empty stdout, a crash — silently denies every
    // tool call in every one of the user's own interactive agy sessions.
    expect(res.status).toBe(0)
    expect(JSON.parse(res.stdout)).toEqual({ decision: 'ask' })
  })
})

/**
 * A1/A3 probe: run agy directly against a workspace whose only PreToolUse hook
 * is deliberately broken, and read back what agy decided from the event stream.
 */
function runAgyWithHook(
  workspace: string,
  hookScript: string,
  prompt: string,
): { code: number | null; events: Array<Record<string, unknown>>; stderr: string } {
  const agentsDir = join(workspace, '.agents')
  mkdirSync(agentsDir, { recursive: true })
  const scriptPath = join(workspace, 'hook.sh')
  writeFileSync(scriptPath, hookScript, { mode: 0o700 })
  chmodSync(scriptPath, 0o700)
  writeFileSync(
    join(agentsDir, 'hooks.json'),
    JSON.stringify({
      'live-probe': { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: scriptPath, timeout: 15 }] }] },
    }),
  )

  const res = spawnSync(
    'agy',
    [
      `--print=${prompt}`,
      '--output-format', 'stream-json',
      '--add-dir', workspace,
      '--sandbox',
      '--model', LIVE_MODEL,
      '--effort', LIVE_EFFORT,
      '--print-timeout', '2m',
    ],
    { cwd: workspace, encoding: 'utf8', timeout: 150_000 },
  )
  const events = (res.stdout ?? '')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>
      } catch {
        return { _unparsed: l }
      }
    })
  return { code: res.status, events, stderr: (res.stderr ?? '').slice(0, 400) }
}

const PROBE_PROMPT = 'Run the shell command: echo hello-from-agy'

live('L6 — what agy does when a PreToolUse hook fails (A3)', () => {
  it('a hook that exits non-zero with no stdout', () => {
    const { code, events, stderr } = runAgyWithHook(project.root, '#!/bin/sh\nexit 1\n', PROBE_PROMPT)
    const steps = events.filter((e) => e.type === 'step_update')
    // eslint-disable-next-line no-console
    console.log(
      '[L6a non-zero exit]',
      JSON.stringify({ code, stderr, steps: steps.map((s) => ({ state: s.state, tool: s.tool_name, info: s.tool_info })) }, null, 1).slice(0, 2500),
    )
    // Observational: the assertion is only that agy ran at all. What it decided
    // is the finding, and it goes into docs/02.
    expect(events.length).toBeGreaterThan(0)
  })

  it('a hook that exits 0 but prints something that is not JSON', () => {
    const { code, events, stderr } = runAgyWithHook(project.root, "#!/bin/sh\nprintf 'not json at all'\n", PROBE_PROMPT)
    const steps = events.filter((e) => e.type === 'step_update')
    // eslint-disable-next-line no-console
    console.log(
      '[L6b non-JSON stdout]',
      JSON.stringify({ code, stderr, steps: steps.map((s) => ({ state: s.state, tool: s.tool_name, info: s.tool_info })) }, null, 1).slice(0, 2500),
    )
    expect(events.length).toBeGreaterThan(0)
  })
})

live('L7 — how long a permissionOverrides grant lasts (A5)', () => {
  it('a hook that grants an override on its first call and records every later call', () => {
    const logPath = join(project.root, 'hook-calls.log')
    // Grant an override on call 1, then log-and-passthrough. If the override is
    // conversation-wide, the hook is simply not consulted again for that tool.
    const script = `#!/bin/sh
payload=$(cat)
printf '%s\\n' "$payload" >> ${JSON.stringify(logPath)}
if [ ! -f ${JSON.stringify(logPath + '.granted')} ]; then
  : > ${JSON.stringify(logPath + '.granted')}
  printf '{"decision":"allow","permissionOverrides":{"command":["echo"]}}'
else
  printf '{"decision":"ask"}'
fi
`
    const { code, events } = runAgyWithHook(
      project.root,
      script,
      'Run the shell command: echo one. Then run the shell command: echo two. Then run the shell command: echo three.',
    )
    let calls = 0
    try {
      calls = execFileSync('sh', ['-c', `wc -l < ${JSON.stringify(logPath)}`], { encoding: 'utf8' }).trim() as unknown as number
      calls = Number(calls)
    } catch {
      calls = 0
    }
    const steps = events.filter((e) => e.type === 'step_update' && e.tool_name === 'run_command')
    // eslint-disable-next-line no-console
    console.log(
      '[L7]',
      JSON.stringify({ code, hook_invocations: calls, run_command_steps: steps.length, states: steps.map((s) => s.state) }),
    )
    expect(events.length).toBeGreaterThan(0)
  })
})
