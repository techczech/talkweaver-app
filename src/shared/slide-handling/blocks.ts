// Slide handling, moving slides and sections (spec docs/design/2026-10-28-slide-handling/slide-handling-build-spec.md
// § Shared unit). Block extents and single-block moves are the existing arithmetic of ./slide-block-ops.ts
// (blockAt, moveBlock; built on ./slide-outline.ts relocateBlock*; both moved here from src/renderer/src/extensions,
// which re-exports them); nothing here re-implements it. NEW: moveBlocks, the multi-block move every
// surface (grid, slide strip, later the Slides outline and Move to…) runs.
//
// What moveBlocks guarantees (each point checked on the result; a result that fails any is refused, never returned):
//   - the same lines, only reordered: the multiset of lines before == after;
//   - the text that is not moved keeps its order: its non-blank lines, in order, are exactly the original's
//     non-blank lines minus the moved blocks' (blank separator lines may shift at the end of the file, as in
//     slide-outline.ts moveSpan);
//   - each moved block's own lines (heading to its last non-blank line, inner blank lines included) appear
//     unchanged and contiguous in the result; the moved blocks follow each other in talk order with only blank
//     lines between them, and stand at the place: right before the place's heading (before), right after the
//     place's block (after, endOfSection), or before the talk's first slide (start);
//   - a moved block of level L is never followed directly by a heading deeper than L that was not part of it
//     (it would adopt those slides): refused with MOVE_CAPTURE;
//   - a ref is a heading line (1-based) and that heading as the person saw it (the card's heading line, or its
//     title); a ref whose line no longer holds that heading (same title; same level when the ref has a level) is
//     refused, never applied to another block;
//   - a ref inside another selected ref's block travels with it and is dropped; a place inside a selected block
//     is refused;
//   - headings keep their levels (a moved section keeps its slides under it).
// cutBlocks guarantees: the remaining text's non-blank lines, in order, are exactly the original's minus the cut
// blocks' (checked), and the clip holds exactly the cut blocks' non-blank lines (checked).
// Pure: no I/O, no React, no CodeMirror. Tests: scripts/test-slide-handling-blocks.mjs.

import { blockAt, copyBlock, cutBlock, moveBlock, startOfTalkPlace, type MoveTarget, type SlideBlock } from './slide-block-ops.ts'
import { relocateBlockAfter, relocateBlockBefore, relocateBlockInto } from './slide-outline.ts'
import { headingLevelsOfText } from '../heading-lines.ts'
import { headingTitle, resolvePlace, type SlidePlace } from './place.ts'

export { blockAt, type SlideBlock }

/** A slide or section to move: its heading line (1-based) and its heading text (the line, or its title). */
export interface SlideRef { line: number; headingText: string }

/** One minimal change, as CodeMirror's ChangeSpec takes it (offsets into the text before the move). */
export interface TextChange { from: number; to: number; insert: string }

export type MoveBlocksResult =
  | {
    text: string
    changes: TextChange
    /** Each moved block's lines in the new text, talk order: [line, endLine), 1-based. */
    movedRanges: Array<{ line: number; endLine: number }>
  }
  | { refused: string }

export const MOVE_STALE = 'The talk changed while you were moving the slide, and it is no longer where it was. Nothing was moved; try again.'
export const MOVE_INTO_ITSELF = 'A slide or section cannot be moved inside itself. Nothing was moved.'
export const MOVE_PLACE_GONE = 'The place you chose is not in the talk any more. Nothing was moved.'
export const MOVE_NOTHING = 'The slides are already there. Nothing was moved.'
export const MOVE_NOT_POSSIBLE = 'That move is not possible (nothing goes above the talk’s title). Nothing was moved.'
export const MOVE_CAPTURE = 'A section can only be placed between sections: there it would take in the slides after it. Nothing was moved.'
export const MOVE_UNSAFE = 'The move would change more than the order of the slides, so nothing was moved.'

