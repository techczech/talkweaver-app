// One writer for talk files (spec 2026-09-27, D2). Every main-process write of a talk outline goes
// through writeTalkOutline, which decides who writes:
//
//   - a live editor window has the file (any alias; outline-identity.ts): main does NOT write. It
//     reads that window's buffer, computes the new text and asks the window to apply it only while
//     the buffer is still what was read; the window saves through its own queue and replies once the
//     save is on disk. Same messages as "Add to talk" (outline:editor-request read / apply).
//   - no window has it: main takes the file's lock (one writer at a time per real file, keyed by
//     outlineIdentity) and writes the file IN PLACE (writeTalkFileInPlace): the new bytes are staged
//     in a temp file beside it and fsynced, then written into the existing inode (truncate, write,
//     fsync), then the temp is removed. The inode never changes, so hard links stay one file, the
//     identity key never moves, and mode bits, ACLs and extended attributes are kept. A read-only
//     target is refused untouched.
//
// Two origins never route: 'editor' (the renderer's own queued save — it IS the buffer) and
// 'migration' (the open-time format migration, which runs before the buffer exists). They take the
// lock and write to disk. The editor route never holds the lock, so an editor save waiting for the
// lock can never be waiting on a writer that is itself waiting on that editor.
//
// Every other (routed) origin first joins the file's ROUTE QUEUE (one chain per real path, then per
// identity key; its own map — never the disk lock): routed writers run one at a time per file, so two of them never read
// the same buffer and race to apply it. The disk lock cannot serve for this: a routed writer on the
// editor route waits for the editor's commit, and that commit is the editor's own save, which takes
// the disk lock — holding the disk lock while waiting for it would deadlock. Lock order is always
// route queue, then disk lock (a closed talk's routed write takes the disk lock inside its turn);
// nothing takes them the other way round. On the editor route a function-shaped `next` whose apply is
// refused because the buffer moved (the person typed between the read and the apply) is worked out
// again against a fresh read, at most ROUTED_RETRIES more times; a whole-text `next` is never re-applied
// over a buffer that moved (it would overwrite the typing), so it refuses.
import { randomBytes } from 'crypto'
import { constants as fsConstants, type Stats } from 'fs'
import { access, lstat, open, readFile, stat, unlink, type FileHandle } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { canonicalOutlinePath, outlineIdentity, type OutlineIdentity } from './outline-identity.ts'
import { CHANGED_ON_DISK_MESSAGE, PARTIAL_WRITE_MESSAGE, REMOVED_ON_DISK_MESSAGE, type OutlineDiskChange } from '../shared/outline-disk-change.ts'

export type TalkWriteOrigin =
  | 'editor' | 'migration' | 'create-talk' | 'tags' | 'frontmatter' | 'ledger-detach' | 'ledger-adopt'
  | 'ledger-merge' | 'publish-handout' | 'publish-flush' | 'optimize-images' | 'retitle' | 'strip-published'
  | 'share-for-comments' | 'conflict-merge'

/** The whole new text, or a transformation of the talk's current text (the open buffer when an editor
 *  has the talk, else the file). A transformation that returns its input writes nothing. A thrown
 *  error is a refusal with that message. */
export type TalkWriteNext = string | ((current: string) => string)

export type TalkWriteResult =
  | { ok: true; via: 'disk' | 'editor'; changed: boolean; text: string }
  /** `changedOnDisk`: refused by the external-change guard (the file changed since the app read it). */
  | { ok: false; error: string; changedOnDisk?: OutlineDiskChange }

/** The external-change guard (outline-disk-guard.ts), as the writer sees it. Every call runs under the
 *  file's lock. */
export interface TalkDiskGuard {
  tracks(realPath: string): boolean
  /** Before a whole-text write of `incoming`: the difference when the file on disk (`diskText`; null =
   *  missing) is not the editor's version, else null. */
  conflict(realPath: string, diskText: string | null, incoming: string): Promise<OutlineDiskChange | null>
  /** The editor's text is now on disk: the new baseline (the app's own saves are never changes). */
  written(realPath: string, text: string): void
  /** A save failed after the file was truncated; `tempPath` holds the full text. */
  failedHalfway(realPath: string, tempPath: string): OutlineDiskChange | null
}

/** The error writeTalkFileInPlace throws when it failed after truncating the file: `partialTemp` is the
 *  temp file kept with the full text. */
