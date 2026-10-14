// Plain view, ticket 03: an unordered list item's mark (`-`, `*`, `+`) shows as a bullet, at the
// item's own indentation, whether or not the caret is on the line. Ordered marks show as typed.
// The mark is one character replaced by a widget; the space after it and the text are untouched,
// so typing `- ` still starts a list and nothing in the document changes.
import { syntaxTree } from '@codemirror/language'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { EditorState, Extension, Range } from '@codemirror/state'
import { picturedMarks } from './iconPictures'

class BulletWidget extends WidgetType {
  eq(): boolean { return true }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-plain-bullet'
    span.textContent = '•'
    return span
  }
  ignoreEvent(): boolean { return false }
}
const bullet = Decoration.replace({ widget: new BulletWidget() })

function build(view: EditorView): DecorationSet {
  const out: Range<Decoration>[] = []
  const doc = view.state.doc
  const pictured = picturedMarks(view.state) // items whose bullet is drawn as an icon picture
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from, to,
      enter: (node) => {
        if (node.name !== 'ListMark') return
        const parent = node.node.parent?.parent
        if (parent?.name !== 'BulletList') return
        const text = doc.sliceString(node.from, node.to)
        if (text.length === 1 && !pictured.has(node.from)) out.push(bullet.range(node.from, node.to))
      }
    })
  }
  return Decoration.set(out, true)
}

const plugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = build(view) }
  update(u: ViewUpdate): void {
    if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state) || picturedMarks(u.startState) !== picturedMarks(u.state)) this.decorations = build(u.view)
  }
}, { decorations: (v) => v.decorations })

const theme = EditorView.theme({
  '.cm-plain-bullet': { display: 'inline-block', width: '1.1em', textAlign: 'left', color: '#17202a' }
})

export function listMarksExtension(): Extension { return [plugin, theme] }
