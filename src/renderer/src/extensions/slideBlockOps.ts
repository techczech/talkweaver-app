// Whole-slide block arithmetic for cut, copy, paste and "Move … to…" (pure: no React, no CodeMirror).
// scripts/test-slide-block-ops.mjs imports this file directly and tests it as tables.
//
// A BLOCK is a heading line and everything under it down to the next heading of the same or a
// shallower level: the same rule as relocateBlock (slideOutline.ts), so a section's block holds its
// slides. Which lines are headings is read from src/shared/heading-lines.ts, as the move functions
// beside it read it: a `# comment` inside a code fence, in the frontmatter or in an HTML comment is
// not a heading, so a slide's block never ends inside its own fenced code. Each function works the
// heading map out once for its text (one pass) and indexes it; no line is scanned again per lookup.
//
// These functions edit the user's talk text. What each one guarantees:
//   - cutBlock removes whole lines only, and `clip` holds exactly the removed block's lines;
//   - pasteSlides inserts whole lines only, at a block boundary, never inside another slide's body;
//   - apart from blank separator lines, a cut followed by a paste elsewhere leaves the multiset of
//     lines unchanged, and a copy followed by a paste adds the pasted block with a fresh id;
//   - moveBlock only reorders lines (it runs the relocate functions of slideOutline.ts).
import { headingTitle, slideIdsInPrelude, TRIGGER_ONLY_RE } from '../../../../compiler/scripts/lib/slide-id.mjs'
import { relocateBlock, relocateBlockAfter, relocateBlockInto, relocateBlockToEnd } from './slideOutline.ts'
import { frontmatterEndIndex, headingLevels, headingLevelsOfText } from '../../../shared/heading-lines.ts'
import { talkTitleIndex } from '../../../shared/talk-title.ts'

const ID_TOKEN_GLOBAL = /\{id=([A-Za-z0-9_-]+)\}/g

const isBlank = (line: string): boolean => /^\s*$/.test(line)

function blockEnd0(levels: readonly number[], start0: number): number {
  const lvl = levels[start0]
  let end = start0 + 1
  while (end < levels.length) {
    const l = levels[end]
    if (l > 0 && l <= lvl) break
    end += 1
  }
  return end
}
/** Index of the first line of the blank run that ends the file (lines.length when there is none). */
function tailStart0(lines: readonly string[]): number {
  let n = lines.length
  while (n > 0 && isBlank(lines[n - 1])) n -= 1
  return n
}
/** 0-based index of the closing `---` of YAML frontmatter, or -1. Lines up to it are never slides. */
const frontmatterEnd0 = frontmatterEndIndex

/**
 * 0-based index of the start of the talk for slides: the first slide or section under the title,
 * after the title's own lines (its `#` line, its id and layout lines, any text of its own). Without
 * a title, the first slide or section of the file. -1 when there is none. "Move … to… Start of
 * talk", a paste aimed at or above the title and an insert with the caret on the title all land
 * before this line.
 */
