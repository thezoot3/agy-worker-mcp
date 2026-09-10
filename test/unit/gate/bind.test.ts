/**
 * Unit tests for `src/gate/bind.ts`.
 *
 * Pins the mapping of agy hook payloads (`conversationId`) to our jobs and
 * their effective policies. Verifies fast-path session caching (`recordBinding`
 * and `lookupBoundJob`), fallback init-event scanning (`readInitConversationId`),
 * filtering of finished jobs (`BIND_LIFECYCLES`), and normalization defaults in
 * `loadJobPolicy` (`add_dirs_source`, `command_policy`, `bypass_sandbox`).
 */
import { writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  bindConversation,
  loadJobPolicy,
  lookupBoundJob,
  recordBinding,
} from '../../../src/gate/bind.js'
import { ensureJobDirs, jobPaths, writeJsonAtomic } from '../../../src/contract/paths.js'
import type { EffectivePolicy, JobRow } from '../../../src/contract/types.js'
import { createSession } from '../../../src/store/sessions.js'
import { updateJob } from '../../../src/store/jobs.js'
import { makeTestStore, newTestJob, type TestStoreHandle } from '../helpers/store.js'

let handle: TestStoreHandle

beforeEach(() => {
  handle = makeTestStore()
})

afterEach(() => {
  handle.cleanup()
})

function writeJobPolicyFiles(
  handle: TestStoreHandle,
  jobId: string,
  policyOverrides: Record<string, unknown> = {},
): void {
  const paths = ensureJobDirs(jobPaths(handle.store.paths, jobId))
  const policy = {
    profile: 'general_worker',
    workspace: handle.workspace,
    read_roots: [handle.workspace],
    write_roots: [handle.workspace],
    allow: ['command(ls)'],
    deny: [],
    on_denial: 'continue',
    rejected_allow: [],
    lifted: [],
    sandbox: 'none',
    sandbox_source: 'default',
    seatbelt_write_roots: [],
    rejected_read_roots: [],
    ...policyOverrides,
  }
  // Write directly to effective-config.json as specified
  writeJsonAtomic(paths.effectiveConfig, { policy })
  // Also write policy.json which src/gate/bind.ts loadJobPolicy currently reads
  writeJsonAtomic(paths.policy, policy)
}

function writeInitEvent(handle: TestStoreHandle, jobId: string, conversationId: string): void {
  const paths = ensureJobDirs(jobPaths(handle.store.paths, jobId))
  writeFileSync(
    paths.events,
    JSON.stringify({ event: 'init', conversation_id: conversationId }) + '\n',
    'utf8',
  )
}

describe('recordBinding and lookupBoundJob', () => {
  it('returns null for an unrecorded conversation', () => {
    const bound = lookupBoundJob(handle.store, 'conv-unknown')
    expect(bound).toBeNull()
  })

  it('recordBinding binds conversationId to session and lookupBoundJob returns the job', () => {
    const session = createSession(handle.store, { cwd: handle.workspace })
    const job = newTestJob(handle.store, { cwd: handle.workspace, sessionId: session.session_id })

    // Before binding
    expect(lookupBoundJob(handle.store, 'conv-123')).toBeNull()

    recordBinding(handle.store, job.job_id, 'conv-123')

    const found = lookupBoundJob(handle.store, 'conv-123')
    expect(found).not.toBeNull()
    expect(found?.job_id).toBe(job.job_id)
  })

  it('recordBinding does nothing if job has no session_id', () => {
    const job = newTestJob(handle.store, { cwd: handle.workspace, sessionId: null })
    recordBinding(handle.store, job.job_id, 'conv-no-session')

    expect(lookupBoundJob(handle.store, 'conv-no-session')).toBeNull()
  })

  it('lookupBoundJob returns null when the bound job is finished (lifecycle outside BIND_LIFECYCLES)', () => {
    const session = createSession(handle.store, { cwd: handle.workspace })
    const job = newTestJob(handle.store, { cwd: handle.workspace, sessionId: session.session_id })
    recordBinding(handle.store, job.job_id, 'conv-finished')

    // Mark job as finished
    updateJob(handle.store, job.job_id, { lifecycle: 'finished' })

    const found = lookupBoundJob(handle.store, 'conv-finished')
    expect(found).toBeNull()
  })
})