// Marks no talk holds, put at the end of heading lines so a block's current line can be read off after each step.
// At the end of a heading line they change no line's level.
const mark = (n: number): string => ` \u0002mb${n}\u0002`
const MARK_RE = / \u0002mb\d+\u0002/

const LEVEL_RE = /^(#{1,6})\s/
/**
 * The same heading: a heading line (level `level`) whose title is the ref's (ids and layout tokens may have been
 * stamped since). When the ref's text is a heading line it names a level too, and the levels must match; a ref that
 * is a bare title (a section card whose row carries no source) matches on the title alone.
 */
function sameHeading(line: string | undefined, level: number, headingText: string): boolean {
  if (line == null || headingTitle(line.trim()) !== headingTitle(headingText.trim())) return false
  const refLevel = LEVEL_RE.exec(headingText.trim())?.[1].length ?? 0
  return refLevel === 0 || refLevel === level
}

/** Whether `ref`'s line in `text` still holds its heading (the check moveBlocks and cutBlocks make on every ref). */
export function refHolds(text: string, ref: SlideRef): boolean {
  const lines = text.split('\n')
  const levels = headingLevelsOfText(text, lines)
  const i = ref.line - 1
  return Number.isInteger(ref.line) && i >= 0 && i < lines.length && levels[i] > 0 && sameHeading(lines[i], levels[i], ref.headingText)
}

/** The minimal single change from `a` to `b` (common prefix and suffix left out). */
export function minimalChange(a: string, b: string): TextChange {
  let start = 0
  const max = Math.min(a.length, b.length)
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) { endA -= 1; endB -= 1 }
  return { from: start, to: endA, insert: b.slice(start, endB) }
}

const sortedLines = (text: string): string => text.split('\n').sort().join('\n')

/**
 * Move the blocks headed at `refs` to `place`, in talk order, as one change. Returns the new text, the one minimal
 * change and where the moved blocks now are; or `{ refused }` with the reason, and the text is not changed.
 */
