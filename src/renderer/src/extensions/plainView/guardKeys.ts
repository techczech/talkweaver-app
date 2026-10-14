// Plain view, ticket 07 (fourth fix round): the one key rule that keeps a single key press from
// deleting or exposing text that Plain hides.
//
// Hidden spans are atomic ranges, so CodeMirror's deleting commands skip a whole span in one
// press: Delete at the end of a title would take its tokens, Backspace at the start of the line
// under a hidden layout line would take that line. This keymap stops the key before any change is
// made. It is a KEY rule: it returns true without dispatching, or false to let the ordinary key
// run. It never alters a transaction (no Plain filter does).
//
// The guard is DERIVED from the editor's keymap, not written as a list of keys. For every binding
// of the editor's base keymap (extensions/editorBaseKeymap.ts: CodeMirror's default keymap with
// its macOS Emacs-style keys, folding, Find), undo and redo left out, a binding for the same key
// is installed here, above it. When the key is pressed with one empty caret, and not while
// composing, that binding makes a DRY RUN: it calls the real command on a stand-in for the view
// that keeps the transaction instead of applying it and lets nothing else through (see `dryRun`).
// The key is held (true, nothing dispatched) when that transaction would
//   - delete or replace a character inside a guard span (one thing is let through: a protected
//     line break that goes together with the whole line after it, as "delete line" on the line
//     under a hidden one does; the hidden line then ends as it did), or
//   - leave something that is protected now no longer protected: a title split from its tokens,
//     a layout line parted from its heading, or
//   - put the caret on protected text it was not on before (Backspace on the empty line under a
//     layout line would put it at that line's end, where the line shows and the next Backspace
//     takes it). So an empty line directly under a slide's layout line cannot be removed with
//     Backspace in Plain; it can in Markdown.
//   - make an empty line that Plain draws hidden at once (ticket 11): a blank line directly
//     before a hidden layout line is drawn hidden with it (hiddenLines.ts), so a key that puts
//     one there and leaves the caret elsewhere would change the document where nobody sees it.
// Otherwise the binding answers false and the real binding runs. So Backspace, Delete, their word
// and line forms, Ctrl-H, Ctrl-D, Ctrl-K, Ctrl-Alt-H, Alt-D, Ctrl-O, Ctrl-T, and whatever is bound
// later, are all held by the same test.
//
// What is protected is read from the DOCUMENT, never from what is drawn (fifth fix round): each
// owner of hidden text gives its regions for a document with no selection (protectedRegion.ts),
// so a token shown as a chip because the caret is beside it, or a layout line shown because the
// caret is on it, is protected exactly as when it is hidden.
//   hiddenLines   a heading's tail from the end of its visible text (the space before the tokens
//                 included) to the line's end, icon groups and others alike, with the line break
//                 after it when no layout line follows; every hidden layout line, wherever in
//                 its slide it stands (ticket 11), with the line breaks on both sides;
//   talkDetails   the front matter under the Talk details panel, with the line break after it;
//   iconPictures  the icon token that ends a paragraph or a list item, with the space before it.
// The caret's own place is the one thing let in: inside an icon token it stepped into, or on a
// layout line it is on (typed by hand), that token's or line's own characters are edited as text.
//
// One case changes the document, from the key handler (never from a filter): a forward deletion
// that starts at the caret in visible text and would run on into protected text on the same line
// (Ctrl-K or Cmd-Delete in the middle of a title, of a list item or paragraph that ends in an
// icon) deletes the visible text up to the protected text and stops there.
//
// The other case that changes the document from the key handler (sixth fix round): an icon belongs
// to its text. When a deletion of one character would leave a paragraph or a list item that ends
// in an icon token with no visible text (Backspace after `A` in `A {icon=…}`, Delete before it),
// the key deletes the text, the separating space and the token in one change, with the `delete`
// user event and as a history step of its own, so one Undo restores text and token. A list item
// keeps its mark. For a paragraph of several lines the rule is for the whole paragraph's text;
// when it is only the paragraph's last line that would be left with the token alone, the key
// deletes that line's text with the line break before it, and the token joins the line above
// with one space before it (`One\nA {icon=…}` becomes `One {icon=…}`), again as one Undo step.
// A title is different: its tokens stay when its text is emptied (they are its tail, not its
// text's), and typing there is the title's text again.
//
// Enter (sixth fix round) is guarded in its own way, because the commands that own it sit above
// this keymap (the app's Enter chain: "Enter from a title", "Continue list"; a completion that is
// open). Three rules:
//   - On a title that has anything hidden (a hidden option, id or icon at its end, a hidden
//     layout line under it) and that the app's "Enter from a title" does not take (it takes
//     `##`–`######` followed by a space: so the `#` title, and a title written with a tab after
//     its marks), Enter does what that command does (the same function, outliner.ts
//     enterFromHeading, called with the plain view's one answer to "is this a heading",
//     shared/plain-view-heading-line.ts): the caret goes past the hidden lines onto the first body
//     line, and a blank line is made only when there is none. A `#` title with nothing hidden is
//     split by Enter as ever.
//   - When everything from the caret to the line's end is hidden tokens and spaces (the caret at
//     the end of a title's, a paragraph's or a list item's visible text, or in a token's chip),
//     Enter acts as if from the line's end, so no token is split or parted from its text. The
//     caret is NOT moved there first (seventh fix round: Undo came back to that caret, after the
//     tokens, and its transaction passes no filter). The Enter chain is run dry from a state whose
//     caret is at the line's end, and what it asks for is dispatched from the key handler as ONE
//     transaction on the real state, so the caret Undo restores is the one the person had.
//   - The last line of defence: as the Enter key goes down, before any binding sees it, every
//     Enter binding the editor has (read from its keymaps, in their order) is run dry as one
//     command, and the result is put to the same test as any other key. Held: an Enter that would
//     split a title from its hidden tokens (Shift-Enter in the middle of a title with a hidden
//     option, at any level).
//
// Not bound here: the app's other commands (keymap/registry.ts), which run above this keymap and
// are whole-slide and formatting verbs with their own rules. Mod-Backspace and Backspace on a
// heading are idProtect's first; what they let through reaches this guard like any other key.
// A selection is not held: deleting one takes what it spans, as in Markdown.
import { EditorView, keymap, type Command, type KeyBinding } from '@codemirror/view'
import { EditorSelection, Prec, Transaction, findClusterBreak, type EditorState, type Extension, type TransactionSpec } from '@codemirror/state'
import { isolateHistory } from '@codemirror/commands'
import { editorBaseKeymap, editorHistoryKeymap } from '../editorBaseKeymap'
import { enterFromHeading, headingEnterOwners } from '../outliner'
import { lineEndCarets } from '../headingEndInsert'
import { anyHeadingLine, headingLine } from '../../../../shared/plain-view-heading-line'
import { caretBeforeEnter, hiddenBlankLines, hiddenProtectedRegions, hiddenProtectedRegionsAfter } from './hiddenLines'
import { iconItemsOf, iconProtectedRegionsAfter, iconProtectedRegionsOf, lineEndPastTokens } from './iconPictures'
import { talkDetailsProtectedRegionsAfter, talkDetailsProtectedRegionsOf } from './talkDetails'
import { guardSpansOf, inZone, inventoryOf, type ProtectedRegion } from './protectedRegion'

