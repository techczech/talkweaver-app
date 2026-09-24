// Garbage collection for superseded thumbnail-cache namespaces.
//
// Every compiler change opens a new `thumb-cache-v8-<tag>` namespace under userData and the
// old ones are never read again (thumbCacheRoot() is fixed per session). A long-lived profile
// accumulated 56 namespaces / 52 GB of orphaned PNGs (2026-09-15). This sweep removes them.
//
// Safety rules:
//   - never touch the LIVE namespace (the tag this session renders into);
//   - never touch a namespace with recent activity (its own mtime or any talk dir's mtime within
//     `graceMs`) — another build sharing the profile (a dev checkout beside the installed app) may
//     still be rendering into it, and thrashing two caches is worse than keeping one for a week;
//   - only names shaped like a cache namespace are candidates; nothing else in userData is read;
//   - one async fs op in flight at a time, so a sweep over hundreds of thousands of files never
//     blocks the main thread (the old startup sweeps beachballed the app — see index.ts).
// Files and bytes are counted as they are unlinked, so the report costs no second pass.

import { promises as fsp } from 'fs'
import { join } from 'path'

const NAMESPACE_RE = /^thumb-cache-v\d+-[0-9a-z]+$/

export interface ThumbCacheSweepOptions {
  /** Keep any namespace whose newest activity is within this window. Default 7 days. */
  graceMs?: number
  now?: number
  log?: (message: string) => void
}

export interface RemovedNamespace { name: string; files: number; bytes: number }
export interface KeptNamespace { name: string; reason: 'live' | 'recent' }
export interface ThumbCacheSweepReport { removed: RemovedNamespace[]; kept: KeptNamespace[] }

const DAY_MS = 24 * 60 * 60 * 1000

/** Newest mtime of the namespace dir itself or any of its immediate children (talk dirs). */
async function newestActivityMs(dir: string): Promise<number> {
  let newest = 0
  try {
    newest = (await fsp.stat(dir)).mtimeMs
    for (const name of await fsp.readdir(dir)) {
      try { newest = Math.max(newest, (await fsp.stat(join(dir, name))).mtimeMs) } catch { /* vanished */ }
    }
  } catch { /* vanished */ }
  return newest
}

/** Remove a tree one entry at a time, counting what went. */
async function removeTreeCounting(dir: string, tally: { files: number; bytes: number }): Promise<void> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const target = join(dir, entry.name)
    if (entry.isDirectory()) {
      await removeTreeCounting(target, tally)
    } else {
      try {
        const st = await fsp.lstat(target)
        await fsp.unlink(target)
        tally.files += 1
        tally.bytes += st.size
      } catch { /* vanished or unreadable; the rmdir below reports if anything is left */ }
    }
  }
  try { await fsp.rmdir(dir) } catch { /* non-empty because of an unremovable child; leave it */ }
}

export async function sweepOrphanedThumbCaches(
  userDataDir: string,
  liveNamespace: string,
  opts: ThumbCacheSweepOptions = {}
): Promise<ThumbCacheSweepReport> {
  const graceMs = opts.graceMs ?? 7 * DAY_MS
  const now = opts.now ?? Date.now()
  const log = opts.log ?? (() => {})
  const report: ThumbCacheSweepReport = { removed: [], kept: [] }
  let names: string[]
  try {
    names = await fsp.readdir(userDataDir)
  } catch {
    return report
  }
  for (const name of names.filter((n) => NAMESPACE_RE.test(n)).sort()) {
    if (name === liveNamespace) { report.kept.push({ name, reason: 'live' }); continue }
    const dir = join(userDataDir, name)
    const activity = await newestActivityMs(dir)
    if (now - activity < graceMs) { report.kept.push({ name, reason: 'recent' }); continue }
    const tally = { files: 0, bytes: 0 }
    await removeTreeCounting(dir, tally)
    report.removed.push({ name, ...tally })
    log(`[thumbnails] removed orphaned cache ${name}: ${tally.files} files, ${(tally.bytes / 1e6).toFixed(1)} MB`)
  }
  const totalBytes = report.removed.reduce((s, r) => s + r.bytes, 0)
  log(`[thumbnails] cache sweep: removed ${report.removed.length} namespaces (${(totalBytes / 1e9).toFixed(2)} GB), kept ${report.kept.length} (live: ${liveNamespace})`)
  return report
}
