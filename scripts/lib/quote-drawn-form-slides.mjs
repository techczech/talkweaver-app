// Fifth review round of quote forms ticket 10 (13 October): generated quote slides, and what "the compiler draws the
// form" means. Shared by scripts/test-quote-forms-address-under-quote.mjs (section C2, through
// scripts/lib/quote-drawn-form-cases.mjs) and scripts/test-quote-forms-base-regression.mjs. Plain Node.
//
//   registryTokens()   every `{…}` token the layout registry holds: each entry's trigger (layouts, containers,
//                      modifiers, components), each of their option values, and every global option value. Read from
//                      the registry, so a token added there is generated here. `quote` itself and the `form=` values
//                      are left out (a form chosen by hand turns the link-edit rule off).
//   comboSlides()      a quote slide for every token and every way the token can meet it: beside `quote` on the layout
//                      line (after it and before it), as a Trigger line among the content, with two child headings
//                      under the slide or none, on the slide alone (no `quote`), and on a heading the quote slide is
//                      a child of.
//   drawnForm()        the statement itself, asked of the full compiler (`prepareSource`): the slide is a slide of
//                      its own with the quote layout, its one quotation carries that form, no card is drawn, the
//                      words are the words compiled before the edit, the cited link is the typed one, and the page
//                      built from the model shows the form's figure for that slide.
//   displayedWords()   sixth review round: the displayed words of compiled slides without the source, for the
//                      statement about `set-quote-source` (a source write changes the source and nothing else).
//                      `compiledWords()` is the first quotation's words alone: on a slide the compiler reads no
//                      quotation on it is [] whatever the slide shows, so it says nothing about a paragraph.
import { statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prepareSource } from '../../compiler/scripts/lib/08-source-adapters.mjs'
import { parseSourceLine } from '../../compiler/scripts/lib/quote-forms.mjs'
import { GLOBAL_OPTION_GROUPS, LAYOUTS } from '../../src/shared/layout-registry/entries.ts'

export const WEB = 'https://example.org/schemas-and-propositions'
export const DOI = 'https://doi.org/10.1000/xyz123'
export const NOTES = ':::notes\nsecret words for the speaker\n:::'

/** Attributes the compiler reads that the registry does not list as a value: the ones a review named. */
export const UNLISTED_TOKENS = ['check=false', 'polltop=2', 'pollskip', 'cols=2', 'layout=carousel', 'role=opening', 'role=ending']

export function registryTokens() {
  const tokens = new Set()
  for (const entry of LAYOUTS) {
    const braces = String(entry.trigger).match(/^\{([^{}]+)\}$/)
    if (braces) tokens.add(braces[1])
    for (const group of entry.options ?? []) for (const value of group.values) if (value.token) tokens.add(value.token)
  }
  for (const group of GLOBAL_OPTION_GROUPS) for (const value of group.values) if (value.token) tokens.add(value.token)
  for (const token of UNLISTED_TOKENS) tokens.add(token)
  return [...tokens].filter((token) => token !== 'quote' && !/^form=/.test(token))
}

/** The tokens of the registry's entries that are a layout or a container: the ones that can move a slide's blocks. */
export function registryLayoutTokens() {
  return LAYOUTS.filter((entry) => entry.kind === 'layout' || entry.kind === 'container').map((entry) => String(entry.trigger).match(/^\{([^{}]+)\}$/)?.[1]).filter((token) => token && token !== 'quote')
}

const CHILDREN = ['', '#### First child', '', 'Text of the first child.', '', '#### Second child', '', 'Text of the second child.']
export const VARIANTS = ['after quote', 'before quote', 'among the content', 'alone', 'after quote, child headings', 'before quote, child headings', 'among the content, child headings', 'on the heading above']

/** One slide (in a section of its own, so a token that configures a section touches no other slide): `content` are its body lines. */
export function comboSlide(id, token, variant, content) {
  const kids = variant.endsWith('child headings') ? CHILDREN : []
  const section = [`## Part ${id}`, '']
  if (variant === 'on the heading above') return [...section, '### Parent', `{id=p-${id} ${token}}`, '', '#### Quote', `{id=${id} quote}`, '', ...content, '', '#### Sibling', '', 'Text of the sibling.'].join('\n')
  const line = variant.startsWith('after quote') ? `{id=${id} quote ${token}}` : variant.startsWith('before quote') ? `{id=${id} ${token} quote}` : variant === 'alone' ? `{id=${id} ${token}}` : `{id=${id} quote}`
  const among = variant.startsWith('among the content') ? ['', `{${token}}`] : []
  return [...section, '### Quote', line, '', ...content, ...among, ...kids].join('\n')
}

/**
 * Rows `{ id, label, text(withLink) }` for every token × variant. `content(link)` gives the slide's body lines with
 * the link ('' for the text before the edit); `linkOf(index)` the link typed on the row.
 */
export function comboSlides(prefix, tokens, variants, content, linkOf) {
  const rows = []
  for (const token of tokens) for (const variant of variants) {
    const index = rows.length
    const id = `${prefix}${index}`
    rows.push({ id, token, variant, link: linkOf(index), label: `{${token}} ${variant}`, text: (withLink) => comboSlide(id, token, variant, content(withLink ? linkOf(index) : '')) })
  }
  return rows
}

export const outlineOf = (rows, withLink) => `# Talk\n\n${rows.map((row) => row.text(withLink)).join('\n\n')}\n`

export const compilerIn = (dir) => async (text) => {
  const path = join(dir, `d-${Math.random().toString(36).slice(2)}.md`)
  writeFileSync(path, text)
  return prepareSource(path, text, 'Talk', statSync(path), undefined, { allowedAssetRoots: [dir] })
}