export interface GuardSpan { from: number; to: number }

/** The protected text of the state's document, from the three owners. */
export function protectedRegionsOf(state: EditorState): ProtectedRegion[] {
  return [...hiddenProtectedRegions(state), ...talkDetailsProtectedRegionsOf(state), ...iconProtectedRegionsOf(state)]
}
/** The protected text of the document a transaction leaves. */
function protectedRegionsAfter(tr: Transaction): ProtectedRegion[] {
  return [...hiddenProtectedRegionsAfter(tr), ...talkDetailsProtectedRegionsAfter(tr), ...iconProtectedRegionsAfter(tr)]
}

const oneCaret = (state: EditorState): number => {
  const sel = state.selection
  return sel.ranges.length === 1 && sel.main.empty ? sel.main.head : -1
}

/** Every span a single deleting key must not reach into. */
export function guardSpans(state: EditorState): GuardSpan[] {
  return guardSpansOf(protectedRegionsOf(state), oneCaret(state))
}

// ── The dry run ─────────────────────────────────────────────────────────────────────────────────

/** Commands that threw on the stand-in (their keys were let through). Read by the tests. */
export const dryRunThrew: string[] = []

/**
 * The view's methods that only read and measure. They run on the real view (they read its layout,
 * and `this` must be the view for that). Every other method runs with the stand-in as `this`, so
 * what it writes is dropped and what it dispatches is kept.
 */
