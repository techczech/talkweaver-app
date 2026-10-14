// Plain view, ticket 07 (eleventh round): the icon items of a document, as a MAPPING of the
// compiler's answer. Pure: no DOM, no CodeMirror.
//
//   paragraphs and list items   plain-view-compiler-facts.ts: the lexer's own blocks say which
//                               paragraph and which list row had a trailing icon token stripped,
//                               and on which line. This file only finds that token's characters
//                               on that line, with the compiler's own token readers
//                               (paragraphIconTokenAt, listItemIconTokenAt). It has no test of
//                               its own for what a paragraph, a list item, a continuation line, a
//                               directive, an attribution or a Trigger line is.
//   headings                    plain-view-outline-lines.ts (which lines are headings for the
//                               compiler) and the ports of the compiler's heading-group readers
//                               (plain-view-icon-tokens.ts, plain-view-heading-tail.ts).
//
// Fail open: an item is made only when the token's characters are exactly the end of the source
// line. When they are not (an HTML comment removed characters from the line, or the token is
// broken over two lines of a paragraph), there is no item and the token shows as text.
import { listItemIconTokenAt, paragraphIconTokenAt } from '../../compiler/scripts/lib/03-markdown-lexer-core.mjs'
import { compilerFacts, compilerFactsOf, editorIconKey, type CompilerFacts, type IconKeyNormaliser } from './plain-view-compiler-facts.ts'
import { headingLine } from './plain-view-heading-line.ts'
import { headingTail } from './plain-view-heading-tail.ts'
import { headingIcon } from './plain-view-icon-tokens.ts'
import { emptyOutlineLines, isHeadingTailLine, readOutlineLinesOf, type OutlineLines } from './plain-view-outline-lines.ts'
import { memoByText } from './memo-by-text.ts'

export interface TokenSpan { from: number; tokenFrom: number; to: number }

export interface IconItem {
  /** What carries the icon. A list item's picture replaces its mark; a heading's and a paragraph's is put in at `textFrom`. */
  kind: 'item' | 'heading' | 'paragraph'
  /** Start of the item's line (a paragraph: of its first line). */
  lineFrom: number
  /** Where the item's text starts (after the mark and its spaces; a paragraph: the start of its first line). */
  textFrom: number
  /**
   * The stretch the caret reveals: from the end of the visible text (`textEnd`) to the end of the
   * last token (a list item's and a paragraph's token runs to the end of the line).
   */
  from: number
  to: number
  /**
   * The end of the visible text, before the ONE space that separates it from the token (when
   * several are written, the others stay with the text, as in a title).
   */
  textEnd: number
  /** The first token's `{` (where its chip starts). */
  tokenFrom: number
  /**
   * Each hidden token: `from` (the whitespace before `{`), `tokenFrom` (`{`), `to`. One for a list
   * item and a paragraph; a heading has one per group that holds an icon token.
   */
  spans: readonly TokenSpan[]
  key: string
  ordered: boolean
  /** The number as typed (`1.`), for an ordered item. */
  number: string
  indent: number
  /** A list row under another row: the compiler strips its token and draws no icon. */
  nested: boolean
  /** The mark's start (for the bullet in listMarks to stand down). */
  markFrom: number
}

export interface PlainViewFacts {
  read: OutlineLines
  compiler: CompilerFacts
  items: IconItem[]
  /** Tokens the compiler strips that could not be found whole at the end of their line (no item). */
  unlocated: Array<{ line: number; reason: 'comment' | 'split' }>
}

/** Facts for a document the compiler's reading threw on: nothing hidden, protected or drawn. */
export function emptyPlainViewFacts(text: string): PlainViewFacts {
  return {
    read: emptyOutlineLines(text),
    compiler: { bodyLines: text.split('\n'), layoutLines: new Set(), layoutLineHeading: new Map(), iconTokens: [], codeLines: new Set(), slideLayouts: new Map(), lexedBlocks: () => [], slideContent: () => '', outsideSlide: () => '' },
    items: [],
    unlocated: []
  }
}

const base = { ordered: false, number: '', indent: 0, nested: false }

/** The end of the visible text before a token: one separating space is the token's, the rest is text. */
function textEndBefore(spaceFrom: number, tokenFrom: number): number {
  return spaceFrom < tokenFrom ? tokenFrom - 1 : tokenFrom
}

