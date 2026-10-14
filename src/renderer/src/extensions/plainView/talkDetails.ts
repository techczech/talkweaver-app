// Plain view, ticket 06 (spec T11): the Talk details panel.
//
// In Plain the frontmatter block (and, when a talk has none, the top of the document) is a panel:
// closed it is one line, open it is labelled fields. It rides the table's own block decoration
// (`frontmatterBlockFacet` in frontmatterTable.ts), so the table still shows in Markdown mode and
// the raw toggle still works. Every edit goes through `editFrontmatterText`, the byte-preserving
// writer the table uses, as one transaction. A key the panel has no field for stays in the text and
// is listed read-only under the fields (the talk's title among them: the `#` heading is the title).
//
// The caret never rests inside the frontmatter while the panel shows: a selection endpoint that
// lands there is settled to the line after the closing `---` by a selection added after the
// transaction (the filter below never changes, cancels or rebuilds a transaction). Backspace at
// the start of the first line after the panel is held by the key rule in guardKeys.ts.
// Open or closed is kept for the window session only (a module variable; no setting).
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { EditorSelection, EditorState, StateEffect, StateField, type Extension, type Text, type Transaction } from '@codemirror/state'
import { METADATA_REGISTRY } from '../../../../shared/metadata-registry.ts'
import { editFrontmatterText } from '../../../../shared/frontmatter-editor.ts'
import { frontmatterBlockFacet, parseFrontmatter, rawField, toggleRawEffect, type Pair } from '../frontmatterTable'
import type { ProtectedRegion } from './protectedRegion'

interface FieldSpec { key: string; label: string }
/** The fields the drawing shows, in its order. */
export const MAIN_FIELDS: readonly FieldSpec[] = [
  { key: 'subtitle', label: 'Subtitle' },
  { key: 'author', label: 'Speaker' },
  { key: 'event', label: 'Event' },
  { key: 'date', label: 'Date' }
]
/** Behind "More: colour, handout link, closing line". */
export const MORE_FIELDS: readonly FieldSpec[] = [
  { key: 'colour', label: 'Colour' },
  { key: 'handout_url', label: 'Handout link' },
  { key: 'cta', label: 'Closing line' }
]
const ALL_FIELDS = [...MAIN_FIELDS, ...MORE_FIELDS]
const entryFor = (key: string) => METADATA_REGISTRY.find((m) => m.key === key)
const spellings = (key: string): string[] => [key, ...(entryFor(key)?.aliases ?? [])]

/** The value a field holds in these pairs ('' when absent). */
export function fieldValue(pairs: readonly Pair[], key: string): string {
  const names = spellings(key)
  return pairs.find((p) => names.includes(p.key))?.value.trim() ?? ''
}

/** Pairs the panel has no field for: they stay in the text and are listed read-only. */
export function otherPairs(pairs: readonly Pair[]): Pair[] {
  const known = new Set(ALL_FIELDS.flatMap((f) => spellings(f.key)))
  return pairs.filter((p) => !known.has(p.key))
}

/** The closed line's text after "Talk details": event · date, else the first two fields that are set; '' when none. */
export function talkDetailsSummary(pairs: readonly Pair[]): string {
  const event = fieldValue(pairs, 'event'), date = fieldValue(pairs, 'date')
  if (event && date) return `${event} · ${date}`
  return ALL_FIELDS.map((f) => fieldValue(pairs, f.key)).filter(Boolean).slice(0, 2).join(' · ')
}

let panelOpen = false
/** For tests: the window-session state. */
export function setTalkDetailsOpen(open: boolean): void { panelOpen = open }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

/** Set (or, with null, remove) one key: one undoable change. With no frontmatter yet, a block is written at the top. */
function setKey(view: EditorView, key: string, value: string | null): void {
  const aliases = spellings(key).slice(1)
  const parsed = parseFrontmatter(view.state)
  if (!parsed) {
    if (value === null) return
    view.dispatch({ changes: { from: 0, insert: editFrontmatterText('', [{ key, value, aliases }]) } })
    return
  }
  const next = editFrontmatterText(parsed.text, [{ key, value, aliases }])
  if (next === parsed.text) return
  view.dispatch({ changes: { from: parsed.from, to: parsed.to, insert: next } })
}

type Refresh = (pairs: readonly Pair[]) => void

