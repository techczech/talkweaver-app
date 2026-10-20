// Focus-scope extension — the foundation for Slide Focus mode (ADR-0032, v0.8 Task 8).
//
// It shows and lets you edit ONLY one slide's line range while every other line is HIDDEN and
// UNTOUCHED. Crucially this is a scoped VIEW onto the SAME Outline document — never a second copy
// (ADR-0032). Same doc → same undo history, same autosave, same {id=…} identity, and every existing
// protection (idProtect chips/guards, atomic ranges, heading-survival guard) stays fully active
// INSIDE the focused band. This extension composes with those; it never replaces them.
//
// Three behaviours, all inert when there is no active range (the editor then behaves exactly as
// today — the extension contributes an empty decoration set and a pass-through transaction filter):
//
//  1. RANGE GUARD  — a transactionFilter that REJECTS any interactive doc change touching outside
//     the focused block [from, to). The block is bounded by absolute document offsets; `from` is
//     inclusive (the block's first line start), `to` is the block's upper edge — an insertion AT
//     `to` is treated as INSIDE and grows the block (typing at the end of the last line extends it).
//     Only user input/delete/move transactions are guarded (mirrors idProtect), so programmatic
//     writes — the normalizer, merge-trigger IPC, propagation, and Task 9's own range-setting —
//     are never blocked. The pure decision is `changesTouchOutside(spans, range)` (exported,
//     node-testable, no CodeMirror/DOM).
//
//  2. LINE HIDING  — Decoration.replace({block:true}) over the two regions OUTSIDE the band
//     (everything before the first visible line, and everything after the last). Hidden lines are
//     removed from the layout entirely (block widgets), so they are non-interactive. The gutter
//     keeps the TRUE outline line numbers on the visible band — CodeMirror numbers lines from the
//     document model, not the rendered layout, exactly like folding, so line 214 still reads "214".
//     Block / line-break-replacing decorations MAY NOT be produced by a ViewPlugin (CodeMirror
//     throws "Block decorations may not be specified via plugins"), so hiding is provided by a
//     StateField via EditorView.decorations — the required deviation from the task's "ViewPlugin"
//     wording. The set is at most two ranges, so recomputing it per relevant transaction is cheap.
//
//  3. CARET CONTAINMENT — the same transactionFilter clamps the resulting selection back into the
//     band, so arrow-past-the-end or a click that lands in a hidden region can't escape the scope.
//
// The band ends at the slide's last line with text, with one addition: a blank line BEGUN at its end by
// an edit inside it (Enter on the last line, a list or quotation marker emptied there) is a line of the
// band, drawn and open to the caret, so what is typed next stays on it. See begunEmptyLine. The rule
// lives in how the band is read from the range (bandLines) and in the field; the filter is unchanged.
// The stored range ends at the END of the band's last line, so every column drawn can be written to.
// Begun lines are a courtesy to the user's own typing. A change that is not the user's (a program's, an
// undo, a redo) is mapped from the end of the band's last line with text, never from a begun line, so
// nothing it puts on or under the begun lines comes into the range by position: see throughProgramChange.
// Such a change can leave the caret on a line that is no longer shown. The caret is brought back before
// any key or input acts: in the same call that made the change, not after it (settleCaret). And while
// the user composes a letter the trailing begun lines are out of the range, so a program's selection on
// them is clamped by the filter itself and the composition is not disturbed (heldForComposition).
//
// INTEGRATION SEAM (documented decision): a StateField holds the live range, driven by a
// StateEffect (`setFocusRangeEffect`, dispatched via the `setFocusRange(view, range)` helper) — NOT
// a Compartment. This is the cleaner seam here for two reasons: (a) the line-hiding decorations must
// live in a StateField anyway (see above), and (b) the field maps the range through every accepted
// change, so the band grows/shrinks as the user edits inside it WITHOUT Task 9 having to recompute
// offsets on every keystroke. Turning focus on/off or switching slides is a single effect dispatch —
// no editor remount, no compartment churn. Editor.tsx exposes a `focusRange` prop that drives this
// via an effect; the e2e harness drives the same setter through a `tw-focus-scope` window event
// (mirroring the KEYMAP_CHANGED_EVENT seam) until Task 9 builds the Slide Focus surface.

