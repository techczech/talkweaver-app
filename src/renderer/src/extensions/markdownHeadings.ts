// Heading sizes in Markdown follow the same structure as the Slides sidebar.
import { Decoration, EditorView } from '@codemirror/view'
import { StateEffect, StateField } from '@codemirror/state'

export type MarkdownHeadingKind = 'section' | 'subsection' | 'slide' | 'subslide'
type Anchor = { pos: number; kind: MarkdownHeadingKind }

const setAnchors = StateEffect.define<readonly Anchor[]>()

export const markdownHeadingStyles = StateField.define<readonly Anchor[]>({
  create: () => [],
  update(anchors, tr) {
    for (const effect of tr.effects) if (effect.is(setAnchors)) return effect.value
    if (!tr.docChanged || !anchors.length) return anchors
    return anchors.map(anchor => ({ ...anchor, pos: tr.changes.mapPos(anchor.pos, 1) }))
  },
  provide: field => EditorView.decorations.from(field, anchors => Decoration.set(
    anchors.map(({ pos, kind }) => Decoration.line({ class: `cm-md-${kind}` }).range(pos)),
    true
  ))
})

export function setMarkdownHeadings(view: EditorView, headings?: ReadonlyMap<number, MarkdownHeadingKind>): void {
  const doc = view.state.doc
  const anchors: Anchor[] = []
  for (const [line, kind] of headings ?? []) {
    if (line >= 1 && line <= doc.lines) anchors.push({ pos: doc.line(line).from, kind })
  }
  if (anchors.length || view.state.field(markdownHeadingStyles).length) view.dispatch({ effects: setAnchors.of(anchors) })
}