class TalkDetailsWidget extends WidgetType {
  constructor(readonly pairs: readonly Pair[]) { super() }
  eq(other: TalkDetailsWidget): boolean { return JSON.stringify(other.pairs) === JSON.stringify(this.pairs) }
  get estimatedHeight(): number { return panelOpen ? 346 : 70 }
  ignoreEvent(): boolean { return true }

  // Keep the panel's DOM (and the focus inside it) when the text under it changes: tabbing from one
  // field to the next commits the first, which rewrites the pairs, and must not lose the second.
  updateDOM(dom: HTMLElement): boolean {
    const refresh = (dom as HTMLElement & { __refresh?: Refresh }).__refresh
    if (!refresh) return false
    refresh(this.pairs)
    return true
  }

  toDOM(view: EditorView): HTMLElement {
    // The widget's root is a plain box with the gaps above and below the panel as PADDING. CodeMirror
    // takes a block widget's height from its root's box; an outer margin is outside that box, and
    // every line under the panel was then drawn lower than the editor placed it (clicks landed one
    // row low). The bordered panel is the box inside.
    const slot = el('div', 'cm-talk-details-slot')
    const wrap = el('div', 'cm-talk-details')
    wrap.dataset.talkDetails = 'true'
    slot.appendChild(wrap)

    const head = el('div', 'cm-td-head')
    const toggle = el('button', 'cm-td-toggle')
    toggle.type = 'button'
    const chevron = el('span', 'cm-td-chevron', '›')
    chevron.setAttribute('aria-hidden', 'true')
    const title = el('strong', 'cm-td-title', 'Talk details')
    const summary = el('span', 'cm-td-summary')
    toggle.append(chevron, title, summary)
    const raw = el('button', 'cm-td-raw', '</> raw')
    raw.type = 'button'
    raw.title = 'Edit the front matter as text'
    raw.addEventListener('mousedown', (e) => { e.preventDefault(); view.dispatch({ effects: toggleRawEffect.of(true) }) })
    head.append(toggle, raw)
    wrap.appendChild(head)

    const body = el('div', 'cm-td-body')
    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>()
    const shown = new Map<string, string>()
    const row = (spec: FieldSpec): HTMLElement => {
      const r = el('label', 'cm-td-row')
      r.dataset.tdKey = spec.key
      r.appendChild(el('span', 'cm-td-label', spec.label))
      const entry = entryFor(spec.key)
      const options = entry?.vocabulary.kind === 'closed' ? entry.vocabulary.options : null
      let control: HTMLInputElement | HTMLSelectElement
      if (options) {
        const select = el('select', 'cm-td-input')
        for (const o of options) { const opt = el('option', undefined, o.label); opt.value = o.value; select.appendChild(opt) }
        select.addEventListener('change', () => setKey(view, spec.key, select.value === '' ? null : select.value))
        control = select
      } else {
        const input = el('input', 'cm-td-input')
        input.type = 'text'
        input.addEventListener('change', () => setKey(view, spec.key, input.value.trim() === '' ? null : input.value))
        control = input
      }
      inputs.set(spec.key, control)
      r.appendChild(control)
      return r
    }
    for (const f of MAIN_FIELDS) body.appendChild(row(f))

    const moreToggle = el('button', 'cm-td-more-toggle')
    moreToggle.type = 'button'
    moreToggle.append(el('span', 'cm-td-chevron', '›'), document.createTextNode('More: colour, handout link, closing line'))
    const more = el('div', 'cm-td-more')
    more.hidden = true
    for (const f of MORE_FIELDS) more.appendChild(row(f))
    const others = el('div', 'cm-td-others')
    more.appendChild(others)
    moreToggle.setAttribute('aria-expanded', 'false')
    moreToggle.addEventListener('click', () => {
      more.hidden = !more.hidden
      moreToggle.setAttribute('aria-expanded', more.hidden ? 'false' : 'true')
      view.dispatch({ effects: panelResized.of(null) })
    })
    body.append(moreToggle, more)
    wrap.appendChild(body)

    const titleText = (): string => (panelOpen || !summary.textContent ? 'Talk details' : 'Talk details:')
    const setOpen = (open: boolean): void => {
      panelOpen = open
      wrap.dataset.open = open ? 'true' : 'false'
      body.hidden = !open
      raw.style.display = open ? '' : 'none'
      summary.hidden = open
      title.textContent = titleText()
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
    }
    const refresh: Refresh = (pairs) => {
      for (const f of ALL_FIELDS) {
        const control = inputs.get(f.key)
        // A field being typed in (its text differs from what was last shown) is left alone; one that
        // only has focus follows the text (an undo while the cursor is still in it).
        if (!control) continue
        const value = fieldValue(pairs, f.key)
        if (control.value === value) { shown.set(f.key, value); continue }
        if (control.ownerDocument.activeElement === control && control.value !== shown.get(f.key)) continue
        if (control instanceof HTMLSelectElement && ![...control.options].some((o) => o.value === value)) {
          const custom = el('option', undefined, `custom: ${value}`)
          custom.value = value
          control.appendChild(custom)
        }
        control.value = value
        shown.set(f.key, control.value)
      }
      summary.textContent = talkDetailsSummary(pairs)
      title.textContent = titleText()
      others.textContent = ''
      const rest = otherPairs(pairs)
      if (rest.length) {
        others.appendChild(el('div', 'cm-td-others-title', 'Other lines in the front matter (edit them as text)'))
        for (const p of rest) {
          const line = el('div', 'cm-td-other')
          line.append(el('span', 'cm-td-other-key', p.key), el('span', 'cm-td-other-value', p.value.trim().split('\n')[0]))
          others.appendChild(line)
        }
      }
    }
    ;(slot as HTMLElement & { __refresh?: Refresh }).__refresh = refresh
    refresh(this.pairs)
    setOpen(panelOpen)

    toggle.addEventListener('click', () => { setOpen(!panelOpen); view.dispatch({ effects: panelResized.of(null) }) })
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); view.focus() }
    })
    return slot
  }
}

