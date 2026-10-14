// The web and paper forms on a link edit (docs/design/2026-10-11-source-styled-quote-slides, spec 3.1 and 12; ticket 07).
//
// When the author pastes or types an ordinary web link (or a DOI) into a quote slide's source line, the slide becomes a web
// page (or a paper): `form=web` (or `form=paper`) joins its layout line in an undoable edit the link is in or comes before, so undoing never
// leaves the token without its link (a paste, and a line left with no change: one undo takes both; a line left by Enter:
// one undo takes the Enter and the token, the next the link).
// The rule itself is one pure function beside the verbs (`setFormOnLinkEdits`, shared/layout-verbs.ts); this file only
// says WHEN it runs:
//   - paste: inside the paste transaction (a transaction filter appends the layout-line change to it, so history sees one
//     change);
//   - typing: when the line is left (the caret moves to another line, by a click, an arrow or Enter, or the editor loses
//     focus). The write is its own transaction with the `input.type.compose` user event, which CodeMirror's history always
//     joins to the previous event (the link's typing, or the Enter that left the line). It bypasses the token guards
//     (`filter: false`): it is the app's own write, as the verbs' are.
// The write is always decided on the document that receives it: whatever left the line, the rule is asked about the
// document as it stands when the write is dispatched (after the Enter, for Enter), and the write is dispatched in the same
// step. Nothing decided on one document is ever carried to another.
// The rule compares the outline before and after the edit. For typing, "before" is the document minus the user's edits
// to the LINE being edited (not the whole uninterrupted run of typing): a slide typed top to bottom in one go has its
// heading and quotation in that text by the time its address line is begun, so the address is a link typed into a slide
// that was there. An edit to the line is a change the user made that lies wholly within it. Both halves are tested:
// where the change lies, and whose it is. A change is the user's only when it says so (a user event of typing, deleting,
// pasting or cutting, or the mark of the app's own Enter and Tab commands; `byUser`, quoteLinkFormSnapshots.ts). The
// text a save writes back meanwhile (the `{id=…}` it stamps under a new heading, savedTextAdoption.ts) is the app's
// change, not the user's: it is put into the "before" text too. Every other change that is not the user's (a write from
// elsewhere in the app, with no user event), on the line or anywhere else, means "before" can no longer be told: it is
// given up and no form is set for that line until another line is begun. The user's own typing that reaches outside the
// line (a second caret typing on another line, a Backspace that joins the line to the one above, Enter clearing the
// quotation marker of the line above) gives it up too, and "before" is taken again from the document that change
// leaves, so nothing it did counts as typed on the line.
// Any edit of the user's counts (decided 13 October 2026, ticket 14): a form is written only as the result of the
// user's own edit at the keyboard (typing, pasting, deleting, or the app's own key commands Enter, Shift-Enter, Tab
// and Shift-Tab), whether or not the user typed the address itself, and never as the result of a program's change. An
// Enter or a Shift-Enter that breaks `> Words. - Author <link>` after the words is such an edit: the slide becomes a
// web page. What is not asked is which characters of the link the user typed; what is asked is whose the change was.
// One line of grace: when a line is left by the Enter that makes the next line and the rule writes nothing, the line's
// "before" is kept until that next line is left, and the rule is then asked once more with it, about the document as it
// then stands (or as soon as that next line is empty again). A `- Author <link>` source line left by Enter is why: the app's Enter continues the list, the slide with
// the empty item is a list for the compiler, and it is a quote with its source again once the item is taken out. That
// kept "before" allows for the user's edits within those two lines only; anything else (but a save's ids) discards it.
// Undo and redo are never read as edits (what an undo takes back may be a program's change: putting it into "before"
// as typing would make a link the user never typed a typed one). The watch keeps the documents the user reached by
// typing alone, each with what was held at it (`ReachedStates`, quoteLinkFormSnapshots.ts). An undo or a redo that
// returns to one of them holds again exactly what was held there; any other gives everything up, as a program's
// change does. Every change that is not the user's empties that list, and each kept document is tied to its place in
// the undo history, so undoing such a change finds nothing, whatever text it leaves.
// Nothing here uses the network or a setting; opening, compiling and presenting a talk set nothing (no trigger fires).
import { ChangeSet, EditorState, type Extension, type Text, type Transaction } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { undoDepth } from '@codemirror/commands'
import { setFormOnLinkEdits } from '../../../shared/layout-verbs'
import { minimalChange } from '../lib/minimalChange'
import { again, byUser, carried, changesWithin, isTyping, ownWrite, ReachedStates, sameLine, type Earlier, type Held, type LeftLine } from './quoteLinkFormSnapshots'
import { savedTextAdopted } from './savedTextAdoption'

