import { appendFileSync, closeSync, openSync, readSync, statSync, writeFileSync } from 'fs'

/**
 * A small append-only log file for one main-process concern.
 *
 * The packaged app has no console: `console.log` from the main process goes nowhere a user can
 * reach, and `tw-main-errors.log` only records unhandled rejections. That is why the 2026-09-15
 * thumbnail crash, and the blank-card regression that followed it, both had to be diagnosed by
 * inference from crash reports and screenshots. A lane that makes decisions on its own (defer,
 * skip, evict) has to be able to say what it did.
 *
 * Bounded by rewriting rather than rotating: one file, easy to ask someone to send.
 */
export interface AppendLogOptions {
  /** Rewrite once the file passes this size. */
  maxBytes?: number
  /** How much of the tail to keep when it does. */
  keepBytes?: number
  /** Injected for tests; defaults to the real clock. */
  now?: () => Date
}

/** `[2026-09-15T08:35:01.123Z] message` — one line, newline-terminated. */
export function formatLogLine(message: string, at: Date = new Date()): string {
  return `[${at.toISOString()}] ${String(message).replace(/[\r\n]+/g, ' ')}\n`
}

/**
 * Keep the last `keepBytes` of `text`, starting at a line boundary so the file never opens
 * mid-line, and mark the cut so a reader knows the history was trimmed rather than lost to a bug.
 */
export function truncateLogText(text: string, keepBytes: number): string {
  if (text.length <= keepBytes) return text
  const tail = text.slice(text.length - keepBytes)
  const firstBreak = tail.indexOf('\n')
  const whole = firstBreak < 0 ? tail : tail.slice(firstBreak + 1)
  return `[log truncated to the last ${keepBytes} bytes]\n` + whole
}

/**
 * Append `text` to `filePath` verbatim, then rewrite the file to its tail once it passes
 * `maxBytes`. Never throws — a full disk, a missing directory and a read-only volume are all
 * "no log", not "no app".
 */
export function appendBounded(filePath: string, text: string, options: AppendLogOptions = {}): void {
  const maxBytes = options.maxBytes ?? 1024 * 1024
  const keepBytes = options.keepBytes ?? 512 * 1024
  try {
    appendFileSync(filePath, text)
    const size = statSync(filePath).size
    if (size > maxBytes) writeFileSync(filePath, readLogTail(filePath, size, keepBytes))
  } catch { /* a log that throws is worse than no log */ }
}

/**
 * The last `keepBytes` of the file as `truncateLogText` would keep them, reading only that tail:
 * a log that has already grown past V8's maximum string length (an unbounded log from before this
 * bound existed) could never be read whole, and so would never be trimmed.
 */
export function readLogTail(filePath: string, size: number, keepBytes: number): string {
  const length = Math.min(size, keepBytes)
  const buffer = Buffer.alloc(length)
  const fd = openSync(filePath, 'r')
  try {
    let read = 0
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, size - length + read)
      if (n <= 0) break
      read += n
    }
  } finally { closeSync(fd) }
  if (size <= keepBytes) return buffer.toString('utf8')
  const tail = buffer.toString('utf8')
  const firstBreak = tail.indexOf('\n')
  const whole = firstBreak < 0 ? tail : tail.slice(firstBreak + 1)
  return `[log truncated to the last ${keepBytes} bytes]\n` + whole
}

export function createAppendLog(filePath: string, options: AppendLogOptions = {}): (message: string) => void {
  const now = options.now ?? (() => new Date())
  return (message: string): void => {
    appendBounded(filePath, formatLogLine(message, now()), options)
  }
}

/** A blank line, then `[iso] kind: stack` — the stack keeps its own line breaks. */
export function formatErrorEntry(kind: string, err: unknown, at: Date = new Date()): string {
  const e = err as Error | undefined
  let detail: string
  try { detail = e?.stack || e?.message || String(err) } catch { detail = '(unprintable error)' }
  return `\n[${at.toISOString()}] ${kind}: ${detail}\n`
}

/**
 * The bounded log behind `tw-main-errors.log`. The path is resolved on every write, not when the
 * log is created, because the process handlers that use it are installed before app ready: if
 * the path cannot be resolved yet (or ever), that entry is skipped and nothing throws.
 */
export function createErrorLog(
  resolveFilePath: () => string,
  options: AppendLogOptions = {},
): (kind: string, err: unknown) => void {
  const now = options.now ?? (() => new Date())
  return (kind: string, err: unknown): void => {
    try {
      appendBounded(resolveFilePath(), formatErrorEntry(kind, err, now()), options)
    } catch { /* path not resolvable yet — the caller's console.error still fired */ }
  }
}