import { EditorView, Decoration, type DecorationSet } from '@codemirror/view'
import {
  EditorState,
  EditorSelection,
  Facet,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type Text,
  type Extension
} from '@codemirror/state'
import { isKeyTyped } from './keyTypedMark.ts'

// Absolute document offsets bounding a focused slide's block. `from` inclusive, `to` the upper edge
// (an insertion at `to` grows the block — see changesTouchOutside).
// `begun` is set by the field, never by a caller: the range's `to` stands at the start of ONE blank line the user begun
// under the slide's last line (Enter at its end) with the next content directly below it. Only that flag tells it
// from the end of a range set from outside at the start of the separator above the next slide (begunEmptyLine hides
// that one), so the new line is not clamped away and what is typed on it lands on it.
export type FocusRange = { from: number; to: number; begun?: true }

// One changed region in the PRE-change document, as produced by ChangeSet.iterChangedRanges.
// A pure insertion has fromA === toA; a deletion/replacement has fromA < toA.
export type ChangeSpan = { fromA: number; toA: number }

// PURE guard predicate — no CodeMirror, no DOM, so it is directly node-testable. True when ANY
// change span touches content OUTSIDE the band [from, to):
//   • insertion (fromA === toA) at point p: outside iff p < from or p > to  (AT either edge is IN;
//     an insert at `to` is allowed so the block can grow at its end).
//   • deletion/replacement [fromA, toA): outside iff it starts before `from` or ends after `to`
//     (a delete crossing a boundary is rejected; a delete fully within the band passes).
export function changesTouchOutside(spans: readonly ChangeSpan[], range: FocusRange): boolean {
  const { from, to } = range
  for (const { fromA, toA } of spans) {
    if (fromA === toA) {
      if (fromA < from || fromA > to) return true
    } else if (fromA < from || toA > to) {
      return true
    }
  }
  return false
}

