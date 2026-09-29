import { readdirSync } from 'node:fs'
import { join } from 'node:path'

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

/** The outline a talk folder is known by: the first `-outline.md` file in directory order. */
export function pickOutlineEntry(dirents) {
  return dirents.find((entry) => entry.isFile() && entry.name.endsWith('-outline.md')) ?? null
}

/** Synchronous walk: every talk folder under `root` as { dir, outlineName }, in walk order. */
export function scanTalkFoldersSync(root) {
  const found = []
  function scanDir(dir, depth) {
    if (depth > TALK_SCAN_MAX_DEPTH) return
    let dirents
    try { dirents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    const outline = pickOutlineEntry(dirents)
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
