// Edit-protection for machine-managed and structured `{…}` tokens (Tier-1 slide-management,
// generalised 2026-07-03 after ⌘L wiped `{id=…}` — ADR-0032).
//
// Two protection tiers:
//  - `{id=…}` anywhere: quiet chip, atomic range, AND interactive edits that would touch the
//    token are BLOCKED unless the whole token's line is deleted with it (so deleting a slide
//    still works, but a stray backspace can never nibble an id — ids are ledger identity).
//  - any other `{…}` token on a Trigger line or in a heading's trailing groups: chip + atomic
//    range — the cursor skips over it, one delete removes the WHOLE token (never a half-eaten
//    `{stateme`). Prose braces elsewhere stay fully editable.
//
// Clicking a protected token reports it to the host instead of placing a cursor inside:
// the Editor routes id-clicks to the where-used panel and trigger-clicks to the ⌘L picker.
// Programmatic rewrites (normalizer, merge-trigger IPC, propagation) are exempt from the
// changeFilter — only user events (input/delete/move via drag) are filtered.
import { EditorView, Decoration, type DecorationSet, ViewPlugin, type ViewUpdate, keymap } from '@codemirror/view'
import { EditorState, RangeSetBuilder, Prec, type Extension, type Transaction } from '@codemirror/state'
import { notify } from '../lib/notify'
import { effectiveKeys } from '../keymap/store'
import { displayKeys } from '../keymap/registry'

// `{id=<chars>}` — opaque short id (letters/digits/_/-). Matches the autocomplete's inserted form.
const ID_RE = /\{id=[A-Za-z0-9_-]+\}/g
const TOKEN_RE = /\{[^}]*\}/g
// A line consisting only of `{…}` groups — the Trigger line (ADR-0015).
const TRIGGER_ONLY_LINE_RE = /^\s*(\{[^}]*\}\s*)+$/
const HEADING_RE = /^#{1,6}\s/
// Trailing `{…}` groups on a heading line (triggers carried on the heading itself).
const HEADING_TAIL_RE = /((?:\s*\{[^}]*\})+)\s*$/

export type ProtectedTokenKind = 'id' | 'trigger'
export type ProtectedTokenClickHandler = (token: string, kind: ProtectedTokenKind) => void

type TokenSpan = { from: number; to: number; kind: ProtectedTokenKind; text: string }

// All protected token spans on ONE line. Ids are protected wherever they appear; other
// tokens only when the line is a Trigger line or they sit in a heading's trailing groups.
function lineTokenSpans(lineText: string, lineFrom: number): TokenSpan[] {
  const spans: TokenSpan[] = []
  const push = (m: RegExpMatchArray, offset: number): void => {
    const text = m[0]
    spans.push({
      from: lineFrom + offset + (m.index ?? 0),
      to: lineFrom + offset + (m.index ?? 0) + text.length,
      kind: /^\{id=/.test(text) ? 'id' : 'trigger',
      text
    })
  }
  if (TRIGGER_ONLY_LINE_RE.test(lineText)) {
    for (const m of lineText.matchAll(TOKEN_RE)) push(m, 0)
    return spans
  }
  if (HEADING_RE.test(lineText)) {
    const tail = lineText.match(HEADING_TAIL_RE)
    if (tail && tail.index != null) {
      for (const m of tail[1].matchAll(TOKEN_RE)) push(m, tail.index)
      return spans
    }
  }
  // Ordinary content line: only `{id=…}` tokens are protected; prose braces stay editable.
  for (const m of lineText.matchAll(ID_RE)) push(m, 0)
  return spans
}

const idMark = Decoration.mark({ class: 'cm-id-chip' })
const triggerMark = Decoration.mark({ class: 'cm-trigger-chip' })

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    let pos = from
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos)
      for (const span of lineTokenSpans(line.text, line.from)) {
        builder.add(span.from, span.to, span.kind === 'id' ? idMark : triggerMark)
      }
      if (line.to + 1 > to) break
      pos = line.to + 1
    }
  }
  return builder.finish()
}

