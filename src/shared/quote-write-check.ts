// =============================================================================
// The last check before a verb writes to a quote slide: does the compiler read the result as the verb meant it?
//
// The quote verbs (src/shared/layout-verbs.ts) read a slide's lines with a reader of their own, because they need
// each line's place to write to. Whatever that reader concluded, the compiler is asked too: the slide is read here
// with the compiler's own slide reading (compiler/scripts/lib/slide-quote-reading.mjs and slide-containers.mjs, the
// functions 08-source-adapters.mjs runs for every slide) on the text before the write and on the text after it.
//
// The check has three answers (`WriteVerdict`):
//   holds     the compiler reads the result as the verb meant it: the write is made;
//   withheld  the compiler was read and DISAGREES (a required condition failed): the write is not made. A shape the
//             verbs' reader gets wrong is then a write not made, never a wrong one;
//   unread    the compiler's reading could not be made at all, so there is nothing to disagree with. A FORM is then
//             decided by the verbs' reader, as it was before this check existed, and is written. A SOURCE LINE is
//             not written: it replaces lines of the slide, and nothing has said which words those lines are.
// A form is stopped only by `withheld`; a source line is written only on `holds`.
//
// What is read, beyond the slide's own lines: a quick check's `{right}` markers and a poll's directive lines leave
// the content as they do in the compiler; a slide folded into a heading above it, one that takes its child headings
// into itself, one whose blocks become a carousel and one whose page shows a poll frame in place of its body are
// read as "the quotation is not drawn here" (`notDrawn`), which withholds a form.
//
// What cannot be read (`unread`): a heading the compiler's tree parse has no slide for, and a slide with more
// `{name}` item endings than are tried. Whether `name` is an icon is in the icon catalogue, which the compiler reads
// from disk and the app does not hold here, so the slide is read once for every way the catalogue could answer (up
// to MAX_ICON_NAMES names): when every reading gives the same answer, that is the answer; when ANY reading
// disagrees, the write is `withheld` (the catalogue may answer that way: `- https://example.org/{zap}` is the link
// `https://example.org/` when `zap` is an icon). With more names than are tried it is `withheld` when the link's own
// line holds a `{…}` group, else `unread`. `{icon=name}` is taken out of the item whatever the catalogue says.
//
// It runs only when a write is about to be returned (a link was edited, a source line was set). Pure: no I/O, no
// Electron, no layout callback. The steps the compiler takes after a slide is read that change neither its layout,
// where its blocks are drawn nor its form (ids, fit, rendering) are not run.
// =============================================================================
import { parseOutlineTree, type OutlineTreeNode } from '../../compiler/scripts/lib/14-outline-tree.mjs'
import { normalizeEmbedUrl } from '../../compiler/scripts/lib/02-triggers-layout.mjs'
import { deckTriggerDefaultsFromMeta, outlineFrontmatterMeta } from '../../compiler/scripts/lib/slide-attrs.mjs'
import { parseSourceLine } from '../../compiler/scripts/lib/quote-forms.mjs'
import { lexMarkdownBlocksWith } from '../../compiler/scripts/lib/03-markdown-lexer-core.mjs'
import { slideReader, type SlideBlock } from '../../compiler/scripts/lib/slide-quote-reading.mjs'
import { childFoldOfNode } from '../../compiler/scripts/lib/slide-containers.mjs'
import { outlineCompilerBody } from './slide-source-text.ts'

/** What the compiler makes of one slide's quotation. */
export interface CompiledQuote {
  /** The compiled slide's layout (`carousel` when {carousel} makes every block of the slide a sub-slide). */
  layout: string
  /** The slide's `form=` value in effect, lower-cased ('' for none). */
  formInEffect: string
  /** The quotation's words, paragraph by paragraph: [] when the slide has no quotation, or one with no words. */
  words: string[]
  /** The source the compiler reads: the quotation's citation (never the slide title standing in for one), or the one
   *  line of a slide that is only its source line; '' when there is none. */
  cite: string
  /** The link of that source ('' when it has none). */
  link: string
  /** The form the quotation is drawn in; null when it is drawn as a plain quote (or the slide is not a quote slide). */
  form: string | null
  /** Drawn in a form with no words: the slide is only its source line. */
  awaiting: boolean
  /** An embed card, a video or an audio file is drawn. */
  card: boolean
  /** The compiler says something else paints beside the quotation, or that there are several quotations. */
  refusedForm: boolean
  /** How many quotations (practice quotes aside) the slide holds. */
  quotations: number
  /** How many blocks other than the one quotation and pictures the slide holds. */
  others: number
  /** Why the quotation read here is not what the compiled slide draws; '' when it is. `folded`: a heading above takes
   *  this slide into its own, so it is no slide. `child-fold`: the slide takes its child headings into itself (cards,
   *  columns, the halves of a comparison), which this reading does not hold. `poll-frame`: the page shows the slide's
   *  poll in place of its body. */
  notDrawn: '' | 'folded' | 'child-fold' | 'poll-frame'
  /** Every quotation of the slide (practice quotes aside), in order: its words, and its citation ('' when it has none
   *  or the slide title stands in for one). */
  quotes: { words: string[]; cite: string }[]
  /** The slide's displayed words without its source (`displayedWords`). */
  displayed: string[]
}

