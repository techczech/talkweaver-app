// Plain view, ticket 03 (spec T5, T6): layout lines and heading tokens are hidden.
//
//  * A layout line is replaced by a zero-height block (as focusScope.ts hides lines, and for the
//    same reason it is a StateField: block decorations may not come from a plugin). Which lines
//    are layout lines is ONE rule, shared/plain-view-margin.ts hiddenLayout: every line the
//    COMPILER takes out of its slide's content as a layout line and reads whole
//    (plain-view-compiler-facts.ts), wherever it stands in the slide (ticket 11: under the
//    heading, after a blank line, among the body). Plain hides a line if and only if the compiler
//    removes it. So a `{…}` line the compiler keeps is shown: one under the talk's `#` title
//    before the first slide, a chart token that owns the list under it.
//    Consecutive hidden lines are one RUN. The line above a run is the line the caret rests on
//    (a heading, a body line, an empty line); everything below that is said of "a heading and the
//    layout lines under it" holds for any line and the run under it. A blank line directly before
//    a run, when a line follows the run, is DRAWN hidden with it, so `### T / blank / {pyramid} /
//    blank / - list` shows one blank line, not two. That is display only: the blank line is no
//    protected text, it shows while the caret is on it, and it is deleted and typed on as ever.
//  * The trailing `{…}` groups on a heading line are replaced by nothing: every group the compiler
//    takes off the title, glued to the text or after a backslash as after a space (headingTail.ts
//    reads them with the shared port of the compiler's reader). The title's own icon (an AUTHORED
//    group that holds an icon token) is iconPictures' to hide and draw, but it is part of the same
//    tail: the end of the visible text, the stretch the caret keeps out of and the span the
//    deleting keys leave alone are read for ALL the groups together, by headingTail.ts. An icon
//    group that is not authored is no title icon: it is hidden here, like any other group.
//
// The rules (third and fourth fix rounds of ticket 07; tests in
// scripts/test-plain-view-hidden-text-rules.mjs, scripts/test-plain-view-guarded-keys.mjs and
// scripts/test-plain-view-margin-and-hidden-lines.mjs):
//  - NOTHING here changes, cancels or extends a change to the document. The one transaction filter
//    returns the transaction it was given, or that transaction with a selection added after it
//    (`[tr, { selection, sequential: true }]`); it never returns a spec that holds `changes` and
//    never rebuilds a transaction, so every annotation and effect arrives as dispatched.
//  - The caret never rests between a heading's visible text and its hidden tokens, nor after them:
//    a selection endpoint that lands there is settled to the end of the visible text (`textEnd`),
//    whoever made the transaction. Two kinds are left alone: a Find match (`select.search`: the
//    span is revealed while the match is selected) and composition (`input.type.compose`: moving
//    the selection mid-composition breaks the input method).
//  - A caret the person moves onto a hidden layout line (ArrowLeft from the line under it, End in
//    the title above it) goes back to the heading's end.
//  - ArrowRight at the end of a heading's visible text, or at the heading's end when a hidden
//    layout line follows, steps over the hidden text to the next line. When the title has an icon
//    token, it steps into that token instead (the chip shows while the caret is at the end of the
//    text): that is how an icon's name is edited by hand. Inside the chip the caret moves as in
//    any text; from its end ArrowRight goes on to the next line. End always goes to the end of
//    the visible text.
//  - Backspace and Delete beside a hidden span are held by the one key rule in guardKeys.ts, which
//    reads this file's protected regions; this file binds no deleting key.
//  - Enter is not handled here. In a `##`–`######` heading it is the app's "Enter from a title"
//    (outliner.ts enterFromHeading), in Plain as in Markdown.
//  - A selection that spans a hidden layout line or a heading's hidden tokens takes them when it
//    is deleted or typed over, as it does in Markdown (and as a folded range does). When that
//    happens and the heading is still there, a notice says so; Undo restores the text.
//  - Find reveals a span while a match inside it is the selection.
//  - A Trigger line the caret is on stays visible (the provisional `{` line typed by hand) and
//    hides when the caret leaves it.
//  - What is PROTECTED is read from the document alone (`protectedRegions`, fifth fix round): the
//    headings, their trailing groups and the layout lines under them, as Plain hides them when the
//    caret is elsewhere. What the caret or a selection reveals is a matter of drawing only; the
//    settling below and the key guard read `protectedRegions`, never the decorations.
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view'
import {
  Annotation, EditorSelection, EditorState, Prec, StateField, Transaction,
  type Extension, type Range, type Text
} from '@codemirror/state'
import { notify } from '../../lib/notify'
import { headingTail, type HeadingTail } from './headingTail'
import { headingLine } from '../../../../shared/plain-view-heading-line'
import { isHeadingTailLine, outlineHeading } from '../../../../shared/plain-view-outline-lines'
import { hiddenLayoutOf, plainFactsOf } from './outlineLines'
import type { ProtectedPart, ProtectedRegion } from './protectedRegion'
import { currentFocusRange, setFocusRangeEffect, type FocusRange } from '../focusScope'

