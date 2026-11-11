// The editor gutter shows each slide's number beside its heading line, and nothing on other
// lines. The number is the strip's (compiled index + 1): the map comes from shared/slide-lines.
// Driven by a StateEffect so a recompile updates the gutter without a remount; between compiles
// the heading positions ride document edits, so typing never makes the numbers jump or blink.
import { EditorView, GutterMarker, gutter } from '@codemirror/view'
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { slideNumbersByLine, titleHeadingLine } from '../../../shared/slide-lines.ts'

type Anchor = { pos: number; number: number }

const setAnchors = StateEffect.define<readonly Anchor[]>()

const HEADING = /^#{1,6}\s/

class NumberMarker extends GutterMarker {
  constructor(private readonly text: string) { super() }
  eq(other: NumberMarker): boolean { return other.text === this.text }
  toDOM(): Node { return document.createTextNode(this.text) }
}

const anchorField = StateField.define<readonly Anchor[]>({
  create: () => [],
  update(anchors, tr) {
    for (const effect of tr.effects) if (effect.is(setAnchors)) return effect.value
    if (!tr.docChanged || !anchors.length) return anchors
    return anchors.map((a) => ({ pos: tr.changes.mapPos(a.pos, 1), number: a.number }))
  }
})

function digitsFor(state: EditorState): string {
  // Same width as the line-number gutter had: sized for the highest line number.
  return '9'.repeat(String(state.doc.lines).length)
}

export const slideNumberGutterExtension: Extension = [
  anchorField,
  gutter({
    class: 'cm-lineNumbers',
    lineMarker(view, line) {
      const anchor = view.state.field(anchorField).find((a) => a.pos === line.from)
      if (!anchor) return null
      if (!HEADING.test(view.state.doc.sliceString(line.from, Math.min(line.to, line.from + 8)))) return null
      return new NumberMarker(String(anchor.number))
    },
    lineMarkerChange: (update) => update.docChanged || update.transactions.some((tr) => tr.effects.some((e) => e.is(setAnchors))),
    initialSpacer: (view) => new NumberMarker(digitsFor(view.state)),
    updateSpacer: (spacer, update) => (update.docChanged ? new NumberMarker(digitsFor(update.state)) : spacer)
  })
]

/** slideLines = computeSlideLines output (the heading line of each compiled slide, by index). */
export function setSlideNumberLines(view: EditorView, slideLines: ReadonlyArray<number | null>): void {
  const doc = view.state.doc
  const anchors: Anchor[] = []
  const title = titleHeadingLine(doc)
  for (const [line, number] of slideNumbersByLine(slideLines)) {
    if (line < 1 || line > doc.lines) continue
    // The cover (number 1, on file line 1) is numbered on the title heading when line 1 is not a heading.
    const at = number === 1 && line === 1 && title != null && !HEADING.test(doc.line(1).text.slice(0, 8)) ? title : line
    anchors.push({ pos: doc.line(at).from, number })
  }
  view.dispatch({ effects: setAnchors.of(anchors) })
}
