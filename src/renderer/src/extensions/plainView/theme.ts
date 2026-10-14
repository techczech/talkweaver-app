// The Plain view's look: a reading sans, sized headings, the code font kept for code.
import { EditorView, Decoration, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { Prec, type Extension } from '@codemirror/state'
import { CODE_FONT } from '../editorLook'
import { plainFontStack, type PlainLook } from '../../../../shared/plain-view-look'

export const PLAIN_SANS = "-apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif"

/** Heading sizes by depth (`#` … `######`): the drawing's four steps. */
export const HEADING_STEPS: ReadonlyArray<{ size: string; weight: string }> = [
  { size: '2.1em', weight: '700' },
  { size: '1.6em', weight: '700' },
  { size: '1.25em', weight: '700' },
  { size: '1.1em', weight: '600' },
  { size: '1.1em', weight: '600' },
  { size: '1.1em', weight: '600' }
]

const mono = { fontFamily: CODE_FONT, fontSize: '0.88em' }

export const plainHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: HEADING_STEPS[0].size, fontWeight: HEADING_STEPS[0].weight },
  { tag: t.heading2, fontSize: HEADING_STEPS[1].size, fontWeight: HEADING_STEPS[1].weight },
  { tag: t.heading3, fontSize: HEADING_STEPS[2].size, fontWeight: HEADING_STEPS[2].weight },
  { tag: [t.heading4, t.heading5, t.heading6], fontSize: HEADING_STEPS[3].size, fontWeight: HEADING_STEPS[3].weight },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.url, color: '#5d6875' },
  { tag: t.processingInstruction, color: '#8a9099' },
  { tag: t.monospace, ...mono },
  // Code inside fences keeps its colours (a small set; the Markdown tab uses CodeMirror's default).
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: '#708' },
  { tag: [t.string, t.regexp], color: '#a11' },
  { tag: [t.number, t.bool, t.null], color: '#164' },
  { tag: [t.comment, t.quote], color: '#6b7684' },
  { tag: [t.definition(t.variableName), t.function(t.variableName), t.typeName, t.className], color: '#00f' }
])

export const plainTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '16px',
    fontFamily: PLAIN_SANS,
    background: '#f7f3ea'
  },
  // Left: 32 px, which with the line's own 6 px is the 38 px the heading mark hangs in (conceal.ts).
  '.cm-content': {
    padding: '16px 20px 16px 32px',
    caretColor: '#0b3a6b',
    fontFamily: PLAIN_SANS
  },
  '.cm-line': { lineHeight: '1.6', color: '#17202a' },
  '.cm-plain-code': { fontFamily: CODE_FONT, fontSize: '14px' },
  '.cm-gutters': {
    backgroundColor: '#f0ebe0',
    borderRight: '1px solid #d9d0c1',
    color: '#8a9099',
    fontFamily: CODE_FONT,
    fontSize: '14px'
  },
  '.cm-activeLineGutter': { backgroundColor: '#e4ddd0' },
  '.cm-activeLine': { backgroundColor: '#e8e3d6' },
  '&.cm-focused .cm-cursor': { borderLeftColor: '#0b3a6b', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: '#0b3a6b22'
  },
  '.cm-matchingBracket': { backgroundColor: '#0b3a6b15', outline: '1px solid #0b3a6b30' }
}, { dark: false })

// Lines inside a fenced code block stay in the code font (nested language tokens carry no monospace tag).
const codeLine = Decoration.line({ class: 'cm-plain-code' })
const fencedCodeLines = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: import('@codemirror/view').EditorView) { this.decorations = build(view) }
  update(u: ViewUpdate): void {
    if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view)
  }
}, { decorations: (v) => v.decorations })

function build(view: import('@codemirror/view').EditorView): DecorationSet {
  const ranges: ReturnType<typeof codeLine.range>[] = []
  const seen = new Set<number>()
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter: (node) => {
        if (node.name !== 'FencedCode') return
        const first = view.state.doc.lineAt(node.from).number
        const last = view.state.doc.lineAt(node.to).number
        for (let n = first; n <= last; n++) {
          const line = view.state.doc.line(n)
          if (!seen.has(line.from)) { seen.add(line.from); ranges.push(codeLine.range(line.from)) }
        }
        return false
      }
    })
  }
  ranges.sort((a, b) => a.from - b.from)
  return Decoration.set(ranges)
}

export function plainLookExtension(): Extension {
  return [syntaxHighlighting(plainHighlightStyle), plainTheme, fencedCodeLines]
}

/**
 * The reader's choice of font and text size (spec T13). Held in its own compartment in Editor.tsx so a
 * change reconfigures only this; headings are sized in em, so they follow the text size. Code stays in
 * the code font (`.cm-plain-code`, inline code) and the gutter keeps its own size.
 */
export function plainTypeExtension(look: PlainLook): Extension {
  const stack = plainFontStack(look.font)
  return Prec.high(EditorView.theme({
    '&': { fontSize: `${look.size}px`, fontFamily: stack },
    '.cm-content': { fontFamily: stack }
  }, { dark: false }))
}
