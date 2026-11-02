// The regions of an outline the object cards are built from (ADR-0042 and its notes/comments addendum):
// fenced blocks, speaker-notes blocks and closed HTML comments, read as the compiler reads them.
//
// It is the reading of shared/plain-view-outline-lines.ts (front matter blanked, closed comments blanked
// before any structure, fences by the compiler's marker rules, notes by the exact `:::notes` rule), made
// in one pass that also keeps the EXTENTS the cards need: where each fence and notes block starts and
// ends, whether it is closed, and which container each comment sits in.
// scripts/test-outline-object-regions.mjs holds its line kinds to readOutlineLines.
// Pure: no DOM, no CodeMirror.
import { blankHtmlComments } from '../../../compiler/scripts/lib/html-comments.mjs'
import {
  isMarkdownFenceClosingLine,
  parseMarkdownFenceOpeningLine,
  type MarkdownFenceOpening
} from '../../../compiler/scripts/lib/03-object-token.mjs'
import {
  closedHtmlComments,
  isNotesCloseLine,
  isNotesOpenLine
} from '../../../compiler/scripts/lib/outline-regions.mjs'
import { outlineCompilerBody } from '../slide-source-text.ts'

export type RegionLineKind = 'outline' | 'frontmatter' | 'comment' | 'fence' | 'notes'

export interface FenceExtent {
  /** Opening marker line (0-based). */
  start: number
  /** Closing marker line, or the line count when unclosed. */
  bodyEnd: number
  /** One past the last line of the fence. */
  end: number
  closed: boolean
  opening: MarkdownFenceOpening
  /** The opening line as the compiler reads it (closed comments blanked), without its CR. */
  line: string
  /** The fence lies inside a speaker-notes block: it is notes body, never a card. */
  inNotes: boolean
}

export interface NotesExtent {
  /** The `:::notes` line. */
  start: number
  /** The closing `:::` line, or -1 when the block is never closed. */
  close: number
  /** One past the last notes line (the heading that ended an unclosed block, or the line count). */
  end: number
  closed: boolean
}

export interface CommentExtent {
  from: number
  to: number
  startLine: number
  endLine: number
  /** Where the comment starts: an ordinary outline line, or inside a fence, notes or the front matter. */
  container: 'outline' | 'fence' | 'notes' | 'frontmatter'
  /** Nothing but whitespace before `<!--` on its first line and after `-->` on its last. */
  standalone: boolean
}

export interface UnclosedComment {
  from: number
  line: number
}

export interface OutlineObjectRegions {
  /** One per line (split on `\n`), the plain-view reading. */
  kinds: RegionLineKind[]
  /** Line start offsets; `lineStarts[lines]` is the text length + 1. */
  lineStarts: number[]
  frontmatterLines: number
  fences: FenceExtent[]
  notes: NotesExtent[]
  comments: CommentExtent[]
  /** A `<!--` with no later `-->`: text to the compiler. */
  unclosedComments: UnclosedComment[]
  /** Lines inside a fence (markers included) or a notes block (markers included). */
  inFence: boolean[]
  inNotes: boolean[]
}

