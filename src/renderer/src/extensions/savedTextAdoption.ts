// Taking the text a save wrote back into the editor without touching the undo history.
//
// A save may write more than the editor sent: the main process gives every heading without one an
// `{id=…}` line, and returns the text it wrote. The editor adopts that text so the next save sends
// it. Until 0.38.3-preview.10 the adoption was one ordinary change (the smallest single replacement
// from the sent text to the saved text), and so an undo step of its own. ⌘Z after the first save of a
// talk then undid the id lines, the autosave wrote them again 1.5 s later, the adoption became the
// newest undo step again, and the user's own change underneath (a move, a paste, typing) could never
// be reached.
//
// What this file does instead.
//
//   1. The adoption is one pure insertion per id (lib/savedTextChanges.ts), dispatched with
//      `addToHistory: false`. It is never an undo step. CodeMirror maps the undo steps it already
//      holds across such a change (the collaborative-editing path).
//
//   2. That mapping alone is not enough. A step whose inverse REPLACES a span (a move is one
//      replacement from the first moved line to the last) keeps the ids inserted inside the span and
//      puts them, together, after the replacement: undoing a move left `{id=a} {id=b}` in the middle
//      of a bullet. So straight after every undo or redo that touches an adopted id, in the same
//      turn, `settle` works out the text the undo should have given and puts it there, again
//      outside the history:
//        a. take the touched adopted ids out of the text as it was before the undo (`strip`, the
//           exact inverse of how each went in);
//        b. carry the undo's change over that removal (ChangeSet.map). With the ids out, the step is
//           what it was when it was recorded, so this is the exact undo;
//        c. put each id back under its heading in the undone text. The heading is found by its
//           whole slide (heading and body unchanged: a move, a cut, a paste), else at the place the
//           heading line maps to when its title or its body is unchanged (typing). An id whose
//           heading the undo removed (a typed heading, a pasted slide) is kept aside, and goes
//           back if a later redo or undo brings the same slide back.
//      Every change this file makes outside the history is the insertion or removal of an adopted id
//      in the form it was inserted, so step b stays exact however many undos and redos follow.
//
//   3. An id whose heading cannot be found is left out; the next save stamps the heading again and
//      reuses the id on disk by heading text and occurrence (src/main/index.ts, ID CHURN GUARD).
//
// Only ids adopted while there were undo steps to protect are tracked; in a talk whose headings all
// had ids when it was opened nothing here runs.
//
// Ordering: `savedTextAdoption()` dispatches from an update listener. Put it AFTER any other update
// listener that reads the text (the editor's autosave listener), so that listener sees the undo
// first and the settled text second.
import { Annotation, ChangeSet, StateEffect, StateField, Transaction, type EditorState, type Extension, type TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { isolateHistory, redoDepth, undoDepth } from '@codemirror/commands'
import { headingLevels } from '../../../shared/heading-lines'
import { minimalChange } from '../lib/minimalChange'
import { idsIn, savedTextChanges, type TextChange } from '../lib/savedTextChanges'

const ID_TOKEN = /\{id=([A-Za-z0-9_-]+)\}/g
const TRIGGER_ONLY_LINE_RE = /^\s*(\{[^}]*\}\s*)+$/

/** How an adopted id went into the text: on a line of its own under the heading (`\n{id=x}` at the
 *  end of the line above), at the start of a trigger line (`{id=x} `), after other tokens
 *  (` {id=x}`), or bare. */
export type IdForm = 'line' | 'lead' | 'trail' | 'bare'

function formOfInsertion(insert: string): { id: string; form: IdForm } | null {
  const m = insert.match(/^(\n| )?\{id=([A-Za-z0-9_-]+)\}( )?$/)
  if (!m || (m[1] && m[3])) return null
  return { id: m[2], form: m[1] === '\n' ? 'line' : m[1] === ' ' ? 'trail' : m[3] ? 'lead' : 'bare' }
}

// ── The ids this editor adopted from saves ──

/** An adopted id that is out of the text because an undo or redo removed its heading: the text it
 *  went in as, and where that was, counted from its heading. If the same slide comes back (the
 *  opposite redo or undo), the id goes back with it. */
