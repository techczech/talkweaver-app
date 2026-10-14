export function parseGridDims(value: unknown): { rows: number; cols: number } | null
/** The layout a slide's attrs name and the attr key that decided (`statement-dimension` for a statement option on the slide's own lines); null when none. */
export function authoredLayoutDecision(attrs: Record<string, unknown>, authoredAttrKeys?: readonly string[] | null): { layout: string | true; by: string } | null
/** The deck-wide `triggers:` defaults of the front matter, as the compiler applies them to every slide. */
export function deckTriggerDefaultsFrom(triggers: unknown): { defaults: Record<string, unknown>; warnings: string[] }
/** Every block of the slide is a chart object: the compiler draws it as a chart whatever its tokens name. */
export function isChartOnlySlide(rawBlocks: ReadonlyArray<{ type?: string } | null | undefined>): boolean
/** Is this heading a section divider by default, and did the author's own tokens override it (the compiler's one decision). */
export function sectionDividerDecision(
  slide: { isSection?: boolean; lines?: readonly string[]; cards?: readonly unknown[]; attrs?: Record<string, unknown> },
  authoredKeys: Iterable<string> | null | undefined,
  authoredLayout?: string
): { divider: boolean; structural: boolean; foldRefused: boolean; authorTokens: string[] }
/** Whether a heading with `childCount` child headings takes them into its own slide, and how; null when they stay slides. */
export function childFoldKind(attrs: Record<string, unknown>, childCount: number): 'carousel' | 'cards' | 'columns' | 'compare' | null
/** What the compiler draws a slide in (the compiled slide's `layout`) and what decided it. */
export interface FinalSlideLayout {
  layout: string
  /** The divider default applied: the heading is kept as a section divider. */
  divider: boolean
  /** Every block is a chart object. */
  chartOnly: boolean
  /** The card treatment, null when none. */
  cardsKind: 'compare' | 'image-grid' | 'static-compare' | 'carousel' | 'static-cards' | null
  /** The style stamped on the slide's lists: numbers, icons, logos, plain; '' when none. */
  listStyle: string
  /** The slide's content holds a list. */
  hasList: boolean
}
interface LayoutTreeNode { level: number; title: string; attrs: Record<string, unknown>; id: string; contentLines: string[]; notesLines: string[]; children: LayoutTreeNode[]; sourceLine: number }
export interface SlideLayoutInput { id: string; title: string; attrs: Record<string, unknown>; lines: string[]; cards: unknown[]; isSection: boolean; authoredAttrKeys: string[] }
/** Folds, in place, every heading that takes its child headings into its own slide, as the compiler does before it makes slides. */
export function foldChildLayoutNodes(nodes: LayoutTreeNode[], options?: { deckTriggerDefaults?: Record<string, unknown>; warnings?: string[]; nodeSourceEndLines?: Map<unknown, number> }): void
/** What a slide is made of, for a node of the folded tree. `lex` is the Markdown lexer. */
export function slideLayoutInput(node: LayoutTreeNode, deckTriggerDefaults: Record<string, unknown>, lex: (lines: readonly string[]) => any[]): SlideLayoutInput
/** The layout of the compiled slide. */
export function finalSlideLayout(slide: SlideLayoutInput, lex: (lines: readonly string[]) => any[]): FinalSlideLayout
