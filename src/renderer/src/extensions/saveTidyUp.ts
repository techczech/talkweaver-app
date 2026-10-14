// Whether a save runs the layout-line tidy-up (normalizePositions, src/shared/outline-normalize.ts).
//
// The tidy-up is an ordinary undo step the save dispatches (Editor.tsx: the autosave, flushSave and
// the replace seam's save branch). ⌘Z undoes it like any other step. If the save that follows that
// ⌘Z made the step again, it would be the newest step again, and the user's own change underneath
// could never be reached (issue 131). So: a save whose most recent document change was an undo or a
// redo does not tidy. It writes the text as the undo or redo left it. The first save after any other
// change tidies as before.
//
// Changes the app makes outside the undo history do not count as "another change": the ids a save
// stamps (savedTextAdoption.ts: the adoption, and the settling after an undo or redo) arrive after an
// undo's save, and if they counted, the save they schedule would tidy and the loop would be back.
// Those carry `Transaction.addToHistory` false; the adoption also carries `savedTextAdopted` (its
// one in-history form included: it is still the save's change, not the user's).
import { StateField, Transaction, type EditorState, type Extension } from '@codemirror/state'
import { normalizePositions } from '../../../shared/outline-normalize'
import { savedTextAdopted } from './savedTextAdoption'

/** True while the most recent document change (the save's own out-of-history changes aside) was an undo or a redo. */
const lastChangeWasUndoOrRedo = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    if (!tr.docChanged) return value
    if (tr.isUserEvent('undo') || tr.isUserEvent('redo')) return true
    if (tr.annotation(Transaction.addToHistory) === false || tr.annotation(savedTextAdopted)) return value
    return false
  }
})

/** The extension that keeps the state `textForSave` reads. Without it every save tidies. */
export function saveTidyUp(): Extension {
  return lastChangeWasUndoOrRedo
}

/** The text a save of `text` writes, and puts in the editor when it differs: `text` itself straight
 *  after an undo or a redo in `state` (the editor's state at the save), else `text` tidied. */
export function textForSave(state: EditorState | null | undefined, text: string): string {
  if (state?.field(lastChangeWasUndoOrRedo, false)) return text
  return normalizePositions(text)
}
