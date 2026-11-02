// The image-text index: what each picture says, keyed by file path + mtime, plus the scheduler that
// fills it. The native Vision helper and the disk are passed in, so the policy is testable without
// either.
//
// Policy (the parcel's, 2026-10-20):
//  - Background work (`queue`) runs only while `isEnabled()` is true; `runNow` (the palette command)
//    ignores the setting.
//  - One helper process at a time: background drains and manual runs share one lock.
//  - A picture is read when it is missing from the cache or its mtime changed.
//  - A chunk that fails, times out or comes back short is split and the pictures without a result are
//    retried in halves, so one bad picture cannot drop the good ones; only a picture that fails when
//    run ALONE is recorded failed, WITH its mtime, and not retried until the file changes.
//  - SVG is never sent to Vision: the text of its <text>/<tspan> elements is read directly. An SVG
//    over `svgMaxBytes` (2 MiB) is recorded as skipped at its mtime (tried again when it changes).
//  - Vault authority (ADR-0036): every picture is queued with the vault root it belongs to. Right
//    before a picture is read (the SVG read, the paths handed to the Vision helper) its real path is
//    resolved and must still lie inside that root; the real path checked is what is read. A picture
//    that now resolves outside (a file swapped for a link after it was queued) is skipped, not read,
//    and not recorded, so it is checked again next time.
//  - No check-then-open gap for SVG: the file is opened first (O_NOFOLLOW), then the open handle is
//    verified: the picture's path resolved again must lie inside the root and be the same file (dev +
//    ino) as the handle; only then is it read, from the handle. A mismatch is skipped, not recorded.
//  - Rasters are opened by the Vision helper (a child process, by path), so the handle check is not
//    available: each checked real path's identity (dev, ino, mtime, ctime) is taken before the helper
//    runs and again after it returns, with containment checked again; a picture whose identity or
//    containment changed has its result discarded (not recorded, read again next pass). Residual: a
//    swap of a PARENT directory that is undone before the helper returns leaves the file's identity
//    unchanged and is not seen; the text would land only in the local search cache.
//  - The pass yields to the event loop every few pictures, so search and its cancellation stay
//    responsive while a vault's pictures are stat'ed and its SVGs read.
//  - `generation()` rises whenever any entry changes: readers (the slide search) refresh what they
//    derived from the previous generation.

import { svgText } from './svg-text.ts'
import { SVG_EXT } from './slide-image-refs.ts'
import { pathStaysInside } from './path-containment.ts'
import { extname } from 'path'
import { constants, statSync } from 'fs'
import { open, stat } from 'fs/promises'

export interface OcrEntry { mtimeMs: number; text: string; failed?: true; skipped?: true }
export interface OcrCounts { total: number; read: number; known: number; failed: number; skipped: number }
/** A picture to read and the vault root it must stay inside. */
export interface OcrPicture { path: string; root: string }

export const SVG_MAX_BYTES = 2 * 1024 * 1024
export const TOO_LARGE = 'too-large' as const
const YIELD_EVERY = 8

export const OUTSIDE = 'outside' as const
/** The file's size changed between the stat and the read: skipped, not recorded, read again next pass. */
export const CHANGED = 'changed' as const
export type SvgRead = string | typeof TOO_LARGE | typeof OUTSIDE | typeof CHANGED | null

export interface SvgReadAuthority {
  /** The picture's path as queued, and the vault root it must stay inside. */
  path: string
  root: string
  /** The containment check (default: pathStaysInside). */
  containedPath?(root: string, path: string): string | null
  /** Test seam: runs after the containment check, right before the open. */
  beforeOpen?(realPath: string): void | Promise<void>
}

/*
 * Accepted residual: containment is best-effort against concurrent symlink swaps. Swaps of a parent
 * and the final component, interleaved between the containment check, the stat and the open, can
 * still let text from an image outside the vault reach the local search cache. Accepted because that
 * text only enters the search cache on this Mac (never written to a vault, published or sent), the
 * attacker needs write access inside the vault and precise timing, and closing it fully needs
 * openat-style no-follow traversal.
 */
/**
 * Read an SVG from its checked real path without a check-then-open gap: open first (no following a
 * final link, no blocking on a FIFO), then verify the open handle — `auth.path` resolved again lies
 * inside `auth.root` and is the same file (dev + ino) as the handle — and only then read from the
 * handle. Its text; TOO_LARGE past the cap; OUTSIDE when the handle is not the contained file; null
 * when unreadable.
 */
