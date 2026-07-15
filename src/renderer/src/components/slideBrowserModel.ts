// Pure model helpers for the Slide Browser (ADR-0034 Light Table). No React/DOM imports —
// node-tested directly by scripts/test-browser-model.mjs (Node ≥23.6 strips types natively),
// so keep this file to ERASABLE TypeScript only: types/interfaces, no enums, no namespaces.
//
// The selection helpers (selRowKey → groupBySection) moved here VERBATIM from
// searchPaletteSelection.ts, which now re-exports them so SearchPalette keeps compiling
// until Task 12 deletes it.

export interface SelRow {
  talkSlug: string
  slide_id?: string
  section?: string
}

export function selRowKey(rows: SelRow[], idx: number): string {
  return `${rows[idx].talkSlug}:${rows[idx].slide_id ?? idx}`
}

// rowKeys for the contiguous range between two indices (inclusive), in order.
export function rangeKeys(rows: SelRow[], anchor: number, active: number): string[] {
  const lo = Math.max(0, Math.min(anchor, active))
  const hi = Math.min(rows.length - 1, Math.max(anchor, active))
  const out: string[] = []
  for (let i = lo; i <= hi; i++) out.push(selRowKey(rows, i))
  return out
}

// rowKeys of all rows sharing the same talkSlug + `##` section as rows[idx].
export function sectionKeysAt(rows: SelRow[], idx: number): string[] {
  const r = rows[idx]
  if (!r) return []
  const sec = r.section ?? ''
  const out: string[] = []
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].talkSlug === r.talkSlug && (rows[i].section ?? '') === sec) out.push(selRowKey(rows, i))
  }
  return out
}

export function isSingleTalk(rows: SelRow[]): boolean {
  return rows.length > 0 && rows.every((r) => r.talkSlug === rows[0].talkSlug)
}

// Ordered groups by `##` section (first-appearance order); indices point back into `rows`.
export function groupBySection(rows: SelRow[]): Array<{ section: string; indices: number[] }> {
  const order: string[] = []
  const map = new Map<string, number[]>()
  rows.forEach((r, i) => {
    const s = r.section ?? ''
    if (!map.has(s)) { map.set(s, []); order.push(s) }
    map.get(s)!.push(i)
  })
  return order.map((section) => ({ section, indices: map.get(section)! }))
}

/* ============================================================
   Scoped search operators (t:/s:/i:/e:) + title-priority ranking
   ============================================================ */

// The structured query the Browser hands to main's `search:all-slides`. `scope` picks which
// field(s) are matched; `exact` makes it a contiguous phrase match on `text`; otherwise every
// word in `terms` must appear somewhere in the field (order-independent, as before).
export interface ParsedQuery {
  scope: 'all' | 'title' | 'body' | 'image'
  exact: boolean
  /** Exact search → the contiguous phrase to match (surrounding quotes stripped). Non-exact →
   *  the human-readable remainder; `terms` is what the all-words match actually consumes. */
  text: string
  terms: string[]
}

// A leading single-letter operator (case-insensitive) then a colon, at the VERY start of the
// query, with optional whitespace after the colon. Only t/s/i/e qualify — so `http://x` (starts
// `h:`… no, `http:`) and `foo:bar` are never operators, and a bare `about me` stays a plain query.
const SEARCH_OP_RE = /^([tsie]):\s*([\s\S]*)$/i
const OP_SCOPE: Record<string, ParsedQuery['scope']> = { t: 'title', s: 'body', i: 'image' }

// Strip ONE pair of matching surrounding quotes so `e:"exact phrase"` matches the bare phrase.
function stripWrappingQuotes(s: string): string {
  if (s.length >= 2) {
    const a = s[0]
    const b = s[s.length - 1]
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return s.slice(1, -1)
  }
  return s
}

// Parse a raw search string into a scoped/exact structured query. No recognised operator → an
// all-fields, all-words query over the raw string (today's behaviour, verbatim). A recognised
// operator sets the scope (t: title, s: slide body, i: image text) or exact (e:), and the
// remainder — trimmed, surrounding quotes stripped — becomes text/terms. An operator with an
// empty remainder (e.g. `t:`) yields empty terms, which (like an empty query) matches everything
// in that scope.
export function parseSearchQuery(raw: string): ParsedQuery {
  const s = String(raw ?? '')
  const m = SEARCH_OP_RE.exec(s)
  if (!m) {
    return { scope: 'all', exact: false, text: s, terms: s.toLowerCase().split(/\s+/).filter(Boolean) }
  }
  const op = m[1].toLowerCase()
  const text = stripWrappingQuotes(m[2].trim())
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean)
  if (op === 'e') return { scope: 'all', exact: true, text, terms }
  return { scope: OP_SCOPE[op], exact: false, text, terms }
}

