// The slide picker's Files tab over the shared tree (ADR-0029 §4; frame K1). The picker draws the
// file list's tree — nested folders at their real depth, the Archive last and collapsed, the
// same folder open/closed memory — with SLIDE counts (per talk its slides, per folder the total
// including subfolders). The picker's own layer on top: a talk expands to its sections, and the
// talk being edited is marked "current". Pure: no React/DOM, erasable TypeScript (node-testable).
import type { TalkInfo, TalkMeta } from '../../../../preload/index'
import { topicOf } from '../talkTreeNav.ts'
import {
  ARCHIVE_FOLDER, ARCHIVE_LABEL, type FolderOpenState, type TalkSortKey,
  collapsedFrom, flattenTree, folderTotals, sortTalks, talkTree
} from '../talklist/model.ts'
import type { TreeSection } from './railTypes'

/** Everything the Files tree is drawn from. */
export interface FilesTreeSource {
  talks: TalkInfo[]
  /** Vault-relative folders, empty ones included (as the file list has them). */
  folders: string[]
  vaultRoot: string
  /** The file list's sort, so talks sit in the same order in both trees. */
  sortKey: TalkSortKey
  meta: TalkMeta
  /** Last delivery per slug, epoch ms. */
  delivered: Record<string, number>
  /** A talk's slide count. */
  slidesOf: (slug: string) => number
  /** A talk's sections, in outline order. */
  sectionsOf: (slug: string) => TreeSection[]
  currentTalkSlug: string
}

export type FilesRow =
  | { kind: 'folder'; key: string; path: string; name: string; depth: number; count: number; open: boolean; archive: boolean }
  | { kind: 'talk'; key: string; slug: string; title: string; depth: number; count: number; open: boolean; current: boolean; hasSections: boolean }
  | { kind: 'section'; key: string; slug: string; title: string; sec: string; label: string; depth: number; count: number; current: boolean }

/** The Files tab's rows in render order. `folderOpen` is the shared folder memory; `openTalks`
 *  the talks whose sections are showing. */
export function filesTreeRows(src: FilesTreeSource, folderOpen: FolderOpenState, openTalks: ReadonlySet<string>): FilesRow[] {
  const sorted = sortTalks(src.talks, src.sortKey, src.meta, src.delivered)
  const tree = talkTree(sorted, src.folders, src.vaultRoot)
  const collapsed = collapsedFrom(tree, folderOpen)
  const totals = folderTotals(tree, 'slides', (t) => src.slidesOf(t.slug))
  const out: FilesRow[] = []
  for (const row of flattenTree(tree, collapsed)) {
    if (row.kind === 'folder') {
      const archive = row.path === ARCHIVE_FOLDER
      out.push({
        kind: 'folder', key: row.key, path: row.path, depth: row.depth,
        name: archive ? ARCHIVE_LABEL : row.path.split('/').pop() || row.path,
        count: totals.get(row.path) ?? 0, open: !collapsed.has(row.path), archive
      })
      continue
    }
    if (row.kind !== 'talk') continue
    const { talk, depth } = row
    const slug = talk.slug
    const title = talk.title || slug
    const current = slug === src.currentTalkSlug
    const sections = src.sectionsOf(slug)
    const open = openTalks.has(slug)
    out.push({ kind: 'talk', key: row.key, slug, title, depth, count: src.slidesOf(slug), open, current, hasSections: sections.length > 0 })
    if (!open) continue
    for (const s of sections) {
      out.push({ kind: 'section', key: `s:${slug}\n${s.sec}`, slug, title, sec: s.sec, label: s.label, depth: depth + 1, count: s.count, current })
    }
  }
  return out
}

/** A talk's vault-relative folder ('' at the vault root): what a folder scope compares against. */
export function folderPathOf(talk: TalkInfo, vaultRoot: string): string {
  return topicOf(talk, vaultRoot)
}