/** The layout the compiler gave the slide whose heading is on `headingLine` (a quote-only slide has no `{quote}` token). */
export type CompiledLayoutAt = (headingLine: number) => string | undefined

class LinkEditWatch {
  /** The document minus the user's edits to the line being edited; null when no line is being edited.
   *  Kept as the editor's own `Text` (nothing is copied while typing); read as a string only when the rule runs. */
  private base: Text | null = null
  /** Every change since `base` that is not in it: applied to `base` it gives the document. Only the user's edits to the
   *  line being edited are ever put in it. */
  private typed: ChangeSet | null = null
  /** A place on the line being edited (the caret after the last edit, carried through later changes): the line is the
   *  one this place is on. Kept only while a line is being edited, `held`, or an `earlier` "before" is kept. */
  private at = 0
  /** The "before" of the line left just before this one, when its check wrote nothing: asked about once more when this
   *  line is left, then discarded (one line of grace). */
  private earlier: Earlier | null = null
  /** `base` was given up on this line (an adopted save could not be put into it exactly, or the document changed outside
   *  the line): none is taken, and no form is set for the line, until another line is begun. */
  private held = false
  /** Lines left whose check has not run yet. */
  private left: LeftLine[] = []
  /** The documents the user reached by typing alone, with what was held at each: where an undo or a redo may return. */
  private readonly reached = new ReachedStates()
  /** The editor is gone: nothing more is checked or written. */
  private destroyed = false

  constructor(private readonly view: EditorView, private readonly layoutAt: () => CompiledLayoutAt | undefined) {}

  update(update: ViewUpdate): void {
    for (const tr of update.transactions) if (tr.docChanged) this.changed(tr)
    // The caret moved to another line with nothing else changing: the line is left.
    if (update.docChanged || !update.selectionSet || (this.base == null && !this.held && !this.earlier)) return
    if (sameLine(update.state.doc, update.state.selection.main.head, this.at)) return
    this.held = false
    this.settle()
  }

  /** The editor is destroyed: the checks still queued are not made (a destroyed view would take the write into its state). */
  destroy(): void {
    this.destroyed = true
    for (const line of this.left) line.dropped = true
    this.left = []
  }

  private holding(): Held {
    return { base: this.base, typed: this.typed, at: this.at, held: this.held, earlier: this.earlier }
  }

  private changed(tr: Transaction): void {
    // A check that has not run yet was queued for the document as it stood: it is not made on another one.
    for (const line of this.left) line.dropped = true
    // An undo or a redo: back at a document the user reached by typing alone, what was held there is held again,
    // exactly. At any other document everything is given up. Its change is never put into a "before".
    if (again(tr)) {
      const was = this.reached.returned(tr.newDoc, undoDepth(tr.state), tr.isUserEvent('undo'))
      if (!was) this.reached.clear()
      this.base = was?.base ?? null
      this.typed = was?.typed ?? null
      this.earlier = was?.earlier ?? null
      this.held = was ? was.held : true
      this.at = was ? was.at : tr.state.selection.main.head
      return
    }
    // Not the user's (a program's change, a save's adoption, the rule's own write): no document from before it may be
    // returned to. What is held after it (carried, or given up) goes into the list with the user's next change.
    if (!byUser(tr) || tr.annotation(ownWrite) || tr.annotation(savedTextAdopted)) {
      this.follow(tr)
      this.reached.clear()
      return
    }
    // The user's: the document it leaves is one that can be returned to, and so is the one it started from.
    if (!this.reached.isAt(tr.startState.doc)) {
      this.reached.clear()
      this.reached.push(tr.startState.doc, undoDepth(tr.startState), this.holding())
    }
    this.follow(tr)
    this.reached.push(tr.newDoc, undoDepth(tr.state), this.holding())
  }

