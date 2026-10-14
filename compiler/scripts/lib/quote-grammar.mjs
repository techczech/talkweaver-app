// The quote grammar: what is a quotation in a slide's outline lines, and what is its attribution.
//
// ONE definition. The markdown lexer (03-markdown-lexer.mjs) calls takeQuoteBlock, takeParagraph and
// promoteQuotedParagraph to build quote blocks; the editing side's outline reader (quote-forms.mjs) calls
// scanQuotes, which walks lines with the same functions, to find the same blocks and the lines they sit on.
// A change to what counts as a quote or a source is made here, and both sides follow.
//
// Pure: no node: imports, so the renderer can bundle it (the lexer itself pulls in the icon catalogue and cannot
// be bundled). scripts/test-quote-forms.mjs compiles each snippet of a table and reads it with scanQuotes' callers,
// so a construct the walker misses is caught by a test.
import { quoteFromQuotedParagraph, PARAGRAPH_STOP_RE, foldQuoteAttribution, isBareUrl } from './02-triggers-layout.mjs'
import { hasKeyCap } from './00-inline-protection.mjs'
import { parseMarkdownFenceOpeningLine, isMarkdownFenceClosingLine } from './image-line-rules.mjs'
import { chartObjectTokenAt } from './03-object-token.mjs'

/** The dash that leads an in-block attribution (`> — Name`, `> – Name`, `> - Name`, with or without a space). */
export const QUOTE_DASH_LEAD_RE = /^[—–-]\s*/

/**
 * One `>` quotation block starting at `lines[start]`: a contiguous run of `>` lines. A blank `>` line is a paragraph
 * break within the quote; a plain blank line ends it. The last non-empty `>` line, if it leads with a dash, is the
 * citation; otherwise the attribution may follow on its own line (foldQuoteAttribution), unless the block is a
 * practice quote (it carries a key cap). Returns
 * `{ block, start, bodyEnd, end, citeLine, foldedLine }`: `bodyEnd` is the line after the `>` run, `end` the line
 * after anything folded in, `citeLine` the index of an in-block citation line (else -1), `foldedLine` the index of
 * a folded attribution line (else -1).
 */
export function takeQuoteBlock(lines, start) {
  let i = start
  const quoteLines = []
  const lineOf = []
  const breakAfter = new Set()
  while (i < lines.length && lines[i].trim().startsWith('>')) {
    const inner = lines[i].trim().replace(/^>\s?/, '')
    if (inner.trim() === '') {
      if (quoteLines.length) breakAfter.add(quoteLines.length - 1)
    } else {
      quoteLines.push(inner)
      lineOf.push(i)
    }
    i += 1
  }
  const bodyEnd = i
  let cite = ''
  let citeLine = -1
  const lastLine = quoteLines[quoteLines.length - 1] || ''
  const dashCite = QUOTE_DASH_LEAD_RE.test(lastLine)
  if (dashCite) {
    cite = lastLine.replace(QUOTE_DASH_LEAD_RE, '')
    citeLine = lineOf[lineOf.length - 1]
    breakAfter.delete(quoteLines.length - 1)
    quoteLines.pop()
  }
  const paras = []
  let current = []
  quoteLines.forEach((line, index) => {
    current.push(line)
    if (breakAfter.has(index)) { paras.push(current.join(' ').trim()); current = [] }
  })
  if (current.length) paras.push(current.join(' ').trim())
  const paragraphs = paras.filter(Boolean)
  // A `>` block that carries a key cap is a practice quotation, not someone's words (0.38.1 ticket 05).
  const practice = [...paragraphs, cite].some((run) => hasKeyCap(run))
  let foldedLine = -1
  if (!dashCite && !practice) {
    const folded = foldQuoteAttribution(lines, i)
    cite = folded.cite
    if (folded.cite) foldedLine = folded.nextIndex - 1
    i = folded.nextIndex
  }
  const block = { type: 'quote', text: paragraphs.join(' ').trim(), paragraphs, cite, ...(practice ? { practice: true } : {}) }
  return { block, start, bodyEnd, end: i, citeLine, foldedLine }
}

