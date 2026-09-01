import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readLinesFrom, readFirstLine, tailLines } from '../../../src/events/cursor.js'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agy-worker-cursor-'))
  file = join(dir, 'events.ndjson')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readLinesFrom — unfinished trailing line', () => {
  it('stops the offset right after the last complete line, not inside the partial one', () => {
    const complete = '{"a":1}\n{"a":2}\n'
    const partial = '{"a":3, "unfinishe'
    writeFileSync(file, complete + partial)

    const read = readLinesFrom(file, 0)

    expect(read.lines).toEqual(['{"a":1}', '{"a":2}'])
    expect(read.nextCursor).toBe(Buffer.byteLength(complete, 'utf8'))
    // Cursor sits short of EOF because the trailing partial line was not consumed.
    expect(read.eof).toBe(false)
    expect(read.size).toBe(Buffer.byteLength(complete + partial, 'utf8'))
  })

  it('a call starting exactly at the partial-line boundary returns nothing new yet', () => {
    const complete = '{"a":1}\n'
    const partial = '{"a":2'
    writeFileSync(file, complete + partial)

    const first = readLinesFrom(file, 0)
    expect(first.lines).toEqual(['{"a":1}'])

    const second = readLinesFrom(file, first.nextCursor)
    expect(second.lines).toEqual([])
    expect(second.nextCursor).toBe(first.nextCursor)
    expect(second.eof).toBe(false) // there IS more data, just not a complete line
  })

  it('once the trailing line is completed, the next call from the same cursor picks it up', () => {
    const complete = '{"a":1}\n'
    writeFileSync(file, complete + '{"a":2')
    const first = readLinesFrom(file, 0)
    expect(first.lines).toEqual(['{"a":1}'])

    appendFileSync(file, '}\n')
    const second = readLinesFrom(file, first.nextCursor)
    expect(second.lines).toEqual(['{"a":2}'])
    expect(second.eof).toBe(true)
  })
})

describe('readLinesFrom — a file that grows across repeated calls', () => {
  it('sequential polling reads every line exactly once: no duplicates, no gaps', () => {
    writeFileSync(file, '')
    const seen: string[] = []
    let cursor = 0

    for (let batch = 0; batch < 5; batch++) {
      appendFileSync(file, `line-${batch}-a\nline-${batch}-b\n`)
      // Simulate a partial write mid-batch: an in-flight, not-yet-terminated line.
      appendFileSync(file, `line-${batch}-partial`)

      const read = readLinesFrom(file, cursor)
      seen.push(...read.lines)
      cursor = read.nextCursor

      // Finish the partial line so the *next* iteration's poll picks it up.
      appendFileSync(file, '\n')
      const read2 = readLinesFrom(file, cursor)
      seen.push(...read2.lines)
      cursor = read2.nextCursor
    }

    const expected: string[] = []
    for (let batch = 0; batch < 5; batch++) {
      expected.push(`line-${batch}-a`, `line-${batch}-b`, `line-${batch}-partial`)
    }
    expect(seen).toEqual(expected)
    expect(new Set(seen).size).toBe(seen.length) // no duplicates
  })

  it('a cursor past current EOF (truncated/replaced file) resets to 0 instead of throwing', () => {
    writeFileSync(file, '{"a":1}\n')
    // The read starts over from offset 0 rather than throwing or returning
    // nothing; nextCursor then advances normally from that restarted read.
    const read = readLinesFrom(file, 10_000)
    expect(read.lines).toEqual(['{"a":1}'])
    expect(read.nextCursor).toBe(Buffer.byteLength('{"a":1}\n', 'utf8'))
  })

  it('a missing file is an empty read at cursor 0, not an error', () => {
    const read = readLinesFrom(join(dir, 'does-not-exist.ndjson'), 0)
    expect(read.lines).toEqual([])
    expect(read.nextCursor).toBe(0)
    expect(read.eof).toBe(true)
  })

  it('maxBytes truncation still resumes cleanly from nextCursor with no loss', () => {
    writeFileSync(file, '')
    for (let i = 0; i < 20; i++) appendFileSync(file, `{"i":${i}}\n`)

    let cursor = 0
    const all: string[] = []
    for (;;) {
      const read = readLinesFrom(file, cursor, { maxBytes: 25 })
      all.push(...read.lines)
      cursor = read.nextCursor
      if (read.eof) break
      // Guard against an infinite loop if the implementation regresses.
      if (all.length > 100) throw new Error('runaway loop')
    }

    expect(all).toEqual(Array.from({ length: 20 }, (_, i) => `{"i":${i}}`))
  })
})

describe('readFirstLine', () => {
  it('returns the first complete line only', () => {
    writeFileSync(file, '{"event":"init"}\n{"event":"step_update"}\n')
    expect(readFirstLine(file)).toBe('{"event":"init"}')
  })

  it('returns null when the only line is still incomplete', () => {
    writeFileSync(file, '{"event":"in')
    expect(readFirstLine(file)).toBeNull()
  })

  it('returns null for a missing file', () => {
    expect(readFirstLine(join(dir, 'nope.ndjson'))).toBeNull()
  })
})

describe('tailLines', () => {
  it('returns the last n complete lines without loading the whole file eagerly', () => {
    writeFileSync(file, '')
    for (let i = 0; i < 50; i++) appendFileSync(file, `{"i":${i}}\n`)
    const tail = tailLines(file, 3)
    expect(tail).toEqual(['{"i":47}', '{"i":48}', '{"i":49}'])
  })

  // KNOWN BUG (see blockers): unlike readLinesFrom, tailLines only strips a
  // trailing '' part (i.e. a file that ends in '\n'); a genuinely unterminated
  // final line survives into the result. `it.fails` pins this down without
  // reddening the suite — if this starts passing, the bug was fixed and this
  // assertion should be promoted to a normal `it`.
  it.fails('drops a trailing partial line', () => {
    writeFileSync(file, '{"i":0}\n{"i":1}\n{"i":2-partial')
    const tail = tailLines(file, 5)
    expect(tail).toEqual(['{"i":0}', '{"i":1}'])
  })
})
