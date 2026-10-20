// The Work files view's main-process side (work-files ticket 06): reads the vault's `Work files/`
// folder, the talks' front matter and the Runs, and answers with the model built in
// src/shared/work-files-view.ts. Read only: nothing here writes to the vault. No Electron import:
// the one IPC channel (`work-files:list`) is registered in index.ts so this module runs under plain Node.
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'fs'
import { join } from 'path'
import {
  WORK_FILES_FOLDER, buildWorkFileItems, readTalkWorkNames,
  type WorkFilesListing, type WorkFileRunSource, type WorkFileSource, type WorkFileTalkSource,
} from '../shared/work-files-view.ts'
import { listRuns, type RunRecord } from './runs.ts'
import { pathStaysInside } from './path-containment.ts'

/** A work file is a short text file; anything larger is not one (and is not read). */
export const MAX_WORK_FILE_BYTES = 512 * 1024
/** The front matter of a talk is read from the head of its outline, never the whole of a huge file. */
const MAX_OUTLINE_HEAD_BYTES = 64 * 1024

/** The `*.md` files directly inside `Work files/`: plain files only (no folders, no links), by name. */
export function readWorkFileSources(vaultRoot: string): WorkFileSource[] {
  const dir = join(vaultRoot, WORK_FILES_FOLDER)
  let names: string[]
  try {
    // The folder itself must be a real directory inside the vault (a link out is read as no folder).
    if (!lstatSync(dir).isDirectory()) return []
    if (!pathStaysInside(vaultRoot, dir)) return []
    names = readdirSync(dir)
  } catch { return [] }
  const out: WorkFileSource[] = []
  for (const fileName of names.sort()) {
    if (!/\.md$/i.test(fileName) || fileName.startsWith('.')) continue
    try {
      const path = join(dir, fileName)
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.size > MAX_WORK_FILE_BYTES) continue
      out.push({ fileName, text: readFileSync(path, 'utf8') })
    } catch { /* unreadable: left out, as a missing file */ }
  }
  return out
}

/** The first `max` bytes of a file as text, read without loading the rest. */
function readHead(path: string, max: number): string {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(max)
    const read = readSync(fd, buffer, 0, max, 0)
    return buffer.subarray(0, read).toString('utf8')
  } finally { closeSync(fd) }
}

/** The part of each Run this view reads. */
export function runSources(runs: readonly RunRecord[]): WorkFileRunSource[] {
  return runs.map((run) => ({
    id: run.id, talkSlug: run.talkSlug, talkTitle: run.talkTitle, eventTitle: run.eventTitle,
    work: run.work && {
      ...(run.work.pre ? { pre: { fileId: run.work.pre.fileId, ...(run.work.pre.pinned ? { pinned: { pinnedAt: run.work.pre.pinned.pinnedAt } } : {}) } } : {}),
      ...(run.work.post ? { post: { fileId: run.work.post.fileId, ...(run.work.post.pinned ? { pinned: { pinnedAt: run.work.post.pinned.pinnedAt } } : {}) } } : {}),
    },
  }))
}

/** Each talk with the work-file names its front matter gives. A talk whose outline cannot be read names none. */
export function readTalkSources(talks: ReadonlyArray<{ slug: string; title: string; outlinePath: string }>): WorkFileTalkSource[] {
  return talks.map((talk) => {
    let names: { prework?: string; postwork?: string } = {}
    try {
      names = readTalkWorkNames(readHead(talk.outlinePath, MAX_OUTLINE_HEAD_BYTES))
    } catch { /* unreadable outline */ }
    return { slug: talk.slug, title: talk.title, outlinePath: talk.outlinePath, ...names }
  })
}

/** The one listing: files, who names them, which Runs carry them. */
export function listWorkFiles(
  vaultRoot: string,
  talks: ReadonlyArray<{ slug: string; title: string; outlinePath: string }>,
  runs: readonly WorkFileRunSource[] = runSources(listRuns(vaultRoot))
): WorkFilesListing {
  const items = buildWorkFileItems(readWorkFileSources(vaultRoot), readTalkSources(talks), runs)
  return { folder: join(vaultRoot, WORK_FILES_FOLDER), items: items.map((item) => ({ ...item, absPath: join(vaultRoot, item.relPath) })) }
}

/** What `work-files:list` answers: null when no vault is open; otherwise the listing. */
export function listWorkFilesFor(
  vaultRoot: string | null,
  talks: ReadonlyArray<{ slug: string; title: string; outlinePath: string }> = [],
): WorkFilesListing | null {
  if (!vaultRoot) return null
  return listWorkFiles(vaultRoot, talks)
}


/** The all-vaults listing the Work files view shows: every open vault's files, each tagged with its vault, vault by vault in order.
 *  `newFileVaultId` is where a New work file goes (the caller picks it: the open talk's vault, else the current vault). */
export function listWorkFilesAcross(
  vaults: ReadonlyArray<{ id: string; name: string; root: string }>,
  talksOf: (vaultRoot: string) => ReadonlyArray<{ slug: string; title: string; outlinePath: string }>,
  newFileVaultId?: string,
): WorkFilesListing | null {
  if (vaults.length === 0) return null
  const items: WorkFilesListing['items'] = []
  for (const vault of vaults) {
    const listing = listWorkFiles(vault.root, talksOf(vault.root))
    for (const item of listing.items) items.push({ ...item, vaultId: vault.id })
  }
  const newFile = vaults.find((v) => v.id === newFileVaultId) ?? vaults[0]
  return {
    folder: join(vaults[0].root, WORK_FILES_FOLDER), items,
    vaults: vaults.map((v) => ({ id: v.id, name: v.name })), newFileVaultId: newFile.id,
  }
}

/** The vault a write lands in: the one the request names (never another), else the current vault. `rootOf` is the main process's
 *  write-root rule (the open vault's folder, only while it is there); a named vault it does not give is refused, not re-targeted. */
export function workFileWriteRoot(vaultId: unknown, rootOf: (vaultId?: string) => string | undefined): string | undefined {
  if (vaultId === undefined || vaultId === null || vaultId === '') return rootOf(undefined)
  return typeof vaultId === 'string' ? rootOf(vaultId) : undefined
}
