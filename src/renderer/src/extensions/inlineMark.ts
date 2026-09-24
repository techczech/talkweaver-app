import {
  Decoration,
  ViewPlugin,
  EditorView,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { inlineMarkRanges } from '../../../../compiler/scripts/lib/00-inline-protection.mjs'

export { inlineMarkRanges }

function buildMarks(view: EditorView): DecorationSet {
  // The editor and compiler share protected-range semantics, not merely a regex: matching
  // backtick runs and whole Markdown link constructs are opaque to ==mark==. Decoration covers
  // the marker interior only, mirroring the deck after its delimiters have been removed. Expand
  // each visible range to complete lines so a protected construct cannot be clipped at a viewport
  // edge, then scan only those lines rather than the whole document.
  const visibleLines: Array<{ from: number; to: number }> = []
  for (const range of view.visibleRanges) {
    const from = view.state.doc.lineAt(range.from).from
    const toPosition = Math.max(range.from, range.to - 1)
    const to = view.state.doc.lineAt(toPosition).to
    const previous = visibleLines.at(-1)
    if (previous && from <= previous.to) previous.to = Math.max(previous.to, to)
    else visibleLines.push({ from, to })
  }
  return Decoration.set(
    visibleLines.flatMap((visible) =>
      inlineMarkRanges(view.state.sliceDoc(visible.from, visible.to))
        .map(({ from, to }) => Decoration.mark({ class: 'cm-ink-marker' })
          .range(visible.from + from, visible.from + to))
    ),
    true
  )
}

export const inlineMarkExtension = [
  ViewPlugin.fromClass(class {
    marks: DecorationSet

    constructor(view: EditorView) {
      this.marks = buildMarks(view)
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.marks = buildMarks(update.view)
    }
  }, { decorations: (value) => value.marks }),
  EditorView.theme({
    '.cm-ink-marker': {
      background: '#ffe45e66',
      borderRadius: '2px'
    }
  })
]
