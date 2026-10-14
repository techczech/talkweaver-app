// Plain view, ticket 05 (spec T10): a list item's `{icon=key}` shows as a picture at the start of the
// item, where the bullet would be; the token at the end of the line is hidden.
//
//   - Item prefix: the indentation, the mark (`-`, `*`, `+`, `1.`) and the spaces after it are replaced
//     by one widget. Unordered: the picture alone. Ordered: the number as typed, then the picture. The
//     widget is a fixed width and the line has a matching hanging indent, so a wrapped line lines up
//     with the text and not under the picture.
//   - The token: from the whitespace before `{` to the end of the line is replaced by nothing (and is
//     an atomic range), so the caret rests at the end of the item's text, before it. Typing there
//     lands before the token; Backspace there deletes text.
//   - Reveal range: the token shows as a chip while an empty caret is anywhere in [textEnd, lineEnd]
//     (both edges included), or a selection overlaps it (a Find match, a selected line). A click or
//     End that would land inside the hidden token is settled to textEnd, so the caret is always put
//     before the chip first; Arrow keys then walk into it, which is how it is edited or deleted.
//   - Enter with the caret in [textEnd, lineEnd] starts the new item after the whole line, so the
//     token stays with the item it belongs to.
//   - Unknown key (the source answered null): no picture, the bullet or number stays, the token is a
//     chip in the warning colour. No source given, or SVG that fails the sanitiser: the same.
//   - A nested item (a row under another row, as the compiler's list reader nests them) gets no picture: the slide draws icons on top-level
//     items only. Its token shows as the chip in the ordinary colour, as for an unknown key but not
//     the warning colour, and no icon is fetched for it (ticket 04 correction to ticket 05).
//   - While an answer is awaited the bullet stays and the token is hidden. Answers are cached per key
//     for the page's life (a "not found" is asked again after NULL_TTL_MS) and arrive by an effect.
//
// Plain view ticket 07 (spec T14): titles and paragraphs carry icons too.
//   - A heading's `{…}` group that holds an `icon=NAME` token (anywhere among its trailing groups,
//     alone or with other options: `{icon=lucide:route title-icon=above}`) is hidden and the
//     picture shows before the title, after the `#` marks. EVERY such group on the line is hidden;
//     the picture is the last one's, as on the slide. With the caret anywhere from the first of
//     them to the last, each shows whole as a chip. In the editor the picture always sits before
//     the title, also where `{title-icon=above}` puts it above on the slide.
//   - A paragraph that ends in `{icon=NAME}` (the explicit form only) has the token hidden and its
//     picture at the start of the paragraph's first line.
//   - Which braces are an icon token is read as the compiler reads it, by
//     src/shared/plain-view-icon-tokens.ts (a quoted value that contains `icon=` is not one;
//     braces written straight after a text character, the tail of a URL or an escaped `\{`, are
//     text). test:plain-view-icon-token-parity holds the two readers together.
//   - Reveal, the caret rules, the cache and the unknown-key chip are the list item's.
//
// Editing rules (fix round 2 of ticket 07). NOTHING here rewrites or blocks a change to the
// document: a transaction's changes, annotations and effects always go through as given, whoever
// made it (the person, a remote collaborator, the app's own code).
//   - Enter is a KEY rule, not a transaction rule, and it is guardKeys.ts's. When the Enter key
//     goes down with one empty caret, and everything from the caret to the end of the line is
//     tokens Plain hides and spaces (the caret is at the end of the line's visible text, or
//     inside a token's chip: `lineEndPastTokens`), the Enter is made as if from the line's end, in
//     one transaction, so the tokens stay on their line. The caret is never moved there first.
//   - The one thing a filter does: a caret the PERSON puts inside a hidden token (a click past the
//     text, End: a `select` user event) rests before it. A caret that anything else leaves there
//     (Undo, the app's own code) is put before it after the transaction, by settleCaret.ts.
//   - A paragraph's and a list item's token is protected as a heading's tail is (fifth fix round),
//     and from the document alone, drawn hidden or as a chip (`iconProtectedRegions`): the text
//     ends at `textEnd`, before the one space that separates it from the token; no single key
//     takes that space or the token (guardKeys.ts); End goes to `textEnd`, so typing after it
//     lands before the token. The caret walks into the chip with ArrowRight from `textEnd`, and
//     there the token's own characters are edited as text.
//   - A HEADING's icon group is not settled or guarded here. It is part of the heading's one hidden
//     tail (headingTail.ts), with the heading's other trailing groups: hiddenLines.ts settles the
//     caret to the end of the visible text for all of them, whoever moved it, and guardKeys.ts
//     holds the deleting keys over the whole tail and the line break after it.
//
// Which paragraph and which list item ends in an icon token is the compiler's own answer: its lexer
// is run on each slide's lines (shared/plain-view-compiler-facts.ts) and this file draws what it
// reports. One thing differs, for want of the icon vocabulary in the editor: the bare `{NAME}` on
// a list item is a token here only when NAME carries a `lucide:` / `svgl:` / `tabler:` prefix
// (the compiler also takes an unprefixed NAME that it finds in its icon sets). An unprefixed `{icon=NAME}` is
// resolved as the compiler does: Lucide, then brand, then Tabler.
import {
  Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet, type ViewUpdate
} from '@codemirror/view'
import {
  EditorSelection, EditorState, Facet, Prec, StateEffect, StateField, Transaction, type Extension, type Range, type Text
} from '@codemirror/state'
import { sanitiseRenderedSvg } from '../../../../shared/objects/sanitise-svg'
import type { IconItem } from '../../../../shared/plain-view-icon-items'
import { hiddenRegions } from './hiddenLines'
import { plainFactsOf } from './outlineLines'
import type { ProtectedRegion } from './protectedRegion'

