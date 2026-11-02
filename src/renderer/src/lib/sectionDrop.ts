// Slide handling (fix round 1, F2): where a SECTION card dropped on a SLIDE card lands, in the grid and the strip.
// A section placed between two slides would take in the slides after it (the shared move core refuses that), so
// the drop goes to the boundary of the slide's section instead, as the locked mockup draws it (H11: the bar between
// sections): dragging up lands before that section, dragging down after it. Pure; tests: scripts/test-slide-drag-dom.mjs.

/** A card as the surfaces list them, in display order. */
export interface DropRow { role?: string; section?: string; movable: boolean }

/**
 * For a drag from card `from` onto card `to`: null when the normal drop applies (the dragged card is not a section
 * card, the target is a section card, or the target is in the dragged card's own section). Otherwise the card to
 * show the drop bar on, the card whose heading names the place, and the place kind.
 */
export function sectionDropBoundary(
  rows: readonly DropRow[],
  from: number,
  to: number
): { cell: number; refIndex: number; kind: 'before' | 'after' } | null {
  const src = rows[from]
  const dst = rows[to]
  if (!src || !dst || from === to || src.role !== 'section-title' || dst.role === 'section-title') return null
  // The section run of `to`: consecutive cards with its section string (as the grid groups them).
  const sec = dst.section ?? ''
  let start = to
  while (start > 0 && (rows[start - 1].section ?? '') === sec) start -= 1
  let end = to
  while (end + 1 < rows.length && (rows[end + 1].section ?? '') === sec) end += 1
  if (from >= start && from <= end) return null
  let head = -1
  for (let i = start; i <= end; i += 1) if (rows[i].role === 'section-title' && rows[i].movable) { head = i; break }
  let first = -1
  let last = -1
  for (let i = start; i <= end; i += 1) if (rows[i].movable) { if (first < 0) first = i; last = i }
  if (last < 0) return null
  if (to < from) {
    const cell = head >= 0 ? head : first
    return { cell, refIndex: cell, kind: 'before' }
  }
  return { cell: last, refIndex: head >= 0 ? head : last, kind: 'after' }
}