export type PartialWriteError = Error & { partialTemp: string }

/** An editor window's buffer for one talk (index.ts editorOutlineDocument). `read` may throw with a
 *  message the person should see; `commit` applies `next` only while the buffer is still `base` and
 *  resolves ok once the editor's save has reached disk, with `text`: the exact text that save wrote
 *  (`next` with any ids the save stamped). */
export interface EditorBuffer {
  read(): Promise<string>
  /** `origin` words the window's refusal ("the tags", "the slide"…). `moved`: refused only because
   *  the buffer is no longer `base` (nothing was applied; a fresh read may succeed). */
  commit(base: string, next: string, origin?: TalkWriteOrigin): Promise<{ ok: true; text?: string } | { ok: false; error: string; moved?: boolean }>
}

export interface TalkWriterRoutes {
  /** The live editor window's buffer for this file (matched by identity), or null. */
  editorBufferFor(outlinePath: string): EditorBuffer | null
  /** Called once per finished write attempt (trace). */
  trace?(event: { outlinePath: string; origin: TalkWriteOrigin; result: TalkWriteResult }): void
  /** The external-change guard; absent = no guard (tests of the writer alone). */
  diskGuard?: TalkDiskGuard
  /** Test seam: runs inside every in-place write of the disk route, after the file is truncated and
   *  before the bytes go in (a throw there is a save that failed halfway). Never set by the app. */
  afterTruncate?(realPath: string): Promise<void>
}

export interface TalkWriteOptions {
  /** Editor route only: runs with the new text just before the window is asked to apply it (e.g.
   *  ledger lineage hints that must be recorded before the editor's own save ledgers the text). */
  beforeEditorApply?(next: string): void | Promise<void>
  /** Save even when a transformation returns its input: the editor saves its buffer as it stands,
   *  or the file is rewritten with its own text. */
  force?: boolean
  /** Publish's flush, editor route only: the buffer is saved only when it differs from the file (read
   *  under the file's lock); a buffer that equals the file is returned with no write. Unsaved changes
   *  over a read-only file refuse. A closed talk's file is read, never rewritten. */
  flushUnsaved?: boolean
}

let routes: TalkWriterRoutes = { editorBufferFor: () => null }

/** Wires the editor-window lookup (index.ts at startup; tests pass a fake registry). */
export function configureTalkWriter(next: TalkWriterRoutes): void {
  routes = next
}

const DIRECT_ORIGINS: ReadonlySet<TalkWriteOrigin> = new Set(['editor', 'migration'])

// One promise chain per lock key, the same shape as the renderer's save queue. Two kinds of key share
// the map: `path:<real path>` and `inode:<identity key>`.
const locks = new Map<string, Promise<void>>()
function chainOn<T>(chains: Map<string, Promise<void>>, key: string, work: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(work)
  const tail = run.then(() => undefined, () => undefined)
  chains.set(key, tail)
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key) })
  return run
}
function withKeyLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  return chainOn(locks, key, work)
}

// The route queue (see the header): its own map, never the disk lock's; routed writes to one file run
// one at a time, in the order they were made.
const routeQueues = new Map<string, Promise<void>>()
const ROUTED_RETRIES = 3
// Before each retry, a short pause that grows (20, 60, 180 ms): the buffer moved because the person
// is typing, and a read taken in a pause in their typing is the one that can be applied. Imperceptible
// for a tag or a stamp; the route queue keeps later writes behind this one meanwhile.
export const retryPause = (attempt: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20 * 3 ** attempt))

const LOCK_ATTEMPTS = 5
const RETRY_PATH = Symbol('retry-path')
const RETRY_INODE = Symbol('retry-inode')

/**
 * Runs `work` holding `outlinePath`'s file lock — the lock every writeTalkOutline disk write takes.
 * Exported for a writer that keeps its own last look at the file (instant-slide-insert.ts).
 *
 * Two levels, always taken in this order (so no two writers can wait on each other in a cycle):
 *   1. the REAL PATH lock — serialises every writer that names this file, whatever its inode is now:
 *      writes queued before the file exists and after it is created, and writes on either side of an
 *      outside tool replacing it by rename, all queue on one chain;
 *   2. the INODE lock (outlineIdentity key) — serialises hard-link aliases, which have different paths.
 * Under the inode lock the identity is resolved again; if the path or the inode moved while this
 * writer waited, it lets go and takes the locks for what the file is now (at most LOCK_ATTEMPTS
 * times, then refuses). `work` gets the identity it holds, so the write can check it opened that inode.
 */