// Block interactive edits that endanger slide identity. Two guards, checked against the
// PRE-change document over the affected lines only:
//  1. An `{id=…}` token may never be partially edited; it goes only when its whole line goes.
//  2. A Trigger LINE carrying an id may not be deleted, emptied, or merged into a neighbour
//     (⌘⌫, backspace at line start, delete at line end) — it goes only when the change also
//     swallows the slide's heading above, i.e. the whole slide is being deleted (the
//     Delete-slide command, cutting a multi-slide selection that includes the heading).
//     Deleting a single non-id token inside the line stays allowed — that's normal editing.
function nearestHeadingFromAbove(doc: EditorState['doc'], lineNumber: number): number {
  for (let n = lineNumber; n >= 1; n -= 1) {
    if (HEADING_RE.test(doc.line(n).text)) return doc.line(n).from
  }
  return -1
}

function blocksIdEdit(startState: EditorState, fromA: number, toA: number): boolean {
  const doc = startState.doc
  const isDeletion = toA > fromA
  // Include lines adjacent to the change so newline-boundary merges are seen.
  const firstLine = doc.lineAt(Math.max(0, fromA - 1))
  const lastLine = doc.lineAt(Math.min(toA + 1, doc.length))
  for (let n = firstLine.number; n <= lastLine.number; n += 1) {
    const line = doc.line(n)
    const hasId = ID_RE.test(line.text)
    ID_RE.lastIndex = 0
    if (!hasId) continue
    const isProtectedTriggerLine = TRIGGER_ONLY_LINE_RE.test(line.text)
    // Whole-slide exemption: the change swallows the nearest heading above AND this line.
    const headingFrom = nearestHeadingFromAbove(doc, line.number)
    const wholeSlideGoes = headingFrom >= 0 && fromA <= headingFrom && toA >= line.to
    if (wholeSlideGoes) continue
    // Guard 1: the id token itself.
    let m: RegExpExecArray | null
    ID_RE.lastIndex = 0
    while ((m = ID_RE.exec(line.text)) !== null) {
      const s = line.from + m.index
      const e = s + m[0].length
      if (s < toA && e > fromA) return true
    }
    // Guard 2: the trigger line's existence (deletions only; typing inside stays free).
    if (isDeletion && isProtectedTriggerLine) {
      const crossesStart = fromA < line.from && toA > line.from - 1
      const crossesEnd = fromA < line.to + 1 && toA > line.to
      const emptiesLine = fromA <= line.from && toA >= line.to
      if (crossesStart || crossesEnd || emptiesLine) return true
    }
  }
  return false
}

// ── Heading-survival guard (2026-07-04) ───────────────────────────────────────
// One rule: a heading line (`### ` / `## ` …, i.e. /^#{1,6}\s/) must STILL be a heading line after
// any USER edit — unless the whole slide is being deleted. This delivers the whole title-protection
// contract in one check: editing/clearing the TITLE TEXT keeps the `### ` marker (allowed);
// re-levelling `###`↔`##` keeps a marker (allowed); turning a non-heading INTO a heading isn't a
// pre-change heading so isn't guarded (allowed); but deleting the marker, emptying the heading line,
// or merging it into a neighbour leaves NO heading at the line's start (blocked) — that is exactly
// what orphaned a Trigger line below a title Dominik had wiped (Gate-4).
//
// Known, accepted over-protection: a `### `-looking line INSIDE a fenced code block is content, not
// a heading, but this guard (like the id/trigger guards above) treats it as a heading and protects
// it. A per-keystroke whole-doc fence scan (slideBrowserModel.fencedLineFlags) is too costly for a
// changeFilter, so we accept the false positive — such a line is still removable by deleting its
// whole slide. (Inserting text or a newline AT column 0 of a heading — Enter, or paste above it — is
// allowed: a pure insertion at the line-start pushes the intact heading down, so the heading, and
// the marker, survive.)

// Warn that a slide title can't be deleted on its own. The whole-slide removal chord is DERIVED from
// the live keymap (effectiveKeys) so a user who rebinds `delete-slide` in Settings still sees the
// right shortcut; it falls back to the ⌘⇧⌫ default. De-dupe key so repeats replace, never stack.
function warnHeadingProtected(): void {
  const chord = displayKeys(effectiveKeys('delete-slide')).join('') || '⌘⇧⌫'
  notify(`A slide title has to stay — delete the whole slide with ${chord}.`, 'warning', 'heading-protected')
}

