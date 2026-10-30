// The destination list of "Move slide to…" and "Move section to…" (pure: outline rows and the typed
// text in, options out; a chosen option carries the move). scripts/test-move-destinations.mjs imports
// this file directly. The move itself is moveBlock (extensions/slideBlockOps.ts).
import type { SlideRow } from '../extensions/slideOutline.ts'
import type { MoveTarget } from '../extensions/slideBlockOps.ts'
import type { SlidePlace } from '../../../shared/slide-handling/place.ts'

export interface MoveOption {
  key: string
  label: string
  /** Shown at the right: a section's slide count. */
  detail: string
  /** Shown at the left: the number the Slide outline shows for the row (`slideNo`, two digits); empty
   *  when the outline shows none (sections, the deck's ends). */
  no: string
  /** Heading shown above the first option of each group. */
  group: 'Talk' | 'As the last slide of' | 'Next to a slide' | 'Next to a section' | 'Where'
  /** Steps of indentation (sections, by heading depth). */
  indent: number
  /** The move this option makes; null for a slide, which asks "before or after" next (`slideLine`). */
  target: MoveTarget | null
  slideLine: number | null
  /** The section the slide is in now. */
  current: boolean
}

const isSectionAt = (rows: readonly SlideRow[], i: number): boolean => i + 1 < rows.length && rows[i + 1].level > rows[i].level
/** Index after the last row of the block that starts at row `i`. */
function subtreeEnd(rows: readonly SlideRow[], i: number): number {
  let end = i + 1
  while (end < rows.length && rows[end].level > rows[i].level) end += 1
  return end
}
function slidesInside(rows: readonly SlideRow[], i: number): number {
  let n = 0
  for (let k = i + 1, end = subtreeEnd(rows, i); k < end; k += 1) if (rows[k].slideNo != null) n += 1
  return n
}
/** The row of the nearest section above row `i` that holds it (never the deck title), or -1. */
function parentSection(rows: readonly SlideRow[], i: number): number {
  for (let k = i - 1; k >= 0; k -= 1) if (rows[k].level < rows[i].level) return rows[k].level > 1 ? k : -1
  return -1
}
const q = (query: string): string => query.trim().toLowerCase()
const has = (text: string, needle: string): boolean => needle === '' || text.toLowerCase().includes(needle)
const quoted = (title: string): string => `“${title}”`
/** Heading line -> the strip's number for that slide (slideNumbersByLine in src/shared/slide-lines.ts). */
export type StripNumbers = ReadonlyMap<number, number>
const noOf = (row: SlideRow | undefined, numbers?: StripNumbers | null): number | null =>
  !row ? null : numbers ? (numbers.get(row.line) ?? null) : row.slideNo
/** The number shown for a row, two digits: the strip's number when the compiled numbers are known (a section
 *  heading has one: its own title slide), else the outline's leaf number. '' when there is none. */
export const slideNumber = (row: SlideRow | undefined, numbers?: StripNumbers | null): string => {
  const n = noOf(row, numbers)
  return n != null ? String(n).padStart(2, '0') : ''
}
/** Typed digits find the row with that number (`14` finds 14, and 140). */
const numberMatches = (row: SlideRow, needle: string, numbers?: StripNumbers | null): boolean => {
  const n = noOf(row, numbers)
  return n != null && /^\d+$/.test(needle) && (String(n).startsWith(needle) || slideNumber(row, numbers).startsWith(needle))
}
const count = (n: number): string => `${n} slide${n === 1 ? '' : 's'}`

/** Start of talk / End of talk, left out when the block is already there. */
function talkEnds(rows: readonly SlideRow[], from: number, needle: string): MoveOption[] {
  const out: MoveOption[] = []
  const first = rows.findIndex((r) => r.level > 1)
  const place = (key: string, label: string, target: MoveTarget): MoveOption => ({ key, label, detail: '', no: '', group: 'Talk', indent: 0, target, slideLine: null, current: false })
  if (first >= 0 && first !== from && has('Start of talk', needle)) out.push(place('start', 'Start of talk', { kind: 'start' }))
  if (subtreeEnd(rows, from) < rows.length && has('End of talk', needle)) out.push(place('end', 'End of talk', { kind: 'end' }))
  return out
}

