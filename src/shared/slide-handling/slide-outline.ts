// Pure slide-outline logic (no React/CodeMirror). scripts/test-slide-outline.mjs and
// scripts/test-slide-outline-moves.mjs import this file directly.
//
// Every relocate function here refuses a move that would put the block before the talk's level-1
// title (src/shared/talk-title.ts): the text comes back unchanged, as for any other impossible move.
//
// Which lines are headings is read from src/shared/heading-lines.ts: a `# comment` inside a code
// fence, in the frontmatter or in an HTML comment is not a heading, so it is not an outline row and
// never ends a block. Each function works the heading map out once for its text.
import { headingLevelsOfText } from '../heading-lines.ts'
import { landsBeforeTitle, talkTitleIndex } from '../talk-title.ts'

/** 1-based line of the talk's title (its level-1 heading), or null when the talk has none. No row
 *  at or above this line is a place a slide can be dropped before. */
export function talkTitleLine(text: string): number | null {
  const lines = text.split('\n')
  const i = talkTitleIndex(lines, headingLevelsOfText(text, lines))
  return i < 0 ? null : i + 1
}

// `id` is the slide's `{id=…}` when it has one, on the heading or on the line directly below it (the
// same two places the compiler reads it, compiler/scripts/lib/slide-id.mjs): the stable identity the
// collapse state follows (src/renderer/src/lib/outlineCollapse.ts).
export type SlideRow = { line: number; level: number; text: string; slideNo: number | null; id: string | null }

const ID_TOKEN = /\{id=([A-Za-z0-9_-]+)\}/

