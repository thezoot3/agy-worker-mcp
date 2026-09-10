import { describe, expect, it } from 'vitest'

import { migrateBrokerResult } from '../../../src/broker/result.js'
import { ValidationError } from '../../../src/contract/errors.js'
import type { BrokerResult } from '../../../src/contract/types.js'

describe('broker-result.json version 4 migration', () => {
  it('a version 3 broker-result.json migrates to 4 with workspace.kind === "in_place", path equal to cwd, and changed_file_count equal to verification.changed_files.length', () => {
    const v3 = {
      schema_version: 3,
      job_id: 'job-v3-migration',
      cwd: '/test/workspace/cwd',
      verification: {
        blockers: [],
        expected_artifacts: [],
        changed_files: ['M src/index.ts', 'A src/new.ts'],
        warnings: [],
        contract_status: 'not_required',
        checked_at: 1000,
        verify: null,
      },
    } as unknown as BrokerResult

    const migrated = migrateBrokerResult(v3, '/test/workspace/broker-result.json')

    expect(migrated.schema_version).toBe(4)
    expect(migrated.workspace).toBeDefined()
    expect(migrated.workspace.kind).toBe('in_place')
    expect(migrated.workspace.path).toBe(v3.cwd)
    expect(migrated.workspace.branch).toBeNull()
    expect(migrated.workspace.base_commit).toBeNull()
    expect(migrated.workspace.head_commit).toBeNull()
    expect(migrated.workspace.committed).toBe(false)
    expect(migrated.workspace.changed_file_count).toBe(v3.verification.changed_files.length)
  })

  it('a version 5 file still throws', () => {
    const v5 = {
      schema_version: 5,
      job_id: 'job-v5-future',
      cwd: '/test/workspace/cwd',
      verification: {
        blockers: [],
        expected_artifacts: [],
        changed_files: [],
        warnings: [],
        contract_status: 'not_required',
        checked_at: 1000,
        verify: null,
      },
    } as unknown as BrokerResult

    expect(() => migrateBrokerResult(v5, '/test/workspace/broker-result.json')).toThrow(ValidationError)
  })
})