/** A hidden stretch of the document that edits and the caret keep out of. */
export interface HiddenRegion {
  from: number
  /** End of the hidden text. For a run this is the end of its last line, not the line break after it. */
  to: number
  /** End of the span edits must leave alone: `to`, plus the line break after a run. */
  guardTo: number
  /** Start of the heading line that owns it. */
  headFrom: number
  kind: 'tail' | 'run' | 'break'
  /**
   * A tail only: where the caret rests instead of in or after the hidden tokens: the end of the
   * heading's visible text, before every trailing group (headingTail.ts). Every group of one
   * heading has the same. Other kinds: `from`.
   */
  textEnd: number
  /**
   * A tail only: the end of the stretch the caret keeps out of, `(textEnd, zoneTo]`: the line's
   * end. Other kinds: `to`.
   */
  zoneTo: number
  /** A tail only: the group holds an icon token. iconPictures hides it and draws its picture; nothing is drawn for it here. */
  icon?: boolean
  /** A run only: the start of its first layout line (after a blank line drawn hidden with it). */
  linesFrom?: number
}

/** A heading's tail with what the selection reveals of it. */
export interface TailState extends HeadingTail {
  /** Groups a non-empty selection (a Find match, a drag from the text) overlaps: shown, and a place for the selection's ends. */
  revealed: ReadonlyArray<{ from: number; to: number }>
  /** The break after the heading is protected: no hidden layout line follows directly, and a line does. */
  breakAfter: boolean
}

export interface HiddenState {
  regions: readonly HiddenRegion[]
  tails: readonly TailState[]
  deco: DecorationSet
  atomic: DecorationSet
}

const hideBlock = Decoration.replace({ block: true })
const hideInline = Decoration.replace({})

export interface SelRange { from: number; to: number; head: number; empty: boolean }

function band(doc: Text, focus: FocusRange | null): { lo: number; hi: number } | null {
  if (!focus) return null
  const from = Math.min(Math.max(focus.from, 0), doc.length)
  const to = Math.min(Math.max(focus.to, 0), doc.length)
  const start = doc.lineAt(from)
  const end = to > from ? doc.lineAt(to - 1) : start
  return { lo: start.from, hi: end.to }
}

/** One heading with what Plain hides of it, read from the document alone. */
interface HeadingStructure {
  lineFrom: number
  lineTo: number
  tail: HeadingTail | null
  /** A hidden run starts directly under it. */
  runAfter: boolean
}