const READERS: ReadonlySet<PropertyKey> = new Set([
  'lineBlockAt', 'lineBlockAtHeight', 'elementAtHeight', 'moveByChar', 'moveByGroup', 'moveVertically',
  'moveToLineBoundary', 'visualLineSide', 'coordsAtPos', 'coordsForChar', 'posAtCoords', 'posAndSideAtCoords',
  'posAtDOM', 'domAtPos', 'textDirectionAt', 'bidiSpans', 'scrollSnapshot'
])
/** Methods with an effect outside the document: nothing happens on the stand-in. */
const NO_OPS: ReadonlySet<PropertyKey> = new Set([
  'focus', 'requestMeasure', 'measure', 'update', 'setState', 'setRoot', 'destroy', 'scrollIntoView'
])

const isDomNode = (value: object): boolean => typeof Node !== 'undefined' && value instanceof Node

/** What a command may ask of a DOM node on the stand-in: these read. Any other method does nothing. */
const DOM_READERS: ReadonlySet<PropertyKey> = new Set([
  'contains', 'querySelector', 'querySelectorAll', 'closest', 'matches', 'getBoundingClientRect', 'getClientRects',
  'getAttribute', 'hasAttribute', 'getRootNode', 'compareDocumentPosition', 'getSelection', 'elementFromPoint'
])

/** A property a proxy must answer with its own value (frozen: nothing can be written to it anyway). */
function fixed(obj: object, prop: PropertyKey): boolean {
  const own = Reflect.getOwnPropertyDescriptor(obj, prop)
  return !!own && !own.configurable && !own.writable && 'value' in own
}

interface Faces {
  /** The face made for an object. */
  of: WeakMap<object, object>
  /** The object behind a face (a DOM method is given the real nodes). */
  behind: WeakMap<object, object>
}

/**
 * A read-only face of one of the view's own objects (`inputState`, the viewport, a plugin's
 * value, a DOM node): reads go to the object, writes and deletions are dropped, and the objects
 * it holds are given the same face. A method runs with the face as `this`, so what it writes is
 * dropped as well. A DOM node's reading methods run on the node; its other methods (`focus`,
 * `select`, `scrollTo`, anything that changes the page) do nothing.
 */
function readOnly<T extends object>(target: T, faces: Faces): T {
  const known = faces.of.get(target)
  if (known) return known as T
  const dom = isDomNode(target)
  const real = (value: unknown): unknown => (value !== null && typeof value === 'object' ? faces.behind.get(value) ?? value : value)
  const faced = (value: unknown): unknown => (value !== null && typeof value === 'object' ? readOnly(value, faces) : value)
  const face = new Proxy(target, {
    get(obj, prop) {
      const value = Reflect.get(obj, prop, obj) as unknown
      if (fixed(obj, prop)) return value
      if (typeof value !== 'function') return faced(value)
      const fn = value as (...a: unknown[]) => unknown
      if (!dom) return (...args: unknown[]): unknown => fn.apply(face, args)
      if (!DOM_READERS.has(prop)) return (): void => {}
      return (...args: unknown[]): unknown => faced(fn.apply(obj, args.map(real)))
    },
    set: () => true,
    defineProperty: () => true,
    deleteProperty: () => true
  })
  faces.of.set(target, face)
  faces.behind.set(face, target)
  return face
}