// The panel changes height when it is opened or closed, or its "More" part is. CodeMirror measures
// its lines again only when the content's own height changes or something is redrawn, and in a
// talk shorter than the pane the content's height does not change: the lines under the panel
// stayed where they were measured and clicks landed on other rows. So a change of height is said
// with an effect, and the effect redraws one line (a counter in an attribute of the first line
// under the panel), which makes the editor measure.
const panelResized = StateEffect.define<null>()
function measureMark(doc: Text, n: number): DecorationSet {
  const parsed = parseFrontmatter({ doc })
  const at = parsed ? parsed.to + 1 : 0
  if (at > doc.length) return Decoration.none
  return Decoration.set([Decoration.line({ attributes: { 'data-td-measure': String(n) } }).range(doc.lineAt(at).from)])
}
const measureField = StateField.define<{ n: number; deco: DecorationSet }>({
  create: (state) => ({ n: 0, deco: measureMark(state.doc, 0) }),
  update(value, tr) {
    const n = value.n + (tr.effects.some((e) => e.is(panelResized)) ? 1 : 0)
    return n === value.n && !tr.docChanged ? value : { n, deco: measureMark(tr.newDoc, n) }
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco)
})

/** Where the frontmatter sits when the panel is showing (not raw), else null. */
function panelSpan(doc: Text, raw: boolean): { from: number; to: number } | null {
  if (raw) return null
  const parsed = parseFrontmatter({ doc })
  return parsed ? { from: parsed.from, to: parsed.to } : null
}

// Returns `tr`, or `[tr, { selection, sequential: true }]`; never `changes`. A Find match and
// composition are not settled (as in hiddenLines.ts).
const keepOut = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged && !tr.selection) return tr
  if (tr.isUserEvent('select.search') || tr.isUserEvent('input.type.compose')) return tr
  const toggled = tr.effects.filter((e) => e.is(toggleRawEffect)).at(-1)
  const raw = toggled ? (toggled.value as boolean) : tr.startState.field(rawField, false) ?? false
  const span = panelSpan(tr.newDoc, raw)
  if (!span) return tr
  const guardTo = span.to + 1
  if (guardTo > tr.newDoc.length) return tr // nothing after the front matter to rest on
  const sel = tr.newSelection
  const settle = (p: number): number => (p >= span.from && p <= span.to ? guardTo : p)
  let changed = false
  const ranges = sel.ranges.map((r) => {
    const anchor = settle(r.anchor), head = settle(r.head)
    if (anchor !== r.anchor || head !== r.head) changed = true
    return EditorSelection.range(anchor, head)
  })
  if (!changed) return tr
  return [tr, { selection: EditorSelection.create(ranges, sel.mainIndex), sequential: true }]
})

