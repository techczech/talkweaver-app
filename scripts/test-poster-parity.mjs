// =============================================================================
// Poster parity (ADR-0015 + ADR-0023 §6, Ticket 2b)
//
// The contract this guards:
//   1. an authored {title} shares the opening treatment, and an authored {closing} keeps
//      the original closing treatment; the generated closing uses the opening treatment;
//   2. the poster's subtitle slot is the slide's FIRST body paragraph, falling back to the deck's
//      own subtitle for that bookend — `subtitle` for an opening, `cta` for an ending;
//   3. EVERY further authored block rides in `.tp-body` — nothing authored is ever dropped;
//   4. `title_style` still picks the opening's variant, authored or auto;
//   5. the generated opening keeps its frozen markup.
//
// It compiles real decks (prepareSource → buildDeckHtmlFromModel), never a stubbed renderer.
// =============================================================================
import { strict as assert } from 'node:assert'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
import { DECK_PALETTES, modelPaletteFor } from '../compiler/scripts/lib/deck-settings.mjs'

const fixturePath = fileURLToPath(import.meta.url).replace(/\.mjs$/, ".md")
const fixtureStat = statSync(fileURLToPath(import.meta.url))

const FRONTMATTER = [
  'title: "Poster **Parity**"',
  'subtitle: The deck subtitle',
  'series: TalkWeaver',
  'event: Parity fixture',
  'author: Dominik Lukeš',
  'affiliation: University of Oxford',
  'web: dominiklukes.net',
  'date: 11 September 2026',
  'colour: cobalt'
]

async function compileDeck(bodyLines, extraMeta = [], heading = '# Poster Parity') {
  const source = ['---', ...FRONTMATTER, ...extraMeta, '---', '', heading, '', ...bodyLines].join('\n')
  const model = await prepareSource(fixturePath, source, 'Poster Parity', fixtureStat)
  const html = await buildDeckHtmlFromModel(model)
  const { document } = new JSDOM(html).window
  return { model, html, document, slides: [...document.querySelectorAll('section.slide')] }
}

const posterIn = (slide) => slide.querySelector('.tp')
const classSet = (element) => [...element.classList].sort().join(' ')
const text = (element) => String(element?.textContent ?? '').replace(/\s+/g, ' ').trim()

/** The slide whose nav/heading title matches — authored slides are found by their own heading. */
function slideTitled(slides, title) {
  const found = slides.find((slide) => text(slide.querySelector('.slide-head h1')) === title)
  assert(found, `no slide titled ${JSON.stringify(title)}`)
  return found
}

// -----------------------------------------------------------------------------
// Fixture 1 — auto title only. The reference poster, and the frozen pre-§6 markup.
// -----------------------------------------------------------------------------
const autoOnly = await compileDeck(['## Body', '', '### A content slide', '', 'Some prose.'])
const autoTitle = autoOnly.slides[0]
const autoClosing = autoOnly.slides[autoOnly.slides.length - 1]
assert(posterIn(autoTitle), 'the auto deck-title renders a poster')
assert(posterIn(autoClosing), 'the auto closing renders a poster')
assert.equal(classSet(posterIn(autoTitle)), 'tp tp-poster')
assert.equal(classSet(posterIn(autoClosing)), 'tp tp-poster')
assert.equal(posterIn(autoTitle).querySelector('.tp-body'), null, 'an auto poster emits no .tp-body')
assert.equal(posterIn(autoClosing).querySelector('.tp-body'), null, 'an auto poster emits no .tp-body')

