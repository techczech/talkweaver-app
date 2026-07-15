// Pure model for the unified Slide Browser rail (ADR-0009 v0.15 wave-1 lock).
// Composition law: Search finds · Scope pins places · Browse walks them · Filters narrow
// by property. No React/DOM imports — keep this ERASABLE TypeScript (types only, no enums)
// so a node test can strip-run it like slideBrowserModel.ts.
import { type BrowserRow, isIconSlide } from '../slideBrowserModel'

/* ============================================================
   Scope — full-width rows, never chips (taste rule)
   ============================================================ */

// A pinned place. `sec` is the projection's section SLUG; `secLabel` the authored display
// name captured at pin time (the row keeps showing the name even if the query later hides
// the section-title row the name came from).
export interface ScopeEntry {
  kind: 'folder' | 'talk' | 'section'
  folder?: string
  talk?: string
  talkTitle?: string
  sec?: string
  secLabel?: string
}

export function scopeKeyOf(e: ScopeEntry): string {
  return `${e.kind}:${e.folder ?? e.talk ?? ''}${e.sec != null ? `:${e.sec}` : ''}`
}

export function scopeDisplayName(e: ScopeEntry): string {
  if (e.kind === 'folder') return e.folder ?? ''
  const t = e.talkTitle || e.talk || ''
  return e.kind === 'talk' ? t : `${t} § ${e.secLabel || e.sec || '(no section)'}`
}

// Does one result row fall inside one scope entry? `folderOf` maps talkSlug → parent folder.
export function rowInScopeEntry(row: BrowserRow, e: ScopeEntry, folderOf: (slug: string) => string): boolean {
  if (e.kind === 'folder') return folderOf(row.talkSlug) === e.folder
  if (e.kind === 'talk') return row.talkSlug === e.talk
  return row.talkSlug === e.talk && (row.section ?? '') === (e.sec ?? '')
}

// Empty scope = the whole vault (never "nothing").
export function rowInScope(row: BrowserRow, scope: ScopeEntry[], folderOf: (slug: string) => string): boolean {
  return scope.length === 0 || scope.some((e) => rowInScopeEntry(row, e, folderOf))
}

// The distinct talks the scope pins, in pin order (folders expand to their talks).
// Drives the grid mode: 1 → outline view, 2–3 → side-by-side columns, >3 → sequential.
export function scopedTalkSlugs(scope: ScopeEntry[], talksInFolder: (folder: string) => string[]): string[] {
  const seen: string[] = []
  for (const e of scope) {
    const list = e.kind === 'folder' ? talksInFolder(e.folder ?? '') : e.talk ? [e.talk] : []
    for (const slug of list) if (!seen.includes(slug)) seen.push(slug)
  }
  return seen
}

// Toggle semantics from the lock: plain click REPLACES the scope (re-click of the sole
// entry clears it); ⌘click toggles the entry in or out of the set. Returns a new array.
export function toggleScope(scope: ScopeEntry[], entry: ScopeEntry, additive: boolean): ScopeEntry[] {
  const key = scopeKeyOf(entry)
  const idx = scope.findIndex((e) => scopeKeyOf(e) === key)
  if (additive) {
    if (idx >= 0) return scope.filter((_e, i) => i !== idx)
    return [...scope, entry]
  }
  return idx >= 0 && scope.length === 1 ? [] : [entry]
}

/* ============================================================
   Facets — Layout · Content · Tags · Sections (ADR-0037 grammar)
   AND across kinds, OR within one.
   ============================================================ */

export type ContentKey = 'image' | 'icon' | 'video' | 'code'
export const CONTENT_KEYS: ContentKey[] = ['image', 'icon', 'video', 'code']
export const CONTENT_LABELS: Record<ContentKey, string> = {
  image: 'has image', icon: 'has icon', video: 'has video', code: 'has code'
}

