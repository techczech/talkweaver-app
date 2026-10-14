// The parts of slide-quote-reading.mjs the app shares (src/shared/quote-write-check.ts: the check before a quote write).
interface ReadNode { title: string; id: string; attrs?: Record<string, unknown>; contentLines?: readonly string[]; children?: readonly unknown[] }

/** A block of a slide as the compiler holds it. On a quotation: its words, its citation and the form it is drawn in. */
export interface SlideBlock {
  type: string
  practice?: boolean
  text?: string
  paragraphs?: string[]
  cite?: string
  /** The citation is the slide's title (the quotation has no source line). */
  citeFromTitle?: boolean
  quoteForm?: { form: string; awaiting: boolean; presentation: string; picture: boolean }
  items?: unknown[]
  src?: string
}

export interface QuoteSlideReading {
  /** The slide's attributes in effect: the deck's defaults, the heading and Trigger line, Trigger lines among the content. */
  attrs: Record<string, unknown>
  /** The content lines the blocks were read from (Trigger lines folded away, speaker notes never among them). */
  lines: string[]
  /** The compiled slide's layout: what its content was read as, or `carousel` when {carousel} makes every block a sub-slide. */
  layout: string
  /** Mapped and annotated for the quote layout; as lexed for any other. */
  blocks: SlideBlock[]
  /** annotateQuoteForm's warnings (`quote-form-other-content:<id>`…). */
  warnings: string[]
  /** The one quotation of a quote-layout slide, else null. */
  quote: SlideBlock | null
  /** The slide has a poll whose frame the page shows in place of the slide's body: nothing read here is drawn. */
  pollFrame: boolean
  /** The fold that takes the node's child headings into its slide ('' for none): their content is not in this reading. */
  childFold: string
}

/** The slide-reading steps over a lexer (the compiler's, or the same lexer code with another icon-key resolver). */
export function slideReader(lexMarkdownBlocks: (lines: string[]) => unknown[]): {
  /** The quotation the compiler draws for one outline-tree node: the steps 08-source-adapters.mjs takes for a slide. */
  quoteSlideReading(node: ReadNode, deckTriggerDefaults: Record<string, unknown>): QuoteSlideReading
}