/**
 * What the command would dispatch, without dispatching it, and with NO other effect: the command
 * runs on an isolated stand-in, a proxy of the view on which
 *   - `dispatch` keeps the transaction, and the state's `update` builds it with `filter: false`,
 *     so what is read is what the command ASKS for (read after the filters, a deletion that the
 *     app's token protection refuses in part would look harmless here, be let through, and move
 *     the caret);
 *   - a write to the view is dropped, and so is a write to an object the view holds (`inputState`:
 *     Tab focus mode lives there, and a toggle run here would be toggled back by the real key);
 *   - `focus`, `requestMeasure` and the other methods with an effect do nothing; a plugin's value
 *     and a DOM node are read through a face on which nothing is written and no method that
 *     changes the page runs (an open Find panel is not focused or filled);
 *   - the methods that read the layout (where a line ends on screen) are the view's own.
 * null when the command declines or dispatches nothing. A command that throws here is taken as
 * one that asks for nothing (the key is not held) and is named in `dryRunThrew`.
 * `from`: the state the command reads and builds its transaction on, when it is not the view's
 * own (the Enter rule: the same document, the caret at the line's end).
 */
export function dryRun(view: EditorView, command: Command, from: EditorState = view.state): Transaction | null {
  const real = from
  const asked = (...specs: TransactionSpec[]): Transaction => real.update(...specs, { filter: false })
  let captured: Transaction | null = null
  const dispatch = (...input: unknown[]): void => {
    const first = input[0]
    if (first instanceof Transaction) captured ??= first
    else if (Array.isArray(first)) captured ??= (first[0] as Transaction | undefined) ?? null
    else captured ??= asked(...(input as TransactionSpec[]))
  }
  const state = Object.create(real, { update: { value: asked } }) as EditorState
  const faces: Faces = { of: new WeakMap(), behind: new WeakMap() }
  const nothing = (): void => {}
  const standIn: EditorView = new Proxy(view, {
    get(target, prop) {
      if (prop === 'dispatch') return dispatch
      if (prop === 'state') return state
      if (NO_OPS.has(prop)) return nothing
      const value = Reflect.get(target, prop, target) as unknown
      if (fixed(target, prop)) return value
      if (typeof value === 'function') {
        const fn = value as (...a: unknown[]) => unknown
        if (READERS.has(prop)) return fn.bind(target)
        // A plugin's value is read through a face.
        if (prop === 'plugin') return (...args: unknown[]): unknown => { const v = fn.apply(target, args); return v !== null && typeof v === 'object' ? readOnly(v, faces) : v }
        return (...args: unknown[]): unknown => fn.apply(standIn, args)
      }
      return value !== null && typeof value === 'object' ? readOnly(value, faces) : value
    },
    set: () => true,
    defineProperty: () => true,
    deleteProperty: () => true
  })
  try {
    if (!command(standIn)) return null
  } catch {
    const name = command.name || 'unnamed command'
    if (!dryRunThrew.includes(name)) dryRunThrew.push(name)
    return null
  }
  return captured
}

/** `had` minus `has`, as a multiset: true when something in `had` is missing from `has`. */
function lost(had: readonly string[], has: readonly string[]): boolean {
  const left = new Map<string, number>()
  for (const text of has) left.set(text, (left.get(text) ?? 0) + 1)
  for (const text of had) {
    const n = left.get(text) ?? 0
    if (n === 0) return true
    left.set(text, n - 1)
  }
  return false
}

/**
 * An icon belongs to its text. When deleting `[from, to)`, one character of the visible text of a
 * paragraph or a list item that ends in an icon token, would leave that text empty, this is what
 * goes in its place: the text, the separating space and the token (a list item's mark stays).
 * When only the last line of a paragraph of several lines would be left empty, it is that line's
 * text and the line break before it, so the token joins the line above. null for any other deletion. A title's tokens are its tail and stay (hiddenLines).
 */
