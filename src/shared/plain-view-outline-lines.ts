// Plain view, ticket 07 (ninth review): the ONE answer to "which lines of this document does the
// compiler read as outline structure, and which lie inside something it skips". Every plain-view
// scanner reads it: the hidden-text structure pass (plainView/hiddenLines.ts), the icon reader for
// titles, paragraphs and list items (iconPictures.ts), the placeholders, the margin (margin.ts and
// plain-view-margin.ts). Pure: no DOM, no CodeMirror.
//
// It is the compiler's reading, made with the compiler's own code where that code is a function:
//   front matter   adaptMarkdownOutlineV2 (08-source-adapters.mjs): the text starts with `---` and
//                  a later line starts with `---`; the block is blanked, its newlines kept. Read
//                  through outlineCompilerBody (slide-source-text.ts), the shared copy of that split.
//   HTML comments  blankHtmlComments (html-comments.mjs, imported): every closed `<!-- … -->` has
//                  its characters removed BEFORE any structure is read, so a fence marker or a
//                  heading inside a comment is nothing, and a comment inside a fence is blanked too.
//                  An unclosed `<!--` is text.
//   fenced code    parseMarkdownFenceOpeningLine, isMarkdownFenceClosingLine (image-line-rules.mjs
//                  through 03-object-token.mjs, imported), used as parseOutlineTree uses them
//                  (14-outline-tree.mjs):
//                    - the marker is three or more backticks, or three or more tildes, after any
//                      indentation (the line is trimmed: a fence inside a list item is a fence);
//                    - anything after the marker on the opening line is the info string;
//                    - the closing line is the same character, at least as many of them as the
//                      opening has, and nothing else but whitespace;
//                    - a fence that is never closed runs to the end of the DOCUMENT: a heading line
//                      does not end it, neither does the end of a slide.
//   notes          `:::notes` (any case, trimmed) to the next `:::` line; both marker lines are
//                  notes. A `##`–`######` heading the compiler recognises ends an unclosed notes
//                  block and is a heading; a `#` line inside one is the talk title and does not
//                  end it. A fence opened inside notes is a fence (its `:::` lines close nothing).
// The loop over the lines (fence, then heading, then notes) is this file's, in parseOutlineTree's
// order; scripts/test-plain-view-outline-lines-parity.mjs holds it to parseOutlineTree and to the
// compiled slides, line by line, on scripts/fixtures/plain-view-outline-regions.json.
//
// A fence written straight under a paragraph line (no blank line between) is where the compiler has
// two readings: its outline tree reads fenced code, its content lexer reads paragraph text. This
// file gives the tree's reading (`kinds`). What a slide's content IS, line by line, is the lexer's
// answer, and Plain takes it from the lexer itself (plain-view-compiler-facts.ts), not from here.
import { blankHtmlComments } from '../../compiler/scripts/lib/html-comments.mjs'
import { isMarkdownFenceClosingLine, parseMarkdownFenceOpeningLine, type MarkdownFenceOpening } from '../../compiler/scripts/lib/03-object-token.mjs'
import { headingLine, type HeadingLine } from './plain-view-heading-line.ts'
import { headingBraceGroups } from './plain-view-icon-tokens.ts'
import { outlineCompilerBody } from './slide-source-text.ts'
import { memoByText } from './memo-by-text.ts'

/**
 * `outline`: the compiler reads the line as outline structure or slide content.
 * `frontmatter`, `fence`, `notes`: the line is in that region (its marker lines included).
 * `comment`: every character of the line that is not whitespace is inside an HTML comment.
 */
export type OutlineLineKind = 'outline' | 'frontmatter' | 'comment' | 'fence' | 'notes'

export interface OutlineLines {
  /** One per line of the text (split on `\n`), 0-based. */
  kinds: readonly OutlineLineKind[]
  /**
   * An `outline` line some of whose characters are inside an HTML comment: the compiler reads
   * fewer characters than are written, so Plain hides and protects nothing on it.
   */
  partial: readonly boolean[]
  /** The compiler's own heading test (`#` title or `##`–`######`) on the line as it reads it. */
  compilerHeading: readonly boolean[]
  /**
   * A `partial` heading line whose trailing `{…}` groups, and everything from the end of the
   * title's text on, the compiler reads exactly as written (the comment is earlier in the line:
   * `### Alpha <!-- note --> beta {reveal}`). Its tail is hidden and protected as any title's.
   */
  tailAsWritten: readonly boolean[]
  /** How many lines at the top are the front matter (0 when there is none). */
  frontmatterLines: number
}

