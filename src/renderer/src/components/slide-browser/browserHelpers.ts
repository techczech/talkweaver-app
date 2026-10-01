// Pure helpers for the Slide Browser: formatting, small set operations, and the derivations the
// grid and the rail read. No React and no DOM imports — erasable TypeScript, so a node test
// strip-runs the real module (scripts/test-slide-browser-helpers.mjs).
import { plainInlineText } from '../../../../../compiler/scripts/lib/00-inline-render.mjs'
import type { LedgerVersion, RecordingSession, TagCount, TalkInfo, TalkMeta } from '../../../../preload/index'
import { tagsOfBlock } from '../../../../shared/tags.ts'
import {
  type ContentKey, type RailFacets,
  CONTENT_KEYS, CONTENT_LABELS, agoLabel, facetLayoutOf, outlineChunks, rowHasContent
} from '../browser-rail/railModel.ts'
import type { ContentItem, CollectionRow, FacetItem, FacetKind, TreeSection } from '../browser-rail/railTypes'
import { folderPathOf } from '../browser-rail/filesTreeModel.ts'
import {
  type BrowserRow, type DisplayCard, sectionInsertSource, sectionKey, sectionNamesByKey, selRowKey
} from '../slideBrowserModel.ts'
import {
  DENSITY_DEFAULT, DENSITY_STORAGE_KEY, type OutlineTalkPlan, type SearchResult
} from './types.ts'

/* ---------- formatting ---------- */

export function rowMarkdown(row: SearchResult): string {
  return row.source_markdown && row.source_markdown.trim() !== ''
    ? row.source_markdown
    : `### ${row.nav_title || row.title || 'Untitled'}\n`
}

export function rowTitle(row: SearchResult): string {
  return plainInlineText(row.nav_title || row.title) || '(untitled)'
}

// 'd MMM yyyy' (en-GB): 28 Jun 2026 — mono in the print caption.
const VDATE_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
export function formatVersionDate(savedAt: string | number | Date): string {
  return VDATE_FMT.format(new Date(savedAt))
}