/** One run of hidden lines (shared/plain-view-margin.ts HiddenRun), in document positions. */
interface RunStructure {
  /** The line above the run: the caret rests at its end. */
  aboveFrom: number
  aboveTo: number
  /** The start of the heading line of the slide the lines belong to (the line above, when the compiler names none). */
  headFrom: number
  /** The hidden lines, in order. `layout` false: the blank line drawn hidden before the layout lines. */
  lines: ReadonlyArray<{ from: number; to: number; layout: boolean }>
  /** The start of the first layout line, and the end of the last. */
  layoutFrom: number
  linesTo: number
}

interface Structure { headings: HeadingStructure[]; runs: RunStructure[] }

const structureCache = new WeakMap<Text, Structure>()

function structure(doc: Text, focus: FocusRange | null): Structure {
  // The whole document's structure is kept by the document (it is read several times for one
  // transaction: the field, the filter, the key guard). Slide Focus's band is cut from it.
  let all = structureCache.get(doc)
  if (!all) { all = readStructure(doc); structureCache.set(doc, all) }
  const bounds = band(doc, focus)
  if (!bounds) return all
  const runs = all.runs.filter((r) => r.aboveFrom >= bounds.lo && r.linesTo <= bounds.hi)
  const kept = new Set(runs.map((r) => r.aboveTo))
  return {
    headings: all.headings.filter((h) => h.lineFrom >= bounds.lo && h.lineTo <= bounds.hi).map((h) => ({ ...h, runAfter: h.runAfter && kept.has(h.lineTo) })),
    runs
  }
}

function readStructure(doc: Text): Structure {
  const headings: HeadingStructure[] = []
  // Which lines are outline at all (not front matter, fenced code, a comment or notes) is the
  // compiler's answer, read once per document (outlineLines.ts): no fence is tracked here.
  // Which lines are layout lines is the compiler's answer too (hiddenLayout).
  const facts = plainFactsOf(doc)
  const read = facts.read
  const hidden = hiddenLayoutOf(doc)
  for (let n = 1; n <= doc.lines; n += 1) {
    if (read.kinds[n - 1] !== 'outline') continue
    const line = doc.line(n)
    if (!outlineHeading(read, n - 1, line.text)) continue
    // A heading with a comment in its tail is read short by the compiler: nothing of it is hidden.
    const tail = isHeadingTailLine(read, n - 1) ? headingTail(line.from, line.text) : null
    headings.push({ lineFrom: line.from, lineTo: line.to, tail, runAfter: hidden.runAfter.has(n - 1) })
  }
  const runs: RunStructure[] = []
  for (const run of hidden.runs) {
    const above = doc.line(run.above + 1)
    const lines: Array<{ from: number; to: number; layout: boolean }> = []
    for (let j = run.first; j <= run.last; j += 1) {
      const t = doc.line(j + 1)
      lines.push({ from: t.from, to: t.to, layout: hidden.set.has(j) })
    }
    const owner = facts.compiler.layoutLineHeading.get(run.layout[0])
    runs.push({
      aboveFrom: above.from, aboveTo: above.to,
      headFrom: owner === undefined ? above.from : doc.line(owner + 1).from,
      lines,
      layoutFrom: lines.find((l) => l.layout)!.from,
      linesTo: lines[lines.length - 1].to
    })
  }
  return { headings, runs }
}

/**
 * The text Plain protects in `doc`: what it hides when the caret is elsewhere. No selection is
 * read. `focus` clips to Slide Focus's band, outside which Plain hides nothing.
 *   - A heading's tail: its trailing `{…}` groups. A single key may not reach from the end of the
 *     visible text (the space before the groups included) to the line's end, nor take the line
 *     break after it when no layout line follows. The caret keeps out of `(textEnd, line end]`;
 *     the filter below puts it at `textEnd` after any transaction.
 *   - A run: hidden layout lines, with the line break before the first and after the last. The
 *     caret keeps off those lines, the end of the last one included. A blank line drawn hidden
 *     before them is not protected (the line break between it and the first layout line is).
 */
