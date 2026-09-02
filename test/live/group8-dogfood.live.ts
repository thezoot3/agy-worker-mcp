/**
 * 그룹 8 — 도그푸딩: 실제 작업 2건 (`docs/05` 작업 B).
 *
 * 지금까지의 live 테스트는 전부 합성 프롬프트("Reply with exactly: PONG",
 * "run python3" 유도 등)였다. 여기서는 실제로 쓸모 있는 작업 두 개를 시키고,
 * `agy_result` 의 응답이 사람/에이전트에게 실제로 읽히는지를 본다:
 *
 *  - L15: `research_readonly` 로 워크스페이스 구조 요약 (조사)
 *  - L16: `general_worker` 로 파일 하나를 만드는 작업, `expected_artifacts` 로
 *    `verified_success` 가 실제로 나오는지 확인
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  LIVE,
  LIVE_EFFORT,
  LIVE_MODEL,
  LIVE_TIMEOUT_MS,
  applyLiveEnv,
  ensureBuilt,
  makeLiveProject,
  readEvents,
  recordUsage,
  replyJson,
  writeWorkspaceFile,
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

live('L15 — research_readonly: summarize a real (small) directory tree', () => {
  it('produces a broker_summary/response that actually describes the workspace', async () => {
    writeWorkspaceFile(project, 'README.md', '# demo-project\n\nA tiny demo used for a live dogfood test.\n')
    writeWorkspaceFile(project, 'src/index.js', "console.log('hello')\n")
    writeWorkspaceFile(project, 'src/utils.js', 'export function add(a, b) { return a + b }\n')
    writeWorkspaceFile(project, 'package.json', '{"name":"demo-project","version":"0.0.1"}\n')
    writeWorkspaceFile(project, 'docs/notes.md', '- todo: write more docs\n')

    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')

    const ctx = createContext()
    const t0 = Date.now()
    const started = replyJson(
      await handleStart(ctx, {
        prompt:
          'List the files in this workspace and briefly describe the directory structure (top-level files and subdirectories). Use the terminal (ls, cat) to look, do not guess.',
        profile: 'research_readonly',
        model: LIVE_MODEL,
        effort: LIVE_EFFORT,
        timeout_ms: LIVE_TIMEOUT_MS,
      } as never),
    ) as { job_id: string }

    const waited = replyJson(
      await handleWait(ctx, { job_id: started.job_id, wait_ms: LIVE_TIMEOUT_MS } as never),
    ) as { lifecycle: string; outcome: string }

    const events = readEvents(ctx, started.job_id)
    recordUsage({ test: 'L15', job_id: started.job_id, model: LIVE_MODEL, events, wall_ms: Date.now() - t0 })

    const full = replyJson(await handleResult(ctx, { job_id: started.job_id, section: 'all' } as never)) as {
      broker_summary?: { headline?: string; log_tail?: string[] }
      agent_report?: { response?: { text?: string } }
      verification?: unknown
    }

    // eslint-disable-next-line no-console
    console.log(
      '[L15] readability check — is this something a human/agent could act on without re-reading logs?',
      JSON.stringify(
        {
          lifecycle: waited.lifecycle,
          outcome: waited.outcome,
          headline: full.broker_summary?.headline,
          log_tail: full.broker_summary?.log_tail,
          response_text: full.agent_report?.response?.text,
        },
        null,
        1,
      ),
    )

    expect(waited.lifecycle).toBe('finished')
    // The point of this test is the *readability* of the reply, judged by the
    // report this test produces, not a machine assertion — so the assertion
    // stays limited to "the job actually finished and produced a summary".
    expect(typeof full.broker_summary?.headline).toBe('string')

    ctx.store.close()
  })
})

live('L16 — general_worker: a real small edit, verified via expected_artifacts', () => {
  it('creates CHANGELOG.md and the broker reports verified_success because the file is actually there', async () => {
    writeWorkspaceFile(project, 'TODO.md', '- [ ] write a CHANGELOG entry\n')

    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')
    const { handleResult } = await import('../../src/server/tools/result.js')

    const ctx = createContext()
    const t0 = Date.now()
    const started = replyJson(
      await handleStart(ctx, {
        prompt:
          'Create a new file named CHANGELOG.md in this workspace containing exactly one line: "Initial version.". Use the write tool, then stop.',
        profile: 'general_worker',
        model: LIVE_MODEL,
        effort: LIVE_EFFORT,
        timeout_ms: LIVE_TIMEOUT_MS,
        expected_artifacts: ['CHANGELOG.md'],
      } as never),
    ) as { job_id: string }

    const waited = replyJson(
      await handleWait(ctx, { job_id: started.job_id, wait_ms: LIVE_TIMEOUT_MS } as never),
    ) as { lifecycle: string; outcome: string }

    const events = readEvents(ctx, started.job_id)
    recordUsage({ test: 'L16', job_id: started.job_id, model: LIVE_MODEL, events, wall_ms: Date.now() - t0 })

    const full = replyJson(await handleResult(ctx, { job_id: started.job_id, section: 'all' } as never)) as {
      broker_summary?: { headline?: string; log_tail?: string[] }
      agent_report?: { response?: { text?: string } }
      verification?: {
        expected_artifacts?: Array<{ path: string; absolute: string; exists: boolean; size: number | null }>
        blockers?: Array<{ source: string; actionable: boolean; remedy: string | null }>
      }
    }

    const onDiskExists = (() => {
      try {
        readFileSync(join(project.root, 'CHANGELOG.md'), 'utf8')
        return true
      } catch {
        return false
      }
    })()

    // eslint-disable-next-line no-console
    console.log(
      '[L16]',
      JSON.stringify(
        {
          lifecycle: waited.lifecycle,
          outcome: waited.outcome,
          headline: full.broker_summary?.headline,
          expected_artifacts: full.verification?.expected_artifacts,
          blockers: full.verification?.blockers,
          on_disk_exists: onDiskExists,
          response_text: full.agent_report?.response?.text,
        },
        null,
        1,
      ),
    )

    expect(waited.lifecycle).toBe('finished')
    expect(onDiskExists).toBe(true)
    expect(full.verification?.expected_artifacts?.length).toBe(1)
    expect(full.verification?.expected_artifacts?.[0]?.path).toBe('CHANGELOG.md')
    expect(full.verification?.expected_artifacts?.[0]?.exists).toBe(true)
    expect(waited.outcome).toBe('verified_success')

    ctx.store.close()
  })
})
