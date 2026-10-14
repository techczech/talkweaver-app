// The Plain view's left margin (spec T7): what each heading line of the outline is called, and for
// a slide, which layout the person has written for it. Pure: no DOM, no CodeMirror.
//
//   `#` line                                   -> Talk
//   a heading with slides under it             -> Section 2.1 (numbered within its parent section), at any depth
//   a compiled row with a section role         -> Section
//   any other compiled row                     -> Slide n (n = the strip's number, index + 1)
//   no row for the heading (not compiled yet)  -> by depth: `##` Section, deeper Slide
//
// "Slides under it" is the compiler's own reading (plain-view-compiler-facts.ts `keptChildren`: the
// child headings left as slides of their own once the headings that take their children are folded).
// A section also says its level (`##` is L1) and how many slides the compiler emits inside it,
// nested sections included. A heading that takes its children into ONE slide (a carousel, cards,
// columns, compare: `foldKind`) is a Section too, with its layout and the count of its items; the
// compiler gives the items no slide of their own, so each reads Slide n.k, n being the number of the
// one slide that holds them.
//
// The layout name under a Slide is the layout the slide WRITES, as the compiler resolves it
// (plain-view-compiler-facts.ts `slideLayouts`, named by slide-authored-layout.ts): the tokens of
// its heading line and of every layout line the compiler folds into it, in every form the compiler
// accepts, with the compiler's own precedence between them. "Auto" when the slide writes none. The
// compiler's choice from the content (`row.layout`) is not shown: it is what Auto resolves to.
//
// A heading the compiler keeps as a section divider (`slideLayouts` `divider`: child headings and an
// empty body) is a Section whatever its tokens name, compiled or not, and is never given the name
// of a layout it will not be drawn in.
import { compilerFactsOf, type SlideLayoutFacts } from './plain-view-compiler-facts.ts'
import { emptyOutlineLines, isStructureLine, outlineHeading, readOutlineLinesOf, type OutlineLines } from './plain-view-outline-lines.ts'
import { layoutEntryFor } from './layout-registry/options.ts'
import { drawnLayoutLabel } from './slide-authored-layout.ts'
import { computeSlideLines, slideNumbersByLine, type SlideLineRow } from './slide-lines.ts'
import { TRIGGER_LINE_RE } from './trigger-line.ts'

export type MarginKind = 'talk' | 'section' | 'slide'

export interface MarginLabel {
  /** 1-based outline line of the heading. */
  line: number
  kind: MarginKind
  /** Slide only, and only when a compiled row gave it. For a folded item: the number of the slide that holds it. */
  number?: number
  /** Slide only: which item of a carousel (cards, columns) heading this is, 1-based; `number` is that heading's slide. */
  item?: number
  /** Section only: "2", "2.1", "2.1.1". */
  sectionNumber?: string
  /** Section only: 1 for a `##` section, 2 for `###`, 3 for `####`. */
  level?: number
  /** Section only: the slides inside it (a folding heading: its items). Absent when nothing says. */
  slideCount?: number
  /** A slide: the layout's name, or "Auto". A section that folds its children into one slide: that layout's name. */
  layoutLabel?: string
}

/** The margin word of a label, as the gutter draws it ("Section 2.1", "Slide 3.1"; CSS upper-cases it). */
export function marginWord(label: Pick<MarginLabel, 'kind' | 'number' | 'item' | 'sectionNumber'>): string {
  if (label.kind === 'talk') return 'Talk'
  if (label.kind === 'section') return label.sectionNumber ? `Section ${label.sectionNumber}` : 'Section'
  if (label.number == null) return 'Slide'
  return label.item != null ? `Slide ${label.number}.${label.item}` : `Slide ${label.number}`
}

/** The quiet second line of a section ("L1 · 3 slides"), or '' when the label has none. */
export function marginDetail(label: Pick<MarginLabel, 'kind' | 'level' | 'slideCount'>): string {
  if (label.kind !== 'section' || label.level == null || label.slideCount == null) return ''
  return `L${label.level} \u00b7 ${label.slideCount} ${label.slideCount === 1 ? 'slide' : 'slides'}`
}

export type MarginRow = SlideLineRow & { layout?: string; triggers?: Record<string, string> }

export const AUTO_LAYOUT_LABEL = 'Auto'
/** The layouts the margin's layout menu lists under Auto, in order (spec T9); the rest are in the Inspector. */
export const MARGIN_LAYOUT_NAMES: readonly string[] = ['list', 'iconlist', 'numbered', 'cards', 'compare', 'image-grid']
const SECTION_ROLES = new Set(['section-title', 'subsection-title'])