// Cheap per-row content flags off the projection: image_count / embed_count / has_code are
// indexed fields; icon reuses the Browser's isIconSlide. `video` keys off embed_count, which
// counts video AND embed blocks — the projection has no video-only count, and the two share
// the media slot in the compiler, so the pill is honestly "carries embedded media".
export function rowHasContent(r: BrowserRow, key: ContentKey): boolean {
  switch (key) {
    case 'image': return (r.image_count ?? 0) > 0
    case 'icon': return isIconSlide(r)
    case 'video': return (r.embed_count ?? 0) > 0
    case 'code': return r.has_code === true || /(^|\n)```/.test(r.source_markdown || '')
  }
}

export interface RailFacets {
  /** Curated tags (filled chips) — OR within. */
  tagSet: Set<string>
  /** Observed section DISPLAY labels (hollow chips) — identity is the section string
   *  across the scoped set (stage-3-lite; per-talk identity is a later wave). */
  sectionSet: Set<string>
  /** Layout registry names — OR within. */
  layoutSet: Set<string>
  /** Content flags — OR within. */
  contentSet: Set<ContentKey>
}

export function emptyFacets(): RailFacets {
  return { tagSet: new Set(), sectionSet: new Set(), layoutSet: new Set(), contentSet: new Set() }
}

export function anyFacetActive(f: RailFacets): boolean {
  return f.tagSet.size > 0 || f.sectionSet.size > 0 || f.layoutSet.size > 0 || f.contentSet.size > 0
}

// The row's layout the way the Browser filters see it: the trigger token wins, the empty
// layout reads as 'default' so the registry's default entry aggregates untriggered slides.
export function facetLayoutOf(r: BrowserRow): string {
  return (r.triggers?.layout || r.layout || '') || 'default'
}

// AND across kinds, OR within one (the lock's law). `secLabel` resolves a row's section to
// its display label (authored name when known, slug otherwise); `tagsOf` reads the row's
// curated tags (the component supplies the pre-tags-index fallback parse).
export function passesFacets(
  r: BrowserRow,
  f: RailFacets,
  secLabel: (r: BrowserRow) => string,
  tagsOf: (r: BrowserRow) => string[]
): boolean {
  if (f.tagSet.size > 0 && !tagsOf(r).some((t) => f.tagSet.has(t))) return false
  if (f.sectionSet.size > 0 && !f.sectionSet.has(secLabel(r))) return false
  if (f.layoutSet.size > 0 && !f.layoutSet.has(facetLayoutOf(r))) return false
  if (f.contentSet.size > 0 && ![...f.contentSet].some((k) => rowHasContent(r, k))) return false
  return true
}

/* ============================================================
   Conditioned facet-count bases (v0.15.2 tweak) — standard
   faceted-search law: each kind's chip counts are computed with
   every OTHER kind's selections applied, but never its own, so
   siblings within a kind still show what switching/adding would
   give while cross-kind combinations can't dead-end unannounced.
   Scope + search condition everything (the caller pre-filters).
   ============================================================ */

export interface FacetKindBases {
  /** Rows passing every kind EXCEPT Layout — the Layout chips' count base. */
  lay: BrowserRow[]
  /** …except Content. */
  ct: BrowserRow[]
  /** …except Tags. */
  tags: BrowserRow[]
  /** …except Sections. */
  secs: BrowserRow[]
}

// One pass over the (scope+search-filtered) rows, evaluating each kind's OR-predicate once
// per row and composing the four leave-one-out bases. Cheap and allocation-light — the
// Browser memoises the result on (scope, query, facet-state).
export function facetKindBases(
  rows: BrowserRow[],
  f: RailFacets,
  secLabel: (r: BrowserRow) => string,
  tagsOf: (r: BrowserRow) => string[]
): FacetKindBases {
  const out: FacetKindBases = { lay: [], ct: [], tags: [], secs: [] }
  for (const r of rows) {
    const tagOk = f.tagSet.size === 0 || tagsOf(r).some((t) => f.tagSet.has(t))
    const secOk = f.sectionSet.size === 0 || f.sectionSet.has(secLabel(r))
    const layOk = f.layoutSet.size === 0 || f.layoutSet.has(facetLayoutOf(r))
    const ctOk = f.contentSet.size === 0 || [...f.contentSet].some((k) => rowHasContent(r, k))
    if (tagOk && secOk && ctOk) out.lay.push(r)
    if (tagOk && secOk && layOk) out.ct.push(r)
    if (secOk && layOk && ctOk) out.tags.push(r)
    if (tagOk && layOk && ctOk) out.secs.push(r)
  }
  return out
}

/* ============================================================
   Capped lists — long vocabularies (75+ layouts, growing tags)
   ============================================================ */

// A sub-group's list: the inline search always sees the WHOLE vocabulary; the cap only
// applies with no query and no explicit Show-all. `hiddenCount` > 0 → render "Show all N".
export function capItems<T>(items: T[], cap: number, showAll: boolean, query: string): { shown: T[]; hiddenCount: number } {
  const capped = !showAll && query.trim() === '' && items.length > cap
  return { shown: capped ? items.slice(0, cap) : items, hiddenCount: capped ? items.length - cap : 0 }
}

/* ============================================================
   Grid mode — the lock's view law
   ============================================================ */

export type GridMode = 'grouped' | 'outline' | 'side'

// No scope → today's grouped view. One talk → outline order. 2–3 → side-by-side columns
// (user-toggleable to sequential). >3 → sequential outline order (columns would starve).
export function gridModeFor(nScopedTalks: number, prefSide: boolean): GridMode {
  if (nScopedTalks === 0) return 'grouped'
  if (nScopedTalks === 1) return 'outline'
  if (nScopedTalks <= 3 && prefSide) return 'side'
  return 'outline'
}

// One talk's rows in outline order, chunked by section for the §-headed outline view.
export interface OutlineChunk { section: string; rows: BrowserRow[] }
export function outlineChunks(rows: BrowserRow[]): OutlineChunk[] {
  const sorted = [...rows].sort((a, b) => ((a as { order?: number }).order ?? 0) - ((b as { order?: number }).order ?? 0))
  const chunks: OutlineChunk[] = []
  for (const r of sorted) {
    const sec = r.section ?? ''
    const last = chunks[chunks.length - 1]
    if (last && last.section === sec) last.rows.push(r)
    else chunks.push({ section: sec, rows: [r] })
  }
  return chunks
}

/* ============================================================
   Search reports both kinds — the talk-hit cluster
   ============================================================ */

// Talks whose TITLE carries every query term (order-independent, like the slide match).
export function talkTitleHits<T extends { title: string }>(talks: T[], terms: string[]): T[] {
  if (terms.length === 0) return []
  return talks.filter((t) => {
    const hay = t.title.toLowerCase()
    return terms.every((w) => hay.includes(w))
  })
}

/* ============================================================
   Relative time — Collections rows
   ============================================================ */

const MIN = 60000
const HOUR = 3600000
const DAY = 86400000

export function agoLabel(ms: number, now: number = Date.now()): string {
  const d = Math.max(0, now - ms)
  if (d < MIN) return 'just now'
  if (d < HOUR) return `${Math.floor(d / MIN)}m ago`
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`
  const days = Math.floor(d / DAY)
  if (days === 1) return 'yesterday'
  if (days < 60) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}