// A short label for the field(s) a scoped/exact query looks in — drives the zero-results copy.
export function scopeNoun(q: ParsedQuery): string {
  if (q.exact) return 'that exact phrase'
  switch (q.scope) {
    case 'title': return 'that in the title'
    case 'body': return 'that in the slide text'
    case 'image': return 'that in image text'
    default: return 'that'
  }
}

// Stable title-priority partition: rows whose title matched the query (titleHit, set by main)
// float to the front in their original order; everything else keeps its original order behind
// them. Applied to the result set BEFORE grouping/clustering so title hits surface first within
// each talk·section group ("prioritise text in title anyway"). Returns the SAME row objects
// reordered (never clones) so identity-keyed passing-set membership survives.
export function rankBySearch<T extends { titleHit?: boolean }>(rows: T[]): T[] {
  const hits: T[] = []
  const rest: T[] = []
  for (const r of rows) (r.titleHit ? hits : rest).push(r)
  return hits.length === 0 || rest.length === 0 ? rows : [...hits, ...rest]
}

/* ============================================================
   Slide Browser filtering — ports SearchPalette's `shown` memo
   semantics 1:1 (layoutOf / isIconSlide / isTitleOnly predicates
   + every filter), with Talk and Section widened to multi-sets
   for the chip row and the index rail.
   ============================================================ */

// The subset of a search-result row the model reads. Structurally compatible with
// ProjectionRow & {talkSlug, talkTitle, …} — the component passes its rows straight in.
export interface BrowserRow extends SelRow {
  talkTitle?: string
  subsection?: string
  role?: string
  nav_title?: string
  title?: string
  layout?: string
  triggers?: Record<string, string>
  source_markdown?: string
  image_count?: number
  bullet_count?: number
  word_count?: number
  /** Embed OR video blocks (the projection has no video-only count). */
  embed_count?: number
  has_code?: boolean
  /** Outline position within the talk (0-based projection order). */
  order?: number
  talkMeta?: string
  talkMtimeMs?: number
}

const ICON_LAYOUTS = new Set(['iconrow', 'iconlist'])
const DAY_MS = 86400000

export function layoutOf(r: BrowserRow): string {
  return (r.triggers?.layout || r.layout || '') as string
}
export function isIconSlide(r: BrowserRow): boolean {
  return ICON_LAYOUTS.has(layoutOf(r)) || /\{icon[=}]/.test(r.source_markdown || '')
}
// A section divider (heading-is-slide model): a node with children. The `subsection-title` LAYOUT
// is no longer emitted for content-bearing dividers, so we key off `role` — which the compiler
// derives DIRECTLY from `isSection` (08-source-adapters: isSection ⇒ section-title | subsection-title,
// and a leaf can never carry those roles), making it a faithful proxy for isSection on the row.
export function isSectionRow(r: BrowserRow): boolean {
  return r.role === 'section-title' || r.role === 'subsection-title'
}
export function isTitleOnly(r: BrowserRow): boolean {
  if (isSectionRow(r) || layoutOf(r) === 'title') return true
  return (r.image_count ?? 0) === 0 && (r.bullet_count ?? 0) === 0 && (r.word_count ?? 0) <= 4
}

// Exact per-talk section identity — used by the index rail, the Section filter set and
// the grid's group keys. `\n` cannot appear in a slug or a section name.
export function sectionKey(talkSlug: string, section: string): string {
  return `${talkSlug}\n${section}`
}

export interface BrowserFilters {
  /** Substring on the talk's parent folder (SearchPalette's Folder combobox semantics). */
  folderQ: string
  /** Selected talkSlugs (multi); empty = all talks. */
  talkSet: Set<string>
  /** Substring on `section subsection` (SearchPalette's Section combobox semantics). */
  sectionQ: string
  /** Exact sectionKey()s toggled from the index rail; empty = all sections. */
  sectionSet: Set<string>
  /** Substring on the talk's metadata blob. */
  metaQ: string
  /** Selected layouts (multi, OR); empty = any layout. */
  layoutSet: Set<string>
  hasImage: boolean
  hasIcons: boolean
  /** Exclude section-title / subsection-title divider slides. */
  excludeSections: boolean
  /** Exclude title-only slides (content only). */
  excludeTitleOnly: boolean
  /** Talk modified within the last N days; 0 = any time. */
  modifiedDays: number
}

