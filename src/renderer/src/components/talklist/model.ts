import type { RecordingSession, TalkInfo, TalkMeta } from '../../../../preload/index'
import { type TreeNode, buildTree, topicOf } from '../talkTreeNav.ts'
import { displayIsoDate, isIgnoredTalkFolder, type TalkSearchHit } from '../../../../shared/talk-search.ts'

// Pure shared model for the Talks browser (ADR-0008): ONE data/sort/filter/keyboard model,
// two renderings (Ledger / Shelf). Nothing in this file may touch React or the DOM.

export type ViewMode = 'ledger' | 'shelf'
export type TalkSortKey = 'name' | 'created' | 'edited' | 'delivered' | 'slides'
export type PubState = 'live' | 'dead' | 'none'
// Naming mode: 'title' shows the real frontmatter title; 'file' shows the slug as a filename.
export type NamingMode = 'title' | 'file'

export const VIEW_STORAGE_KEY = 'tw-talklist-view'
export const SORT_STORAGE_KEY = 'tw-talklist-sort'
export const NAMING_STORAGE_KEY = 'tw-talklist-naming'

export const SORT_OPTIONS: Array<{ key: TalkSortKey; label: string }> = [
  { key: 'edited', label: 'Recently edited' },
  { key: 'delivered', label: 'Recently delivered' },
  { key: 'name', label: 'Title A–Z' },
  { key: 'slides', label: 'Slide count' },
  { key: 'created', label: 'Created' }
]

export function readViewPreference(): ViewMode {
  try {
    const raw = window.localStorage.getItem(VIEW_STORAGE_KEY)
    if (raw === 'shelf') return 'shelf'
  } catch { /* storage failures fall through to the default */ }
  return 'ledger'
}

export function readNamingPreference(): NamingMode {
  try {
    if (window.localStorage.getItem(NAMING_STORAGE_KEY) === 'file') return 'file'
  } catch { /* ignore */ }
  return 'title'
}

/** The row label under the current naming mode: the real title, or the slug read as a filename. */
export function displayName(talk: TalkInfo, naming: NamingMode): string {
  return naming === 'file' ? talk.slug : talk.title
}

export function readSortPreference(): TalkSortKey {
  try {
    const raw = window.localStorage.getItem(SORT_STORAGE_KEY)
    // Legacy key from the pre-ADR-0008 panel: 'presented' is now 'delivered' (delivery-kind only).
    if (raw === 'presented') return 'delivered'
    if (SORT_OPTIONS.some((o) => o.key === raw)) return raw as TalkSortKey
  } catch { /* ignore */ }
  // Default to recency, not Title: the cold-launch job is almost always "resume yesterday's
  // talk", and an alphabetical wall gives no orientation. A user-chosen sort always wins.
  return 'edited'
}

// Last DELIVERED per slug — rehearsals and recordings never mark a talk as presented
// (honest presented-date, user decision 2026-07-10 / ADR-0008).
export function lastDeliveredBySlug(sessions: RecordingSession[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const session of sessions) {
    if (session.kind !== 'delivery') continue
    // A planned Run has not been given yet: its startedAt is only its planned date.
    if (session.status === 'planned') continue
    const started = Date.parse(session.startedAt)
    if (!Number.isFinite(started)) continue
    if (started > (out[session.talkSlug] ?? 0)) out[session.talkSlug] = started
  }
  return out
}

export function sortTalks(
  talks: TalkInfo[],
  sortKey: TalkSortKey,
  meta: TalkMeta,
  delivered: Record<string, number>
): TalkInfo[] {
  const copy = [...talks]
  const name = (a: TalkInfo, b: TalkInfo): number => a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug)
  const numericDesc = (value: (talk: TalkInfo) => number | null): ((a: TalkInfo, b: TalkInfo) => number) =>
    (a, b) => {
      const av = value(a)
      const bv = value(b)
      if (av == null && bv == null) return name(a, b)
      if (av == null) return 1
      if (bv == null) return -1
      return bv - av || name(a, b)
    }
  const comparators: Record<TalkSortKey, (a: TalkInfo, b: TalkInfo) => number> = {
    name,
    created: numericDesc((talk) => meta[talk.slug]?.createdMs ?? null),
    edited: numericDesc((talk) => meta[talk.slug]?.editedMs ?? null),
    delivered: numericDesc((talk) => delivered[talk.slug] ?? null),
    slides: numericDesc((talk) => meta[talk.slug]?.slideCount ?? null)
  }
  return copy.sort(comparators[sortKey])
}