export function protectedRegions(doc: Text, focus: FocusRange | null = null): ProtectedRegion[] {
  const out: ProtectedRegion[] = []
  const { headings, runs } = structure(doc, focus)
  for (const h of headings) {
    if (!h.tail) continue
    const breakAfter = !h.runAfter && h.lineTo < doc.length
    out.push({
      kind: 'tail', anchor: h.lineFrom,
      from: h.tail.textEnd, to: h.lineTo + (breakAfter ? 1 : 0),
      zoneFrom: h.tail.textEnd + 1, zoneTo: h.lineTo, rest: h.tail.textEnd, settles: true,
      parts: h.tail.groups.map((g): ProtectedPart => ({ from: g.from, to: g.to, text: 'group ' + doc.sliceString(g.from, g.to), walk: g.icon }))
    })
  }
  for (const r of runs) {
    // One region for each stretch of consecutive layout lines (a run drawn as one may hold a blank
    // line between two of them: that line is ordinary text).
    for (let i = 0; i < r.lines.length; i += 1) {
      if (!r.lines[i].layout) continue
      let last = i
      while (last + 1 < r.lines.length && r.lines[last + 1].layout) last += 1
      const stretch = r.lines.slice(i, last + 1)
      out.push({
        kind: 'run', anchor: i === 0 ? r.aboveFrom : r.lines[i - 1].from,
        from: stretch[0].from - 1, to: Math.min(r.lines[last].to + 1, doc.length),
        zoneFrom: stretch[0].from, zoneTo: r.lines[last].to, rest: r.aboveTo, settles: false,
        parts: stretch.map((l): ProtectedPart => ({ from: l.from, to: l.to, text: 'line ' + doc.sliceString(l.from, l.to), walk: true }))
      })
      i = last
    }
  }
  return out.filter((r) => r.to > r.from).sort((x, y) => x.anchor - y.anchor || x.from - y.from)
}

/**
 * How Plain DRAWS the protected text for a selection: `sel` decides what is revealed (a Trigger
 * line the caret is on, a line or tail group a non-empty selection, a Find match, sits in).
 * Display only: what is protected is `protectedRegions`. `focus` clips to Slide Focus's band.
 */