export function moveBlocks(text: string, refs: readonly SlideRef[], place: SlidePlace): MoveBlocksResult {
  if (MARK_RE.test(text)) return { refused: MOVE_UNSAFE }
  const lines = text.split('\n')
  const levels = headingLevelsOfText(text, lines)
  // Every ref must still be the heading it was.
  for (const ref of refs) {
    const i = ref.line - 1
    if (!Number.isInteger(ref.line) || i < 0 || i >= lines.length || !(levels[i] > 0) || !sameHeading(lines[i], levels[i], ref.headingText)) {
      return { refused: MOVE_STALE }
    }
  }
  // Talk order; a ref inside another selected block travels with it.
  const blocks: SlideBlock[] = []
  for (const line of [...new Set(refs.map((r) => r.line))].sort((a, b) => a - b)) {
    const b = blockAt(text, line)
    if (!b) return { refused: MOVE_STALE }
    const outer = blocks[blocks.length - 1]
    if (outer && line < outer.endLine) continue
    blocks.push(b)
  }
  if (blocks.length === 0) return { refused: MOVE_NOTHING }
  // The place, in this text; never inside a moved block.
  let targetLine0 = -1
  if (place.kind !== 'start') {
    const resolved = resolvePlace(text, place)
    if (!resolved || resolved.kind === 'start') return { refused: MOVE_PLACE_GONE }
    targetLine0 = resolved.index
    if (blocks.some((b) => targetLine0 >= b.line - 1 && targetLine0 < b.endLine - 1)) return { refused: MOVE_INTO_ITSELF }
  }
  // Mark the moved headings and the place's heading, then move one block at a time: the first to the place, each
  // next one after the one before it. Each step is one of the relocate functions (slide-outline.ts; whole lines only).
  const marked = [...lines]
  blocks.forEach((b, n) => { marked[b.line - 1] += mark(n) })
  const TARGET = blocks.length
  if (targetLine0 >= 0) marked[targetLine0] += mark(TARGET)
  let work = marked.join('\n')
  const lineOfMark = (n: number): number => work.split('\n').findIndex((l) => l.endsWith(mark(n))) + 1
  let movedAny = false
  for (let n = 0; n < blocks.length; n += 1) {
    const from = lineOfMark(n)
    let step: MoveTarget
    if (n > 0) step = { kind: 'after', line: lineOfMark(n - 1) }
    else if (place.kind === 'start') step = { kind: 'start' }
    else {
      const at = lineOfMark(TARGET)
      step = place.kind === 'after' ? { kind: 'after', line: at }
        : place.kind === 'before' ? { kind: 'before', line: at }
          : { kind: 'into', line: at }
    }
    const moved = step.kind === 'start' ? moveBlock(work, from, step)?.text ?? work
      : step.kind === 'before' ? relocateBlockBefore(work, from, step.line)
        : step.kind === 'after' ? relocateBlockAfter(work, from, step.line)
          : relocateBlockInto(work, from, step.line)
    if (moved !== work) { work = moved; movedAny = true }
    else if (n === 0 && place.kind !== 'start' && !alreadyThere(work, from, step)) return { refused: MOVE_NOT_POSSIBLE }
  }
  if (!movedAny) return { refused: MOVE_NOTHING }
  // Where the moved blocks are now, then the marks off.
  const outLines = work.split('\n')
  const movedRanges = blocks.map((_, n) => {
    const line = lineOfMark(n)
    return { line, endLine: 0 }
  })
  for (let i = 0; i < outLines.length; i += 1) outLines[i] = outLines[i].replace(MARK_RE, '')
  const out = outLines.join('\n')
  for (const r of movedRanges) r.endLine = blockAt(out, r.line)?.endLine ?? r.line + 1
  if (out === text) return { refused: MOVE_NOTHING }
  const heads = movedRanges.map((r) => r.line)
  if (capturesSlides(text, out, blocks, heads)) return { refused: MOVE_CAPTURE }
  const before0 = place.kind === 'start' ? startBefore0(text)
    : place.kind === 'before' ? targetLine0
      : (blockAt(text, targetLine0 + 1)?.endLine ?? lines.length + 1) - 1
  if (!isSoundMove(text, out, blocks, before0, heads)) return { refused: MOVE_UNSAFE }
  return { text: out, changes: minimalChange(text, out), movedRanges }
}

const isBlank = (line: string): boolean => /^\s*$/.test(line)

/** A block's own lines: its heading down to its last non-blank line (inner blank lines kept, trailing ones off). */
function ownLines(lines: readonly string[], b: { line: number; endLine: number }): string[] {
  let end0 = Math.min(b.endLine - 1, lines.length)
  while (end0 > b.line && isBlank(lines[end0 - 1])) end0 -= 1
  return lines.slice(b.line - 1, end0)
}

/** 0-based line the moved blocks go before for the place "start": the talk's first slide (end of file if none). */
function startBefore0(text: string): number {
  const at = startOfTalkPlace(text)
  return at !== 'end' && 'before' in at ? at.before - 1 : text.split('\n').length
}

/**
 * Whether a moved block, in `out`, is followed directly (blank lines aside) by a heading deeper than its own that
 * was not part of it: the block would adopt those slides. `heads` are the moved blocks' heading lines in `out`.
 */
function capturesSlides(text: string, out: string, blocks: readonly SlideBlock[], heads: readonly number[]): boolean {
  const lines = text.split('\n')
  const outLines = out.split('\n')
  const outLevels = headingLevelsOfText(out, outLines)
  return blocks.some((b, n) => {
    let i = heads[n] - 1 + ownLines(lines, b).length
    while (i < outLines.length && outLevels[i] === 0) i += 1
    return i < outLines.length && outLevels[i] > b.level
  })
}

