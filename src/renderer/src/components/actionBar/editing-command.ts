import type { EditorView } from '@codemirror/view'
import { insertNewSlide, toggleList } from './editing.ts'

/** One editor command path for toolbar, palette and rebound editor shortcuts. */
export function runActionBarEditing(view: EditorView, action: 'new-slide' | 'bulleted-list' | 'numbered-list'): boolean {
  const text = view.state.doc.toString()
  const selection = view.state.selection.main
  if (action === 'new-slide') {
    const result = insertNewSlide(text, selection.head)
    view.dispatch({ changes: { from: result.at, insert: result.insert }, selection: { anchor: result.cursor } })
  } else {
    const result = toggleList(text, selection.from, selection.to, action === 'bulleted-list' ? 'bullet' : 'numbered')
    const trailing = text.length - result.to
    const insert = result.text.slice(result.from, result.text.length - trailing)
    view.dispatch({ changes: { from: result.from, to: result.to, insert }, selection: { anchor: result.from, head: result.from + insert.length } })
  }
  view.focus()
  return true
}