export type IconSvgSource = (key: string) => Promise<string | null>

const PREFIXED = /^(lucide|svgl|tabler):/
const NULL_TTL_MS = 30_000
/** Width of the indentation, in em per source character (a space in the reading sans is about 0.28em). */
const INDENT_EM = 0.3
const PICTURE_EM = 1.15
const GAP_EM = 0.45
const NUMBER_EM = 1.6

export type { IconItem, TokenSpan } from '../../../../shared/plain-view-icon-items'

/**
 * The items of a document that end in an icon token. A paragraph's and a list item's are the
 * compiler's own answer (its lexer, run on each slide's lines: shared/plain-view-compiler-facts.ts),
 * mapped to positions by shared/plain-view-icon-items.ts; nothing here recognises a paragraph or
 * a list item.
 */
export function iconItems(doc: Text): IconItem[] {
  return plainFactsOf(doc).items
}

// ── The icon source and its cache ───────────────────────────────────────────────────────────────

interface Entry { svg: string | null; at: number }
const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<void>>()

/** Forget every answer (tests, and a changed icon source). */
export function clearIconCache(): void { cache.clear(); inflight.clear() }

function cached(key: string): { svg: string | null } | undefined {
  const e = cache.get(key)
  if (!e) return undefined
  if (e.svg === null && Date.now() - e.at > NULL_TTL_MS) { cache.delete(key); return undefined }
  return e
}

async function fetchIcon(source: IconSvgSource, raw: string): Promise<string | null> {
  const tries = PREFIXED.test(raw) ? [raw] : [`lucide:${raw}`, `svgl:${raw}`, `tabler:${raw}`]
  for (const k of tries) {
    let svg: string | null = null
    try { svg = await source(k) } catch { svg = null }
    if (!svg) continue
    const clean = sanitiseRenderedSvg(svg)
    if ('svg' in clean) return clean.svg
  }
  return null
}

const iconArrived = StateEffect.define<string>()

const loader = (source: IconSvgSource | undefined) => ViewPlugin.fromClass(class {
  asked = new Set<string>()
  constructor(readonly view: EditorView) { this.scan() }
  update(u: ViewUpdate): void { if (u.docChanged) this.scan() }
  scan(): void {
    if (!source) return
    for (const { key, nested } of this.view.state.field(itemsField).items) {
      if (nested || cached(key) || this.asked.has(key)) continue
      this.asked.add(key)
      let p = inflight.get(key)
      if (!p) {
        p = fetchIcon(source, key).then((svg) => { cache.set(key, { svg, at: Date.now() }); inflight.delete(key) })
        inflight.set(key, p)
      }
      // Every view that asked is told, so each repaints.
      void p.then(() => {
        this.asked.delete(key)
        try { this.view.dispatch({ effects: iconArrived.of(key) }) } catch { /* the view is gone */ }
      })
    }
  }
})

// ── State ─────────────────────────────────────────────────────────────────────────────────────