/** `holds`: the compiler agrees. `withheld`: it was read and disagrees. `unread`: it could not be read (see the head of this file). */
export type WriteVerdict = 'holds' | 'withheld' | 'unread'

const isPicture = (block: SlideBlock): boolean => block.type === 'image' || block.type === 'image-row'
const isQuotation = (block: SlideBlock): boolean => block.type === 'quote' && !block.practice
const wordsOf = (block: SlideBlock | undefined): string[] => {
  if (!block) return []
  const paragraphs = Array.isArray(block.paragraphs) && block.paragraphs.length ? block.paragraphs : [block.text ?? '']
  return paragraphs.map((paragraph) => String(paragraph ?? '')).filter((paragraph) => paragraph.trim() !== '')
}

/** What a block holds that is its source, or no words at all: left out of the displayed words. */
const NOT_DISPLAYED_WORDS = new Set(['type', 'cite', 'citeFromTitle', 'quoteForm'])
const stringsOf = (value: unknown, into: string[]): void => {
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const entry of value) stringsOf(entry, into)
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) if (!NOT_DISPLAYED_WORDS.has(key)) stringsOf(entry, into)
}

/**
 * The slide's displayed words as the compiler reads them, without the source: for every block in order, its kind and
 * every string it holds (a quotation's `text` and `paragraphs`, a paragraph's or a subheading's `text`, a list's
 * `items` and their `children`, a card's `src`, a table's cells…), a quotation's `cite` left out. The lines the
 * compiler reads as the source are in no block's words: the lexer folds an attribution into the quotation's `cite`,
 * and so does the address under a quotation with a form (`adoptAddressUnderQuote`). A list is one kind whether or
 * not the quote layout has mapped it.
 */
function displayedWords(blocks: readonly SlideBlock[]): string[] {
  const words: string[] = []
  for (const block of blocks) {
    if (!block) continue
    words.push(`[${block.type === 'feature-list' ? 'list' : block.type}]`)
    stringsOf(block, words)
  }
  return words
}

/** The most `{name}` item endings one check reads every way (2 to the power of it readings of each text). */
const MAX_ICON_NAMES = 3
const iconName = (name: unknown): string => String(name ?? '').trim().toLowerCase()

// The compiler's lexer with a key resolver that has no catalogue: it answers from `iconsKnown` (the names taken as
// icons in this reading) and records every name it was asked about in `iconsAsked`.
let iconsKnown: (name: string) => boolean = () => false
let iconsAsked: Set<string> | null = null
const reader = slideReader((lines) => lexMarkdownBlocksWith(lines, (raw) => {
  const name = iconName(raw)
  if (!name) return null
  iconsAsked?.add(name)
  return iconsKnown(name) ? name : null
}))

/** The heading nodes from the top of the tree down to the first one on a line (1-based), as the compiler's tree parse numbers it. */
function pathToLine(node: OutlineTreeNode, headingLine: number, above: OutlineTreeNode[] = []): OutlineTreeNode[] | null {
  if (node.level >= 2 && node.sourceLine === headingLine) return [...above, node]
  const path = node.level >= 2 ? [...above, node] : above
  for (const child of node.children) {
    const found = pathToLine(child, headingLine, path)
    if (found) return found
  }
  return null
}

/**
 * The compiler's reading of the quotation on the slide whose heading stands on `headingLine` (1-based) of `outline`:
 * the outline as `adaptMarkdownOutlineV2` hands it to the tree parse, the node, then `quoteSlideReading`. Null when
 * the compiler's tree has no slide on that line. `iconKnown(name)` says whether a `{name}` ending a list item is an
 * icon (lower-cased, trimmed); with none given, no name is.
 */
