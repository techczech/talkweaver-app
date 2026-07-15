import type { RecordingSession, TalkInfo, TalkMeta } from '../../../../preload/index'
import { type TreeNode, topicOf } from '../talkTreeNav.ts'

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
export function isIgnoredPath(p: string): boolean {
  return ['cache', 'scripts'].includes(p.split('/')[0].toLowerCase())
}

// ── keyboard rows ────────────────────────────────────────────────────────────
// The flattened render order both modes share: keyboard focus walks exactly this list.

export type RowRef =
  | { kind: 'folder'; key: string; path: string; depth: number }
  | { kind: 'talk'; key: string; talk: TalkInfo; depth: number }

export const folderKey = (path: string): string => `f:${path}`
export const talkKey = (outlinePath: string): string => `t:${outlinePath}`

/** Render-order rows for the tree view: each folder row, then (when expanded) its subfolders
 *  and the talks directly inside it — mirroring the JSX exactly, so ↑↓ never skips or invents. */
export function flattenTree(view: TreeNode, collapsed: Set<string>): RowRef[] {
  const out: RowRef[] = []
  const walk = (node: TreeNode, depth: number): void => {
    for (const child of node.children) {
      out.push({ kind: 'folder', key: folderKey(child.path), path: child.path, depth })
      if (collapsed.has(child.path)) continue
      walk(child, depth + 1)
      for (const t of child.talks) out.push({ kind: 'talk', key: talkKey(t.outlinePath), talk: t, depth: depth + 1 })
    }
  }
  walk(view, 0)
  for (const t of view.talks) out.push({ kind: 'talk', key: talkKey(t.outlinePath), talk: t, depth: 0 })
  return out
}

/** Flat rows while searching (folders drop away — today's behaviour, kept by the lock). */
export function flattenSearch(filtered: TalkInfo[]): RowRef[] {
  return filtered.map((t) => ({ kind: 'talk', key: talkKey(t.outlinePath), talk: t, depth: 0 }))
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