class PictureWidget extends WidgetType {
  constructor(readonly svg: string, readonly number: string, readonly indent: number) { super() }
  eq(o: PictureWidget): boolean { return o.svg === this.svg && o.number === this.number && o.indent === this.indent }
  toDOM(): HTMLElement {
    const box = document.createElement('span')
    box.className = 'cm-plain-icon-box'
    box.style.width = `${hangEm(this.number !== '', this.indent)}em`
    if (this.indent) box.style.paddingLeft = `${this.indent * INDENT_EM}em`
    if (this.number) {
      const num = document.createElement('span')
      num.className = 'cm-plain-icon-number'
      num.textContent = this.number
      box.appendChild(num)
    }
    const pic = document.createElement('span')
    pic.className = 'cm-plain-icon-picture'
    pic.innerHTML = this.svg // sanitised by sanitiseRenderedSvg before it was cached
    box.appendChild(pic)
    return box
  }
  ignoreEvent(): boolean { return false }
}

/** The picture before a title or a paragraph: put in at a position, replacing nothing. */
class InlinePictureWidget extends WidgetType {
  constructor(readonly svg: string) { super() }
  eq(o: InlinePictureWidget): boolean { return o.svg === this.svg }
  toDOM(): HTMLElement {
    const box = document.createElement('span')
    box.className = 'cm-plain-icon-box cm-plain-icon-inline'
    const pic = document.createElement('span')
    pic.className = 'cm-plain-icon-picture'
    pic.innerHTML = this.svg // sanitised by sanitiseRenderedSvg before it was cached
    box.appendChild(pic)
    return box
  }
  ignoreEvent(): boolean { return false }
}

function hangEm(ordered: boolean, indent: number): number {
  return indent * INDENT_EM + (ordered ? NUMBER_EM : 0) + PICTURE_EM + GAP_EM
}

const hideToken = Decoration.replace({})
const chip = Decoration.mark({ class: 'cm-plain-icon-chip' })
const chipWarn = Decoration.mark({ class: 'cm-plain-icon-chip cm-plain-icon-chip-warn' })

interface IconState {
  items: readonly IconItem[]
  deco: DecorationSet
  atomic: DecorationSet
  /** Mark starts whose bullet is replaced by a picture (listMarks leaves those alone). */
  pictured: ReadonlySet<number>
}

const sameSel = (a: EditorState['selection'], b: EditorState['selection']): boolean => a.eq(b)

function revealed(item: IconItem, sel: EditorState['selection']): boolean {
  return sel.ranges.some((r) => r.empty ? r.head >= item.from && r.head <= item.to : r.from < item.to && r.to > item.from)
}

function compute(items: readonly IconItem[], sel: EditorState['selection'], hasSource: boolean): IconState {
  const deco: Range<Decoration>[] = []
  const atomic: Range<Decoration>[] = []
  const pictured = new Set<number>()
  for (const item of items) {
    if (item.nested) { deco.push(chip.range(item.tokenFrom, item.to)); continue }
    const entry = hasSource ? cached(item.key) : undefined
    const svg = entry?.svg ?? null
    if (svg && item.kind !== 'item') {
      deco.push(Decoration.widget({ widget: new InlinePictureWidget(svg), side: -1 }).range(item.textFrom))
    } else if (svg) {
      pictured.add(item.markFrom)
      const hang = hangEm(item.ordered, item.indent)
      deco.push(Decoration.line({
        class: 'cm-plain-icon-item',
        attributes: { style: `padding-left:${hang}em;text-indent:-${hang}em` }
      }).range(item.lineFrom))
      deco.push(Decoration.replace({ widget: new PictureWidget(svg, item.number, item.indent) }).range(item.lineFrom, item.textFrom))
    }
    const pending = hasSource && entry === undefined
    const unknown = hasSource && entry !== undefined && svg === null
    // Hidden only while a picture is drawn or being fetched, and the caret is away from it.
    if ((svg || pending) && !revealed(item, sel)) {
      for (const span of item.spans) {
        deco.push(hideToken.range(span.from, span.to))
        atomic.push(hideToken.range(span.from, span.to))
      }
    } else {
      for (const span of item.spans) deco.push((unknown ? chipWarn : chip).range(span.tokenFrom, span.to))
    }
  }
  return { items, deco: Decoration.set(deco, true), atomic: Decoration.set(atomic, true), pictured }
}

const hasSourceFacet = Facet.define<boolean, boolean>({ combine: (v) => v.some(Boolean) })