export function compiledQuoteAt(outline: string, headingLine: number, iconKnown: (name: string) => boolean = () => false): CompiledQuote | null {
  const path = pathToLine(parseOutlineTree(outlineCompilerBody(outline).body).root, headingLine)
  if (!path) return null
  const node = path[path.length - 1]
  const defaults = deckTriggerDefaultsFromMeta(outlineFrontmatterMeta(outline)).attrs
  iconsKnown = iconKnown
  let read: ReturnType<typeof reader.quoteSlideReading>
  try {
    read = reader.quoteSlideReading(node, defaults)
  } finally {
    iconsKnown = () => false
  }
  const quotations = read.blocks.filter(isQuotation)
  const quote = quotations.length === 1 ? quotations[0] : undefined
  const others = read.blocks.filter((block) => block && block !== quote && !isPicture(block))
  let cite = quote && !quote.citeFromTitle ? String(quote.cite ?? '') : ''
  if (!quote && others.length === 1) {
    // A slide that is only its source line: the one item of a list, a paragraph, or an address (drawn as a card).
    const only = others[0]
    if ((only.type === 'feature-list' || only.type === 'list') && Array.isArray(only.items) && only.items.length === 1) cite = String(only.items[0] ?? '')
    else if (only.type === 'paragraph' && typeof only.text === 'string') cite = only.text
    else if (only.type === 'embed' && typeof only.src === 'string') cite = only.src
  }
  // A heading above that folds its children takes this slide (and everything under it) into its own.
  const folded = path.slice(0, -1).some((ancestor) => childFoldOfNode(ancestor, defaults) !== '')
  return {
    layout: read.layout,
    formInEffect: String(read.attrs.form ?? '').trim().toLowerCase(),
    words: wordsOf(quote),
    cite,
    link: parseSourceLine(cite).link?.url ?? '',
    form: quote?.quoteForm?.form ?? null,
    awaiting: quote?.quoteForm?.awaiting === true,
    card: read.blocks.some((block) => block && (block.type === 'embed' || block.type === 'video' || block.type === 'audio')),
    refusedForm: read.warnings.some((warning) => /^quote-form-(?:other-content|several-quotes):/.test(warning)),
    quotations: quotations.length,
    others: others.length,
    notDrawn: folded ? 'folded' : read.childFold ? 'child-fold' : read.pollFrame ? 'poll-frame' : '',
    quotes: quotations.map((block) => ({ words: wordsOf(block), cite: block.citeFromTitle ? '' : String(block.cite ?? '') })),
    displayed: displayedWords(read.blocks)
  }
}

type Read = (outline: string, headingLine: number) => CompiledQuote | null

/**
 * One decision over every reading the icon catalogue could give. `decide(read)` answers true (the write holds),
 * false (the compiler disagrees) or null (a slide could not be read). It is asked first with no name taken as an
 * icon; when a `{name}` item ending was met, again for every other choice of names. One answer throughout is the
 * verdict. When the readings do not agree, a reading that disagrees is `withheld` (the catalogue may answer that
 * way), and only readings that differ with no disagreement among them are `unread`. More names than are tried
 * (MAX_ICON_NAMES): `withheld` when `groupOnLinkLine()` says the link's own line holds a `{…}` group, else `unread`.
 */
function overIconReadings(decide: (read: Read) => boolean | null, groupOnLinkLine: () => boolean = () => false): WriteVerdict {
  const names = new Set<string>()
  const ask = (known: ReadonlySet<string>): boolean | null => {
    iconsAsked = names
    try {
      return decide((outline, headingLine) => compiledQuoteAt(outline, headingLine, (name) => known.has(name)))
    } finally {
      iconsAsked = null
    }
  }
  const first = ask(new Set())
  if (first == null) return 'unread'
  if (names.size > MAX_ICON_NAMES) return groupOnLinkLine() ? 'withheld' : 'unread'
  const all = [...names]
  const answers: (boolean | null)[] = [first]
  for (let choice = 1; choice < 2 ** all.length; choice += 1) {
    const answer = ask(new Set(all.filter((_, index) => (choice >> index) & 1)))
    answers.push(answer)
    // A reading met a name the first did not: the readings tried are not all there are.
    if (names.size !== all.length) return answers.includes(false) || groupOnLinkLine() ? 'withheld' : 'unread'
  }
  if (answers.includes(false)) return 'withheld'
  return answers.every((answer) => answer === true) ? 'holds' : 'unread'
}

/**
 * Does a line of the slide that holds `link` also hold a `{…}` group (in the link or after it)? The slide's lines
 * are those from its heading on `headingLine` (1-based) to the next heading. When no line holds the link as written,
 * every line of the slide that is not wholly Trigger groups is asked.
 */
function groupOnLinkLine(outline: string, headingLine: number, link: string): boolean {
  const lines = outline.split('\n')
  let end = headingLine
  while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end += 1
  const own = lines.slice(headingLine, end).filter((line) => !/^\s*(?:\{[^{}]*\}\s*)+$/.test(line))
  const holding = link ? own.filter((line) => line.includes(link)) : []
  return (holding.length ? holding : own).some((line) => /\{[^{}\s][^{}]*\}/.test(line))
}

const sameWords = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((paragraph, index) => paragraph === b[index])