// True when the change [fromA,toA) swallows this heading AND its whole block (down to the next
// heading / EOF) — a whole-slide removal by selection, the belt-and-braces twin of delete.slide
// (which is exempted upstream by its userEvent). Mirrors the trigger-line guard's whole-slide test.
function headingBlockSwallowed(
  doc: EditorState['doc'],
  heading: { number: number; from: number },
  fromA: number,
  toA: number
): boolean {
  let blockEndTo = doc.length
  for (let n = heading.number + 1; n <= doc.lines; n += 1) {
    if (HEADING_RE.test(doc.line(n).text)) { blockEndTo = doc.line(n - 1).to; break }
  }
  return fromA <= heading.from && toA >= blockEndTo
}

// True when the change destroys a heading it touches: a heading present in the PRE-change doc over
// [fromA,toA) whose start no longer begins a heading line in the POST-change doc (`tr.newDoc`).
function destroysHeading(tr: Transaction, fromA: number, toA: number): boolean {
  const doc = tr.startState.doc
  const first = doc.lineAt(fromA)
  const last = doc.lineAt(toA)
  for (let n = first.number; n <= last.number; n += 1) {
    const line = doc.line(n)
    if (!HEADING_RE.test(line.text)) continue
    // Skip headings the change can't destroy: one ending STRICTLY before this line's start, one
    // starting after its content, or a PURE INSERTION at the start (Enter / paste above a heading —
    // pushes the intact heading down, so it survives). A DELETION ending exactly at the start
    // (forward-Delete / select-to-line-start that eats the joining newline, merging the heading UP)
    // is NOT skipped — the survival check below blocks it when the line above is non-empty and
    // allows it when the line above is empty (a heading still begins the merged line).
    const insertionAtFrom = fromA === toA && toA === line.from
    if (toA < line.from || insertionAtFrom || fromA > line.to) continue
    // Whole-slide removal by selection is sanctioned (delete.slide is exempted upstream).
    if (headingBlockSwallowed(doc, line, fromA, toA)) continue
    // Map the heading's start into the post-change doc. Left-association keeps the position anchored
    // to the line's start, so a marker deepened/shrunk at the start (typing `#` at col 0, or the
    // `### `→`## ` re-level) still resolves to the start of the SURVIVING marker and passes.
    const mappedFrom = tr.changes.mapPos(line.from, -1)
    const newLine = tr.newDoc.lineAt(mappedFrom)
    if (newLine.from === mappedFrom && HEADING_RE.test(newLine.text)) continue // heading survived
    return true // heading destroyed
  }
  return false
}

const idChangeGuard = EditorState.changeFilter.of((tr) => {
  if (!tr.docChanged) return true
  const interactive =
    tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move')
  if (!interactive) return true
  // delete.slide is the sanctioned whole-slide removal — never heading-guarded (isUserEvent is
  // hierarchical, so this is also matched by the 'delete' test above; that's fine, blocksIdEdit
  // still exempts it via its own whole-slide check).
  const isSlideDelete = tr.isUserEvent('delete.slide')
  let blocked = false
  let headingDestroyed = false
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (!blocked && blocksIdEdit(tr.startState, fromA, toA)) blocked = true
    if (!headingDestroyed && !isSlideDelete && destroysHeading(tr, fromA, toA)) headingDestroyed = true
  })
  if (headingDestroyed) {
    warnHeadingProtected()
    return false
  }
  return !blocked
})

// The `/^#{1,6}\s/` marker's end offset on a heading line, or null when the line is not a heading.
function headingMarkerEnd(lineText: string, lineFrom: number): number | null {
  const m = lineText.match(HEADING_RE)
  return m ? lineFrom + m[0].length : null
}