/** Before “X” / After “X”, leaving out the side the block is already on. */
function sides(rows: readonly SlideRow[], from: number, at: number, group: MoveOption['group'], numbers?: StripNumbers | null): MoveOption[] {
  const out: MoveOption[] = []
  const row = rows[at]
  const side = (relation: 'before' | 'after'): MoveOption => ({
    key: `${relation}:${row.line}`, label: `${relation === 'before' ? 'Before' : 'After'} ${quoted(row.text)}`, detail: '', no: slideNumber(row, numbers), group, indent: 0,
    target: { kind: relation, line: row.line }, slideLine: null, current: false
  })
  if (subtreeEnd(rows, from) !== at) out.push(side('before'))
  if (subtreeEnd(rows, at) !== from) out.push(side('after'))
  return out
}

/**
 * Where the slide on `fromLine` can go: Start of talk, End of talk, then every section in outline
 * order (the slide becomes the last slide of the chosen one). Typed text filters these by name and
 * also offers the other slides whose titles match; a slide is a `slideLine` option, answered next by
 * placementOptions. Sections the slide could not be inside (its own level or deeper, the deck title)
 * are not offered.
 */
export function slideMoveOptions(rows: readonly SlideRow[], fromLine: number, query = '', numbers?: StripNumbers | null): MoveOption[] {
  const from = rows.findIndex((r) => r.line === fromLine)
  if (from < 0) return []
  const needle = q(query)
  const out = talkEnds(rows, from, needle)
  const fromEnd = subtreeEnd(rows, from)
  const parent = parentSection(rows, from)
  const sections = rows.map((_, i) => i).filter((i) => isSectionAt(rows, i) && rows[i].level > 1 && rows[i].level < rows[from].level && (i < from || i >= fromEnd))
  const top = Math.min(...sections.map((i) => rows[i].level))
  for (const i of sections) {
    if (!(has(rows[i].text, needle) || numberMatches(rows[i], needle, numbers))) continue
    // A section further up that the slide already ends (it is last in the last section inside it): nothing would move.
    if (i !== parent && i < from && subtreeEnd(rows, i) === fromEnd) continue
    out.push({
      key: `into:${rows[i].line}`, label: rows[i].text, detail: count(slidesInside(rows, i)), no: slideNumber(rows[i], numbers), group: 'As the last slide of',
      indent: rows[i].level - top, target: { kind: 'into', line: rows[i].line }, slideLine: null, current: i === parent
    })
  }
  if (needle !== '') {
    rows.forEach((r, i) => {
      if (i === from || r.level === 1 || isSectionAt(rows, i) || (i > from && i < fromEnd) || !(has(r.text, needle) || numberMatches(r, needle, numbers))) return
      out.push({ key: `slide:${r.line}`, label: r.text, detail: '', no: slideNumber(r, numbers), group: 'Next to a slide', indent: 0, target: null, slideLine: r.line, current: false })
    })
  }
  return out
}

/** The second step after choosing a slide: Before “Title” and After “Title”. */
export function placementOptions(rows: readonly SlideRow[], fromLine: number, slideLine: number, numbers?: StripNumbers | null): MoveOption[] {
  const from = rows.findIndex((r) => r.line === fromLine)
  const at = rows.findIndex((r) => r.line === slideLine)
  if (from < 0 || at < 0 || from === at) return []
  return sides(rows, from, at, 'Where', numbers)
}

/**
 * Where the section on `fromLine` can go: Start of talk, End of talk, and before or after each other
 * heading of the same level (a section never goes inside itself: only headings of its own level are offered).
 */
export function sectionMoveOptions(rows: readonly SlideRow[], fromLine: number, query = '', numbers?: StripNumbers | null): MoveOption[] {
  const from = rows.findIndex((r) => r.line === fromLine)
  if (from < 0) return []
  const needle = q(query)
  const out = talkEnds(rows, from, needle)
  rows.forEach((r, i) => {
    if (i === from || r.level !== rows[from].level) return
    for (const option of sides(rows, from, i, 'Next to a section', numbers)) if (has(option.label, needle) || numberMatches(r, needle, numbers)) out.push(option)
  })
  return out
}

