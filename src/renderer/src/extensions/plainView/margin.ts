// The compact Outline gutter. Numbers track the compiler's margin labels, and the
// heading-level and layout menus act on the heading beside the clicked number.
import { EditorView, GutterMarker, gutter } from '@codemirror/view'
import { Prec, StateEffect, StateField, type EditorState, type Extension, type Text } from '@codemirror/state'
import { isSectionHeading, marginDetail, marginWord, slideLayoutLabel, type MarginLabel } from '../../../../shared/plain-view-margin'
import { headingAt, plainFactsOf } from './outlineLines'

/** What the margin raises when a person opens one of its menus. `line` is the heading's 1-based line. */
export interface MarginMenuHandlers {
  onLevelMenu?: (line: number, anchor: DOMRect) => void
  onLayoutMenu?: (line: number, anchor: DOMRect) => void
}

/** What a label says, without its line: the anchor keeps it with the position it rides. */
type Words = Omit<MarginLabel, 'line'>
interface Anchor extends Words { pos: number }

const setAnchors = StateEffect.define<readonly Anchor[]>()

const anchorField = StateField.define<readonly Anchor[]>({
  create: () => [],
  update(anchors, tr) {
    for (const effect of tr.effects) if (effect.is(setAnchors)) return effect.value
    if (!tr.docChanged || !anchors.length) return anchors
    return anchors.map((a) => ({ ...a, pos: tr.changes.mapPos(a.pos, 1) }))
  }
})

const WORD_FIELDS = ['kind', 'number', 'item', 'sectionNumber', 'level', 'slideCount', 'layoutLabel'] as const

class MarginMarker extends GutterMarker {
  constructor(
    private readonly words: Words,
    private readonly lineNo: number,
    private readonly active: boolean,
    private readonly handlers: MarginMenuHandlers
  ) { super() }

  eq(other: MarginMarker): boolean {
    return other.lineNo === this.lineNo && other.active === this.active && other.handlers === this.handlers && WORD_FIELDS.every((field) => other.words[field] === this.words[field])
  }

  /** The button's rectangle, reaching down to the bottom of the whole label so a menu never covers the other half of it. */
  private anchorRect(box: HTMLElement, button: HTMLElement): DOMRect {
    const b = button.getBoundingClientRect(), all = box.getBoundingClientRect()
    return new DOMRect(b.left, b.top, b.width, Math.max(b.bottom, all.bottom) - b.top)
  }

  toDOM(): Node {
    const box = document.createElement('div')
    box.className = `cm-plain-margin-label cm-plain-margin-${this.words.kind}${this.active ? ' cm-plain-margin-active' : ''}`
    box.dataset.marginKind = this.words.kind
    box.dataset.marginLine = String(this.lineNo)
    const word = document.createElement('button')
    word.type = 'button'
    word.className = 'cm-plain-margin-word'
    const description = marginWord(this.words)
    word.textContent = this.words.kind === 'talk' ? '#'
      : this.words.kind === 'section' ? (this.words.sectionNumber ? `§${this.words.sectionNumber}` : '§')
      : this.words.number == null ? '•'
      : this.words.item == null ? String(this.words.number) : `${this.words.number}.${this.words.item}`
    if (this.words.kind === 'section') word.title = [description, marginDetail(this.words)].filter(Boolean).join(' · ')
    word.setAttribute('aria-haspopup', 'menu')
    word.setAttribute('aria-label', `${description}: change this heading's level`)
    word.addEventListener('click', () => this.handlers.onLevelMenu?.(this.lineNo, this.anchorRect(box, word)))
    box.append(word)
    const layoutLabel = this.words.layoutLabel
    if (layoutLabel && this.words.kind !== 'talk') {
      const layout = document.createElement('button')
      layout.type = 'button'
      layout.className = 'cm-plain-margin-layout'
      layout.setAttribute('aria-haspopup', 'menu')
      layout.setAttribute('aria-label', `Layout: ${layoutLabel}. Change this slide's layout`)
      const name = document.createElement('span')
      name.textContent = layoutLabel
      const chevron = document.createElement('span')
      chevron.className = 'cm-plain-margin-chevron'
      chevron.setAttribute('aria-hidden', 'true')
      chevron.textContent = '\u2304'
      layout.append(name, chevron)
      layout.addEventListener('click', () => this.handlers.onLayoutMenu?.(this.lineNo, this.anchorRect(box, layout)))
      box.append(layout)
    }
    return box
  }
}

/** The 1-based line of the heading that holds the caret: the nearest heading line at or above it. */
const caretHeadingCache = new WeakMap<EditorState, number>()
export function caretHeadingLine(state: EditorState): number {
  const cached = caretHeadingCache.get(state)
  if (cached !== undefined) return cached
  const doc = state.doc
  let found = 0
  for (let n = doc.lineAt(state.selection.main.head).number; n >= 1; n -= 1) {
    if (headingAt(doc, n)) { found = n; break }
  }
  caretHeadingCache.set(state, found)
  return found
}