function firstSlide0(lines: readonly string[], levels: readonly number[]): number {
  const floor = Math.max(frontmatterEnd0(lines), talkTitleIndex(lines, levels))
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

/** Whether `line` (1-based) is the talk's title: its first level-1 heading. */
export function isTalkTitleLine(text: string, line: number): boolean {
  const lines = text.split('\n')
  const title0 = talkTitleIndex(lines, headingLevelsOfText(text, lines))
  return title0 >= 0 && title0 === line - 1
}
const offsetOfLine = (lines: readonly string[], line0: number): number => {
  let at = 0
  for (let i = 0; i < line0 && i < lines.length; i += 1) at += lines[i].length + 1
  return at
}
const titleOf = (line: string): string => headingTitle(line) || '(untitled)'

export interface SlideBlock {
  /** 1-based line of the heading. */
  line: number
  /** 1-based line after the block's last line (its trailing blank lines included). */
  endLine: number
  level: number
  title: string
  /** The block holds other headings: it is a section, and they travel with it. */
  section: boolean
}

/**
 * The heading a caret on `line` (1-based) stands for: the line itself when it is a heading, or the
 * heading directly above when every line between is a layout/trigger/id line (`{…}` groups only).
 * Null anywhere else (body text, notes, blank lines, frontmatter).
 */
export function headingLineAt(text: string, line: number): number | null {
  const lines = text.split('\n')
  const levels = headingLevelsOfText(text, lines)
  let i = line - 1
  if (i < 0 || i >= lines.length || i <= frontmatterEnd0(lines)) return null
  while (i > 0 && levels[i] === 0 && TRIGGER_ONLY_RE.test(lines[i].trim())) i -= 1
  return levels[i] > 0 ? i + 1 : null
}

/** The block headed at `headingLine` (1-based), or null when that line is not a heading. */
export function blockAt(text: string, headingLine: number): SlideBlock | null {
  const lines = text.split('\n')
  const levels = headingLevelsOfText(text, lines)
  const h0 = headingLine - 1
  const level = levels[h0] ?? 0
  if (h0 < 0 || level === 0) return null
  const end = blockEnd0(levels, h0)
  let section = false
  for (let i = h0 + 1; i < end && !section; i += 1) section = levels[i] > 0
  return { line: headingLine, endLine: end + 1, level, title: titleOf(lines[h0]), section }
}

/** The block's Markdown as the clipboard holds it: its lines, trailing blank lines off, LF, one final newline. */
function clipOf(lines: readonly string[], start0: number, end0: number): string {
  const block = lines.slice(start0, end0).map((l) => l.replace(/\r$/, ''))
  while (block.length > 0 && isBlank(block[block.length - 1])) block.pop()
  return block.join('\n') + '\n'
}

export function copyBlock(text: string, headingLine: number): { clip: string; block: SlideBlock } | null {
  const block = blockAt(text, headingLine)
  if (!block) return null
  return { clip: clipOf(text.split('\n'), block.line - 1, block.endLine - 1), block }
}

export interface CutResult {
  /** The talk without the block: `before.slice(0, from) + before.slice(to)`. */
  text: string
  from: number
  to: number
  clip: string
  block: SlideBlock
}

/**
 * Cut the block headed at `headingLine`. Whole lines go, the heading's first character included, so
 * the change passes the id and heading guard as a whole-slide removal. A block in the middle takes
 * its own trailing blank lines with it; the last block of the talk takes the blank lines that
 * separated it from the block before instead, so the file ends as it did (when the file had no
 * final newline it gains one: the newline after the previous slide's last line is never removed,
 * because that line may be a protected id line).
 *
 * The talk's title (a level-1 `#` heading) is never cut: its block is the whole talk. Null for it,
 * as moveBlock keeps it on top.
 */
export function cutBlock(text: string, headingLine: number): CutResult | null {
  const block = blockAt(text, headingLine)
  if (!block || block.level === 1) return null
  const lines = text.split('\n')
  const start0 = block.line - 1
  const end0 = block.endLine - 1
  const tail = tailStart0(lines)
  let from0 = start0
  let to0 = end0
  if (Math.min(end0, tail) === tail) {
    // The last block: the separator before it goes, the blank lines that end the file stay.
    while (from0 > 0 && isBlank(lines[from0 - 1])) from0 -= 1
    to0 = tail < lines.length ? tail : lines.length
  }
  const from = offsetOfLine(lines, from0)
  const to = to0 >= lines.length ? text.length : offsetOfLine(lines, to0)
  return { text: text.slice(0, from) + text.slice(to), from, to, clip: clipOf(lines, start0, end0), block }
}

// ── Clipboard text ──

// The level of a clip's first line: a clip is read as a text of its own, so its first line (blank
// lines off) is a heading whenever it has a heading marker; nothing above it can fence it.
const firstLevel = (clip: string): number => headingLevels(clipLines(clip).slice(0, 1))[0] ?? 0

const clipLines = (clip: string): string[] => {
  const lines = clip.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length > 0 && isBlank(lines[0])) lines.shift()
  while (lines.length > 0 && isBlank(lines[lines.length - 1])) lines.pop()
  return lines
}

/** Text shaped like one or more whole slide blocks: its first line is a heading line. Shape only:
 *  whether a paste treats clipboard text as slides is isOwnSlideClip. */
export function isSlideClip(clip: string): boolean {
  return firstLevel(clip) > 0
}

// The text this app last put on the clipboard with a whole-slide cut or copy (line endings as LF).
// One record for the window, kept across talks, so a slide cut in one talk pastes in another. Text
// from anywhere else that merely starts with a `#` line (a README, a shell comment) is never read
// as slides: it pastes as ordinary text.
let lastSlideClip: string | null = null
const lfOnly = (text: string): string => text.replace(/\r\n?/g, '\n')

