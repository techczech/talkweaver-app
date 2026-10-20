// Which lines of a talk are headings, and at what level (pure). THE ONE ANSWER for every function
// that works out a slide's block: slideBlockOps.ts, slideOutline.ts, headingEndInsert.ts,
// outliner.ts, talk-title.ts and grid-reorder.ts all read it here.
//
// A heading is a line matching /^#{1,6}\s/ that the compiler would also read as structure:
//   - not in the YAML frontmatter (a leading `---` line down to the next `---` line);
//   - not inside a code fence, by the compiler's own scan (scanFencedLines in
//     compiler/scripts/lib/03-object-token.mjs, the one 12-outline-edit.mjs and the outline tree
//     follow): ``` and ~~~ openers of three or more, closed by a line of the same character at
//     least as long with nothing after it; an unclosed fence runs to the end of the text; the two
//     marker lines are not headings either;
//   - not on a line that starts inside an HTML comment (`<!--` … `-->`): the compiler blanks
//     comments before it reads headings.
// So a `# install` line in a fenced shell snippet is never a heading, a slide's block never ends
// inside its own code, and the Slide outline lists exactly the headings the compiler makes slides
// or sections of. (One difference kept on purpose: the compiler wants text after the marker,
// /^#{1,6}\s+\S/; the editor also counts a heading that is still empty, as it always has.)
//
// COST: headingLevels is one pass over the lines (the fence scan is one pass too). Callers work
// out the whole map once per text and then index it; nothing here is asked per line.
// headingLevelsOfText keeps the map of the last text it saw, so the chains that hand the same text
// from function to function (caretPastePlace → headingLineAt, cutBlock → blockAt) scan it once.
// scripts/test-slide-block-ops.mjs tests this file.
import { scanFencedLines } from '../../compiler/scripts/lib/03-object-token.mjs'

const HEADING_MARK_RE = /^(#{1,6})\s/

/** The level a line's heading marker gives it (1–6), 0 when it has none. The line alone: whether it
 *  IS a heading depends on the lines above it (headingLevels). */
export function headingMarkLevel(line: string | undefined): number {
  const m = line != null ? HEADING_MARK_RE.exec(line) : null
  return m ? m[1].length : 0
}

/** 0-based index of the closing `---` of the YAML frontmatter, or -1 when there is none. */
export function frontmatterEndIndex(lines: readonly string[]): number {
  if ((lines[0] ?? '').trim() !== '---') return -1
  for (let i = 1; i < lines.length; i += 1) if (lines[i].trim() === '---') return i
  return -1
}

/** For each line: its heading level (1–6), or 0 when it is not a heading. One pass. */
export function headingLevels(lines: readonly string[]): number[] {
  const levels = new Array<number>(lines.length).fill(0)
  const body0 = frontmatterEndIndex(lines) + 1
  let marked = false
  for (let i = body0; i < lines.length; i += 1) {
    const level = headingMarkLevel(lines[i])
    if (level > 0) { levels[i] = level; marked = true }
  }
  if (!marked) return levels
  // The frontmatter is not part of the scan: the compiler blanks it before it looks for fences.
  const flags = scanFencedLines(body0 === 0 ? lines : lines.slice(body0)).flags
  for (let i = body0; i < lines.length; i += 1) if (levels[i] > 0 && flags[i - body0]) levels[i] = 0
  return levels
}

let lastText: string | null = null
let lastLevels: readonly number[] = []

/**
 * headingLevels(text.split('\n')), kept for the last text asked about. `lines` is that split when
 * the caller already has it. The result is shared: do not write to it.
 */
export function headingLevelsOfText(text: string, lines?: readonly string[]): readonly number[] {
  if (text !== lastText) {
    lastLevels = headingLevels(lines ?? text.split('\n'))
    lastText = text
  }
  return lastLevels
}
