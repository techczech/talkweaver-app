// The Slide Browser's windowing, as pure functions (no React, no DOM): the results become a flat
// list of LINES — a group or talk heading, a section heading, one grid row of cards, the open
// expansion under its row — each with a height (measured once mounted, estimated until then) and
// an offset. Only the lines in or near the viewport are mounted (VirtualGrid.tsx).
// Spacing constants mirror lighttable.css (.lt-grid gaps, .lt-group / .lt-outline-sec margins).
import type { DisplayCard } from '../slideBrowserModel'
import type { OutlineTalkPlan } from './types'

export type GridLine = { key: string; after: number } & (
  | { kind: 'group-head'; talkTitle: string; section: string; sectionLabel: string; countLabel: string }
  | { kind: 'talk-head'; slug: string; title: string; total: number }
  | { kind: 'sec-head'; slug: string; section: string; label: string; count: number }
  | { kind: 'beside-head' }
  | { kind: 'row'; base: number; cards: DisplayCard[]; cols: number; ordinals: boolean }
  | { kind: 'expansion'; pos: number; anchorIndex: number; cols: number }
  | { kind: 'zero'; title: string }
)

/** Row gap (.lt-grid gap, first value) and column gap by cards across. */
export const ROW_GAP: Record<number, number> = { 2: 26, 3: 26, 4: 22, 5: 18, 6: 16 }
export const COL_GAP: Record<number, number> = { 2: 22, 3: 22, 4: 18, 5: 15, 6: 13 }
export const GROUP_GAP = 34 // .lt-group margin-bottom
export const SECTION_GAP = 14 // .lt-outline-sec margin-bottom
const gapOf = (table: Record<number, number>, cols: number): number => table[cols] ?? table[3]

export interface GroupInput {
  talkSlug: string
  talkTitle: string
  section: string
  units: number
  cards: DisplayCard[]
}

export type LinesInput = { cols: number; expandedPos: number } & (
  | { mode: 'grouped'; groups: GroupInput[]; groupTotals: Map<string, number>; groupKey: (g: GroupInput) => string; secName: (key: string, fallback: string) => string }
  | { mode: 'outline'; plan: OutlineTalkPlan[] }
  | { mode: 'beside'; cards: DisplayCard[] }
)

/** Cards into row lines (+ the expansion line after the row holding `expandedPos`). The last line's
 *  `after` is `endGap`. */
function pushRows(lines: GridLine[], cards: DisplayCard[], base: number, cols: number, ordinals: boolean, expandedPos: number, endGap: number): void {
  const rowGap = gapOf(ROW_GAP, cols)
  for (let j = 0; j < cards.length; j += cols) {
    const rowBase = base + j
    const rowCards = cards.slice(j, j + cols)
    const last = j + cols >= cards.length
    const hasExp = expandedPos >= rowBase && expandedPos < rowBase + rowCards.length
    lines.push({ kind: 'row', key: `r${cols}:${rowBase}`, base: rowBase, cards: rowCards, cols, ordinals, after: last && !hasExp ? endGap : rowGap })
    if (hasExp) {
      lines.push({ kind: 'expansion', key: `x:${expandedPos}`, pos: expandedPos, anchorIndex: expandedPos - rowBase, cols, after: last ? endGap : rowGap })
    }
  }
}