// Every heading #–###### in document order (heading-is-slide model: hierarchy = heading depth);
// {triggers} stripped. LEAVES are the numbered slides: a heading whose next heading is deeper is a
// section (slideNo null), and the deck title (#) is never numbered. `level` carries the depth the
// organizer indents/collapses on.
export function slideRows(content: string): SlideRow[] {
  const raw: Array<{ line: number; level: number; text: string; id: string | null }> = []
  const sourceLines = content.split('\n')
  const levels = headingLevelsOfText(content, sourceLines)
  sourceLines.forEach((t, i) => {
    // The marker and the text after it (the same reading as before the heading map: it is only
    // asked of lines the map says are headings).
    const m = levels[i] > 0 ? t.match(/^(#{1,6})\s+(.*)$/) : null
    if (!m) return
    const text = m[2].replace(/\{[^}]*\}/g, '').trim() || '(untitled)'
    const below = sourceLines[i + 1] ?? ''
    const idMatch = m[2].match(ID_TOKEN) ?? (levels[i + 1] > 0 ? null : below.match(ID_TOKEN))
    raw.push({ line: i + 1, level: m[1].length, text, id: idMatch ? idMatch[1] : null })
  })
  let slideNo = 0
  return raw.map((r, idx) => {
    const isSection = idx + 1 < raw.length && raw[idx + 1].level > r.level
    if (isSection || r.level === 1) return { ...r, slideNo: null }
    slideNo += 1
    return { ...r, slideNo }
  })
}

// Move the heading-block at `fromLine` (heading + lines until the next heading whose level ≤ this
// heading's level, EOF otherwise) to just before the heading-block at `toLine`. 1-based lines.
// No-op when either line is not a heading, when dropping into the from-block, or out of range, and
// when `toLine` is the talk's title or a heading above it (nothing goes before the title).
export function relocateBlock(text: string, fromLine: number, toLine: number): string {
  const lines = text.split('\n')
  const levels = headingLevelsOfText(text, lines)
  const levelAt = (idx: number): number => levels[idx] ?? 0
  const from0 = fromLine - 1
  const to0 = toLine - 1
  if (from0 < 0 || from0 >= lines.length || to0 < 0 || to0 >= lines.length) return text
  if (levelAt(from0) === 0 || levelAt(to0) === 0) return text
  const lvl = levelAt(from0)
  let fEnd = from0 + 1
  while (fEnd < lines.length) {
    const l = levelAt(fEnd)
    if (l > 0 && l <= lvl) break
    fEnd += 1
  }
  if (to0 >= from0 && to0 < fEnd) return text
  if (landsBeforeTitle(lines, from0, fEnd, to0, levels)) return text
  const block = lines.slice(from0, fEnd)
  const without = [...lines.slice(0, from0), ...lines.slice(fEnd)]
  const insertAt = to0 < from0 ? to0 : to0 - (fEnd - from0)
  return [...without.slice(0, insertAt), ...block, ...without.slice(insertAt)].join('\n')
}

// ── Drop targets that are not "before a row" (Slides organizer: end of talk, into a section) ──
// Both functions move whole lines only: the result is always the same multiset of lines as the
// input, with only the moved block's position changed.

const isBlankLine = (line: string): boolean => /^\s*$/.test(line)

// End (exclusive, 0-based) of the heading-block starting at `start0`: the next heading whose level
// is ≤ this one's, EOF otherwise. Same rule as relocateBlock.
function blockEnd(levels: readonly number[], start0: number): number {
  const lvl = levels[start0]
  let end = start0 + 1
  while (end < levels.length) {
    const l = levels[end]
    if (l > 0 && l <= lvl) break
    end += 1
  }
  return end
}

// Take the trailing run of blank lines off `lines` (mutates) and return it.
function peelTrailingBlanks(lines: string[]): string[] {
  let n = lines.length
  while (n > 0 && isBlankLine(lines[n - 1])) n -= 1
  return lines.splice(n)
}

// Move lines[from0, fEnd) so the block sits immediately before original index `at` (which is never
// strictly inside the block). A block carries its own trailing blank lines, as in relocateBlock,
// with one rule for the end of the file: the blank lines that END THE FILE stay at the end of the
// file, and the blank lines that SEPARATE blocks stay between blocks. Without it, a file with no
// final newline would glue the old last slide's body to the moved heading ("body\n### Moved"), and
// the moved slide would bring a stray trailing newline with it. So when the block leaves the end of
// the file, it takes the separator of the block that becomes last; when it arrives at the end, it
// hands its separator to the block that used to be last.
// A place before the talk's title is refused: the lines come back as they were.
function moveSpan(lines: string[], levels: readonly number[], from0: number, fEnd: number, at: number): string[] {
  if (landsBeforeTitle(lines, from0, fEnd, at, levels)) return lines
  let tailStart = lines.length
  while (tailStart > 0 && isBlankLine(lines[tailStart - 1])) tailStart -= 1
  const tail = lines.slice(tailStart)
  const core = lines.slice(0, tailStart)
  const bEnd = Math.min(fEnd, tailStart)
  const target = Math.min(at, tailStart)
  const block = core.slice(from0, bEnd)
  const rest = [...core.slice(0, from0), ...core.slice(bEnd)]
  const insertAt = target <= from0 ? target : target - (bEnd - from0)
  const wasLast = bEnd === tailStart
  const toLast = insertAt === rest.length
  let head = rest.slice(0, insertAt)
  const after = rest.slice(insertAt)
  if (wasLast && !toLast) {
    block.push(...peelTrailingBlanks(after)) // `after` now ends the file
  } else if (!wasLast && toLast) {
    head = [...head, ...peelTrailingBlanks(block)]
  }
  return [...head, ...block, ...after, ...tail]
}

// Move the heading-block at `fromLine` (1-based) to the end of the document. No-op when the line is
// not a heading, is out of range, or the block already ends the document.
export function relocateBlockToEnd(text: string, fromLine: number): string {
  const lines = text.split('\n')
  const from0 = fromLine - 1
  const levels = headingLevelsOfText(text, lines)
  if (from0 < 0 || from0 >= lines.length || levels[from0] === 0) return text
  return moveSpan(lines, levels, from0, blockEnd(levels, from0), lines.length).join('\n')
}

// Move the heading-block at `fromLine` INTO the section headed at `sectionLine` (both 1-based), as
// the last thing in it: the block lands at the end of the section's own block (after every nested
// subsection). No-op when either line is not a heading or is out of range, when the section is the
// moved block or inside it, when the block is already last in the section, and when the block's
// heading is not deeper than the section's (it could not be a child of it).
export function relocateBlockInto(text: string, fromLine: number, sectionLine: number): string {
  const lines = text.split('\n')
  const from0 = fromLine - 1
  const sec0 = sectionLine - 1
  if (from0 < 0 || from0 >= lines.length || sec0 < 0 || sec0 >= lines.length) return text
  const levels = headingLevelsOfText(text, lines)
  const fromLevel = levels[from0]
  const secLevel = levels[sec0]
  if (fromLevel === 0 || secLevel === 0 || fromLevel <= secLevel) return text
  const fEnd = blockEnd(levels, from0)
  if (sec0 >= from0 && sec0 < fEnd) return text
  return moveSpan(lines, levels, from0, fEnd, blockEnd(levels, sec0)).join('\n')
}

// Move the heading-block at `fromLine` to just AFTER the heading-block at `afterLine` (both 1-based):
// it lands where that block ends (after everything nested in it). No-op when either line is not a
// heading or is out of range, when the target is the moved block or inside it, and when the block is
// already there. The moved block may sit inside the target (a slide moved to after its own section).
export function relocateBlockAfter(text: string, fromLine: number, afterLine: number): string {
  const lines = text.split('\n')
  const from0 = fromLine - 1
  const after0 = afterLine - 1
  if (from0 < 0 || from0 >= lines.length || after0 < 0 || after0 >= lines.length) return text
  const levels = headingLevelsOfText(text, lines)
  if (levels[from0] === 0 || levels[after0] === 0) return text
  const fEnd = blockEnd(levels, from0)
  if (after0 >= from0 && after0 < fEnd) return text
  return moveSpan(lines, levels, from0, fEnd, blockEnd(levels, after0)).join('\n')
}

// Move the heading-block at `fromLine` to just BEFORE the heading at `beforeLine` (both 1-based), with
// moveSpan's end-of-file rule (relocateBlock, the older "before a row" move, glues a block that had no final
// newline to the heading it lands before). No-op when either line is not a heading or is out of range, when the
// target is inside the moved block, and when the block is already there. Slide handling's moveBlocks uses it.
export function relocateBlockBefore(text: string, fromLine: number, beforeLine: number): string {
  const lines = text.split('\n')
  const from0 = fromLine - 1
  const to0 = beforeLine - 1
  if (from0 < 0 || from0 >= lines.length || to0 < 0 || to0 >= lines.length) return text
  const levels = headingLevelsOfText(text, lines)
  if (levels[from0] === 0 || levels[to0] === 0) return text
  const fEnd = blockEnd(levels, from0)
  if (to0 >= from0 && to0 <= fEnd) return text
  return moveSpan(lines, levels, from0, fEnd, to0).join('\n')
}
