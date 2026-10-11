import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { RangeSetBuilder, type EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { hasLinkSyntax, keyCapRanges } from '../../../../compiler/scripts/lib/00-inline-protection.mjs'

// Key caps in the outline editor (onboarding 0.38.1, ticket 05). `<kbd>⌘⇧↓</kbd>` in outline
// text shows as a key cap on every line the caret is NOT on; on the caret's line the source shows,
// so it can be edited as typed. The document is never changed: this is a display-only replace
// decoration. Which `<kbd>` spans count is the compiler's own rule (keyCapRanges: plain-text
// content, no attributes, not inside a code span, no link syntax on the run), so the editor and
// the slide agree. The slide renders a paragraph or quotation paragraph as one run (its lines
// joined), so the editor asks about the whole run, not just the line: a link on a neighbouring
// line of the same paragraph means no caps on any of its lines (review round 1, 2026-10-09).

export { keyCapRanges }

class KeyCapWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }

  eq(other: KeyCapWidget): boolean {
    return other.text === this.text
  }

  toDOM(): HTMLElement {
    const cap = document.createElement('kbd')
    cap.className = 'cm-key-cap'
    cap.textContent = this.text
    return cap
  }

  // A click on the cap reaches the editor, which puts the caret there and reveals the source.
  ignoreEvent(): boolean {
    return false
  }
}

/** 1-based numbers of the lines any selection range touches: those lines show their source. */
export function caretLines(state: EditorState): Set<number> {
  const lines = new Set<number>()
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number
    for (let n = first; n <= last; n += 1) lines.add(n)
  }
  return lines
}

function insideCodeBlock(state: EditorState, pos: number): boolean {
  for (let node: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return true
  }
  return false
}

type RunKind = 'blank' | 'solo' | 'quote' | 'para'

// How the lexer groups a line: blank lines and blank `>` lines end a run; headings, list items,
// trigger lines, fences and table rows are runs of their own; consecutive `>` lines, and
// consecutive plain lines, are joined into one run.
function runKind(text: string): RunKind {
  if (/^\s*$/.test(text) || /^\s*>\s*$/.test(text)) return 'blank'
  if (/^\s*>/.test(text)) return 'quote'
  if (/^\s*(#|[-*+]\s|\d+[.)]\s|\{|```|~~~|:::|\|)/.test(text)) return 'solo'
  return 'para'
}

/** Whether the run line `lineNumber` belongs to (as the slide renderer receives it) has link syntax. */
export function runHasLinkSyntax(state: EditorState, lineNumber: number): boolean {
  const { doc } = state
  const kind = runKind(doc.line(lineNumber).text)
  if (hasLinkSyntax(doc.line(lineNumber).text)) return true
  if (kind === 'solo' || kind === 'blank') return false
  for (const step of [-1, 1]) {
    for (let n = lineNumber + step; n >= 1 && n <= doc.lines; n += step) {
      const text = doc.line(n).text
      if (runKind(text) !== kind) break
      if (hasLinkSyntax(text)) return true
    }
  }
  return false
}

function buildKeyCaps(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const { state } = view
  const skip = caretLines(state)
  let lastLine = 0
  for (const { from, to } of view.visibleRanges) {
    let pos = from
    while (pos <= to) {
      const line = state.doc.lineAt(pos)
      pos = line.to + 1
      if (line.number <= lastLine) continue
      lastLine = line.number
      if (skip.has(line.number) || !line.text.includes('<kbd>')) continue
      if (insideCodeBlock(state, line.from)) continue
      if (runHasLinkSyntax(state, line.number)) continue
      for (const cap of keyCapRanges(line.text)) {
        builder.add(
          line.from + cap.from,
          line.from + cap.to,
          Decoration.replace({ widget: new KeyCapWidget(cap.content), inclusive: false })
        )
      }
    }
  }
  return builder.finish()
}

export const keyCapExtension = [
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = buildKeyCaps(view)
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = buildKeyCaps(update.view)
        }
      }
    },
    { decorations: (value) => value.decorations }
  ),
  EditorView.theme({
    // The drawing's key cap (states 05 and 06): the UI sans, never the editor's monospace, so a
    // letter O and a zero differ; 12px; a hairline border with a heavier bottom edge.
    '.cm-key-cap': {
      display: 'inline-block',
      font: '500 12px/16px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      letterSpacing: '0.02em',
      padding: '0 5px',
      margin: '0 1px',
      border: '1px solid var(--line, #d9d0c1)',
      borderBottomWidth: '2px',
      borderRadius: '4px',
      background: 'var(--panel, #fffdf8)',
      color: 'var(--muted, #5d6875)',
      verticalAlign: '1px',
      whiteSpace: 'nowrap'
    }
  })
]