// The generated opening is frozen from the pre-§6 build.
const FROZEN_AUTO_TITLE = '<div class="tp tp-poster"><div class="tp-side"></div><div class="tp-main"><div class="tp-kicker">TalkWeaver · Parity fixture</div><div class="tp-mid"><h2 class="tp-title">Poster <strong>Parity</strong></h2><p class="tp-sub">The deck subtitle</p></div><div class="tp-foot"><div class="tp-who"><span class="tp-name">Dominik Lukeš</span> · <span class="tp-soft">University of Oxford</span></div><div class="tp-whenweb"><span class="tp-web">dominiklukes.net</span><br>11 September 2026</div></div></div></div>'
const THEMED_AUTO_CLOSING = '<div class="tp tp-poster"><div class="tp-side"></div><div class="tp-main"><div class="tp-kicker">TalkWeaver · Parity fixture</div><div class="tp-mid"><h2 class="tp-title">Thank you</h2></div><div class="tp-foot"><div class="tp-who"><span class="tp-name">Dominik Lukeš</span> · <span class="tp-soft">University of Oxford</span></div><div class="tp-whenweb"><span class="tp-web">dominiklukes.net</span><br>11 September 2026</div></div></div></div>'
assert.equal(posterIn(autoTitle).outerHTML, FROZEN_AUTO_TITLE, 'the auto deck-title poster is unchanged')
assert.equal(posterIn(autoClosing).outerHTML, THEMED_AUTO_CLOSING, 'the auto closing uses the opening poster')

// -----------------------------------------------------------------------------
// Fixture 2 — authored {title} + one paragraph.
// -----------------------------------------------------------------------------
const oneParagraph = await compileDeck([
  '## Structural', '', '### Authored title', '{title}', '', 'A subtitle line.'
])
const authoredTitle = slideTitled(oneParagraph.slides, 'Authored title')
const authoredPoster = posterIn(authoredTitle)
assert(authoredPoster, 'an authored {title} slide renders through the poster')
assert.equal(classSet(authoredPoster), classSet(posterIn(autoTitle)), 'authored title poster class set equals the auto poster’s')
assert.equal(text(authoredPoster.querySelector('.tp-title')), 'Authored title', 'the heading is the poster title')
assert.equal(text(authoredPoster.querySelector('.tp-sub')), 'A subtitle line.', 'paragraph 1 fills the subtitle slot')
assert.equal(authoredPoster.querySelector('.tp-body'), null, 'a single paragraph is the subtitle, not a body')
// The frontmatter byline fills the authored poster exactly as it fills the auto one.
assert.equal(text(authoredPoster.querySelector('.tp-who')), text(posterIn(autoTitle).querySelector('.tp-who')))
assert.equal(text(authoredPoster.querySelector('.tp-whenweb')), text(posterIn(autoTitle).querySelector('.tp-whenweb')))
assert.equal(text(authoredPoster.querySelector('.tp-kicker')), text(posterIn(autoTitle).querySelector('.tp-kicker')))

// -----------------------------------------------------------------------------
// Fixture 3 — authored {title} + three paragraphs + a list.
// -----------------------------------------------------------------------------
const AUTHORED_BODY = ['Second paragraph.', 'Third paragraph.', '- First item', '- Second item']
const threeParagraphs = await compileDeck([
  '## Structural', '', '### Long authored title', '{title}', '',
  'The subtitle paragraph.', '', 'Second paragraph.', '', 'Third paragraph.', '',
  '- First item', '- Second item'
])
const longTitle = slideTitled(threeParagraphs.slides, 'Long authored title')
const longPoster = posterIn(longTitle)
assert(longPoster, 'a multi-paragraph authored {title} renders through the poster')
assert.equal(classSet(longPoster), classSet(posterIn(autoTitle)), 'class set still equals the auto poster’s')
assert.equal(text(longPoster.querySelector('.tp-sub')), 'The subtitle paragraph.')
const longBody = longPoster.querySelector('.tp-body')
assert(longBody, 'further blocks render as .tp-body')
// 3 — every further authored text node is INSIDE .tp-body, and nothing is dropped.
for (const line of ['Second paragraph.', 'Third paragraph.', 'First item', 'Second item']) {
  assert(text(longBody).includes(line), `.tp-body holds ${JSON.stringify(line)}`)
}
for (const line of ['Long authored title', 'The subtitle paragraph.', ...AUTHORED_BODY.map((l) => l.replace(/^- /, ''))]) {
  assert(text(longTitle).includes(line), `no authored text missing: ${JSON.stringify(line)}`)
}
// .tp-body sits under the byline, inside the poster's right column.
assert.equal(longBody.parentElement.className, 'tp-main', '.tp-body rides in the poster right column')
assert(longBody.previousElementSibling?.classList.contains('tp-foot'), '.tp-body sits under the byline')

