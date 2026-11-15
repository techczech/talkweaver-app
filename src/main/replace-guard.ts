// One rule for every writer that replaces a vault data file from a record it holds in memory (0.45,
// second Mac): when the file is on disk but cannot be read as what it should be (Git conflict markers
// from a sync, truncated or broken JSON, the wrong shape), it is not replaced. Its bytes stay exactly as
// they are, and the writer throws a refusal that names the file. A missing file is a first save and is
// allowed. Writers call this as the last step before their rename, with nothing awaited in between.
import { lstatSync, readFileSync } from 'node:fs'
import { hasGitConflictMarkers } from './conflict-copies.mjs'

export type ReplaceRefusalCode = 'git-conflict' | 'unreadable'

/** A replacement refused because the file on disk could not be read. `gitConflict` matches `isGitConflictError`. */
export class ReplaceRefusedError extends Error {
  readonly code: ReplaceRefusalCode
  readonly file: string
  readonly gitConflict: boolean
  constructor(code: ReplaceRefusalCode, message: string, file: string) {
    super(message)
    this.name = 'ReplaceRefusedError'
    this.code = code
    this.file = file
    this.gitConflict = code === 'git-conflict'
  }
}

export const isReplaceRefused = (error: unknown): error is ReplaceRefusedError =>
  error instanceof ReplaceRefusedError || (!!error && typeof error === 'object' && (error as { name?: unknown }).name === 'ReplaceRefusedError')

export type ReplaceWords = { conflict: (file: string) => string; unreadable: (file: string) => string }

/** What is on disk at `path`: null when nothing is there (or it is not a plain file, which its writer
 *  handles), else its text, or `unreadable` when it is there and cannot be read. */
function currentText(path: string): string | null | { unreadable: true } {
  try {
    if (!lstatSync(path).isFile()) return null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return { unreadable: true }
  }
  try { return readFileSync(path, 'utf8') } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : { unreadable: true }
  }
}

/**
 * Throws a `ReplaceRefusedError` when `path` holds a file that `readable` does not accept (Git markers are
 * always refused). Returns quietly when nothing is there or the file reads.
 */
export function refuseUnreadableReplace(path: string, readable: (text: string) => boolean, words: ReplaceWords): void {
  const text = currentText(path)
  if (text === null) return
  if (typeof text !== 'string') throw new ReplaceRefusedError('unreadable', words.unreadable(path), path)
  if (hasGitConflictMarkers(text)) throw new ReplaceRefusedError('git-conflict', words.conflict(path), path)
  if (!readable(text)) throw new ReplaceRefusedError('unreadable', words.unreadable(path), path)
}

/** A JSON object (not an array), or null when the text is not one. */
export function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch { return null }
}
