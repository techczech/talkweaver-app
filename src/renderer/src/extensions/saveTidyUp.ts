// What a save writes, and whether the editor takes it back (issue 131, rebuilt in issue 201).
//
// A save writes the text tidied (normalizePositions, src/shared/outline-normalize.ts: a layout line
// directly under its heading). The editor does not tidy itself before the save: the tidy-up comes back
// with the ids the save stamped, as the one undo step savedTextAdoption.ts makes, and ⌘Z takes that
// step back with the user's change below it.
//
// After an undo or a redo the save is different. A save whose most recent document change was an undo
// or a redo writes the text as the undo or redo left it, untidied, and the editor adopts nothing from
// it: an adoption there would be a new undo step, and a new step ends what could be redone. The first
// save after any other change tidies and is adopted as usual.
//
// (Until 0.40 the rule covered only the tidy-up, which was its own undo step; the save after each ⌘Z
// made that step again and the change underneath could never be reached. The rule stays now that the
// tidy-up travels with the adoption, for the redo steps.)
//
// Changes the app makes outside the undo history (a talk load) do not count as "another change".
import { StateField, Transaction, type EditorState, type Extension } from '@codemirror/state'
import { normalizePositions } from '../../../shared/outline-normalize'

/** True while the most recent document change (outside-history changes aside) was an undo or a redo. */
const lastChangeWasUndoOrRedo = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    if (!tr.docChanged) return value
    if (tr.isUserEvent('undo') || tr.isUserEvent('redo')) return true
    if (tr.annotation(Transaction.addToHistory) === false) return value
    return false
  }
})

/** The extension that keeps the state `textForSave` and the adoption read. Without it every save tidies and is adopted. */
export function saveTidyUp(): Extension {
  return lastChangeWasUndoOrRedo
}

/** True when the most recent document change in `state` was an undo or a redo. */
export function saveFollowsUndoOrRedo(state: EditorState | null | undefined): boolean {
  return state?.field(lastChangeWasUndoOrRedo, false) === true
}

/** The text a save of `text` writes: `text` itself straight after an undo or a redo in `state` (the
 *  editor's state at the save), else `text` tidied. The editor is not changed here; what the save wrote
 *  is adopted afterwards (savedTextAdoption.ts adoptSavedText, from the text the save was made from). */
export function textForSave(state: EditorState | null | undefined, text: string): string {
  if (saveFollowsUndoOrRedo(state)) return text
  return normalizePositions(text)
}