/** Text whose first heading is the talk's title (level 1). It is never slides to paste: pasted as a
 *  block it would put a second `#` title, and the whole talk under it, inside the talk. */
export function isTitleClip(clip: string): boolean {
  return firstLevel(clip) === 1
}

/** Record `clip` as the slide text this app wrote to the clipboard. Text that is not slide-shaped,
 *  or that starts with the talk's title, is not recorded. */
export function rememberSlideClip(clip: string): void {
  if (isSlideClip(clip) && !isTitleClip(clip)) lastSlideClip = lfOnly(clip)
}

/** Clipboard text that is exactly what this app last wrote with a whole-slide cut or copy. */
export function isOwnSlideClip(clip: string): boolean {
  return lastSlideClip !== null && isSlideClip(clip) && !isTitleClip(clip) && lfOnly(clip) === lastSlideClip
}

/** Forget the recorded slide text (tests). */
export function forgetSlideClip(): void {
  lastSlideClip = null
}

/** What a slide clip holds: its top-level blocks, and the first one's title. */
export function describeClip(clip: string): { count: number; title: string; section: boolean } | null {
  const lines = clipLines(clip)
  const levels = headingLevels(lines)
  let top = levels[0] ?? 0
  if (top === 0) return null
  let count = 1
  let nested = false
  for (let i = 1; i < lines.length; i += 1) {
    const l = levels[i]
    if (l === 0) continue
    if (l <= top) { count += 1; top = l } else nested = true
  }
  return { count, title: titleOf(lines[0]), section: count === 1 && nested }
}

/** A minter of slide ids: returns an id not in `taken` (the caller adds it). */
export type MintId = (taken: Set<string>) => string

/**
 * Give a fresh id to every slide of `block` whose id is already in `taken` (the ids of the talk it
 * is going into, then of the slides earlier in the block). Only `{id=…}` tokens where a slide's id
 * is read (the heading and its layout/trigger lines, compiler/scripts/lib/slide-id.mjs) are looked
 * at; nothing else in the lines changes. `taken` gains every id the block ends up with.
 */
export function reIdCollisions(block: readonly string[], taken: Set<string>, mint: MintId): { lines: string[]; reIds: Array<{ from: string; to: string }> } {
  const lines = [...block]
  // Only `{id=…}` tokens change below, so the heading map of the block as given holds throughout.
  const levels = headingLevels(lines)
  const reIds: Array<{ from: string; to: string }> = []
  for (let h = 0; h < lines.length; h += 1) {
    if (levels[h] === 0) continue
    let end = h + 1
    while (end < lines.length && levels[end] === 0) end += 1
    const fresh = new Map<string, string>()
    const own = new Set<string>()
    for (const { id, line } of slideIdsInPrelude(lines, h, end)) {
      if (!taken.has(id)) { own.add(id); continue }
      let to = fresh.get(id)
      if (!to) {
        to = mint(taken)
        fresh.set(id, to)
        reIds.push({ from: id, to })
      }
      lines[line] = lines[line].replace(`{id=${id}}`, `{id=${to}}`)
    }
    for (const id of own) taken.add(id)
    for (const id of fresh.values()) taken.add(id)
  }
  return { lines, reIds }
}

/** Where a paste of slides goes: after the block headed at a line, before a heading line, or at the end of the talk. */
export type PastePlace = { after: number } | { before: number } | 'end'

export interface PasteResult {
  /** The talk with the slides in: `before.slice(0, from) + insert + before.slice(from)`. */
  text: string
  from: number
  insert: string
  /** 1-based line of the first pasted heading. */
  line: number
  title: string
  /** How many top-level blocks were pasted, and whether the one block is a section. */
  count: number
  section: boolean
  /** The neighbour the status line names: the block it went after or before; null at the end of the talk. */
  anchor: { relation: 'after' | 'before'; title: string } | null
  reIds: Array<{ from: string; to: string }>
}