/** The form token written on the slide's layout line: 'web', 'paper' or null. */
export const formWritten = (outline, id) => outline.match(new RegExp(`\\{id=${id}\\b[^\\n]*?form=(web|paper)`))?.[1] ?? null

const quotationsOf = (slide) => (slide?.blocks ?? []).filter((block) => block && block.type === 'quote' && !block.practice)
export const compiledWords = (slide) => {
  const [quote] = quotationsOf(slide)
  if (!quote) return []
  return (Array.isArray(quote.paragraphs) && quote.paragraphs.length ? quote.paragraphs : [quote.text ?? '']).filter((paragraph) => String(paragraph).trim())
}

/** What a compiled block holds that is its source, or no words: left out of the displayed words. */
const NOT_DISPLAYED_WORDS = new Set(['type', 'cite', 'citeFromTitle', 'quoteForm', 'quoteLayout'])
const walkDisplayed = (value, into) => {
  if (typeof value === 'string') into.push(value)
  else if (Array.isArray(value)) for (const entry of value) walkDisplayed(entry, into)
  else if (value && typeof value === 'object') {
    if (typeof value.type === 'string') into.push(`[${value.type === 'feature-list' ? 'list' : value.type}]`)
    for (const [key, entry] of Object.entries(value)) if (!NOT_DISPLAYED_WORDS.has(key)) walkDisplayed(entry, into)
  }
}
/**
 * The displayed words of compiled slides as the full compiler reads them, without the source: for every block in
 * order (a slide's `blocks`, and the sub-slides of its `carousel`; cards, columns and the halves of a comparison are
 * blocks within blocks) its kind and every string it holds: a quotation's `text` and `paragraphs`, a paragraph's
 * `text`, a list's `items` and `children`, a card's `src`, a folded child's title and blocks. Left out: each
 * quotation's `cite` (the source itself: an attribution and the address under a quotation with a form are folded
 * into it), with the form's fields and the layout figures made from it. `slides` is one compiled slide or several.
 */
export const displayedWords = (slides) => {
  const words = []
  for (const slide of [slides].flat()) if (slide) walkDisplayed([slide.blocks ?? [], slide.carousel ?? []], words)
  return words
}
/** Every quotation (practice quotes aside) of compiled slides, folded ones too: `{ words, cite }` in order, the cite '' when the slide title stands in for one. */
export const compiledQuotations = (slides) => {
  const found = []
  const walk = (value) => {
    if (Array.isArray(value)) return void value.forEach(walk)
    if (!value || typeof value !== 'object') return
    if (value.type === 'quote' && !value.practice) found.push({ words: (Array.isArray(value.paragraphs) && value.paragraphs.length ? value.paragraphs : [value.text ?? '']).filter((paragraph) => String(paragraph).trim()), cite: value.citeFromTitle ? '' : String(value.cite ?? '') })
    for (const [key, entry] of Object.entries(value)) if (key !== 'quoteForm') walk(entry)
  }
  for (const slide of [slides].flat()) if (slide) walk([slide.blocks ?? [], slide.carousel ?? []])
  return found
}
/** The compiled slides of one generated row: its section (`## Part <id>`), so a slide folded into the heading above is among them. */
export const rowSlides = (model, id) => model.slides.filter((slide) => slide.section === `part-${String(id).toLowerCase()}`)

export const pageSection = (model, id) => String(model.fullHtml ?? '').match(new RegExp(`<section class="slide[^"]*" data-id="${id}"[\\s\\S]*?</section>`))?.[0] ?? ''

/**
 * Is `form` drawn for slide `id` of a compiled talk? '' when it is; else the first thing that is not so.
 * `wordsBefore` are the words compiled before the edit (null: not compared), `link` the typed link (null: not compared).
 */
export function drawnForm(model, id, form, { wordsBefore = null, link = null } = {}) {
  const slide = model.slides.find((candidate) => candidate.id === id)
  if (!slide) return 'the compiled talk has no slide of that id (it is folded into another)'
  if (slide.layout !== 'quote') return `the compiled slide's layout is ${slide.layout}`
  const quotes = quotationsOf(slide)
  if (quotes.length !== 1) return `the compiled slide holds ${quotes.length} quotations among its blocks`
  if (quotes[0].quoteForm?.form !== form) return `the quotation is drawn as ${quotes[0].quoteForm?.form ?? 'a plain quote'}`
  if (slide.blocks.some((block) => block && ['embed', 'video', 'audio'].includes(block.type))) return 'a card is still drawn'
  if (wordsBefore && JSON.stringify(compiledWords(slide)) !== JSON.stringify(wordsBefore)) return `the words are ${JSON.stringify(compiledWords(slide))}, and were ${JSON.stringify(wordsBefore)}`
  if (link != null && (parseSourceLine(quotes[0].cite ?? '').link?.url ?? '') !== link) return `the cited link is ${JSON.stringify(parseSourceLine(quotes[0].cite ?? '').link?.url ?? '')}`
  if (!new RegExp(`<figure class="qf (?:[^"]* )?qf-${form}[ "]`).test(pageSection(model, id))) return 'the page built from the model does not show the form for that slide'
  return ''
}

/** Is the form on the model alone (the statement without the page): a slide of its own, the quote layout, the form on its quotation? */
export const formOnModel = (model, id, form) => {
  const slide = model.slides.find((candidate) => candidate.id === id)
  return Boolean(slide && slide.layout === 'quote' && quotationsOf(slide).some((quote) => quote.quoteForm?.form === form))
}

/** Rows in decks of `size` slides: the link-edit rule reads the whole outline for each form it writes. */
export const inDecks = (rows, size = 200) => Array.from({ length: Math.ceil(rows.length / size) }, (_, deck) => rows.slice(deck * size, (deck + 1) * size))
