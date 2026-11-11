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

import { headingLevelsOfText, frontmatterEndIndex } from '../heading-lines.ts'
import { talkTitleIndex } from '../talk-title.ts'
import { TRIGGER_ONLY_RE } from '../../../compiler/scripts/lib/slide-id.mjs'
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
export function resolvePlace(text: string, place: SlidePlace, mode?: 'slide' | 'paste'): ResolvedPlace | null
export function resolvePlace(text: string, place: SlidePlace, mode: 'slide' | 'paste' = 'slide'): ResolvedPlace | null {
  if (place.kind === 'start') return place
  const lines = text.split('\n')
  const rows = mode === 'paste'
    ? headingLevelsOfText(text, lines).flatMap((level, i) => level > 0 ? [{ line: i + 1, title: headingTitle(lines[i]) }] : [])
    : placeRows(text)
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

export type InsertionPoint = { ok: true; at: number; offset: number; level: number; titleClamped?: boolean } | { ok: false; error: string }

export const PLACE_GONE = 'The slide you chose as the place is not in the talk any more. Nothing was inserted; choose the place again.'
export const UNSAFE_PLACE = 'The talk has a code fence or comment that is never closed, so the slide could not be placed safely. Nothing was inserted.'

const isBlank = (line: string): boolean => /^\s*$/.test(line)

/** Where a new slide goes for `place`: the line index its first line takes, that line's character offset, and
 *  the heading level it gets. */
export function insertionPoint(text: string, place: SlidePlace, mode: 'slide' | 'paste' = 'slide', options?: { partHeadings: 'body' | 'boundary' }): InsertionPoint {
  const read = readOutline(text)
  if (mode === 'slide' && (read.openFence || read.openComment)) return { ok: false, error: UNSAFE_PLACE }
  const resolved = resolvePlace(text, place, mode)
  if (!resolved) return { ok: false, error: PLACE_GONE }
  const lines = text.split('\n')
  const levels = mode === 'paste' ? headingLevelsOfText(text, lines) : read.levels
  const { bodyStart } = read
  let sectionLevel = 7
  let deepest = 0
  for (let i = bodyStart; i < levels.length; i += 1) {
    if (levels[i] >= 2) { sectionLevel = Math.min(sectionLevel, levels[i]); deepest = Math.max(deepest, levels[i]) }
  }
  let at: number
  let level: number
  let titleClamped = false
  if (mode === 'paste') {
    let tail = lines.length
    while (tail > 0 && isBlank(lines[tail - 1])) tail -= 1
    if (resolved.kind === 'start') {
      const first = firstSlide0(lines, levels)
      at = first < 0 ? tail : first
    } else if (resolved.kind === 'before') at = resolved.index
    else {
      at = resolved.index + 1
      while (at < lines.length && !(levels[at] > 0 && levels[at] <= levels[resolved.index])) at += 1
      at = Math.min(at, tail)
    }
    const title = talkTitleIndex(lines, levels)
    if (title >= 0 && at <= title) {
      titleClamped = true
      const first = firstSlide0(lines, levels)
      at = first < 0 ? tail : first
    }
    level = resolved.kind === 'start' ? (levels[at] || 3) : levels[resolved.index]
  } else if (resolved.kind === 'before') {
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
      // insert after slide A stops at the next part heading. Archive insertion historically treats
      // those headings as body instead; its explicit option preserves that dialect's landing position.
      while (end < lines.length && !(levels[end] >= (options?.partHeadings === 'body' ? 2 : 1) && levels[end] <= ownerLevel)) end += 1
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
  return { ok: true, at, offset: Math.min(offset, text.length), level, ...(titleClamped ? { titleClamped: true } : {}) }
}

/** The place `kind` of the heading a ref names (a card's heading line and text). */
export function placeAtHeading(kind: HeadingPlace['kind'], heading: { line: number; headingText: string }): HeadingPlace {
  return { kind, line: heading.line, title: headingTitle(heading.headingText.trim()) }
}

/** Legacy line-addressed inputs are accepted only at the clipboard boundary. */
export type PastePlace = SlidePlace | { after: number } | { before: number } | 'end'

export function firstSlide0(lines: readonly string[], levels: readonly number[]): number {
  const floor = Math.max(frontmatterEndIndex(lines), talkTitleIndex(lines, levels))
  for (let i = floor + 1; i < levels.length; i += 1) if (levels[i] > 1) return i
  return -1
}

/**
 * Where slides put in at the start of the talk go: before the first slide or section under the
 * title, or at the end of the talk when there is none (firstSlide0, the place "Move … to… Start of
 * talk" lands).
 */
export function startOfTalkPlace(text: string): PastePlace {
  const lines = text.split('\n')
  const first0 = firstSlide0(lines, headingLevelsOfText(text, lines))
  return first0 < 0 ? 'end' : { before: first0 + 1 }
}


export function headingLineAt(text: string, line: number): number | null {
  const lines = text.split('\n')
  const levels = headingLevelsOfText(text, lines)
  let i = line - 1
  if (i < 0 || i >= lines.length || i <= frontmatterEndIndex(lines)) return null
  while (i > 0 && levels[i] === 0 && TRIGGER_ONLY_RE.test(lines[i].trim())) i -= 1
  return levels[i] > 0 ? i + 1 : null
}


export function caretPastePlace(text: string, caretLine: number): PastePlace | null {
  const lines = text.split('\n')
  const levels = headingLevelsOfText(text, lines)
  const i = caretLine - 1
  if (i < 0 || i >= lines.length || i <= frontmatterEndIndex(lines)) return null
  const heading = headingLineAt(text, caretLine)
  if (heading != null) return { after: heading }
  if (!isBlank(lines[i])) return null
  for (let j = i + 1; j < lines.length; j += 1) {
    if (isBlank(lines[j])) continue
    return levels[j] > 0 ? { before: j + 1 } : null
  }
  return 'end'
}


/** Name a clipboard boundary once; all placement arithmetic runs in insertionPoint. */
export function slidePlaceForPaste(text: string, place: PastePlace): SlidePlace | null {
  if (typeof place === 'object' && 'kind' in place) return place
  const lines = text.split('\n')
  const levels = headingLevelsOfText(text, lines)
  if (place === 'end') {
    let last = levels.length - 1
    while (last >= 0 && levels[last] === 0) last -= 1
    return last < 0 ? { kind: 'start' } : { kind: 'endOfSection', line: last + 1, title: headingTitle(lines[last]) }
  }
  const line = 'after' in place ? place.after : place.before
  if (!(levels[line - 1] > 0)) return null
  return { kind: 'after' in place ? 'endOfSection' : 'before', line, title: headingTitle(lines[line - 1]) }
}

/** Whole-slide caret insertion uses the clipboard boundary, preserving the heading's entire body. */
export function caretSlidePlace(text: string, pos: number): SlidePlace | null {
  const line = text.slice(0, pos).split('\n').length
  const levels = headingLevelsOfText(text)
  if (!(levels[line - 1] > 0)) return null
  return slidePlaceForPaste(text, levels[line - 1] === 1 && talkTitleIndex(text.split('\n'), levels) === line - 1
    ? startOfTalkPlace(text) : { after: line })
}
