// The "before" texts the web form's typing watch keeps (quoteLinkForm.ts), and whose change a transaction is.
//
// What a "before" must satisfy: the document minus the "before" is only text the USER typed or pasted on the line (or the
// two lines) it was taken for. Where a change lies is one half of that (`changesWithin`); who made it is the other, and
// it is decided positively (`byUser`): a change counts as the user's only when it says so itself. Everything else that
// changes the document, and is not a save's adoption or the rule's own write (both put into the "before", `carried`), is
// not the user's, wherever it lies, and the "before" is given up. Giving up writes nothing; it is always safe.
import { Annotation, type ChangeSet, type Text, type Transaction } from '@codemirror/state'
import { isKeyTyped } from './keyTypedMark'

/** Marks the rule's own write, so it is never read as typing. */
export const ownWrite = Annotation.define<boolean>()

/**
 * The user's own edit. The user event and one mark are read, nothing else (no text, no positions):
 *   - a user event of `input` (typed, pasted, dropped in from outside, a completion accepted, the app's commands that
 *     insert at the caret with that event) or of `delete` (Backspace, Delete, a cut);
 *   - `isKeyTyped`: the app's own Enter and Tab commands (outliner.ts), which carry no user event. A Tab or Shift-Tab
 *     that moves more lines than the caret's (a list item with lines under it) does not carry it. The mark is a state
 *     effect only those commands can attach; it stays on their change when Slide Focus moves the caret back into the
 *     focused slide (focusScope.ts rebuilds the transaction with its changes and effects, and no annotation).
 * Not the user's: a change with no user event (a write from elsewhere in the app: the Inspector, a command, a
 * replacement of the text), `move` (text dragged within the editor, a line moved: text put somewhere, not typed), and
 * every other event. An undo or a redo is neither; the watch treats it apart (`again`, `ReachedStates`).
 */
export const byUser = (tr: Transaction): boolean =>
  tr.isUserEvent('input') || tr.isUserEvent('delete') || isKeyTyped(tr)

/** An undo or a redo: never read as an edit; it goes back to a document the user reached, or all is given up. */
export const again = (tr: Transaction): boolean => tr.isUserEvent('undo') || tr.isUserEvent('redo')

/** Typing and deleting that can begin a line (a paste is the paste filter's; the rule's own write is not typing). */
export const isTyping = (tr: Transaction): boolean =>
  byUser(tr) && !tr.isUserEvent('input.paste') && !tr.annotation(ownWrite)

export const sameLine = (doc: Text, a: number, b: number): boolean => doc.lineAt(a).from === doc.lineAt(b).from

/** Every range the transaction changed lies within `from..to` of the document it started from. */
export const changesWithin = (tr: Transaction, from: number, to: number): boolean => {
  let within = true
  tr.changes.iterChangedRanges((a, b) => { if (a < from || b > to) within = false })
  return within
}

/** A "before": the document minus certain edits of the user's, and those edits (applied to `base` they give the document). */
export interface Snapshot { base: Text; typed: ChangeSet }

/** The "before" of the line left before the one being edited, kept for one more line: the document minus the user's
 *  edits to those two lines. `top` is the start of the first of the two. */
export interface Earlier extends Snapshot { top: number }

/**
 * A line that was left, until its check runs. `base` is the document minus the edits to that line (null: none was
 * taken), `earlier` the one kept from the line left before it. `grace` is what is kept for one more line if this check
 * writes nothing (only for a line left by a change that made the next line, with `next` a place on that line).
 * `dropped` once the document changes again before the check has run, or the editor is destroyed: the check is then
 * not made at all.
 */
export interface LeftLine { base: Text | null; earlier: Earlier | null; grace: (Earlier & { next: number }) | null; dropped: boolean }

/** What the watch holds for one document: the "before" of the line being edited (`base`, `typed`), a place on that line
 *  (`at`), whether the "before" was given up on it (`held`), and the "before" kept from the line left before it. */
export interface Held { base: Text | null; typed: ChangeSet | null; at: number; held: boolean; earlier: Earlier | null }

const sameText = (a: Text, b: Text): boolean => a === b || (a.length === b.length && a.eq(b))

