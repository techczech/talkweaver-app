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
  StateEffect,
  StateField,
  Transaction,
  type Text,
  type Extension
} from '@codemirror/state'

// Absolute document offsets bounding a focused slide's block. `from` inclusive, `to` the upper edge
// (an insertion at `to` grows the block — see changesTouchOutside).
export type FocusRange = { from: number; to: number }

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
  return { from, to }
}

// The visible band's first/last line objects for `range`. `to` is the block's exclusive-ish upper
// edge, so when it lands on a following line's start we step back one position to stay on the
// block's real last line.
function bandLines(doc: Text, range: FocusRange): { startLine: ReturnType<Text['lineAt']>; endLine: ReturnType<Text['lineAt']> } {
  const from = clampNum(range.from, 0, doc.length)
  const to = clampNum(range.to, 0, doc.length)
  const startLine = doc.lineAt(from)
  const endLine = to > from ? doc.lineAt(to - 1) : doc.lineAt(from)
  return { startLine, endLine }
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
// band sits flush at the top/bottom with no phantom blank line. At most two ranges regardless of
// document size.
function buildHideDecorations(doc: Text, range: FocusRange | null): DecorationSet {
  if (!range) return Decoration.none
  const { startLine, endLine } = bandLines(doc, range)
  const ranges = []
  if (startLine.from > 0) ranges.push(hideBlock.range(0, startLine.from))
  if (endLine.to < doc.length) ranges.push(hideBlock.range(endLine.to, doc.length))
  return Decoration.set(ranges)
}

// State carried by the single focus-scope field: the live range plus its derived hide decorations.
// Keeping them together avoids cross-field ordering hazards (the decorations always match the range
// they were built from) and lets EditorView.decorations read straight off this one field.
type ScopeState = { range: FocusRange | null; deco: DecorationSet }

// Task 9 (and the e2e seam) set/clear/switch the focused range by dispatching this effect. null
// exits focus. The value is normalized to the current document on adoption.
export const setFocusRangeEffect = StateEffect.define<FocusRange | null>()

// Window CustomEvent name — the e2e harness dispatches `new CustomEvent(FOCUS_SCOPE_EVENT, { detail:
// {from,to} | null })` to drive focus before Task 9's Slide Focus surface exists. Editor.tsx listens
// and forwards to setFocusRange, mirroring KEYMAP_CHANGED_EVENT.
export const FOCUS_SCOPE_EVENT = 'tw-focus-scope'

function makeField(getRange?: () => FocusRange | null): StateField<ScopeState> {
  return StateField.define<ScopeState>({
    create(state) {
      const range = normalizeRange(getRange ? getRange() : null, state.doc)
      return { range, deco: buildHideDecorations(state.doc, range) }
    },
    update(value, tr) {
      let range = value.range
      let fromEffect = false
      for (const e of tr.effects) {
        if (e.is(setFocusRangeEffect)) {
          range = normalizeRange(e.value, tr.newDoc)
          fromEffect = true
        }
      }
      // No explicit set → track the band through the edit so it grows/shrinks with typing inside it.
      // from maps left (an insert at the very start stays outside the marker); to maps right (an
      // insert at the end extends the block).
      if (!fromEffect && range && tr.docChanged) {
        range = { from: tr.changes.mapPos(range.from, -1), to: tr.changes.mapPos(range.to, 1) }
      }
      if (range === value.range && !tr.docChanged) return value
      return { range, deco: buildHideDecorations(tr.newDoc, range) }
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.deco)
  })
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
      postRange = normalizeRange(
        { from: tr.changes.mapPos(startRange.from, -1), to: tr.changes.mapPos(startRange.to, 1) },
        tr.newDoc
      )
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

// The extension. `getRange` (optional) only SEEDS the field's initial value; the live authority is
// the StateField, driven by setFocusRange / the effect and mapped through edits. When no range is
// active the whole thing is inert. Add it once to the editor's extension list.
export function focusScopeExtension(getRange?: () => FocusRange | null): Extension {
  const field = makeField(getRange)
  return [field, makeGuard(field)]
}

// Imperative setter Task 9 (and the Editor prop effect + e2e seam) use to turn focus on/off or
// switch the focused slide without remounting the editor. null exits focus.
export function setFocusRange(view: EditorView, range: FocusRange | null): void {
  view.dispatch({ effects: setFocusRangeEffect.of(range) })
}