  private follow(tr: Transaction): void {
    if (this.base == null && !this.held && !this.earlier) return this.begin(tr)
    this.keepEarlier(tr)
    const at = tr.changes.mapPos(this.at, -1)
    // The app's own changes (the form this rule wrote for a line left by Enter, the ids a save stamped) are not the user's.
    if (tr.annotation(ownWrite) || tr.annotation(savedTextAdopted)) {
      this.carry(tr)
      this.at = at
      return
    }
    // A change that is not the user's (no user event of typing, deleting or pasting, and not one of the app's own key
    // commands), on this line or anywhere else: `base` would no longer be the document minus the USER's edits to this
    // line. It is given up, and none is taken for this line again.
    if (!byUser(tr)) {
      this.base = null
      this.typed = null
      this.held = true
      this.at = at
      return
    }
    // The user's edit to the line being edited is a change that lies wholly within that line (its extent is read from
    // the place kept on it; no text is copied). One that reaches outside it is not: `base` is given up.
    const line = tr.startState.doc.lineAt(this.at)
    const within = changesWithin(tr, line.from, line.to)
    const from = tr.changes.mapPos(line.from, -1)
    const to = tr.changes.mapPos(line.to, 1)
    // The change made the line into several (Enter, a paste of several lines).
    const split = within && tr.newDoc.lineAt(from).to !== to
    const head = tr.state.selection.main.head
    if (!within) {
      // The user's own typing that reaches outside the line (Enter on an empty quotation marker also clears the marker
      // of the line above; a Backspace that joins two lines; a second caret) begins again from the document it leaves.
      if (isTyping(tr)) return this.beginAfter(tr)
      this.base = null
      this.typed = null
      this.held = true
      this.at = at
      return
    }
    // The change took the caret to another line (Enter): the line is left. Its check is made on the document as it
    // stands after this change, never on the text before it. If that check writes nothing, the line's "before" is kept
    // for the line the change made (`grace`), with the change itself among the edits it leaves out.
    if (split || head < from || head > to) {
      const grace = split && this.base != null && this.typed ? { base: this.base, typed: this.typed.compose(tr.changes), top: from, next: head } : null
      this.held = false
      this.at = at
      this.leave(tr.newDoc, grace)
      this.at = head
      return this.begin(tr)
    }
    if (this.base == null && !this.held) {
      this.at = at
      this.begin(tr)
    } else {
      if (this.base != null && this.typed) this.typed = this.typed.compose(tr.changes)
      this.at = isTyping(tr) ? head : at
    }
    // The line under the one `earlier` was kept for is empty again (the second Enter took out the empty item the first
    // one made): `earlier` is asked about now, on the document as it stands, and discarded.
    if (this.earlier && tr.newDoc.lineAt(this.at).length === 0) {
      const earlier = this.earlier
      this.earlier = null
      this.check(tr.newDoc, null, earlier, null)
    }
  }

  /**
   * The `earlier` "before" through a change, or given up. It stays the document minus the user's edits to two lines, the
   * line it was taken for and the line under it that is being edited: a save's ids are put into it exactly (`carried`) or
   * it is given up; any other change must be the user's and lie wholly within those two lines
   * (their extents read from the two places kept on them). A change that is not the user's discards it wherever it
   * lies: on either of the two lines it would be read as typed there. Nothing that reaches outside them is allowed for,
   * not the user's own typing either.
   */
  private keepEarlier(tr: Transaction): void {
    const earlier = this.earlier
    if (!earlier) return
    this.earlier = null
    const top = tr.changes.mapPos(earlier.top, -1)
    if (tr.annotation(ownWrite) || tr.annotation(savedTextAdopted)) {
      const next = carried(earlier, tr)
      if (next) this.earlier = { ...next, top }
      return
    }
    if (!byUser(tr)) return
    const doc = tr.startState.doc
    const first = doc.lineAt(earlier.top)
    const second = doc.lineAt(this.at)
    if (first.number + 1 !== second.number || !changesWithin(tr, first.from, second.to)) return
    this.earlier = { base: earlier.base, typed: earlier.typed.compose(tr.changes), top }
  }

  /** The user begins a line with this change (the first one since the caret came to the line, or the Enter that made
   *  it): a change wholly within the line the caret was on, which leaves the caret in what that line became. Typing that
   *  is not such a change is no edit to one line: the line is begun from the document it leaves. */
  private begin(tr: Transaction): void {
    if (!isTyping(tr)) return
    const line = tr.startState.doc.lineAt(tr.startState.selection.main.head)
    const head = tr.state.selection.main.head
    if (!changesWithin(tr, line.from, line.to) || head < tr.changes.mapPos(line.from, -1) || head > tr.changes.mapPos(line.to, 1)) return this.beginAfter(tr)
    this.base = tr.startState.doc
    this.typed = tr.changes
    this.at = head
    this.held = false
  }

  /** The line the caret is on after this change is begun with nothing typed on it yet: `base` is the document as the
   *  change leaves it, so nothing the change did (on this line or any other) is ever read as typed on the line. */
  private beginAfter(tr: Transaction): void {
    this.base = tr.newDoc
    this.typed = ChangeSet.empty(tr.newDoc.length)
    this.at = tr.state.selection.main.head
    this.held = false
  }