// App-infrastructure folders to hide — only content folders are shown.
// One rule with talk search (shared/talk-search.ts), so search never finds a hidden talk.
export function isIgnoredPath(p: string): boolean {
  return isIgnoredTalkFolder(p)
}

// ── the shared tree (ADR-0029 §3, §4) ─────────────────────────────────────────
// The file list and the slide picker's Files tab draw ONE tree: every talk the file list shows,
// in nested folders at their real depth, the Archive last. Only the count differs: the file list
// counts talks, the picker counts slides (frame K1).

/** The folder tree both surfaces draw: hidden app folders dropped, talks in the given order. */
export function talkTree(talks: TalkInfo[], folders: string[], vaultRoot: string): TreeNode {
  return buildTree(
    talks.filter((t) => !isIgnoredPath(topicOf(t, vaultRoot))),
    folders.filter((f) => !isIgnoredPath(f)),
    vaultRoot
  )
}

export type TreeCountMode = 'talks' | 'slides'

/** Every folder's total, subfolders included, keyed by folder path: its number of talks
 *  ('talks'), or the sum of its talks' slide counts ('slides', from `slidesOf`). */
export function folderTotals(view: TreeNode, mode: TreeCountMode, slidesOf?: (talk: TalkInfo) => number): Map<string, number> {
  const out = new Map<string, number>()
  const weigh = (t: TalkInfo): number => (mode === 'talks' ? 1 : Math.max(0, slidesOf?.(t) ?? 0))
  const visit = (node: TreeNode): number => {
    let total = 0
    for (const t of node.talks) total += weigh(t)
    for (const child of node.children) total += visit(child)
    if (node.path) out.set(node.path, total)
    return total
  }
  visit(view)
  return out
}

// ── keyboard rows ────────────────────────────────────────────────────────────
// The flattened render order both modes share: keyboard focus walks exactly this list.

export type RowRef =
  // vaultId: which vault's folder tree the row belongs to (absent for the single tree of the slide
  // picker). Paths are vault-relative, so two vaults can each have a "Workshops".
  | { kind: 'folder'; key: string; path: string; depth: number; vaultId?: string }
  // A vault's section header, and (under an open vault with no talks yet) its empty-state block.
  // `compact`: another vault is shown, so this vault is one line. `unavailable`: the empty block is the
  // "folder not there" note (ticket 07), which is taller.
  | { kind: 'vault'; key: string; vaultId: string; compact?: boolean }
  | { kind: 'empty'; key: string; vaultId: string; unavailable?: boolean }
  // `hit`: a talk-search result row (two lines: title, then what matched).
  // `line`: the at-rest second line of a tree row (ADR-0029 §3) — drawn by Ledger only.
  | { kind: 'talk'; key: string; talk: TalkInfo; depth: number; hit?: TalkSearchHit; line?: string }

export const folderKey = (path: string, vaultId?: string): string => (vaultId ? `f:${vaultId}:${path}` : `f:${path}`)
/** The id a folder has in the collapsed set: its path, made unique per vault when there is one. */
export const collapseId = (vaultId: string | undefined, path: string): string => (vaultId ? `${vaultId}\u001f${path}` : path)
export const vaultKey = (vaultId: string): string => `v:${vaultId}`
export const emptyKey = (vaultId: string): string => `e:${vaultId}`
export const talkKey = (outlinePath: string): string => `t:${outlinePath}`

// ── Archive (ADR-0029 §3; CONTEXT.md: Archive) ─────────────────────────────────
// The old PowerPoint imports: shown last, dimmed and collapsed until opened.

export const ARCHIVE_FOLDER = 'z-old-powerpoint-imports'
export const ARCHIVE_LABEL = 'Archive · old PowerPoint imports'

/** True for the Archive folder itself and everything inside it. */
export function isArchivePath(path: string): boolean {
  return path === ARCHIVE_FOLDER || path.startsWith(`${ARCHIVE_FOLDER}/`)
}

/** A folder's children in display order: the tree's name order, with the Archive last. */
export function orderedChildren(node: TreeNode): TreeNode[] {
  const archive = node.children.filter((c) => c.path === ARCHIVE_FOLDER)
  return archive.length === 0 ? node.children : [...node.children.filter((c) => c.path !== ARCHIVE_FOLDER), ...archive]
}