function textWithItsIcon(state: EditorState, from: number, to: number): { from: number; to: number } | null {
  const deleted = state.doc.sliceString(from, to)
  if (!deleted || findClusterBreak(deleted, 0) !== deleted.length) return null
  for (const item of iconItemsOf(state)) {
    if (item.kind === 'heading' || from < item.textFrom || to > item.textEnd) continue
    // The paragraph's whole visible text (its first line's start to the end of its last line's text).
    const left = state.doc.sliceString(item.textFrom, from) + state.doc.sliceString(to, item.textEnd)
    if (!/\S/.test(left)) return { from: item.textFrom, to: item.to }
    // The paragraph has other lines, and its last line (the token's) would be left with the token
    // alone, which is no icon at all: that line's text goes with the line break before it, and
    // the token joins the line above, one space before it.
    const last = state.doc.lineAt(item.to)
    if (item.kind !== 'paragraph' || last.from <= item.lineFrom || from < last.from) return null
    if (/\S/.test(state.doc.sliceString(last.from, from) + state.doc.sliceString(to, item.textEnd))) return null
    const above = state.doc.lineAt(last.from - 1)
    return { from: above.from + above.text.trimEnd().length, to: item.textEnd }
  }
  return null
}

/**
 * Whether the key is held; when it is, a deletion that stops at the hidden text, or one that takes
 * a text's icon with its last character, may be made in its place (`partial`; not for Enter, which
 * deletes nothing of the person's). `state`: where the key acts from, when it is not the view's
 * own state (the Enter rule; never with `partial`).
 */
function held(view: EditorView, command: Command, partial = true, state: EditorState = view.state): boolean {
  if (view.composing) return false
  const sel = state.selection
  if (sel.ranges.length !== 1 || !sel.main.empty) return false
  const regions = protectedRegionsOf(state)
  if (!regions.length) return false
  const head = sel.main.head
  const spans = guardSpansOf(regions, head)
  const tr = dryRun(view, command, state)
  if (!tr || !tr.docChanged) return false

  let hit: GuardSpan | null = null
  let ranges = 0
  let from = -1, to = -1, inserted = 0
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, text) => {
    ranges += 1
    from = fromA; to = toA; inserted = text.length
    if (toA === fromA) return
    for (const span of spans) {
      if (fromA >= span.to || toA <= span.from) continue
      // A protected line break alone may go in one way: with the whole line after it (a deletion
      // from the break to that line's end), which leaves the hidden line ending as it did.
      const a = Math.max(fromA, span.from)
      const onlyBreaks = !/[^\n]/.test(state.doc.sliceString(a, Math.min(toA, span.to)))
      if (onlyBreaks && text.length === 0 && fromA === a && toA === state.doc.lineAt(toA).to) continue
      if (!hit || span.from < hit.from) hit = span
    }
  })
  const first = hit as GuardSpan | null
  if (first) {
    // A forward deletion from the caret that runs into hidden text on the caret's line: the
    // visible text goes, the hidden text stays.
    const line = state.doc.lineAt(head)
    if (partial && ranges === 1 && inserted === 0 && from === head && first.from > head && first.from <= line.to && to > first.from) {
      view.dispatch({ changes: { from: head, to: first.from }, scrollIntoView: true, userEvent: 'delete' })
    }
    return true
  }
  // The last visible character of a paragraph or list item that ends in an icon: the icon goes
  // with it, in one change that one Undo takes back.
  if (partial && ranges === 1 && inserted === 0) {
    const whole = textWithItsIcon(state, from, to)
    if (whole) {
      view.dispatch({ changes: whole, scrollIntoView: true, userEvent: 'delete', annotations: isolateHistory.of('full') })
      return true
    }
  }
  // Nothing protected was touched. Is everything that is protected now still protected after it?
  // (What the caret is editing by hand, a token it stepped into, is its own to change.)
  const after = protectedRegionsAfter(tr)
  if (lost(inventoryOf(regions, head), inventoryOf(after, -1))) return true
  // A key may not make an empty line that is drawn hidden at once (ticket 11: Ctrl-O at the end
  // of a line with a hidden layout line under it would put an empty line between the two, which
  // Plain draws hidden with the layout line: a change nobody sees). An empty line the caret
  // arrives on is shown, and is the person's to type on (Enter at the end of a body line).
  if (hiddenProtectedRegions(state).length) {
    const were = new Set(hiddenBlankLines(state.doc).flatMap(([p]) => [tr.changes.mapPos(p, -1), tr.changes.mapPos(p, 1)]))
    const caret = tr.newSelection.main
    for (const [p, end] of hiddenBlankLines(tr.newDoc)) {
      if (!were.has(p) && !(caret.empty && caret.head >= p && caret.head <= end)) return true
    }
  }
  // And the caret: it may not arrive on protected text (there the text shows, and the next key
  // would be pressed inside it). A caret that was already on that region goes on moving in it; a
  // region whose owner puts the caret back after any change (a title's tail) needs no holding.
  const next = tr.newSelection.main
  for (const pos of next.empty ? [next.head] : [next.anchor, next.head]) {
    const into = after.find((r) => !r.settles && inZone(r, pos))
    if (!into) continue
    const same = regions.some((r) => r.kind === into.kind && inZone(r, head) && tr.changes.mapPos(r.anchor, -1) === into.anchor)
    if (!same) return true
  }
  return false
}