export function emptyFilters(): BrowserFilters {
  return {
    folderQ: '', talkSet: new Set(), sectionQ: '', sectionSet: new Set(), metaQ: '',
    layoutSet: new Set(), hasImage: false, hasIcons: false,
    excludeSections: false, excludeTitleOnly: false, modifiedDays: 0
  }
}

export function anyFilterActive(f: BrowserFilters): boolean {
  return Boolean(
    f.folderQ.trim() || f.talkSet.size || f.sectionQ.trim() || f.sectionSet.size || f.metaQ.trim() ||
    f.layoutSet.size || f.hasImage || f.hasIcons || f.excludeSections || f.excludeTitleOnly || f.modifiedDays > 0
  )
}

// Ports SearchPalette.tsx's `shown` memo predicate-for-predicate. `folderBySlug` maps
// talkSlug → parent folder name; `now` is injectable for the date-window tests.
export function filterRows(
  rows: BrowserRow[],
  f: BrowserFilters,
  folderBySlug: Map<string, string>,
  now: number = Date.now()
): BrowserRow[] {
  const fq = f.folderQ.toLowerCase().trim()
  const sq = f.sectionQ.toLowerCase().trim()
  const mq = f.metaQ.toLowerCase().trim()
  const cutoff = f.modifiedDays > 0 ? now - f.modifiedDays * DAY_MS : 0
  return rows.filter((r) => {
    if (fq && !((folderBySlug.get(r.talkSlug) || '').toLowerCase().includes(fq))) return false
    if (f.talkSet.size > 0 && !f.talkSet.has(r.talkSlug)) return false
    if (sq && !(`${r.section || ''} ${r.subsection || ''}`.toLowerCase().includes(sq))) return false
    if (f.sectionSet.size > 0 && !f.sectionSet.has(sectionKey(r.talkSlug, r.section ?? ''))) return false
    if (mq && !((r.talkMeta || '').toLowerCase().includes(mq))) return false
    if (f.layoutSet.size > 0 && !f.layoutSet.has(layoutOf(r))) return false
    if (f.hasImage && !((r.image_count ?? 0) > 0)) return false
    if (f.hasIcons && !isIconSlide(r)) return false
    if (f.excludeSections && isSectionRow(r)) return false
    if (f.excludeTitleOnly && isTitleOnly(r)) return false
    if (cutoff && !((r.talkMtimeMs ?? 0) >= cutoff)) return false
    return true
  })
}

/* ============================================================
   Grouping — `talk · section` heads in first-appearance order
   ============================================================ */

export interface TalkSectionGroup {
  talkSlug: string
  talkTitle: string
  section: string
  /** Indices back into the filtered rows array, in row order. */
  indices: number[]
}

export function groupByTalkSection(rows: BrowserRow[]): TalkSectionGroup[] {
  const order: string[] = []
  const map = new Map<string, TalkSectionGroup>()
  rows.forEach((r, i) => {
    const key = sectionKey(r.talkSlug, r.section ?? '')
    let g = map.get(key)
    if (!g) {
      g = { talkSlug: r.talkSlug, talkTitle: r.talkTitle || r.talkSlug, section: r.section ?? '', indices: [] }
      map.set(key, g)
      order.push(key)
    }
    g.indices.push(i)
  })
  return order.map((k) => map.get(k)!)
}

// The projection stores `section` as a SLUG (e.g. `deep-dive`); the authored display name
// lives on the section-title row itself. Map sectionKey → authored name so the rail, group
// heads and chips show names exactly as written in the files (never the slug, never re-cased).
export function sectionNamesByKey(rows: BrowserRow[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const r of rows) {
    if (r.role !== 'section-title') continue
    const name = r.nav_title || r.title
    if (name) m.set(sectionKey(r.talkSlug, r.section ?? ''), name)
  }
  return m
}

/* ============================================================
   Version filmstrip (Task 6) — anchor caret, canonical pick,
   badge labels, stamped-id extraction
   ============================================================ */

// The strip-row's ::before caret points at the horizontal CENTRE of the expanded card:
// column i of n columns → ((i + 0.5) / n) * 100 percent of the full grid width.
// Clamped so a stale index can never push the caret off the strip.
export function stripAnchorPercent(cardIndexInRow: number, columns: number): number {
  if (columns <= 0) return 50
  const i = Math.max(0, Math.min(cardIndexInRow, columns - 1))
  return ((i + 0.5) / columns) * 100
}