/** What the status line says after the move, e.g. `Moved “Title” to the end of “Section”.` */
export function moveMessage(rows: readonly SlideRow[], fromLine: number, target: MoveTarget): string {
  const title = quoted(rows.find((r) => r.line === fromLine)?.text ?? '(untitled)')
  const other = 'line' in target ? quoted(rows.find((r) => r.line === target.line)?.text ?? '(untitled)') : ''
  switch (target.kind) {
    case 'start': return `Moved ${title} to the start of the talk.`
    case 'end': return `Moved ${title} to the end of the talk.`
    case 'into': return `Moved ${title} to the end of ${other}.`
    case 'before': return `Moved ${title} before ${other}.`
    case 'after': return `Moved ${title} after ${other}.`
  }
}

export interface MoveSubject { line: number; kind: 'slide' | 'section'; title: string }

/**
 * What a move command acts on, from the heading line the caret or the selection stands on (`line`
 * may be any line of the slide). "slide": the slide there, or the section when the heading is a
 * section's. "section": the section there, or the section holding the slide. Null on the deck title,
 * above the first heading, and for "section" when the slide is in none.
 */
export function moveSubject(rows: readonly SlideRow[], line: number, want: 'slide' | 'section'): MoveSubject | null {
  let i = -1
  for (let k = 0; k < rows.length; k += 1) if (rows[k].line <= line) i = k
  if (i < 0 || rows[i].level === 1) return null
  if (isSectionAt(rows, i)) return { line: rows[i].line, kind: 'section', title: rows[i].text }
  if (want === 'slide') return { line: rows[i].line, kind: 'slide', title: rows[i].text }
  const parent = parentSection(rows, i)
  return parent < 0 ? null : { line: rows[parent].line, kind: 'section', title: rows[parent].text }
}

/** One destination of "Move N slides to…" (the batch bar): where the selected slides go, as a SlidePlace. */
export interface BatchMoveOption {
  key: string
  label: string
  detail: string
  no: string
  group: 'Talk' | 'End of section' | 'After slide'
  indent: number
  place: SlidePlace
}

/**
 * The destinations for several selected slides or sections (`selectedLines`: their heading lines): Start / End of
 * talk, the end of each section the selection could sit inside (shallower than every selected block), and, as the
 * typed text asks, "after" any slide outside the selection (typed text filters both lists by name or number).
 * Nothing inside a selected block is offered. Every option is a SlidePlace for moveBlocks.
 */
export function batchMoveOptions(rows: readonly SlideRow[], selectedLines: readonly number[], query = '', numbers?: StripNumbers | null): BatchMoveOption[] {
  const picked = rows.map((_, i) => i).filter((i) => selectedLines.includes(rows[i].line))
  if (picked.length === 0) return []
  const needle = q(query)
  const inside = (i: number): boolean => picked.some((p) => i >= p && i < subtreeEnd(rows, p))
  const minLevel = Math.min(...picked.map((p) => rows[p].level))
  const topLevel = Math.min(...rows.filter((r) => r.level > 1).map((r) => r.level))
  const lastTop = [...rows].reverse().find((r) => r.level === topLevel)
  const out: BatchMoveOption[] = []
  const talk = (key: string, label: string, place: SlidePlace): void => {
    if (has(label, needle)) out.push({ key, label, detail: '', no: '', group: 'Talk', indent: 0, place })
  }
  talk('start', 'Start of talk', { kind: 'start' })
  if (lastTop) talk('end', 'End of talk', { kind: 'after', line: lastTop.line, title: lastTop.text })
  const sections = rows.map((_, i) => i).filter((i) => rows[i].level > 1 && rows[i].level < minLevel && isSectionAt(rows, i) && !inside(i))
  const top = sections.length ? Math.min(...sections.map((i) => rows[i].level)) : 0
  for (const i of sections) {
    if (!(has(rows[i].text, needle) || numberMatches(rows[i], needle, numbers))) continue
    out.push({
      key: `into:${rows[i].line}`, label: rows[i].text, detail: count(slidesInside(rows, i)), no: slideNumber(rows[i], numbers), group: 'End of section',
      indent: rows[i].level - top, place: { kind: 'endOfSection', line: rows[i].line, title: rows[i].text }
    })
  }
  rows.forEach((r, i) => {
    if (r.level === 1 || inside(i) || !(has(r.text, needle) || numberMatches(r, needle, numbers))) return
    out.push({ key: `after:${r.line}`, label: r.text, detail: '', no: slideNumber(r, numbers), group: 'After slide', indent: 0, place: { kind: 'after', line: r.line, title: r.text } })
  })
  return out
}