export function computeHidden(doc: Text, sel: readonly SelRange[], focus: FocusRange | null): HiddenState {
  const regions: HiddenRegion[] = []
  const tails: TailState[] = []
  const deco: Range<Decoration>[] = []
  const atomic: Range<Decoration>[] = []

  const revealedLine = (from: number, to: number): boolean =>
    sel.some((r) => r.empty ? r.head >= from && r.head <= to : r.from >= from && r.to <= to)
  const revealedSpan = (from: number, to: number): boolean =>
    sel.some((r) => !r.empty && r.from < to && r.to > from)

  const { headings, runs } = structure(doc, focus)
  // The first drawn stretch of each run that starts directly under its line above, by that line's end.
  const drawnUnder = new Set<number>()
  for (const r of runs) {
    // Consecutive lines of the run, drawn hidden unless the caret or a match is in one. A stretch
    // that holds no layout line (the blank line alone, its layout line being shown) is not drawn.
    let start = -1
    const close = (last: number): void => {
      const first = start
      start = -1
      if (!r.lines.slice(first, last + 1).some((l) => l.layout)) return
      // The stretch starts at the line break before it (the end of the line above) and ends at the
      // last hidden line's END, not after its line break: a block replace that ends at the start of
      // the next line makes CM put the first typed character on the line after it when that line is empty.
      const prevTo = first === 0 ? r.aboveTo : r.lines[first - 1].to
      const prevEmpty = first === 0 ? r.aboveTo === r.aboveFrom : r.lines[first - 1].to === r.lines[first - 1].from
      const from = prevTo
      const to = r.lines[last].to
      if (to <= from) return
      const linesFrom = r.lines.slice(first, last + 1).find((l) => l.layout)!.from
      regions.push({ from, to, guardTo: Math.min(to + 1, doc.length), headFrom: r.headFrom, kind: 'run', textEnd: from, zoneTo: to, linesFrom })
      // Under an EMPTY line the replaced block starts at the hidden line itself: a block that
      // starts at the end of an empty line starts at that line's start too, and would take the
      // empty line with it. The caret still steps over the line break (the atomic range).
      deco.push(hideBlock.range(prevEmpty ? r.lines[first].from : from, to))
      atomic.push(hideBlock.range(from, to))
      if (first === 0) drawnUnder.add(r.aboveTo)
    }
    r.lines.forEach((t, i) => {
      if (revealedLine(t.from, t.to)) { if (start >= 0) close(i - 1) } else if (start < 0) start = i
    })
    if (start >= 0) close(r.lines.length - 1)
  }

  for (const h of headings) {
    // Trailing groups on the heading line: one tail, whatever the groups hold.
    let tailFrom: number | null = null
    const tail = h.tail
    const revealed: Array<{ from: number; to: number }> = []
    if (tail) {
      for (const g of tail.groups) {
        if (revealedSpan(g.from, g.to)) { revealed.push({ from: g.from, to: g.to }); if (!g.icon) continue }
        regions.push({ from: g.from, to: g.to, guardTo: g.to, headFrom: h.lineFrom, kind: 'tail', textEnd: tail.textEnd, zoneTo: h.lineTo, ...(g.icon ? { icon: true } : {}) })
        // The decoration covers the group only; the whitespace before it stays in the line.
        if (!g.icon) deco.push(hideInline.range(g.from, g.to))
        tailFrom ??= g.from
      }
    }
    const breakAfter = tailFrom != null && !drawnUnder.has(h.lineTo) && h.lineTo < doc.length
    if (breakAfter) {
      regions.push({ from: h.lineTo, to: h.lineTo + 1, guardTo: h.lineTo + 1, headFrom: h.lineFrom, kind: 'break', textEnd: h.lineTo, zoneTo: h.lineTo + 1 })
    }
    // Every tail is listed, drawn hidden or not: where the caret may rest is read from it.
    if (tail) tails.push({ ...tail, revealed, breakAfter: !h.runAfter && h.lineTo < doc.length })
  }
  regions.sort((x, y) => x.headFrom - y.headFrom || x.from - y.from)
  return {
    regions,
    tails,
    deco: Decoration.set(deco, true),
    atomic: Decoration.set(atomic, true)
  }
}

function selRanges(sel: EditorState['selection']): SelRange[] {
  return sel.ranges.map((r) => ({ from: r.from, to: r.to, head: r.head, empty: r.empty }))
}

/**
 * A position between a heading's visible text and its hidden tokens, or after them, goes to the
 * end of the text. Two places in that stretch are kept: inside a group a selection has revealed,
 * and inside an icon group when the caret was already at the end of the text or past it on that
 * line (`walking`: it stepped in from there to edit the icon's name).
 */
function settleTail(pos: number, tails: readonly TailState[], walking: (tail: TailState) => boolean): number {
  for (const t of tails) {
    if (pos <= t.textEnd || pos > t.lineTo) continue
    if (t.revealed.some((g) => pos >= g.from && pos <= g.to)) return pos
    if (t.groups.some((g) => g.icon && pos >= g.from && pos <= g.to) && walking(t)) return pos
    return t.textEnd
  }
  return pos
}

/**
 * A position on a hidden layout line goes back to the end of the line above it: End in a title
 * (CodeMirror takes the title and its hidden lines as one block, so End lands at the block's end)
 * stays on the title, and ArrowLeft from the line below comes back to it. Going forward over the
 * hidden lines is the keys' own step (stepOver).
 */
function settleRun(pos: number, runs: readonly RunStructure[], was: readonly number[]): number {
  for (const r of runs) {
    // The run's lines, the blank line drawn hidden with them included.
    if (pos < r.lines[0].from) break
    if (pos > r.linesTo) continue
    // A caret that was already on one of these lines (typed there by hand) moves among them.
    return was.some((head) => head >= r.lines[0].from && head <= r.linesTo) ? pos : r.aboveTo
  }
  return pos
}

