/**
 * Unit tests for `agy_result` handler (`src/server/tools/result.ts`).
 *
 * Verifies observable behavior:
 * - Happy path: Returns summary, verification, agent_report, or paged response from stored `broker-result.json`.
 * - In-flight job: A running/queued job returns a polite not-finished notification rather than crashing.
 * - Missing broker-result.json: A finished job with no result file returns an unavailable-yet notification.
 * - Error path: Non-existent job_id returns JOB_NOT_FOUND error.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { writeBrokerResult } from '../../../src/broker/result.js'
import { jobPaths } from '../../../src/contract/paths.js'
import {
  BROKER_RESULT_VERSION,
  type BrokerResult,
  type JobRow,
} from '../../../src/contract/types.js'
import { DEFAULT_LIMITS, type ToolContext } from '../../../src/server/context.js'
import { handleResult } from '../../../src/server/tools/result.js'
import { updateJob } from '../../../src/store/jobs.js'
import { makeTestStore, newTestJob, type TestStoreHandle } from '../helpers/store.js'

function replyJson<T = Record<string, unknown>>(reply: { content: Array<{ type: string; text: string }> }): T {
  return JSON.parse(reply.content[0]!.text) as T
}

function makeSampleBrokerResult(job: JobRow): BrokerResult {
  return {
    schema_version: BROKER_RESULT_VERSION,
    job_id: job.job_id,
    session_id: job.session_id,
    conversation_id: 'conv-test-123',
    lifecycle: 'finished',
    cwd: job.cwd,
    profile: job.profile,
    session_mode: job.session_mode,
    created_at: job.created_at,
    started_at: job.started_at ?? Date.now() - 5000,
    finished_at: Date.now(),
    agent_report: {
      status: 'SUCCESS',
      response: 'All tasks completed successfully.',
      error: null,
      num_turns: 1,
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      conversation_id: 'conv-test-123',
    },
    broker_summary: {
      headline: 'verified_success: all checks passed',
      outcome: 'verified_success',
      exit_code: 0,
      duration_ms: 1234,
      counts: {
        events: 5,
        steps: 2,
        tool_calls: 1,
        tool_errors: 0,
        turns: 1,
        malformed_lines: 0,
      },
      log_tail: ['step 1 done'],
    },
    verification: {
      blockers: [],
      expected_artifacts: [],
      changed_files: [],
      warnings: [],
      contract_status: 'satisfied',
      checked_at: Date.now(),
      verify: null,
    },
    agent_status: 'SUCCESS',
    contract_status: 'satisfied',
    structured_output: null,
    finalized_at: Date.now(),
  }
}

describe('agy_result tool handler', () => {
  let handle: TestStoreHandle
  let ctx: ToolContext

  beforeEach(() => {
    handle = makeTestStore()
    ctx = {
      store: handle.store,
      paths: handle.store.paths,
      version: '0.2.2',
      limits: DEFAULT_LIMITS,
    }
  })

  afterEach(() => {
    handle.cleanup()
  })

  it('returns broker result summary for a finished job', async () => {
    const job = newTestJob(ctx.store, { cwd: handle.workspace })
    updateJob(ctx.store, job.job_id, { lifecycle: 'finished' })

    const paths = jobPaths(ctx.paths, job.job_id)
    const expectedResult = makeSampleBrokerResult(job)
    writeBrokerResult(paths, expectedResult)

    const rep = await handleResult(ctx, { job_id: job.job_id })
    expect(rep.isError).toBeFalsy()

    const body = replyJson<{
      job_id: string
      lifecycle: string
      broker_summary: { outcome: string; headline: string }
      agent_status: string
    }>(rep)

    expect(body.job_id).toBe(job.job_id)
    expect(body.lifecycle).toBe('finished')
    expect(body.broker_summary.outcome).toBe('verified_success')
    expect(body.agent_status).toBe('SUCCESS')
  })

  it('supports section filtering: response with paging and verification', async () => {
    const job = newTestJob(ctx.store, { cwd: handle.workspace })
    updateJob(ctx.store, job.job_id, { lifecycle: 'finished' })

    const paths = jobPaths(ctx.paths, job.job_id)
    writeBrokerResult(paths, makeSampleBrokerResult(job))

    // Response section
    const respRep = await handleResult(ctx, { job_id: job.job_id, section: 'response', limit: 10 })
    expect(respRep.isError).toBeFalsy()
    const respBody = replyJson<{
      job_id: string
      response: { text: string; offset: number; total_length: number }
    }>(respRep)
    expect(respBody.response.text).toBe('All tasks ')
    expect(respBody.response.offset).toBe(0)
    expect(respBody.response.total_length).toBeGreaterThan(10)

    // Verification section
    const verifRep = await handleResult(ctx, { job_id: job.job_id, section: 'verification' })
    expect(verifRep.isError).toBeFalsy()
    const verifBody = replyJson<{
      job_id: string
      verification: { blockers: unknown[]; contract_status: string }
    }>(verifRep)
    expect(verifBody.verification.contract_status).toBe('satisfied')
  })

  it('returns not finished message when job is still running/queued', async () => {
    const job = newTestJob(ctx.store, { cwd: handle.workspace })
    updateJob(ctx.store, job.job_id, { lifecycle: 'running' })

    const rep = await handleResult(ctx, { job_id: job.job_id })
    expect(rep.isError).toBeFalsy()

    const body = replyJson<{
      job_id: string
      lifecycle: string
      message: string
    }>(rep)

    expect(body.job_id).toBe(job.job_id)
    expect(body.lifecycle).toBe('running')
    expect(body.message).toContain('job has not finished yet')
  })

  it('returns not available yet message when finished job has no broker-result.json', async () => {
    const job = newTestJob(ctx.store, { cwd: handle.workspace })
    updateJob(ctx.store, job.job_id, { lifecycle: 'finished' })

    const rep = await handleResult(ctx, { job_id: job.job_id })
    expect(rep.isError).toBeFalsy()

    const body = replyJson<{
      job_id: string
      lifecycle: string
      message: string
    }>(rep)

    expect(body.job_id).toBe(job.job_id)
    expect(body.message).toContain('broker-result.json is not available yet')
  })

  it('returns JOB_NOT_FOUND error when job_id does not exist', async () => {
    const rep = await handleResult(ctx, { job_id: 'job-nonexistent' })
    expect(rep.isError).toBe(true)

    const body = replyJson<{
      error: string
      message: string
    }>(rep)

    expect(body.error).toBe('JOB_NOT_FOUND')
    expect(body.message).toContain('job-nonexistent')
  })
})