function pasteLf(text: string, clip: string, place: PastePlace, mint: MintId): PasteResult | null {
  const what = describeClip(clip)
  if (!what) return null
  const lines = text.split('\n')
  const levels = headingLevelsOfText(text, lines)
  const tail = tailStart0(lines)
  let at: number
  let anchor: PasteResult['anchor'] = null
  if (place === 'end') {
    at = tail
  } else if ('after' in place) {
    const h0 = place.after - 1
    if (!(levels[h0] > 0)) return null
    at = Math.min(blockEnd0(levels, h0), tail)
    anchor = { relation: 'after', title: titleOf(lines[h0]) }
  } else {
    const b0 = place.before - 1
    if (b0 < 0 || !(levels[b0] > 0)) return null
    at = b0
    anchor = { relation: 'before', title: titleOf(lines[b0]) }
  }
  // Nothing is pasted before the talk's title: a place at or above it becomes the first place after
  // it, before the first slide or section under the title, or the end of the talk when there is none.
  const title0 = talkTitleIndex(lines, levels)
  if (title0 >= 0 && at <= title0) {
    const next0 = firstSlide0(lines, levels)
    at = next0 < 0 ? tail : next0
    anchor = next0 < 0 ? null : { relation: 'before', title: titleOf(lines[next0]) }
  }
  const taken = new Set([...text.matchAll(ID_TOKEN_GLOBAL)].map((m) => m[1]))
  const { lines: block, reIds } = reIdCollisions(clipLines(clip), taken, mint)
  let from: number
  let insert: string
  let line: number
  if (at >= tail) {
    if (tail === 0) {
      from = 0
      insert = block.join('\n')
      line = 1
    } else {
      // After the last line that has text: a blank separator, then the block. The blank lines that end the file stay.
      from = offsetOfLine(lines, tail - 1) + lines[tail - 1].length
      insert = '\n\n' + block.join('\n')
      line = tail + 2
    }
  } else {
    from = offsetOfLine(lines, at)
    const blankBefore = at > 0 && !isBlank(lines[at - 1])
    insert = (blankBefore ? '\n' : '') + block.join('\n') + '\n' + (isBlank(lines[at]) ? '' : '\n')
    line = at + 1 + (blankBefore ? 1 : 0)
  }
  return { text: text.slice(0, from) + insert + text.slice(from), from, insert, line, title: what.title, count: what.count, section: what.section, anchor, reIds }
}

/**
 * Paste the slide blocks in `clip` into the talk as whole slides at `place`, one blank line between
 * them and their neighbours. A pasted slide whose id is already in the talk gets one from `mint`.
 * Null when the clip is not slide blocks or the place names a line that is not a heading.
 */
export function pasteSlides(text: string, clip: string, place: PastePlace, mint: MintId): PasteResult | null {
  if (!text.includes('\r\n')) return pasteLf(text, clip, place, mint)
  // A CRLF talk: work on LF text, then put the line endings back (CodeMirror documents are always LF).
  const lf = text.replace(/\r\n/g, '\n')
  const r = pasteLf(lf, clip, place, mint)
  if (!r) return null
  const from = r.from + (lf.slice(0, r.from).match(/\n/g)?.length ?? 0)
  const insert = r.insert.replace(/\n/g, '\r\n')
  return { ...r, from, insert, text: text.slice(0, from) + insert + text.slice(from) }
}

/**
 * Where slides pasted with the caret on `caretLine` (1-based, no selection) go, or null when the
 * caret is inside a slide's text and the paste is ordinary text: on a heading line or its
 * layout/trigger/id lines, after that slide (after the whole section when it is a section); on a
 * blank line with the next slide's heading (or the end of the talk) below, between the two.
 */
export function caretPastePlace(text: string, caretLine: number): PastePlace | null {
  const lines = text.split('\n')
  const levels = headingLevelsOfText(text, lines)
  const i = caretLine - 1
  if (i < 0 || i >= lines.length || i <= frontmatterEnd0(lines)) return null
  const heading = headingLineAt(text, caretLine)
  if (heading != null) return { after: heading }
  if (!isBlank(lines[i])) return null
  for (let j = i + 1; j < lines.length; j += 1) {
    if (isBlank(lines[j])) continue
    return levels[j] > 0 ? { before: j + 1 } : null
  }
  return 'end'
}

/**
 * A selection [from, to) that holds an entire heading line, widened so each such slide's whole block
 * goes with its title. Null when no heading line lies wholly inside the selection (then the cut or
 * copy is of ordinary text, a part of a title included). Offsets are into `text`. The start is never
 * moved: a selection that begins inside the slide before takes that text too.
 */
