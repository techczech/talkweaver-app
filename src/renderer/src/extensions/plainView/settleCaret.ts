// Plain view, ticket 07 (seventh fix round): the caret is settled after EVERY transaction, not
// only the ones that pass the filters.
//
// The owners' transaction filters (hiddenLines.ts, iconPictures.ts, talkDetails.ts) put a caret
// that lands in hidden text back at the end of the visible text. A transaction dispatched with
// `filter: false` passes none of them, and CodeMirror's Undo and Redo are such transactions: Undo
// restores the selection the undone change started from, wherever that was. So one update
// listener looks at the caret after any update that changed the document or the selection, with
// the same regions and zones the filters and the key guard read (protectedRegion.ts), and when
// one collapsed caret rests in a zone it did not deliberately walk into, it dispatches ONE
// selection-only transaction that puts it at the zone's settle point (`rest`).
//
// "Deliberately walked into" is the filters' rule:
//   - the caret is in a part that is edited by hand (an icon token's chip) and was, before the
//     update, already at the end of that text or in that zone (ArrowRight from the text's end
//     steps into the chip; inside it the caret moves and types as in any text);
//   - the person's own typing or deleting on the line of a paragraph's or list item's icon token
//     (the token typed by hand: the caret stays after the `}` it has just typed, as it always
//     did; a title's tail is different, its filter takes the caret back on every change);
//   - a Find match (`select.search`) and composition are left alone, as in the filters.
// Undo and Redo are never deliberate.
//
// A hidden layout line (`run`) is settled here in one case: Undo or Redo put the caret on it and
// the caret was not on that line before (ticket 11). Any other caret on such a line shows the
// line, which is then edited as text (a `{…}` line typed by hand; a caret put there by code).
//
// It cannot loop: its own transaction is marked and ignored, it is not added to history, and it
// is dispatched only when the caret is in a zone, which the settle point never is.
import { EditorView, type ViewUpdate } from '@codemirror/view'
import { Annotation, EditorSelection, Prec, Transaction, type Extension } from '@codemirror/state'
import { protectedRegionsOf } from './guardKeys'
import { caretBeforeEnter } from './hiddenLines'
import { inZone, walkedPart, type ProtectedRegion } from './protectedRegion'

/** Marks the listener's own transaction. */
export const caretSettled = Annotation.define<boolean>()

/** How many times the listener has dispatched (read by the tests: at most once for one action). */
export const settleDispatches = { count: 0 }

function walkedIn(update: ViewUpdate, region: ProtectedRegion, head: number): boolean {
  if (!walkedPart(region, head)) return false
  const was = update.startState.selection.main
  if (!was.empty) return false
  // Already at the end of this text, or in this zone, before the update.
  const before = protectedRegionsOf(update.startState)
    .some((r) => r.kind === region.kind && update.changes.mapPos(r.anchor, -1) === region.anchor && was.head >= r.rest && was.head <= r.zoneTo)
  if (before) return true
  // The person typing or deleting on the token's own line (not a title's: see the head of the file).
  if (region.kind !== 'icon' || !update.docChanged) return false
  if (!update.transactions.some((tr) => tr.isUserEvent('input') || tr.isUserEvent('delete'))) return false
  return update.changes.mapPos(update.startState.doc.lineAt(was.head).from, -1) === region.anchor
}

// At the lowest precedence, so it is the last listener to hear of an update: the transaction it
// dispatches (from inside the listener, at once: no key can come between) then reaches the other
// listeners after the update that caused it, in the order things happened.
const settle = Prec.lowest(EditorView.updateListener.of((update) => {
  if (!update.docChanged && !update.selectionSet) return
  if (update.view.composing) return
  const trs = update.transactions
  // (caretBeforeEnter: the one caret that is put past the tokens on purpose, for the browser's own Enter.)
  if (trs.some((tr) => tr.annotation(caretSettled) || tr.annotation(caretBeforeEnter) || tr.isUserEvent('select.search') || tr.isUserEvent('input.type.compose'))) return
  const state = update.state
  const sel = state.selection
  if (sel.ranges.length !== 1 || !sel.main.empty) return
  const head = sel.main.head
  const history = trs.some((tr) => tr.isUserEvent('undo') || tr.isUserEvent('redo'))
  // (A hidden layout line: only where Undo or Redo put the caret; see the head of the file.)
  const region = protectedRegionsOf(state).find((r) => (r.kind !== 'run' || history) && inZone(r, head))
  if (!region) return
  // Nowhere to rest (front matter with nothing after it).
  if (region.rest < 0 || region.rest > state.doc.length || inZone(region, region.rest)) return
  if (region.kind === 'run') {
    // The caret was on this line before the update (the line is being typed by hand): it stays.
    const was = update.startState.selection.main
    const at = update.changes.mapPos(update.startState.doc.lineAt(was.head).from, 1)
    if (was.empty && at >= region.zoneFrom && at <= region.zoneTo) return
  }
  if (!history && walkedIn(update, region, head)) return
  settleDispatches.count += 1
  update.view.dispatch({
    selection: EditorSelection.cursor(region.rest),
    annotations: [caretSettled.of(true), Transaction.addToHistory.of(false)]
  })
}))

export function settleCaretExtension(): Extension {
  return settle
}
