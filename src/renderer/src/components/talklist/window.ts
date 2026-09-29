import type { RowRef, ViewMode } from './model.ts'

// Pure grouped-window maths for the Talks browser. React and DOM measurement stay in the
// orchestrator so this model can be exercised with the same plain-node tests as model.ts.

// ledgerTwo / shelfTwo: two-line rows — talk-search results (what matched) and, in Ledger, every
// tree talk row at rest (its folder or event and last delivery).
export type RowHeights = { ledger: number; shelf: number; fhead: number; ledgerTwo?: number; shelfTwo?: number }
export const TWO_LINE_EXTRA_PX = 10
export type WindowGroup = { headerIndex: number | null; start: number; end: number }
export type WindowRange = { start: number; end: number }

export interface WindowLayout {
  offsets: number[]
  heights: number[]
  total: number
  groups: WindowGroup[]
  stickyHeaderHeight: number
}

export function heightOf(row: RowRef, viewMode: ViewMode, heights: RowHeights): number {
  if (row.kind === 'folder') return row.depth === 0 ? heights.fhead : heights.ledger
  // Ledger: search results and at-rest tree rows with a second line (ADR-0029 §3) are 36 px.
  // Shelf keeps its own rows at rest (they already show the event and recency); only search
  // results grow there.
  if (viewMode === 'ledger') {
    return row.hit || row.line != null ? heights.ledgerTwo ?? heights.ledger + TWO_LINE_EXTRA_PX : heights.ledger
  }
  return row.hit ? heights.shelfTwo ?? heights.shelf + TWO_LINE_EXTRA_PX + 4 : heights.shelf
}

// A group owns one sticky depth-0 header and its descendants. Root talks (and search rows)
// form a headerless group, keeping sticky containment correct without rebuilding tree order.
export function partitionGroups(rows: RowRef[]): WindowGroup[] {
  if (rows.length === 0) return []

  const groups: WindowGroup[] = []
  let start = 0
  let headerIndex: number | null = rows[0].kind === 'folder' && rows[0].depth === 0 ? 0 : null

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index]
    if (row.kind !== 'folder' || row.depth !== 0) continue
    groups.push({ headerIndex, start, end: index })
    start = index
    headerIndex = index
  }
  groups.push({ headerIndex, start, end: rows.length })
  return groups
}

export function buildLayout(rows: RowRef[], viewMode: ViewMode, rowHeights: RowHeights): WindowLayout {
  const offsets = new Array<number>(rows.length)
  const heights = new Array<number>(rows.length)
  let total = 0
  for (let index = 0; index < rows.length; index += 1) {
    offsets[index] = total
    const height = heightOf(rows[index], viewMode, rowHeights)
    heights[index] = height
    total += height
  }
  return {
    offsets,
    heights,
    total,
    groups: partitionGroups(rows),
    stickyHeaderHeight: rowHeights.fhead
  }
}

/** The contiguous row range intersecting the overscanned viewport; `end` is exclusive. */
export function windowRange(
  layout: WindowLayout,
  scrollTop: number,
  viewportH: number,
  overscanPx: number
): WindowRange {
  const count = layout.offsets.length
  if (count === 0) return { start: 0, end: 0 }

  const top = Math.max(0, scrollTop - overscanPx)
  const bottom = Math.min(layout.total, scrollTop + viewportH + overscanPx)

  let low = 0
  let high = count
  while (low < high) {
    const middle = (low + high) >>> 1
    if (layout.offsets[middle] + layout.heights[middle] <= top) low = middle + 1
    else high = middle
  }
  const start = low

  low = start
  high = count
  while (low < high) {
    const middle = (low + high) >>> 1
    if (layout.offsets[middle] < bottom) low = middle + 1
    else high = middle
  }
  return { start, end: low }
}

export function mountedIndices(
  layout: WindowLayout,
  range: WindowRange,
  pinned: Set<number>
): Set<number> {
  const mounted = new Set<number>()
  const count = layout.offsets.length
  for (let index = Math.max(0, range.start); index < Math.min(count, range.end); index += 1) {
    mounted.add(index)
  }
  for (const index of pinned) if (index >= 0 && index < count) mounted.add(index)
  for (const group of layout.groups) if (group.headerIndex != null) mounted.add(group.headerIndex)
  return mounted
}

export function scrollTargetFor(
  layout: WindowLayout,
  index: number,
  scrollTop: number,
  viewportH: number
): number | null {
  if (index < 0 || index >= layout.offsets.length || viewportH <= 0) return null

  const rowTop = layout.offsets[index]
  const rowBottom = rowTop + layout.heights[index]
  const group = layout.groups.find((candidate) => index >= candidate.start && index < candidate.end)
  const stickyInset = group?.headerIndex != null && group.headerIndex !== index
    ? layout.stickyHeaderHeight
    : 0
  const visibleTop = scrollTop + stickyInset
  const visibleBottom = scrollTop + viewportH
  if (rowTop >= visibleTop && rowBottom <= visibleBottom) return null

  const unclamped = rowTop < visibleTop ? rowTop - stickyInset : rowBottom - viewportH
  return Math.min(Math.max(0, unclamped), Math.max(0, layout.total - viewportH))
}

/** One sample's offsetHeight per row kind; undefined where no row of that kind is mounted. */
export type MeasuredRowHeights = {
  ledger: number | undefined
  shelf: number | undefined
  fhead: number | undefined
  ledgerTwo: number | undefined
  shelfTwo: number | undefined
}

/** Fold one DOM measurement pass into the current row heights. A kind with no mounted sample
 *  (undefined or 0) keeps its current height. Returns `current` itself when no height changed,
 *  so the caller writes state only for a real change: a no-op write still queues a React update,
 *  and a queued update re-applied on a later render must not mint a new heights object. */
export function mergeRowHeights(current: RowHeights, measured: MeasuredRowHeights): RowHeights {
  const next: RowHeights = {
    ledger: measured.ledger || current.ledger,
    shelf: measured.shelf || current.shelf,
    fhead: measured.fhead || current.fhead,
    ledgerTwo: measured.ledgerTwo || current.ledgerTwo,
    shelfTwo: measured.shelfTwo || current.shelfTwo
  }
  return next.ledger === current.ledger && next.shelf === current.shelf && next.fhead === current.fhead &&
    next.ledgerTwo === current.ledgerTwo && next.shelfTwo === current.shelfTwo
    ? current
    : next
}
