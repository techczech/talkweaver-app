// The deck as the Inspector preview and the thumbnails load it, made where the deck was compiled
// (prepare-talk-worker.ts) rather than on the main process's thread, and kept as a FILE, not in the
// main process's memory.
//
// Both consumers load markSlidePreviewHtml(withRemoteEmbedArtwork(fullHtml), { localPages: true }).
// For a deck with no remote page on a slide, withRemoteEmbedArtwork changes nothing, so that document
// is fixed by the compile alone: the compile's process marks it, encodes it, hashes it and writes it
// to <previewDir>/<sha256>.html. The main process gets a small descriptor back. It serves the preview
// from the file and the thumbnail window loads the file, so the main process holds the compiled deck
// (fullHtml) once and never a second, marked copy of it. A deck that has a remote page gets no
// variant: the main process turns the pages into pictures first and marks the deck itself, as before,
// so the policy is the same.
//
// THREAT MODEL (driver's decision, 2026-11-06). The folder is <userData>/preview-variants, created
// 0700 and owned by the user. An attacker able to swap or link entries inside it already runs as the
// user and could delete the user's files directly, so this code does not try to defend against an
// active same-user attacker racing it (Node has no openat; no directory-handle machinery is built).
// It does defend against accidents and stale state:
//   - a pre-existing link, or a folder replaced between runs or while running: the folder is lstat'ed
//     when validated (a real directory, not a link, owned by this user) and its identity (dev + ino)
//     recorded. Immediately before every delete, write, rename, serve and thumbnail load it is
//     lstat'ed again and must be the same directory; if not, variants stop for the run (one log line),
//     nothing is deleted, and every consumer falls back to marking fullHtml on the main process.
//   - stray or hard-linked files: only entries that lstat says are regular files and whose names are
//     exactly a variant name (64 hex digits + .html) or its temporary-file name are ever deleted, one
//     at a time, never recursively. A variant is used only if it is such a regular file, and served
//     through a handle opened with O_NOFOLLOW and checked again (fstat) on the handle.
//   - never trusting a filename as proof of content: every variant is written fresh, to a temporary
//     file created exclusively in the folder, then renamed over the name. A rename replaces whatever
//     entry had the name (a link, a hard link, an unrelated file) without touching what it pointed to
//     or its other links.
//
// No Electron import: the compile's utility process and plain-Node tests load this file.
import { createHash } from 'node:crypto'
import { constants, lstatSync } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { Readable } from 'node:stream'
import { markSlidePreviewHtml } from '../shared/slide-preview.ts'
import { hasRemoteEmbedFrames } from './embed-preview-policy.ts'
import { writeGeneratedFile, type GeneratedFileOps } from './generated-file-write.ts'

/** The validated variant folder: its path and identity (dev + ino, as decimal strings). */
export type VariantFolder = { path: string; dev: string; ino: string }
/** A written variant: its file, the sha256 (hex) of its bytes (the file name), its size in bytes, and
 *  the identity of the folder it was written into. */
export type PreviewVariant = { path: string; key: string; size: number; folder: VariantFolder; file: FileIdentity }
/** The identity of the file this run wrote (dev, ino as decimal strings, size in bytes): an entry
 *  replaced after the write (another file, a hard link) no longer matches and is refused. */
export type FileIdentity = { dev: string; ino: string; size: number; mtimeNs: string }

const VARIANT_NAME = /^[0-9a-f]{64}\.html$/
// generated-file-write.ts names its temporary file `<target>.<12 hex>.tmp`.
const VARIANT_TEMP_NAME = /^[0-9a-f]{64}\.html\.[0-9a-f]{12}\.tmp$/

type FolderStats = { isDirectory(): boolean; isSymbolicLink(): boolean; uid: number | bigint; dev: number | bigint; ino: number | bigint }
function trustedStats(stats: FolderStats): boolean {
  if (!stats.isDirectory() || stats.isSymbolicLink()) return false
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  return uid === undefined || BigInt(stats.uid) === BigInt(uid)
}

/** Validate `dir` (a real directory, not a link, owned by this user) and record its identity. */
export async function validateVariantFolder(dir: string): Promise<VariantFolder | null> {
  try {
    const stats = await lstat(dir, { bigint: true })
    return trustedStats(stats) ? { path: dir, dev: String(stats.dev), ino: String(stats.ino) } : null
  } catch { return null }
}

/** True when the folder is still the directory that was validated (re-lstat'ed now). */
export function sameVariantFolder(folder: VariantFolder): boolean {
  try {
    const stats = lstatSync(folder.path, { bigint: true })
    return trustedStats(stats) && String(stats.dev) === folder.dev && String(stats.ino) === folder.ino
  } catch { return false }
}

/** A variant about to be used: its folder is still the validated one, and the entry is a regular
 *  file (not a link) with a variant name directly in it. */