const itemsField = StateField.define<IconState>({
  create: (state) => compute(iconItems(state.doc), state.selection, state.facet(hasSourceFacet)),
  update(value, tr) {
    const arrived = tr.effects.some((e) => e.is(iconArrived))
    if (!tr.docChanged && !arrived && sameSel(tr.startState.selection, tr.newSelection)) return value
    const items = tr.docChanged ? iconItems(tr.newDoc) : value.items
    const next = compute(items, tr.newSelection, tr.startState.facet(hasSourceFacet))
    // Keep the same set while its members are unchanged, so listMarks does not rebuild on every caret move.
    const same = next.pictured.size === value.pictured.size && [...next.pictured].every((m) => value.pictured.has(m))
    return same ? { ...next, pictured: value.pictured } : next
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.deco),
    EditorView.atomicRanges.of((view) => view.state.field(f).atomic)
  ]
})

const NONE: ReadonlySet<number> = new Set()

/** Mark starts of list items whose bullet is drawn as a picture (for listMarks). */
export function picturedMarks(state: EditorState): ReadonlySet<number> {
  return state.field(itemsField, false)?.pictured ?? NONE
}

/** The icon items now in force (read by guardKeys.ts and the tests). */
export function iconItemsOf(state: EditorState): readonly IconItem[] {
  return state.field(itemsField, false)?.items ?? []
}

// ── Editing rules ───────────────────────────────────────────────────────────────────────────────

/**
 * For the Enter key (guardKeys.ts makes the Enter): with one empty caret, when everything from the
 * caret to the end of the line is tokens Plain hides (icon tokens, and a heading's other trailing
 * groups) and spaces, the line's end, from where Enter is to act so that it never splits a token
 * or parts it from its text. null for any other caret. It reads only; the caret is not moved (a
 * caret put at the line's end as a step of its own was what Undo came back to: seventh fix round).
 *
 * `tail` is where that stretch starts: the end of the line's visible text. A caret inside a
 * token's chip is past it.
 */
export function lineEndPastTokens(state: EditorState): number | null {
  const sel = state.selection
  if (sel.ranges.length !== 1 || !sel.main.empty) return null
  const head = sel.main.head
  const line = state.doc.lineAt(head)
  if (head >= line.to) return null
  const tokens: Array<{ from: number; to: number }> = []
  for (const item of state.field(itemsField, false)?.items ?? []) {
    for (const span of item.spans) if (span.tokenFrom >= line.from && span.to <= line.to) tokens.push({ from: span.tokenFrom, to: span.to })
  }
  for (const region of hiddenRegions(state)) {
    if (region.kind === 'tail' && region.from >= line.from && region.to <= line.to) tokens.push({ from: region.from, to: region.to })
  }
  if (!tokens.length) return null
  // Walk back from the line's end over spaces and whole tokens.
  let tail = line.to
  for (;;) {
    const token = tokens.find((t) => t.to === tail)
    if (token) { tail = token.from; continue }
    if (tail > line.from && /[ \t]/.test(state.doc.sliceString(tail - 1, tail))) { tail -= 1; continue }
    break
  }
  // No token in the stretch (trailing spaces only), or the caret is still in the visible text.
  if (!tokens.some((t) => t.from >= tail) || head < tail) return null
  return line.to
}

// A caret the person puts inside a hidden token (a click past the text, End) rests before it
// instead. Only a `select` user event that changes nothing in the document is settled; a remote
// transaction, and one with no user event (the app's own code), is never altered. The transaction
// itself is kept whole (its annotations and effects) and the settled selection is added to it.
const filter = EditorState.transactionFilter.of((tr) => {
  if (tr.docChanged || !tr.selection) return tr
  if (tr.annotation(Transaction.remote) || !tr.isUserEvent('select') || tr.isUserEvent('select.search')) return tr
  const start = tr.startState.field(itemsField, false)
  if (!start || !start.items.length) return tr
  const before = tr.startState.selection
  let changed = false
  const ranges = tr.selection.ranges.map((r) => {
    if (!r.empty) return r
    for (const item of start.items) {
      // A heading's icon group is part of the heading's one hidden tail: hiddenLines settles the
      // caret there, for every group together (headingTail.ts).
      if (item.kind === 'heading') continue
      const span = item.spans.find((s) => r.head > s.from && r.head <= s.to)
      if (!span) continue
      if (before.ranges.some((b) => b.empty && b.head >= item.from && b.head <= item.to)) return r // already walking inside it
      changed = true
      return EditorSelection.cursor(span.from)
    }
    return r
  })
  if (!changed) return tr
  return [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex), sequential: true }]
})