interface Parked {
  id: string
  /** The inserted text: the id, with its line break (`own`) or its space. */
  text: string
  /** On a line of its own: `text` starts with the line break. */
  own: boolean
  heading: string
  body: string
  /** The lines from the heading down to the line `text` goes into, as they were without the id. */
  lines: string[]
  col: number
}

interface Adopted { forms: ReadonlyMap<string, IdForm>; parked: readonly Parked[] }
const MAX_PARKED = 200

const adoptedEffect = StateEffect.define<ReadonlyArray<{ id: string; form: IdForm }>>()
const parkedEffect = StateEffect.define<{ park: readonly Parked[]; unpark: readonly string[] }>()
/** Forget every adopted and parked id. Dispatch it in the transaction that puts another talk's text
 *  (or a reloaded file's) in the document and drops the undo history: the ids belong to the text and
 *  the history that are going. Without it an id parked in one talk is inserted under a look-alike
 *  heading of the next talk on its first undo. */
export const resetAdoptedIds = StateEffect.define<null>()
const adoptedField = StateField.define<Adopted>({
  create: () => ({ forms: new Map<string, IdForm>(), parked: [] }),
  update(value, tr) {
    let next = value
    for (const e of tr.effects) {
      if (e.is(resetAdoptedIds)) {
        next = { forms: new Map<string, IdForm>(), parked: [] }
      } else if (e.is(adoptedEffect) && e.value.length > 0) {
        const forms = new Map(next.forms)
        for (const { id, form } of e.value) forms.set(id, form)
        next = { ...next, forms }
      } else if (e.is(parkedEffect)) {
        const gone = new Set([...e.value.unpark, ...e.value.park.map((p) => p.id)])
        next = { ...next, parked: [...next.parked.filter((p) => !gone.has(p.id)), ...e.value.park].slice(-MAX_PARKED) }
      }
    }
    return next
  }
})

// Outside the history, and closing the undo step before it: a change made within the grouping delay
// after an adoption must not join the step before the adoption, or one step would hold text from
// both sides of it and no removal of ids could make it exact again.
const outsideHistory = () => [Transaction.addToHistory.of(false), isolateHistory.of('before')]

/** Marks the transaction that adopts the text a save wrote (either shape below): the app's change, not the user's.
 *  extensions/quoteLinkForm.ts reads it, to keep the ids a save stamped out of what it takes as typed. */
export const savedTextAdopted = Annotation.define<boolean>()

/** The transaction that puts `saved` in place of `sent`, or null when the document is no longer
 *  `sent` (the user typed during the save; the next save stamps again) or nothing differs. */
export function adoptionTransaction(state: EditorState, sent: string, saved: string): TransactionSpec | null {
  if (sent === saved || state.doc.toString() !== sent) return null
  const changes = savedTextChanges(sent, saved)
  const known = new Set(idsIn(sent))
  const forms = changes?.map((c) => (c.from === c.to ? formOfInsertion(c.insert) : null))
  // Not "one new id per change": one replacement, as an ordinary undo step. That leaves every
  // earlier step meaning what it meant, which a change outside the history would not.
  if (!changes || !forms || forms.some((f) => f === null || known.has(f.id))) return { changes: minimalChange(sent, saved), annotations: savedTextAdopted.of(true) }
  // No undo or redo step to protect: the ids are plain text to every step made from here on.
  const tracked = undoDepth(state) + redoDepth(state) > 0
  return {
    changes,
    annotations: [...outsideHistory(), savedTextAdopted.of(true)],
    effects: tracked ? adoptedEffect.of(forms as Array<{ id: string; form: IdForm }>) : []
  }
}

/** Adopt the text a save wrote. The caret is mapped through the change and the scroll position
 *  holds. True when the editor's text changed. */
export function adoptSavedText(view: EditorView, sent: string, saved: string): boolean {
  const spec = adoptionTransaction(view.state, sent, saved)
  if (!spec) return false
  view.dispatch(spec)
  return true
}

