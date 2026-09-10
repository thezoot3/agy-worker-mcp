/**
 * Tests for PR5 start preflight:
 * (a) verifiable means warning when general_worker has no verify_command, expected_artifacts, or json_schema
 * (b) dry_run.expected_commands preflight command evaluation and denial warning
 * (c) model and effort validation against MEASURED_MODELS
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Blocker, EffectiveConfig, PolicySummary } from '../../src/contract/types.js'
import { applyEnv, ensureBuilt, makeProject, replyJson, type TestProject } from './helpers.js'

let project: TestProject

beforeAll(() => {
  ensureBuilt()
})

beforeEach(() => {
  project = makeProject()
  applyEnv(project, 'happy')
})

interface PreflightCommand {
  command: string
  decision: 'allow' | 'deny'
  stage: string
  required_rule: string | null
}

interface StartReply {
  dry_run?: boolean
  job_id?: string
  session_id?: string
  policy_summary: PolicySummary
  blockers: Blocker[]
  warnings: string[]
  preflight?: {
    commands: PreflightCommand[]
  }
  effective_config?: EffectiveConfig
}

interface ErrorReply {
  error: string
  message: string
  detail?: {
    field?: string
    value?: unknown
    expected?: string
  }
  remedy?: string
}

async function start(input: Record<string, unknown>): Promise<StartReply> {
  const { createContext } = await import('../../src/server/context.js')
  const { handleStart } = await import('../../src/server/tools/start.js')
  const ctx = createContext()
  try {
    return replyJson<StartReply>(await handleStart(ctx, input as never))
  } finally {
    ctx.store.close()
  }
}

async function startRaw(input: Record<string, unknown>) {
  const { createContext } = await import('../../src/server/context.js')
  const { handleStart } = await import('../../src/server/tools/start.js')
  const ctx = createContext()
  try {
    const rep = await handleStart(ctx, input as never)
    return { reply: rep, json: replyJson<ErrorReply | StartReply>(rep) }
  } finally {
    ctx.store.close()
  }
}

describe('verifiable means warning on general_worker', () => {
  it('general_worker with no verifiable means includes nothing verifiable warning', async () => {
    const reply = await start({
      prompt: 'do work',
      profile: 'general_worker',
      dry_run: true,
    })
    expect(
      reply.warnings.some((w) =>
        w.includes('nothing verifiable requested: the best outcome this job can reach is success_unverified'),
      ),
    ).toBe(true)
  })

  it('empty expected_artifacts array still produces the warning', async () => {
    const reply = await start({
      prompt: 'do work',
      profile: 'general_worker',
      expected_artifacts: [],
      dry_run: true,
    })
    expect(
      reply.warnings.some((w) =>
        w.includes('nothing verifiable requested: the best outcome this job can reach is success_unverified'),
      ),
    ).toBe(true)
  })

  it('suppresses nothing verifiable warning when verify_command is given', async () => {
    const reply = await start({
      prompt: 'do work',
      profile: 'general_worker',
      verify_command: 'npm test',
      dry_run: true,
    })
    expect(
      reply.warnings.some((w) => w.includes('nothing verifiable')),
    ).toBe(false)
  })

  it('suppresses nothing verifiable warning when non-empty expected_artifacts is given', async () => {
    const reply = await start({
      prompt: 'do work',
      profile: 'general_worker',
      expected_artifacts: ['dist/out.js'],
      dry_run: true,
    })
    expect(
      reply.warnings.some((w) => w.includes('nothing verifiable')),
    ).toBe(false)
  })

  it('research_readonly does not receive nothing verifiable warning', async () => {
    const reply = await start({
      prompt: 'read code',
      profile: 'research_readonly',
      dry_run: true,
    })
    expect(
      reply.warnings.some((w) => w.includes('nothing verifiable')),
    ).toBe(false)
  })
})

describe('dry_run.expected_commands preflight', () => {
  it('evaluates commands against policy and reports decisions and warning on denial', async () => {
    const reply = await start({
      prompt: 'build project',
      profile: 'general_worker',
      dry_run: true,
      verify_command: 'npm test',
      expected_commands: [
        'git status',
        'uname -a',
        'JAVA_HOME=/opt/jdk ./gradlew build',
      ],
    })

    expect(reply.preflight).toBeDefined()
    expect(reply.preflight!.commands).toHaveLength(3)

    // First command: git status -> allowed by profile_allowlist
    const cmd1 = reply.preflight!.commands[0]!
    expect(cmd1.command).toBe('git status')
    expect(cmd1.decision).toBe('allow')
    expect(cmd1.stage).toBe('profile_allowlist')

    // Second command: uname -a -> denied by default (PR3 allows stat) with required_rule
    const cmd2 = reply.preflight!.commands[1]!
    expect(cmd2.command).toBe('uname -a')
    expect(cmd2.decision).toBe('deny')
    expect(cmd2.stage).toBe('default')
    expect(cmd2.required_rule).toBe('command(uname -a)')

    // Third command: JAVA_HOME=/opt/jdk ./gradlew build -> allowed (env prefix stripped)
    const cmd3 = reply.preflight!.commands[2]!
    expect(cmd3.command).toBe('JAVA_HOME=/opt/jdk ./gradlew build')
    expect(cmd3.decision).toBe('allow')
    expect(cmd3.stage).toBe('profile_allowlist')

    // Warning reports denied commands count
    expect(
      reply.warnings.some((w) =>
        w.includes('1 of 3 expected_commands would be denied; see preflight.commands'),
      ),
    ).toBe(true)
  })

  it('throws ValidationError when expected_commands is passed without dry_run', async () => {
    const raw = await startRaw({
      prompt: 'build project',
      profile: 'general_worker',
      expected_commands: ['git status'],
    })
    expect(raw.reply.isError).toBe(true)
    const err = raw.json as ErrorReply
    expect(err.error).toBe('VALIDATION')
    expect(err.detail?.field).toBe('expected_commands')
    expect(err.detail?.expected).toContain('dry_run')
  })
})

describe('model and effort preflight validation (M8)', () => {
  it('rejects an effort that conflicts with the suffix in the model name', async () => {
    const raw = await startRaw({
      prompt: 'run test',
      model: 'gemini-3.8-flash-high',
      effort: 'low',
      dry_run: true,
    })
    expect(raw.reply.isError).toBe(true)
    const err = raw.json as ErrorReply
    expect(err.error).toBe('VALIDATION')
    expect(err.detail?.field).toBe('effort')
    expect(err.detail?.expected).toBe(
      'omit effort for gemini-3.8-flash-high, or pass exactly "high" (the effort is part of the model name)',
    )
  })

  it('accepts the effort that matches the suffix (what the live harness sends)', async () => {
    const reply = await start({
      prompt: 'run test',
      model: 'gemini-3.7-flash-low',
      effort: 'low',
      dry_run: true,
    })
    expect(reply.dry_run).toBe(true)
    expect(reply.effective_config?.effort).toBe('low')
  })

  it('rejects any effort on a claude model', async () => {
    const raw = await startRaw({
      prompt: 'run test',
      model: 'claude-sonnet-4-6',
      effort: 'medium',
      dry_run: true,
    })
    expect(raw.reply.isError).toBe(true)
    const err = raw.json as ErrorReply
    expect(err.detail?.field).toBe('effort')
    expect(err.detail?.expected).toBe(
      'omit effort for claude-sonnet-4-6: agy does not accept --effort for this model',
    )
  })

  it('applies the suffix rule to an unmeasured model that carries one', async () => {
    const raw = await startRaw({
      prompt: 'run test',
      model: 'gemini-9.9-flash-medium',
      effort: 'high',
      dry_run: true,
    })
    expect(raw.reply.isError).toBe(true)
    expect((raw.json as ErrorReply).detail?.field).toBe('effort')
  })

  it('passes an unknown, unsuffixed model through for agy to judge', async () => {
    const reply = await start({
      prompt: 'run test',
      model: 'unobserved-custom-model',
      effort: 'low',
      dry_run: true,
    })
    expect(reply.dry_run).toBe(true)
    expect(reply.effective_config?.model).toBe('unobserved-custom-model')
    expect(reply.effective_config?.effort).toBe('low')
  })
})
