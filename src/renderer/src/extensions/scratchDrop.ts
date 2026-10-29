// Scratchpad drags name only an item. Both the visible marker and the eventual insertion use place.ts.
import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { insertionPoint, placeForLine, placeRows, type SlidePlace } from '../../../shared/slide-handling/place'

export const SCRATCH_DRAG_TYPE = 'application/x-tw-scratch-item'
const markPlace = StateEffect.define<number | null>()
const marker = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    if (transaction.docChanged) return Decoration.none
    for (const effect of transaction.effects) if (effect.is(markPlace)) {
      return effect.value == null ? Decoration.none : Decoration.set([Decoration.line({ class: 'cm-scratch-insert-here' }).range(effect.value)])
    }
    return value
  },
  provide: field => EditorView.decorations.from(field)
})

export function scratchDropExtension(onDrop: (id: string, place: SlidePlace) => void) {
  const placeAt = (event: DragEvent, view: EditorView): SlidePlace | null => {
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (position == null) return null
    const text = view.state.doc.toString()
    const line = view.state.doc.lineAt(position).number
    const heading = placeRows(text).find(row => row.line === line)
    return heading ? { kind: 'before', line, title: heading.title } : placeForLine(text, line)
  }
  return [marker, EditorView.domEventHandlers({
    dragover(event, view) {
      if (!event.dataTransfer?.types.includes(SCRATCH_DRAG_TYPE)) return false
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      const place = placeAt(event, view)
      const point = place && insertionPoint(view.state.doc.toString(), place)
      const at = point?.ok ? view.state.doc.lineAt(Math.min(point.offset, view.state.doc.length)).from : null
      view.dispatch({ effects: markPlace.of(at) })
      return true
    },
    dragleave(event, view) {
      if (!view.dom.contains(event.relatedTarget as Node | null)) view.dispatch({ effects: markPlace.of(null) })
      return false
    },
    drop(event, view) {
      if (!event.dataTransfer?.types.includes(SCRATCH_DRAG_TYPE)) return false
      event.preventDefault(); event.stopPropagation()
      const place = placeAt(event, view)
      const id = event.dataTransfer.getData(SCRATCH_DRAG_TYPE)
      view.dispatch({ effects: markPlace.of(null) })
      if (id && place) onDrop(id, place)
      return true
    },
    dragend(_event, view) { view.dispatch({ effects: markPlace.of(null) }); return false }
  })]
}
