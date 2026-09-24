// =============================================================================
// Inline semantics (ADR-0023 §4 claims, §5 quote attribution) — Composition Ticket 4
//
// The contract this guards:
//   CLAIMS (§4)
//     1. a paragraph whose WHOLE text is bold is a claim, not a bold paragraph;
//     2. it renders as `<p class="content-p claim" data-claim-style="plain|bar">` and carries
//        no <strong> — the claim device is size or a bar, never weight;
//     3. `plain` (C1) is the default; `{claim=bar}` on the slide and `claim_style: bar` in the
//        frontmatter select C2, the slide token winning;
//     4. partial bold stays an ordinary paragraph with an inline <strong> (the accent highlight);
//     5. no rule in the ASSEMBLED deck stylesheet gives `.claim` a bold weight.
//   QUOTES (§5, D1)
//     6. both quote paths — `>` blockquote and a wholly-quoted paragraph — fold a following
//        dash-led line into the cite, producing identical <blockquote> markup;
//     7. a quote with no cite takes the slide title as its cite (`citeFromTitle`);
//     8. when the cite equals the title (authored or from rule 7) the painted title is hidden
//        and the navigation text is kept;
//     9. a cite that differs from the title leaves the title regime alone;
//    10. a quote that already carried an inline cite renders BYTE-IDENTICALLY to its pre-ticket
//        markup — the quote panel is unchanged by this ticket.
//
// Real decks are compiled (prepareSource → buildDeckHtmlFromModel); nothing is stubbed.
// =============================================================================
import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
import { buildDeckStyles } from './build-deck-styles.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'tw-inline-semantics-'))
let probe = 0
const checks = []
const check = (name, fn) => { fn(); checks.push(name) }

// One probe slide under a real section, no auto title/closing slides, so the LAST slide is it.
async function compile(body, { title = 'On Writing', trigger = '', frontmatter = [] } = {}) {
  const source = [
    '---', `title: ${title}`, ...frontmatter, 'auto_title_slide: false', 'auto_thanks_slide: false',
    '---', '', '## Fixtures', '', `### ${title}`, ...(trigger ? [trigger] : []), '', ...body
  ].join('\n')
  const path = join(dir, `${++probe}.md`)
  writeFileSync(path, source, 'utf8')
  const model = await prepareSource(path, source, title, statSync(path))
  const html = await buildDeckHtmlFromModel(model)
  const section = [...new JSDOM(html).window.document.querySelectorAll('section.slide')].at(-1)
  assert(section, 'compiled deck has a slide')
  return { model, html, section, slide: model.slides.at(-1) }
}

const sectionMarkup = (html) => html.match(/<section class="slide"[\s\S]*?<\/section>/g).at(-1)
const blockquoteOf = (section) => section.querySelector('blockquote')?.outerHTML ?? ''
const headOf = (section) => section.querySelector(':scope > .slide-content > header.slide-head')

// -----------------------------------------------------------------------------
// Claims (ADR-0023 §4)
// -----------------------------------------------------------------------------

const CLAIM_TEXT = 'Agents are the new applications.'

const plain = await compile([`**${CLAIM_TEXT}**`])
check('whole-bold paragraph becomes a claim', () => {
  const claim = plain.section.querySelector('p.claim')
  assert(claim, 'a whole-bold paragraph renders a p.claim')
  assert.equal(claim.getAttribute('data-claim-style'), 'plain', 'C1 is the default style')
  assert.equal(claim.textContent, CLAIM_TEXT, 'the bold markers are consumed by the claim')
  assert.equal(claim.querySelector('strong'), null, 'a claim never carries <strong>')
  assert(claim.classList.contains('content-p'), 'a claim is still a content paragraph')
})

check('the claim block type reaches the model', () => {
  const blocks = plain.slide.blocks ?? []
  const claim = blocks.find((b) => b && b.type === 'claim')
  assert(claim, 'the model carries a `claim` block (the corpus census reads block.type)')
  assert.equal(claim.text, CLAIM_TEXT, 'the claim block holds the unmarked text')
})

for (const [label, trailing] of [['inside', `**${CLAIM_TEXT}**`], ['outside', `**${CLAIM_TEXT.slice(0, -1)}**.`]]) {
  const cased = await compile([trailing])
  check(`trailing punctuation ${label} the markers still reads as a claim`, () => {
    assert(cased.section.querySelector('p.claim'), `${label}-punctuation bold paragraph is a claim`)
  })
}

const barToken = await compile([`**${CLAIM_TEXT}**`], { trigger: '{claim=bar}' })
check('{claim=bar} selects C2', () => {
  assert.equal(barToken.section.querySelector('p.claim')?.getAttribute('data-claim-style'), 'bar')
})

const barFrontmatter = await compile([`**${CLAIM_TEXT}**`], { frontmatter: ['claim_style: bar'] })
check('frontmatter claim_style: bar selects C2 deck-wide', () => {
  assert.equal(barFrontmatter.section.querySelector('p.claim')?.getAttribute('data-claim-style'), 'bar')
})

const tokenWins = await compile([`**${CLAIM_TEXT}**`], {
  trigger: '{claim=plain}', frontmatter: ['claim_style: bar']
})
check('the slide token beats the frontmatter default', () => {
  assert.equal(tokenWins.section.querySelector('p.claim')?.getAttribute('data-claim-style'), 'plain')
})

const partial = await compile(['Agents are the **new** applications.'])
check('partial bold stays a paragraph with inline <strong>', () => {
  assert.equal(partial.section.querySelector('p.claim'), null, 'partial bold is not a claim')
  const para = partial.section.querySelector('p.content-p')
  assert(para, 'partial bold still renders a content paragraph')
  assert(para.querySelector('strong'), 'the inline accent highlight survives')
})