export function regularVariantFile(variant: PreviewVariant): boolean {
  try {
    if (!isAbsolute(variant.path) || !VARIANT_NAME.test(basename(variant.path))) return false
    if (dirname(variant.path) !== variant.folder.path || !sameVariantFolder(variant.folder)) return false
    const stats = lstatSync(variant.path, { bigint: true })
    return stats.isFile() && sameFile(stats, variant.file)
  } catch { return false }
}

function sameFile(stats: { dev: bigint; ino: bigint; size: bigint; nlink: bigint; mtimeNs: bigint }, file: FileIdentity | undefined): boolean {
  return !!file && String(stats.dev) === file.dev && String(stats.ino) === file.ino && Number(stats.size) === file.size
    && String(stats.mtimeNs) === file.mtimeNs && Number(stats.nlink) === 1
}

/** The bytes of the variant of a deck and their key, or undefined when the deck has a remote page. */
export function previewVariantBytes(fullHtml: string): { bytes: Buffer; key: string } | undefined {
  if (!fullHtml || hasRemoteEmbedFrames(fullHtml)) return undefined
  const bytes = Buffer.from(markSlidePreviewHtml(fullHtml, { localPages: true }), 'utf8')
  return { bytes, key: createHash('sha256').update(bytes).digest('hex') }
}

/** Write the variant of a deck fresh into the validated folder (compile's process): an exclusive
 *  temporary file, then a rename over the name. Every step first checks that the folder is still the
 *  one validated; if not, there is no variant (and nothing is renamed or deleted). */
export async function writePreviewVariant(fullHtml: string, folder: VariantFolder): Promise<PreviewVariant | undefined> {
  if (!sameVariantFolder(folder)) return undefined
  const made = previewVariantBytes(fullHtml)
  if (!made) return undefined
  const path = join(folder.path, `${made.key}.html`)
  const moved = new Error('The preview variant folder is no longer the one validated.')
  const guarded: GeneratedFileOps = {
    writeFile: async (temp, data) => { if (!sameVariantFolder(folder)) throw moved; await writeFile(temp, data, { flag: 'wx' }) },
    rename: async (from, to) => { if (!sameVariantFolder(folder)) throw moved; await rename(from, to) },
    unlink: async (temp) => { if (sameVariantFolder(folder)) await unlink(temp) },
  }
  try { await writeGeneratedFile(path, made.bytes, guarded) } catch { return undefined }
  // Record the identity of the file just renamed into place, so a later replacement is refused.
  const stats = await lstat(path, { bigint: true }).catch(() => null)
  if (!stats?.isFile() || Number(stats.size) !== made.bytes.byteLength || !sameVariantFolder(folder)) return undefined
  const file: FileIdentity = { dev: String(stats.dev), ino: String(stats.ino), size: made.bytes.byteLength, mtimeNs: String(stats.mtimeNs) }
  return { path, key: made.key, size: made.bytes.byteLength, folder, file }
}

/** A variant that came back from another process is used only when it still has its shape, names a
 *  file in `folder` under its own key, and was written into that same folder (same identity). */
export function usablePreviewVariant(value: unknown, folder?: VariantFolder): PreviewVariant | undefined {
  const v = value as { path?: unknown; key?: unknown; size?: unknown; folder?: Partial<VariantFolder>; file?: Partial<FileIdentity> } | null | undefined
  if (!v || typeof v.key !== 'string' || !/^[0-9a-f]{64}$/.test(v.key)) return undefined
  if (typeof v.path !== 'string' || !isAbsolute(v.path) || basename(v.path) !== `${v.key}.html`) return undefined
  if (typeof v.size !== 'number' || !(v.size > 0)) return undefined
  const f = v.folder
  if (!f || typeof f.path !== 'string' || typeof f.dev !== 'string' || typeof f.ino !== 'string' || dirname(v.path) !== f.path) return undefined
  if (folder && (f.path !== folder.path || f.dev !== folder.dev || f.ino !== folder.ino)) return undefined
  const id = v.file
  if (!id || typeof id.dev !== 'string' || typeof id.ino !== 'string' || typeof id.mtimeNs !== 'string' || id.size !== v.size) return undefined
  return { path: v.path, key: v.key, size: v.size, folder: { path: f.path, dev: f.dev, ino: f.ino }, file: { dev: id.dev, ino: id.ino, size: v.size, mtimeNs: id.mtimeNs } }
}

/** Open a variant for serving: a stream of the regular file, opened without following a link and
 *  checked on the open handle, or null (gone, refused, folder no longer the validated one). */
export async function openPreviewVariant(variant: PreviewVariant): Promise<ReadableStream<Uint8Array> | null> {
  if (!regularVariantFile(variant)) return null
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(variant.path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stats = await handle.stat({ bigint: true })
    if (!stats.isFile() || !sameFile(stats, variant.file)) { await handle.close(); return null }
    return Readable.toWeb(handle.createReadStream()) as unknown as ReadableStream<Uint8Array>
  } catch {
    await handle?.close().catch(() => {})
    return null
  }
}

