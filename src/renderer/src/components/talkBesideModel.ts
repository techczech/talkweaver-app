// A slide-search result's talk beside the results (talk search 06; ADR-0029 §4; frame K5) — the
// picker main area's pure view model. Results-only or results-plus-talk; which talk and slide the
// right side shows; what Esc restores; the talk's outline plan and header; keyboard movement across
// the split; and which rows an insert takes when the same slide shows on both sides.
// No React/DOM imports; erasable TypeScript only, node-tested by scripts/test-result-beside.mjs.

/** The fields of a result row this model reads. */
export interface BesideRow {
  talkSlug: string
  slide_id?: string
  section?: string
  order?: number
  talkTitle?: string
}

/** What the results looked like when a talk first opened beside them — Esc puts it back. */
export interface ResultsSnapshot {
  /** The results pane's scrollTop. */
  scrollTop: number
  /** The focused result's selection key, or null when nothing was focused. */
  activeKey: string | null
}

/** The picker main area: results only, or results plus one talk on the right. */
export interface PickerMain {
  /** The talk on the right (slug) and the slide in it (outline order), or null: results only. */
  beside: { slug: string; order: number } | null
  /** The results as they were before the first open; kept across replacements, null when closed. */
  saved: ResultsSnapshot | null
}

export const RESULTS_ONLY: PickerMain = { beside: null, saved: null }

export function mainView(main: PickerMain): 'results' | 'results+talk' {
  return main.beside ? 'results+talk' : 'results'
}

/** Open a result's talk beside the results. Opening another result's talk replaces the right side
 *  and keeps the snapshot taken at the first open, so Esc returns to the results as they were. */
export function openBeside(main: PickerMain, row: BesideRow, results: ResultsSnapshot): PickerMain {
  return {
    beside: { slug: row.talkSlug, order: row.order ?? 0 },
    saved: main.saved ?? { scrollTop: results.scrollTop, activeKey: results.activeKey }
  }
}

/** Esc: close the right side. Returns the results snapshot to restore (null if nothing was open).
 *  The selection is not part of this state, so closing never touches it. */
export function closeBeside(main: PickerMain): { main: PickerMain; restore: ResultsSnapshot | null } {
  return { main: RESULTS_ONLY, restore: main.beside ? main.saved : null }
}

/** A talk can open beside the results in the grouped and outline views. With 2–3 talks side by
 *  side, the main area is already columns. */
export function besideAvailable(gridMode: 'grouped' | 'outline' | 'side'): boolean {
  return gridMode !== 'side'
}

/** A talk's whole deck in outline order: from the unqueried index snapshot, the live results only
 *  when the snapshot has not caught the talk yet (as the insert-decision viewer does). */