/** Render-order rows for the tree view: each folder row, then (when expanded) its subfolders
 *  and the talks directly inside it — mirroring the JSX exactly, so ↑↓ never skips or invents.
 *  `lines` (outlinePath → text) gives each talk row its at-rest second line. */
export function flattenTree(view: TreeNode, collapsed: Set<string>, lines?: Map<string, string>, vaultId?: string): RowRef[] {
  const out: RowRef[] = []
  const talkRow = (t: TalkInfo, depth: number): RowRef => {
    const line = lines?.get(t.outlinePath)
    return line == null
      ? { kind: 'talk', key: talkKey(t.outlinePath), talk: t, depth }
      : { kind: 'talk', key: talkKey(t.outlinePath), talk: t, depth, line }
  }
  const walk = (node: TreeNode, depth: number): void => {
    for (const child of orderedChildren(node)) {
      out.push(vaultId
        ? { kind: 'folder', key: folderKey(child.path, vaultId), path: child.path, depth, vaultId }
        : { kind: 'folder', key: folderKey(child.path), path: child.path, depth })
      if (collapsed.has(collapseId(vaultId, child.path))) continue
      walk(child, depth + 1)
      for (const t of child.talks) out.push(talkRow(t, depth + 1))
    }
  }
  walk(view, 0)
  for (const t of view.talks) out.push(talkRow(t, 0))
  return out
}

// ── folder open/closed state (persisted across restarts) ─────────────────────
// Only the user's choices are stored (vault-relative folder path → open). A folder with no
// stored choice is closed — the Archive and every other folder, in the file list and in the slide
// picker's Files tab alike, which share this one folder memory (Dominik, 0.34.0-preview.2 check,
// 26 Sep: the folder list starts collapsed). A stored choice wins, so a folder opened or closed
// stays as left. Stored paths the tree does not have are ignored.

export type FolderOpenState = Record<string, boolean>

/** A folder without a stored choice starts closed. */
export function defaultFolderOpen(_path: string): boolean {
  return false
}

/** The collapsed set the tree renders from: every folder in `tree` whose stored choice (or,
 *  without one, the default) is closed. */
export function collapsedFrom(tree: TreeNode, open: FolderOpenState): Set<string> {
  const out = new Set<string>()
  const walk = (node: TreeNode): void => {
    for (const child of node.children) {
      const choice = open[child.path]
      if (!(typeof choice === 'boolean' ? choice : defaultFolderOpen(child.path))) out.add(child.path)
      walk(child)
    }
  }
  walk(tree)
  return out
}

/** The same open/closed choice for several folders at once (fold all, expand all). */
export function folderChoices(paths: string[], open: boolean): FolderOpenState {
  const out: FolderOpenState = {}
  for (const p of paths) if (p) out[p] = open
  return out
}

// ── at-rest second line (ADR-0029 §3; Journeys 2 and 3; frames L1, L2) ─────────

export interface SecondLineFacts {
  vaultRoot: string
  meta: TalkMeta
  /** Last DELIVERY per slug, epoch ms (lastDeliveredBySlug). */
  lastDelivered: Record<string, number>
  currentYear: number
}

/** "given 10 Jul" (the year shown only outside the current year), or "no delivery recorded". */
export function deliveryPhrase(ms: number | undefined, currentYear: number): string {
  if (!ms || !Number.isFinite(ms)) return 'no delivery recorded'
  const d = new Date(ms)
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const date = displayIsoDate(iso)
  return `given ${d.getFullYear() === currentYear ? date.replace(/ \d{4}$/, '') : date}`
}

function leafFolder(topic: string): string {
  return topic ? topic.split('/').pop() || topic : 'vault root'
}

function outlineFileName(talk: TalkInfo): string {
  return talk.outlinePath.split(/[\\/]/).pop() || talk.slug
}

/** Line two of every talk row at rest, keyed by outlinePath:
 *  · the event, or (without one) the folder — "imported" for an Archive talk — then the last
 *    delivery: "Summer School · given 8 Jul", "agents-2026 · no delivery recorded";
 *  · where two or more talks share a title, the folder, the event and the last delivery, so the
 *    versions read apart: "ai-in-education · Clinical Neuroscience · given 10 Jul";
 *  · where even that line is the same for two same-titled talks, the file name instead. */
