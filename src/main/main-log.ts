import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'fs'

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

export function createAppendLog(filePath: string, options: AppendLogOptions = {}): (message: string) => void {
  const maxBytes = options.maxBytes ?? 1024 * 1024
  const keepBytes = options.keepBytes ?? 512 * 1024
  const now = options.now ?? (() => new Date())
  return (message: string): void => {
    // Logging must never be able to take the app down — a full disk, a missing userData
    // directory and a read-only volume are all "no log", not "no app".
    try {
      appendFileSync(filePath, formatLogLine(message, now()))
      if (existsSync(filePath) && statSync(filePath).size > maxBytes) {
        writeFileSync(filePath, truncateLogText(readFileSync(filePath, 'utf8'), keepBytes))
      }
    } catch { /* a log that throws is worse than no log */ }
  }
}