export async function withTalkFileLock<T>(outlinePath: string, work: (held: OutlineIdentity) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    const pathKey = canonicalOutlinePath(outlinePath)
    const outcome = await withKeyLock(`path:${pathKey}`, async () => {
      for (let inner = 0; inner < LOCK_ATTEMPTS; inner += 1) {
        const inodeKey = outlineIdentity(outlinePath).key
        const held = await withKeyLock(`inode:${inodeKey}`, async () => {
          const now = outlineIdentity(outlinePath)
          if (now.realPath !== pathKey) return RETRY_PATH
          if (now.key !== inodeKey) return RETRY_INODE
          return { value: await work(now) }
        })
        if (held !== RETRY_INODE) return held
      }
      return RETRY_PATH
    })
    if (outcome !== RETRY_PATH) return outcome.value
  }
  throw new Error('The talk’s file kept changing (moved or replaced by another program) while waiting to be written. Nothing was written; try again.')
}

// ── Data-loss backstop (2026-07-05) ─────────────────────────────────────────────────────────
// A structurally-empty payload is one that is empty/whitespace-only, OR carries neither YAML
// frontmatter NOR any Markdown heading — i.e. it is not a real outline. An outline never legitimately
// becomes empty: even a deck with every slide deleted keeps its frontmatter. So the ONLY thing this
// predicate ever catches is a bug about to overwrite real work — never a genuine save. talk:write-
// outline applies it to the editor's saves (index.ts); writeTalkOutline applies it to every other
// origin, with the same message.
export function isStructurallyEmptyOutline(content: string): boolean {
  if (typeof content !== 'string' || content.trim() === '') return true
  const trimmed = content.replace(/^\uFEFF/, '').trimStart()
  const hasFrontmatter = /^---\s*(?:\n|$)/.test(trimmed)
  const hasHeading = /^#{1,6}[ \t]/m.test(content)
  return !hasFrontmatter && !hasHeading
}

/** The backstop's refusal message (and console warning) for an empty write over real content. */
export function emptyOverNonemptyMessage(outlinePath: string, incoming: string, existing: string): string {
  return `[write-outline] REFUSED empty-over-nonempty write to ${outlinePath} — ` +
    `incoming ${incoming?.length ?? 0} bytes vs existing ${existing.length} bytes (data-loss backstop)`
}