function markerFor(state: EditorState, from: number, to: number, handlers: MarginMenuHandlers): MarginMarker | null {
  const doc = state.doc
  // A heading only on a line the compiler reads as outline (outlineLines.ts): a `##` line in
  // fenced code, a comment, notes or the front matter gets no label.
  if (doc.sliceString(from, Math.min(to, from + 1)) !== '#') return null
  const lineNo = doc.lineAt(from).number
  const m = headingAt(doc, lineNo)
  if (!m) return null
  const active = caretHeadingLine(state) === lineNo
  const anchor = state.field(anchorField).find((a) => a.pos === from)
  if (anchor) return new MarginMarker(anchor, lineNo, active, handlers)
  // Not (yet) in the compiled rows: depth decides.
  const depth = m.level
  // A deeper heading with slides under it is a Section too (plain-view-margin.ts isSectionHeading).
  const facts = plainFactsOf(doc)
  const section = depth === 2 || (depth > 2 && isSectionHeading(facts, lineNo - 1))
  if (depth === 1) return new MarginMarker({ kind: 'talk' }, lineNo, active, handlers)
  return new MarginMarker(section ? { kind: 'section' } : { kind: 'slide', layoutLabel: slideLayoutLabel(facts, lineNo - 1) }, lineNo, active, handlers)
}

const WIDTH = '40px'

const marginTheme = EditorView.theme({
  '.cm-gutter.cm-plain-margin': { width: WIDTH, minWidth: WIDTH, maxWidth: WIDTH, boxSizing: 'border-box', overflow: 'visible' },
  '.cm-plain-margin .cm-gutterElement': { padding: '0 2px 0 1px', boxSizing: 'border-box' },
  '.cm-plain-margin-label': {
    position: 'relative', display: 'flex', justifyContent: 'flex-end', width: '100%', marginTop: '3px',
    fontFamily: "-apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif"
  },
  '.cm-plain-margin-word, .cm-plain-margin-layout': {
    appearance: 'none', background: 'transparent', border: '0', borderRadius: '5px',
    cursor: 'pointer', fontFamily: 'inherit', lineHeight: '16px', padding: '0 4px'
  },
  '.cm-plain-margin-word': {
    maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    color: 'var(--faint)', fontSize: '11.5px', fontWeight: '600', fontVariantNumeric: 'tabular-nums'
  },
  // A floating control keeps the layout available on hover and Tab without taking a row or column.
  '.cm-plain-margin-layout': {
    position: 'absolute', insetBlockStart: '100%', insetInlineStart: '0', zIndex: '1',
    width: 'max-content', maxWidth: '9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    color: 'var(--accent-text)', background: 'var(--panel)', border: '1px solid var(--line-strong)',
    fontSize: '12px', opacity: '0', pointerEvents: 'none'
  },
  '.cm-plain-margin-label:hover .cm-plain-margin-layout, .cm-plain-margin-label:focus-within .cm-plain-margin-layout': {
    opacity: '1', pointerEvents: 'auto'
  },
  '.cm-plain-margin-chevron': { marginInlineStart: '3px' },
  '.cm-plain-margin-word:hover, .cm-plain-margin-layout:hover, .cm-plain-margin-word[aria-expanded="true"], .cm-plain-margin-layout[aria-expanded="true"]': {
    background: 'var(--accent-soft)', color: 'var(--accent-text)'
  },
  '.cm-plain-margin-word:focus-visible, .cm-plain-margin-layout:focus-visible': { outline: '2px solid var(--focus)', outlineOffset: '-1px' },
  '.cm-plain-margin-active .cm-plain-margin-word': { color: 'var(--accent-text)', fontWeight: '800' }
})

function marginGutter(handlers: MarginMenuHandlers): Extension {
  return gutter({
    class: 'cm-plain-margin',
    lineMarker: (view, line) => markerFor(view.state, line.from, line.to, handlers),
    lineMarkerChange: (update) => update.docChanged || update.selectionSet || update.transactions.some((tr) => tr.effects.some((e) => e.is(setAnchors))),
    initialSpacer: () => new MarginMarker({ kind: 'talk' }, 0, false, handlers)
  })
}

export function marginExtension(handlers: MarginMenuHandlers = {}): Extension {
  return [anchorField, Prec.high(marginGutter(handlers)), marginTheme]
}

/** Trailing `{…}` groups on a heading line are hidden in Plain; the caret goes before them. */
export function headingTextEnd(view: EditorView, line: number): number {
  const l = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines))
  const trimmed = l.text.replace(/\s*(?:\{[^}]*\})+\s*$/, '').replace(/\s+$/, '')
  return l.from + Math.max(trimmed.length, 0)
}

/** Put the caret at the end of the heading's visible text and give the editor focus. */
export function focusHeading(view: EditorView, line: number): void {
  const at = headingTextEnd(view, line)
  view.dispatch({ selection: { anchor: at }, scrollIntoView: true })
  view.focus()
}

/** The heading holding the caret and where to draw a menu for it: its margin word, else the heading line. */
export function caretHeadingTarget(view: EditorView): { line: number; anchor: DOMRect } | null {
  const line = caretHeadingLine(view.state)
  if (!line) return null
  const word = view.dom.querySelector(`.cm-plain-margin-label[data-margin-line="${line}"] .cm-plain-margin-word`)
  if (word) return { line, anchor: word.getBoundingClientRect() }
  const coords = view.coordsAtPos(view.state.doc.line(line).from)
  const rect = coords ? new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top) : view.dom.getBoundingClientRect()
  return { line, anchor: rect }
}

/** Feed the margin from `marginLabels`: one anchor per heading line. */
export function setMarginLabels(view: EditorView, labels: readonly MarginLabel[]): void {
  const doc = view.state.doc
  const anchors: Anchor[] = []
  for (const l of labels) {
    if (l.line >= 1 && l.line <= doc.lines) anchors.push({ pos: doc.line(l.line).from, ...Object.fromEntries(WORD_FIELDS.map((field) => [field, l[field]])) as Words })
  }
  view.dispatch({ effects: setAnchors.of(anchors) })
}
