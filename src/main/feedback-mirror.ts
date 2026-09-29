// Feedback rail (ticket 05): the feedback mirror. Every item the owner socket delivers is kept in
// `<talk>/feedback/<share-id>.jsonl`, so nothing depends on the Worker's lifetime; the rail reads
// this file, never the socket.
//
// Invariants:
//   - ONE serialised writer for every feedback file in the app: all writes run in order on one
//     chain.
//   - Append-only. An item is written once per itemId; a status change is a later line that
//     overrides.
//   - Each file is folded ONCE into an in-memory index (applyFeedbackLine), updated line by line on
//     every append; dedupe, summaries and lists read the index. The file is re-read only at first
//     use and when it changed under us (its size or mtime is not what our last write left).
//   - The file is the replay position's only source (FeedbackFold.replayFrom): an item counts as
//     received once its line is on disk, never before.
//   - The talk folder is never created: a feedback write for a talk folder that is gone (moved or
//     deleted) fails instead of resurrecting the old path. Only `feedback/` is created.
//   - A torn line (a crash mid-append) is skipped on read; the next append starts on a fresh line.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { isShareId } from '../shared/share-id.ts'
import type { AcceptRecord } from '../shared/feedback-accept.ts'
import {
  applyFeedbackLine, emptyFeedbackIndex, failedLine, foldView, itemLine, statusLine, syncedLine,
  type FeedbackFold, type FeedbackIndex, type FeedbackStatus, type WorkerFeedbackItem,
} from '../shared/feedback.ts'

export function feedbackFilePath(outlinePath: string, shareId: string): string {
  if (!isShareId(shareId)) throw new Error(`Not a share id: ${JSON.stringify(shareId)}`)
  return join(dirname(outlinePath), 'feedback', `${shareId}.jsonl`)
}

export interface FeedbackMirror {
  /** The file's fold (from the in-memory index; re-read only when the file changed under us). */
  read(path: string): FeedbackFold
  /** Append the items not already in the file; resolves to the ones written. */
  addItems(path: string, items: WorkerFeedbackItem[]): Promise<WorkerFeedbackItem[]>
  /** Append his status for an item (`edit`: what Accept changed, kept for Undo). False when the item
   *  is not in the file. */
  setStatus(path: string, itemId: string, status: FeedbackStatus, edit?: AcceptRecord | null): Promise<boolean>
  /** Record that the Worker confirmed a status. */
  markSynced(path: string, itemId: string, status: FeedbackStatus): Promise<void>
  /** Record that the Worker refused a status for good (it is not re-sent). */
  markFailed(path: string, itemId: string, status: FeedbackStatus, code: number): Promise<void>
  /** Settles once every queued write has run. */
  idle(): Promise<void>
  /** How many times a file was read and folded from disk (tests). */
  loads(): number
}

interface Entry {
  index: FeedbackIndex
  size: number
  mtimeMs: number
  endsWithNewline: boolean
}

export function createFeedbackMirror(options: { now?: () => number } = {}): FeedbackMirror {
  const now = options.now ?? (() => Date.now())
  const cache = new Map<string, Entry>()
  let loadCount = 0
  let chain: Promise<unknown> = Promise.resolve()

  function serial<T>(work: () => T): Promise<T> {
    const next = chain.then(work)
    chain = next.catch(() => {})
    return next
  }

  function stat(path: string): { size: number; mtimeMs: number } | null {
    try {
      const s = statSync(path)
      return { size: s.size, mtimeMs: s.mtimeMs }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /** The file's index: cached, re-folded from disk only when the file is not as we left it. */
  function entry(path: string): Entry {
    const onDisk = stat(path)
    const cached = cache.get(path)
    if (cached && (onDisk ? cached.size === onDisk.size && cached.mtimeMs === onDisk.mtimeMs : cached.size === 0)) return cached
    const index = emptyFeedbackIndex()
    let text = ''
    if (onDisk) {
      text = readFileSync(path, 'utf8')
      loadCount += 1
      for (const raw of text.split('\n')) applyFeedbackLine(index, raw)
    }
    const fresh: Entry = { index, size: onDisk?.size ?? 0, mtimeMs: onDisk?.mtimeMs ?? 0, endsWithNewline: !text || text.endsWith('\n') }
    cache.set(path, fresh)
    return fresh
  }

  function append(path: string, current: Entry, lines: string[]): void {
    if (!lines.length) return
    const talkDir = dirname(dirname(path))
    if (!existsSync(talkDir) || !statSync(talkDir).isDirectory()) throw new Error(`The talk folder is not there: ${talkDir}`)
    mkdirSync(dirname(path), { recursive: true })
    const lead = current.endsWithNewline ? '' : '\n'
    try {
      appendFileSync(path, lead + lines.join('\n') + '\n', 'utf8')
    } catch (error) {
      cache.delete(path) // a partial append: the next read folds what is really there
      throw error
    }
    for (const line of lines) applyFeedbackLine(current.index, line)
    const after = stat(path)
    current.size = after?.size ?? 0
    current.mtimeMs = after?.mtimeMs ?? 0
    current.endsWithNewline = true
  }

  return {
    read(path) {
      return foldView(entry(path).index)
    },

    addItems(path, items) {
      return serial(() => {
        const current = entry(path)
        const seen = new Set<string>()
        const fresh = items.filter((item) => {
          if (current.index.byId.has(item.itemId) || seen.has(item.itemId)) return false
          seen.add(item.itemId)
          return true
        })
        const at = now()
        append(path, current, fresh.map((item) => itemLine(item, at)))
        return fresh
      })
    },

    setStatus(path, itemId, status, edit) {
      return serial(() => {
        const current = entry(path)
        if (!current.index.byId.has(itemId)) return false
        append(path, current, [statusLine(itemId, status, now(), edit)])
        return true
      })
    },

    markSynced(path, itemId, status) {
      return serial(() => { append(path, entry(path), [syncedLine(itemId, status, now())]) })
    },

    markFailed(path, itemId, status, code) {
      return serial(() => { append(path, entry(path), [failedLine(itemId, status, code, now())]) })
    },

    async idle() {
      for (;;) {
        const current = chain
        await current
        if (current === chain) return
      }
    },

    loads: () => loadCount,
  }
}