export function widenToBlocks(text: string, from: number, to: number): { from: number; to: number; titles: string[] } | null {
  if (to <= from) return null
  const lines = text.split('\n')
  const levels = headingLevelsOfText(text, lines)
  const fm = frontmatterEnd0(lines)
  let at = 0
  let end = to
  const titles: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const lineFrom = at
    const lineTo = at + lines[i].length
    at = lineTo + 1
    if (lineFrom > to) break
    if (i <= fm || levels[i] === 0 || lineTo === lineFrom) continue
    if (from > lineFrom || to < lineTo) continue
    titles.push(titleOf(lines[i]))
    const e0 = blockEnd0(levels, i)
    // Whole lines when the selection starts at a line start. When it starts inside a line, the newline
    // before the next heading stays, so what is left of that line is not joined onto the next title.
    const startsLine = from === 0 || text[from - 1] === '\n'
    end = Math.max(end, e0 >= lines.length ? text.length : offsetOfLine(lines, e0) - (startsLine ? 0 : 1))
  }
  return titles.length > 0 ? { from, to: end, titles } : null
}

/**
 * Whether the selection [from, to) holds any character of a level-1 heading line (the talk's title).
 * Such a selection is never a whole-slide cut or copy: widened, it would start at or before the
 * title and take it along. Offsets are into `text`.
 */
export function touchesTitleLine(text: string, from: number, to: number): boolean {
  if (to <= from) return false
  const lines = text.split('\n')
  const levels = headingLevelsOfText(text, lines)
  const fm = frontmatterEnd0(lines)
  let at = 0
  for (let i = 0; i < lines.length; i += 1) {
    const lineFrom = at
    const lineTo = at + lines[i].length
    at = lineTo + 1
    if (lineFrom >= to) break
    if (i > fm && levels[i] === 1 && from < lineTo && to > lineFrom) return true
  }
  return false
}

// ── Move … to… ──

/** Where a moved block goes. Lines are 1-based heading lines of the talk as it is before the move. */
export type MoveTarget =
  | { kind: 'start' }
  | { kind: 'end' }
  /** Into the section headed at `line`, as the last thing in it. */
  | { kind: 'into'; line: number }
  | { kind: 'before'; line: number }
  | { kind: 'after'; line: number }

// A mark no talk holds, put on the moved heading so its new line can be read off the result.
const MOVED = ' \u0001moved\u0001'

/**
 * Move the block headed at `fromLine` to `target`, with the relocate functions of slideOutline.ts
 * (the result is the same multiset of lines). Returns the new text and the moved heading's new
 * 1-based line, or null when nothing would move (not a heading, a target inside the block, already
 * there, or a place before the talk's title: nothing goes above it).
 */
export function moveBlock(text: string, fromLine: number, target: MoveTarget): { text: string; line: number } | null {
  const lines = text.split('\n')
  // The map of the talk as it is: the mark below is put at the end of a heading line, so it changes
  // no line's level.
  const levels = headingLevelsOfText(text, lines)
  const from0 = fromLine - 1
  if (!(levels[from0] > 0) || text.includes(MOVED)) return null
  const original = lines[from0]
  lines[from0] = original + MOVED
  const marked = lines.join('\n')
  let moved: string
  if (target.kind === 'start') {
    // The start of the talk is before the first slide or section under the title: after the title's
    // own lines (its `#` line, its id and layout lines, any text of its own). Without a title, before
    // the first slide or section of the file. A block that sits above the title (a file an earlier
    // build damaged) and has nothing under the title to go before goes to the end of the title's block.
    const title0 = talkTitleIndex(lines, levels)
    const first0 = firstSlide0(lines, levels)
    if (first0 === from0) return null
    if (first0 >= 0) moved = relocateBlock(marked, fromLine, first0 + 1)
    else if (title0 >= 0 && from0 < title0) moved = relocateBlockAfter(marked, fromLine, title0 + 1)
    else return null
  } else if (target.kind === 'end') {
    moved = relocateBlockToEnd(marked, fromLine)
  } else if (target.kind === 'into') {
    moved = relocateBlockInto(marked, fromLine, target.line)
  } else if (target.kind === 'before') {
    moved = relocateBlock(marked, fromLine, target.line)
  } else {
    moved = relocateBlockAfter(marked, fromLine, target.line)
  }
  if (moved === marked) return null
  const out = moved.split('\n')
  const at = out.indexOf(original + MOVED)
  if (at < 0) return null
  out[at] = original
  return { text: out.join('\n'), line: at + 1 }
}