/**
 * The main process's side of the variant folder. `ready` settles with whether variants are on for
 * this run: the folder is made if missing (0700), validated and its identity recorded, and the
 * variant files of an earlier run (only those) removed. Then the folder is bounded: every variant the
 * app hears of or uses is noted, most recent last; past `maxFiles` files or `maxBytes` bytes the least
 * recently noted are deleted, but never the newest `keepNewest` nor any noted in the last `graceMs`.
 * `check()` re-validates the folder (same identity); the first failure turns variants off for the run.
 */
export function createPreviewVariantFiles(dir: string, limits: {
  maxFiles?: number; maxBytes?: number; keepNewest?: number; graceMs?: number
  now?: () => number; log?: (message: string) => void
} = {}) {
  const maxFiles = limits.maxFiles ?? 12
  const maxBytes = limits.maxBytes ?? 1024 * 1024 * 1024
  const keepNewest = limits.keepNewest ?? 2
  const graceMs = limits.graceMs ?? 60_000
  const now = limits.now ?? Date.now
  const log = limits.log ?? ((message: string) => console.warn(`[preview-variants] ${message}`))
  const recent = new Map<string, PreviewVariant & { at: number }>()
  let bytes = 0
  let folder: VariantFolder | null = null
  let off = false
  function turnOff(reason: string): void {
    if (off) return
    off = true
    folder = null
    recent.clear()
    log(`${dir} ${reason}: preview variants are off for this run`)
  }
  /** Still on and the folder still the validated directory; otherwise off for the run. */
  function check(): boolean {
    if (off || !folder) return false
    if (sameVariantFolder(folder)) return true
    turnOff('is no longer the folder validated at start')
    return false
  }
  /** Delete `name` only if the folder is unchanged and it is a regular file with a variant name. */
  async function deleteEntry(name: string): Promise<void> {
    if (!VARIANT_NAME.test(name) && !VARIANT_TEMP_NAME.test(name)) return
    if (!check() || !folder) return
    const path = join(folder.path, name)
    const stats = await lstat(path).catch(() => null)
    if (!stats?.isFile() || !check()) return
    await unlink(path).catch(() => {})
  }
  const ready: Promise<boolean> = (async () => {
    await mkdir(dir, { mode: 0o700 }).catch(() => {})
    folder = await validateVariantFolder(dir)
    if (!folder) { turnOff('is not a folder of this user\'s (or is a link)'); return false }
    try {
      for (const name of await readdir(dir)) await deleteEntry(name)
    } catch { /* an unreadable folder: nothing removed */ }
    return check()
  })()
  function prune(): void {
    if (recent.size <= keepNewest || (recent.size <= maxFiles && bytes <= maxBytes)) return
    const newest = new Set([...recent.keys()].slice(-keepNewest))
    const cutoff = now() - graceMs
    for (const [key, entry] of recent) {
      if (recent.size <= maxFiles && bytes <= maxBytes) break
      if (newest.has(key) || entry.at > cutoff) continue
      recent.delete(key)
      bytes -= entry.size
      void deleteEntry(basename(entry.path))
    }
  }
  return {
    dir,
    ready,
    check,
    /** The validated folder while variants are on (re-checked now), else null. */
    folder: (): VariantFolder | null => (check() ? folder : null),
    /** Whether variants are on (false until `ready` has settled true). */
    enabled: (): boolean => !off && folder !== null,
    /** Note a variant as just made or used; deletes the least recently used beyond the limits. */
    note(variant: PreviewVariant): void {
      if (!check() || !folder || variant.folder.dev !== folder.dev || variant.folder.ino !== folder.ino || variant.folder.path !== folder.path) return
      const had = recent.get(variant.key)
      // An older descriptor of the same key never displaces a newer write that still checks out.
      if (had && !regularVariantFile(variant) && regularVariantFile(had)) return
      if (had) { recent.delete(variant.key); bytes -= had.size }
      recent.set(variant.key, { ...variant, at: now() })
      bytes += variant.size
      prune()
    },
    /** The newest noted variant for `key` whose file still checks out (folder and written-file
     *  identity), or undefined. A held descriptor of an earlier write of the same key (each write is a
     *  fresh file) recovers through this rather than failing; any other file under the name stays refused. */
    current(key: string): PreviewVariant | undefined {
      if (!check()) return undefined
      const entry = recent.get(key)
      if (!entry || !regularVariantFile(entry)) return undefined
      const { at: _at, ...variant } = entry
      return variant
    },
    /** Diagnostics and tests: the keys kept, least recently used first. */
    kept: (): string[] => [...recent.keys()],
  }
}