/**
 * True for a line made only of `{…}` groups. A cheap test of the text alone: it never decides that
 * a line is hidden or protected (`hiddenLayout` does, with the compiler's answer). It is one of
 * that rule's conditions, so where it is false nothing is hidden: a caller may use it to skip work.
 */
export function isTriggerLineText(text: string): boolean {
  return TRIGGER_LINE_RE.test(text.replace(/\r$/, '').trim())
}

/** What the layout-line rule reads: the outline lines and the lines the compiler removes (PlainViewFacts has both). */
export interface LayoutLineFacts {
  read: OutlineLines
  compiler: { layoutLines: ReadonlySet<number>; layoutLineHeading: ReadonlyMap<number, number>; slideLayouts: ReadonlyMap<number, SlideLayoutFacts> }
}

/** A stretch of consecutive lines Plain hides: layout lines, and a blank line hidden with them. */
export interface HiddenRun {
  /** 0-based line above the hidden lines: the caret rests at its end. */
  above: number
  /** The first and last hidden line. `first` is a blank line when `blankFirst`. */
  first: number
  last: number
  /**
   * The line before the first layout line is blank and is drawn hidden with it, so that the blank
   * line before a hidden layout line and the one after it read as one line of space. Display only:
   * it is an ordinary line, shown while the caret is on it, and nothing protects it.
   */
  blankFirst: boolean
  /** The layout lines among them, in order. */
  layout: readonly number[]
}

export interface HiddenLayout {
  /** Every line Plain hides as a layout line (0-based), in order. */
  lines: readonly number[]
  set: ReadonlySet<number>
  /** The hidden layout lines of each slide, by the 0-based line of its heading (the compiler's own slide). */
  byHeading: ReadonlyMap<number, readonly number[]>
  runs: readonly HiddenRun[]
  /** The run whose hidden lines start directly under line `above`. */
  runAfter: ReadonlyMap<number, HiddenRun>
}

const hiddenLayoutCache = new WeakMap<LayoutLineFacts, HiddenLayout>()

/**
 * The layout lines Plain hides: the ONE rule, read by hiddenLines.ts, placeholders.ts, the margin
 * (its label here, its marker in plainView/margin.ts), the layout verbs and the generated test.
 *
 * A line is hidden if and only if the compiler takes it out of its slide's content as a layout
 * line (plain-view-compiler-facts.ts `layoutLines`: a heading's Trigger block, an id-only line, a
 * stray Trigger line anywhere in the slide) and reads it whole (not partly inside an HTML
 * comment). Where it stands in the slide does not matter. A `{…}` line the compiler keeps as
 * content is shown: a chart token that owns the list under it, a `{…}` line before the first slide.
 *
 * `runs` is how they are drawn and stepped over: consecutive hidden lines are one run. A blank line
 * directly before a run, when a line follows the run, is drawn hidden with it (`blankFirst`); two
 * runs that such a blank line separates are one.
 *
 * The answer is kept by the facts object (one per document text): `textOf` must read that text.
 */
export function hiddenLayout(facts: LayoutLineFacts, textOf: (index: number) => string, lineCount: number): HiddenLayout {
  const known = hiddenLayoutCache.get(facts)
  if (known) return known
  const lines: number[] = []
  for (const j of [...facts.compiler.layoutLines].sort((x, y) => x - y)) {
    if (j < lineCount && isStructureLine(facts.read, j) && isTriggerLineText(textOf(j))) lines.push(j)
  }
  const set = new Set(lines)
  const byHeading = new Map<number, number[]>()
  for (const j of lines) {
    const h = facts.compiler.layoutLineHeading.get(j)
    if (h === undefined) continue
    const list = byHeading.get(h)
    if (list) list.push(j); else byHeading.set(h, [j])
  }
  const runs: Array<{ above: number; first: number; last: number; blankFirst: boolean; layout: number[] }> = []
  const blank = (j: number): boolean => j >= 0 && isStructureLine(facts.read, j) && textOf(j).trim() === ''
  for (const j of lines) {
    const prev = runs[runs.length - 1]
    if (prev && prev.last === j - 1) { prev.last = j; prev.layout.push(j); continue }
    if (j < 1) continue
    runs.push({ above: j - 1, first: j, last: j, blankFirst: false, layout: [j] })
  }
  const merged: typeof runs = []
  for (const run of runs) {
    // The blank line before it goes with it when something follows the run and something stands above the blank line.
    const prev = merged[merged.length - 1]
    if (run.last + 1 < lineCount && run.first >= 2 && blank(run.first - 1)) {
      if (prev && prev.last === run.first - 2) { prev.last = run.last; prev.layout.push(...run.layout); continue }
      run.blankFirst = true
      run.first -= 1
      run.above -= 1
    }
    merged.push(run)
  }
  const out: HiddenLayout = { lines, set, byHeading, runs: merged, runAfter: new Map(merged.map((run) => [run.above, run])) }
  hiddenLayoutCache.set(facts, out)
  return out
}

