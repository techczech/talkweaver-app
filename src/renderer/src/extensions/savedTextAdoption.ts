// Taking the text a save wrote back into the editor, as an undo step of its own that ⌘Z takes back
// together with the user's change the save was made for (issues 131 and 201).
//
// A save may write more than the editor holds: the save tidies the layout lines (saveTidyUp.ts
// textForSave), and the main process gives every heading without one an `{id=…}` (src/main/index.ts,
// talk:write-outline) and returns the text it wrote. The editor adopts that text so the next save
// sends it.
//
// Why the adoption is in the history. Made outside it (`addToHistory: false`, as up to 0.40),
// CodeMirror maps every undo step across the inserted ids. A slide's identity exists only as text, so
// after an undo the editor had to work out again which id belonged to which slide, by matching heading
// text that the mapped step had already changed; every matching rule met an input it got wrong.
//
// What this file does. Nothing here finds an id again by its text.
//   1. The adoption is ONE undo step, isolated on both sides (no change of the user's joins it), with
//      the save's tidy-up and the stamped ids in it as one change (`adoptionTransaction`). It carries
//      the `savedTextAdopted` annotation for the extensions that tell the user's changes from the
//      app's, and the `saveStep` effect, which the history keeps with the step (`invertedEffects`) and
//      gives back on every undo and redo of it.
//   2. ⌘Z (`undoWithSave`) undoes a save's step together with the step below it, the user's change the
//      save was made for; redo (`redoWithSave`) redoes the user's step and the save's step above it.
//      Every undo and redo is CodeMirror's own and exact: nothing outside the history changes the text
//      the steps were recorded against. A slide's id goes out with the change it was stamped for and
//      comes back with it on redo.
//   3. A save straight after an undo or a redo is not adopted (saveTidyUp.ts `saveFollowsUndoOrRedo`):
//      a new undo step there would throw the redo steps away. The file has the ids (the main process
//      reuses the ids the file had, `preferred`); the editor takes them at the first save after the
//      user's next change.
//
// The step is made in `savedTextChanges` form: one small change per touched line (an id line put in,
// a layout line moved), so the caret and Slide Focus's range map through it as through a user's edit.
import { Annotation, Prec, StateEffect, type EditorState, type Extension, type Transaction, type TransactionSpec } from '@codemirror/state'
import { EditorView, type Command } from '@codemirror/view'
import { invertedEffects, isolateHistory, redo, undo } from '@codemirror/commands'
import { minimalChange } from '../lib/minimalChange'
import { savedTextChanges } from '../lib/savedTextChanges'
import { saveFollowsUndoOrRedo } from './saveTidyUp'

/** Marks the transaction that adopts the text a save wrote: the app's change, not the user's.
 *  extensions/quoteLinkForm.ts reads it, to keep the ids a save stamped out of what it takes as typed. */
export const savedTextAdopted = Annotation.define<boolean>()

/** Carried by a save's step, and by every undo and redo of it (the history keeps it with the step). */
const saveStep = StateEffect.define<null>()
const keepsSaveStep = invertedEffects.of((tr) => (tr.effects.some((e) => e.is(saveStep)) ? [saveStep.of(null)] : []))

/** True when `tr` makes, undoes or redoes a save's step. */
export const isSaveStep = (tr: Transaction): boolean => tr.effects.some((e) => e.is(saveStep))

/** The transaction that puts `saved` (what the save wrote) in place of `source` (the editor's text the
 *  save was made from), or null when nothing is to be adopted: the texts are the same, the document is
 *  no longer `source` (the user typed during the save; the next save stamps again), or the save
 *  followed an undo or a redo (the head of this file, 3). */
export function adoptionTransaction(state: EditorState, source: string, saved: string): TransactionSpec | null {
  if (source === saved || state.doc.toString() !== source || saveFollowsUndoOrRedo(state)) return null
  // One small change per touched line; one replacement when the difference reads otherwise. Either is
  // one undo step whose undo gives `source` back exactly.
  const changes = savedTextChanges(source, saved) ?? [minimalChange(source, saved)]
  return { changes, effects: saveStep.of(null), annotations: [savedTextAdopted.of(true), isolateHistory.of('full')] }
}

/** Adopt the text a save wrote (`adoptionTransaction`). The caret is mapped through the change and
 *  the scroll position holds. True when the editor's text changed. */
export function adoptSavedText(view: EditorView, source: string, saved: string): boolean {
  const spec = adoptionTransaction(view.state, source, saved)
  if (!spec) return false
  view.dispatch(spec)
  return true
}

// ── ⌘Z and redo ──

/** The transaction `command` (CodeMirror's undo or redo) would dispatch in `state`; null when none. */
function step(command: typeof undo, state: EditorState): Transaction | null {
  let made: Transaction | null = null
  command({ state, dispatch: (tr) => { made = tr } })
  return made
}

// Two save steps never stand together in practice (the save that follows a save's step stamps nothing
// new and tidies nothing). If they do, the run goes with the user's step it stands on. Bounded anyway.
const MAX_STEPS = 50

/** The transactions of one ⌘Z in `state`: an undo, and while what it undid was a save's step, the
 *  step below as well. Empty when there is nothing to undo. */
export function undoTransactions(state: EditorState): Transaction[] {
  const out: Transaction[] = []
  let at = state
  while (out.length < MAX_STEPS) {
    const tr = step(undo, at)
    if (!tr) break
    out.push(tr)
    at = tr.state
    if (!isSaveStep(tr)) break
  }
  return out
}

/** The transactions of one redo in `state`: a redo, and while the next redo is a save's step, that
 *  one as well. Empty when there is nothing to redo. */
export function redoTransactions(state: EditorState): Transaction[] {
  const out: Transaction[] = []
  let at = state
  while (out.length < MAX_STEPS) {
    const tr = step(redo, at)
    if (!tr || (out.length > 0 && !isSaveStep(tr))) break
    out.push(tr)
    at = tr.state
  }
  return out
}

// One dispatch for the whole command: the editor's listeners see one update, with the text the
// command ends at (never the text between the two steps). The array form: two Transaction arguments
// would be read as two specs and merged into one transaction.
const run = (view: EditorView, trs: Transaction[]): boolean => {
  if (trs.length === 0) return false
  view.dispatch(trs)
  return true
}

/** ⌘Z: an undo; a save's step together with the user's step below it. */
export const undoWithSave: Command = (view) => run(view, undoTransactions(view.state))
/** ⇧⌘Z: a redo; the user's step together with the save's step above it. */
export const redoWithSave: Command = (view) => run(view, redoTransactions(view.state))

/** Keeps a save's step marked in the history, and sends the Edit menu's Undo and Redo (the browser's
 *  `historyUndo` and `historyRedo` input) through the two commands above. The keys are bound in
 *  extensions/editorBaseKeymap.ts and keymap/registry.ts. */
export function savedTextAdoption(): Extension {
  return [
    keepsSaveStep,
    // Ahead of history()'s own handler, which runs CodeMirror's single-step undo and redo.
    Prec.high(EditorView.domEventHandlers({
      beforeinput(event, view) {
        const command = event.inputType === 'historyUndo' ? undoWithSave : event.inputType === 'historyRedo' ? redoWithSave : null
        if (!command) return false
        event.preventDefault()
        return command(view)
      }
    }))
  ]
}