/** A heading's icon: every authored group that holds an icon token is a hidden span; the last token is the picture. */
function headingIconItem(lineFrom: number, text: string): IconItem | null {
  const h = headingLine(text)
  if (!h || h.empty) return null
  const icon = headingIcon(text)
  if (!icon.key || !icon.groups.length) return null
  const textStart = h.textFrom
  let floor = textStart
  const spans = icon.groups.map((group) => {
    let from = group.start
    while (from > floor && /\s/.test(text[from - 1])) from -= 1
    floor = group.end
    return { from: lineFrom + from, tokenFrom: lineFrom + group.start, to: lineFrom + group.end }
  })
  // The chip shows from the end of the title's visible text (headingTail's, the one end for all
  // the line's hidden groups), also when other groups are written before the icon's.
  const textEnd = headingTail(lineFrom, text)?.textEnd ?? spans[0].from
  return {
    ...base, kind: 'heading', lineFrom, markFrom: lineFrom,
    textFrom: lineFrom + textStart,
    from: Math.min(spans[0].from, textEnd), tokenFrom: spans[0].tokenFrom, to: spans[spans.length - 1].to, textEnd, spans, key: icon.key
  }
}

/**
 * Every plain-view fact of a document in one pass: the outline lines, the compiler's facts and the
 * icon items. `normalise` is the editor's (the default) everywhere but in a test.
 */
export function plainViewFacts(text: string, normalise: IconKeyNormaliser = editorIconKey): PlainViewFacts {
  // The outline lines and, with the editor's normaliser, the compiler's facts are the ones every
  // other reader of this text has (memo-by-text.ts): one computation per text.
  const read = readOutlineLinesOf(text)
  const compiler = normalise === editorIconKey ? compilerFactsOf(text) : compilerFacts(text, normalise)
  const lines = text.split('\n')
  const starts: number[] = new Array(lines.length)
  for (let i = 0, at = 0; i < lines.length; i += 1) { starts[i] = at; at += lines[i].length + 1 }
  const items: IconItem[] = []
  const unlocated: PlainViewFacts['unlocated'] = []

  // The talk's title is the LAST `#` line the compiler reads (it takes one inside speaker notes
  // too), and only that line's icon is the title's.
  let titleLine = -1
  lines.forEach((written, i) => { if (read.compilerHeading[i] && /^#\s/.test(written)) titleLine = i })
  lines.forEach((written, i) => {
    if (!read.compilerHeading[i] || !isHeadingTailLine(read, i)) return
    if (/^#\s/.test(written) && i !== titleLine) return
    const title = headingIconItem(starts[i], written.replace(/\r$/, ''))
    if (title) items.push(title)
  })

  for (const token of compiler.iconTokens) {
    const i = token.line
    const text0 = (lines[i] ?? '').replace(/\r$/, '')
    const lineFrom = starts[i]
    // The compiler read fewer characters than are written on the line: the token is not located.
    if (text0 !== compiler.bodyLines[i]) { unlocated.push({ line: i, reason: 'comment' }); continue }
    if (token.kind === 'paragraph') {
      const at = paragraphIconTokenAt(text0)
      if (!at || at.key !== token.key) { unlocated.push({ line: i, reason: 'split' }); continue }
      const first = starts[token.firstLine]
      const firstText = lines[token.firstLine]
      const from = textEndBefore(lineFrom + at.from, lineFrom + at.tokenFrom)
      const span = { from, tokenFrom: lineFrom + at.tokenFrom, to: lineFrom + text0.length }
      items.push({
        ...base, kind: 'paragraph', lineFrom: first, markFrom: first,
        textFrom: first + (firstText.length - firstText.trimStart().length),
        ...span, textEnd: from, spans: [span], key: token.key.trim()
      })
      continue
    }
    const textFromOff = token.indentLength + token.markLength
    const content = text0.slice(textFromOff)
    const at = listItemIconTokenAt(content, normalise)
    if (!at || at.key !== token.key) { unlocated.push({ line: i, reason: 'split' }); continue }
    const spaceFrom = lineFrom + textFromOff + at.index
    const tokenFrom = lineFrom + textFromOff + content.indexOf('{', at.index)
    const from = textEndBefore(spaceFrom, tokenFrom)
    const indent = text0.slice(0, token.indentLength).replace(/\t/g, '    ').length
    items.push({
      kind: 'item', lineFrom, textFrom: lineFrom + textFromOff,
      from, to: lineFrom + text0.length, tokenFrom, textEnd: from,
      spans: [{ from, tokenFrom, to: lineFrom + text0.length }],
      key: token.key.trim(), ordered: token.ordered,
      number: token.ordered ? text0.slice(token.indentLength, textFromOff).trim() : '',
      indent, nested: !token.top, markFrom: lineFrom + token.indentLength
    })
  }
  items.sort((a, b) => a.to - b.to)
  return { read, compiler, items, unlocated }
}

/**
 * `plainViewFacts` of a text with the editor's normaliser, computed once per text (memo-by-text.ts):
 * the editor (by its document, extensions/plainView/outlineLines.ts) and the icon verbs (the text
 * before an edit and the text after it) read one computation. Throws what `plainViewFacts` throws.
 */
export const plainViewFactsOf: (text: string) => PlainViewFacts = memoByText((text) => plainViewFacts(text))
