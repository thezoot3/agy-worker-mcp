import { describe, expect, it } from 'vitest'

import { classifyToolCall } from '../../../src/policy/tools.js'
import { canonicalize } from '../../../src/contract/paths.js'

const WS = '/abs/workspace'
const CWS = canonicalize(WS)

describe('classifyToolCall — the table in docs/permissions.md', () => {
  it('run_command: subject command(CommandLine), read/write Cwd, write also gets redirection targets', () => {
    const c = classifyToolCall('run_command', { CommandLine: 'printf hi > out.txt', Cwd: WS }, WS)
    expect(c.kind).toBe('subject')
    if (c.kind !== 'subject') throw new Error('unreachable')
    expect(c.subject).toEqual({ verb: 'command', value: 'printf hi > out.txt' })
    expect(c.read).toEqual([CWS])
    expect(c.write).toEqual([CWS, canonicalize(`${WS}/out.txt`)])
  })

  it('run_command: Cwd defaults to workspace when absent', () => {
    const c = classifyToolCall('run_command', { CommandLine: 'ls' }, WS)
    if (c.kind !== 'subject') throw new Error('unreachable')
    expect(c.read).toEqual([CWS])
    expect(c.write).toEqual([CWS])
  })

  it('run_command: missing CommandLine is unsupported, never throws', () => {
    const c = classifyToolCall('run_command', {}, WS)
    expect(c.kind).toBe('unsupported')
  })

  it('view_file: subject read_file(AbsolutePath), read only', () => {
    const c = classifyToolCall('view_file', { AbsolutePath: `${WS}/a.txt` }, WS)
    if (c.kind !== 'subject') throw new Error('unreachable')
    expect(c.subject).toEqual({ verb: 'read_file', value: canonicalize(`${WS}/a.txt`) })
    expect(c.read).toEqual([canonicalize(`${WS}/a.txt`)])
    expect(c.write).toEqual([])
  })

  it('view_file: missing AbsolutePath is unsupported', () => {
    const c = classifyToolCall('view_file', { path: `${WS}/a.txt` }, WS)
    expect(c.kind).toBe('unsupported')
  })

  it('view_file: non-string AbsolutePath is unsupported, not a crash', () => {
    const c = classifyToolCall('view_file', { AbsolutePath: 123 }, WS)
    expect(c.kind).toBe('unsupported')
  })

  it('list_dir: subject read_file(DirectoryPath), read only', () => {
    const c = classifyToolCall('list_dir', { DirectoryPath: WS }, WS)
    if (c.kind !== 'subject') throw new Error('unreachable')
    expect(c.subject.verb).toBe('read_file')
    expect(c.subject.value).toBe(CWS)
    expect(c.write).toEqual([])
  })

  it('find_by_name: subject read_file(SearchDirectory), read only', () => {
    const c = classifyToolCall('find_by_name', { Pattern: '*.txt', SearchDirectory: WS }, WS)
    if (c.kind !== 'subject') throw new Error('unreachable')
    expect(c.subject).toEqual({ verb: 'read_file', value: CWS })
    expect(c.read).toEqual([CWS])
  })

  it('grep_search: subject read_file(SearchPath), read only', () => {
    const c = classifyToolCall('grep_search', { Query: 'x', SearchPath: WS, MatchPerLine: true }, WS)
    if (c.kind !== 'subject') throw new Error('unreachable')
    expect(c.subject).toEqual({ verb: 'read_file', value: CWS })
    expect(c.read).toEqual([CWS])
  })

  it('write_to_file: subject write_file(TargetFile), write only', () => {
    const c = classifyToolCall('write_to_file', { TargetFile: `${WS}/b.txt`, CodeContent: 'x' }, WS)
    if (c.kind !== 'subject') throw new Error('unreachable')
    expect(c.subject).toEqual({ verb: 'write_file', value: canonicalize(`${WS}/b.txt`) })
    expect(c.read).toEqual([])
    expect(c.write).toEqual([canonicalize(`${WS}/b.txt`)])
  })

  it('replace_file_content: subject write_file(TargetFile), both read and write', () => {
    const c = classifyToolCall(
      'replace_file_content',
      { TargetFile: `${WS}/a.txt`, TargetContent: 'x', ReplacementContent: 'y' },
      WS,
    )
    if (c.kind !== 'subject') throw new Error('unreachable')
    expect(c.subject).toEqual({ verb: 'write_file', value: canonicalize(`${WS}/a.txt`) })
    expect(c.read).toEqual([canonicalize(`${WS}/a.txt`)])
    expect(c.write).toEqual([canonicalize(`${WS}/a.txt`)])
  })

  it('manage_task: control, regardless of its arguments', () => {
    expect(classifyToolCall('manage_task', { Action: 'status', TaskId: 'x/1' }, WS)).toEqual({ kind: 'control' })
    expect(classifyToolCall('manage_task', {}, WS)).toEqual({ kind: 'control' })
  })

  it('schedule: control, regardless of its arguments', () => {
    expect(classifyToolCall('schedule', { DurationSeconds: 60, Prompt: 'wait' }, WS)).toEqual({ kind: 'control' })
    expect(classifyToolCall('schedule', {}, WS)).toEqual({ kind: 'control' })
  })

  it.each(['define_subagent', 'invoke_subagent', 'manage_subagents', 'browser_subagent'])(
    '%s: unsupported with the M2 reason',
    (name) => {
      const c = classifyToolCall(name, {}, WS)
      expect(c.kind).toBe('unsupported')
      if (c.kind !== 'unsupported') throw new Error('unreachable')
      expect(c.reason).toContain('conversationId')
      expect(c.subagent).toBe(true)
    },
  )

  it('an unknown tool name is unsupported with the generic reason', () => {
    const c = classifyToolCall('sed_file', { TargetFile: 'x' }, WS)
    expect(c.kind).toBe('unsupported')
    if (c.kind !== 'unsupported') throw new Error('unreachable')
    expect(c.reason).not.toContain('conversationId')
    expect(c.subagent).toBe(false)
  })

  it('a relative path resolves against args.Cwd when present, else workspace', () => {
    const withCwd = classifyToolCall('view_file', { AbsolutePath: 'sub/a.txt', Cwd: `${WS}/sub2` }, WS)
    if (withCwd.kind !== 'subject') throw new Error('unreachable')
    expect(withCwd.subject.value).toBe(canonicalize(`${WS}/sub2/sub/a.txt`))

    const withoutCwd = classifyToolCall('view_file', { AbsolutePath: 'sub/a.txt' }, WS)
    if (withoutCwd.kind !== 'subject') throw new Error('unreachable')
    expect(withoutCwd.subject.value).toBe(canonicalize(`${WS}/sub/a.txt`))
  })
})