/**
 * The icon tokens Plain protects in `doc`: the token that ends a paragraph or a list item, read
 * from the document alone (no selection, no picture cache: a token shown as a chip is protected
 * as one that is hidden). A single key may not reach from `textEnd` (the separating space
 * included) to the line's end; the caret keeps out of `(textEnd, line end]` unless it walks in.
 * (A heading's icon group is part of the heading's tail: hiddenLines.protectedRegions.)
 */
export function iconProtectedRegions(doc: Text, items: readonly IconItem[] = iconItems(doc)): ProtectedRegion[] {
  const out: ProtectedRegion[] = []
  for (const item of items) {
    if (item.kind === 'heading') continue
    out.push({
      kind: 'icon', anchor: doc.lineAt(item.to).from,
      from: item.textEnd, to: item.to,
      zoneFrom: item.textEnd + 1, zoneTo: item.to, rest: item.textEnd, settles: false,
      parts: item.spans.map((span) => ({ from: span.tokenFrom, to: span.to, text: 'icon ' + doc.sliceString(span.tokenFrom, span.to).trim(), walk: true }))
    })
  }
  return out.filter((r) => r.to > r.from)
}

/** The same for a state (read by guardKeys.ts); none where the pictures are not installed (Markdown mode). */
export function iconProtectedRegionsOf(state: EditorState): ProtectedRegion[] {
  const field = state.field(itemsField, false)
  return field ? iconProtectedRegions(state.doc, field.items) : []
}
export function iconProtectedRegionsAfter(tr: Transaction): ProtectedRegion[] {
  return tr.startState.field(itemsField, false) ? iconProtectedRegions(tr.newDoc) : []
}

/**
 * End on the line of a paragraph or list item that ends in an icon token goes to the end of its
 * visible text, as End on a title does (hiddenLines.endOfTitle): typing after End lands before
 * the token. `visual`: the key moves by rows on screen (End, Cmd-ArrowRight); it is ours only
 * when the row's end lies past the text's end, so End on an earlier row of a wrapped paragraph
 * is the ordinary key.
 */
function endOfIconText(view: EditorView, extend: boolean, visual: boolean): boolean {
  const state = view.state
  const sel = state.selection.main
  const line = state.doc.lineAt(sel.head)
  const item = state.field(itemsField, false)?.items.find((i) => i.kind !== 'heading' && i.to === line.to && i.textEnd >= line.from)
  if (!item) return false
  if (visual && view.moveToLineBoundary(sel, true).head <= item.textEnd && sel.head < item.textEnd) return false
  view.dispatch({
    selection: extend ? EditorSelection.range(sel.anchor, item.textEnd) : EditorSelection.cursor(item.textEnd),
    scrollIntoView: true,
    userEvent: 'select'
  })
  return true
}

const endKeys = Prec.high(keymap.of([
  { key: 'End', mac: 'Mod-ArrowRight', run: (v) => endOfIconText(v, false, true), shift: (v) => endOfIconText(v, true, true) },
  { mac: 'End', run: (v) => endOfIconText(v, false, true), shift: (v) => endOfIconText(v, true, true) },
  { mac: 'Ctrl-e', run: (v) => endOfIconText(v, false, false) }
]))

// ── Theme ──────────────────────────────────────────────────────────────────────────────────────

const theme = EditorView.theme({
  '.cm-plain-icon-box': { display: 'inline-block', boxSizing: 'border-box', whiteSpace: 'nowrap', textIndent: '0', verticalAlign: 'baseline' },
  '.cm-plain-icon-inline': { width: `${PICTURE_EM + GAP_EM}em` },
  '.cm-plain-icon-number': { display: 'inline-block', width: `${NUMBER_EM}em`, color: '#17202a' },
  '.cm-plain-icon-picture': {
    display: 'inline-block', width: `${PICTURE_EM}em`, height: `${PICTURE_EM}em`,
    color: '#1a5fb4', verticalAlign: '-0.22em'
  },
  '.cm-plain-icon-picture svg': { display: 'block', width: '100%', height: '100%' },
  '.cm-plain-icon-chip': {
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: '0.82em',
    background: 'rgba(11, 58, 107, 0.05)',
    color: '#6b7684',
    borderRadius: '4px',
    padding: '0 4px',
    border: '1px solid rgba(11, 58, 107, 0.10)'
  },
  '.cm-plain-icon-chip-warn': {
    background: 'rgba(165, 42, 42, 0.10)',
    color: '#9a3c3c',
    borderColor: 'rgba(165, 42, 42, 0.24)'
  }
})

export function iconPicturesExtension(source?: IconSvgSource): Extension {
  return [hasSourceFacet.of(!!source), itemsField, filter, endKeys, loader(source), theme]
}