  /** Put a change the app made into `base` (`carried`); when that cannot be done exactly `base` is given up: no form is
   *  set for this line, and the next line begun takes a new one. */
  private carry(tr: Transaction): void {
    if (this.base == null || this.typed == null) return
    const next = carried({ base: this.base, typed: this.typed }, tr)
    this.base = next?.base ?? null
    this.typed = next?.typed ?? null
    if (!next) this.held = true
  }

  /** The line is left as the document stands (the caret moved away, or the editor lost focus). */
  settle(): void {
    if (this.base != null || this.earlier) this.leave(this.view.state.doc, null)
    this.reached.note(this.view.state.doc, undoDepth(this.view.state), this.holding())
  }

  /**
   * The line being edited is left (`doc` is the document as it is left in). Its check waits one microtask (a view cannot
   * dispatch inside an update) and is then made, whatever left the line, on the document as it is at that moment: the
   * rule is asked with `base` and that document, and what it writes is dispatched to that same document in the same
   * step. No decision is kept from one document to another: if the document changed in between, the check is not made.
   *
   * One line of grace: if the rule writes nothing for this line and the line left before it kept its "before"
   * (`earlier`), the rule is asked once more, about the same document, with that one (a `- Author <link>` line left by
   * Enter is a list slide until the empty item the Enter made is taken out again). `earlier` is discarded here whatever
   * the answer. If nothing is written at all, this line's own "before" is kept in turn for the line under it (`grace`).
   */
  private leave(doc: Text, grace: LeftLine['grace']): void {
    const base = this.base
    const earlier = this.earlier
    this.base = null
    this.typed = null
    this.earlier = null
    this.check(doc, base, earlier, grace)
  }

  /** Queue the check of `base` and then `earlier` (see `leave`); `doc` is the document as it stands now. */
  private check(doc: Text, base: Text | null, earlier: Earlier | null, grace: LeftLine['grace']): void {
    // The two lines `earlier` is for are the one above this line and this line.
    if (earlier && doc.lineAt(earlier.top).number + 1 !== doc.lineAt(this.at).number) earlier = null
    if ((base == null && !earlier) || this.destroyed) return
    const line: LeftLine = { base, earlier, grace, dropped: false }
    this.left.push(line)
    queueMicrotask(() => {
      this.left = this.left.filter((other) => other !== line)
      if (line.dropped || this.destroyed) return
      const now = this.view.state
      let outline: string | null = null
      for (const before of [base, earlier?.base]) {
        if (!before || now.doc.eq(before)) continue
        outline ??= now.doc.toString()
        const written = setFormOnLinkEdits(before.toString(), outline, this.layoutAt())
        if (!written.set) continue
        const change = minimalChange(outline, written.outline)
        this.view.dispatch({
          changes: { from: change.from, to: change.to, insert: change.insert },
          userEvent: 'input.type.compose',
          annotations: ownWrite.of(true),
          filter: false
        })
        return
      }
      // Nothing was written: the "before" of the line left is kept while the caret is on the line made under it.
      if (!grace || !sameLine(now.doc, now.selection.main.head, grace.next) || now.doc.lineAt(grace.top).number + 1 !== now.doc.lineAt(grace.next).number) return
      this.earlier = { base: grace.base, typed: grace.typed, top: grace.top }
      if (this.base == null && !this.held) this.at = grace.next
      this.reached.note(now.doc, undoDepth(now), this.holding())
    })
  }
}

/**
 * The extension: the paste filter and the typing watch. `layoutAt` returns the editor host's `compiledLayoutAt` (read when
 * the rule runs, so a later recompile is seen).
 */
export function quoteLinkFormExtension(layoutAt: () => CompiledLayoutAt | undefined): Extension {
  const pasteFilter = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || !tr.isUserEvent('input.paste')) return tr
    const written = setFormOnLinkEdits(tr.startState.doc.toString(), tr.newDoc.toString(), layoutAt())
    if (!written.set) return tr
    const change = minimalChange(tr.newDoc.toString(), written.outline)
    // Appended to the paste itself: one transaction, so one undo step. `sequential`: positions are in the pasted document.
    return [tr, { changes: { from: change.from, to: change.to, insert: change.insert }, sequential: true }]
  })
  const typingWatch = ViewPlugin.define<LinkEditWatch>(
    (view) => new LinkEditWatch(view, layoutAt),
    { eventHandlers: { blur(this: LinkEditWatch) { this.settle() } } }
  )
  return [pasteFilter, typingWatch]
}