const guard = (command: Command) => (view: EditorView): boolean => held(view, command)

/** A binding of the base keymap that this guard stands in front of. */
function guarded(binding: KeyBinding): boolean {
  if (editorHistoryKeymap.includes(binding)) return false
  if (binding.scope && !binding.scope.split(' ').includes('editor')) return false
  // Enter has its own rules (see the head of this file).
  return ![binding.key, binding.mac, binding.win, binding.linux].some((key) => key === 'Enter')
}

/** The guard's bindings: the same keys, on the same platforms, as the bindings they stand in front of. */
export function guardBindings(base: readonly KeyBinding[] = editorBaseKeymap): KeyBinding[] {
  const out: KeyBinding[] = []
  for (const binding of base) {
    if (!guarded(binding) || (!binding.run && !binding.shift)) continue
    out.push({
      ...(binding.key !== undefined ? { key: binding.key } : {}),
      ...(binding.mac !== undefined ? { mac: binding.mac } : {}),
      ...(binding.win !== undefined ? { win: binding.win } : {}),
      ...(binding.linux !== undefined ? { linux: binding.linux } : {}),
      ...(binding.run ? { run: guard(binding.run) } : {}),
      ...(binding.shift ? { shift: guard(binding.shift) } : {})
    })
  }
  return out
}

// ── Enter ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Enter on a title that has anything hidden (a tail of hidden groups, a hidden layout line under
 * it): the app's "Enter from a title", for every line the plain view reads as a heading. The app
 * binds that command above this one for `##`–`######` followed by a space, so what arrives here is
 * the `#` title and a title written with a tab after its marks. With one empty caret; a
 * selection, and a title with nothing hidden, are the ordinary Enter's.
 */
export function enterFromTitleOverHiddenLines(view: EditorView): boolean {
  if (view.composing) return false
  const state = view.state
  const head = oneCaret(state)
  if (head < 0) return false
  const line = state.doc.lineAt(head)
  if (!headingLine(line.text)) return false
  if (!hiddenProtectedRegions(state).some((r) => (r.kind === 'run' || r.kind === 'tail') && r.anchor === line.from)) return false
  return enterFromHeading(view, anyHeadingLine)
}