/** The results as lines, in visual order; card positions run from 0 like the grid's `vRows`. */
export function buildGridLines(input: LinesInput): GridLine[] {
  const lines: GridLine[] = []
  const { cols, expandedPos } = input
  if (input.mode === 'grouped') {
    let base = 0
    for (const g of input.groups) {
      const gKey = input.groupKey(g)
      const total = input.groupTotals.get(gKey) ?? g.units
      lines.push({
        kind: 'group-head', key: `g:${gKey}`, after: 0, talkTitle: g.talkTitle, section: g.section,
        sectionLabel: g.section ? input.secName(gKey, g.section) : '',
        countLabel: g.units === total ? `${total} shown` : `${g.units} of ${total} shown`
      })
      if (g.cards.length === 0) lines[lines.length - 1].after = GROUP_GAP
      pushRows(lines, g.cards, base, cols, false, expandedPos, GROUP_GAP)
      base += g.cards.length
    }
    return lines
  }
  if (input.mode === 'beside') {
    lines.push({ kind: 'beside-head', key: 'beside-head', after: 0 })
    if (input.cards.length === 0) lines[0].after = GROUP_GAP
    pushRows(lines, input.cards, 0, cols, false, expandedPos, GROUP_GAP)
    return lines
  }
  let base = 0
  for (const t of input.plan) {
    lines.push({ kind: 'talk-head', key: `t:${t.slug}`, after: 0, slug: t.slug, title: t.title, total: t.total })
    t.chunks.forEach((c, ci) => {
      if (c.section !== '') {
        lines.push({ kind: 'sec-head', key: `s:${t.slug}\n${ci}\n${c.section}`, after: c.cards.length === 0 ? SECTION_GAP : 0, slug: t.slug, section: c.section, label: c.label, count: c.cards.length })
      }
      pushRows(lines, c.cards, base, cols, true, expandedPos, SECTION_GAP)
      base += c.cards.length
    })
    if (t.total === 0) lines.push({ kind: 'zero', key: `z:${t.slug}`, after: 0, title: t.title })
    // The last section's margin collapses into the talk group's (CSS margin collapsing).
    lines[lines.length - 1].after = Math.max(lines[lines.length - 1].after, GROUP_GAP)
  }
  return lines
}

/* ---------- heights ---------- */

/** Measured heights. Bodies (height without the line's `after` spacing) by line key, and the last
 *  measured body per kind, so one mounted row calibrates every row not yet drawn. Valid for one
 *  content width: a new width starts afresh. */
export interface MeasureCache {
  width: number
  byKey: Map<string, number>
  byKind: Map<string, number>
}

export function createMeasureCache(width = 0): MeasureCache {
  return { width, byKey: new Map(), byKind: new Map() }
}

function kindKey(line: GridLine): string {
  return line.kind === 'row' ? `row:${line.cols}:${line.ordinals ? 1 : 0}` : line.kind
}

/** The CSS-derived estimate of a line's body at a content width (before anything is measured). */
export function estimateBody(line: GridLine, width: number): number {
  switch (line.kind) {
    case 'row': {
      const w = Math.max(80, width > 0 ? width : 1200)
      const card = (w - gapOf(COL_GAP, line.cols) * (line.cols - 1)) / line.cols
      const print = 10 + Math.max(0, card - 10) * 9 / 16
      return Math.round(print + 48) // + the label: title, meta row, padding
    }
    case 'group-head': case 'talk-head': return 46
    case 'sec-head': return 44
    case 'beside-head': return 31
    case 'expansion': return 300
    case 'zero': return 40
  }
}

export function lineHeight(line: GridLine, cache: MeasureCache, width: number): number {
  const same = cache.width === width
  const body = (same ? cache.byKey.get(line.key) ?? cache.byKind.get(kindKey(line)) : undefined) ?? estimateBody(line, width)
  return body + line.after
}

/** Record a mounted line's measured height (its `after` spacing included). True when it changed. */
export function recordMeasure(cache: MeasureCache, line: GridLine, width: number, measured: number): boolean {
  if (cache.width !== width) { cache.width = width; cache.byKey.clear(); cache.byKind.clear() }
  const body = Math.max(0, measured - line.after)
  const k = kindKey(line)
  const prev = cache.byKey.get(line.key)
  cache.byKind.set(k, body)
  if (prev !== undefined && Math.abs(prev - body) < 0.5) return false
  cache.byKey.set(line.key, body)
  return true
}

/* ---------- layout ---------- */

export interface GridLayout {
  offsets: number[]
  heights: number[]
  total: number
}