// Friendly Backspace / ⌘-Backspace on a heading line, so the destructive keys never silently eat a
// title's marker — they clear the title TEXT and stop at the `### `, or warn (ADR-0032, Gate-4).
// Bound at Prec.high so it beats CodeMirror's default deleteToLineStart / deleteCharBackward but
// still sits below the outliner keymap (Prec.highest, which owns ⌘⇧⌫ = Delete-slide). Non-heading
// lines are untouched (run() returns false → default behaviour).
const headingDeleteKeymap = Prec.high(
  keymap.of([
    {
      key: 'Mod-Backspace', // ⌘⌫ delete-to-line-start
      run: (view: EditorView): boolean => {
        const sel = view.state.selection.main
        if (!sel.empty) return false
        const line = view.state.doc.lineAt(sel.head)
        const markerEnd = headingMarkerEnd(line.text, line.from)
        if (markerEnd == null) return false // not a heading → default deleteToLineStart
        if (sel.head > markerEnd) {
          // Clear the title text but keep the marker: delete (markerEnd … caret], leaving `### `.
          view.dispatch({
            changes: { from: markerEnd, to: sel.head, insert: '' },
            selection: { anchor: markerEnd },
            userEvent: 'delete'
          })
          return true
        }
        warnHeadingProtected() // caret at/inside the marker → would nuke the title; refuse.
        return true
      }
    },
    {
      key: 'Backspace',
      run: (view: EditorView): boolean => {
        const sel = view.state.selection.main
        if (!sel.empty) return false
        const line = view.state.doc.lineAt(sel.head)
        const markerEnd = headingMarkerEnd(line.text, line.from)
        if (markerEnd == null) return false // not a heading → default
        if (sel.head > markerEnd) return false // deleting a title char → default (one char back)
        // caret === markerEnd (about to eat the marker's trailing space) or inside the marker: refuse.
        warnHeadingProtected()
        return true
      }
    }
  ])
)

function protectPlugin(getClickHandler?: () => ProtectedTokenClickHandler | null): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view)
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.viewportChanged) this.decorations = buildDecorations(u.view)
      }
    },
    {
      decorations: (v) => v.decorations,
      // Chips are atomic: cursor motion skips them; deletion treats each as one unit
      // (ids are additionally guarded by the changeFilter above).
      provide: (plugin) =>
        EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
      eventHandlers: {
        mousedown(e: MouseEvent, view: EditorView): boolean {
          const handler = getClickHandler?.()
          if (!handler) return false
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
          if (pos == null) return false
          const line = view.state.doc.lineAt(pos)
          const span = lineTokenSpans(line.text, line.from).find(
            (s) => pos >= s.from && pos < s.to
          )
          if (!span) return false
          e.preventDefault()
          // Park the caret just before the token so a picker-driven merge targets this slide.
          view.dispatch({ selection: { anchor: span.from } })
          handler(span.text, span.kind)
          return true
        }
      }
    }
  )
}

// Quiet chip styling: machine-managed field, not editable prose. Trigger chips are the
// lighter cousin — recognisably structured, clickable, but not shouting.
const chipTheme = EditorView.baseTheme({
  '.cm-id-chip': {
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: '0.82em',
    background: 'rgba(11, 58, 107, 0.09)',
    color: '#5d6875',
    borderRadius: '4px',
    padding: '0 4px',
    border: '1px solid rgba(11, 58, 107, 0.14)',
    cursor: 'pointer'
  },
  '.cm-trigger-chip': {
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: '0.82em',
    background: 'rgba(11, 58, 107, 0.05)',
    color: '#6b7684',
    borderRadius: '4px',
    padding: '0 4px',
    border: '1px solid rgba(11, 58, 107, 0.10)',
    cursor: 'pointer'
  }
})

// Factory: the Editor passes a getter so the click handler can live in React-land without
// rebuilding the extension on every render.
export function tokenProtectExtension(
  getClickHandler?: () => ProtectedTokenClickHandler | null
): Extension {
  return [protectPlugin(getClickHandler), idChangeGuard, headingDeleteKeymap, chipTheme]
}

// Back-compat name (pre-2026-07-03): id-only protection is now a subset of token protection.
export const idProtectExtension: Extension = tokenProtectExtension()