export async function readSvgFile(realPath: string, maxBytes: number, auth: SvgReadAuthority): Promise<SvgRead> {
  const containedPath = auth.containedPath ?? ((root: string, path: string) => pathStaysInside(root, path))
  if (auth.beforeOpen) await auth.beforeOpen(realPath)
  let fh: Awaited<ReturnType<typeof open>>
  try {
    fh = await open(realPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (e) {
    // The checked real path is now a link: swapped since the check.
    return (e as NodeJS.ErrnoException)?.code === 'ELOOP' ? OUTSIDE : null
  }
  try {
    const held = await fh.stat()
    const again = containedPath(auth.root, auth.path)
    if (!again) return OUTSIDE
    let named
    try { named = await stat(again) } catch { return OUTSIDE }
    if (named.dev !== held.dev || named.ino !== held.ino) return OUTSIDE
    if (!held.isFile()) return null
    if (held.size > maxBytes) return TOO_LARGE
    // Read up to cap + 1 bytes from the handle whatever the stat said: a file that grew past the cap
    // since the stat is still too large, and one that changed size is not trusted.
    const buf = Buffer.alloc(maxBytes + 1)
    let got = 0
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, got)
      if (!bytesRead) break
      got += bytesRead
    }
    if (got > maxBytes) return TOO_LARGE
    if (got !== held.size) return CHANGED
    return buf.subarray(0, got).toString('utf8')
  } catch { return null } finally { await fh.close().catch(() => {}) }
}

/** Identity of a file for the before/after check around the Vision helper; null when it cannot be stat'ed. */
export function fileIdentity(path: string): string | null {
  try {
    const st = statSync(path, { bigint: true })
    return `${st.dev}:${st.ino}:${st.mtimeNs}:${st.ctimeNs}`
  } catch { return null }
}

