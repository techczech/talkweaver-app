import type { EditorView } from '@codemirror/view'
import { insertNewSlide, toggleList } from './editing.ts'
import { runLineCommand } from '../../extensions/objectBlocks/field.ts'

/** One editor command path for toolbar, palette and rebound editor shortcuts. */
export function runActionBarEditing(view: EditorView, action: 'new-slide' | 'bulleted-list' | 'numbered-list'): boolean {
  if (action === 'new-slide') {
    const text = view.state.doc.toString()
    const selection = view.state.selection.main
    const result = insertNewSlide(text, selection.head)
    view.dispatch({ changes: { from: result.at, insert: result.insert }, selection: { anchor: result.cursor } })
  } else {
    // A list is a line command: under an object it goes on a new line, on a selected object it does nothing.
    runLineCommand(view, (target) => {
      const text = target.state.doc.toString()
      const selection = target.state.selection.main
      const result = toggleList(text, selection.from, selection.to, action === 'bulleted-list' ? 'bullet' : 'numbered')
      const trailing = text.length - result.to
      const insert = result.text.slice(result.from, result.text.length - trailing)
      target.dispatch({ changes: { from: result.from, to: result.to, insert }, selection: { anchor: result.from, head: result.from + insert.length } })
      return true
    })
  }
  view.focus()
  return true
}