/**
 * The documents the user reached by typing alone, each with what the watch held at it: what an undo or a redo may go
 * back to. It is a line through time, as the undo history is: the entries up to `here` (the one of the document as it
 * stands) are what undoing can reach, those after it what redoing can.
 *   - The user's own change (`byUser`) adds the document it leaves after `here` and drops what stood after it (typing
 *     after an undo ends what could be redone). If the list is empty, the document the change started from goes in
 *     first, with what the watch held then.
 *   - Every other change that is no undo or redo (a program's, a save's adoption, the rule's own write) empties it:
 *     a document from before such a change is never in the list, so undoing the change itself finds nothing.
 *   - An undo is looked for among the entries before `here`, a redo among those after it, the nearest first. Found
 *     (the same place in the undo history, see below, and an equal document: the same `Text`, else the same length
 *     and `Text.eq`): what was held there is held again, exactly. Not found: the caller gives everything up and
 *     empties the list. Nothing is ever worked out from the undo's own change.
 *   - An equal text is no proof that the undo stayed on this side of the change that emptied the list: a program's
 *     change can share an undo step with the typing after it, and the one undo that takes both back may leave a text
 *     equal to one typed in between. So each entry also keeps `depth`, the number of undo steps the history held at
 *     it (`undoDepth`), and an undo or a redo is matched only with an entry of the depth it leaves. An undo that
 *     takes back the change that emptied the list, or anything before it, leaves fewer steps than the history held
 *     at any entry made since: every such entry had at least the step that change is in (or, for a change outside
 *     the history, the steps there were at it). When the history drops its oldest steps the numbers of later entries
 *     only go down by as much, so that still holds. An editor with no history has no undo; the depth is then 0.
 * Why what is found is valid: each entry was valid for its document when it was made (the watch's rule for the user's
 * own changes), and whether a "before" is valid for a document depends on those two texts alone.
 * Each entry holds the editor's own `Text` and the watch's own values by reference; adding one copies no text. At
 * most `REACHED_CAP` are kept (the oldest goes first: an undo back past it finds nothing, and nothing is written).
 */
export const REACHED_CAP = 256
export class ReachedStates {
  private entries: Array<Held & { doc: Text; depth: number }> = []
  private here = -1

  clear(): void {
    this.entries = []
    this.here = -1
  }

  /** The list has the document as it stands, this very `Text`. */
  isAt(doc: Text): boolean {
    return this.here >= 0 && this.entries[this.here].doc === doc
  }

  /** The user's change left `doc`: it follows the document as it stood, and nothing can be redone past it. */
  push(doc: Text, depth: number, held: Held): void {
    this.entries.length = this.here + 1
    this.entries.push({ ...held, doc, depth })
    if (this.entries.length > REACHED_CAP) this.entries.shift()
    this.here = this.entries.length - 1
  }

  /** What the watch holds changed with the document as it is (a line left, a "before" kept for the next line). */
  note(doc: Text, depth: number, held: Held): void {
    if (this.isAt(doc)) this.entries[this.here] = { ...held, doc, depth }
  }

  /** An undo (or a redo) left `doc` with `depth` undo steps: what was held at the nearest entry before (after) this
   *  one with that depth and an equal document, or null. */
  returned(doc: Text, depth: number, undo: boolean): Held | null {
    if (this.here < 0) return null
    const step = undo ? -1 : 1
    for (let n = this.here + step; n >= 0 && n < this.entries.length; n += step) {
      if (this.entries[n].depth !== depth || !sameText(this.entries[n].doc, doc)) continue
      this.entries[n] = { ...this.entries[n], doc }
      this.here = n
      return this.entries[n]
    }
    return null
  }
}

/**
 * A change the app made, put into a "before" so that it stays the document minus the user's edits: the change is carried
 * back over what was typed (`ChangeSet.map` over the typing inverted), and the typing carried over it in turn. Exact when
 * the change lies clear of everything typed (an id goes under a heading; the typing is on another line), and checked: the
 * typing applied to the new `base` must give the document. Otherwise null: the "before" is given up, never guessed.
 */
export function carried(snapshot: Snapshot, tr: Transaction): Snapshot | null {
  const back = snapshot.typed.invertedDesc
  let clear = true
  tr.changes.iterChangedRanges((from, to) => { if (back.touchesRange(from, to)) clear = false })
  if (!clear) return null
  const onBase = tr.changes.map(back)
  const base = onBase.apply(snapshot.base)
  const typed = snapshot.typed.map(onBase)
  return typed.apply(base).eq(tr.newDoc) ? { base, typed } : null
}