/** Every line Plain hides as a layout line (0-based), for the whole document. */
export function hiddenLayoutLines(facts: LayoutLineFacts, lines: readonly string[]): number[] {
  return [...hiddenLayout(facts, (j) => lines[j], lines.length).lines]
}

/**
 * The margin's layout label of the slide whose heading is on line `index` (0-based): "Auto" when
 * the slide writes no layout; when it writes one, the layout the compiler DRAWS it in
 * (slide-authored-layout.ts drawnLayoutOf: a slide of charts only is "Chart" under {cards}, a
 * paragraph under {iconlist} is "Statement"). The ONE reader of "which layout does this slide
 * have" (the margin compiled or not, the layout menu's current row).
 * Only for a document the compiler's reading threw on (no facts at all) is the compiled row's own
 * `triggers.layout` used.
 */
export function slideLayoutLabel(facts: LayoutLineFacts, index: number, row?: MarginRow | null): string {
  const slide = facts.compiler.slideLayouts.get(index)
  // A divider is drawn as a divider: the layout its tokens name is not what the slide gets.
  if (slide?.divider) return AUTO_LAYOUT_LABEL
  if (slide) return drawnLayoutLabel(slide) ?? AUTO_LAYOUT_LABEL
  const name = row?.triggers?.layout
  return (name && layoutEntryFor(name)?.label) || AUTO_LAYOUT_LABEL
}

/** The compiler keeps the heading on line `index` (0-based) as a section divider: the margin calls it a Section. */
export function isDividerHeading(facts: LayoutLineFacts, index: number): boolean {
  return facts.compiler.slideLayouts.get(index)?.divider === true
}

/** Facts for a document the compiler's reading threw on: nothing is outline, so nothing is hidden, protected or labelled. */
export function emptyLayoutFacts(text: string): LayoutLineFacts {
  return { read: emptyOutlineLines(text), compiler: { layoutLines: new Set(), layoutLineHeading: new Map(), slideLayouts: new Map() } }
}

// The margin's labels are asked for several times for one text (the memo in WorkspaceLayout, then a
// click on a marker): the last text's facts are kept. The two readings are the ones the editor and
// the verbs have for the same text (memo-by-text.ts), not computed again here.
let lastFacts: { text: string; facts: LayoutLineFacts } | null = null
function layoutFactsOf(text: string): LayoutLineFacts {
  if (lastFacts?.text !== text) {
    let facts: LayoutLineFacts
    // Fail open: a document the compiler's reading throws on gets no labels, and the editor goes on.
    try { facts = { read: readOutlineLinesOf(text), compiler: compilerFactsOf(text) } } catch { facts = emptyLayoutFacts(text) }
    lastFacts = { text, facts }
  }
  return lastFacts.facts
}

interface HeadingInfo { line: number; depth: number; index: number }

/**
 * Heading lines on lines the compiler reads as outline (plain-view-outline-lines.ts: not front
 * matter, fenced code, a comment or notes).
 */
function scanHeadings(outlineText: string, lines: readonly string[]): HeadingInfo[] {
  const out: HeadingInfo[] = []
  const facts = layoutFactsOf(outlineText)
  const read = facts.read
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i]
    const m = outlineHeading(read, i, text)
    if (!m) continue
    out.push({ line: i + 1, depth: m.level, index: i })
  }
  return out
}

/**
 * The compiler keeps this heading as a section: it has child headings that stay slides of their own
 * (`keptChildren`), or it is a divider (the same thing, for a heading whose body is empty). A heading
 * that folds its children into its own slide is a section only to `foldedSection`.
 */
export function isSectionHeading(facts: LayoutLineFacts, index: number): boolean {
  const slide = facts.compiler.slideLayouts.get(index)
  return slide !== undefined && (slide.divider || slide.keptChildren.length > 0)
}

/** The heading takes its children into its one slide (carousel, cards, columns, compare). */
function foldedSection(facts: LayoutLineFacts, index: number): SlideLayoutFacts | null {
  const slide = facts.compiler.slideLayouts.get(index)
  return slide && slide.foldKind && slide.keptChildren.length === 0 && slide.children.length > 0 ? slide : null
}

const FOLD_NAMES: Record<string, string> = { carousel: 'Carousel', cards: 'Cards', columns: 'Columns', compare: 'Compare' }