/**
 * The soundness check every move passes before it is returned (pure; exported so tests can hand it crafted
 * results). `blocks` are the moved blocks in the ORIGINAL text, talk order; `before0` the 0-based original line the
 * blocks go before; `heads` the blocks' heading lines (1-based) in `out`. True only when:
 *   (0) out has the same lines as text, reordered;
 *   (a+c) out's non-blank lines == the original's non-blank lines outside the blocks, with the blocks' non-blank
 *         lines put in, in talk order, right before the first of them at or after `before0`;
 *   (b) each block's own lines stand unchanged and contiguous at its head in `out`, in talk order, only blank lines
 *       between one block and the next.
 */
export function isSoundMove(text: string, out: string, blocks: ReadonlyArray<{ line: number; endLine: number }>, before0: number, heads: readonly number[]): boolean {
  if (sortedLines(out) !== sortedLines(text)) return false
  if (heads.length !== blocks.length) return false
  const lines = text.split('\n')
  const outLines = out.split('\n')
  const inBlock = (i: number): boolean => blocks.some((b) => i >= b.line - 1 && i < b.endLine - 1)
  const restBefore: string[] = []
  const restAfter: string[] = []
  lines.forEach((l, i) => { if (!isBlank(l) && !inBlock(i)) (i < before0 ? restBefore : restAfter).push(l) })
  const moved = blocks.flatMap((b) => lines.slice(b.line - 1, b.endLine - 1).filter((l) => !isBlank(l)))
  const expected = [...restBefore, ...moved, ...restAfter]
  const got = outLines.filter((l) => !isBlank(l))
  if (expected.length !== got.length || expected.some((l, i) => l !== got[i])) return false
  let prevEnd0 = -1
  for (let n = 0; n < blocks.length; n += 1) {
    const own = ownLines(lines, blocks[n])
    const at0 = heads[n] - 1
    if (at0 < 0 || at0 + own.length > outLines.length) return false
    if (own.some((l, k) => outLines[at0 + k] !== l)) return false
    if (n > 0) {
      if (at0 < prevEnd0) return false
      for (let i = prevEnd0; i < at0; i += 1) if (!isBlank(outLines[i])) return false
    }
    prevEnd0 = at0 + own.length
  }
  return true
}

/** The cut's check: `out`'s non-blank lines, in order, are exactly the original's outside the cut blocks. */
export function isSoundCut(text: string, out: string, blocks: ReadonlyArray<{ line: number; endLine: number }>): boolean {
  const lines = text.split('\n')
  const inBlock = (i: number): boolean => blocks.some((b) => i >= b.line - 1 && i < b.endLine - 1)
  const expected = lines.filter((l, i) => !isBlank(l) && !inBlock(i))
  const got = out.split('\n').filter((l) => !isBlank(l))
  return expected.length === got.length && expected.every((l, i) => l === got[i])
}

/** Whether the block at `from` already sits at `step` (moveBlock answers null then too, as for an impossible move). */
function alreadyThere(text: string, from: number, step: MoveTarget): boolean {
  if (step.kind === 'start' || step.kind === 'end') return true
  const self = blockAt(text, from)
  const other = blockAt(text, step.line)
  if (!self || !other) return false
  if (step.kind === 'before') return self.endLine === step.line
  if (step.kind === 'after') return other.endLine === from
  // into: already the last thing in the section.
  return from > step.line && self.endLine === other.endLine
}

/**
 * The place ⌘↑ / ⌘↓ moves a slide or section to: before the nearest heading of the same level above it, or after
 * the nearest one below its block. Null when there is none.
 */
export function stepPlace(text: string, line: number, dir: 'up' | 'down'): SlidePlace | null {
  const lines = text.split('\n')
  const levels = headingLevelsOfText(text, lines)
  const self = blockAt(text, line)
  if (!self) return null
  if (dir === 'up') {
    for (let i = line - 2; i >= 0; i -= 1) {
      if (levels[i] === self.level) return { kind: 'before', line: i + 1, title: headingTitle(lines[i]) }
    }
    return null
  }
  for (let i = self.endLine - 1; i < lines.length; i += 1) {
    if (levels[i] === self.level) return { kind: 'after', line: i + 1, title: headingTitle(lines[i]) }
  }
  return null
}