// Canonical = the newest SEALED version, else the head (versions arrive newest-first from
// tw.ledger.versions). This is ADR-0032's "lightweight star" — a PROPER per-id star store
// (user-pinned canonical) is Wave B; until then the seal record decides.
export function canonicalVersion<T extends { sealed: boolean }>(versions: T[]): T | null {
  if (versions.length === 0) return null
  return versions.find((v) => v.sealed) ?? versions[0]
}

// Badge copy split into base + the ` · M talks` span (the span carries class="long" so g6
// density can hide it). null when the id has no versions — the card shows the dashed
// 'no versions yet' badge instead.
export function versionBadgeParts(nVersions: number, nTalks: number): { base: string; long: string } | null {
  if (nVersions <= 0) return null
  return {
    base: `${nVersions} version${nVersions === 1 ? '' : 's'}`,
    long: nTalks > 1 ? ` · ${nTalks} talks` : ''
  }
}

export function versionBadgeLabel(nVersions: number, nTalks: number): string | null {
  const p = versionBadgeParts(nVersions, nTalks)
  return p ? p.base + p.long : null
}

// The LEDGER id of a slide block: the `{id=…}` token on the heading or the Trigger line
// (the line immediately below — ADR-0015), mirroring 13-slide-ledger's extractIdSlides.
// The projection's slide_id is auto-derived for UNstamped slides too, so it cannot tell
// stamped from unstamped — only the source token can. Deeper `{id=…}` mentions are body
// content, never an id.
const STAMPED_ID_RE = /\{id=([A-Za-z0-9_-]+)\}/
export function stampedIdOf(sourceMarkdown?: string): string | null {
  if (!sourceMarkdown) return null
  const lines = sourceMarkdown.split('\n', 2)
  for (const line of lines) {
    const m = line.match(STAMPED_ID_RE)
    if (m) return m[1]
  }
  return null
}

/* ============================================================
   Propagation checklist (Task 7, PRD A5) — pure label/diff helpers
   ============================================================ */

// The confirm button's live recount (mockup 2293-2305): 'Replace in N presentation(s)'
// (singular/plural), 'Nothing to replace' when N=0, '· skip M' suffix only when M>0.
// The ⌘↵ kbd is rendered separately by the component.
export function propagationSummaryLabel(nReplace: number, nSkip: number): string {
  const head = nReplace > 0
    ? `Replace in ${nReplace} presentation${nReplace === 1 ? '' : 's'}`
    : 'Nothing to replace'
  return head + (nSkip > 0 ? ` · skip ${nSkip}` : '')
}

// Feed for the drawer's two columns (mockup 1846-1876): the LEFT column is the target's
// copy (same + del lines), the RIGHT is the version to adopt (same + add lines). Order
// preserved so shared lines stay aligned as far as the line counts allow.
export type DiffLine = { kind: 'same' | 'del' | 'add'; text: string }
export function splitDiffColumns(diffLines: DiffLine[]): { left: DiffLine[]; right: DiffLine[] } {
  return {
    left: diffLines.filter((l) => l.kind !== 'add'),
    right: diffLines.filter((l) => l.kind !== 'del')
  }
}

/* ============================================================
   Grid keyboard navigation — flat visual index over the grid
   ============================================================ */

// ←/→ step ±1 (flowing across row/group edges, clamped at the ends); ↑ steps −columns but
// STAYS PUT on the top row; ↓ steps +columns, clamping onto the last card when the step
// would fall off the bottom edge.
export function gridNavigate(index: number, key: string, columns: number, total: number): number {
  if (total <= 0) return 0
  const clamp = (i: number): number => Math.max(0, Math.min(i, total - 1))
  switch (key) {
    case 'ArrowLeft': return clamp(index - 1)
    case 'ArrowRight': return clamp(index + 1)
    case 'ArrowUp': return index - columns >= 0 ? index - columns : index
    case 'ArrowDown': return Math.min(index + columns, total - 1)
    default: return clamp(index)
  }
}

/* ============================================================
   Duplicate detection (Task 8, ADR-0032) — cluster a result set
   ============================================================ */

// A result row as the duplicate clusterer reads it — the browser passes its projection+meta rows
// straight in. content_hash is id-independent slide identity (the byte-identical key); source_markdown
// drives the cheap near-identical key; outlinePath addresses the copy for a merge.
export interface ClusterRow extends BrowserRow {
  content_hash?: string
  render_hash?: string
  outlinePath?: string
}