describe('bindConversation', () => {
  it('binds job, policy, and conversationId on cached session lookup', () => {
    const session = createSession(handle.store, { cwd: handle.workspace })
    const job = newTestJob(handle.store, { cwd: handle.workspace, sessionId: session.session_id })
    writeJobPolicyFiles(handle, job.job_id, { command_policy: 'allowlist' })
    recordBinding(handle.store, job.job_id, 'conv-cached')

    const bound = bindConversation(handle.store, 'conv-cached')
    expect(bound).not.toBeNull()
    expect(bound?.job.job_id).toBe(job.job_id)
    expect(bound?.conversationId).toBe('conv-cached')
    expect(bound?.policy.command_policy).toBe('allowlist')
  })

  it('binds job via candidate scanning of events.ndjson when not previously cached', () => {
    const session = createSession(handle.store, { cwd: handle.workspace })
    const job = newTestJob(handle.store, { cwd: handle.workspace, sessionId: session.session_id })
    writeJobPolicyFiles(handle, job.job_id)
    writeInitEvent(handle, job.job_id, 'conv-scanned')

    const bound = bindConversation(handle.store, 'conv-scanned')
    expect(bound).not.toBeNull()
    expect(bound?.job.job_id).toBe(job.job_id)
    expect(bound?.conversationId).toBe('conv-scanned')

    // After scanning, it should also have recorded the binding in the session
    const cached = lookupBoundJob(handle.store, 'conv-scanned')
    expect(cached?.job_id).toBe(job.job_id)
  })

  it('returns null when candidate job has matching conversation but policy is missing', () => {
    const session = createSession(handle.store, { cwd: handle.workspace })
    const job = newTestJob(handle.store, { cwd: handle.workspace, sessionId: session.session_id })
    // No policy files written
    writeInitEvent(handle, job.job_id, 'conv-missing-policy')

    const bound = bindConversation(handle.store, 'conv-missing-policy')
    expect(bound).toBeNull()
  })

  it('returns null for finished job even if events.ndjson matches', () => {
    const session = createSession(handle.store, { cwd: handle.workspace })
    const job = newTestJob(handle.store, { cwd: handle.workspace, sessionId: session.session_id })
    writeJobPolicyFiles(handle, job.job_id)
    writeInitEvent(handle, job.job_id, 'conv-done')
    updateJob(handle.store, job.job_id, { lifecycle: 'finished' })

    const bound = bindConversation(handle.store, 'conv-done')
    expect(bound).toBeNull()
  })

  it('returns null when no candidate job matches the conversationId', () => {
    const session = createSession(handle.store, { cwd: handle.workspace })
    const job = newTestJob(handle.store, { cwd: handle.workspace, sessionId: session.session_id })
    writeJobPolicyFiles(handle, job.job_id)
    writeInitEvent(handle, job.job_id, 'conv-different')

    const bound = bindConversation(handle.store, 'conv-unrelated')
    expect(bound).toBeNull()
  })
})

describe('loadJobPolicy', () => {
  it('returns null when policy file is missing', () => {
    const policy = loadJobPolicy(handle.store, 'job-nonexistent')
    expect(policy).toBeNull()
  })

  it('defaults add_dirs_source to "none" when missing', () => {
    const job = newTestJob(handle.store, { cwd: handle.workspace })
    writeJobPolicyFiles(handle, job.job_id, {
      add_dirs_source: undefined,
    })

    const policy = loadJobPolicy(handle.store, job.job_id)
    expect(policy).not.toBeNull()
    expect(policy?.add_dirs_source).toBe('none')
  })

  it('preserves add_dirs_source when present', () => {
    const job = newTestJob(handle.store, { cwd: handle.workspace })
    writeJobPolicyFiles(handle, job.job_id, {
      add_dirs_source: 'ceiling',
    })

    const policy = loadJobPolicy(handle.store, job.job_id)
    expect(policy?.add_dirs_source).toBe('ceiling')
  })

  it('defaults command_policy to "allowlist" when missing or not "denylist"', () => {
    const job = newTestJob(handle.store, { cwd: handle.workspace })
    writeJobPolicyFiles(handle, job.job_id, {
      command_policy: undefined,
    })

    const policy = loadJobPolicy(handle.store, job.job_id)
    expect(policy?.command_policy).toBe('allowlist')

    writeJobPolicyFiles(handle, job.job_id, {
      command_policy: 'other_value',
    })
    const policy2 = loadJobPolicy(handle.store, job.job_id)
    expect(policy2?.command_policy).toBe('allowlist')
  })

  it('preserves command_policy when set to "denylist"', () => {
    const job = newTestJob(handle.store, { cwd: handle.workspace })
    writeJobPolicyFiles(handle, job.job_id, {
      command_policy: 'denylist',
    })

    const policy = loadJobPolicy(handle.store, job.job_id)
    expect(policy?.command_policy).toBe('denylist')
  })

  it('defaults bypass_sandbox to false when not a boolean', () => {
    const job = newTestJob(handle.store, { cwd: handle.workspace })
    writeJobPolicyFiles(handle, job.job_id, {
      bypass_sandbox: undefined,
    })

    const policy = loadJobPolicy(handle.store, job.job_id)
    expect(policy?.bypass_sandbox).toBe(false)
  })

  it('preserves bypass_sandbox: true', () => {
    const job = newTestJob(handle.store, { cwd: handle.workspace })
    writeJobPolicyFiles(handle, job.job_id, {
      bypass_sandbox: true,
    })

    const policy = loadJobPolicy(handle.store, job.job_id)
    expect(policy?.bypass_sandbox).toBe(true)
  })

  it('defaults add_dirs to empty array when not an array', () => {
    const job = newTestJob(handle.store, { cwd: handle.workspace })
    writeJobPolicyFiles(handle, job.job_id, {
      add_dirs: 'not-an-array',
    })

    const policy = loadJobPolicy(handle.store, job.job_id)
    expect(policy?.add_dirs).toEqual([])
  })

  it('sets policy_version to 3', () => {
    const job = newTestJob(handle.store, { cwd: handle.workspace })
    writeJobPolicyFiles(handle, job.job_id, {
      policy_version: 1,
    })

    const policy = loadJobPolicy(handle.store, job.job_id)
    expect(policy?.policy_version).toBe(3)
  })

  it('defaults max_denials to null when missing or not a number', () => {
    const job = newTestJob(handle.store, { cwd: handle.workspace })
    writeJobPolicyFiles(handle, job.job_id, {
      max_denials: undefined,
    })

    const policy = loadJobPolicy(handle.store, job.job_id)
    expect(policy?.max_denials).toBeNull()
  })

  it('preserves max_denials when set to a number', () => {
    const job = newTestJob(handle.store, { cwd: handle.workspace })
    writeJobPolicyFiles(handle, job.job_id, {
      max_denials: 5,
    })

    const policy = loadJobPolicy(handle.store, job.job_id)
    expect(policy?.max_denials).toBe(5)
  })
})

