// Plain view, ticket 02 (spec T4, T4a): Markdown marks are replaced by nothing unless the caret or
// selection is inside the element they belong to. Same mechanism as WriteFlex's clean mode
// (re-implemented, not imported): the syntax tree names the elements, one decoration set replaces
// their marks. The replacements are NOT atomic: an atomic hidden mark lets the DOM selection sync
// shorten a selection at the hidden mark, and entering an element reveals all its marks anyway.
//
// What this adds besides concealment: the faint `#` marks on the caret's heading, the quotation
// lines (rule on the left, text style) with the attribution line, the link text look, and the
// shown/hidden state of TalkWeaver's own `==`, `~~`, `++` marks (inlineMark.ts keeps their styling).
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import type { Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { inlineMarkRanges } from '../inlineMark'
import { HEADING_STEPS } from './theme'

interface Span { from: number; to: number }
interface Element extends Span {
  markers: Span[]
  /** Heading depth (1-6) for the faint marks shown on the caret's heading. */
  headingLevel?: number
  /** Link: the `(address)` part, set in the code font when shown. */
  address?: Span
}

const INLINE_MARK_NAMES: Record<string, string> = {
  StrongEmphasis: 'EmphasisMark', Emphasis: 'EmphasisMark', Strikethrough: 'StrikethroughMark', InlineCode: 'CodeMark'
}

const hidden = Decoration.replace({})
const shownMark = Decoration.mark({ class: 'cm-plain-mark-shown' })
const addressMark = Decoration.mark({ class: 'cm-plain-link-address' })
const linkText = Decoration.mark({ class: 'cm-plain-link' })
const quoteLine = Decoration.line({ class: 'cm-plain-quote' })
const citeLine = Decoration.line({ class: 'cm-plain-quote-cite' })
const headingMark = (level: number) => Decoration.mark({ class: `cm-plain-hmark cm-plain-hmark-${level}` })

/** The compiler's rule (03-markdown-lexer.mjs): the last non-empty `>` line, if it starts with a dash. */
export function isAttributionText(inner: string): boolean {
  return /^[—–-]/.test(inner)
}

/** The `>` marks of one quotation: children of the Blockquote, or of the paragraph inside it (later lines). */
function quoteMarks(node: SyntaxNode): SyntaxNode[] {
  const found: SyntaxNode[] = []
  const walk = (n: SyntaxNode): void => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.name === 'QuoteMark') found.push(c)
      else if (c.name !== 'Blockquote') walk(c)
    }
  }
  walk(node)
  return found
}

function trailingSpace(doc: { sliceString(a: number, b: number): string; length: number }, span: Span): Span {
  let to = span.to
  while (to < doc.length && doc.sliceString(to, to + 1) === ' ') to += 1
  return { from: span.from, to }
}

/** A selection range touches an element: a caret on either boundary, or any overlap of text. */
function revealed(el: Span, ranges: readonly { from: number; to: number; empty: boolean; head: number }[]): boolean {
  return ranges.some((r) => r.empty ? r.head >= el.from && r.head <= el.to : r.from < el.to && r.to > el.from)
}

function build(view: EditorView): DecorationSet {
  const state = view.state
  const doc = state.doc
  const tree = syntaxTree(state)
  const out: Range<Decoration>[] = []
  const seenMarker = new Set<string>()
  const seenLine = new Set<number>()
  const fenced: Span[] = []
  const elements: Element[] = []

  // Whole lines, merged: a construct is never clipped at the viewport edge.
  const regions: Span[] = []
  for (const r of view.visibleRanges) {
    const from = doc.lineAt(r.from).from
    const to = doc.lineAt(Math.max(r.from, r.to - 1)).to
    const last = regions.at(-1)
    if (last && from <= last.to) last.to = Math.max(last.to, to)
    else regions.push({ from, to })
  }

  for (const region of regions) {
    tree.iterate({
      from: region.from, to: region.to,
      enter: (ref) => {
        const name = ref.name
        if (name === 'FencedCode' || name === 'CodeBlock') { fenced.push({ from: ref.from, to: ref.to }); return false }
        const node = ref.node
        if (/^ATXHeading[1-6]$/.test(name)) {
          const marks = node.getChildren('HeaderMark')
          if (marks.length) {
            elements.push({
              from: ref.from, to: ref.to, headingLevel: Number(name.slice(-1)),
              markers: marks.map((m, i) => i === 0 ? trailingSpace(doc, m) : { from: m.from, to: m.to })
            })
          }
        } else if (INLINE_MARK_NAMES[name]) {
          const marks = node.getChildren(INLINE_MARK_NAMES[name])
          if (marks.length) elements.push({ from: ref.from, to: ref.to, markers: marks.map((m) => ({ from: m.from, to: m.to })) })
        } else if (name === 'Link') {
          const marks = node.getChildren('LinkMark')
          const url = node.getChild('URL')
          if (url && marks.length >= 3) {
            // `[` | text | `](address)`
            elements.push({
              from: ref.from, to: ref.to,
              markers: [{ from: marks[0].from, to: marks[0].to }, { from: marks[1].from, to: ref.to }],
              address: { from: marks[2].from, to: ref.to }
            })
            out.push(linkText.range(marks[0].to, marks[1].from))
          }
        } else if (name === 'Blockquote') {
          const marks = quoteMarks(node)
          elements.push({ from: ref.from, to: ref.to, markers: marks.map((m) => trailingSpace(doc, m)) })
          const first = doc.lineAt(ref.from).number
          const last = doc.lineAt(ref.to).number
          let cite = -1
          for (let n = last; n >= first; n--) {
            const inner = doc.line(n).text.trim().replace(/^>\s?/, '')
            if (inner.trim() === '') continue
            if (isAttributionText(inner)) cite = doc.line(n).from
            break
          }
          for (let n = first; n <= last; n++) {
            const line = doc.line(n)
            if (seenLine.has(line.from)) continue
            seenLine.add(line.from)
            out.push(quoteLine.range(line.from))
            if (line.from === cite) out.push(citeLine.range(line.from))
          }
        }
        return undefined
      }
    })

    // TalkWeaver's own marks: the ranges are the interior; the delimiters are the two characters each side.
    for (const { from, to } of inlineMarkRanges(doc.sliceString(region.from, region.to))) {
      const a = region.from + from, b = region.from + to
      if (fenced.some((f) => a >= f.from && b <= f.to)) continue
      elements.push({ from: a - 2, to: b + 2, markers: [{ from: a - 2, to: a }, { from: b, to: b + 2 }] })
    }
  }

  const sel = state.selection.ranges
  for (const el of elements) {
    const shown = revealed(el, sel)
    for (const m of el.markers) {
      if (m.from >= m.to) continue
      const key = `${m.from}:${m.to}`
      if (seenMarker.has(key)) continue
      seenMarker.add(key)
      if (!shown) out.push(hidden.range(m.from, m.to))
      else if (el.headingLevel) out.push(headingMark(el.headingLevel).range(m.from, m.to))
      else out.push(shownMark.range(m.from, m.to))
    }
    if (shown && el.address) out.push(addressMark.range(el.address.from, el.address.to))
  }
  return Decoration.set(out, true)
}

const concealPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = build(view) }
  update(u: ViewUpdate): void {
    if (u.docChanged || u.selectionSet || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
      this.decorations = build(u.view)
    }
  }
}, { decorations: (v) => v.decorations })

const PAPER_RULE = '#cfc6b4'
const LINK = '#1a5fb4'
const GREY = '#8a9099'

/**
 * The heading mark's size by depth, as a share of the body text. 0.85 for `#` to `####`. The two
 * deepest marks are set smaller so that they too fit in the 38 px between the margin and the text
 * (`######` and its space are 49 px wide at 0.85).
 */
const MARK_SIZE = [0.85, 0.85, 0.85, 0.85, 0.74, 0.64]

const concealTheme = EditorView.theme({
  '.cm-plain-link': { color: LINK, textDecoration: 'underline', textUnderlineOffset: '0.18em' },
  '.cm-plain-mark-shown': { color: GREY, fontWeight: '400', fontStyle: 'normal' },
  '.cm-plain-link-address': { color: GREY, fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace", fontSize: '0.88em', textDecoration: 'none' },
  // Heading marks: grey, not heading size (the drawing's faint ### before the title).
  // The mark's wrapper sits outside the highlight spans that carry the heading size, so its own
  // size is the body size divided by the heading step: wrapper x step = 0.85 of the body text
  // (MARK_SIZE).
  //
  // The mark HANGS to the left of the title and takes no width, so the title's text is at the same
  // place whether the caret is on the line or not (a double-click's second click must hit the word
  // the first one did). It is taken out of the line's flow and moved left by its own width; left
  // and top are not set, so it starts where it would have stood (whatever the line's padding) and
  // ends where the title begins. It is still the document's text: the caret walks into it and
  // Backspace there changes the level. It sits in the content's left padding (theme.ts), between
  // the margin and the text.
  '.cm-line .cm-plain-hmark': {
    color: GREY, fontWeight: '400', fontStyle: 'normal',
    position: 'absolute', transform: 'translateX(-100%)', whiteSpace: 'pre'
  },
  '.cm-line .cm-plain-hmark span': { color: GREY, fontWeight: '400' },
  ...Object.fromEntries(HEADING_STEPS.map((step, i) => [`.cm-line .cm-plain-hmark-${i + 1}`, { fontSize: `${(MARK_SIZE[i] / parseFloat(step.size)).toFixed(4)}em` }])),
  // Out of the flow the mark is a box of its own, and its text would stand at the top of the title's
  // row. An empty character at the title's size gives that box the row's height and baseline, so
  // the mark stands on the title's baseline as it did in the line.
  ...Object.fromEntries(HEADING_STEPS.map((step, i) => [`.cm-line .cm-plain-hmark-${i + 1}::before`, {
    content: '"\\200b"', fontSize: `${(parseFloat(step.size) ** 2 / MARK_SIZE[i]).toFixed(4)}em`
  }])),
  '.cm-line.cm-plain-quote': {
    borderLeft: `3px solid ${PAPER_RULE}`,
    paddingLeft: '18px',
    color: '#5d6875',
    fontStyle: 'italic'
  },
  '.cm-line.cm-plain-quote-cite, .cm-line.cm-plain-quote-cite *': {
    fontStyle: 'normal',
    color: GREY
  },
  '.cm-line.cm-plain-quote-cite': { fontSize: '0.88em' }
})

export function concealExtension(): Extension {
  return [concealPlugin, concealTheme]
}