const hiddenField = StateField.define<HiddenState>({
  create: (state) => computeHidden(state.doc, selRanges(state.selection), currentFocusRange(state)),
  update(value, tr) {
    // Focus range effects arrive in the same transaction; read it from the NEW state's facet.
    if (!tr.docChanged && !tr.selection && !tr.effects.length) return value
    return computeHidden(tr.newDoc, selRanges(tr.newSelection), focusAfter(tr))
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    EditorView.atomicRanges.of((view) => view.state.field(f).atomic)
  ]
})

// The focus range after this transaction, derived as focusScope's field derives it. (tr.state cannot be
// read inside a field's update: it would ask for the state this update is building.)
function focusAfter(tr: Transaction): FocusRange | null {
  let range = currentFocusRange(tr.startState)
  let set = false
  for (const e of tr.effects) if (e.is(setFocusRangeEffect)) { range = e.value; set = true }
  if (range && !set && tr.docChanged) range = { from: tr.changes.mapPos(range.from, -1), to: tr.changes.mapPos(range.to, 1) }
  return range
}

/**
 * Marks the one selection the settling filter leaves alone: a caret put at the end of a line that
 * ends in hidden tokens as the Enter key goes down, where no Enter command of the editor's keymaps
 * takes the key and the browser's own Enter is to act from there (guardKeys.ts, the Enter handler's
 * last case; it does not arise in the app).
 */
export const caretBeforeEnter = Annotation.define<boolean>()

// The one filter. It returns `tr`, or `[tr, { selection, sequential: true }]`: the transaction as
// given with a settled selection added after it. It never returns `changes`.
const filter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged && !tr.selection) return tr
  if (tr.isUserEvent('select.search') || tr.isUserEvent('input.type.compose') || tr.annotation(caretBeforeEnter)) return tr
  if (!tr.startState.field(hiddenField, false)) return tr
  const doc = tr.newDoc
  const sel = tr.newSelection
  let ranges = sel.ranges
  let moved = false

  // The person's own caret move onto a layout line (the arrow keys reach its end; nothing else of
  // theirs can) goes round it. A caret that was already on those lines stays among them.
  // The runs are the document's own (the compiler's answer, kept by the document), wherever in a
  // slide they stand; a `{…}` line that is in no run moves no caret.
  const runs = !tr.docChanged && tr.isUserEvent('select') ? structure(doc, null).runs : []
  if (runs.length) {
    const was = tr.startState.selection.ranges.filter((r) => r.empty).map((r) => r.head)
    ranges = ranges.map((r) => {
      const anchor = settleRun(r.anchor, runs, was), head = settleRun(r.head, runs, was)
      if (anchor === r.anchor && head === r.head) return r
      moved = true
      return EditorSelection.range(anchor, head)
    })
  }

  // The person's own selection that lies wholly inside a heading's hidden tokens is a caret at the
  // end of the title text. (A click to the right of such a title arrives from CodeMirror as a
  // range over the hidden token; left alone it would select and reveal it.) A selection that
  // reaches in from the text is left as made, and so is one made by code (Replace's next match).
  if (!tr.docChanged && tr.isUserEvent('select') && ranges.some((r) => !r.empty)) {
    const bare = protectedRegions(doc).filter((t) => t.kind === 'tail')
    ranges = ranges.map((r) => {
      if (r.empty) return r
      const tail = bare.find((t) => r.from >= t.rest && r.to <= t.zoneTo)
      if (!tail) return r
      moved = true
      return EditorSelection.cursor(tail.rest)
    })
  }

  // Heading tails, for every transaction: read on the document and the selection it leaves.
  const next = moved ? EditorSelection.create(ranges, sel.mainIndex) : sel
  const tails = computeHidden(doc, selRanges(next), null).tails
  if (tails.length) {
    // The caret was at the end of this title's text, or past it, before the transaction.
    const was = tr.startState.selection.main
    const walking = (tail: TailState): boolean => {
      if (!was.empty) return false
      const line = tr.startState.doc.lineAt(was.head)
      if (tr.changes.mapPos(line.from, -1) !== tail.lineFrom) return false
      const before = headingTail(line.from, line.text)
      return !!before && was.head >= before.textEnd
    }
    ranges = ranges.map((r) => {
      const anchor = settleTail(r.anchor, tails, walking), head = settleTail(r.head, tails, walking)
      if (anchor === r.anchor && head === r.head) return r
      moved = true
      return EditorSelection.range(anchor, head)
    })
  }
  if (!moved) return tr
  return [tr, { selection: EditorSelection.create(ranges, sel.mainIndex), sequential: true }]
})