export function talkDeck<T extends BesideRow>(slug: string, snapshot: T[], live: T[]): T[] {
  const src = snapshot.some((r) => r.talkSlug === slug) ? snapshot : live
  return src.filter((r) => r.talkSlug === slug).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

export interface BesideChunk<T> {
  section: string
  label: string
  rows: T[]
  /** Index of the chunk's first row in the deck. */
  start: number
}

export interface BesidePlan<T> {
  slug: string
  title: string
  deck: T[]
  chunks: BesideChunk<T>[]
  /** Deck index of the highlighted slide. */
  hl: number
  /** Chunk index holding the highlighted slide — the right side scrolls to it. */
  hlChunk: number
  /** The header: "‹talk title› · § ‹section› · slide N of M · Esc close". */
  header: BesideHeader
}

export interface BesideHeader {
  title: string
  /** "§ ‹section›", or '' for a slide before the first section. */
  section: string
  /** "slide N of M". */
  position: string
}

export function besideHeaderText(h: BesideHeader): string {
  return [h.title, h.section, h.position, 'Esc close'].filter(Boolean).join(' · ')
}

/** The right side: the whole talk in outline order, section by section, the slide highlighted. */
export function besidePlan<T extends BesideRow>(
  beside: { slug: string; order: number },
  snapshot: T[],
  live: T[],
  sectionLabel: (slug: string, section: string) => string,
  titleOf: (slug: string) => string
): BesidePlan<T> | null {
  const deck = talkDeck(beside.slug, snapshot, live)
  if (deck.length === 0) return null
  const found = deck.findIndex((r) => (r.order ?? 0) === beside.order)
  const hl = found >= 0 ? found : 0
  // Consecutive slides of one section form a chunk (as the outline view's chunks do); slides
  // before the first section form an unheaded chunk.
  const chunks: BesideChunk<T>[] = []
  deck.forEach((r, i) => {
    const sec = r.section ?? ''
    const last = chunks[chunks.length - 1]
    if (last && last.section === sec) last.rows.push(r)
    else chunks.push({ section: sec, label: sec ? sectionLabel(beside.slug, sec) : '', rows: [r], start: i })
  })
  const hlChunk = Math.max(0, chunks.findIndex((c) => hl >= c.start && hl < c.start + c.rows.length))
  const title = titleOf(beside.slug) || deck[0].talkTitle || beside.slug
  const secLabel = chunks[hlChunk]?.label ?? ''
  return {
    slug: beside.slug,
    title,
    deck,
    chunks,
    hl,
    hlChunk,
    header: { title, section: secLabel ? `§ ${secLabel}` : '', position: `slide ${hl + 1} of ${deck.length}` }
  }
}

/** The split's shape for keyboard movement: the results (flat, `leftCols` across) come first in the
 *  visual order, then the talk (its chunks each start a new row, `rightCols` across). */
export interface SplitLayout {
  left: number
  leftCols: number
  /** Chunk sizes of the talk, in order; they sum to the talk's card count. */
  rightChunks: number[]
  rightCols: number
  /** Where → from the results' right edge lands: the highlighted slide's position. */
  rightEntry: number
  /** Where ← from the talk's left edge lands: the result the talk was opened from. */
  leftEntry: number
}

/** Arrow keys across the split. ↑↓ stay on their side (section-aware on the right); ←→ move along a
 *  row and cross to the other side at its edge. Returns a visual position. */
export function splitNavigate(pos: number, key: string, L: SplitLayout): number {
  const right = L.rightChunks.reduce((n, c) => n + c, 0)
  const total = L.left + right
  if (total <= 0) return 0
  const clamp = (i: number): number => Math.max(0, Math.min(i, total - 1))
  if (pos < L.left) {
    const col = pos % L.leftCols
    switch (key) {
      case 'ArrowLeft': return col === 0 ? pos : pos - 1
      case 'ArrowRight':
        if ((col === L.leftCols - 1 || pos === L.left - 1) && right > 0) return clamp(L.rightEntry)
        return Math.min(pos + 1, L.left - 1)
      case 'ArrowUp': return pos - L.leftCols >= 0 ? pos - L.leftCols : pos
      case 'ArrowDown': return Math.min(pos + L.leftCols, L.left - 1)
      default: return clamp(pos)
    }
  }
  // On the right: find the chunk and the column within it.
  const rel = pos - L.left
  let ci = 0
  let cStart = 0
  while (ci < L.rightChunks.length - 1 && rel >= cStart + L.rightChunks[ci]) { cStart += L.rightChunks[ci]; ci++ }
  const inChunk = rel - cStart
  const col = inChunk % L.rightCols
  const row = Math.floor(inChunk / L.rightCols)
  const size = L.rightChunks[ci] ?? 0
  const at = (chunk: number, r: number, c: number): number => {
    let s = 0
    for (let k = 0; k < chunk; k++) s += L.rightChunks[k]
    return L.left + s + Math.min(r * L.rightCols + c, L.rightChunks[chunk] - 1)
  }
  switch (key) {
    case 'ArrowLeft':
      if (col === 0) return L.left > 0 ? clamp(L.leftEntry) : pos
      return pos - 1
    case 'ArrowRight': return inChunk + 1 < size && col < L.rightCols - 1 ? pos + 1 : pos
    case 'ArrowUp': {
      if (row > 0) return pos - L.rightCols
      if (ci === 0) return pos
      const prev = L.rightChunks[ci - 1]
      return at(ci - 1, Math.floor((prev - 1) / L.rightCols), col)
    }
    case 'ArrowDown': {
      if ((row + 1) * L.rightCols < size) return Math.min(pos + L.rightCols, L.left + cStart + size - 1)
      if (ci >= L.rightChunks.length - 1) return pos
      return at(ci + 1, 0, col)
    }
    default: return clamp(pos)
  }
}

/** The rows an insert (or a tag) takes: every selected slide once — a slide showing both as a
 *  result and in its talk beside is one slide, and a selected slide no longer on screen (the talk
 *  beside was closed, or a search hid it) is found in the index snapshot — in TALK ORDER, never in
 *  the order they happen to show (Dominik's Select whole section flow, 0.34.0-preview.8 check):
 *  talks in the order the user added them (the first selected slide of each, by the selection's
 *  insertion order), and within a talk each slide at its place in the talk (`order`). So the same
 *  selection gives the same rows, in the same order, whether or not a search is active. A slide
 *  showing on screen is taken as its on-screen row (the tag picker mutates those in place). */
export function selectedRowsFor<T extends BesideRow>(
  visible: T[],
  keyAt: (pos: number) => string,
  selected: Set<string>,
  snapshot: T[]
): T[] {
  const byKey = new Map<string, T>()
  visible.forEach((r, pos) => {
    const k = keyAt(pos)
    if (selected.has(k) && !byKey.has(k)) byKey.set(k, r)
  })
  if (byKey.size < selected.size) {
    for (const r of snapshot) {
      const k = `${r.talkSlug}:${r.slide_id}`
      if (r.slide_id != null && selected.has(k) && !byKey.has(k)) byKey.set(k, r)
    }
  }
  // Talks in the order their first slide joined the selection; the selection's own order breaks
  // a tie between two slides at the same place (never expected: `order` is unique within a talk).
  const talkRank = new Map<string, number>()
  const keyRank = new Map<string, number>()
  let n = 0
  for (const k of selected) {
    const r = byKey.get(k)
    if (!r) continue
    keyRank.set(k, n++)
    if (!talkRank.has(r.talkSlug)) talkRank.set(r.talkSlug, talkRank.size)
  }
  const place = (r: T): number => (typeof r.order === 'number' ? r.order : Number.MAX_SAFE_INTEGER)
  return [...byKey.entries()]
    .sort(([ka, a], [kb, b]) =>
      (talkRank.get(a.talkSlug) as number) - (talkRank.get(b.talkSlug) as number) ||
      place(a) - place(b) ||
      (keyRank.get(ka) as number) - (keyRank.get(kb) as number))
    .map(([, r]) => r)
}

/** Where the right side scrolls on open (all offsets within its scroll content): to the top of the
 *  result's section, unless that leaves the slide out of view — then the slide is centred. */
export function besideScrollTop(g: { sectionTop: number; cardTop: number; cardBottom: number; viewport: number }): number {
  const top = Math.max(0, g.sectionTop)
  if (g.cardBottom - top <= g.viewport) return top
  return Math.max(0, g.cardTop - Math.max(0, (g.viewport - (g.cardBottom - g.cardTop)) / 2))
}