function emptyOverNonempty(outlinePath: string, origin: TalkWriteOrigin, incoming: string, existing: string): string | null {
  if (origin === 'editor' || !isStructurallyEmptyOutline(incoming) || existing.trim() === '') return null
  const warning = emptyOverNonemptyMessage(outlinePath, incoming, existing)
  console.warn(warning)
  return warning
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** The talk's current text: the open editor's buffer when a window has it, else the file. Throws
 *  (with a message the person should see) when neither can be read. */
export async function readTalkOutline(outlinePath: string): Promise<string> {
  const buffer = routes.editorBufferFor(outlinePath)
  return buffer ? buffer.read() : readFile(canonicalOutlinePath(outlinePath), 'utf8')
}

/**
 * Writes `text` into the file at `realPath` in place, keeping its inode. The bytes are first staged in
 * a temp file beside it and fsynced; `beforeCopy` (optional) then gets a last look and may abort
 * (false: nothing written, the temp removed); then the target is truncated, written and fsynced, and
 * the temp removed. A read-only target and a dangling link are refused before anything is staged. If
 * the copy fails after the target was truncated, the temp is KEPT as the only whole copy and the error
 * names it (it is never cleaned up automatically). The caller holds the file's lock.
 *
 * Replacement by another program: `expectKey` is the identity the caller's lock holds. The inode the
 * write opens must be that one, and after the write the path must still name it; otherwise the write
 * refuses with "replaced while writing" (it may have landed on an inode the path no longer names).
 * An outside replacement DURING the write cannot be prevented without OS file locks (which many
 * cloud sync clients do not honour); detecting it and never reporting such a write as done is the
 * contract. `afterCopy` is a test seam that runs after the bytes are in, before that last check.
 */
export async function writeTalkFileInPlace(
  realPath: string,
  text: string,
  hooks: { beforeCopy?: () => Promise<boolean>; expectKey?: string; afterCopy?: () => Promise<void>; afterTruncate?: () => Promise<void> } = {},
): Promise<'written' | 'aborted'> {
  let previous: Stats | null = null
  try { previous = await lstat(realPath) } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
  }
  // Only a dangling link lstat's as a link here (canonicalOutlinePath resolved every live one).
  if (previous?.isSymbolicLink()) throw new Error(`The outline ${realPath} is a link to a file that does not exist.`)
  if (previous) await access(realPath, fsConstants.W_OK)
  const bytes = Buffer.from(text, 'utf8')
  const temp = join(dirname(realPath), `.${basename(realPath)}.${randomBytes(6).toString('hex')}.tw-write`)
  let staged: FileHandle | null = null
  try {
    staged = await open(temp, 'wx', 0o600)
    await staged.writeFile(bytes)
    await staged.sync()
    await staged.close()
    staged = null
    if (hooks.beforeCopy && !(await hooks.beforeCopy())) {
      await unlink(temp).catch(() => undefined)
      return 'aborted'
    }
  } catch (error) {
    if (staged) await staged.close().catch(() => undefined)
    await unlink(temp).catch(() => undefined)
    throw error
  }
  const replaced = (): Error => new Error('The talk’s file was replaced while writing (by another program). This change was not saved; try again.')
  let target: FileHandle | null = null
  let truncated = false
  let opened = ''
  try {
    target = await open(realPath, previous ? 'r+' : 'wx', 0o666)
    const st = await target.stat()
    opened = `${st.dev}:${st.ino}`
    if (previous && hooks.expectKey && opened !== hooks.expectKey) throw replaced()
    await target.truncate(0)
    truncated = true
    await hooks.afterTruncate?.()
    let offset = 0
    while (offset < bytes.length) {
      const { bytesWritten } = await target.write(bytes, offset, bytes.length - offset, offset)
      offset += bytesWritten
    }
    await target.sync()
    await target.close()
    target = null
  } catch (error) {
    if (target) await target.close().catch(() => undefined)
    if (!truncated) await unlink(temp).catch(() => undefined)
    if (!truncated) throw error
    const partial = new Error(`${message(error)} — the outline may be incomplete; its full text is kept in ${temp} (rename that file over the outline by hand to recover it)`) as PartialWriteError
    partial.partialTemp = temp
    throw partial
  }
  await unlink(temp).catch(() => undefined)
  await hooks.afterCopy?.()
  let now = ''
  try { const st = await stat(realPath); now = `${st.dev}:${st.ino}` } catch { /* gone: replaced (or removed) */ }
  if (now !== opened) throw replaced()
  if (!previous) {
    // A new file: make its directory entry durable too (best effort).
    try {
      const dir = await open(dirname(realPath), 'r')
      try { await dir.sync() } finally { await dir.close() }
    } catch { /* not every filesystem syncs a directory */ }
  }
  return 'written'
}

export const PUBLISH_READ_ONLY_UNSAVED = 'The talk has unsaved changes and its file is read-only, so nothing was published.'
const PUBLISH_EDITOR_UNREADABLE = 'The talk could not be read from its editor window, so nothing was published. Try again.'

// Publish's flush (opts.flushUnsaved): 'same' when the file already holds `buffer` (nothing to save),
// 'read-only' when it does not and cannot be written, else 'save'. The file is read under its lock,
// so an editor save in progress (truncate, then write) is never seen half-written.
async function flushNeed(outlinePath: string, buffer: string): Promise<'same' | 'save' | 'read-only'> {
  return withTalkFileLock(outlinePath, async (held) => {
    let disk: string | null = null
    try { disk = await readFile(held.realPath, 'utf8') } catch { /* absent: the save creates it */ }
    if (disk === buffer) return 'same'
    if (disk !== null) { try { await access(held.realPath, fsConstants.W_OK) } catch { return 'read-only' } }
    return 'save'
  })
}