const TITLE_RE = /^#\s+(.+)/
const NODE_RE = /^(#{2,6})\s+(.+)/

/** The trailing groups of a heading line with a comment in it are the ones the compiler reads, character for character. */
function tailReadAsWritten(written: string, read: string): boolean {
  const mark = headingLine(written)
  const markRead = headingLine(read)
  if (!mark || !markRead || mark.textFrom !== markRead.textFrom) return false
  const shift = written.length - read.length
  const groups = headingBraceGroups(written).filter((g) => g.start >= mark.textFrom)
  const groupsRead = headingBraceGroups(read).filter((g) => g.start >= markRead.textFrom)
  if (!groups.length || groups.length !== groupsRead.length) return false
  if (!groups.every((g, k) => g.start - shift === groupsRead[k].start && g.end - shift === groupsRead[k].end && g.inner === groupsRead[k].inner && g.authored === groupsRead[k].authored)) return false
  // From the whitespace before the first group to the end of the line, nothing is a comment's.
  let from = groups[0].start
  while (from > mark.textFrom && /\s/.test(written[from - 1])) from -= 1
  return from - shift >= markRead.textFrom && written.slice(from) === read.slice(from - shift)
}

export function readOutlineLines(text: string): OutlineLines {
  const raw = text.split('\n')
  const { body, fmEnd, newlines } = outlineCompilerBody(text, blankHtmlComments)
  const read = body.split('\n')
  const frontmatterLines = fmEnd > 0 ? newlines + 1 : 0
  const kinds: OutlineLineKind[] = new Array(raw.length)
  const partial: boolean[] = new Array(raw.length).fill(false)
  const compilerHeading: boolean[] = new Array(raw.length).fill(false)
  const tailAsWritten: boolean[] = new Array(raw.length).fill(false)
  let fence: MarkdownFenceOpening | null = null
  let inNotes = false
  for (let i = 0; i < raw.length; i += 1) {
    if (i < frontmatterLines) { kinds[i] = 'frontmatter'; continue }
    const line = (read[i] ?? '').replace(/\r$/, '')
    const touched = line.length !== raw[i].replace(/\r$/, '').length
    const blanked = touched && line.trim() === ''
    if (fence) {
      kinds[i] = blanked ? 'comment' : 'fence'
      if (isMarkdownFenceClosingLine(line, fence)) fence = null
      continue
    }
    const open = parseMarkdownFenceOpeningLine(line)
    if (open) {
      kinds[i] = 'fence'; fence = open
      continue
    }
    if (blanked) { kinds[i] = 'comment'; continue }
    // The talk's title is no slide's content: the lexer never sees it.
    if (TITLE_RE.test(line) && !line.startsWith('##')) {
      kinds[i] = 'outline'; compilerHeading[i] = true; partial[i] = touched
      tailAsWritten[i] = touched && tailReadAsWritten(raw[i].replace(/\r$/, ''), line)
      continue
    }
    if (NODE_RE.test(line)) {
      inNotes = false
      kinds[i] = 'outline'; compilerHeading[i] = true; partial[i] = touched
      tailAsWritten[i] = touched && tailReadAsWritten(raw[i].replace(/\r$/, ''), line)
      continue
    }
    const t = line.trim()
    if (t.toLowerCase() === ':::notes') { inNotes = true; kinds[i] = 'notes'; continue }
    if (t === ':::' && inNotes) { inNotes = false; kinds[i] = 'notes'; continue }
    if (inNotes) { kinds[i] = 'notes'; continue }
    kinds[i] = 'outline'
    partial[i] = touched
  }
  return { kinds, partial, compilerHeading, tailAsWritten, frontmatterLines }
}

/** A reading in which no line is outline: Plain hides, protects and labels nothing (the fail-open answer when the compiler's reading throws). */
export function emptyOutlineLines(text: string): OutlineLines {
  let n = 1
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n += 1
  const none: boolean[] = new Array<boolean>(n).fill(false)
  return { kinds: new Array<OutlineLineKind>(n).fill('comment'), partial: none, compilerHeading: none, tailAsWritten: none, frontmatterLines: 0 }
}

/** A line Plain may hide or protect: outline, read whole by the compiler. */
export function isStructureLine(read: OutlineLines, index: number): boolean {
  return read.kinds[index] === 'outline' && !read.partial[index]
}

/**
 * A heading line whose trailing `{…}` groups Plain may hide and protect: a line read whole, or one
 * with a comment before the end of the title's text (`tailAsWritten`).
 */
export function isHeadingTailLine(read: OutlineLines, index: number): boolean {
  return read.kinds[index] === 'outline' && (!read.partial[index] || read.tailAsWritten[index])
}

/** A line the compiler reads as outline (whole, or what a comment leaves of it). */
export function isOutlineLine(read: OutlineLines, index: number): boolean {
  return read.kinds[index] === 'outline'
}

/**
 * The heading on line `index` (0-based), whose text is `text`: the plain view's one reader of
 * heading lines (plain-view-heading-line.ts) on a line the compiler reads as outline. A line with
 * a comment in it is a heading only when the compiler also reads one there.
 */
export function outlineHeading(read: OutlineLines, index: number, text: string): HeadingLine | null {
  if (read.kinds[index] !== 'outline') return null
  if (read.partial[index] && !read.compilerHeading[index]) return null
  return headingLine(text)
}

/** `readOutlineLines` of a text, computed once per text (memo-by-text.ts). The answer is shared: no reader changes it. */
export const readOutlineLinesOf: (text: string) => OutlineLines = memoByText((text) => readOutlineLines(text))