check('no assembled rule gives .claim a bold weight', () => {
  const css = buildDeckStyles()
  const offenders = []
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selector, body] = match
    if (!selector.includes('.claim')) continue
    const weight = body.match(/font-weight\s*:\s*([^;]+)/)
    if (weight && /bold|[6-9]00/.test(weight[1])) offenders.push(`${selector.trim()} → ${weight[1].trim()}`)
  }
  assert.deepEqual(offenders, [], 'ADR-0023 §4: the claim is never carried by weight')
  assert(/\.claim\b/.test(css), 'the assembled stylesheet actually styles .claim')
})

// -----------------------------------------------------------------------------
// Quote attribution (ADR-0023 §5, D1)
// -----------------------------------------------------------------------------

const QUOTE = 'The scariest moment is always just before you start.'
const CITE = 'Stephen King, On Writing'

const blockquoteDash = await compile([`> ${QUOTE}`, '', `— ${CITE}`], { title: 'Starting' })
const quotedParaDash = await compile([`"${QUOTE}"`, '', `— ${CITE}`], { title: 'Starting' })
check('both quote paths fold a following dash line into the cite', () => {
  assert.equal(
    blockquoteOf(blockquoteDash.section),
    `<blockquote data-quote-length="short" data-quote-chars="52"><p>${QUOTE}</p><cite>${CITE}</cite></blockquote>`,
    'blockquote + dash line'
  )
  assert.equal(
    blockquoteOf(quotedParaDash.section),
    blockquoteOf(blockquoteDash.section),
    'a quoted paragraph + dash line produces the SAME blockquote markup'
  )
  assert.equal(
    quotedParaDash.section.querySelectorAll('p.content-p').length, 0,
    'the attribution is inside the panel, not a caption beside it'
  )
})

const loneBullet = await compile([`> ${QUOTE}`, '', `- ${CITE}`], { title: 'Starting' })
check('a lone bullet after a quote is still an attribution', () => {
  assert.equal(blockquoteOf(loneBullet.section), blockquoteOf(blockquoteDash.section))
})

const realList = await compile([`> ${QUOTE}`, '', '- One', '- Two'], { title: 'Starting' })
check('a real list after a quote stays a list', () => {
  assert.equal(realList.section.querySelectorAll('li').length, 2, 'both items survive')
  const quote = (realList.slide.blocks ?? []).find((b) => b && b.type === 'quote')
  assert.equal(quote.citeFromTitle, true, 'no list item was stolen — the cite came from the title')
})

const noCite = await compile([`> ${QUOTE}`], { title: 'Starting' })
check('a quote with no cite takes the slide title as its cite', () => {
  const quote = (noCite.slide.blocks ?? []).find((b) => b && b.type === 'quote')
  assert(quote, 'the model carries the quote block')
  assert.equal(quote.cite, 'Starting', 'the title became the cite')
  assert.equal(quote.citeFromTitle, true, 'the block records where the cite came from')
  assert.equal(noCite.section.querySelector('blockquote cite')?.textContent, 'Starting')
})

// A quote inside a NON-quote layout: the list keeps the layout off `quote`, so the title regime
// is visible and the hide is observable.
const citeIsTitleInList = await compile(
  [`> ${QUOTE}`, `> — Starting`, '', '- One', '- Two'], { title: 'Starting' }
)
check('an authored cite equal to the title hides the painted title', () => {
  const head = headOf(citeIsTitleInList.section)
  assert(head, 'a head element is still emitted')
  assert(head.classList.contains('slide-head-quiet'), 'the title rail is quiet')
  assert.equal(head.querySelector('h1')?.textContent, 'Starting', 'navigation text is kept')
  assert.equal(head.querySelector('h1')?.className, 'sr-only', 'and only for navigation')
})

const noCiteInList = await compile([`> ${QUOTE}`, '', '- One', '- Two'], { title: 'Starting' })
check('a title-derived cite hides the painted title too', () => {
  const head = headOf(noCiteInList.section)
  assert(head?.classList.contains('slide-head-quiet'), 'rule 2 + rule 3 compose')
})

const citeDiffers = await compile(
  [`> ${QUOTE}`, `> — ${CITE}`, '', '- One', '- Two'], { title: 'Starting' }
)
check('a cite that differs from the title leaves the title regime alone', () => {
  const head = headOf(citeDiffers.section)
  assert(head, 'the head is emitted')
  assert(!head.classList.contains('slide-head-quiet'), 'the title is still painted')
  assert.equal(head.querySelector('h1')?.textContent, 'Starting')
})

// Rule 10 — an existing inline cite keeps the same content and attribution structure byte-for-byte.
// ADR-0023 §9: the panel carries no width metadata any more (one width, one type; long quotes split).
const EXPECTED_INLINE_CITE_SECTION = '<section class="slide" data-id="on-writing" data-section="fixtures" data-subsection="" data-role="opening" data-layout="quote" data-nav-title="On Writing" data-title-layout="hidden" style="--accent: #0f4bd8; --sec-accent: #0f4bd8; --sec-tint: #e8eefc">\n  <div class="slide-content layout-quote">\n<header class="slide-head slide-head-quiet"><h1 class="sr-only">On Writing</h1></header>\n<blockquote data-quote-length="short" data-quote-chars="52"><p>The scariest moment is always just before you start.</p><cite>Stephen King</cite></blockquote>\n  </div>\n  \n</section>'
const inlineCite = await compile([`> ${QUOTE}`, '> — Stephen King'])
check('an existing inline-cite quote preserves its attribution markup', () => {
  assert.equal(sectionMarkup(inlineCite.html), EXPECTED_INLINE_CITE_SECTION)
})

console.log(`inline semantics: ${checks.length} checks passed`)
for (const name of checks) console.log(`  · ${name}`)
