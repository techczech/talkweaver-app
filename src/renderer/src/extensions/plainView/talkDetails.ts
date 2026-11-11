// Plain view, ticket 06 (spec T11), changed by house rule R11: the Talk details line.
//
// In Plain the frontmatter block (and, when a talk has none, the top of the document) is one line: "Talk details:" and a few
// words of what is set, a link that opens the Talk tab of the right sidebar, where a talk's details are edited. It rides
// the table's own block decoration (`frontmatterBlockFacet` in frontmatterTable.ts), so the table still shows in Markdown
// mode and the raw toggle still works. The line holds no field and writes nothing.
//
// The caret never rests inside the frontmatter while the line shows: a selection endpoint that lands there is settled to the
// line after the closing `---` by a selection added after the transaction (the filter below never changes, cancels or
// rebuilds a transaction). Backspace at the start of the first line after the line is held by the key rule in guardKeys.ts.
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { EditorSelection, EditorState, StateEffect, StateField, type Extension, type Text, type Transaction } from '@codemirror/state'
import { METADATA_REGISTRY } from '../../../../shared/metadata-registry.ts'
import { frontmatterBlockFacet, OPEN_TALK_TAB_EVENT, parseFrontmatter, rawField, toggleRawEffect, type Pair } from '../frontmatterTable'
import type { ProtectedRegion } from './protectedRegion'

const entryFor = (key: string) => METADATA_REGISTRY.find((m) => m.key === key)
const spellings = (key: string): string[] => [key, ...(entryFor(key)?.aliases ?? [])]
/** The keys the closed line summarises, in order: subtitle, speaker, event, date, then colour, handout link, closing line. */
const SUMMARY_KEYS: readonly string[] = ['subtitle', 'author', 'event', 'date', 'colour', 'handout_url', 'cta']

/** The value a field holds in these pairs ('' when absent). */
export function fieldValue(pairs: readonly Pair[], key: string): string {
  const names = spellings(key)
  return pairs.find((p) => names.includes(p.key))?.value.trim() ?? ''
}

/** The line's text after "Talk details": event · date, else the first two fields that are set; '' when none. */
export function talkDetailsSummary(pairs: readonly Pair[]): string {
  const event = fieldValue(pairs, 'event'), date = fieldValue(pairs, 'date')
  if (event && date) return `${event} · ${date}`
  return SUMMARY_KEYS.map((key) => fieldValue(pairs, key)).filter(Boolean).slice(0, 2).join(' · ')
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

type Refresh = (pairs: readonly Pair[]) => void

class TalkDetailsWidget extends WidgetType {
  constructor(readonly pairs: readonly Pair[]) { super() }
  eq(other: TalkDetailsWidget): boolean { return JSON.stringify(other.pairs) === JSON.stringify(this.pairs) }
  get estimatedHeight(): number { return 52 }
  ignoreEvent(): boolean { return true }

  // The summary follows the text under it without rebuilding the line.
  updateDOM(dom: HTMLElement): boolean {
    const refresh = (dom as HTMLElement & { __refresh?: Refresh }).__refresh
    if (!refresh) return false
    refresh(this.pairs)
    return true
  }

  toDOM(view: EditorView): HTMLElement {
    // One line (house rule R11): a talk's details are edited in the Talk tab of the right sidebar, so this is a link to it
    // with what is set in a few words, and the raw front matter one click away. The root is a plain box with the gaps
    // above and below as PADDING: CodeMirror takes a block widget's height from its root's box (an outer margin is
    // outside it, and every line under the line was then drawn lower than the editor placed it).
    const slot = el('div', 'cm-talk-details-slot')
    const wrap = el('div', 'cm-talk-details')
    wrap.dataset.talkDetails = 'true'
    slot.appendChild(wrap)

    const head = el('div', 'cm-td-head')
    const link = el('button', 'cm-td-toggle')
    link.type = 'button'
    link.dataset.talkDetailsLink = 'true'
    link.title = 'Edit this talk’s details in the Talk tab'
    const title = el('strong', 'cm-td-title', 'Talk details')
    const summary = el('span', 'cm-td-summary')
    const go = el('span', 'cm-td-go', 'Edit in the Talk tab ›')
    link.append(title, summary, go)
    link.addEventListener('mousedown', (e) => e.preventDefault())
    link.addEventListener('click', () => window.dispatchEvent(new Event(OPEN_TALK_TAB_EVENT)))
    const raw = el('button', 'cm-td-raw', '</> raw')
    raw.type = 'button'
    raw.title = 'Show the front matter as text'
    raw.addEventListener('mousedown', (e) => { e.preventDefault(); view.dispatch({ effects: toggleRawEffect.of(true) }) })
    head.append(link, raw)
    wrap.appendChild(head)

    const refresh: Refresh = (pairs) => {
      const text = talkDetailsSummary(pairs)
      summary.textContent = text
      title.textContent = text ? 'Talk details:' : 'Talk details'
    }
    ;(slot as HTMLElement & { __refresh?: Refresh }).__refresh = refresh
    refresh(this.pairs)
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
  '.cm-td-head': { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
  '.cm-td-toggle': {
    all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'baseline', gap: '10px', boxSizing: 'border-box', minWidth: '0', flex: '1 1 auto'
  },
  '.cm-td-toggle:focus-visible, .cm-td-raw:focus-visible': { outline: '2px solid #0b3a6b', outlineOffset: '2px', borderRadius: '4px' },
  '.cm-td-title': { fontWeight: '700', flex: '0 0 auto' },
  '.cm-td-summary': { color: '#5d6875', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: '0' },
  '.cm-td-go': { color: '#1d5fa8', fontSize: '13px', marginLeft: 'auto', flex: '0 0 auto' },
  '.cm-td-raw': { all: 'unset', cursor: 'pointer', fontSize: '12px', color: '#5d6875', padding: '2px 6px', flex: '0 0 auto' }
}, { dark: false })

export function talkDetailsExtension(): Extension {
  return [
    frontmatterBlockFacet.of((parsed) => new TalkDetailsWidget(parsed ? parsed.pairs : [])),
    keepOut,
    measureField,
    panelTheme
  ]
}