export function readOutlineObjectRegions(text: string): OutlineObjectRegions {
  const raw = text.split('\n')
  const lineStarts: number[] = new Array(raw.length + 1)
  let offset = 0
  for (let i = 0; i < raw.length; i += 1) {
    lineStarts[i] = offset
    offset += raw[i].length + 1
  }
  lineStarts[raw.length] = offset
  const { body, fmEnd, newlines } = outlineCompilerBody(text, blankHtmlComments)
  const read = body.split('\n')
  const frontmatterLines = fmEnd > 0 ? newlines + 1 : 0
  const kinds: RegionLineKind[] = new Array(raw.length)
  const inFence: boolean[] = new Array(raw.length).fill(false)
  const inNotes: boolean[] = new Array(raw.length).fill(false)
  const fences: FenceExtent[] = []
  const notes: NotesExtent[] = []
  let fence: { opening: MarkdownFenceOpening; start: number; inNotes: boolean; line: string } | null = null
  let note: { start: number } | null = null
  for (let i = 0; i < raw.length; i += 1) {
    if (i < frontmatterLines) { kinds[i] = 'frontmatter'; continue }
    const line = (read[i] ?? '').replace(/\r$/, '')
    const touched = line.length !== raw[i].replace(/\r$/, '').length
    const blanked = touched && line.trim() === ''
    if (note) inNotes[i] = true
    if (fence) {
      inFence[i] = true
      kinds[i] = blanked ? 'comment' : 'fence'
      if (isMarkdownFenceClosingLine(line, fence.opening)) {
        fences.push({ start: fence.start, bodyEnd: i, end: i + 1, closed: true, opening: fence.opening, line: fence.line, inNotes: fence.inNotes })
        fence = null
      }
      continue
    }
    const open = parseMarkdownFenceOpeningLine(line)
    if (open) {
      kinds[i] = 'fence'
      inFence[i] = true
      fence = { opening: open, start: i, inNotes: note !== null, line }
      continue
    }
    if (blanked) { kinds[i] = 'comment'; continue }
    if (/^#\s+(.+)/.test(line) && !line.startsWith('##')) { kinds[i] = 'outline'; continue }
    // The compiler's NODE_RE (plain-view-outline-lines.ts): a heading ends an unclosed notes block.
    if (/^(#{2,6})\s+(.+)/.test(line)) {
      if (note) {
        inNotes[i] = false
        notes.push({ start: note.start, close: -1, end: i, closed: false })
        note = null
      }
      kinds[i] = 'outline'
      continue
    }
    if (isNotesOpenLine(line) && !note) { note = { start: i }; inNotes[i] = true; kinds[i] = 'notes'; continue }
    if (isNotesOpenLine(line) && note) { kinds[i] = 'notes'; continue }
    if (note && isNotesCloseLine(line)) {
      notes.push({ start: note.start, close: i, end: i + 1, closed: true })
      note = null
      kinds[i] = 'notes'
      continue
    }
    kinds[i] = note ? 'notes' : 'outline'
  }
  if (fence) {
    fences.push({ start: fence.start, bodyEnd: raw.length, end: raw.length, closed: false, opening: fence.opening, line: fence.line, inNotes: fence.inNotes })
  }
  if (note) notes.push({ start: note.start, close: -1, end: raw.length, closed: false })

  const lineOf = (pos: number): number => {
    let lo = 0
    let hi = raw.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= pos) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const comments: CommentExtent[] = []
  // Comments of the body only: the front matter is its own region and is blanked separately.
  const bodyOffset = fmEnd
  for (const found of closedHtmlComments(text.slice(bodyOffset))) {
    const from = found.from + bodyOffset
    const to = found.to + bodyOffset
    const startLine = lineOf(from)
    const endLine = lineOf(Math.max(from, to - 1))
    const container = startLine < frontmatterLines
      ? 'frontmatter'
      : inFence[startLine] ? 'fence' : inNotes[startLine] ? 'notes' : 'outline'
    const before = text.slice(lineStarts[startLine], from)
    const lineEnd = lineStarts[endLine] + raw[endLine].length
    const after = text.slice(to, lineEnd)
    comments.push({ from, to, startLine, endLine, container, standalone: before.trim() === '' && after.trim() === '' })
  }
  const unclosedComments: UnclosedComment[] = []
  const lastClose = comments.length ? comments[comments.length - 1].to : bodyOffset
  const stray = text.indexOf('<!--', lastClose)
  if (stray >= 0) unclosedComments.push({ from: stray, line: lineOf(stray) })
  return { kinds, lineStarts, frontmatterLines, fences, notes, comments, unclosedComments, inFence, inNotes }
}