async function viaEditor(outlinePath: string, buffer: EditorBuffer, next: TalkWriteNext, origin: TalkWriteOrigin, opts: TalkWriteOptions): Promise<TalkWriteResult> {
  // Retried only for a transformation with no side effect before the apply: a hook (the detach's
  // lineage hint) must run once, for the text that lands.
  const retries = typeof next === 'function' && !opts.beforeEditorApply ? ROUTED_RETRIES : 0
  for (let attempt = 0; ; attempt += 1) {
    let base: string
    try { base = await buffer.read() } catch (error) { return { ok: false, error: opts.flushUnsaved ? PUBLISH_EDITOR_UNREADABLE : message(error) } }
    let text: string
    try { text = typeof next === 'function' ? next(base) : next } catch (error) { return { ok: false, error: message(error) } }
    if (typeof next === 'function' && text === base && opts.flushUnsaved) {
      if (base.trim() === '') return { ok: false, error: PUBLISH_EMPTY_TALK }
      let need: 'same' | 'save' | 'read-only'
      try { need = await flushNeed(outlinePath, base) } catch (error) { return { ok: false, error: message(error) } }
      if (need === 'same') return { ok: true, via: 'editor', changed: false, text: base }
      if (need === 'read-only') return { ok: false, error: PUBLISH_READ_ONLY_UNSAVED }
    } else if (typeof next === 'function' && text === base && !opts.force) return { ok: true, via: 'editor', changed: false, text }
    const empty = emptyOverNonempty(outlinePath, origin, text, base)
    if (empty) return { ok: false, error: empty }
    try { await opts.beforeEditorApply?.(text) } catch (error) { return { ok: false, error: message(error) } }
    const reply = await buffer.commit(base, text, origin)
    if (!reply.ok) {
      // The person typed between the read and the apply: work it out again against the buffer now.
      if (reply.moved && attempt < retries) { await retryPause(attempt); continue }
      return { ok: false, error: reply.error }
    }
    // The exact text the editor's save wrote (`text` with any ids it stamped), as the window reports
    // it — never a read of the file afterwards, which a later save (truncate, then write) can tear.
    return { ok: true, via: 'editor', changed: true, text: typeof reply.text === 'string' ? reply.text : text }
  }
}

async function viaDisk(outlinePath: string, next: TalkWriteNext, origin: TalkWriteOrigin, held: OutlineIdentity, opts: TalkWriteOptions): Promise<TalkWriteResult> {
  // `held` was resolved under the lock: a symlink retargeted meanwhile writes its new target.
  const realPath = held.realPath
  const guard = routes.diskGuard
  const tracked = !!guard?.tracks(realPath)
  // External-change guard: a WHOLE text (the editor's save, a text worked out elsewhere) is checked
  // against the version the editor holds. A transformation is not: it is worked out from the file as it
  // stands now, under the lock, so it can never overwrite what it has not seen (tags and frontmatter
  // from the talk list). The open-time migration is exempt (it re-reads the fresh bytes itself, before
  // the editor has them).
  const guarded = tracked && typeof next !== 'function' && origin !== 'migration'
  let text: string
  let current = ''
  let absent = false
  if (typeof next === 'function') {
    try { current = await readFile(realPath, 'utf8') } catch (error) { return { ok: false, error: message(error) } }
    try { text = next(current) } catch (error) { return { ok: false, error: message(error) } }
    if (text === current && !opts.force) return { ok: true, via: 'disk', changed: false, text }
  } else {
    text = next
    if (origin !== 'editor' || guarded) {
      // Only a missing file counts as missing. Any other read failure (no permission, busy, a cloud
      // placeholder that cannot be fetched offline) refuses: nothing is written unchecked.
      try { current = await readFile(realPath, 'utf8') } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          return { ok: false, error: `The talk’s file could not be read before saving (${(error as NodeJS.ErrnoException)?.code ?? 'error'}: ${message(error)}). Nothing was saved.` }
        }
        absent = true
      }
    }
  }
  if (guarded) {
    let change: OutlineDiskChange | null = null
    try { change = await guard!.conflict(realPath, absent ? null : current, text) } catch { /* the guard never blocks on its own failure */ }
    if (change) {
      const error = change.kind === 'removed' ? REMOVED_ON_DISK_MESSAGE : change.kind === 'partial' ? PARTIAL_WRITE_MESSAGE : CHANGED_ON_DISK_MESSAGE
      return { ok: false, error, changedOnDisk: change }
    }
  }
  const empty = emptyOverNonempty(outlinePath, origin, text, current)
  if (empty) return { ok: false, error: empty }
  try {
    await writeTalkFileInPlace(realPath, text, {
      expectKey: held.key,
      ...(routes.afterTruncate ? { afterTruncate: () => routes.afterTruncate!(realPath) } : {}),
    })
  } catch (error) {
    const partialTemp = (error as Partial<PartialWriteError>)?.partialTemp
    if (partialTemp && tracked) {
      // Failed halfway: the bar says so (never offering a Reload of the partial text) until Save again.
      let change: OutlineDiskChange | null = null
      try { change = guard!.failedHalfway(realPath, partialTemp) } catch { /* the guard never fails a write */ }
      if (change) return { ok: false, error: message(error), changedOnDisk: change }
    }
    return { ok: false, error: message(error) }
  }
  // Self-write: only the editor's own text moves the guard's baseline, recorded while this write holds
  // the lock, so the watcher event it causes finds the file unchanged. Any other writer's text is not in
  // the editor, so the editor must see it as a change.
  if (tracked && (origin === 'editor' || origin === 'migration')) {
    try { guard!.written(realPath, text) } catch { /* the guard never fails a write */ }
  }
  return { ok: true, via: 'disk', changed: true, text }
}

