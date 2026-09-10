/**
 * `checkProcessIdentity` — the three-way liveness check `reconcile` relies on
 * to tell "the runner is gone" from "the runner is busy". The one regression
 * this pins: `ps` failing to run (fork-saturated machine, measured 2026-09-03
 * while a verify_command started vitest) must not read as `gone` while the pid
 * is demonstrably alive, because `gone` + no exit_code = `process_error`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const execFileSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return { ...real, execFileSync }
})

import { checkProcessIdentity } from '../../../src/runner/reap.js'

afterEach(() => {
  execFileSync.mockReset()
})

describe('checkProcessIdentity', () => {
  it('same: the pid is alive and ps returns the recorded token', () => {
    execFileSync.mockReturnValue('Tue Sep  2 00:16:43 2026\n')
    expect(checkProcessIdentity(process.pid, 'Tue Sep  2 00:16:43 2026')).toBe('same')
  })

  it('different: the pid is alive but ps returns another token (pid reuse)', () => {
    execFileSync.mockReturnValue('Wed Sep  3 09:00:00 2026\n')
    expect(checkProcessIdentity(process.pid, 'Tue Sep  2 00:16:43 2026')).toBe('different')
  })

  it('same, not gone: ps itself fails while the pid is still alive', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('spawnSync ps EAGAIN')
    })
    expect(checkProcessIdentity(process.pid, 'Tue Sep  2 00:16:43 2026')).toBe('same')
  })

  it('gone: the pid is not alive at all', () => {
    execFileSync.mockReturnValue('')
    // Above every platform's pid ceiling (macOS 99998, Linux default 4194304 - 1
    // is the ceiling itself), so kill(pid, 0) is ESRCH.
    expect(checkProcessIdentity(2 ** 22, 'x')).toBe('gone')
  })
})