function clampNum(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

// A range clamped to the document and normalized (from ≤ to), or null.
function normalizeRange(range: FocusRange | null | undefined, doc: Text): FocusRange | null {
  if (!range) return null
  const from = clampNum(Math.min(range.from, range.to), 0, doc.length)
  const to = clampNum(Math.max(range.from, range.to), 0, doc.length)
  return range.begun && range.to === to && range.from === from ? { from, to, begun: true } : { from, to }
}

// The blank line the band ends on when `to` sits on a blank line (empty, or spaces only), or null. `to` gets
// there only through an edit inside the band: Enter at the end of the slide's last line (the new line
// starts at `to`), the second Enter that empties a list or quotation marker there, or the last line's
// text deleted. That line is a line of the slide the user has begun, so it is shown and the caret may
// stand on it; hiding it sent what was typed next to another line. The blank lines directly under it
// belong to the band too (the second Enter out of a quotation puts the caret one blank line lower),
// except the last one before the next content: that one is the separator above the next slide's
// heading and stays hidden, as it is when focus is entered. At the end of the document there is no
// next content and every blank line counts. Only blank lines are ever added: a line with text
// (the next slide's heading) can never come into the band this way.
function begunEmptyLine(doc: Text, to: number): ReturnType<Text['lineAt']> | null {
  const at = doc.lineAt(to)
  if (at.text.trim() !== '') return null
  let last = at
  while (last.number < doc.lines) {
    const next = doc.line(last.number + 1)
    if (next.text.trim() !== '') break
    last = next
  }
  if (last.number === doc.lines) return last
  return last.number > at.number ? doc.line(last.number - 1) : null
}

// The visible band's first/last line objects for `range`. `to` is the block's exclusive-ish upper
// edge, so when it lands on a following line's start we step back one position to stay on the
// block's real last line, unless that following line is an empty line begun inside the band
// (begunEmptyLine).
function bandLines(doc: Text, range: FocusRange): { startLine: ReturnType<Text['lineAt']>; endLine: ReturnType<Text['lineAt']> } {
  const from = clampNum(range.from, 0, doc.length)
  const to = clampNum(range.to, 0, doc.length)
  const startLine = doc.lineAt(from)
  const soleBegun = range.begun && to > from && doc.lineAt(to).number > startLine.number && doc.lineAt(to).text.trim() === '' ? doc.lineAt(to) : null
  const endLine = to > from ? begunEmptyLine(doc, to) ?? soleBegun ?? doc.lineAt(to - 1) : doc.lineAt(from)
  return { startLine, endLine }
}

// `range` with its upper edge at the END of the band's last line when that line is blank (a begun line
// below `to`, a begun line of spaces, or the begun line left above a line the user has just emptied),
// so the range guard takes typing on every line and at every column the band shows, and the range ends
// where the band ends. A range whose band ends on a line with text is returned as it is.
function withBegunEmptyLines(doc: Text, range: FocusRange | null): FocusRange | null {
  if (!range) return null
  const { startLine, endLine } = bandLines(doc, range)
  const begun = endLine.number > startLine.number && endLine.text.trim() === ''
  if (begun && endLine.to !== range.to) return { from: range.from, to: endLine.to }
  // The flag (FocusRange.begun) is kept only while it is what puts the band's end on the sole begun blank line.
  if (range.begun && !(begun && begunEmptyLine(doc, clampNum(range.to, 0, doc.length)) === null)) return { from: range.from, to: range.to }
  return range
}

// A line that starts a slide, as slideFocusModel.ts bounds a slide's block (any `#` line, in a code
// fence too: a line too many is taken for a title, never one too few).
const TITLE_LINE = /^#{1,6}\s/

// `range` with a `to` that a change left at the very start of a title line put at the end of the line
// above, where the band ends. The line break in front of another slide's title is never inside the
// range: Delete at the end of the band cannot join that title onto the focused slide's last line.
function offTitleLine(doc: Text, range: FocusRange): FocusRange {
  if (range.to <= range.from) return range
  const at = doc.lineAt(range.to)
  return at.from === range.to && TITLE_LINE.test(at.text) ? { from: range.from, to: range.to - 1 } : range
}

// `range` mapped through the user's change `tr` (`from` left, `to` right), with `begun` set when the change left `to`
// on a blank line below the slide's first line that the change made (an insertion at the old `to`: Enter at the end of
// the slide's last line) or that was one already. See FocusRange.
function mapThroughUserChange(tr: Transaction, range: FocusRange): FocusRange {
  const from = tr.changes.mapPos(range.from, -1)
  const to = tr.changes.mapPos(range.to, 1)
  const mapped: FocusRange = { from, to }
  if (to <= from) return mapped
  const at = tr.newDoc.lineAt(to)
  // Made here: an insertion at the very end of a line of the old document (Enter at the end of the last line), not one at the start of a title that stands on `to`.
  const madeHere = tr.changes.mapPos(range.to, -1) !== to && tr.startState.doc.lineAt(range.to).to === range.to
  if (at.text.trim() === '' && at.number > tr.newDoc.lineAt(from).number && (madeHere || range.begun)) mapped.begun = true
  return mapped
}

// The range while the user composes a letter (an input method, a dead key): pulled back to the end of
// the band's last line with text when the caret's line has text. What must hold: a program's selection
// set under the caret's line while a letter is composed never moves the caret. Moving it, even there and
// straight back, takes the browser's selection out of the letter being composed, and the letter is then
// written twice. With the trailing begun lines in the range the filter takes an insertion on them, and
// a selection inside it, for the slide's own (it cannot tell whose change it is); with them out of the
// range it clamps that selection to the caret's line, as it did before begun lines existed. The lines
// are given back when the composition ends (withLinesBegunBelow). A caret on a blank line keeps them:
// its own line is one of them.
function heldForComposition(doc: Text, range: FocusRange, head: number): FocusRange {
  if (doc.lineAt(head).text.trim() === '') return range
  const { startLine, endLine } = bandLines(doc, range)
  let content = endLine
  while (content.number > startLine.number && content.text.trim() === '') content = doc.line(content.number - 1)
  return content.to < range.to ? { from: range.from, to: content.to } : range
}

// `range` with the blank lines directly under its last line taken in again, by the rule of
// begunEmptyLine (all but the last one before the next content), after heldForComposition dropped them.
function withLinesBegunBelow(doc: Text, range: FocusRange): FocusRange {
  const last = doc.lineAt(range.to)
  const begun = last.number < doc.lines ? begunEmptyLine(doc, doc.line(last.number + 1).from) : null
  return begun ? { from: range.from, to: begun.to } : range
}

// The range after a change that is NOT the user's own (a program's write, an undo, a redo, text
// dragged). What must hold: such a change brings a line into the range only where it would with no
// begun lines at all, or as a line of the focused slide itself.
//   1. In the document before the change the range is pulled back to the end of the band's last line
//      with text: the begun blank lines are dropped from it (and the line break under that line, when
//      `to` stood just after it).
//   2. That range is mapped through the change as every range was before begun lines existed (`from`
//      left, `to` right; offTitleLine). An insertion on or under a begun line is now outside it.
//   3. Of the lines from there down to where the old upper edge went, those before the first title
//      line are lines of the focused slide still (no title stands between them and it): the range is
//      taken to the last of them with text, so a redo of words typed on a begun line shows them. A
//      title line, and everything under it, stays outside.
//   4. Blank lines left directly under that line are begun lines by the rule of begunEmptyLine: all
//      but the last one before the next content.
// The guard (makeGuard) clamps the caret of that very transaction to the range mapped WITH its begun
// lines (it cannot tell whose change it is), so the change can leave the caret on a line this range no
// longer shows. settleCaret puts it back before the call that made the change returns.
function throughProgramChange(tr: Transaction, range: FocusRange): FocusRange {
  const { startLine, endLine } = bandLines(tr.startState.doc, range)
  let content = endLine
  while (content.number > startLine.number && content.text.trim() === '') content = tr.startState.doc.line(content.number - 1)
  const pulled = Math.min(range.to, content.to)
  const doc = tr.newDoc
  const { from, to } = offTitleLine(doc, { from: tr.changes.mapPos(range.from, -1), to: tr.changes.mapPos(pulled, 1) })
  if (pulled === range.to) return { from, to }
  const lastNumber = doc.lineAt(tr.changes.mapPos(range.to, 1)).number
  let end = to
  let blank: ReturnType<Text['lineAt']> | null = null
  for (let n = doc.lineAt(to).number + 1; n <= lastNumber; n += 1) {
    const line = doc.line(n)
    if (TITLE_LINE.test(line.text)) break
    if (line.text.trim() !== '') {
      end = line.to
      blank = null
    } else if (!blank) blank = line
  }
  if (blank) end = begunEmptyLine(doc, blank.from)?.to ?? end
  return { from, to: end }
}

// The [lo, hi] positions the caret may occupy: start of the first visible line to end of the last.
function bandBounds(doc: Text, range: FocusRange): { lo: number; hi: number } {
  const { startLine, endLine } = bandLines(doc, range)
  return { lo: startLine.from, hi: endLine.to }
}

// A zero-height block widget that swallows the lines it replaces. One instance, reused.
const hideBlock = Decoration.replace({ block: true })

// Block-replace decorations for the two OUTSIDE regions. Covering the newline BETWEEN the hidden
// region and the visible band (before: [0, startLine.from); after: [endLine.to, docEnd)) means the
// band sits flush at the top/bottom with no phantom blank line. An EMPTY last line is the exception:
// a block replacement that starts where an empty line starts swallows that line, so there the hidden
// region starts after the line's own break and the empty line is drawn (a last line of spaces has
// length and is drawn like any line with text). At most two ranges regardless of document size.
function buildHideDecorations(doc: Text, range: FocusRange | null): DecorationSet {
  if (!range) return Decoration.none
  const { startLine, endLine } = bandLines(doc, range)
  const ranges = []
  if (startLine.from > 0) ranges.push(hideBlock.range(0, startLine.from))
  const hideFrom = endLine.length === 0 && endLine.number > startLine.number ? endLine.to + 1 : endLine.to
  if (hideFrom < doc.length) ranges.push(hideBlock.range(hideFrom, doc.length))
  return Decoration.set(ranges)
}

// State carried by the single focus-scope field: the live range plus its derived hide decorations.
// Keeping them together avoids cross-field ordering hazards (the decorations always match the range
// they were built from) and lets EditorView.decorations read straight off this one field. `held`: the
// trailing begun lines are out of the range for a composition (heldForComposition) and are owed back.
type ScopeState = { range: FocusRange | null; deco: DecorationSet; held: boolean }

// Task 9 (and the e2e seam) set/clear/switch the focused range by dispatching this effect. null
// exits focus. The value is normalized to the current document on adoption.
export const setFocusRangeEffect = StateEffect.define<FocusRange | null>()

// The composition has ended: the begun lines held out of the range for it are given back.
const compositionEndedEffect = StateEffect.define<null>()

// Window CustomEvent name — the e2e harness dispatches `new CustomEvent(FOCUS_SCOPE_EVENT, { detail:
// {from,to} | null })` to drive focus before Task 9's Slide Focus surface exists. Editor.tsx listens
// and forwards to setFocusRange, mirroring KEYMAP_CHANGED_EVENT.
export const FOCUS_SCOPE_EVENT = 'tw-focus-scope'

const focusRangeFacet = Facet.define<FocusRange | null, FocusRange | null>({
  combine: (values) => values.find((range) => range !== null) ?? null
})

function makeField(getRange?: () => FocusRange | null): StateField<ScopeState> {
  return StateField.define<ScopeState>({
    create(state) {
      const range = normalizeRange(getRange ? getRange() : null, state.doc)
      return { range, deco: buildHideDecorations(state.doc, range), held: false }
    },
    update(value, tr) {
      let range = value.range
      let held = value.held
      let fromEffect = false
      let ended = false
      for (const e of tr.effects) {
        if (e.is(setFocusRangeEffect)) {
          range = normalizeRange(e.value, tr.newDoc)
          fromEffect = true
          held = false
        } else if (e.is(compositionEndedEffect)) ended = true
      }
      // No explicit set → track the band through the edit so it grows/shrinks with typing inside it.
      // from maps left (an insert at the very start stays outside the marker); to maps right (an
      // insert at the end extends the block). That is for the user's own change (typed, deleted, or one
      // of the app's key commands); any other is mapped without the begun lines (throughProgramChange).
      // A blank line begun below `to` is then taken into the range (withBegunEmptyLines), so the guard
      // and the band agree on the slide's last line and on its end.
      if (!fromEffect && range && tr.docChanged) {
        range = tr.isUserEvent('input') || tr.isUserEvent('delete') || isKeyTyped(tr)
          ? offTitleLine(tr.newDoc, mapThroughUserChange(tr, range))
          : throughProgramChange(tr, range)
      }
      range = withBegunEmptyLines(tr.newDoc, range)
      if (range && !fromEffect && tr.isUserEvent('input.type.compose')) {
        const kept = heldForComposition(tr.newDoc, range, tr.newSelection.main.head)
        if (kept !== range) held = true
        range = kept
      } else if (range && held && ended) {
        range = withLinesBegunBelow(tr.newDoc, range)
        held = false
      }
      if (!range) held = false
      if (range === value.range && held === value.held && !tr.docChanged) return value
      return { range, deco: buildHideDecorations(tr.newDoc, range), held }
    },
    provide: (f) => [
      EditorView.decorations.from(f, (v) => v.deco),
      focusRangeFacet.from(f, (v) => v.range)
    ]
  })
}

/** Read the live Slide Focus range so composing StateFields can omit decorations in hidden bands. */
export function currentFocusRange(state: EditorState): FocusRange | null {
  return state.facet(focusRangeFacet)
}

function makeGuard(field: StateField<ScopeState>): Extension {
  return EditorState.transactionFilter.of((tr) => {
    const startRange = tr.startState.field(field, false)?.range ?? null

    // Resolve the POST-transaction range for caret containment: an explicit set wins; otherwise map
    // the start range through this transaction's changes.
    let postRange: FocusRange | null = null
    let hasSet = false
    for (const e of tr.effects) {
      if (e.is(setFocusRangeEffect)) {
        postRange = normalizeRange(e.value, tr.newDoc)
        hasSet = true
      }
    }
    if (!hasSet && startRange) {
      const mapped = tr.isUserEvent('input') || tr.isUserEvent('delete') || isKeyTyped(tr)
        ? mapThroughUserChange(tr, startRange)
        : { from: tr.changes.mapPos(startRange.from, -1), to: tr.changes.mapPos(startRange.to, 1) }
      postRange = normalizeRange(mapped, tr.newDoc)
    }

    if (!startRange && !postRange) return tr // fully inert when no focus is active

    // (1) RANGE GUARD — reject an interactive edit that touches outside the pre-edit band. Only
    // input/delete/move user events are guarded (idProtect discipline); delete.slide is the
    // sanctioned whole-slide removal and is exempted like idProtect's own guards.
    if (startRange && tr.docChanged) {
      const interactive =
        tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move')
      if (interactive && !tr.isUserEvent('delete.slide')) {
        const spans: ChangeSpan[] = []
        tr.changes.iterChangedRanges((fromA, toA) => spans.push({ fromA, toA }))
        if (changesTouchOutside(spans, startRange)) return [] // cancel the whole transaction
      }
    }

    // (2) CARET CONTAINMENT — clamp the resulting selection into the band. Rebuild the transaction
    // preserving its changes/effects/userEvent so history and the other filters see it unchanged.
    if (postRange) {
      const { lo, hi } = bandBounds(tr.newDoc, postRange)
      const sel = tr.newSelection
      let changed = false
      const ranges = sel.ranges.map((r) => {
        const anchor = clampNum(r.anchor, lo, hi)
        const head = clampNum(r.head, lo, hi)
        if (anchor !== r.anchor || head !== r.head) changed = true
        return EditorSelection.range(anchor, head)
      })
      if (changed) {
        const userEvent = tr.annotation(Transaction.userEvent)
        return {
          changes: tr.changes,
          selection: EditorSelection.create(ranges, sel.mainIndex),
          effects: tr.effects,
          scrollIntoView: tr.scrollIntoView,
          ...(userEvent ? { userEvent } : {})
        }
      }
    }
    return tr
  })
}

// After a change that left the caret outside the band (only a change that is not the user's can: see
// throughProgramChange), one selection-only transaction is sent through the guard, which clamps the
// caret into the band as it does for every transaction. What must hold: when the call that made the
// change returns, the caret is in the band. Nothing can act at a caret on a hidden line: not a key
// pressed next in the same task, and not the app's own key commands (Enter on a title or a list item,
// outliner.ts), which carry no user event, are not guarded, and would write on a line of another slide.
// So the transaction is sent from the update listener itself, which the view calls once its own update
// is over, never from a queued task. The
// listener is at the lowest precedence: every other listener has seen the change before it sees the
// caret put back, the two in the order they were made.
function settleCaret(field: StateField<ScopeState>): Extension {
  const outside = (state: EditorState): boolean => {
    const range = state.field(field, false)?.range
    if (!range) return false
    const { lo, hi } = bandBounds(state.doc, range)
    return state.selection.ranges.some((r) => r.from < lo || r.to > hi)
  }
  return Prec.lowest(EditorView.updateListener.of((update) => {
    const view = update.view
    if (update.docChanged && outside(view.state)) view.dispatch({ selection: view.state.selection })
  }))
}

// The begun lines held out of the range while a letter was composed (heldForComposition) are given back
// once the view is no longer composing: after the composition's last change, and after a composition
// that ended with no further change. The second is sent in a task of its own, never in the event's: the
// browser's last change to the letter is not yet read by the view then, and a transaction sent before
// it is read loses it (the last letter of the word was dropped). The lines given back are blank and
// hold no caret, so nothing can act on them in between.
function releaseHeldLines(field: StateField<ScopeState>): Extension {
  const release = (view: EditorView): void => {
    if (view.dom.parentNode && !view.composing && view.state.field(field, false)?.held) view.dispatch({ effects: compositionEndedEffect.of(null) })
  }
  return [
    Prec.lowest(EditorView.updateListener.of((update) => release(update.view))),
    EditorView.domEventObservers({ compositionend: (_event, view) => { setTimeout(() => release(view), 0) } })
  ]
}

// The extension. `getRange` (optional) only SEEDS the field's initial value; the live authority is
// the StateField, driven by setFocusRange / the effect and mapped through edits. When no range is
// active the whole thing is inert. Add it once to the editor's extension list.
export function focusScopeExtension(getRange?: () => FocusRange | null): Extension {
  const field = makeField(getRange)
  return [field, makeGuard(field), settleCaret(field), releaseHeldLines(field)]
}

// Imperative setter Task 9 (and the Editor prop effect + e2e seam) use to turn focus on/off or
// switch the focused slide without remounting the editor. null exits focus.
export function setFocusRange(view: EditorView, range: FocusRange | null): void {
  view.dispatch({ effects: setFocusRangeEffect.of(range) })
}