// Schematic fallback title for a version print: the heading text without tokens.
export function versionTitle(markdown: string): string {
  const first = (markdown.split('\n', 1)[0] ?? '').replace(/^#+\s*/, '').replace(/\{[^}]*\}/g, '').trim()
  return first || '(untitled)'
}

// Unsealed but superseded = a later save replaced it without a presenting/export/publish seal;
// only the head is genuinely 'current session'.
export function sealLabel(v: Pick<LedgerVersion, 'sealedBy'>, idx: number): string {
  return v.sealedBy
    ? `sealed by ${v.sealedBy === 'present' ? 'presenting' : v.sealedBy}`
    : idx === 0 ? 'current session' : 'sealed by later edit'
}

/** The card's hover title, by what kind of card it is. */
export function cardTitleFor(kind: DisplayCard['kind'], count: number | undefined): string {
  return kind === 'identical'
    ? `${count} byte-identical copies — E for where they live`
    : kind === 'near'
      ? `${count} near-identical variants — U to uncollapse and compare`
      : 'Click selects · ⇧-click range · Space preview · ↵ view & insert'
}

/** The header's result count: the search state first, then the grid mode's own noun pair. */
export function countLabelFor(s: {
  unavailable: boolean; loading: boolean; grouped: boolean
  slideCount: number; sectionCount: number; leftCount: number; talkCount: number
}): string {
  if (s.unavailable) return 'search unavailable'
  if (s.loading) return 'searching…'
  if (s.grouped) {
    return `${s.slideCount} slide${s.slideCount === 1 ? '' : 's'} · ${s.sectionCount} section${s.sectionCount === 1 ? '' : 's'}`
  }
  return `${s.leftCount} slide${s.leftCount === 1 ? '' : 's'} · ${s.talkCount} talk${s.talkCount === 1 ? '' : 's'}`
}

/* ---------- density ---------- */

export function clampDensity(d: number): number {
  return Math.min(6, Math.max(2, d))
}

export function readDensity(): number {
  try {
    const n = parseInt(window.localStorage.getItem(DENSITY_STORAGE_KEY) ?? '', 10)
    return Number.isFinite(n) ? clampDensity(n) : DENSITY_DEFAULT
  } catch {
    return DENSITY_DEFAULT
  }
}

/* ---------- sets and selection ---------- */

export function toggleInSet<T>(prev: Set<T>, value: T): Set<T> {
  const n = new Set(prev)
  if (n.has(value)) n.delete(value)
  else n.add(value)
  return n
}

export function addAllToSet<T>(prev: Set<T>, values: Iterable<T>): Set<T> {
  const n = new Set(prev)
  for (const v of values) n.add(v)
  return n
}

/** The current tag list of one result row: the projection's `tags` (post-tags index rows),
 *  falling back to a source parse for rows from a pre-tags cached index. */
export function rowTagsOf(row: { tags?: string[]; source_markdown?: string }): string[] {
  return row.tags ?? tagsOfBlock(row.source_markdown)
}

/** The optimistic in-place tag change of a row after tags:apply succeeded. */
export function tagsAfter(current: string[], tag: string, action: 'add' | 'remove'): string[] {
  return action === 'add' ? (current.includes(tag) ? current : [...current, tag]) : current.filter((t) => t !== tag)
}

/** What an insert hands the host, per row. */
export function insertItemsFor(rows: SearchResult[]): { markdown: string; fromSlug: string; sourceOutlinePath: string }[] {
  return rows.map((r) => ({ markdown: rowMarkdown(r), fromSlug: r.talkSlug, sourceOutlinePath: r.outlinePath }))
}

/** A version's source outline: its own vault-relative `outline` against the vault root (an old
 *  version's relative images live in ITS talk); the card's outline only for pre-outline records. */
export function versionSourceOutline(v: Pick<LedgerVersion, 'outline'>, vaultRoot: string, fallback: string): string {
  return v.outline ? `${vaultRoot.replace(/\/$/, '')}/${v.outline}` : fallback
}

/** Where the open expansion sits in the visual order (or -1: filtered away). */
export function expansionPos(vRows: SearchResult[], expandedRowKey: string | null): number {
  return expandedRowKey ? vRows.findIndex((_r, i) => selRowKey(vRows, i) === expandedRowKey) : -1
}

/** The index (within a grid's cards) after which the expansion row is inserted: the end of the
 *  grid row holding the expanded card; -1 when the expanded card is not in this grid. */
export function expansionAfterIndex(expandedPos: number, base: number, count: number, cols: number): { jExp: number; expAfter: number } {
  const jExp = expandedPos >= base && expandedPos < base + count ? expandedPos - base : -1
  const expAfter = jExp >= 0 ? Math.min(count - 1, (Math.floor(jExp / cols) + 1) * cols - 1) : -1
  return { jExp, expAfter }
}

/* ---------- facets ---------- */

const FACET_SET_KEY = { tag: 'tagSet', sec: 'sectionSet', lay: 'layoutSet', content: 'contentSet' } as const
export function toggleFacetValue(f: RailFacets, kind: FacetKind, value: string): RailFacets {
  const key = FACET_SET_KEY[kind]
  return { ...f, [key]: toggleInSet(f[key] as Set<string>, value) } as RailFacets
}

/* ---------- derivations over the index snapshot ---------- */

/** Each talk's vault-relative folder path, nested folders at their real depth. '' = the root. */
export function folderMap(talks: TalkInfo[], vaultRoot: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const t of talks) m.set(t.slug, folderPathOf(t, vaultRoot))
  return m
}

/** Authored section names, resolved over the FULL snapshot with the live results as fallback. */
export function mergedSectionNames(fullRows: SearchResult[], results: SearchResult[]): Map<string, string> {
  const m = sectionNamesByKey(fullRows)
  for (const [k, v] of sectionNamesByKey(results)) if (!m.has(k)) m.set(k, v)
  return m
}

export function rowsGroupedByTalk(rows: SearchResult[]): Map<string, SearchResult[]> {
  const m = new Map<string, SearchResult[]>()
  for (const r of rows) {
    const list = m.get(r.talkSlug)
    if (list) list.push(r)
    else m.set(r.talkSlug, [r])
  }
  return m
}