export function layoutLines(lines: readonly GridLine[], heightOf: (line: GridLine) => number): GridLayout {
  const offsets = new Array<number>(lines.length)
  const heights = new Array<number>(lines.length)
  let y = 0
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = y
    heights[i] = heightOf(lines[i])
    y += heights[i]
  }
  return { offsets, heights, total: y }
}

/** The lines overlapping [top, bottom): `start` inclusive, `end` exclusive. */
export function visibleRange(layout: GridLayout, top: number, bottom: number): { start: number; end: number } {
  const { offsets, heights } = layout
  const n = offsets.length
  if (n === 0) return { start: 0, end: 0 }
  // First line whose bottom edge is below `top`.
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] + heights[mid] <= top) lo = mid + 1
    else hi = mid
  }
  const start = Math.min(lo, n - 1)
  // First line starting at or after `bottom`.
  lo = start
  hi = n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] < bottom) lo = mid + 1
    else hi = mid
  }
  return { start, end: Math.max(lo, start + 1) }
}

/** Which line holds each card position (-1 = none). */
export function lineOfPositions(lines: readonly GridLine[]): Map<number, number> {
  const m = new Map<number, number>()
  lines.forEach((line, i) => {
    if (line.kind !== 'row') return
    for (let j = 0; j < line.cards.length; j++) m.set(line.base + j, i)
  })
  return m
}

/**
 * The scroll position that brings line `i` into view the way `scrollIntoView({ block: 'nearest' })`
 * would, or null when it already is. Scrolling up to a group's first row shows its heading too.
 * `listTop` is where the lines start inside the scroll box; `viewport` is the box's height.
 */
export function scrollTargetFor(lines: readonly GridLine[], layout: GridLayout, i: number, scrollTop: number, viewport: number, listTop: number): number | null {
  if (i < 0 || i >= lines.length) return null
  let top = listTop + layout.offsets[i]
  const line = lines[i]
  const bottom = top + layout.heights[i] - line.after
  if (top < scrollTop) {
    // Walk back over the headings directly above, so the row is read with its heading.
    let k = i - 1
    while (k >= 0 && lines[k].kind !== 'row' && lines[k].kind !== 'expansion') k -= 1
    if (k < i - 1) top = listTop + layout.offsets[k + 1]
    if (k < 0) top = 0 // the first row: back to the very top
    return Math.max(0, top)
  }
  if (bottom > scrollTop + viewport) return Math.max(0, bottom - viewport)
  return null
}

/* ---------- scroll anchor ---------- */

/** A line held still on screen while heights change: its key and its offset when it was taken. */
export interface ScrollAnchor { key: string; lineTop: number }

/**
 * The line to hold still while measurements arrive: the preferred line (the focused card's) when any
 * of it is in the viewport, else the first line in view. `top` is the scroll position inside the
 * list (scrollTop minus where the list starts). null when there are no lines.
 */
export function anchorFor(lines: readonly GridLine[], layout: GridLayout, top: number, viewport: number, preferIndex?: number): ScrollAnchor | null {
  const n = lines.length
  if (n === 0) return null
  const { offsets, heights } = layout
  let i = visibleRange(layout, top, top + 1).start
  if (preferIndex !== undefined && preferIndex >= 0 && preferIndex < n) {
    const a = offsets[preferIndex]
    if (a < top + viewport && a + heights[preferIndex] > top) i = preferIndex
  }
  return { key: lines[i].key, lineTop: offsets[i] }
}

/**
 * How far the anchor line moved in a new layout of the same lines (px; positive = down): scrolling by
 * this much keeps it where it was on screen. 0 when the line is gone.
 */
export function anchorShift(lines: readonly GridLine[], layout: GridLayout, anchor: ScrollAnchor | null): number {
  if (!anchor) return 0
  const i = lines.findIndex((l) => l.key === anchor.key)
  return i === -1 ? 0 : layout.offsets[i] - anchor.lineTop
}