// -----------------------------------------------------------------------------
// Fixture 4 — authored {closing} + two paragraphs.
// -----------------------------------------------------------------------------
const authoredClosingDeck = await compileDeck([
  '## Closing', '', '### Thanks for listening', '{closing}', '',
  '**Thank you**', '', 'Slides and notes at dominiklukes.net.'
])
const closingSlide = slideTitled(authoredClosingDeck.slides, 'Thanks for listening')
const closingPoster = posterIn(closingSlide)
assert(closingPoster, 'an authored {closing} slide renders through the poster')
assert.equal(classSet(closingPoster), 'tp tp-closing tp-poster', 'authored closing keeps its original variant')
assert.equal(text(closingPoster.querySelector('.tp-title')), 'Thanks for listening')
assert.equal(text(closingPoster.querySelector('.tp-cta')), 'Thank you', 'paragraph 1 fills the closing subtitle slot')
const closingBody = closingPoster.querySelector('.tp-body')
assert(closingBody, 'the second paragraph renders as .tp-body')
assert(text(closingBody).includes('Slides and notes at dominiklukes.net.'), '.tp-body holds the further paragraph')

// -----------------------------------------------------------------------------
// Fixture 4b — the deck's own subtitle is the fallback (Dominik, 2026-09-12). An authored
// bookend with no leading paragraph is never barer than the auto slide it stands beside; a
// leading paragraph still wins. An ending falls back to `cta`, never to `subtitle` — the auto
// closing has never read `subtitle`.
// -----------------------------------------------------------------------------
const fallback = await compileDeck([
  '## Structural', '', '### Bare authored title', '{title}', '',
  '## Closing', '', '### Bare authored closing', '{closing}'
], ['cta: Come and find me afterwards'])
const bareTitle = posterIn(slideTitled(fallback.slides, 'Bare authored title'))
assert.equal(text(bareTitle.querySelector('.tp-sub')), 'The deck subtitle', 'a bodyless authored {title} takes the deck subtitle')
assert.equal(bareTitle.querySelector('.tp-body'), null, 'the fallback subtitle is not also a body')
const bareClosing = posterIn(slideTitled(fallback.slides, 'Bare authored closing'))
assert.equal(text(bareClosing.querySelector('.tp-cta')), 'Come and find me afterwards', 'a bodyless authored {closing} takes the deck cta')
assert.equal(bareClosing.querySelector('.tp-sub'), null, 'an authored closing never reads the deck subtitle')
assert(!text(bareClosing).includes('The deck subtitle'), 'the deck subtitle never leaks onto a closing')
// With no `cta` at all the closing subtitle slot simply stays empty, exactly as the auto one does.
const noCta = await compileDeck(['## Closing', '', '### Silent authored closing', '{closing}'])
const silentClosing = posterIn(slideTitled(noCta.slides, 'Silent authored closing'))
assert.equal(silentClosing.querySelector('.tp-cta'), null, 'no cta ⇒ an empty closing subtitle slot')
assert.equal(silentClosing.querySelector('.tp-sub'), null, 'no cta ⇒ no subtitle borrowed from the deck')
// A leading paragraph still beats the frontmatter fallback (fixture 2's deck has `subtitle:` set).
assert.equal(text(authoredPoster.querySelector('.tp-sub')), 'A subtitle line.', 'paragraph 1 beats the deck subtitle')