/** The active talk is NEVER on the table: its own slides live in the grid/strip. */
export function withoutActiveTalk(results: SearchResult[], currentTalkSlug: string): SearchResult[] {
  return currentTalkSlug ? results.filter((r) => r.talkSlug !== currentTalkSlug) : results
}

/** §-numbers per talk in first-appearance order, keyed by talk+section. */
export function sectionNumbers(rows: SearchResult[]): Map<string, number> {
  const m = new Map<string, number>()
  const perTalk = new Map<string, number>()
  for (const r of rows) {
    const key = sectionKey(r.talkSlug, r.section ?? '')
    if (m.has(key)) continue
    const n = (perTalk.get(r.talkSlug) ?? 0) + 1
    perTalk.set(r.talkSlug, n)
    m.set(key, n)
  }
  return m
}

/** Display titles: the vault list first (covers talks with no matching rows), results fallback. */
export function titleMap(talks: TalkInfo[], results: SearchResult[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const t of talks) m.set(t.slug, t.title || t.slug)
  for (const r of results) if (!m.has(r.talkSlug)) m.set(r.talkSlug, r.talkTitle || r.talkSlug)
  return m
}

/** Scoped views show each talk AS IT RUNS: every passing occurrence is its own card in outline
 *  order (no duplicate collapse — position badges need the real sequence). */
export function buildOutlinePlan(a: {
  grouped: boolean
  scopedSlugs: string[]
  visibleResults: SearchResult[]
  passing: (r: SearchResult) => boolean
  talks: TalkInfo[]
  secName: (key: string, fallback: string) => string
}): OutlineTalkPlan[] {
  if (a.grouped) return []
  return a.scopedSlugs.map((slug) => {
    const mine = a.visibleResults.filter((r) => r.talkSlug === slug && a.passing(r))
    const chunks = outlineChunks(mine).map((c) => ({
      section: c.section,
      label: a.secName(sectionKey(slug, c.section), c.section),
      cards: c.rows.map((row) => ({ row, kind: 'single' as const }))
    }))
    const title = mine[0]?.talkTitle || a.talks.find((t) => t.slug === slug)?.title || slug
    return { slug, title, total: mine.length, chunks }
  })
}

/** The viewed slide's source talk, WHOLE deck, in outline order — from the index snapshot; the
 *  query-narrowed results only stand in for a talk the snapshot hasn't caught yet. */
export function viewerDeckFor(
  viewer: { slug: string } | null, fullRows: SearchResult[], results: SearchResult[]
): SearchResult[] {
  if (!viewer) return []
  const src = fullRows.some((r) => r.talkSlug === viewer.slug) ? fullRows : results
  return src
    .filter((r) => r.talkSlug === viewer.slug)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

export function viewerIndexFor(viewer: { order: number } | null, deck: SearchResult[]): number {
  return viewer ? Math.max(0, deck.findIndex((r) => (r.order ?? 0) === viewer.order)) : 0
}

/** Insert-section source for a heading, from the WHOLE talk's rows (null until they are fetched). */
export function sectionSourceFor(rowsByTalk: Map<string, SearchResult[]>, slug: string, section: string) {
  const whole = rowsByTalk.get(slug)
  return whole ? sectionInsertSource(whole, slug, section) : null
}

/* ---------- rail vocabularies (all in-memory rows, no IPC) ---------- */

export function countByTalk(rows: SearchResult[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows) m.set(r.talkSlug, (m.get(r.talkSlug) ?? 0) + 1)
  return m
}

/** Files tree sections: observed from the full snapshot, in outline order, with authored labels. */
export function treeSectionsBySlug(
  fullRows: SearchResult[], secName: (key: string, fallback: string) => string
): Map<string, TreeSection[]> {
  const m = new Map<string, TreeSection[]>()
  for (const r of fullRows) {
    const sec = r.section ?? ''
    if (sec === '') continue
    let list = m.get(r.talkSlug)
    if (!list) { list = []; m.set(r.talkSlug, list) }
    const hit = list.find((s) => s.sec === sec)
    if (hit) hit.count++
    else list.push({ sec, label: secName(sectionKey(r.talkSlug, sec), sec), count: 1 })
  }
  return m
}

export function coverUrlOf(talk: string | undefined, talkMeta: TalkMeta): string | null {
  if (!talk) return null
  const key = talkMeta[talk]?.coverKey
  return key ? `twthumb://${talk}/${key}` : null
}

export function recentEditRows(talkMeta: TalkMeta, titleBySlug: Map<string, string>): CollectionRow[] {
  return Object.entries(talkMeta)
    .filter(([, m]) => (m.editedMs ?? 0) > 0)
    .sort((a, b) => b[1].editedMs - a[1].editedMs)
    .slice(0, 6)
    .map(([slug, m]) => ({
      key: `edit:${slug}`,
      slug,
      title: titleBySlug.get(slug) ?? slug,
      when: agoLabel(m.editedMs)
    }))
}

export function deliveryRows(sessions: RecordingSession[], titleBySlug: Map<string, string>): CollectionRow[] {
  // A planned Run has not been given: no end time, and it must not read as a recent delivery.
  return sessions.filter((s) => s.status !== 'planned')
    .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt))
    .slice(0, 8)
    .map((s) => ({
      key: `run:${s.id}`,
      slug: s.talkSlug,
      title: s.talkTitle || titleBySlug.get(s.talkSlug) || s.talkSlug,
      sub: s.context ?? undefined,
      when: agoLabel(Date.parse(s.endedAt))
    }))
}

