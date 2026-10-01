import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { conflictServiceOf } from './conflict-copies.mjs'

// The ONE rule for "which folders hold talks", shared by every vault walk.
//
// Two walks exist: the persisted, async vault index that feeds the Talks browser
// (vault-index.mjs) and the synchronous walk the main process uses for slide text, thumbnails
// and slide search (index.ts scanTalks). They used to stop at different depths (8 vs 3), so the
// York festival talks four levels down (external-workshops/York-July-2026/day-N/<talk>) were
// listed but never got slide text (2026-09-25, talk search ticket 01). Both walks now take their
// depth limit, skip rule and outline pick from here, and a test runs both over one fixture.

// Backstop against runaway recursion (symlink loops), NOT a real nesting constraint: talks live
// several organisational levels deep (bucket/event/day/talk). Recursion stops at each talk
// folder, so deep organisational trees cost little.
export const TALK_SCAN_MAX_DEPTH = 8

/** Folders never descended into: hidden, `_`-prefixed system areas (_assets, _PRESENTATIONS,
 *  _SLIDE-VERSIONS) and node_modules. */
export function isSkippedScanDir(name) {
  return name.startsWith('.') || name.startsWith('_') || name === 'node_modules'
}

/**
 * The outline a talk folder is known by, from the names of its `-outline.md` files (several-vaults
 * ticket 09). With one, it is that one (unchanged from every earlier build). With several:
 *   1. the one named for the folder (`<folder>/<folder>-outline.md`);
 *   2. else the first, in listing order, that is not a sync-conflict copy of another one
 *      (`foo-MacBook-outline.md` never shadows `foo-outline.md`);
 *   3. else the first.
 * The rest are left to the conflict scanner (conflict-copies.mjs), which counts only real copies.
 */
export function pickOutlineName(names, folderName) {
  const outlines = (names ?? []).filter((n) => typeof n === 'string' && n.endsWith('-outline.md'))
  if (outlines.length <= 1) return outlines[0] ?? null
  if (typeof folderName === 'string' && folderName) {
    const own = outlines.find((n) => n === `${folderName}-outline.md`)
    if (own) return own
  }
  const original = outlines.find((n) => !outlines.some((other) => other !== n && conflictServiceOf(n, other, { loose: true })))
  return original ?? outlines[0]
}

/** pickOutlineName over a folder's dirents (files only); `folderName` is the folder's own name. */
export function pickOutlineEntry(dirents, folderName) {
  const files = dirents.filter((entry) => entry.isFile() && entry.name.endsWith('-outline.md'))
  const name = pickOutlineName(files.map((entry) => entry.name), folderName)
  return name === null ? null : files.find((entry) => entry.name === name) ?? null
}

/** Synchronous walk: every talk folder under `root` as { dir, outlineName }, in walk order. */
export function scanTalkFoldersSync(root) {
  const found = []
  function scanDir(dir, depth) {
    if (depth > TALK_SCAN_MAX_DEPTH) return
    let dirents
    try { dirents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    const outline = pickOutlineEntry(dirents, basename(dir))
    if (outline) {
      found.push({ dir, outlineName: outline.name })
      return // a talk folder is a leaf
    }
    for (const entry of dirents) {
      if (!entry.isDirectory() || isSkippedScanDir(entry.name)) continue
      scanDir(join(dir, entry.name), depth + 1)
    }
  }
  scanDir(root, 0)
  return found
}