// ── Settling the adopted ids after an undo or redo ──

interface Slide {
  /** Index of the heading line. */
  line: number
  /** Offset of the heading line. */
  from: number
  heading: string
  /** The lines under the heading, up to the next heading, without trailing blank lines. */
  body: string
}

// `levels`: each line's heading level, 0 when it is not a heading (src/shared/heading-lines.ts: a
// `# comment` inside a code fence is not a slide's heading). Worked out once per parsed text.
interface Parsed { lines: string[]; levels: readonly number[]; start: number[]; slides: Slide[] }

function parse(text: string): Parsed {
  const lines = text.split('\n')
  const start: number[] = []
  let offset = 0
  for (const line of lines) { start.push(offset); offset += line.length + 1 }
  const slides: Slide[] = []
  const at: number[] = []
  const levels = headingLevels(lines)
  levels.forEach((level, i) => { if (level > 0) at.push(i) })
  at.forEach((line, k) => {
    const end = k + 1 < at.length ? at[k + 1] : lines.length
    slides.push({ line, from: start[line], heading: lines[line], body: lines.slice(line + 1, end).join('\n').trimEnd() })
  })
  return { lines, levels, start, slides }
}

function lineAt(parsed: Parsed, pos: number): number {
  let lo = 0
  let hi = parsed.start.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (parsed.start[mid] <= pos) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** The slide whose heading owns the id position at `line`: only blank and trigger lines may stand
 *  between a heading and its id. */
function slideOwning(parsed: Parsed, line: number): Slide | null {
  for (let n = line; n >= 0; n -= 1) {
    if (parsed.levels[n] > 0) return parsed.slides.find((s) => s.line === n) ?? null
    if (n !== line && parsed.lines[n].trim() !== '' && !TRIGGER_ONLY_LINE_RE.test(parsed.lines[n])) return null
  }
  return null
}

/** Does the heading already carry an id, on its own line or on the lines before its content? */
function slideHasId(parsed: Parsed, slide: Slide): boolean {
  for (let n = slide.line; n < parsed.lines.length; n += 1) {
    const text = parsed.lines[n]
    if (n > slide.line) {
      if (parsed.levels[n] > 0) return false
      if (text.trim() === '') continue
      if (!TRIGGER_ONLY_LINE_RE.test(text)) return false
    }
    if (text.includes('{id=')) return true
  }
  return false
}

export interface Settled {
  /** To apply to `tr.newDoc`, outside the history; null when the text is already right. */
  changes: ChangeSet | null
  park: Parked[]
  unpark: string[]
}

/** What settles the adopted ids after the undo or redo `tr`; null when there is nothing to do. */
export function settle(tr: Transaction, adopted: Adopted): Settled | null {
  if ((adopted.forms.size === 0 && adopted.parked.length === 0) || !tr.docChanged) return null
  const before = tr.startState.doc.toString()
  // a. The adopted ids the undo's change touches, each with the text it went in as.
  const hits: Array<{ id: string; from: number; to: number; own: boolean }> = []
  const seen = new Set<string>()
  for (const m of before.matchAll(ID_TOKEN)) {
    const form = adopted.forms.get(m[1])
    if (!form || seen.has(m[1])) continue
    seen.add(m[1])
    let from = m.index
    let to = from + m[0].length
    let own = false
    if (form === 'line' && before[from - 1] === '\n') { from -= 1; own = true }
    else if (form === 'lead' && before[to] === ' ') to += 1
    else if (form === 'trail' && before[from - 1] === ' ') from -= 1
    if (tr.changes.touchesRange(from, to) !== false) hits.push({ id: m[1], from, to, own })
  }
  if (hits.length === 0 && adopted.parked.length === 0) return null
  const strip = ChangeSet.of(hits.map((h) => ({ from: h.from, to: h.to })), before.length)
  // b. The undo with those ids out of the way, and the same removal carried to the undone text.
  const exact = tr.changes.map(strip)
  const stripAfter = strip.map(tr.changes)
  const undoneDoc = stripAfter.apply(tr.newDoc)
  const undone = undoneDoc.toString()
  const now = parse(undone)
  const present = new Set(idsIn(undone))
  // c. Each id back under its heading.
  const pending: Array<Parked & { from: number }> = []
  if (hits.length > 0) {
    const old = parse(strip.apply(tr.startState.doc).toString())
    for (const h of hits) {
      if (present.has(h.id)) continue // the undo's own text brought it back
      const at = strip.mapPos(h.from, -1)
      const line = lineAt(old, at)
      const slide = slideOwning(old, line)
      if (!slide) continue
      pending.push({
        id: h.id, text: before.slice(h.from, h.to), own: h.own, heading: slide.heading, body: slide.body,
        lines: old.lines.slice(slide.line, line + 1), col: at - old.start[line], from: slide.from
      })
    }
  }
  const free = new Set(now.slides.filter((s) => !slideHasId(now, s)))
  const targets = new Map<Parked, Slide>()
  const claim = (p: Parked, fits: (s: Slide) => boolean): void => {
    for (const s of free) if (fits(s)) { targets.set(p, s); free.delete(s); return }
  }
  // The whole slide, unchanged, wherever it went.
  for (const p of pending) claim(p, (s) => s.heading === p.heading && s.body === p.body)
  // Else the heading line where it was, its title or its body unchanged.
  for (const p of pending) {
    if (targets.has(p)) continue
    const from = exact.mapPos(p.from, 1)
    claim(p, (s) => s.from === from && (s.heading === p.heading || s.body === p.body))
  }
  // A slide an earlier undo or redo removed, back as it was.
  const unpark: string[] = []
  for (const p of adopted.parked) {
    if (present.has(p.id)) { unpark.push(p.id); continue }
    claim(p, (s) => s.heading === p.heading && s.body === p.body)
    if (targets.has(p)) unpark.push(p.id)
  }
  const park = pending.filter((p) => !targets.has(p)).map(({ from: _from, ...p }) => p)
  const inserts: TextChange[] = []
  for (const [p, s] of targets) {
    // The lines from the heading to the id's place must be what they were (for an id inside a line,
    // that line too).
    const depth = p.lines.length - 1
    const line = s.line + depth
    let same = line < now.lines.length
    for (let d = 1; d < depth && same; d += 1) if (now.lines[s.line + d] !== p.lines[d]) same = false
    if (same && depth > 0 && (p.own ? now.lines[line].slice(0, p.col) !== p.lines[depth].slice(0, p.col) : now.lines[line] !== p.lines[depth])) same = false
    if (same && depth === 0 && !p.own && now.lines[line] !== p.lines[0]) same = false
    if (same && depth === 0 && p.own && p.col > now.lines[line].length) same = false
    if (same) {
      inserts.push({ from: now.start[line] + p.col, to: now.start[line] + p.col, insert: p.text })
    } else {
      // They are not: a line of its own straight under the heading.
      const at = s.from + s.heading.length
      inserts.push({ from: at, to: at, insert: '\n' + p.text.trim() })
    }
  }
  inserts.sort((x, y) => x.from - y.from)
  const fix = stripAfter.compose(ChangeSet.of(inserts, undone.length))
  const changes = fix.apply(tr.newDoc).eq(tr.newDoc) ? null : fix
  return changes || park.length > 0 || unpark.length > 0 ? { changes, park, unpark } : null
}

/** The extension that remembers which ids were adopted and settles them after an undo or redo.
 *  See the ordering note at the top of this file. */
export function savedTextAdoption(): Extension {
  return [
    adoptedField,
    EditorView.updateListener.of((update) => {
      if (!update.docChanged || update.transactions.length !== 1) return
      const tr = update.transactions[0]
      if (!tr.isUserEvent('undo') && !tr.isUserEvent('redo')) return
      const settled = settle(tr, update.state.field(adoptedField))
      if (!settled) return
      update.view.dispatch({
        changes: settled.changes ?? undefined,
        annotations: outsideHistory(),
        effects: parkedEffect.of({ park: settled.park, unpark: settled.unpark })
      })
    })
  ]
}