export interface QuoteFormWrite {
  /** The 1-based line of the slide's heading: the same in all three texts (every change is below it). */
  headingLine: number
  /** The outline with the form token written. */
  written: string
  /** The outline as it was handed to the rule: no token yet. */
  withoutToken: string
  /** `withoutToken` with the link's line taken out (the source that follows a quoted paragraph on its own line: cut off it). */
  withoutLink: string
  form: 'web' | 'paper'
  /** The link the rule classified. */
  link: string
  /** The verbs' reader found a quotation (false: a slide that is only its source line). */
  quotation: boolean
}

/**
 * Does the compiler draw the form the rule is about to write? `holds` only when it reads `written` as the rule meant it:
 *   - the slide is a slide of its own, drawn from the blocks read here (`notDrawn` is ''), with the quote layout, one
 *     quotation, the form in effect and drawn, no embed card, video or audio block, and nothing the compiler calls
 *     other content;
 *   - the source link it reads is the link the rule classified;
 *   - the quotation's words are not empty, and are the words it reads without the token and without the link's line:
 *     writing the form changes nothing about which words are the quotation.
 * A slide that is only its source line has no words and stays so: it holds when the compiler reads no words in any
 * of the three texts and nothing at all once the link's line is gone (no quotation was taken into the source).
 * Any of these failing on a slide that was read is `withheld`.
 */
export function quoteFormWriteVerdict(write: QuoteFormWrite): WriteVerdict {
  return overIconReadings((read) => {
    const after = read(write.written, write.headingLine)
    const plain = read(write.withoutToken, write.headingLine)
    const bare = read(write.withoutLink, write.headingLine)
    if (!after || !plain || !bare) return null
    if (after.notDrawn !== '' || after.layout !== 'quote' || after.quotations !== 1 || after.formInEffect !== write.form || after.form !== write.form) return false
    if (after.card || after.refusedForm || after.others !== 0 || after.link !== write.link) return false
    if (!write.quotation) return after.awaiting && after.words.length === 0 && plain.words.length === 0 && bare.words.length === 0 && bare.quotations === 0 && bare.others === 0
    return !after.awaiting && after.words.length > 0 && sameWords(after.words, plain.words) && sameWords(after.words, bare.words)
  }, () => groupOnLinkLine(write.written, write.headingLine, write.link))
}

/** May the form be written? False only when the compiler was read and disagrees (`quoteFormWriteVerdict`). */
export function quoteFormWriteHolds(write: QuoteFormWrite): boolean {
  return quoteFormWriteVerdict(write) !== 'withheld'
}

export interface QuoteSourceWriteCheck {
  headingLine: number
  /** The outline before the source line was written, and after. */
  before: string
  written: string
  /** The text and the link the written source line holds ('' for a part it does not have). */
  text: string
  link: string
}

const squeezed = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * Does the compiler read the source line the verb is about to write, and nothing else differently? One rule,
 * whatever the number of quotations. `unread` only when the compiler's tree has no slide at that heading, before or
 * after the write. Else `holds` only when all of these are so, and `withheld` when any is not:
 *   - the slide has a quotation before the write (with none there is no quotation to attribute);
 *   - the displayed words without the source (`displayedWords`) are the same sequence before and after: no word the
 *     slide shows was taken into the source, or removed, or added beside it;
 *   - there are as many quotations after as before, each with the words it had;
 *   - at most one quotation's citation changed, and that quotation's citation holds the text and the link that were
 *     written (an address the compiler turns into its embed address counts as that link), or, with nothing written
 *     as the source, is empty. When no citation changed, one of them holds the text and the link.
 */
export function quoteSourceWriteVerdict(write: QuoteSourceWriteCheck): WriteVerdict {
  return overIconReadings((read) => {
    const before = read(write.before, write.headingLine)
    const after = read(write.written, write.headingLine)
    if (!before || !after) return null
    if (before.quotes.length === 0 || !sameWords(before.displayed, after.displayed)) return false
    if (after.quotes.length !== before.quotes.length || !before.quotes.every((quote, index) => sameWords(quote.words, after.quotes[index].words))) return false
    const text = squeezed(write.text)
    const link = write.link.trim()
    const holds = (quote: { cite: string }): boolean => {
      const cite = squeezed(quote.cite)
      if (!text && !link) return cite === ''
      if (text && !cite.includes(text)) return false
      return !link || cite.includes(link) || cite.includes(normalizeEmbedUrl(link))
    }
    const changed = after.quotes.filter((quote, index) => quote.cite !== before.quotes[index].cite)
    if (changed.length > 1) return false
    if (changed.length === 1) return holds(changed[0])
    return (text !== '' || link !== '') && after.quotes.some(holds)
  })
}

/** May the source line be written? Only when the compiler was read and agrees (`quoteSourceWriteVerdict`): a slide that cannot be read is not written to. */
export function quoteSourceWriteHolds(write: QuoteSourceWriteCheck): boolean {
  return quoteSourceWriteVerdict(write) === 'holds'
}
