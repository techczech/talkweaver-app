// Plain view, ticket 06 (spec states table, "Empty new slide"): grey placeholders drawn as widgets,
// never text in the file. They vanish when the line has a character, cannot be selected, and exist
// only in Plain (Markdown mode does not load this extension).
//
//  * "Slide title" after a heading that has no text (`## ` and nothing after the marks).
//  * "Write, or press / to insert" on the empty line that is the whole body of a slide: the first
//    line after the heading and the lines hidden directly under it, with only blank lines until the next
//    heading. It shows when the heading is empty too (a slide just made), or while the caret is on
//    that line (a title typed, Enter pressed), so a titled section with a blank line under it stays quiet.
//    `/` opens the Insert menu today, so the wording names it.
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { EditorState, StateField, type Extension, type Range, type Text } from '@codemirror/state'
import { headingLine } from '../../../../shared/plain-view-heading-line'
import { isStructureLine, outlineHeading } from '../../../../shared/plain-view-outline-lines'
import { hiddenLayoutOf, plainFactsOf } from './outlineLines'
import { headingTail } from './headingTail'
import { startBodyWithBullet } from '../outliner'

export const TITLE_PLACEHOLDER = 'Slide title'
const SECTION_PLACEHOLDER = 'Section name'
export const BODY_PLACEHOLDER = 'Write, or press / to insert'

/** Marks alone (`##`): no heading yet for the compiler or the other rules, but a title being typed, which gets its placeholder. */
const BARE_MARKS = /^#{1,6}$/
const isHeading = (text: string): boolean => !!headingLine(text) || BARE_MARKS.test(text)


class PlaceholderWidget extends WidgetType {
  constructor(readonly text: string, readonly kind: 'title' | 'body') { super() }
  eq(other: PlaceholderWidget): boolean { return other.text === this.text && other.kind === this.kind }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = `cm-plain-placeholder cm-plain-placeholder-${this.kind}`
    span.textContent = this.text
    span.setAttribute('aria-hidden', 'true')
    return span
  }
  ignoreEvent(): boolean { return true }
}

/** Positions of the placeholders for a document and the carets in it. Exported for tests. */
export function placeholderSpots(doc: Text, heads: readonly number[]): Array<{ pos: number; kind: 'title' | 'body'; section?: true }> {
  const spots: Array<{ pos: number; kind: 'title' | 'body'; section?: true }> = []
  // Only lines the compiler reads whole as outline are looked at (outlineLines.ts): a `##` line in
  // fenced code, a comment, notes or the front matter is no title.
  const facts = plainFactsOf(doc)
  const read = facts.read
  const hidden = hiddenLayoutOf(doc)
  // (A title with a comment on its line is a title when the compiler reads one there.)
  const headingOn = (k: number): boolean => isStructureLine(read, k - 1) ? isHeading(doc.line(k).text) : !!outlineHeading(read, k - 1, doc.line(k).text)
  for (let n = 1; n <= doc.lines; n += 1) {
    if (!headingOn(n)) continue
    const line = doc.line(n)
    const heading = headingLine(line.text)
    const tail = headingTail(line.from, line.text)
    const emptyTitle = BARE_MARKS.test(line.text) || !!heading?.empty ||
      (!!heading && !!tail && tail.textEnd <= line.from + heading.textFrom)
    const section = facts.compiler.slideLayouts.get(n - 1)?.divider
    if (emptyTitle) spots.push({ pos: tail?.textEnd ?? line.to, kind: 'title', ...(section ? { section: true } : {}) })
    if (section) continue
    // The body: skip the layout lines under the heading, then it must be blank up to the next heading.
    const under = hidden.runAfter.get(n - 1)
    const m = under ? under.last + 2 : n + 1
    if (m > doc.lines || doc.line(m).text !== '') continue
    let k = m
    // (A hidden layout line further down the slide is no body text: it counts as blank here.)
    while (k <= doc.lines && (doc.line(k).text.trim() === '' || hidden.set.has(k - 1))) k += 1
    if (k <= doc.lines && !headingOn(k)) continue
    const bodyLine = doc.line(m)
    if (emptyTitle || heads.some((h) => h >= bodyLine.from && h <= bodyLine.to)) spots.push({ pos: bodyLine.from, kind: 'body' })
  }
  return spots
}

function build(state: EditorState): DecorationSet {
  const heads = state.selection.ranges.map((r) => r.head)
  const bodyPlaceholder = state.facet(startBodyWithBullet) ? 'First point' : BODY_PLACEHOLDER
  const ranges: Range<Decoration>[] = placeholderSpots(state.doc, heads).map((s) =>
    Decoration.widget({ widget: new PlaceholderWidget(s.kind === 'title' ? s.section ? SECTION_PLACEHOLDER : TITLE_PLACEHOLDER : bodyPlaceholder, s.kind), side: 1 }).range(s.pos))
  return Decoration.set(ranges, true)
}

const placeholderField = StateField.define<DecorationSet>({
  create: build,
  update: (value, tr) => (tr.docChanged || tr.selection ||
    tr.startState.facet(startBodyWithBullet) !== tr.state.facet(startBodyWithBullet) ? build(tr.state) : value),
  provide: (f) => EditorView.decorations.from(f)
})

const placeholderTheme = EditorView.theme({
  '.cm-plain-placeholder': { color: 'var(--faint)', pointerEvents: 'none', userSelect: 'none', whiteSpace: 'nowrap' },
  '.cm-plain-placeholder-title': { fontWeight: '700', fontSize: '1.25em' }
}, { dark: false })

export function placeholdersExtension(): Extension {
  return [placeholderField, placeholderTheme]
}