/** The lines of the paragraph that starts at `lines[start]`: up to a blank line or a line that opens another block. */
export function takeParagraph(lines, start) {
  const parts = []
  let i = start
  while (i < lines.length && lines[i].trim() && !PARAGRAPH_STOP_RE.test(lines[i].trim())) {
    parts.push(lines[i].trim())
    i += 1
  }
  return { parts, end: i }
}

/**
 * A paragraph that is wholly a double-quoted statement is a quote block. Its attribution is the dash or parenthetical
 * tail on the paragraph, else the line foldQuoteAttribution folds after it (`end` is the paragraph's end index).
 * Returns `{ block, end, foldedLine }` (`end` past anything folded), or null when the paragraph is not a quotation.
 */
export function promoteQuotedParagraph(paraText, lines, end) {
  const promoted = quoteFromQuotedParagraph(paraText)
  if (!promoted) return null
  let cite = promoted.cite
  let foldedLine = -1
  let next = end
  if (!cite) {
    const folded = foldQuoteAttribution(lines, end)
    cite = folded.cite
    if (folded.cite) foldedLine = folded.nextIndex - 1
    next = folded.nextIndex
  }
  return { block: { type: 'quote', text: promoted.text, paragraphs: [promoted.text], cite }, end: next, foldedLine }
}

const ACTION_RE_A = /^\[Action:\s*(.+?)\s*(?:→|->)\s*(\S+?)\]$/i
const ACTION_RE_B = /^\[Action:\s*(.+?)\]\((\S+?)\)$/i
const QR_RE = /^\[QR:\s*([^\]|]+?)\s*(?:\|\s*(.+?)\s*)?\]$/i

/**
 * Every quotation block in the lines, in order, as the lexer finds them. Each entry is
 * `{ kind: 'block' | 'promoted', block, start, bodyEnd, end, citeLine, foldedLine }`; for `promoted`, `start` is the
 * paragraph's first line, `bodyEnd` its end, and `citeLine` is -1 (a tail source sits inside the paragraph's own text).
 * Only the lexer constructs that take whole lines out of reach of a quotation are followed: fenced code and the
 * one-line directives; every other line either starts a `>` block, starts a paragraph, or is a line the lexer skips.
 */
export function scanQuotes(lines) {
  const found = []
  let i = 0
  while (i < lines.length) {
    const t = lines[i].trim()
    if (!t) { i += 1; continue }
    const fence = parseMarkdownFenceOpeningLine(t)
    if (fence) {
      i += 1
      while (i < lines.length && !isMarkdownFenceClosingLine(lines[i], fence)) i += 1
      if (i < lines.length) i += 1
      continue
    }
    const chart = chartObjectTokenAt(lines, i)
    if (chart) { i = chart.listStart; continue }
    if (ACTION_RE_A.test(t) || ACTION_RE_B.test(t) || QR_RE.test(t)) { i += 1; continue }
    if (t.startsWith('>')) {
      const taken = takeQuoteBlock(lines, i)
      found.push({ kind: 'block', ...taken })
      i = taken.end
      continue
    }
    const paragraph = takeParagraph(lines, i)
    if (!paragraph.parts.length) { i += 1; continue }
    const text = paragraph.parts.join(' ')
    if (!isBareUrl(text)) {
      const promoted = promoteQuotedParagraph(text, lines, paragraph.end)
      if (promoted) {
        found.push({ kind: 'promoted', block: promoted.block, start: i, bodyEnd: paragraph.end, end: promoted.end, citeLine: -1, foldedLine: promoted.foldedLine })
        i = promoted.end
        continue
      }
    }
    i = paragraph.end
  }
  return found
}