// -----------------------------------------------------------------------------
// Fixture 4c — a LEADING WHOLLY-BOLD paragraph. Since ADR-0023 §4 the lexer turns it into a
// `claim` block, so the subtitle slot must accept a claim exactly as it accepts a paragraph —
// on both bookends. A claim FURTHER DOWN rides in .tp-body as an ordinary paragraph. Nothing
// authored is lost either way.
// -----------------------------------------------------------------------------
const boldLead = await compileDeck([
  '## Structural', '', '### Bold-led title', '{title}', '',
  '**A bold subtitle.**', '', '**A bold body claim.**', '', 'Trailing prose.',
  '', '## Closing', '', '### Bold-led closing', '{closing}', '',
  '**Thank you**', '', 'Slides at dominiklukes.net.'
])
const boldTitle = posterIn(slideTitled(boldLead.slides, 'Bold-led title'))
assert.equal(text(boldTitle.querySelector('.tp-sub')), 'A bold subtitle.', 'a leading claim fills the title subtitle slot')
assert.equal(boldTitle.querySelector('.tp-sub strong'), null, 'the claim markers are consumed, not re-emitted as bold')
const boldTitleBody = boldTitle.querySelector('.tp-body')
assert(boldTitleBody, 'the further blocks still render as .tp-body')
for (const line of ['A bold body claim.', 'Trailing prose.']) {
  assert(text(boldTitleBody).includes(line), `.tp-body holds ${JSON.stringify(line)}`)
}
// A claim in the poster body reads as an ordinary paragraph — no .claim treatment at byline scale.
const bodyParagraphs = [...boldTitleBody.querySelectorAll('p')]
assert.equal(bodyParagraphs.length, 2, '.tp-body holds both further blocks as paragraphs')
assert.deepEqual(bodyParagraphs.map((p) => p.className), ['content-p', 'content-p'], 'a body claim renders like a paragraph')
const boldClosing = posterIn(slideTitled(boldLead.slides, 'Bold-led closing'))
assert.equal(text(boldClosing.querySelector('.tp-cta')), 'Thank you', 'a leading claim fills the closing subtitle slot')
assert.equal(boldClosing.querySelector('.tp-cta strong'), null, 'the closing claim markers are consumed too')
assert(text(boldClosing.querySelector('.tp-body')).includes('Slides at dominiklukes.net.'), 'the closing keeps its further paragraph')

// -----------------------------------------------------------------------------
// Fixture 5 — title_style: banner with an authored title.
// -----------------------------------------------------------------------------
const banner = await compileDeck([
  '## Structural', '', '### Banner authored title', '{title}', '',
  'Banner subtitle.', '', 'Banner body paragraph.'
], ['title_style: banner'])
const bannerAuto = posterIn(banner.slides[0])
const bannerAuthored = posterIn(slideTitled(banner.slides, 'Banner authored title'))
assert.equal(classSet(bannerAuto), 'tp tp-banner', 'title_style picks the auto opening variant')
assert.equal(classSet(bannerAuthored), classSet(bannerAuto), 'title_style picks the authored opening variant too')
assert.equal(text(bannerAuthored.querySelector('.tp-sub')), 'Banner subtitle.')
assert(text(bannerAuthored.querySelector('.tp-body')).includes('Banner body paragraph.'), 'banner keeps the further paragraph')
// A generated closing shares the selected opening treatment.
assert.equal(classSet(posterIn(banner.slides[banner.slides.length - 1])), 'tp tp-banner')

