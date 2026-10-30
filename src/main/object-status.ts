// What an object card can say about the file it names (ADR-0042 card status; root plan 2026-10-28):
// present, missing, outside the talk's vault, a web address, or not a file reference at all.
//
// One channel, object:status(outlinePath, refs). It answers only the editor window that asks, and only
// for the talk that window has open (main's own record of it, window:claim-talk), never for a path the
// renderer names. Each reference is resolved as the compiler resolves media (a pooled `img-`/`vid-` id in
// the talk's vault pool, else a path relative to the talk's folder, URL-decoded), and is checked for
// containment in the folders the compiler may read the talk's media from (assetRootsFor: the vault that
// holds the talk, else the talk's folder) BEFORE anything is looked at on disk: a path outside them is
// answered "outside" without a stat. Only the file's own entry is looked at (lstat); no file is read, no
// folder is listed and no web address is fetched. A request is capped in count and length and stops at a
// time budget (the rest answer "unchecked"). A link inside the folders is followed only when its target
// is inside them too (pathStaysInsideAsync); a link that leaves them answers "outside".
//
// Off the event loop (review R4 of a222975a): every look at the disk is asynchronous (fs/promises, run
// on libuv's threads), so a slow or hung disk never stalls main. The time budget is a timer raced
// against the work: when it fires the answer is given at once (the rest "unchecked"; earlier views
// "unreadable") and no further look is started. Main's record of the window's talk is checked before
// and again after the work.
//
// A status is a fact for the card, never an authority: Open and Reveal still go through
// shell:open-path / shell:show-item-in-folder, which check the path again at the moment of the operation.
import { constants } from 'fs'
import { lstat, open, opendir, realpath } from 'fs/promises'
import { isAbsolute, join, resolve } from 'path'
import type { IpcMain } from 'electron'
import { pathStaysInsideAsync, underStop } from './path-containment.ts'
import { htmlPageImportSupportedOn } from './html-page-import-core.ts'
import { O_NOFOLLOW_ANY } from './live-page-capture-core.ts'
import { SERVED_POOL_NAME } from './image-search/vault-pictures.ts'
import {
  LIVE_PAGE_CAPTURES_DIR, MAX_CAPTURE_ENTRY_BYTES, MAX_CAPTURES_TOTAL, earlierCapturesFor, galleryFromEntries,
  isCaptureEntryName, normaliseCaptureUrl, parseCaptureEntry
} from '../../compiler/scripts/lib/live-page-captures.mjs'

export type ObjectStatusState = 'present' | 'missing' | 'outside' | 'remote' | 'invalid' | 'unchecked'

export interface ObjectRefStatus {
  ref: string
  state: ObjectStatusState
  /** For a present local file: its absolute path inside the allowed folders (for Open and Reveal). */
  path?: string
}

export type ObjectStatusAnswer =
  | { ok: true; statuses: ObjectRefStatus[] }
  | { ok: false; reason: 'not-current-talk' | 'no-vault' | 'invalid-input' }

export const MAX_STATUS_REFS = 200
export const MAX_STATUS_REF_LENGTH = 2048
export const STATUS_BUDGET_MS = 250

export interface ObjectStatusContext {
  /** The talk's folder. */
  talkDir: string
  /** The folders the compiler may read the talk's media from (assetRootsFor). */
  roots: readonly string[]
  /** The talk's own vault (its pool holds `img-`/`vid-` ids); undefined for a talk in no vault. */
  vaultRoot: string | undefined
}

export interface ObjectStatusFs {
  /** true: a plain file; false: something else; null: nothing there. Throws when it cannot be looked at. */
  isFile: (path: string) => Promise<boolean | null>
}

const isAbsent = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

const nodeFs: ObjectStatusFs = {
  isFile: async (path) => {
    try { return (await lstat(path)).isFile() } catch (error) { if (isAbsent(error)) return null; throw error }
  }
}

const TIMED_OUT = Symbol('timed out')
type Budget = { expired: () => boolean; race: <T>(work: Promise<T>) => Promise<T | typeof TIMED_OUT>; end: () => void }

/** A timer raced against the work: past it, the answer is given at once and no further look is started. */
function startBudget(ms: number): Budget {
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const reached = new Promise<typeof TIMED_OUT>((done) => { timer = setTimeout(() => { expired = true; done(TIMED_OUT) }, ms) })
  return {
    expired: () => expired,
    race: (work) => Promise.race([work, reached]),
    end: () => clearTimeout(timer)
  }
}