/** The ref for the heading on `line` of `text`, or null when that line is not a heading. */
export function refAt(text: string, line: number): SlideRef | null {
  const lines = text.split('\n')
  const levels = headingLevelsOfText(text, lines)
  return levels[line - 1] > 0 ? { line, headingText: lines[line - 1] } : null
}

// ── Cut, copy and delete of several blocks (the batch bar, ⌘X / ⌘C / Delete on a selection) ──

export const CUT_TITLE = 'The talk’s title can’t be cut or deleted.'
export type CutBlocksResult =
  | {
    text: string
    changes: TextChange
    /** The blocks' text in talk order, the format a single-slide cut/copy puts on the clipboard (so paste takes it). */
    clip: string
    /** How many whole blocks went (nested selections count once). */
    count: number
    titles: string[]
  }
  | { refused: string }

/** The outermost blocks named by `refs`, in talk order, or the refusal (a ref that is not the heading it was). */
function outerBlocks(text: string, refs: readonly SlideRef[]): SlideBlock[] | { refused: string } {
  const lines = text.split('\n')
  const levels = headingLevelsOfText(text, lines)
  for (const ref of refs) {
    const i = ref.line - 1
    if (!Number.isInteger(ref.line) || i < 0 || i >= lines.length || !(levels[i] > 0) || !sameHeading(lines[i], levels[i], ref.headingText)) return { refused: MOVE_STALE }
  }
  const blocks: SlideBlock[] = []
  for (const line of [...new Set(refs.map((r) => r.line))].sort((a, b) => a - b)) {
    const b = blockAt(text, line)
    if (!b) return { refused: MOVE_STALE }
    const outer = blocks[blocks.length - 1]
    if (outer && line < outer.endLine) continue
    blocks.push(b)
  }
  return blocks
}

const nonBlank = (text: string): string => text.split('\n').filter((l) => l.trim() !== '').sort().join('\n')

/** Copy: the clip of every named block, talk order. The talk is not changed. */
export function copyBlocks(text: string, refs: readonly SlideRef[]): { clip: string; count: number; titles: string[] } | { refused: string } {
  const blocks = outerBlocks(text, refs)
  if ('refused' in blocks) return blocks
  if (blocks.length === 0) return { refused: MOVE_NOTHING }
  const copies = blocks.map((b) => copyBlock(text, b.line)!)
  return { clip: copies.map((c) => c.clip).join('\n'), count: copies.length, titles: copies.map((c) => c.block.title) }
}

/**
 * Cut (and delete: the caller just does not use `clip`) every block named by `refs`, as one change. Bottom block
 * first, so no block's line moves before it is cut. Refused: a stale ref, the talk's title; nothing is lost
 * (the remaining text and the clip together hold exactly the non-blank lines of the text, checked) and the rest
 * keeps its order (isSoundCut, checked).
 */
export function cutBlocks(text: string, refs: readonly SlideRef[]): CutBlocksResult {
  const blocks = outerBlocks(text, refs)
  if ('refused' in blocks) return blocks
  if (blocks.length === 0) return { refused: MOVE_NOTHING }
  if (blocks.some((b) => b.level === 1)) return { refused: CUT_TITLE }
  const clips = blocks.map((b) => copyBlock(text, b.line)!.clip)
  let work = text
  for (let n = blocks.length - 1; n >= 0; n -= 1) {
    const cut = cutBlock(work, blocks[n].line)
    if (!cut) return { refused: MOVE_STALE }
    work = cut.text
  }
  const clip = clips.join('\n')
  if (nonBlank(work + '\n' + clip) !== nonBlank(text)) return { refused: MOVE_UNSAFE }
  if (!isSoundCut(text, work, blocks)) return { refused: MOVE_UNSAFE }
  return { text: work, changes: minimalChange(text, work), clip, count: blocks.length, titles: blocks.map((b) => b.title) }
}
