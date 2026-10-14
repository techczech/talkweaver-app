// Plain view, ticket 13: the editor's side of Command-I. Where the caret is, and the ONE write of
// an icon change that shared/icon-verbs.ts has verified. Nothing here decides what is written.
import type { EditorView } from '@codemirror/view'
import { isolateHistory } from '@codemirror/commands'

export interface PlainIconTools {
  /** The outline, the caret's 0-based line and where that line is drawn; null while no talk is loaded. */
  caret: () => { text: string; line: number; anchor: { left: number; top: number; bottom: number } } | null
  /**
   * Dispatches `change` as ONE ordinary transaction (one Undo step; the selection is mapped
   * through it, so a caret at the end of the line's text stays before the new token), and only
   * while the outline is still `text`, the text the verb verified the change against. False: the
   * outline moved on and nothing was written.
   */
  write: (text: string, change: { from: number; to: number; insert: string }) => boolean
  focus: () => void
}

/** `view`: the live editor, or null while there is none or its talk's text is not loaded. */
export function plainIconTools(view: () => EditorView | null): PlainIconTools {
  return {
    caret: () => {
      const v = view()
      // An editor that is not on screen (another view of the workspace is up) has no caret line to draw under.
      if (!v || !v.dom.isConnected || v.dom.offsetParent === null) return null
      const head = v.state.selection.main.head
      const line = v.state.doc.lineAt(head)
      const at = v.coordsAtPos(head) ?? v.coordsAtPos(line.from)
      if (!at) return null
      return { text: v.state.doc.toString(), line: line.number - 1, anchor: { left: v.coordsAtPos(line.from)?.left ?? at.left, top: at.top, bottom: at.bottom } }
    },
    write: (text, change) => {
      const v = view()
      if (!v || v.state.doc.toString() !== text) return false
      // Isolated on both sides: the icon is its own Undo step, never joined to the typing before it.
      v.dispatch({ changes: change, annotations: isolateHistory.of('full') })
      return true
    },
    focus: () => view()?.focus()
  }
}
