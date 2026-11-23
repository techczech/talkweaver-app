// The editor gutter shows each slide's number beside its heading line, and nothing on other
// lines. The number is the strip's (compiled index + 1): the map comes from shared/slide-lines.
// Driven by a StateEffect so a recompile updates the gutter without a remount; between compiles
// the heading positions ride document edits, so typing never makes the numbers jump or blink.
import { Decoration, EditorView, GutterMarker, gutter } from '@codemirror/view'
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { slideNumbersByLine, titleHeadingLine } from '../../../shared/slide-lines.ts'

export interface MarkdownHeadingLabel {
  kind: 'Section' | 'Subsection' | 'Slide' | 'Subslide' | 'Talk'
  sectionNumber?: string
}

type Anchor = { pos: number; label: string; kind?: MarkdownHeadingLabel['kind'] }

const setAnchors = StateEffect.define<readonly Anchor[]>()

const HEADING = /^#{1,6}\s/

class NumberMarker extends GutterMarker {
  constructor(private readonly text: string, private readonly kind?: MarkdownHeadingLabel['kind']) { super() }
  eq(other: NumberMarker): boolean { return other.text === this.text && other.kind === this.kind }
  toDOM(): Node {
    if (!this.kind) return document.createTextNode(this.text)
    const marker = document.createElement('span')
    marker.className = 'cm-md-heading-marker'
    marker.dataset.headingKind = this.kind
    marker.title = [this.kind, this.text].filter(Boolean).join(' ')
    const name = document.createElement('span')
    name.className = 'cm-md-heading-name'
    name.textContent = this.kind
    const compact = document.createElement('span')
    compact.className = this.text ? 'cm-md-heading-number' : 'cm-md-heading-abbreviation'
    compact.textContent = this.text || ({ Section: '§', Subsection: '§', Slide: 'Sl', Subslide: 'Sub', Talk: 'Talk' }[this.kind])
    marker.append(name, compact)
    return marker
  }
}

const anchorField = StateField.define<readonly Anchor[]>({
  create: () => [],
  update(anchors, tr) {
    for (const effect of tr.effects) if (effect.is(setAnchors)) return effect.value
    if (!tr.docChanged || !anchors.length) return anchors
    return anchors.map((a) => ({ ...a, pos: tr.changes.mapPos(a.pos, 1) }))
  },
  provide: field => EditorView.decorations.from(field, anchors => Decoration.set(
    anchors.flatMap(({ pos, kind }) => kind ? [Decoration.line({ class: `cm-md-${kind.toLowerCase()}` }).range(pos)] : []),
    true
  ))
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
      return new NumberMarker(anchor.label, anchor.kind)
    },
    lineMarkerChange: (update) => update.docChanged || update.transactions.some((tr) => tr.effects.some((e) => e.is(setAnchors))),
    initialSpacer: (view) => new NumberMarker(digitsFor(view.state)),
    updateSpacer: (spacer, update) => (update.docChanged ? new NumberMarker(digitsFor(update.state)) : spacer)
  })
]

/** slideLines = computeSlideLines output (the heading line of each compiled slide, by index). */
export function setSlideNumberLines(
  view: EditorView,
  slideLines: ReadonlyArray<number | null>,
  structure?: ReadonlyMap<number, MarkdownHeadingLabel>
): void {
  const doc = view.state.doc
  const anchors: Anchor[] = []
  const title = titleHeadingLine(doc)
  for (const [line, number] of slideNumbersByLine(slideLines)) {
    if (line < 1 || line > doc.lines) continue
    // The cover (number 1, on file line 1) is numbered on the title heading when line 1 is not a heading.
    const at = number === 1 && line === 1 && title != null && !HEADING.test(doc.line(1).text.slice(0, 8)) ? title : line
    if (!structure) anchors.push({ pos: doc.line(at).from, label: String(number) })
    else {
      const heading = structure.get(at) ?? (at === title ? { kind: 'Talk' as const } : undefined)
      if (heading) anchors.push({ pos: doc.line(at).from, kind: heading.kind,
        label: heading.kind === 'Section' || heading.kind === 'Subsection'
          ? heading.sectionNumber ? '§' + heading.sectionNumber : '' : String(number) })
    }
  }
  if (structure) {
    const numbered = new Set(anchors.map(anchor => anchor.pos))
    for (const [line, heading] of structure) {
      if (line > doc.lines || numbered.has(doc.line(line).from)) continue
      anchors.push({ pos: doc.line(line).from, kind: heading.kind, label: heading.sectionNumber ? '§' + heading.sectionNumber : '' })
    }
  }
  view.dispatch({ effects: setAnchors.of(anchors) })
}
