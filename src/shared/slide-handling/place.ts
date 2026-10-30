// Slide handling, the ONE placement rule (spec docs/design/2026-10-28-slide-handling/slide-handling-build-spec.md
// § Shared unit). A place in the talk is named by a heading line (1-based) and that heading's title, so a place
// chosen a while ago is found again after the text moved: the line first, then the nearest heading with the same
// title. Insert (Slide Scratchpad), paste, Move to… and drop all name places this way.
//
//   start                       — before the first slide of the talk
//   after { line, title }       — after that slide's block (its text, notes and every slide under it)
//   before { line, title }      — directly before that heading (a drop on the upper half of a card)
//   endOfSection { line, title } — the last thing inside that section's block
//
// Moved here from src/shared/scratchpad-insert.ts (Slide Scratchpad ticket 2), which re-exports these names; the
// Scratchpad still names only `start` and `after` places (ScratchPlace) and behaves as before.
// Pure: no I/O, no React, no CodeMirror. Tests: scripts/test-slide-handling-place.mjs, scripts/test-scratchpad-insert.mjs.

import { readOutline } from '../insert-section.ts'

/** The places the Slide Scratchpad offers (start of the talk, after a slide). */
export type ScratchPlace = { kind: 'start' } | { kind: 'after'; line: number; title: string }

/** Every place a slide can be put or moved to. */
export type SlidePlace =
  | ScratchPlace
  | { kind: 'before'; line: number; title: string }
  | { kind: 'endOfSection'; line: number; title: string }

/** A place that names a heading. */
export type HeadingPlace = Exclude<SlidePlace, { kind: 'start' }>

export interface PlaceRow {
  /** 1-based heading line. */
  line: number
  level: number
  title: string
}

/** A heading's title as the Slide outline shows it: the text after the marker, `{…}` tokens dropped. */
export function headingTitle(line: string): string {
  const m = /^#{1,6}\s+(.*)$/.exec(line)
  return (m ? m[1] : line).replace(/\{[^}]*\}/g, '').trim() || '(untitled)'
}

/** Every slide heading (`##`–`######`) in reading order, as the compiler reads the talk's structure. */
export function placeRows(text: string): PlaceRow[] {
  const lines = text.split('\n')
  const { levels } = readOutline(text)
  const rows: PlaceRow[] = []
  levels.forEach((level, i) => { if (level >= 2) rows.push({ line: i + 1, level, title: headingTitle(lines[i]) }) })
  return rows
}

/** The default place for a line (1-based): after the slide that holds it; at the start above the first slide. */
export function placeForLine(text: string, line: number | null | undefined): ScratchPlace {
  if (!Number.isInteger(line)) return { kind: 'start' }
  let found: PlaceRow | null = null
  for (const row of placeRows(text)) { if (row.line <= (line as number)) found = row; else break }
  return found ? { kind: 'after', line: found.line, title: found.title } : { kind: 'start' }
}

export type ResolvedPlace = { kind: 'start' } | { kind: HeadingPlace['kind']; index: number }

/** The heading line (0-based) a place names in this text: the line when it still has that title, else the
 *  heading with that title nearest to it; null when the slide is not in the talk any more. */
export function resolvePlace(text: string, place: ScratchPlace): { kind: 'start' } | { kind: 'after'; index: number } | null
export function resolvePlace(text: string, place: SlidePlace): ResolvedPlace | null
export function resolvePlace(text: string, place: SlidePlace): ResolvedPlace | null {
  if (place.kind === 'start') return place
  const rows = placeRows(text)
  const exact = rows.find((r) => r.line === place.line && r.title === place.title)
  if (exact) return { kind: place.kind, index: exact.line - 1 }
  const same = rows.filter((r) => r.title === place.title)
  if (same.length === 0) return null
  same.sort((a, b) => Math.abs(a.line - place.line) - Math.abs(b.line - place.line))
  return { kind: place.kind, index: same[0].line - 1 }
}

/**
 * A place chosen by hand, kept true to the talk as it changes. `earlier` are the places it advanced from (each
 * insert at a chosen place moves the place on to the slide just added), latest last. Still there at the same line:
 * unchanged (the same object). Moved by an edit above it: the same slide at its new line. Gone (an Undo took the
 * added slide back, or it was deleted): the latest earlier place that is still there, at its line; none: null, and
 * the place follows the cursor again. Never a place that names a slide the talk no longer has.
 */