/**
 * A step to the right from the end of a heading's visible text goes over its hidden tokens and
 * layout lines to the next line. "The end" is the end of the title text when hidden tokens follow
 * it, or the line's end when a hidden layout line does.
 */
function stepOver(view: EditorView, extend: boolean): boolean {
  const state = view.state
  const sel = state.selection.main
  if (!extend && !sel.empty) return false
  const { regions, tails } = state.field(hiddenField)
  const doc = state.doc
  const line = doc.lineAt(sel.head)
  const tail = tails.find((t) => t.lineFrom === line.from)
  // In the title's tail the caret is at the end of the text, or in an icon token it stepped into.
  const inChip = tail?.groups.find((g) => g.icon && sel.head > tail.textEnd && sel.head >= g.from && sel.head <= g.to)
  if (inChip && sel.head < inChip.to) return false // inside the chip: one character on, as in any text
  const atTail = !!tail && (sel.head === tail.textEnd || !!inChip)
  if (!atTail && sel.head !== line.to) return false
  if (tail && atTail && !extend) {
    // Into the next icon token, where there is one.
    const chip = tail.groups.find((g) => g.icon && g.from >= sel.head && g !== inChip)
    if (chip) {
      view.dispatch({ selection: EditorSelection.cursor(chip.from), scrollIntoView: true, userEvent: 'select' })
      return true
    }
  }
  const run = regions.find((r) => r.kind === 'run' && r.from === line.to)
  if (!atTail && !run) return false
  const target = run ? run.to + 1 : line.to + 1
  if (target > doc.length) return atTail // nothing after the heading to step onto: stay (not into the hidden tokens)
  if (target <= sel.head) return false
  view.dispatch({
    selection: extend ? EditorSelection.range(sel.anchor, target) : EditorSelection.cursor(target),
    scrollIntoView: true,
    userEvent: 'select'
  })
  return true
}

/**
 * End on a heading that has hidden tokens, or on any line with a hidden layout line under it, goes
 * to the end of the title text (of the line). A key rule, because with line wrapping on CodeMirror finds the row's end by a point
 * on screen, and for a title whose block also holds hidden lines that point resolves to the line
 * below (seen in the app: End in such a title put the caret on the body line). Other lines: false.
 */
function endOfTitle(view: EditorView, extend: boolean): boolean {
  const state = view.state
  const sel = state.selection.main
  const line = state.doc.lineAt(sel.head)
  const { regions, tails } = state.field(hiddenField)
  // (Any line with a hidden run under it, a heading or not: the block is the same.)
  const tail = headingLine(line.text) ? tails.find((t) => t.lineFrom === line.from) : undefined
  if (!tail && !regions.some((r) => r.kind === 'run' && r.from === line.to)) return false
  const target = tail ? tail.textEnd : line.to
  view.dispatch({
    selection: extend ? EditorSelection.range(sel.anchor, target) : EditorSelection.cursor(target),
    scrollIntoView: true,
    userEvent: 'select'
  })
  return true
}