/** The name a binding has on this platform, as CodeMirror reads it. */
function keyName(binding: KeyBinding): string | undefined {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform
  const own = /Mac/.test(platform) ? binding.mac : /Win/.test(platform) ? binding.win : /Linux|X11/.test(platform) ? binding.linux : undefined
  return own ?? binding.key
}

/** Every command the editor's keymaps bind to Enter (to Shift-Enter with `shift`), in the order they are tried. */
export function enterChain(state: EditorState, shift = false): Command[] {
  const out: Command[] = []
  for (const binding of state.facet(keymap).flat()) {
    if (binding.scope && !binding.scope.split(' ').includes('editor')) continue
    const name = keyName(binding)
    if (!shift && name === 'Enter' && binding.run) out.push(binding.run)
    if (shift && name === 'Shift-Enter' && binding.run) out.push(binding.run)
    if (shift && name === 'Enter' && binding.shift) out.push(binding.shift)
  }
  return out
}

// A keydown handler at the highest precedence, not a keymap binding: every keymap binding, at any
// precedence, runs inside CodeMirror's one keydown handler, and the app's own Enter bindings (list
// continuation, heading rules) sit in a keymap that comes before this extension. A handler
// registered above that one is the only place that is reliably ahead of them all.
const enterGuard = Prec.highest(EditorView.domEventHandlers({
  keydown(event, view) {
    if (event.key !== 'Enter' || event.isComposing || view.composing) return false
    if (event.ctrlKey || event.metaKey || event.altKey) return false
    const chain = enterChain(view.state, event.shiftKey)
    const pressEnter: Command = (target) => chain.some((run) => run(target))
    const end = lineEndPastTokens(view.state)
    if (end === null) {
      // The ordinary case: the Enter is the bindings' own, unless it would expose hidden text.
      if (!chain.length || !held(view, pressEnter, false)) return false
      event.preventDefault()
      return true
    }
    // Only hidden tokens and spaces lie between the caret and the line's end: Enter as if from
    // the line's end. The state it would act on is built, not dispatched.
    const atEnd = view.state.update({ selection: EditorSelection.cursor(end), filter: false }).state
    if (chain.length && held(view, pressEnter, false, atEnd)) {
      event.preventDefault()
      return true
    }
    const tr = chain.length ? dryRun(view, pressEnter, atEnd) : null
    if (!tr) {
      // No command of the editor's keymaps takes Enter (not so in the app, whose base keymap
      // binds it): the browser's own Enter is to act, and it acts at the caret, so here the
      // caret is moved. History is told not to record that caret.
      view.dispatch({
        selection: EditorSelection.cursor(end), scrollIntoView: true,
        annotations: [caretBeforeEnter.of(true), Transaction.addToHistory.of(false)]
      })
      return false
    }
    // What the chain asked for from the line's end, as one transaction on the real state (the
    // document is the same, so the change fits). The selection history keeps for Undo is the
    // caret the person had. A change is the person's input; a caret move alone (onto the body
    // line under a title) carries no user event, as the app's own command's does not.
    view.dispatch({
      changes: tr.changes, selection: tr.newSelection, effects: tr.effects, scrollIntoView: true,
      ...(tr.docChanged ? { userEvent: 'input' } : {})
    })
    event.preventDefault()
    return true
  }
}))

export function guardKeysExtension(): Extension {
  return [
    Prec.high(keymap.of([...guardBindings(), { key: 'Enter', run: enterFromTitleOverHiddenLines }])),
    // The app's "Enter from a title" runs above the binding on the line before this one, and at the
    // end of a title it does not cover (the `#` title, a tab after the marks) it puts a new line
    // under the title's id and layout lines (headingEndInsert.ts). It asks here first, so a title
    // with hidden text keeps the rule above.
    headingEnterOwners.of(enterFromTitleOverHiddenLines),
    // A paste with the caret at the end of a title's visible text, before its hidden groups, is a
    // paste at the end of the title: the rest of it goes under the title's id and layout lines.
    lineEndCarets.of(lineEndPastTokens),
    enterGuard
  ]
}