export interface OcrIndexDeps {
  loadCache(): Record<string, OcrEntry> | null
  saveCache(cache: Record<string, OcrEntry>): void
  /** mtime of the file, or null when it is gone. */
  mtimeOf(path: string): number | null
  /** Run the helper on these files; `stdout` has one JSON line {p,t} per picture it read. */
  runHelper(paths: string[]): Promise<{ stdout: string; ok: boolean }>
  /** Read an SVG's XML from its checked real path (default: readSvgFile, which verifies the open handle). */
  readText?(realPath: string, maxBytes: number, picture: OcrPicture): Promise<SvgRead>
  /** Test seam for the default SVG reader: runs after the containment check, right before the open. */
  beforeSvgOpen?(realPath: string): void | Promise<void>
  /** Identity of a checked real path, taken before and after the Vision helper (default: fileIdentity). */
  identityOf?(realPath: string): string | null
  /** The real path of `path` when it lies inside `root`, else null (default: pathStaysInside). */
  containedPath?(root: string, path: string): string | null
  /** Hand control back to the event loop (default: setImmediate). */
  yieldToLoop?(): Promise<void>
  svgMaxBytes?: number
  helperAvailable(): boolean
  isEnabled(): boolean
  log?(message: string): void
  chunkSize?: number
  /** Wait before a background drain starts, so a burst of saves is one pass. */
  debounceMs?: number
  persistMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface OcrIndex {
  generation(): number
  size(): number
  entry(path: string): OcrEntry | undefined
  /** The picture's text, lowercased ('' when unknown, unreadable or failed). */
  textLower(path: string): string
  /** True when the picture has no entry for its current mtime (a recorded failure at that mtime counts as known). */
  needs(path: string): boolean
  /** Background: read these pictures soon, if the setting is on. Never blocks. */
  queue(pictures: Iterable<OcrPicture>): void
  /** Foreground: read these now whatever the setting says; resolves with the real counts. */
  runNow(pictures: Iterable<OcrPicture>): Promise<OcrCounts>
  /** Resolves when no background work is pending or running (tests, shutdown). */
  idle(): Promise<void>
  /** Write the cache to disk now. */
  flush(): void
}

export function createOcrIndex(deps: OcrIndexDeps): OcrIndex {
  const chunkSize = deps.chunkSize ?? 80
  const debounceMs = deps.debounceMs ?? 2000
  const persistMs = deps.persistMs ?? 1500
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const log = deps.log ?? (() => {})
  const containedPath = deps.containedPath ?? ((root: string, path: string) => pathStaysInside(root, path))
  const readText = deps.readText ?? ((real: string, max: number, pic: OcrPicture) =>
    readSvgFile(real, max, { path: pic.path, root: pic.root, containedPath, beforeOpen: deps.beforeSvgOpen }))
  const identityOf = deps.identityOf ?? fileIdentity
  const yieldNow = deps.yieldToLoop ?? ((): Promise<void> => new Promise((resolve) => setImmediate(resolve)))
  const svgMaxBytes = deps.svgMaxBytes ?? SVG_MAX_BYTES
  const cache = new Map<string, OcrEntry>()
  const lower = new Map<string, string>()
  let generation = 0
  let loaded = false
  let persistHandle: unknown = null
  let lock: Promise<unknown> = Promise.resolve()
  let drainHandle: unknown = null
  const pending = new Map<string, string>() // path -> vault root
  let draining = false

  function load(): void {
    if (loaded) return
    loaded = true
    try {
      const obj = deps.loadCache()
      if (obj) for (const [k, v] of Object.entries(obj)) if (v && typeof v.mtimeMs === 'number') cache.set(k, v)
    } catch { /* no cache yet */ }
  }
  function flush(): void {
    if (persistHandle) { clearTimer(persistHandle); persistHandle = null }
    try { deps.saveCache(Object.fromEntries(cache)) } catch { /* ignore */ }
  }
  function persistSoon(): void {
    if (persistHandle) clearTimer(persistHandle)
    persistHandle = setTimer(() => { persistHandle = null; flush() }, persistMs)
  }
  function set(path: string, entry: OcrEntry): void {
    cache.set(path, entry)
    lower.delete(path)
    generation += 1
  }
  function needs(path: string): boolean {
    load()
    const m = deps.mtimeOf(path)
    if (m === null) return false // gone: nothing to read
    const c = cache.get(path)
    return !c || c.mtimeMs !== m
  }

  // Read one group of pictures; pictures without a result are retried in smaller groups, and only a
  // picture that fails on its own is recorded failed.
  async function readChunk(items: OcrPicture[], wanted: Map<string, number>, counts: OcrCounts): Promise<void> {
    if (!items.length) return
    // Accepted residual: containment is best-effort against concurrent symlink swaps. Swaps around the
    // helper run (the identity check below sees only the final state) can still let text from an image
    // outside the vault reach the local search cache. Accepted because that text only enters the search
    // cache on this Mac (never written to a vault, published or sent), the attacker needs write access
    // inside the vault and precise timing, and closing it fully needs handing the helper file descriptors.
    // Vault authority, checked now (not when queued): the helper is handed the real paths checked.
    const keysByReal = new Map<string, string[]>()
    const args: string[] = []
    const handed: Array<OcrPicture & { real: string; id: string }> = []
    for (const it of items) {
      const real = containedPath(it.root, it.path)
      if (!real) { counts.skipped += 1; log('[ocr] skipped, not inside its vault: ' + it.path); continue }
      const id = identityOf(real)
      if (id === null) { counts.skipped += 1; log('[ocr] skipped, cannot be stat\'ed: ' + it.path); continue }
      handed.push({ ...it, real, id })
      const keys = keysByReal.get(real)
      if (keys) keys.push(it.path)
      else { keysByReal.set(real, [it.path]); args.push(real) }
    }
    if (!args.length) return
    const res = await deps.runHelper(args).catch(() => ({ stdout: '', ok: false }))
    // The helper opened these by path: anything swapped or moved out of its vault while it ran has its
    // result thrown away (not recorded, read again next pass).
    const changed = new Set<string>()
    for (const it of handed) {
      if (containedPath(it.root, it.path) !== it.real || identityOf(it.real) !== it.id) changed.add(it.real)
    }
    for (const real of changed) {
      for (const key of keysByReal.get(real) ?? []) { counts.skipped += 1; log('[ocr] discarded, changed while it was read: ' + key) }
    }
    const got = new Set<string>()
    for (const line of String(res.stdout || '').split('\n')) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line) as { p: string; t: string }
        const keys = keysByReal.get(obj.p)
        if (!keys || got.has(obj.p) || changed.has(obj.p)) continue
        got.add(obj.p)
        for (const key of keys) { set(key, { mtimeMs: wanted.get(key) ?? 0, text: obj.t || '' }); counts.read += 1 }
      } catch { /* skip a bad line */ }
    }
    const missing = handed.filter((it) => !got.has(it.real) && !changed.has(it.real))
    if (!missing.length) return
    if (args.length === 1) {
      // It ran alone and gave nothing: remember the failure at its mtime.
      for (const it of missing) { set(it.path, { mtimeMs: wanted.get(it.path) ?? 0, text: '', failed: true }); counts.failed += 1 }
      return
    }
    // A batch came back short (crash, timeout, a skipped picture): the rest are not judged by it.
    const mid = Math.ceil(missing.length / 2)
    await readChunk(missing.slice(0, mid), wanted, counts)
    await readChunk(missing.slice(mid), wanted, counts)
  }

  async function readSvg(pic: OcrPicture, mtime: number, counts: OcrCounts): Promise<void> {
    const real = containedPath(pic.root, pic.path)
    if (!real) { counts.skipped += 1; log('[ocr] skipped, not inside its vault: ' + pic.path); return }
    let text: SvgRead = null
    try { text = await readText(real, svgMaxBytes, pic) } catch { text = null }
    if (text === OUTSIDE) { counts.skipped += 1; log('[ocr] skipped, not the file inside its vault when opened: ' + pic.path); return }
    if (text === CHANGED) { counts.skipped += 1; log('[ocr] skipped, changed while it was read: ' + pic.path); return }
    if (text === TOO_LARGE) { set(pic.path, { mtimeMs: mtime, text: '', skipped: true }); counts.skipped += 1; return }
    if (text === null) { set(pic.path, { mtimeMs: mtime, text: '', failed: true }); counts.failed += 1; return }
    const parsed = svgText(text)
    set(pic.path, { mtimeMs: mtime, text: parsed })
    counts.read += 1
  }

  async function process(pictures: OcrPicture[]): Promise<OcrCounts> {
    load()
    const counts: OcrCounts = { total: 0, read: 0, known: 0, failed: 0, skipped: 0 }
    const unique = new Map<string, string>()
    for (const p of pictures) if (p && typeof p.path === 'string' && !unique.has(p.path)) unique.set(p.path, p.root)
    const todo: OcrPicture[] = []
    const wanted = new Map<string, number>()
    let sinceYield = 0
    for (const [path, root] of unique) {
      if (++sinceYield >= YIELD_EVERY) { sinceYield = 0; await yieldNow() }
      const m = deps.mtimeOf(path)
      if (m === null) continue
      counts.total += 1
      const c = cache.get(path)
      if (c && c.mtimeMs === m) { counts.known += 1; continue }
      if (extname(path).slice(1).toLowerCase() === SVG_EXT) {
        // Not a Vision job: the XML text, read directly.
        await readSvg({ path, root }, m, counts)
        continue
      }
      todo.push({ path, root })
      wanted.set(path, m)
    }
    if (todo.length && !deps.helperAvailable()) {
      counts.failed += todo.length
      return counts
    }
    for (let i = 0; i < todo.length; i += chunkSize) await readChunk(todo.slice(i, i + chunkSize), wanted, counts)
    if (counts.read || counts.failed || counts.skipped) persistSoon()
    return counts
  }

  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = lock.then(task, task)
    lock = run.catch(() => {})
    return run
  }

  async function drain(): Promise<void> {
    if (draining) return
    draining = true
    try {
      while (pending.size) {
        if (!deps.isEnabled()) { pending.clear(); break }
        const batch = [...pending].map(([path, root]) => ({ path, root }))
        pending.clear()
        const counts = await exclusive(() => process(batch))
        if (counts.read || counts.failed || counts.skipped) log(`[ocr] background: ${counts.read} read, ${counts.known} known, ${counts.failed} failed, ${counts.skipped} skipped`)
      }
    } catch (e) { log('[ocr] background pass failed ' + String(e)) } finally { draining = false }
  }

  return {
    generation: () => generation,
    size: () => { load(); return cache.size },
    entry: (p) => { load(); return cache.get(p) },
    textLower(path) {
      load()
      const memo = lower.get(path)
      if (memo !== undefined) return memo
      const c = cache.get(path)
      const t = c && !c.failed && !c.skipped ? c.text.toLowerCase() : ''
      lower.set(path, t)
      return t
    },
    needs,
    queue(pictures) {
      if (!deps.isEnabled()) return
      let added = false
      for (const pic of pictures) if (pic && !pending.has(pic.path) && needs(pic.path)) { pending.set(pic.path, pic.root); added = true }
      if (!added) return
      if (drainHandle) clearTimer(drainHandle)
      drainHandle = setTimer(() => { drainHandle = null; void drain() }, debounceMs)
    },
    runNow: (pictures) => exclusive(() => process([...pictures])),
    async idle() {
      while (drainHandle || draining || pending.size) {
        if (drainHandle) { clearTimer(drainHandle); drainHandle = null; void drain() }
        await lock
        await new Promise((r) => setImmediate(r))
      }
    },
    flush
  }
}