/** Layout chips: the registry's layouts plus any the vault uses, ordered by conditioned count. */
export function layoutFacetItems(
  registryLayouts: string[], fullRows: SearchResult[], layoutBase: BrowserRow[]
): FacetItem[] {
  const names = new Set<string>(registryLayouts)
  for (const r of fullRows) names.add(facetLayoutOf(r))
  const counts = new Map<string, number>()
  for (const r of layoutBase) counts.set(facetLayoutOf(r), (counts.get(facetLayoutOf(r)) ?? 0) + 1)
  return [...names]
    .map((value) => ({ value, count: counts.get(value) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

export function contentFacetItems(contentBase: BrowserRow[]): ContentItem[] {
  return CONTENT_KEYS.map((key: ContentKey) => ({
    key,
    label: CONTENT_LABELS[key],
    count: contentBase.reduce((n, r) => n + (rowHasContent(r, key) ? 1 : 0), 0)
  }))
}

export function tagFacetItems(tagVocab: TagCount[], fullRows: SearchResult[], tagBase: BrowserRow[]): FacetItem[] {
  const vault = new Map<string, number>(tagVocab.map((t) => [t.name, t.count]))
  for (const r of fullRows) for (const t of rowTagsOf(r)) if (!vault.has(t)) vault.set(t, 0)
  const counts = new Map<string, number>()
  for (const r of tagBase) for (const t of rowTagsOf(r)) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...vault.entries()]
    .map(([value, vaultCount]) => ({ value, count: counts.get(value) ?? 0, vaultCount }))
    .sort((a, b) => b.count - a.count || b.vaultCount - a.vaultCount || a.value.localeCompare(b.value))
    .map(({ value, count }) => ({ value, count }))
}

/** Section chips. Vocabulary comes from the scope+search base (a section zeroed by OTHER kinds
 *  is still LISTED, dimmed with 0); counts from the leave-Sections-out base; active selections
 *  stay listed (and removable) even when the scope no longer shows them. */
export function sectionFacetItems(
  baseRows: SearchResult[], sectionBase: BrowserRow[], activeSections: Set<string>,
  secLabelOf: (r: BrowserRow) => string
): FacetItem[] {
  const counts = new Map<string, number>()
  for (const r of baseRows) {
    const label = secLabelOf(r)
    if (label !== '' && !counts.has(label)) counts.set(label, 0)
  }
  for (const r of sectionBase) {
    const label = secLabelOf(r)
    if (label === '') continue
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  for (const s of activeSections) if (!counts.has(s)) counts.set(s, 0)
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}
