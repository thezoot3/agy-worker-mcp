/**
 * docs/04 완료 기준 (task numbering) #2, #3 — multi-client access to one project.
 *
 * "A client" here is one `ToolContext`: one open `DatabaseSync` connection plus
 * the tool handlers bound to it, exactly what one MCP server process holds
 * (`docs/01` 결정 1). Two clients are simulated with two independently created
 * `ToolContext`s against the same project root, which is the real unit of
 * concurrency this design has — there is no in-process handle to share even
 * between two real server processes.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { applyEnv, ensureBuilt, makeProject, replyJson, waitUntil, type TestProject } from './helpers.js'

let project: TestProject

beforeAll(() => {
  ensureBuilt()
})

beforeEach(() => {
  project = makeProject()
})

afterEach(() => {
  delete process.env.AGY_FAKE_SCENARIO
})

describe('#2 — client A starts a job, client B picks it up via list/wait', () => {
  it('B sees the job in agy_list_jobs and agy_wait resolves it to completion', async () => {
    applyEnv(project, 'happy')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleListJobs } = await import('../../src/server/tools/listJobs.js')
    const { handleWait } = await import('../../src/server/tools/wait.js')

    const clientA = createContext()
    const clientB = createContext()

    const started = replyJson(
      await handleStart(clientA, { prompt: 'compute 41+1', profile: 'general_worker' } as never),
    )
    expect(started.job_id).toBeTruthy()

    // B never called agy_start — it only ever sees the project's shared state.
    const listed = replyJson(await handleListJobs(clientB, {} as never)) as { jobs: Array<{ job_id: string }> }
    expect(listed.jobs.some((j) => j.job_id === started.job_id)).toBe(true)

    const waited = replyJson(await handleWait(clientB, { job_id: started.job_id, wait_ms: 10_000 } as never)) as {
      lifecycle: string
      outcome: string | null
    }
    expect(waited.lifecycle).toBe('finished')
    expect(waited.outcome).toBe('success_unverified')

    clientA.store.close()
    clientB.store.close()
  })
})

describe('#3 — the spawning client can disappear; another client still finalizes the result', () => {
  it('closing the starting client does not stop the detached runner or lose the result', async () => {
    applyEnv(project, 'happy')
    const { createContext } = await import('../../src/server/context.js')
    const { handleStart } = await import('../../src/server/tools/start.js')
    const { handleResult } = await import('../../src/server/tools/result.js')

    const spawner = createContext()
    const started = replyJson(
      await handleStart(spawner, { prompt: 'compute 41+1', profile: 'general_worker' } as never),
    ) as { job_id: string }
    expect(started.job_id).toBeTruthy()

    // Simulate the spawning MCP server process going away entirely: its own
    // store connection closes and nothing about it is touched again. The
    // runner was spawned detached + unref'd (`start.ts`), so it must not care.
    spawner.store.close()

    const rescuer = createContext()
    const finished = await waitUntil(
      async () => {
        const { reconcile } = await import('../../src/broker/reconcile.js')
        await reconcile(rescuer.store)
        const { getJob } = await import('../../src/store/jobs.js')
        const job = getJob(rescuer.store, started.job_id)
        return job.lifecycle === 'finished' ? job : null
      },
      { timeoutMs: 10_000, label: 'job finalized by a client that never started it' },
    )
    expect(finished.outcome).toBe('success_unverified')

    const result = replyJson(await handleResult(rescuer, { job_id: started.job_id, section: 'all' } as never)) as {
      agent_report: { response: { text: string } }
    }
    expect(result.agent_report.response.text).toContain('42')

    rescuer.store.close()
  })
})
