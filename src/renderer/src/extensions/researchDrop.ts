import { Decoration, EditorView, type DOMEventHandlers } from '@codemirror/view'
import { RESEARCH_DRAG_TYPE } from '../../../shared/research'

/** Only this app's research drags are claimed; the file is re-read by the insertion seam. */
export function researchDropHandlers(onDrop: (file: string) => void): DOMEventHandlers<unknown> {
  return {
    dragover(event: DragEvent) {
      if (!event.dataTransfer?.types.includes(RESEARCH_DRAG_TYPE)) return false
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      return true
    },
    drop(event: DragEvent, view: EditorView) {
      if (!event.dataTransfer?.types.includes(RESEARCH_DRAG_TYPE)) return false
      event.preventDefault()
      event.stopPropagation()
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (position === null) return true
      view.dispatch({ selection: { anchor: position } })
      const file = event.dataTransfer.getData(RESEARCH_DRAG_TYPE)
      if (file) onDrop(file)
      return true
    }
  }
}

/** Keep the insertion place visible while the research panel owns keyboard focus. */
export const researchInsertionMarker = EditorView.decorations.compute(['selection', 'doc'], state =>
  Decoration.set([Decoration.line({ class: 'cm-research-insert-here' }).range(state.doc.lineAt(state.selection.main.head).from)]))