export function secondLines(talks: TalkInfo[], facts: SecondLineFacts): Map<string, string> {
  const out = new Map<string, string>()
  const byTitle = new Map<string, TalkInfo[]>()
  for (const t of talks) {
    const k = t.title.trim().toLowerCase()
    const group = byTitle.get(k)
    if (group) group.push(t)
    else byTitle.set(k, [t])
  }
  for (const group of byTitle.values()) {
    const shared = group.length > 1
    const lines = group.map((t) => {
      const topic = topicOf(t, facts.vaultRoot)
      const event = facts.meta[t.slug]?.event?.trim() || ''
      const given = deliveryPhrase(facts.lastDelivered[t.slug], facts.currentYear)
      if (shared) return [leafFolder(topic), event, given].filter(Boolean).join(' · ')
      const where = event || (isArchivePath(topic) ? 'imported' : leafFolder(topic))
      return `${where} · ${given}`
    })
    const seen = new Map<string, number>()
    for (const line of lines) seen.set(line, (seen.get(line) ?? 0) + 1)
    const files = group.map(outlineFileName)
    const fileSeen = new Map<string, number>()
    for (const f of files) fileSeen.set(f, (fileSeen.get(f) ?? 0) + 1)
    group.forEach((t, i) => {
      if (!shared || seen.get(lines[i]) === 1) { out.set(t.outlinePath, lines[i]); return }
      out.set(t.outlinePath, fileSeen.get(files[i]) === 1 ? files[i] : `${t.slug}/${files[i]}`)
    })
  }
  return out
}

/** Flat rows while searching (folders drop away — today's behaviour, kept by the lock). */
export function flattenSearch(filtered: TalkInfo[]): RowRef[] {
  return filtered.map((t) => ({ kind: 'talk', key: talkKey(t.outlinePath), talk: t, depth: 0 }))
}

/** Flat rows for talk-search results, in the search's ranked order. A hit whose talk the panel
 *  no longer lists (deleted or moved since the search ran) is dropped, so a row never points at
 *  a talk the list does not have. */
export function flattenSearchHits(hits: TalkSearchHit[], listed: Map<string, TalkInfo>): RowRef[] {
  const rows: RowRef[] = []
  for (const hit of hits) {
    const talk = listed.get(hit.outlinePath)
    if (!talk) continue
    rows.push({ kind: 'talk', key: talkKey(talk.outlinePath), talk, depth: 0, hit })
  }
  return rows
}

/** Line two of a result whose title matched every word (frames L5, L7): where the talk lives,
 *  relative to the drilled-in folder, and when it was last given. The year is dropped for the
 *  current year, as the drawings do. */
export function quietSearchLine(hit: TalkSearchHit, focusPath: string, currentYear: number): string {
  let folder = hit.folder
  if (focusPath && (folder === focusPath || folder.startsWith(`${focusPath}/`))) folder = folder.slice(focusPath.length).replace(/^\//, '')
  const parts: string[] = []
  if (folder) parts.push(folder.split('/').join(' / '))
  if (hit.lastGiven) {
    const date = displayIsoDate(hit.lastGiven)
    parts.push(`given ${hit.lastGiven.startsWith(String(currentYear)) ? date.replace(/ \d{4}$/, '') : date}`)
  }
  return parts.join(' · ')
}

// ── formatting ───────────────────────────────────────────────────────────────

/** Compact recency for badges / the Shelf's quiet edited date: 'today' | '1d' | 'Nd'. */
export function relDays(ms: number | undefined | null): string | null {
  if (!ms || !Number.isFinite(ms)) return null
  const now = new Date()
  const d = new Date(ms)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const thatDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((today - thatDay) / 86_400_000)
  if (diff <= 0) return 'today'
  if (diff === 1) return '1d'
  return `${diff}d`
}

/** Human short date for the flyout: today / yesterday / Nd ago / 12 Jun [2025]. */
export function formatShortDate(ms: number | undefined | null): string {
  if (!ms || !Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const thatDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diffDays = Math.round((today - thatDay) / 86_400_000)
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  if (diffDays > 1 && diffDays < 7) return `${diffDays}d ago`
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' })
  })
}

/** Folders that can be a move target = every existing folder + the vault root (''). */
export function allMoveTopics(talks: TalkInfo[], folders: string[], vaultRoot: string): string[] {
  const set = new Set<string>([''])
  for (const t of talks) set.add(topicOf(t, vaultRoot))
  for (const f of folders) if (f) set.add(f)
  return Array.from(set)
    .filter((t) => !isIgnoredPath(t))
    .sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
}