// A cluster of result rows.
//   'identical' = ≥2 rows sharing the ENGINE identity key (identityCanon — byte-identical modulo any
//                 {id=…}); this is EXACTLY what mergeDuplicates unifies, so the merge is offered and
//                 its Phase-2 guard never refuses in normal use. `key` is that shared identity canon.
//   'near'      = ≥2 rows sharing content_hash (they look identical to the projection — same
//                 lowercased/whitespace-collapsed/markdown-stripped text) but spanning ≥2 distinct
//                 identity keys (they differ in case / whitespace / inline markdown / a non-id
//                 trigger), so they are NOT engine-identical: NO merge, uncollapsible. `key` is the
//                 shared content_hash.
//   'single'    = a row in neither.
export type SlideCluster =
  | { kind: 'identical'; rows: ClusterRow[]; key: string; count: number; talks: string[] }
  | { kind: 'near'; rows: ClusterRow[]; key: string; count: number }
  | { kind: 'single'; rows: ClusterRow[] }

/* ---- engine identity mirror (drift risk — keep in lockstep with the compiler) ----
   identityCanon mirrors compiler/scripts/lib/15-slide-merge.mjs `identityKey` + `canon`, which run
   over 13-slide-ledger.mjs `normalizeDepth` / `ID_TOKEN_RE`. It is the key the merge engine compares
   copies on, so the Browser MUST cluster "identical" on the SAME thing (otherwise it would label
   slides identical that the engine then refuses to merge, and its near bucket — same content_hash,
   different identity — would be unreachable). It is TIGHTER than the projection's content_hash
   (10-projections.mjs: lowercased + whitespace-collapsed + markdown-stripped): identityCanon
   PRESERVES case, inline markdown, non-id triggers and line structure, dropping only {id=…} tokens. */