export function settlePlace<P extends SlidePlace>(text: string, chosen: P | null, earlier: readonly P[]): { place: P | null; earlier: P[] } {
  if (!chosen || chosen.kind === 'start') return { place: chosen, earlier: [...earlier] }
  const stack = [...earlier]
  let candidate: P | null = chosen
  while (candidate) {
    if (candidate.kind === 'start') return { place: candidate, earlier: stack }
    const found = resolvePlace(text, candidate)
    if (found && found.kind !== 'start') {
      const line = found.index + 1
      return { place: candidate === chosen && line === (chosen as HeadingPlace).line ? chosen : { ...candidate, line }, earlier: stack }
    }
    candidate = stack.pop() ?? null
  }
  return { place: null, earlier: [] }
}

export type InsertionPoint = { ok: true; at: number; offset: number; level: number } | { ok: false; error: string }

export const PLACE_GONE = 'The slide you chose as the place is not in the talk any more. Nothing was inserted; choose the place again.'
export const UNSAFE_PLACE = 'The talk has a code fence or comment that is never closed, so the slide could not be placed safely. Nothing was inserted.'

const isBlank = (line: string): boolean => /^\s*$/.test(line)

/** Where a new slide goes for `place`: the line index its first line takes, that line's character offset, and
 *  the heading level it gets. */
export function insertionPoint(text: string, place: SlidePlace): InsertionPoint {
  const read = readOutline(text)
  if (read.openFence || read.openComment) return { ok: false, error: UNSAFE_PLACE }
  const resolved = resolvePlace(text, place)
  if (!resolved) return { ok: false, error: PLACE_GONE }
  const lines = text.split('\n')
  const { levels, bodyStart } = read
  let sectionLevel = 7
  let deepest = 0
  for (let i = bodyStart; i < levels.length; i += 1) {
    if (levels[i] >= 2) { sectionLevel = Math.min(sectionLevel, levels[i]); deepest = Math.max(deepest, levels[i]) }
  }
  let at: number
  let level: number
  if (resolved.kind === 'before') {
    at = resolved.index
    level = levels[at]
  } else if (resolved.kind === 'endOfSection') {
    // The end of the section's own block (every slide under it), as its last child.
    const owner = resolved.index
    const ownerLevel = levels[owner]
    let firstUnder = 0
    let end = owner + 1
    while (end < lines.length && !(levels[end] >= 1 && levels[end] <= ownerLevel)) {
      if (!firstUnder && levels[end] > ownerLevel) firstUnder = levels[end]
      end += 1
    }
    while (end > owner + 1 && isBlank(lines[end - 1])) end -= 1
    at = end
    level = firstUnder || Math.min(ownerLevel + 1, 6)
  } else if (resolved.kind === 'after') {
    const owner = resolved.index
    const ownerLevel = levels[owner]
    let own = owner + 1
    while (own < lines.length && levels[own] === 0) own += 1
    const firstUnder = own < lines.length && levels[own] > ownerLevel ? levels[own] : 0
    let end: number
    if (ownerLevel === sectionLevel && deepest > sectionLevel) {
      end = own
      level = firstUnder || Math.min(ownerLevel + 1, 6)
    } else {
      end = own
      // The owner's own subtree ends at the next heading at its level or above, a `# ` part heading included: an
      // insert after slide A never walks past the next part's heading and its intro.
      while (end < lines.length && !(levels[end] >= 1 && levels[end] <= ownerLevel)) end += 1
      while (end > owner + 1 && (levels[end - 1] === 1 || isBlank(lines[end - 1]))) end -= 1
      level = ownerLevel
    }
    while (end > owner + 1 && isBlank(lines[end - 1])) end -= 1
    at = end
  } else {
    let first = -1
    for (let i = bodyStart; i < lines.length; i += 1) if (levels[i] >= 2) { first = i; break }
    at = first >= 0 ? first : lines.length
    level = first >= 0 ? levels[first] : 3
    while (first < 0 && at > bodyStart && isBlank(lines[at - 1])) at -= 1
  }
  let offset = 0
  for (let i = 0; i < at && i < lines.length; i += 1) offset += lines[i].length + 1
  return { ok: true, at, offset: Math.min(offset, text.length), level }
}

/** The place `kind` of the heading a ref names (a card's heading line and text). */
export function placeAtHeading(kind: HeadingPlace['kind'], heading: { line: number; headingText: string }): HeadingPlace {
  return { kind, line: heading.line, title: headingTitle(heading.headingText.trim()) }
}
