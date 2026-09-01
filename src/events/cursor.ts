import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs'

/**
 * Cursors are byte offsets into `events.ndjson` (`docs/01` 결정 3).
 *
 * There is no shared state and no line index: a reader seeks, parses only complete
 * lines, and returns the offset just past the last complete one. A partially
 * written trailing line is simply not consumed yet, so a growing file is read
 * exactly once with no duplicates and no gaps.
 */

export interface CursorRead {
  /** Complete lines only, newline stripped. */
  lines: string[]
  /** Byte offset just past the last complete line. Feed this back next time. */
  nextCursor: number
  /** Cursor reached the current end of file. */
  eof: boolean
  /** `maxBytes` cut the read short; call again from `nextCursor`. */
  truncated: boolean
  /** File size when the read happened. */
  size: number
  /**
   * True when the last entry in `lines` is a single line that itself exceeded
   * `maxBytes` and was returned content-truncated so the cursor could still
   * advance. Absent (not just false) on every other read.
   */
  lineTruncated?: boolean
}

export interface ReadLinesOptions {
  /** Cap on bytes read in one call. Protects the response-size budget. */
  maxBytes?: number
  /** Cap on lines returned. */
  maxLines?: number
}

const NEWLINE = 0x0a

/** Scan forward from `from` (exclusive of any prior read) for a newline byte, chunked so an
 * enormous line is never loaded whole just to find its terminator. Returns -1 if none of
 * `[from, upTo)` contains one. */
function findNewlineFrom(fd: number, from: number, upTo: number): number {
  const chunkSize = 65536
  let pos = from
  const chunk = Buffer.alloc(chunkSize)
  while (pos < upTo) {
    const toRead = Math.min(chunkSize, upTo - pos)
    const n = readSync(fd, chunk, 0, toRead, pos)
    if (n <= 0) return -1
    const idx = chunk.subarray(0, n).indexOf(NEWLINE)
    if (idx !== -1) return pos + idx
    pos += n
  }
  return -1
}

/**
 * Read complete lines starting at `cursor`.
 *
 * A cursor past EOF (file truncated or replaced) resets to 0 rather than
 * throwing. Missing file is not an error: a job that has not written yet returns
 * an empty read at cursor 0.
 */
export function readLinesFrom(
  filePath: string,
  cursor: number,
  opts?: ReadLinesOptions,
): CursorRead {
  let size: number
  try {
    size = statSync(filePath).size
  } catch {
    return { lines: [], nextCursor: 0, eof: true, truncated: false, size: 0 }
  }

  let start = cursor < 0 || cursor > size ? 0 : cursor
  if (start === size) {
    return { lines: [], nextCursor: start, eof: true, truncated: false, size }
  }

  const maxBytes = opts?.maxBytes
  const cappedByBytes = maxBytes !== undefined && size - start > maxBytes
  const readEnd = cappedByBytes ? start + (maxBytes as number) : size
  const length = readEnd - start

  const fd = openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, start)

    let lastNl = -1
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i] === NEWLINE) {
        lastNl = i
        break
      }
    }

    if (lastNl === -1) {
      if (!cappedByBytes) {
        // Not capped and still no newline: a genuine trailing partial write.
        // Nothing consumed; the caller will see the rest once it lands.
        return { lines: [], nextCursor: start, eof: start === size, truncated: false, size }
      }

      // A single line longer than `maxBytes` (agy events routinely embed tool
      // output past 32KB). Without this branch `nextCursor` never advances past
      // it and every subsequent call repeats the same non-progressing window
      // forever (finding 4). Scan forward — beyond the capped window, but
      // bounded by the file's size at read time — for the line's real
      // terminator so the cursor can still move past it.
      const nlPos = findNewlineFrom(fd, readEnd, size)
      if (nlPos === -1) {
        // The oversized line has still not finished being written even past
        // the cap; still nothing to consume.
        return { lines: [], nextCursor: start, eof: false, truncated: true, size }
      }
      const lineText = buf.toString('utf8')
      const nextCursor = nlPos + 1
      return {
        lines: [lineText],
        nextCursor,
        eof: nextCursor === size,
        truncated: true,
        lineTruncated: true,
        size,
      }
    }

    const text = buf.subarray(0, lastNl + 1).toString('utf8')
    let lines = text.split('\n')
    lines.pop() // trailing '' from the final split on the terminating \n

    let nextCursor = start + lastNl + 1
    let truncatedByLines = false
    const maxLines = opts?.maxLines
    if (maxLines !== undefined && lines.length > maxLines) {
      const kept = lines.slice(0, maxLines)
      let bytes = 0
      for (const l of kept) bytes += Buffer.byteLength(l, 'utf8') + 1
      lines = kept
      nextCursor = start + bytes
      truncatedByLines = true
    }

    return {
      lines,
      nextCursor,
      eof: nextCursor === size,
      truncated: cappedByBytes || truncatedByLines,
      size,
    }
  } finally {
    closeSync(fd)
  }
}

/** Read just the first complete line. The gate uses this to grab `conversation_id`. */
export function readFirstLine(filePath: string): string | null {
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return null
  }
  try {
    const size = fstatSync(fd).size
    if (size === 0) return null

    let offset = 0
    let buf = Buffer.alloc(0)
    let chunkSize = 4096

    while (offset < size) {
      const toRead = Math.min(chunkSize, size - offset)
      const chunk = Buffer.alloc(toRead)
      readSync(fd, chunk, 0, toRead, offset)
      buf = Buffer.concat([buf, chunk])
      offset += toRead

      const nlIdx = buf.indexOf(NEWLINE)
      if (nlIdx !== -1) {
        return buf.subarray(0, nlIdx).toString('utf8')
      }
      chunkSize *= 2
    }
    // Reached EOF without ever seeing a newline: the only line is incomplete.
    return null
  } finally {
    closeSync(fd)
  }
}

/**
 * Last `n` complete lines, read backwards from the end so a large file is never
 * fully loaded. Mutually exclusive with a cursor read by convention — the tools
 * reject being given both.
 */
export function tailLines(filePath: string, n: number, maxBytes?: number): string[] {
  if (n <= 0) return []
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return []
  }
  try {
    const size = fstatSync(fd).size
    if (size === 0) return []
    const cap = maxBytes !== undefined && maxBytes > 0 ? Math.min(maxBytes, size) : size

    let windowSize = Math.min(size, 4096)
    for (;;) {
      const start = Math.max(0, size - windowSize)
      const length = size - start
      const buf = Buffer.alloc(length)
      readSync(fd, buf, 0, length, start)
      const text = buf.toString('utf8')

      let parts = text.split('\n')
      if (start > 0) parts.shift() // drop a possibly-partial leading line
      if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop() // trailing \n

      if (parts.length >= n || start === 0 || windowSize >= cap) {
        return parts.slice(-n)
      }
      windowSize = Math.min(size, windowSize * 2, cap)
    }
  } finally {
    closeSync(fd)
  }
}