/** The user's own edits and moves (typing, deleting, pasting, cutting, dragging); not undo or code. */
function isInteractive(tr: Transaction): boolean {
  return tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move')
}

/** True when this transaction deleted a hidden layout line or hidden heading tokens whose heading is still there. */
function removedHiddenText(tr: Transaction): boolean {
  if (!tr.docChanged || !isInteractive(tr) || tr.isUserEvent('delete.slide') || tr.annotation(Transaction.remote)) return false
  const regions = tr.startState.field(hiddenField, false)?.regions ?? []
  for (const r of regions) {
    if (r.kind === 'break' || r.icon) continue
    const textFrom = r.kind === 'run' ? r.linesFrom ?? r.from + 1 : r.from // a run starts at the line break before it
    let gone = false
    // The change starts after the heading's own start, so its `#` marks are still there.
    tr.changes.iterChangedRanges((fromA, toA) => { if (fromA > r.headFrom && fromA <= textFrom && toA >= r.to) gone = true })
    if (!gone) continue
    const at = tr.changes.mapPos(r.headFrom, -1)
    const line = tr.newDoc.lineAt(at)
    if (line.from === at && headingLine(line.text)) return true
  }
  return false
}

// Observation only: it never blocks and never writes.
const removalNotice = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return
  for (const tr of update.transactions) {
    if (removedHiddenText(tr)) notify('A slide\'s layout line was removed with the selection. Undo restores it.', 'warning', 'plain-hidden-removed')
  }
})

/**
 * The protected text of this state's document (read by guardKeys.ts), and of the document a
 * transaction leaves. None where Plain's hiding is not installed (Markdown mode).
 */
export function hiddenProtectedRegions(state: EditorState): ProtectedRegion[] {
  return state.field(hiddenField, false) ? protectedRegions(state.doc, currentFocusRange(state)) : []
}
export function hiddenProtectedRegionsAfter(tr: Transaction): ProtectedRegion[] {
  return tr.startState.field(hiddenField, false) ? protectedRegions(tr.newDoc, focusAfter(tr)) : []
}

/**
 * Each blank line Plain draws hidden with the layout lines under it, as [from, to] (display only:
 * the line is no protected text). Read by the key guard: a single key may not make such a line
 * anywhere but under the caret.
 */
export function hiddenBlankLines(doc: Text): Array<[number, number]> {
  return structure(doc, null).runs.filter((r) => !r.lines[0].layout).map((r): [number, number] => [r.lines[0].from, r.lines[0].to])
}

/** The tail of the heading on the line that starts at `lineFrom`, when it has hidden groups. */
export function tailOnLine(state: EditorState, lineFrom: number): TailState | null {
  return state.field(hiddenField, false)?.tails.find((t) => t.lineFrom === lineFrom) ?? null
}

export function hiddenLinesExtension(): Extension {
  return [
    hiddenField,
    filter,
    removalNotice,
    Prec.high(keymap.of([
      { key: 'ArrowRight', run: (v) => stepOver(v, false), shift: (v) => stepOver(v, true) },
      // The other keys that step one place to the right (by word; the macOS Ctrl-F).
      { key: 'Alt-ArrowRight', mac: 'Alt-ArrowRight', run: (v) => stepOver(v, false) },
      { mac: 'Ctrl-f', run: (v) => stepOver(v, false) },
      { key: 'End', mac: 'Mod-ArrowRight', run: (v) => endOfTitle(v, false), shift: (v) => endOfTitle(v, true) },
      { mac: 'End', run: (v) => endOfTitle(v, false), shift: (v) => endOfTitle(v, true) },
      { mac: 'Ctrl-e', run: (v) => endOfTitle(v, false) }
    ]))
  ]
}

/** The hidden regions now in force (for tests and the margin). */
export function hiddenRegions(state: EditorState): readonly HiddenRegion[] {
  return state.field(hiddenField, false)?.regions ?? []
}