const palettes = ['ocean', ...DECK_PALETTES]
for (const palette of palettes) {
  const extraMeta = palette === 'ocean' ? [] : [`palette: ${palette}`]
  const content = ['## Talk content', '', '### A body slide', '', 'Body copy.']
  const { slides, model } = await compileDeck(content, [...extraMeta,
    'thanks: See you **soon**',
    'cta: "[Read the notes](https://example.com/notes)"',
    'handout_url: https://example.com/handout',
    'contact_links:',
    '  contact: {url: https://example.com/contact, label: Contact page}',
    '  email: mailto:hello@example.com',
    '  invalid: ftp://example.com/file',
    'hide-email: true',
  ], '# Poster Parity {icon=lucide:book-open title-icon=above}')
  const opening = slides.find(slide => slide.dataset.id === 'deck-title')
  const closing = slides.find(slide => slide.dataset.id === 'deck-thanks')
  const openingIcon = opening.querySelector('.tp-title .title-icon svg')
  const closingIcon = closing.querySelector('.tp-title .title-icon svg')
  assert(openingIcon, palette)
  if (palette === 'classic' || palette === 'green') {
    assert.equal(closingIcon, null, palette)
  } else {
    assert.equal(closingIcon?.outerHTML, openingIcon.outerHTML, palette)
    assert.equal(closingIcon?.closest('.title-with-icon').dataset.titleIcon, 'above', palette)
    const noIcon = await compileDeck(content, extraMeta)
    assert.equal(noIcon.slides.at(-1).querySelector('.tp-title .title-icon'), null, palette)
  }
  assert.equal(model.palette, modelPaletteFor(palette), palette)
  assert.equal(closing.dataset.role, 'ending', palette)
  assert.equal(closing.dataset.layout, 'closing', palette)
  assert.equal(closing.querySelector('.slide-content').className, opening.querySelector('.slide-content').className, palette)
  for (const field of ['look', 'palette', 'companion', 'lead', 'titleLayout']) {
    assert.equal(closing.dataset[field], opening.dataset[field], `${palette} ${field}`)
  }
  for (const slot of ['.tp-kicker', '.tp-foot', '.tp-qr']) {
    assert.equal(closing.querySelector(slot)?.outerHTML, opening.querySelector(slot)?.outerHTML, `${palette} ${slot}`)
  }
  assert.equal(closing.querySelector('.tp-title strong')?.textContent, 'soon', palette)
  assert.equal(closing.querySelector('.tp-sub a')?.href, 'https://example.com/notes', palette)
  assert.equal(closing.querySelector('a[href="https://example.com/contact"]')?.textContent, 'Contact page', palette)
  assert(!closing.querySelector('a[href^="mailto:"], a[href^="ftp:"]'), palette)
}
for (const variant of ['split', 'banner']) {
  const { slides } = await compileDeck(['### A slide', '', 'Body copy.'], [
    `title_style: ${variant}`,
    'logo: https://example.com/logo.png',
    'handout_url: https://example.com/handout',
  ], '# Poster Parity {icon=lucide:book-open}')
  const closing = slides.find(slide => slide.dataset.id === 'deck-thanks')
  const poster = posterIn(closing)
  assert.equal(classSet(poster), `tp tp-${variant}`)
  assert.equal(poster.querySelector('.tp-title .title-icon'), null, variant)
  assert.equal(poster.querySelector('.tp-side .tp-logo')?.src, 'https://example.com/logo.png')
  assert.equal(poster.querySelector('.tp-side .qr-caption a')?.href, 'https://example.com/handout')
  assert(!closing.querySelector('.slide-qr-corner'))
}
for (const iconAttr of ['', ' icon=lucide:leaf']) {
  const { slides } = await compileDeck([
    `### Welcome {title role=opening${iconAttr}} {id=welcome}`, '', 'Workshop details.',
  ], ['palette: forest'], '# Poster Parity {icon=lucide:book-open}')
  const opening = slides.find(slide => slide.dataset.id === 'welcome')
  const closing = slides.find(slide => slide.dataset.id === 'deck-thanks')
  const openingIcon = opening.querySelector('.tp-title .title-icon svg')
  assert.equal(Boolean(openingIcon), Boolean(iconAttr), 'authored opening fixture')
  assert.equal(closing.querySelector('.tp-title .title-icon svg')?.outerHTML, openingIcon?.outerHTML, 'follow the authored opening')
}
const emailDeck = await compileDeck(['### A slide', '', 'Body copy.'], [
  'contacts: {email: mailto:hello@example.com}',
])
assert.equal(emailDeck.slides.at(-1).querySelector('.tp-contacts a')?.href, 'mailto:hello@example.com')
const privateDeck = await compileDeck(['### A slide', '', 'Body copy.'], [
  'contacts: {email: mailto:hello@example.com}',
  'hide_email: yes',
])
assert.equal(privateDeck.slides.at(-1).querySelector('.tp-contacts'), null)
console.log(`poster parity: 7 bookend fixtures and ${palettes.length} palette fixtures OK`)