/** A folding heading's layout: the one its tokens name, else the one its fold makes ({carousel} alone names no layout to the compiler). */
function foldLayoutLabel(facts: LayoutLineFacts, index: number, slide: SlideLayoutFacts, row?: MarginRow): string {
  const named = slideLayoutLabel(facts, index, row)
  if (named !== AUTO_LAYOUT_LABEL) return named
  const name = FOLD_NAMES[slide.foldKind ?? ''] ?? AUTO_LAYOUT_LABEL
  return layoutEntryFor(name.toLowerCase())?.label ?? name
}

export function marginLabels(rows: readonly MarginRow[] | null | undefined, outlineText: string): MarginLabel[] {
  const lines = outlineText.split('\n')
  const headings = scanHeadings(outlineText, lines)
  const compiled = rows && rows.length > 0 ? rows : null
  const slideLines = compiled ? computeSlideLines(compiled, outlineText) : []
  const numbers = slideNumbersByLine(slideLines)
  const rowByLine = new Map<number, MarginRow>()
  slideLines.forEach((line, index) => {
    if (typeof line === 'number' && !rowByLine.has(line)) rowByLine.set(line, compiled![index])
  })
  const facts = layoutFactsOf(outlineText)
  const isSectionRow = (row: MarginRow | undefined): boolean => Boolean(row?.role && SECTION_ROLES.has(row.role))
  // A divider is no slide of the section's content. The compiler's own answer when it has one: a heading with a body and slides under it has a section role too, and is a slide.
  const isDividerRow = (line: number, row: MarginRow): boolean => facts.compiler.slideLayouts.get(line - 1)?.divider ?? isSectionRow(row)

  // The slides inside the section on heading `at` (its subtree is the headings up to the next one of
  // its depth or shallower): the compiled slides whose heading stands there and that are no divider;
  // before anything is compiled, the headings the compiler leaves as slides.
  const slidesInside = (at: number): number => {
    const first = headings[at]
    let end = lines.length + 1
    for (let k = at + 1; k < headings.length; k += 1) if (headings[k].depth <= first.depth) { end = headings[k].line; break }
    if (compiled) {
      let count = 0
      slideLines.forEach((line, index) => {
        if (typeof line === 'number' && line >= first.line && line < end && !isDividerRow(line, compiled[index])) count += 1
      })
      return count
    }
    let count = 0
    for (let k = at + 1; k < headings.length && headings[k].line < end; k += 1) {
      const slide = facts.compiler.slideLayouts.get(headings[k].index)
      if (slide ? slide.final !== null && !isSectionHeading(facts, headings[k].index) : headings[k].depth > 2) count += 1
    }
    return count
  }

  // Section numbers: the sections above the heading, by depth, and how many each has had so far.
  const open: Array<{ depth: number; path: number[]; used: number }> = []
  const topUsed = { n: 0 }
  let slideOrder = 0
  // The heading that folds its children, while its subtree runs: the headings in it are its items.
  let folding: { depth: number; slideNumber: number | undefined; children: readonly number[] } | null = null

  return headings.map(({ line, depth, index }, at): MarginLabel => {
    if (depth === 1) return { line, kind: 'talk' }
    if (folding && depth <= folding.depth) folding = null
    const row = rowByLine.get(line)
    const inFold = folding !== null && depth > folding.depth
    const folded = inFold ? null : foldedSection(facts, index)
    const section = !inFold && (folded !== null || isSectionRow(row) || isSectionHeading(facts, index) || (!row && depth === 2))
    if (section) {
      while (open.length && open[open.length - 1].depth >= depth) open.pop()
      const parent = open[open.length - 1]
      const ordinal = parent ? ++parent.used : ++topUsed.n
      const path = [...(parent?.path ?? []), ordinal]
      if (!folded) open.push({ depth, path, used: 0 })
      const label: MarginLabel = { line, kind: 'section', sectionNumber: path.join('.'), level: depth - 1 }
      if (folded) {
        folding = { depth, slideNumber: numbers.get(line), children: folded.children }
        label.slideCount = folded.children.length
        label.layoutLabel = foldLayoutLabel(facts, index, folded, row)
      } else {
        label.slideCount = slidesInside(at)
        // A heading with a body AND slides under it is a slide of its own as well (the compiler draws it, and its layout
        // menu works): the section keeps its layout line.
        const own = facts.compiler.slideLayouts.get(index)?.final
        if (own && !own.divider) label.layoutLabel = slideLayoutLabel(facts, index, row)
      }
      return label
    }
    slideOrder += 1
    const item = inFold ? folding!.children.indexOf(index) : -1
    return {
      line, kind: 'slide',
      // A compiled row gives the number; not compiled, it is the order among slide headings, and only when nothing is compiled at all.
      ...(item >= 0 ? { number: folding!.slideNumber, item: item + 1 } : compiled ? (row ? { number: numbers.get(line) } : {}) : { number: slideOrder }),
      layoutLabel: slideLayoutLabel(facts, index, row)
    }
  })
}