// One disk attempt under the file's lock, or ROUTE when a window has the talk (it may have opened
// while this write waited for the lock): then its buffer is the writer.
const ROUTE = Symbol('route')
function diskOnce(outlinePath: string, next: TalkWriteNext, origin: TalkWriteOrigin, opts: TalkWriteOptions): Promise<TalkWriteResult | typeof ROUTE> {
  return withTalkFileLock<TalkWriteResult | typeof ROUTE>(outlinePath, async (held) => {
    if (routes.editorBufferFor(outlinePath)) return ROUTE
    return viaDisk(outlinePath, next, origin, held, opts)
  })
}

async function write(outlinePath: string, next: TalkWriteNext, origin: TalkWriteOrigin, opts: TalkWriteOptions): Promise<TalkWriteResult> {
  if (DIRECT_ORIGINS.has(origin)) return withTalkFileLock(outlinePath, (held) => viaDisk(outlinePath, next, origin, held, opts))
  // A routed origin: one turn in the file's route queue, then the buffer if a window has the talk,
  // else the disk (under the disk lock, taken inside the turn — route queue first, always).
  // Two levels, like the disk lock and in the same order: the real path (so writes made before the file
  // exists queue with those made after), then, inside that turn, the identity key (so hard-link aliases
  // of one open talk queue together).
  return chainOn(routeQueues, `path:${canonicalOutlinePath(outlinePath)}`, () =>
    chainOn(routeQueues, `inode:${outlineIdentity(outlinePath).key}`, async () => {
      for (;;) {
        const buffer = routes.editorBufferFor(outlinePath)
        if (buffer) return viaEditor(outlinePath, buffer, next, origin, opts)
        const result = await diskOnce(outlinePath, next, origin, opts)
        if (result !== ROUTE) return result
      }
    }))
}

/** Writes a talk outline: through the live editor window that has the file, else in place on disk
 *  under the file's lock. Never throws. `result.text` is the text applied or written. */
export async function writeTalkOutline(
  outlinePath: string,
  next: TalkWriteNext,
  origin: TalkWriteOrigin,
  opts: TalkWriteOptions = {},
): Promise<TalkWriteResult> {
  let result: TalkWriteResult
  try { result = await write(outlinePath, next, origin, opts) } catch (error) { result = { ok: false, error: message(error) } }
  try { routes.trace?.({ outlinePath, origin, result }) } catch { /* trace only */ }
  return result
}

export const PUBLISH_EMPTY_TALK = 'The talk is empty, so nothing was published.'

/** Publish's flush (spec round 5, fix b; handout-built-from-the-buffer 2026-09-28): puts the talk's
 *  CURRENT text on disk before a publish and returns it (`result.text`) — the text the handout is
 *  built from and sealed. For an open talk that is the editor's buffer as it stands — never the text
 *  the renderer sent with the request, which can be older than the buffer: saved by the editor when
 *  it differs from the file (the text returned is exactly what that save wrote), else returned with
 *  no write. A closed talk's file is read, not rewritten. Empty or whitespace-only text is refused:
 *  it is never published or sealed. */
export async function flushTalkForPublish(outlinePath: string): Promise<TalkWriteResult> {
  const result = await writeTalkOutline(outlinePath, (current) => current, 'publish-flush', { flushUnsaved: true })
  if (result.ok && result.text.trim() === '') return { ok: false, error: PUBLISH_EMPTY_TALK }
  return result
}