const HEADING_RE = /^(#{1,6})\s/
const ID_TOKEN_RE = /\{id=[A-Za-z0-9_-]+\}/

// Per-line fence + HTML-comment flags — mirrors 13-slide-ledger.mjs fencedLineFlags (length-aware
// fences; a comment state machine) so a `#` inside a code fence or HTML comment is never re-levelled
// as a heading.
function fencedLineFlags(lines: string[]): boolean[] {
  const flags = new Array<boolean>(lines.length).fill(false)
  let inFence = false
  let fenceMark = ''
  let inComment = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const t = line.trim()
    const visibleAtStart = !inComment
    if (!inFence) {
      let pos = 0
      for (;;) {
        if (inComment) {
          const close = line.indexOf('-->', pos)
          if (close === -1) break
          inComment = false
          pos = close + 3
        } else {
          const open = line.indexOf('<!--', pos)
          if (open === -1) break
          inComment = true
          pos = open + 4
        }
      }
    }
    if (!visibleAtStart) { flags[i] = true; continue }
    if (inFence) {
      flags[i] = true
      const close = t.match(/^(`{3,})\s*$/)
      if (close && close[1].length >= fenceMark.length) { inFence = false; fenceMark = '' }
      continue
    }
    const open = t.match(/^(`{3,})/)
    if (open) { inFence = true; fenceMark = open[1]; flags[i] = true }
  }
  return flags
}

// normalizeDepth mirror (13-slide-ledger.mjs): re-level every heading so the root heading sits at ###.
function normalizeDepth(markdown: string): string {
  const lines = String(markdown).split('\n')
  const fenced = fencedLineFlags(lines)
  const root = fenced[0] ? null : lines[0]?.match(HEADING_RE)
  if (!root) return markdown
  const delta = 3 - root[1].length
  if (delta === 0) return markdown
  return lines
    .map((l, i) => {
      const h = fenced[i] ? null : l.match(HEADING_RE)
      if (!h) return l
      const depth = Math.min(6, Math.max(1, h[1].length + delta))
      return '#'.repeat(depth) + l.slice(h[1].length)
    })
    .join('\n')
}

// identityKey mirror (15-slide-merge.mjs): canon (normalizeDepth + strip trailing newlines), then
// drop every {id=…} token — a line that held only an id disappears; an id trailing a shared trigger
// group leaves the rest with whitespace collapsed; prose lines compare verbatim. '' for empty source.
export function identityCanon(sourceMarkdown?: string): string {
  const canon = normalizeDepth(String(sourceMarkdown ?? '')).replace(/\n+$/, '')
  const out: string[] = []
  for (const raw of canon.split('\n')) {
    if (!ID_TOKEN_RE.test(raw)) { out.push(raw); continue }
    const stripped = raw.replace(new RegExp(ID_TOKEN_RE.source, 'g'), '').replace(/\s+/g, ' ').trim()
    if (stripped === '') continue // the line was only the id token (a lone-id Trigger line)
    out.push(stripped)
  }
  return out.join('\n')
}

// Group a result set into clusters in first-appearance order (each cluster ordered by its first row's
// position in `rows`). IDENTITY (identityCanon) wins over near: a row in an identical cluster is never
// also pulled into a near cluster. Rows with empty source never identity-cluster; rows with no
// content_hash never near-cluster.
export function clusterRows(rows: ClusterRow[]): SlideCluster[] {
  const n = rows.length
  // Empty identity/hash → a per-row unique key so such rows never collide with anything.
  const idKeyOf = (r: ClusterRow, i: number): string => {
    const k = identityCanon(r.source_markdown)
    return k === '' ? `u:${i}` : `id:${k}`
  }
  const hashKeyOf = (r: ClusterRow, i: number): string => (r.content_hash ? `h:${r.content_hash}` : `u:${i}`)

  const pushInto = (map: Map<string, number[]>, k: string, i: number): void => {
    const bucket = map.get(k)
    if (bucket) bucket.push(i)
    else map.set(k, [i])
  }

  // Identity groups by identityCanon → identical (mergeable) clusters (size ≥ 2); rows claimed.
  const idGroups = new Map<string, number[]>()
  rows.forEach((r, i) => pushInto(idGroups, idKeyOf(r, i), i))
  const claimed = new Array<boolean>(n).fill(false)
  const staged: Array<{ firstIdx: number; cluster: SlideCluster }> = []
  for (const idxs of idGroups.values()) {
    if (idxs.length < 2) continue
    idxs.forEach((i) => (claimed[i] = true))
    const crows = idxs.map((i) => rows[i])
    const talks: string[] = []
    for (const r of crows) if (r.talkSlug && !talks.includes(r.talkSlug)) talks.push(r.talkSlug)
    staged.push({
      firstIdx: idxs[0],
      cluster: { kind: 'identical', rows: crows, key: identityCanon(rows[idxs[0]].source_markdown), count: crows.length, talks }
    })
  }

  // Near groups by content_hash over UNCLAIMED rows. Every unclaimed row has a UNIQUE identity key
  // (its identity group had size 1), so any content_hash group of ≥2 unclaimed rows automatically
  // spans ≥2 distinct identity keys — the definition of near.
  const hashGroups = new Map<string, number[]>()
  rows.forEach((r, i) => {
    if (claimed[i]) return
    pushInto(hashGroups, hashKeyOf(r, i), i)
  })
  const nearClaimed = new Array<boolean>(n).fill(false)
  for (const [k, idxs] of hashGroups) {
    if (idxs.length < 2 || !k.startsWith('h:')) continue
    idxs.forEach((i) => (nearClaimed[i] = true))
    const crows = idxs.map((i) => rows[i])
    staged.push({ firstIdx: idxs[0], cluster: { kind: 'near', rows: crows, key: k.slice(2), count: crows.length } })
  }

  // Everything else is a single.
  rows.forEach((r, i) => {
    if (claimed[i] || nearClaimed[i]) return
    staged.push({ firstIdx: i, cluster: { kind: 'single', rows: [r] } })
  })

  staged.sort((a, b) => a.firstIdx - b.firstIdx)
  return staged.map((s) => s.cluster)
}

// One merge target per copy in an IDENTICAL cluster, for tw.ledger.mergeDuplicates. Each target is
// { outline, heading, occurrence }: `outline` is the row's outline path (passed through verbatim —
// the main-process handler resolves it against the vault and relativises before the engine sees it),
// `heading` is the first line of the copy's source_markdown (the verbatim ### line, which
// listSlideBlocks matches on), and `occurrence` is the 1-based position among copies sharing that
// (outline, heading) within THIS cluster. That last point is the one caveat: occurrence is derived
// from the cluster, so it equals the true in-outline occurrence only when the cluster contains every
// copy in that outline — which holds for the unfiltered duplicate view (content_hash groups every
// copy in the result set). The engine's identity guard is the backstop: a wrong occurrence either
// addresses an interchangeable identical block (harmless) or a different block (whole merge refused,
// never a silent mis-merge). Returns [] for non-identical clusters.
export function mergeTargetsFromCluster(
  cluster: SlideCluster
): Array<{ outline: string; heading: string; occurrence: number }> {
  if (cluster.kind !== 'identical') return []
  const seen = new Map<string, number>()
  const targets: Array<{ outline: string; heading: string; occurrence: number }> = []
  for (const r of cluster.rows) {
    const outline = r.outlinePath ?? ''
    const heading = String(r.source_markdown ?? '').split('\n')[0] ?? ''
    const key = `${outline}\n${heading}`
    const occurrence = (seen.get(key) ?? 0) + 1
    seen.set(key, occurrence)
    targets.push({ outline, heading, occurrence })
  }
  return targets
}

/* ============================================================
   Duplicate collapse (Task 9, ADR-0032) — merge-eligibility +
   the collapsed display model the Light Table grid renders
   ============================================================ */

// True when every copy in an IDENTICAL cluster ALREADY carries the same non-null stamped id —
// i.e. they are already a single ledger slide, so the merge action reads 'already one slide'
// rather than offering to merge. A cluster with any unstamped copy, or copies whose stamped ids
// differ, is NOT yet one slide. (Byte-identity is content-hash based and id-independent, so two
// copies can be byte-identical while carrying different — or no — ids.)
export function clusterAlreadyOneSlide(cluster: SlideCluster): boolean {
  if (cluster.kind !== 'identical') return false
  const ids = cluster.rows.map((r) => stampedIdOf(r.source_markdown))
  if (ids.some((id) => id == null)) return false
  return new Set(ids).size === 1
}

// The "Merge into one slide" action is offered only for an identical cluster of ≥2 copies that
// are NOT already one slide. Everything else (singles, near clusters, already-merged identicals)
// shows no merge action.
export function clusterMergeable(cluster: SlideCluster): boolean {
  return cluster.kind === 'identical' && cluster.rows.length >= 2 && !clusterAlreadyOneSlide(cluster)
}

// A single grid cell in the collapsed Light Table. 'single' = a normal standalone slide (today's
// card, unchanged); 'identical' = a collapsed STACK standing in for ≥2 byte-identical copies;
// 'near' = a collapsed fanned stack standing in for ≥2 near-identical variants; 'near-variant' =
// one variant of an UNCOLLAPSED near cluster, rendered as a normal card in place. `row` is the
// representative (for identical/near, the first copy that passes the active filters).
export interface DisplayCard {
  row: ClusterRow
  kind: 'single' | 'identical' | 'near' | 'near-variant'
  /** identical/near(+variants): the originating cluster (merge targets, locations, U toggle). */
  cluster?: SlideCluster
  /** identical/near: total copies across the FULL unfiltered result set. */
  count?: number
  /** identical: distinct talk slugs across all copies (the "in N talks" pill). */
  talks?: string[]
  /** near + near-variant: the cluster key, so U collapses/uncollapses the right cluster. */
  nearKey?: string
  /** near-variant: 1-based index among the cluster's rows. */
  variantIndex?: number
}

export interface DisplayGroup {
  talkSlug: string
  talkTitle: string
  section: string
  /** The actual cards rendered in this group (near variants expanded in place). */
  cards: DisplayCard[]
  /** Collapsed UNITS in this group under the current filter — a cluster counts as ONE unit
   *  whether or not it is uncollapsed, so the group head count is stable across expand/collapse. */
  units: number
}

export interface DisplayModel {
  groups: DisplayGroup[]
  /** The flat visual order of cards (groups flattened) — the source of vRows/selection/nav. */
  cards: DisplayCard[]
  /** Total collapsed units — the "N slides" the top count reports. */
  slideCount: number
  /** Number of talk·section groups — the "M sections" the top count reports. */
  sectionCount: number
}

// Cluster the FULL unfiltered result set (engine caveat F3: cluster-derived `occurrence` is only
// exact when the cluster holds every copy of a content, so we ALWAYS cluster over all rows), then
// build the collapsed grid. A cluster is SHOWN when any of its rows passes `passes`; its
// representative (title/thumbnail/placement) is the first PASSING row, but its count / distinct
// talks / merge targets still come from ALL its rows so the occurrence stays exact. Byte-identical
// copies collapse to one stack placed at the representative's talk·section; the other copies never
// emit a card, so any talk·section whose rows were all absorbed elsewhere simply produces no group
// (empty groups vanish). Near clusters collapse to one card unless their key is in `nearExpanded`,
// in which case every variant that PASSES the filter renders as a card in the representative's group,
// contiguously.
export function buildDisplayModel(
  results: ClusterRow[],
  passes: (row: ClusterRow) => boolean,
  nearExpanded: Set<string>
): DisplayModel {
  const clusters = clusterRows(results)
  const order: string[] = []
  const map = new Map<string, DisplayGroup>()
  const groupFor = (row: ClusterRow): DisplayGroup => {
    const key = sectionKey(row.talkSlug, row.section ?? '')
    let g = map.get(key)
    if (!g) {
      g = { talkSlug: row.talkSlug, talkTitle: row.talkTitle || row.talkSlug, section: row.section ?? '', cards: [], units: 0 }
      map.set(key, g)
      order.push(key)
    }
    return g
  }
  for (const cluster of clusters) {
    if (cluster.kind === 'single') {
      const row = cluster.rows[0]
      if (!passes(row)) continue
      const g = groupFor(row)
      g.cards.push({ row, kind: 'single' })
      g.units += 1
      continue
    }
    const passing = cluster.rows.filter(passes)
    if (passing.length === 0) continue
    const rep = passing[0]
    const g = groupFor(rep)
    if (cluster.kind === 'identical') {
      g.cards.push({ row: rep, kind: 'identical', cluster, count: cluster.count, talks: cluster.talks })
    } else if (nearExpanded.has(cluster.key)) {
      // Reveal only the variants that PASS the active filter, so a filtered-out variant is never
      // surfaced or selectable by uncollapsing.
      passing.forEach((r, i) =>
        g.cards.push({ row: r, kind: 'near-variant', cluster, nearKey: cluster.key, variantIndex: i + 1 })
      )
    } else {
      g.cards.push({ row: rep, kind: 'near', cluster, count: cluster.count, nearKey: cluster.key })
    }
    g.units += 1
  }
  const groups = order.map((k) => map.get(k)!)
  const cards = groups.flatMap((g) => g.cards)
  const slideCount = groups.reduce((n, g) => n + g.units, 0)
  return { groups, cards, slideCount, sectionCount: groups.length }
}

/* ---- merge / nudge copy (node-tested for plurals & the natural talk-name join) ---- */

// 'in 1 talk' / 'in N talks' — the identical stack's distinct-talks pill.
export function inTalksLabel(nTalks: number): string {
  return `in ${nTalks} talk${nTalks === 1 ? '' : 's'}`
}

// 'N near-identical' — the near stack's marker (count of variants).
export function nearCountLabel(count: number): string {
  return `${count} near-identical`
}

// Confirm-dialog title: 'Merge N identical copies into one slide?'
export function mergeConfirmTitle(count: number): string {
  return `Merge ${count} identical ${count === 1 ? 'copy' : 'copies'} into one slide?`
}

// Insert-time nudge: `nOthers` is the count of OTHER copies (cluster count − 1; ≥1 by construction).
export function mergeNudgeLabel(nOthers: number): string {
  return `This slide is identical to ${nOthers} other${nOthers === 1 ? '' : 's'} across your talks — merge into one?`
}

// Success toast after a clean merge.
export function mergeSuccessLabel(count: number): string {
  return `Merged ${count} ${count === 1 ? 'copy' : 'copies'} into one slide`
}

// Natural British join of talk names for the confirm body: 'A', 'A and B', 'A, B and C' (no
// Oxford comma). Empty → ''.
export function joinTalkNames(names: string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

// The full merge request handed from the Browser to the host-mounted MergeConfirm (and captured by
// the insert-time nudge so it survives the Browser closing on insert). Targets are occurrence-exact
// (from mergeTargetsFromCluster over the full cluster); talkTitles are the distinct talks' display
// names; count is the number of copies; title is the representative slide's title for the copy.
export interface MergeRequest {
  targets: Array<{ outline: string; heading: string; occurrence: number }>
  talkTitles: string[]
  count: number
  title: string
}

/* ============================================================
   Slide tags (ADR-0037) — target derivation for tags:apply
   ============================================================ */

// One tags:apply target per SELECTED row (per-occurrence storage: the write goes to the
// selected occurrence's outline; identity-wide aggregation is a READ concern). A stamped row
// is addressed by its {id=…} (robust across reorders); an unstamped row falls back to its
// verbatim heading line + a batch-derived occurrence — exact under the same caveat as
// mergeTargetsFromCluster (occurrences count within the batch, and the engine addresses the
// first occurrence when only one copy of a heading is selected).
export interface TagApplyTarget {
  outline: string
  id?: string | null
  heading?: string
  occurrence?: number
}

export function tagTargetsFromRows(
  rows: Array<{ outlinePath?: string; source_markdown?: string }>
): TagApplyTarget[] {
  const seen = new Map<string, number>()
  const targets: TagApplyTarget[] = []
  for (const r of rows) {
    const outline = r.outlinePath ?? ''
    if (!outline) continue
    const id = stampedIdOf(r.source_markdown)
    if (id) {
      targets.push({ outline, id })
      continue
    }
    const heading = String(r.source_markdown ?? '').split('\n')[0] ?? ''
    const key = `${outline}\n${heading}`
    const occurrence = (seen.get(key) ?? 0) + 1
    seen.set(key, occurrence)
    targets.push({ outline, heading, occurrence })
  }
  return targets
}