/** A pool id's file: `<vault>/_assets/<id>.<ext>`, `_assets` a plain folder and the file a plain file (no link followed), as containedPoolFile. */
async function poolFile(vaultRoot: string, id: string, exts: readonly string[], fs: ObjectStatusFs, stop: () => boolean): Promise<string | null> {
  const assetsDir = join(vaultRoot, '_assets')
  let folder
  try { folder = await underStop(stop, () => lstat(assetsDir)) } catch (error) { if (isAbsent(error)) return null; throw error }
  if (!folder.isDirectory()) return null
  for (const ext of exts) {
    const name = `${id}.${ext}`
    if (!SERVED_POOL_NAME.test(name)) continue
    const full = join(assetsDir, name)
    if (await underStop(stop, () => fs.isFile(full))) return full
  }
  return null
}

/**
 * The status of one reference as written in a talk. Pure apart from the containment check and
 * `fs.isFile` on a contained path; throws when the disk cannot be asked (the caller answers "unchecked").
 * No filesystem operation starts once `stop()` is true.
 */
export async function objectRefStatus(ref: unknown, ctx: ObjectStatusContext, fs: ObjectStatusFs = nodeFs, stop: () => boolean = () => false): Promise<ObjectRefStatus> {
  if (typeof ref !== 'string') return { ref: '', state: 'invalid' }
  const text = ref.trim()
  if (!text || text.length > MAX_STATUS_REF_LENGTH || text.includes('\0')) return { ref, state: 'invalid' }
  if (/^https?:\/\//i.test(text)) return { ref, state: 'remote' }
  if (/^data:/i.test(text)) return { ref, state: 'present' }
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return { ref, state: 'invalid' }
  if (/^(img|vid)-[0-9a-f]{7,}$/i.test(text)) {
    if (!ctx.vaultRoot) return { ref, state: 'missing' }
    const exts = /^vid-/i.test(text) ? ['mp4', 'jpg'] : ['webp', 'png', 'jpg', 'jpeg', 'gif']
    const file = await poolFile(ctx.vaultRoot, text, exts, fs, stop)
    return file ? { ref, state: 'present', path: file } : { ref, state: 'missing' }
  }
  let decoded = text.replace(/[?#].*$/, '')
  try { decoded = decodeURIComponent(decoded) } catch { /* keep as written, as the editor does */ }
  if (!decoded || decoded.includes('\0')) return { ref, state: 'invalid' }
  const candidate = isAbsolute(decoded) ? resolve(decoded) : resolve(ctx.talkDir, decoded)
  // The resolved real path (links followed, each checked inside the root): only that entry is looked at.
  let real: string | null = null
  for (const root of ctx.roots) {
    if (typeof root === 'string' && root) real = await pathStaysInsideAsync(root, candidate, false, stop)
    if (real) break
  }
  if (!real) return { ref, state: 'outside' }
  const isFile = await underStop(stop, () => fs.isFile(real))
  if (isFile === true) return { ref, state: 'present', path: candidate }
  return { ref, state: isFile === false ? 'invalid' : 'missing' }
}

export interface ObjectStatusDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  /** The talk the editor window with this webContents id has open, per main's own record. */
  currentTalkOf: (senderId: number) => string | null
  /** The status context for a talk; undefined when its folders are not available. */
  contextFor: (outlinePath: string) => ObjectStatusContext | undefined
  fs?: ObjectStatusFs
  /** The time budget in ms (tests); STATUS_BUDGET_MS otherwise. */
  budgetMs?: number
}

/** Answers one request (exported for tests; the handler below is a thin wrapper). */
export async function answerObjectStatus(senderId: number, outlinePath: unknown, refs: unknown, deps: Omit<ObjectStatusDeps, 'ipcMain'>): Promise<ObjectStatusAnswer> {
  if (typeof outlinePath !== 'string' || !Array.isArray(refs)) return { ok: false, reason: 'invalid-input' }
  const current = deps.currentTalkOf(senderId)
  if (!current || current !== outlinePath) return { ok: false, reason: 'not-current-talk' }
  const ctx = deps.contextFor(current)
  if (!ctx) return { ok: false, reason: 'no-vault' }
  const budget = startBudget(deps.budgetMs ?? STATUS_BUDGET_MS)
  const seen = new Set<string>()
  const statuses: ObjectRefStatus[] = []
  try {
    for (const ref of refs.slice(0, MAX_STATUS_REFS)) {
      if (typeof ref !== 'string' || seen.has(ref)) continue
      seen.add(ref)
      if (budget.expired()) { statuses.push({ ref, state: 'unchecked' }); continue }
      const answer = await budget.race(objectRefStatus(ref, ctx, deps.fs, budget.expired).catch((): ObjectRefStatus => ({ ref, state: 'unchecked' })))
      statuses.push(answer === TIMED_OUT ? { ref, state: 'unchecked' } : answer)
    }
  } finally { budget.end() }
  if (deps.currentTalkOf(senderId) !== outlinePath) return { ok: false, reason: 'not-current-talk' }
  return { ok: true, statuses }
}

export type EarlierView = { image: string; capturedAt: string; mode?: 'page' }
export type EarlierViewsAnswer =
  | { ok: true; views: EarlierView[] }
  | { ok: false; reason: 'not-current-talk' | 'no-vault' | 'invalid-input' | 'unreadable' }

export interface EarlierViewsFs {
  /**
   * The saved-view record names in `dir`, enumerating no further than `cap` + 1 of them; null when there
   * is no such folder. Throws when the folder is a link or cannot be listed, or once `stop()` is true.
   */
  list: (dir: string, cap: number, stop: () => boolean) => Promise<string[] | null>
  /**
   * The record's text; null when it is not a record (gone, a link, not a plain file, over `maxBytes`).
   * Throws when it could not be read (no permission, an I/O error, a link appeared on its path), or once
   * `stop()` is true: the list would be incomplete.
   */
  read: (path: string, maxBytes: number, stop: () => boolean) => Promise<string | null>
}

const code = (error: unknown): unknown => (error as { code?: unknown } | null)?.code

const nodeEarlierFs: EarlierViewsFs = {
  list: async (dir, cap, stop) => {
    let info
    try { info = await underStop(stop, () => lstat(dir)) } catch (error) { if (isAbsent(error)) return null; throw error }
    if (info.isSymbolicLink()) throw new Error('the saved-view folder is a link')
    if (!info.isDirectory()) return null
    // Names only: what each name holds is read by `read` below, under the kernel's rule.
    if (stop()) throw new Error('stopped')
    const folder = await opendir(dir)
    const names: string[] = []
    try {
      if (stop()) throw new Error('stopped')
      for await (const entry of folder) {
        if (stop()) throw new Error('stopped')
        if (isCaptureEntryName(entry.name)) names.push(entry.name)
        if (names.length > cap) break
      }
    } catch (error) { await folder.close().catch(() => {}); throw error }
    return names
  },
  read: async (path, maxBytes, stop) => {
    // The one open that consumes bytes: O_NOFOLLOW_ANY makes the kernel refuse it if ANY component of
    // the (real) path is a link at that moment, so a folder swapped for a link after any check cannot
    // redirect it outside the talk. A plain link record is left out (never followed); a link that
    // appears on the path between the look and the open fails the whole list.
    let info
    try { info = await underStop(stop, () => lstat(path)) } catch (error) { if (isAbsent(error)) return null; throw error }
    if (!info.isFile()) return null
    if (stop()) throw new Error('stopped')
    let file
    try {
      file = await open(path, constants.O_RDONLY | O_NOFOLLOW_ANY | constants.O_NONBLOCK)
    } catch (error) {
      if (isAbsent(error)) return null
      throw error
    }
    try {
      const held = file
      const st = await underStop(stop, () => held.stat())
      if (!st.isFile() || st.size > maxBytes) return null
      const buffer = Buffer.alloc(maxBytes + 1)
      const { bytesRead } = await underStop(stop, () => held.read(buffer, 0, maxBytes + 1, 0))
      return bytesRead > maxBytes ? null : buffer.subarray(0, bytesRead).toString('utf8')
    } finally { await file.close().catch(() => {}) }
  }
}

/**
 * The views of a web page saved before {capture} lines existed (the compiler's compatibility listing,
 * earlierCapturesFor), for "Place earlier views" on a page card: read from the talk's own saved-view
 * folder (records the capture writer made: plain files inside the talk's folder, within the writer's
 * size and count limits). Review of 03756f0f: each record's bytes come from one open the kernel refuses
 * if any folder on the talk's real path is a link at that moment (O_NOFOLLOW_ANY, as the capture window
 * reads its pictures), never from a path checked earlier; a record that is itself a link is left out, a
 * saved-view folder that is a link answers "unreadable", and on a system without that open nothing is
 * read ("unreadable"). The budget stops the work itself: no filesystem operation starts after it. Only the public fields go back (the picture's
 * talk-relative path, its date, its kind). The list is all or nothing (review R3 of a222975a): a record
 * that is not a saved view (out of shape, too large, a link) is not one and is left out,
 * but a record that could not be read, a folder that could not be listed, more records than the limit or
 * the budget running out answers "unreadable": a partial list placed on the slide would hide the views
 * it missed.
 */
export async function answerEarlierViews(
  senderId: number,
  outlinePath: unknown,
  pageUrl: unknown,
  deps: Omit<ObjectStatusDeps, 'ipcMain'> & { earlierFs?: EarlierViewsFs; platformSupported?: boolean }
): Promise<EarlierViewsAnswer> {
  if (typeof outlinePath !== 'string' || typeof pageUrl !== 'string' || pageUrl.length > MAX_STATUS_REF_LENGTH) return { ok: false, reason: 'invalid-input' }
  const page = normaliseCaptureUrl(pageUrl)
  if (!page) return { ok: false, reason: 'invalid-input' }
  const current = deps.currentTalkOf(senderId)
  if (!current || current !== outlinePath) return { ok: false, reason: 'not-current-talk' }
  const ctx = deps.contextFor(current)
  if (!ctx) return { ok: false, reason: 'no-vault' }
  // The reader's guarantee is the kernel's no-link open (macOS); elsewhere nothing is read.
  if (!(deps.platformSupported ?? htmlPageImportSupportedOn(process.platform))) return { ok: false, reason: 'unreadable' }
  const budget = startBudget(deps.budgetMs ?? STATUS_BUDGET_MS)
  let answer: EarlierViewsAnswer | typeof TIMED_OUT
  try {
    answer = await budget.race(readEarlierViews(ctx, page, deps.earlierFs ?? nodeEarlierFs, budget.expired))
  } catch {
    answer = { ok: false, reason: 'unreadable' }
  } finally { budget.end() }
  if (answer === TIMED_OUT) return { ok: false, reason: 'unreadable' }
  if (deps.currentTalkOf(senderId) !== outlinePath) return { ok: false, reason: 'not-current-talk' }
  return answer
}

async function readEarlierViews(ctx: ObjectStatusContext, page: string, fs: EarlierViewsFs, stop: () => boolean): Promise<EarlierViewsAnswer> {
  const unreadable: EarlierViewsAnswer = { ok: false, reason: 'unreadable' }
  // The talk folder's real path once; every later look names a path below it with no link in it.
  let realTalk: string
  try { realTalk = await underStop(stop, () => realpath(ctx.talkDir)) } catch (error) { if (isAbsent(error)) return { ok: true, views: [] }; throw error }
  const dir = join(realTalk, LIVE_PAGE_CAPTURES_DIR)
  const listed = await fs.list(dir, MAX_CAPTURES_TOTAL * 2, stop)
  if (stop()) return unreadable
  if (!listed) return { ok: true, views: [] }
  const names = listed.filter((name) => isCaptureEntryName(name)).sort()
  if (names.length > MAX_CAPTURES_TOTAL * 2) return unreadable
  const entries = []
  for (const name of names) {
    if (stop()) return unreadable
    const text = await fs.read(join(dir, name), MAX_CAPTURE_ENTRY_BYTES, stop)
    if (stop()) return unreadable
    const entry = text === null ? null : parseCaptureEntry(text, name)
    if (entry) entries.push({ ...entry, name })
  }
  if (stop()) return unreadable
  return { ok: true, views: earlierCapturesFor(galleryFromEntries(entries), page) }
}

export function registerObjectStatusIpc(deps: ObjectStatusDeps): void {
  deps.ipcMain.handle('object:status', (event, outlinePath: unknown, refs: unknown): Promise<ObjectStatusAnswer> =>
    answerObjectStatus(event.sender.id, outlinePath, refs, deps))
  deps.ipcMain.handle('object:earlier-views', (event, outlinePath: unknown, pageUrl: unknown): Promise<EarlierViewsAnswer> =>
    answerEarlierViews(event.sender.id, outlinePath, pageUrl, deps))
}