/**
 * The front matter Plain protects in `doc` (what the Talk details panel stands for), read from the
 * document alone: a single key may not reach into the block or take the line break after it, and
 * the caret keeps out of the block (`keepOut` puts it on the line after, when there is one).
 */
export function talkDetailsProtectedRegions(doc: Text): ProtectedRegion[] {
  const span = panelSpan(doc, false)
  if (!span) return []
  const to = Math.min(span.to + 1, doc.length)
  return [{
    kind: 'frontmatter', anchor: span.from, from: span.from, to,
    zoneFrom: span.from, zoneTo: span.to, rest: span.to + 1, settles: span.to + 1 <= doc.length,
    parts: [{ from: span.from, to: span.to, text: 'front matter ' + doc.sliceString(span.from, span.to), walk: false }]
  }]
}

/** The same for a state (read by guardKeys.ts): none while the front matter is edited as text. */
export function talkDetailsProtectedRegionsOf(state: EditorState): ProtectedRegion[] {
  return state.field(rawField, false) ? [] : talkDetailsProtectedRegions(state.doc)
}
/** And for the document a transaction leaves (the panel is as it was: a key does not switch it to text). */
export function talkDetailsProtectedRegionsAfter(tr: Transaction): ProtectedRegion[] {
  return tr.startState.field(rawField, false) ? [] : talkDetailsProtectedRegions(tr.newDoc)
}

const panelTheme = EditorView.theme({
  // No vertical margin on either box: see toDOM.
  '.cm-talk-details-slot': { boxSizing: 'border-box', margin: '0', padding: '2px 0 14px' },
  '.cm-talk-details': {
    boxSizing: 'border-box', margin: '0', padding: '10px 16px', border: '1px solid #d9d0c1', borderRadius: '8px',
    background: '#fffdf8', fontFamily: 'inherit', fontSize: '15px', lineHeight: '1.4', color: '#17202a'
  },
  '.cm-td-head': { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  '.cm-td-toggle, .cm-td-more-toggle': {
    all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px', boxSizing: 'border-box'
  },
  '.cm-td-toggle:focus-visible, .cm-td-more-toggle:focus-visible, .cm-td-raw:focus-visible': { outline: '2px solid #0b3a6b', outlineOffset: '2px', borderRadius: '4px' },
  '.cm-td-chevron': { display: 'inline-block', width: '12px', textAlign: 'center', fontSize: '18px', lineHeight: '1', transition: 'transform 0.1s' },
  '[aria-expanded="true"] > .cm-td-chevron': { transform: 'rotate(90deg)' },
  '.cm-td-title': { fontWeight: '700' },
  '.cm-td-summary': { color: '#5d6875' },
  '.cm-td-raw': { all: 'unset', cursor: 'pointer', fontSize: '12px', color: '#5d6875', padding: '2px 6px' },
  '.cm-td-body': { marginTop: '8px' },
  '.cm-td-row': { display: 'grid', gridTemplateColumns: '142px 1fr', alignItems: 'center', margin: '0 0 8px' },
  '.cm-td-label': { color: '#4a5563', fontSize: '14px', fontWeight: '500' },
  '.cm-td-input': {
    boxSizing: 'border-box', width: '100%', padding: '8px 12px', border: '1px solid #d9d0c1', borderRadius: '6px',
    background: '#fff', font: 'inherit', color: '#17202a'
  },
  '.cm-td-input:focus': { outline: '2px solid #0b3a6b55', borderColor: '#0b3a6b' },
  '.cm-td-more-toggle': { color: '#1d5fa8', fontSize: '14px', margin: '2px 0 4px' },
  '.cm-td-more': { marginTop: '8px' },
  '.cm-td-others': { marginTop: '4px', fontSize: '13px', color: '#5d6875' },
  '.cm-td-others-title': { margin: '6px 0 2px' },
  '.cm-td-other': { display: 'flex', gap: '12px' },
  '.cm-td-other-key': { minWidth: '142px', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '12px' }
}, { dark: false })

export function talkDetailsExtension(): Extension {
  return [
    frontmatterBlockFacet.of((parsed) => new TalkDetailsWidget(parsed ? parsed.pairs : [])),
    keepOut,
    measureField,
    panelTheme
  ]
}
