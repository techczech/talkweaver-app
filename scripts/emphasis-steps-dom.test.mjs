// 0.38 ticket 02 — "Emphasis appears on Next" in a real presenter + projector pair, and on the
// venue page. The presenter is driven with the keyboard. Every step is read in three places: the
// PROJECTOR window's slide, the presenter's Current pane (a clone in an iframe) and a VENUE page
// that is sent only what the live session carries ({ slideId, reveal, focus, lightbox }).
//   (a) {emphasis-steps} alone: plain text on arrival, one piece of emphasis per Next in reading
//       order, Back in reverse, then the next slide; the title's emphasis shows from the start;
//   no reflow: the text block, every element and every word keep their boxes at every step, and
//       the boxes are those of the slide with all emphasis on;
//   (b) with {reveal}: an item appears, then its emphasis, then the next item; with the presenter's
//       own Reveal (R) the same; a {group} list appears whole, then its emphasis in order;
//   (c) with {focus}: the emphasis of the unit in focus steps before focus moves on;
//   with {image-steps}: the emphasis first, then the images;
//   {nostep}: no emphasis step, all of it on; the option absent: nothing is marked and Next goes
//       straight on;
//   the next-slide pane, the handout and print show all emphasis;
//   a carousel: each card's emphasis steps inside that card (cards that are their own beats, and
//       cards that hop within one beat); the shared line under the cards is not a step;
//   a phone following live: an emphasis-only step is no mode of the reader's, so one click on
//       Reveal enters the reader's own Reveal; Stop following shows all emphasis.
// Headless Chromium only (never the installed Chrome).
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { buildVenuePageHtml } from '../compiler/scripts/lib/venue-page.mjs'
import { emphasisWireFocus } from '../compiler/assets/runtime/emphasis-steps.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const dir = await mkdtemp(join(tmpdir(), 'tw-emphasis-steps-dom-'))
await mkdir(join(dir, 'assets'), { recursive: true })
for (const name of ['a', 'b']) await writeFile(join(dir, 'assets', `${name}.png`), PNG)

const slides = (token) => [
  '### Start', '{id=start}', '', '- Words only', '',
  '### A **bold** title', `${token} {id=plain}`, '',
  'The opening line has a **bold phrase of several words** in the middle and then carries on for long enough that it wraps onto a second line of the slide.', '',
  '- First point with ==a highlighted claim== inside it',
  '- Second point is ++underlined here++ and ~~struck here~~ before it ends', '',
  '### Mixed', `${token} {reveal} {id=mixed}`, '', '- Alpha has **one** and ==two==', '- Beta has none', '- Gamma has ++three++', '',
  '### Focus', `${token} {focus} {id=focus}`, '', '- Alpha has **one**', '- Beta has ==two==', '',
  '### Group', `${token} {reveal} {group} {id=group}`, '', '- Alpha has **one**', '- Beta has ==two==', '',
  '### Images', `${token} {image-steps} {id=images}`, '', '- A point with **bold**', '', '![One](assets/a.png)', '![Two](assets/b.png)', '',
  '### Nostep', `${token} {nostep} {id=nostep}`, '', '- A **b** and ==c==', '',
  '### Off', '{id=off}', '', '- A **b** and ==c== ++d++ ~~e~~', '',
  '### End', '{id=end}', '', '- Words only', ''
]
// Two carousels with the option. "cards": heading-authored cards (each its own beat) under a
// shared line of prose. "hops": block-content cards, which hop inside one beat.
const carouselSlides = [
  '### Start', '{id=start}', '', '- Words only', '',
  '### Cards', '{carousel} {emphasis-steps} {id=cards}', '', 'A shared **source** line with ==a mark==', '',
  '#### First', '', '- One has **a** and ==b==', '', '#### Second', '', '- Two has ++c++', '',
  '### Hops', '{carousel} {emphasis-steps} {id=hops}', '', 'The first card has **d** and ==e==', '', '- The second card has ++f++', '',
  '### End', '{id=end}', '', '- Words only', ''
]
const build = async (name, token, body = slides(token)) => {
  const outline = ['---', 'title: Emphasis steps', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', ...body].join('\n')
  const path = join(dir, `${name}.md`)
  await writeFile(path, outline, 'utf8')
  return (await prepareSource(path, outline, null, await stat(path), {}, {})).fullHtml
}
const onHtml = await build('on', '{emphasis-steps}')
const offHtml = await build('off', '')
const carouselHtml = await build('carousel', '', carouselSlides)
const venueFor = (html) => buildVenuePageHtml({ title: 'Emphasis steps', slug: 'emphasis-steps', liveTalkSlug: 'emphasis-steps',
  workerBaseUrl: 'https://live.example.test', qr: '<svg aria-label="QR code"></svg>', handoutUrl: 'https://handouts.fyi/k7m2',
  includeNotes: false, license: null, slides: extractSlides(html), styles: extractStyles(html) })
const shareInput = { includeNotes: false, license: null, slides: extractSlides(onHtml), styles: extractStyles(onHtml) }
const pages = {
  '/on.html': onHtml,
  '/off.html': offHtml,
  '/handout.html': buildShareHtml({ title: 'Emphasis steps', slug: 'emphasis-steps', ...shareInput }),
  '/carousel.html': carouselHtml,
  // A phone's page: the handout with the live session wired in.
  '/follower.html': buildShareHtml({ title: 'Emphasis steps', slug: 'emphasis-steps', liveTalkSlug: 'emphasis-steps', workerBaseUrl: 'https://live.example.test', ...shareInput }),
  '/venue/on.html': venueFor(onHtml),
  '/venue/off.html': venueFor(offHtml),
  '/venue/carousel.html': venueFor(carouselHtml)
}

const server = createServer((req, res) => {
  const path = req.url.split('?')[0]
  if (pages[path]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(pages[path]); return }
  if (path.startsWith('/assets/') && path.endsWith('.png')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return }
  res.writeHead(404); res.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ headless: true })
let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`) } catch (error) { failures += 1; console.error(`FAIL ${name}\n  ${error.stack || error}`) }
}

/**
 * What one slide shows: each emphasis span in page order ("on" | "off", with its text) and each
 * list item or paragraph's reveal / focus state (null where it carries none). Runs in the page;
 * `inPreview` reads the presenter's Current pane instead of the window's own slide.
 */
function readSlide(inPreview) {
  const doc = inPreview ? document.querySelector('#currentPreview iframe')?.contentDocument : document
  const slide = doc?.querySelector(inPreview ? '.slide' : '.slide.active')
  if (!slide) return null
  return {
    slide: slide.dataset.id,
    // The card on show in a carousel (null elsewhere), and the emphasis of that card only.
    card: slide.querySelector('.card-gallery[data-exclusive]') ? [...slide.querySelectorAll('.card-gallery[data-exclusive] > .card')].findIndex((card) => card.classList.contains('active-card')) : null,
    onCard: [...slide.querySelectorAll('.card-gallery[data-exclusive] > .card.active-card [data-emph-step]')].map((el) => `${el.textContent}:${el.getAttribute('data-emph-state') === 'off' ? 'off' : 'on'}`),
    emphasis: [...slide.querySelectorAll('[data-emph-step]')].map((el) => `${el.textContent}:${el.getAttribute('data-emph-state') === 'off' ? 'off' : 'on'}`),
    blocks: [...slide.querySelectorAll('.slide-content .content-p, .slide-content .feature-list, .slide-content .feature-list > li')]
      .map((el) => el.getAttribute('data-mode-state')),
    mode: ['reveal', 'focus'].find((kind) => slide.classList.contains(`mode-${kind}`)) ?? null
  }
}

/** Every box on the active slide: the text block, each element in it, and each word. */
function readGeometry() {
  const slide = document.querySelector('.slide.active')
  const content = slide.querySelector('.slide-content')
  const box = (rect) => [rect.left, rect.top, rect.width, rect.height].map((n) => Math.round(n * 100) / 100)
  const out = { content: box(content.getBoundingClientRect()), elements: [], words: [] }
  for (const el of content.querySelectorAll('*')) out.elements.push([el.tagName, ...box(el.getBoundingClientRect())])
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const match of node.data.matchAll(/\S+/g)) {
      range.setStart(node, match.index)
      range.setEnd(node, match.index + match[0].length)
      out.words.push([match[0], ...[...range.getClientRects()].flatMap(box)])
    }
  }
  return out
}

// The venue page and a following phone talk to the live service over a socket; this stand-in lets
// the test hand them the slide states the presenter publishes.
function liveServiceStandIn() {
  window.__sockets = []
  window.fetch = async (url) => ({ ok: true, json: async () => String(url).endsWith('/capabilities')
    ? { protocol: 2 } : String(url).endsWith('/status') ? { status: 'open' } : { live: true, sessionId: 'session-1' } })
  window.WebSocket = class {
    static OPEN = 1
    readyState = 1
    constructor(url) {
      this.url = url
      window.__sockets.push(this)
      queueMicrotask(() => { this.onopen?.(); this.emit({ type: 'session.hello', protocol: 2 }) })
    }
    send(raw) {
      const message = JSON.parse(raw)
      if (message.type === 'session.sync') queueMicrotask(() => this.emit({
        type: 'session.snapshot', protocol: 2, sessionId: 'session-1', syncId: message.syncId,
        expiresAt: Date.now() + 60000, slideState: null, polls: [], receipts: []
      }))
      if (message.type === 'session.ping') this.emit({ type: 'session.pong', nonce: message.nonce })
    }
    close() { this.readyState = 3 }
    emit(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
  }
}

async function pair(deck, { reducedMotion = 'reduce' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, reducedMotion })
  const session = `emphasis-steps-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const presenter = await context.newPage()
  const projector = await context.newPage()
  const venue = await context.newPage()
  for (const page of [presenter, projector, venue]) page.on('pageerror', (error) => { failures += 1; console.error(`FAIL page error: ${error.message}`) })
  // The venue page talks to the live service over a socket; this stand-in lets the test hand it
  // the slide states the presenter publishes.
  await venue.addInitScript(liveServiceStandIn)
  await venue.setViewportSize({ width: 1280, height: 720 })
  await venue.goto(`${origin}/venue${deck}`, { waitUntil: 'load' })
  await venue.waitForFunction(() => window.__sockets.length === 1)
  await projector.goto(`${origin}${deck}?audience=1&session=${session}`, { waitUntil: 'load' })
  await presenter.goto(`${origin}${deck}?presenter=1&session=${session}`, { waitUntil: 'load' })
  await presenter.waitForSelector('#presenterRoot, .presenter-root')
  let presses = 0
  let revision = 0
  /**
   * Press a key in the presenter; wait until the projector has applied that state; send the venue
   * page what the live session would carry; return what the projector shows, after asserting that
   * the presenter's Current pane and the venue page show the same.
   */
  const press = async (key) => {
    presses += 1
    await presenter.keyboard.press(key)
    const sent = await presenter.evaluate(() => ({
      slide: document.querySelector('.slide.active')?.dataset.id ?? null,
      lightbox: document.documentElement.dataset.twLiveLightbox,
      focus: document.documentElement.dataset.twLiveFocus || '',
      reveal: Number(document.documentElement.dataset.twLiveReveal) || 0
    }))
    await projector.waitForFunction((want) => document.querySelector('.slide.active')?.dataset.id === want.slide
      && document.documentElement.dataset.twLiveLightbox === want.lightbox
      && (document.documentElement.dataset.twLiveFocus || '') === want.focus
      && (Number(document.documentElement.dataset.twLiveReveal) || 0) === want.reveal, sent, { timeout: 5000 })
    const shown = await projector.evaluate(readSlide, false)
    const label = `press ${presses} (${key}) on ${shown.slide}`
    // The presenter's Current pane is rebuilt in an iframe: wait for it, then compare.
    let pane = null
    for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
      pane = await presenter.evaluate(readSlide, true)
      if (JSON.stringify(pane) === JSON.stringify(shown)) break
      await presenter.waitForTimeout(25)
    }
    assert.deepEqual(pane, shown, `${label}: the presenter's Current pane shows the projector's step`)
    // The venue screen: exactly the fields worker/protocol.ts SlideState carries.
    const focus = sent.focus ? JSON.parse(sent.focus) : null
    if (focus) {
      assert(focus.kind === 'reveal' || focus.kind === 'focus', `${label}: the focus kind is one the live protocol accepts`)
      assert(Number.isInteger(focus.step) && focus.step >= 0, `${label}: the focus step is a non-negative integer`)
      assert.deepEqual(Object.keys(focus).sort(), ['kind', 'step'], `${label}: the published focus has no new field`)
    }
    revision += 1
    await venue.evaluate((state) => window.__sockets.at(-1).emit(state),
      { type: 'slide.state', slideId: sent.slide, reveal: sent.reveal, focus, lightbox: JSON.parse(sent.lightbox), revision })
    await venue.locator(`.slide.active[data-id="${sent.slide}"]`).waitFor()
    assert.deepEqual(await venue.evaluate(readSlide, false), shown, `${label}: the venue screen shows the projector's step`)
    return { ...shown, lightbox: JSON.parse(sent.lightbox), focus }
  }
  const next = () => press('ArrowRight')
  const back = () => press('ArrowLeft')
  return { context, presenter, projector, venue, press, next, back }
}
const states = (shown) => shown.emphasis.map((entry) => entry.split(':').at(-1))
const OFF = 'off'
const ON = 'on'

try {
  {
    const { context, presenter, projector, press, next, back } = await pair('/on.html')
    const start = await projector.evaluate(readSlide, false)
    assert.equal(start.slide, 'start')

    // ── (a) the option alone ────────────────────────────────────────────────────────────────
    let allOnGeometry = null
    await check('(a) plain text on arrival; each Next turns on the next piece in reading order; no word moves', async () => {
      let shown = await next()
      assert.equal(shown.slide, 'plain')
      assert.deepEqual(shown.emphasis, ['bold phrase of several words:off', 'a highlighted claim:off', 'underlined here:off', 'struck here:off'],
        'the four pieces of emphasis in the body arrive off, in reading order')
      assert.deepEqual(shown.blocks, [null, null, null, null], 'every block shows from arrival: no reveal state')
      assert.equal(shown.mode, null)
      const geometry = [await projector.evaluate(readGeometry)]
      for (const want of [[ON, OFF, OFF, OFF], [ON, ON, OFF, OFF], [ON, ON, ON, OFF], [ON, ON, ON, ON]]) {
        shown = await next()
        assert.equal(shown.slide, 'plain', 'still on the slide')
        assert.deepEqual(states(shown), want)
        assert.deepEqual(shown.blocks, [null, null, null, null])
        geometry.push(await projector.evaluate(readGeometry))
      }
      // No reflow: the text block, every element and every word keep their boxes at every step.
      assert(geometry[0].words.length > 30 && geometry[0].elements.length > 10, 'the geometry reading covers the slide')
      geometry.forEach((reading, step) => assert.deepEqual(reading, geometry[0], `step ${step}: same boxes as on arrival`))
      // ...and they are the boxes of the slide with no step state at all (what the slide fit measures).
      await projector.evaluate(() => document.querySelectorAll('.slide.active [data-emph-state]').forEach((el) => {
        el.dataset.wasState = el.getAttribute('data-emph-state')
        el.removeAttribute('data-emph-state')
      }))
      allOnGeometry = await projector.evaluate(readGeometry)
      await projector.evaluate(() => document.querySelectorAll('.slide.active [data-was-state]').forEach((el) => {
        el.setAttribute('data-emph-state', el.dataset.wasState)
        delete el.dataset.wasState
      }))
      assert.deepEqual(allOnGeometry, geometry[0], 'the stepped slide has the geometry of the slide with all emphasis on')
      // The reading can tell bold from plain: a bold word is wider than the same word at the
      // paragraph's weight, so a slide that laid the plain text out first would have moved.
      const widths = await projector.evaluate(() => {
        const word = document.querySelector('.slide.active strong[data-emph-step] .es-w')
        const probe = document.createElement('span')
        probe.textContent = word.textContent
        word.closest('p').append(probe)
        const out = { bold: word.getBoundingClientRect().width, plain: probe.getBoundingClientRect().width }
        probe.remove()
        return out
      })
      assert(widths.bold > widths.plain, `a bold word (${widths.bold}px) is wider than the same word plain (${widths.plain}px)`)
    })

    await check('(a) a piece that is not yet on is painted as the text around it, and never hidden', async () => {
      await back(); await back(); await back(); await back()
      const read = () => projector.evaluate(() => {
        const slide = document.querySelector('.slide.active')
        const paragraph = getComputedStyle(slide.querySelector('.content-p'))
        const strong = slide.querySelector('.content-p strong[data-emph-step]')
        const word = strong.querySelector('.es-w')
        const copy = getComputedStyle(word, '::before')
        const mark = getComputedStyle(slide.querySelector('mark[data-emph-step]'))
        const u = getComputedStyle(slide.querySelector('u[data-emph-step]'))
        const s = getComputedStyle(slide.querySelector('s[data-emph-step]'))
        const transparent = (value) => /rgba\(\d+, \d+, \d+, 0\)|transparent/.test(value)
        const shownToTheEye = (el) => { const style = getComputedStyle(el); return style.visibility === 'visible' && style.display !== 'none' && Number(style.opacity) > 0 }
        return {
          paragraphWeight: paragraph.fontWeight, paragraphColour: paragraph.color,
          strongWeight: getComputedStyle(strong).fontWeight, strongColour: getComputedStyle(strong).color,
          boldGlyphsFilled: !transparent(getComputedStyle(word).webkitTextFillColor),
          copyText: copy.content, copyWeight: copy.fontWeight, copyOpacity: copy.opacity, copyColour: copy.color,
          markSweep: mark.backgroundSize, underlineShown: !transparent(u.textDecorationColor), strikeShown: !transparent(s.textDecorationColor), strikeOpacity: s.opacity,
          allShown: [...slide.querySelectorAll('[data-emph-step]')].every(shownToTheEye)
        }
      })
      const off = await read()
      assert.equal(off.allShown, true, 'no span is hidden')
      assert.equal(off.strongWeight, '700', 'the bold run is laid out at its bold weight (that is what reserves the width)')
      assert.equal(off.boldGlyphsFilled, false, 'the bold glyphs are not painted')
      assert.equal(off.copyOpacity, '1', 'the plain copy is painted over them')
      assert.match(off.copyText, /^"bold"/, 'the plain copy is the word itself')
      assert.equal(off.copyWeight, off.paragraphWeight, 'at the weight of the paragraph around it')
      assert.equal(off.copyColour, off.paragraphColour, 'in the colour of the paragraph around it')
      assert.equal(off.strongColour, off.paragraphColour, 'the bold run has no colour of its own yet')
      assert.match(off.markSweep, /^0(%|px) /, 'the highlight has no width yet')
      assert.equal(off.underlineShown, false, 'the underline is not drawn yet')
      assert.equal(off.strikeShown, false, 'the strike is not drawn yet')
      assert.equal(off.strikeOpacity, '1', 'text to be struck reads at full strength')
      await next(); await next(); await next(); await next()
      const on = await read()
      assert.equal(on.boldGlyphsFilled, true, 'on: the bold glyphs are painted')
      assert.equal(on.copyOpacity, '0', 'on: the plain copy is gone')
      assert.notEqual(on.strongColour, on.paragraphColour, 'on: bold takes its accent colour, as on any slide')
      assert.match(on.markSweep, /^100% /, 'on: the highlight is full width')
      assert.equal(on.underlineShown, true)
      assert.equal(on.strikeShown, true)
      assert.notEqual(on.strikeOpacity, '1', 'on: struck text is dimmed, as on any slide')
    })

    await check('(a) emphasis in the title is not a step and shows from the start', async () => {
      const title = await projector.evaluate(() => {
        const strong = document.querySelector('.slide.active .slide-head h1 strong')
        return { marked: strong.hasAttribute('data-emph-step'), words: strong.querySelectorAll('.es-w').length, weight: getComputedStyle(strong).fontWeight }
      })
      assert.deepEqual([title.marked, title.words], [false, 0])
      assert(Number(title.weight) >= 700, `the title's bold is bold on arrival (${title.weight})`)
    })

    await check('(a) after the last piece Next moves on; Back returns with all of it on and takes it off in reverse', async () => {
      let shown = await next()
      assert.equal(shown.slide, 'mixed', 'the press after the last piece goes to the next slide')
      shown = await back()
      assert.equal(shown.slide, 'plain')
      assert.deepEqual(states(shown), [ON, ON, ON, ON], 'entered backwards: all emphasis on')
      for (const want of [[ON, ON, ON, OFF], [ON, ON, OFF, OFF], [ON, OFF, OFF, OFF], [OFF, OFF, OFF, OFF]]) {
        shown = await back()
        assert.equal(shown.slide, 'plain')
        assert.deepEqual(states(shown), want)
      }
      assert.equal((await back()).slide, 'start', 'Back from plain text leaves the slide')
      assert.deepEqual(states(await next()), [OFF, OFF, OFF, OFF], 'and the slide arrives plain again')
    })

    await check('the next-slide pane shows all emphasis while the projector steps', async () => {
      await back()   // on Start: the next pane previews the stepped slide
      await presenter.waitForFunction(() => document.querySelector('#nextPreview iframe')?.contentDocument?.querySelector('.slide')?.dataset.id === 'plain')
      const preview = await presenter.evaluate(() => {
        const slide = document.querySelector('#nextPreview iframe').contentDocument.querySelector('.slide')
        return { spans: slide.querySelectorAll('[data-emph-step]').length, off: slide.querySelectorAll('[data-emph-state="off"]').length }
      })
      assert.deepEqual(preview, { spans: 4, off: 0 })
      await next()
    })

    await check("the presenter's own Reveal (R) on the slide: each block appears, then its emphasis", async () => {
      let shown = await press('r')
      assert.equal(shown.mode, 'reveal')
      assert.deepEqual(shown.blocks, ['hidden', null, 'hidden', 'hidden'], 'paragraph and both items wait (the list itself is not a unit)')
      assert.deepEqual(states(shown), [OFF, OFF, OFF, OFF])
      const walk = []
      for (let i = 0; i < 8; i += 1) { shown = await next(); walk.push([shown.blocks.filter(Boolean).join(' '), states(shown).join(' ')]) }
      assert.deepEqual(walk, [
        ['current hidden hidden', 'off off off off'],
        ['current hidden hidden', 'on off off off'],
        ['soft current hidden', 'on off off off'],
        ['soft current hidden', 'on on off off'],
        ['soft soft current', 'on on off off'],
        ['soft soft current', 'on on on off'],
        ['soft soft current', 'on on on on'],
        ['full full full', 'on on on on']
      ])
      assert.deepEqual(await projector.evaluate(readGeometry), allOnGeometry, 'fully revealed, the slide has the same boxes again')
      shown = await press('r')
      assert.equal(shown.mode, null, 'R again leaves Reveal')
      assert.deepEqual(shown.blocks, [null, null, null, null])
      assert.deepEqual(states(shown), [OFF, OFF, OFF, OFF], 'and the slide is back at its own first step')
      for (let i = 0; i < 4; i += 1) await next()
    })

    // ── (b) with {reveal} ───────────────────────────────────────────────────────────────────
    await check('(b) {reveal}: an item appears, its emphasis follows as its own steps, then the next item', async () => {
      let shown = await next()
      assert.equal(shown.slide, 'mixed')
      assert.equal(shown.mode, 'reveal')
      assert.deepEqual(shown.emphasis, ['one:off', 'two:off', 'three:off'])
      assert.deepEqual(shown.blocks, [null, 'hidden', 'hidden', 'hidden'])
      const walk = []
      for (let i = 0; i < 7; i += 1) {
        shown = await next()
        assert.equal(shown.slide, 'mixed', `step ${i + 1} stays on the slide`)
        assert.equal(shown.focus.step, i + 1, 'the step is one flat count over the page order')
        walk.push([shown.blocks.filter(Boolean).join(' '), states(shown).join(' ')])
      }
      assert.deepEqual(walk, [
        ['current hidden hidden', 'off off off'],   // Alpha appears, plain
        ['current hidden hidden', 'on off off'],    //   its bold
        ['current hidden hidden', 'on on off'],     //   its highlight
        ['soft current hidden', 'on on off'],       // Beta appears
        ['soft soft current', 'on on off'],         // Gamma appears, plain
        ['soft soft current', 'on on on'],          //   its underline
        ['full full full', 'on on on']              // all at full strength
      ])
      assert.equal((await next()).slide, 'focus', 'then the next slide')
      shown = await back()
      assert.deepEqual([shown.slide, shown.blocks.filter(Boolean).join(' '), states(shown).join(' ')], ['mixed', 'full full full', 'on on on'], 'entered backwards: everything on')
      shown = await back()
      assert.deepEqual([shown.blocks.filter(Boolean).join(' '), states(shown).join(' ')], ['soft soft current', 'on on on'])
      shown = await back()
      assert.deepEqual([shown.blocks.filter(Boolean).join(' '), states(shown).join(' ')], ['soft soft current', 'on on off'], 'Back takes the last emphasis off before the item goes')
      for (let i = 0; i < 3; i += 1) await next()
    })

    // ── (c) with {focus} ────────────────────────────────────────────────────────────────────
    await check('(c) {focus}: the emphasis of the unit in focus steps before focus moves on', async () => {
      let shown = await projector.evaluate(readSlide, false)
      assert.deepEqual([shown.slide, shown.mode], ['focus', 'focus'])
      assert.deepEqual(shown.blocks, [null, 'fuzzy', 'fuzzy'])
      const walk = []
      for (let i = 0; i < 5; i += 1) { shown = await next(); walk.push([shown.slide, shown.blocks.filter(Boolean).join(' '), states(shown).join(' ')]) }
      assert.deepEqual(walk, [
        ['focus', 'current fuzzy', 'off off'],
        ['focus', 'current fuzzy', 'on off'],
        ['focus', 'soft current', 'on off'],
        ['focus', 'soft current', 'on on'],
        ['focus', 'full full', 'on on']
      ])
    })

    await check('a {group} list appears as one unit, then its emphasis in order', async () => {
      let shown = await next()
      assert.equal(shown.slide, 'group')
      assert.deepEqual(shown.blocks, ['hidden', null, null], 'the list is the one unit; its items are not')
      const walk = []
      for (let i = 0; i < 3; i += 1) { shown = await next(); walk.push([shown.slide, shown.blocks[0], states(shown).join(' ')]) }
      assert.deepEqual(walk, [['group', 'current', 'off off'], ['group', 'current', 'on off'], ['group', 'full', 'on on']])
    })

    // ── with {image-steps} ──────────────────────────────────────────────────────────────────
    await check('with {image-steps}: the emphasis first, then the images, then the slide again', async () => {
      let shown = await next()
      assert.deepEqual([shown.slide, states(shown).join(' '), shown.lightbox.open], ['images', 'off', false])
      shown = await next()
      assert.deepEqual([shown.slide, states(shown).join(' '), shown.lightbox.open], ['images', 'on', false], 'Next turns the emphasis on before any image is enlarged')
      shown = await next()
      assert.deepEqual([shown.slide, states(shown).join(' '), shown.lightbox], ['images', 'on', { open: true, index: 0 }], 'then the first image')
      shown = await next()
      assert.deepEqual(shown.lightbox, { open: true, index: 1 })
      shown = await next()
      assert.deepEqual([shown.slide, states(shown).join(' '), shown.lightbox], ['images', 'on', { open: false, index: 2 }], 'the slide again, emphasis still on')
      assert.equal((await next()).slide, 'nostep')
      shown = await back()
      assert.deepEqual([shown.slide, states(shown).join(' '), shown.lightbox], ['images', 'on', { open: false, index: 2 }], 'Back lands on the slide again')
      assert.deepEqual((await back()).lightbox, { open: true, index: 1 })
      assert.deepEqual((await back()).lightbox, { open: true, index: 0 })
      shown = await back()
      assert.deepEqual([states(shown).join(' '), shown.lightbox], ['on', { open: false, index: 0 }], 'out of the images, the emphasis is still on')
      assert.deepEqual(states(await back()), [OFF], 'then Back takes the emphasis off')
      for (let i = 0; i < 5; i += 1) await next()
    })

    // ── {nostep} ────────────────────────────────────────────────────────────────────────────
    await check('{nostep} beside the option: no emphasis step, all of it on', async () => {
      const shown = await projector.evaluate(readSlide, false)
      assert.equal(shown.slide, 'nostep')
      assert.deepEqual(shown.emphasis, [], 'nothing on the slide is marked as a step')
      assert.equal(await projector.evaluate(() => getComputedStyle(document.querySelector('.slide.active .feature-list strong')).fontWeight), '700')
      assert.equal(await projector.evaluate(() => document.querySelectorAll('.slide.active mark.ink-marker').length), 1)
      assert.equal((await next()).slide, 'off', 'Next goes straight to the next slide')
    })
    await check('a slide without the option in the same talk does not step', async () => {
      assert.equal((await next()).slide, 'end')
      assert.equal((await back()).slide, 'off')
    })
    await context.close()
  }

  // ── The option absent ─────────────────────────────────────────────────────────────────────
  await check('the option absent: nothing is marked anywhere and Next goes slide to slide', async () => {
    assert.doesNotMatch(offHtml.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, ''), /data-emph-step|data-emphasis-steps|class="es-w"/,
      'the compiled talk carries no emphasis-step markup')
    const { context, projector, next } = await pair('/off.html')
    assert.equal(await projector.evaluate(() => document.querySelectorAll('[data-emph-step], [data-emph-state], [data-emphasis-steps], .es-w').length), 0)
    const seen = []
    for (let i = 0; i < 40; i += 1) {
      const shown = await next()
      assert.equal(await projector.evaluate(() => document.querySelectorAll('[data-emph-state]').length), 0, 'no span is ever given a step state')
      if (shown.lightbox.open) continue
      if (seen.at(-1) !== shown.slide) seen.push(shown.slide)
      if (shown.slide === 'end') break
    }
    assert.deepEqual(seen, ['plain', 'mixed', 'focus', 'group', 'images', 'nostep', 'off', 'end'])
    await context.close()
  })

  // ── A carousel with the option ────────────────────────────────────────────────────────────
  {
    const { context, projector, next, back } = await pair('/carousel.html')
    const at = (shown) => [shown.slide, shown.card, shown.onCard.join(' ')]
    await check('carousel: the shared line under the cards is not a step and shows its emphasis from arrival', async () => {
      const shown = await next()
      assert.deepEqual(at(shown), ['cards', 0, 'a:off b:off'], 'the first card arrives plain')
      const source = await projector.evaluate(() => {
        const line = document.querySelector('.slide.active .slide-source')
        const transparent = (value) => /rgba\(\d+, \d+, \d+, 0\)|transparent/.test(value)
        return { text: line.textContent, marked: line.querySelectorAll('[data-emph-step], [data-emph-state], .es-w').length,
          bold: Number(getComputedStyle(line.querySelector('strong')).fontWeight) >= 700,
          boldPainted: !transparent(getComputedStyle(line.querySelector('strong')).webkitTextFillColor),
          highlight: getComputedStyle(line.querySelector('mark.ink-marker')).backgroundImage !== 'none' }
      })
      assert.deepEqual(source, { text: 'A shared source line with a mark', marked: 0, bold: true, boldPainted: true, highlight: true })
      assert.equal(shown.emphasis.length, 3, 'only the cards\' emphasis is marked (two on the first card, one on the second)')
    })
    await check('carousel, cards as beats: each card\'s emphasis steps inside the card; Back lands on a card with all of it on', async () => {
      assert.deepEqual(at(await next()), ['cards', 0, 'a:on b:off'])
      assert.deepEqual(at(await next()), ['cards', 0, 'a:on b:on'])
      assert.deepEqual(at(await next()), ['cards', 1, 'c:off'], 'the press after the card\'s last piece shows the next card, plain')
      assert.deepEqual(at(await next()), ['cards', 1, 'c:on'])
      assert.deepEqual(at(await next()), ['hops', 0, 'd:off e:off'], 'then the next slide')
      assert.deepEqual(at(await back()), ['cards', 1, 'c:on'], 'Back lands on the last card with its emphasis on')
      assert.deepEqual(at(await back()), ['cards', 1, 'c:off'])
      assert.deepEqual(at(await back()), ['cards', 0, 'a:on b:on'], 'Back onto the first card: all of its emphasis on')
      assert.deepEqual(at(await back()), ['cards', 0, 'a:on b:off'])
      for (let i = 0; i < 4; i += 1) await next()
    })
    await check('carousel, cards that hop within one beat: emphasis first, then the hop; Back across the hop lands with it all on', async () => {
      assert.deepEqual(at(await projector.evaluate(readSlide, false)), ['hops', 0, 'd:off e:off'])
      assert.deepEqual(at(await next()), ['hops', 0, 'd:on e:off'])
      assert.deepEqual(at(await next()), ['hops', 0, 'd:on e:on'])
      assert.deepEqual(at(await next()), ['hops', 1, 'f:off'], 'the hop comes after the card\'s emphasis, and the next card arrives plain')
      assert.deepEqual(at(await next()), ['hops', 1, 'f:on'])
      assert.deepEqual(at(await next()), ['end', null, ''])
      assert.deepEqual(at(await back()), ['hops', 1, 'f:on'], 'entered backwards: the last card, all on')
      assert.deepEqual(at(await back()), ['hops', 1, 'f:off'])
      assert.deepEqual(at(await back()), ['hops', 0, 'd:on e:on'], 'Back across the hop: the previous card with all its emphasis on')
      assert.deepEqual(at(await back()), ['hops', 0, 'd:on e:off'])
      assert.deepEqual(at(await back()), ['hops', 0, 'd:off e:off'])
      assert.deepEqual(at(await back()), ['cards', 1, 'c:on'])
    })
    await context.close()
  }

  // ── A phone following live ────────────────────────────────────────────────────────────────
  await check('a following phone: an emphasis-only step is no mode of the reader\'s; one click on Reveal enters the reader\'s own Reveal', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' })
    page.on('pageerror', (error) => { failures += 1; console.error(`FAIL follower page error: ${error.message}`) })
    await page.addInitScript(liveServiceStandIn)
    await page.goto(`${origin}/follower.html`, { waitUntil: 'load' })
    await page.waitForFunction(() => window.__sockets.length === 1)
    // The "plain" slide's units in page order: paragraph, bold, item, highlight, item, underline, strike.
    const block = { kind: 'block', parent: null }
    const span = (parent) => ({ kind: 'emphasis', parent })
    const units = [block, span(0), block, span(2), block, span(4), span(4)]
    const sent = emphasisWireFocus(units, null, 2)
    assert.equal(sent.kind, 'reveal', 'an emphasis-only step travels as kind "reveal" (ADR-0035)')
    let revision = 0
    const send = async () => {
      revision += 1
      await page.evaluate((state) => window.__sockets.at(-1).emit(state), { type: 'slide.state', slideId: 'plain', reveal: 0, focus: sent, revision })
      await page.locator('.slide.active[data-id="plain"]').waitFor()
    }
    const read = () => page.evaluate((fn) => ({
      ...new Function(`return (${fn})(false)`)(),
      revealPressed: document.getElementById('revealBtn').getAttribute('aria-pressed'),
      following: document.querySelector('#followLiveBtn .btn-label').textContent,
      returnShown: !document.getElementById('returnToPresenterBtn').hidden && getComputedStyle(document.getElementById('returnToPresenterBtn')).display !== 'none'
    }), readSlide.toString())
    const shape = (shown) => [shown.mode, shown.blocks.join(' '), shown.emphasis.map((entry) => entry.split(':').at(-1)).join(' '), shown.revealPressed]

    await send()
    let shown = await read()
    assert.deepEqual(shape(shown), [null, '   ', 'on on off off', 'false'], 'following: two pieces on, every block shown, Reveal not pressed')
    assert.deepEqual([shown.following, shown.returnShown], ['Stop following', false], 'the page is at the presenter\'s position')

    await page.locator('#revealBtn').click()
    shown = await read()
    assert.deepEqual(shape(shown), ['reveal', 'hidden  hidden hidden', 'on on on on', 'true'],
      'ONE click: the reader\'s own Reveal is on at its first step, and all emphasis shows')
    assert.equal(shown.returnShown, true, 'the reader has left the presenter\'s position')
    await page.keyboard.press('ArrowRight')
    shown = await read()
    assert.deepEqual(shape(shown), ['reveal', 'current  hidden hidden', 'on on on on', 'true'], 'the reader\'s Reveal steps the blocks only')
    await page.locator('#revealBtn').click()
    shown = await read()
    assert.deepEqual(shape(shown), [null, '   ', 'on on on on', 'false'], 'a second click leaves the reader\'s Reveal')

    // Focus from the same followed state, by key.
    await page.locator('#returnToPresenterBtn').click()
    shown = await read()
    assert.deepEqual(shape(shown), [null, '   ', 'on on off off', 'false'], 'Return shows the presenter\'s step again')
    await page.keyboard.press('f')
    shown = await read()
    assert.deepEqual([shown.mode, shown.emphasis.filter((entry) => entry.endsWith(':off')).length], ['focus', 0], 'one press of F enters the reader\'s own Focus')
    await page.keyboard.press('f')

    // Stop following without moving: the page shows what a handout shows.
    await page.locator('#returnToPresenterBtn').click()
    assert.deepEqual(shape(await read()), [null, '   ', 'on on off off', 'false'])
    await page.locator('#followLiveBtn').click()
    shown = await read()
    assert.equal(shown.following, 'Follow live')
    assert.deepEqual(shape(shown), [null, '   ', 'on on on on', 'false'], 'Stop following: all emphasis on')
    await page.close()
  })

  // ── The transition ────────────────────────────────────────────────────────────────────────
  await check('the change takes about 200 ms, on paint properties only; none under reduced motion', async () => {
    const durations = async (reducedMotion) => {
      const { context, projector, next } = await pair('/on.html', { reducedMotion })
      await next()
      await projector.waitForFunction(() => document.querySelector('.slide.active').classList.contains('emph-anim'))
      const read = await projector.evaluate(() => {
        const slide = document.querySelector('.slide.active')
        const style = (el, pseudo) => { const s = getComputedStyle(el, pseudo); return { properties: s.transitionProperty, durations: s.transitionDuration } }
        return [style(slide.querySelector('strong[data-emph-step]')), style(slide.querySelector('.es-w')), style(slide.querySelector('.es-w'), '::before'),
          style(slide.querySelector('mark[data-emph-step]')), style(slide.querySelector('u[data-emph-step]')), style(slide.querySelector('s[data-emph-step]'))]
      })
      await context.close()
      return read
    }
    const moving = await durations('no-preference')
    for (const entry of moving) {
      assert.match(entry.durations, /^0\.2s(, 0\.2s)*$/, `200 ms (${entry.durations})`)
      for (const property of entry.properties.split(', ')) {
        assert(['color', 'background-color', 'background-size', 'box-shadow', 'text-decoration-color', 'opacity', '-webkit-text-fill-color'].includes(property), `${property} is a paint property`)
      }
    }
    for (const entry of await durations('reduce')) assert.match(entry.durations, /^0s(, 0s)*$/, `no transition under reduced motion (${entry.durations})`)
  })

  // ── The handout, the phone view and print ─────────────────────────────────────────────────
  await check('the handout shows all emphasis, also while the reader steps with Reveal, and so does print', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    page.on('pageerror', (error) => { failures += 1; console.error(`FAIL handout page error: ${error.message}`) })
    await page.goto(`${origin}/handout.html#plain`, { waitUntil: 'load' })
    await page.locator('.slide.active[data-id="plain"]').waitFor()
    const read = () => page.evaluate(() => {
      const slide = document.querySelector('.slide.active')
      return { spans: slide.querySelectorAll('[data-emph-step]').length, off: document.querySelectorAll('[data-emph-state="off"]').length,
        copyOpacity: getComputedStyle(slide.querySelector('.es-w'), '::before').opacity,
        strongWeight: getComputedStyle(slide.querySelector('.content-p strong')).fontWeight }
    })
    assert.deepEqual(await read(), { spans: 4, off: 0, copyOpacity: '0', strongWeight: '700' })
    await page.keyboard.press('r')
    await page.locator('.slide.active.mode-reveal').waitFor()
    await page.keyboard.press('ArrowRight')
    assert.deepEqual(await read(), { spans: 4, off: 0, copyOpacity: '0', strongWeight: '700' }, "the reader's own Reveal steps blocks only")
    await page.close()
    // Print: a projector left mid-step prints every piece of emphasis.
    const { context, projector, next } = await pair('/on.html')
    await next()
    assert.equal(await projector.evaluate(() => document.querySelectorAll('.slide.active [data-emph-state="off"]').length), 4)
    await projector.emulateMedia({ media: 'print' })
    const printed = await projector.evaluate(() => {
      const slide = document.querySelector('.slide[data-id="plain"]')
      const transparent = (value) => /rgba\(\d+, \d+, \d+, 0\)|transparent/.test(value)
      return { boldFilled: !transparent(getComputedStyle(slide.querySelector('.es-w')).webkitTextFillColor), copy: getComputedStyle(slide.querySelector('.es-w'), '::before').content,
        underline: !transparent(getComputedStyle(slide.querySelector('u[data-emph-step]')).textDecorationColor),
        strike: !transparent(getComputedStyle(slide.querySelector('s[data-emph-step]')).textDecorationColor) }
    })
    assert.deepEqual(printed, { boldFilled: true, copy: 'none', underline: true, strike: true })
    await context.close()
  })
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
if (failures > 0) { console.error(`${failures} emphasis-steps DOM check(s) failed`); process.exit(1) }
console.log('PASS emphasis-steps DOM: plain arrival, reading order, no reflow, title, Back, Reveal, {reveal}, {focus}, {group}, {image-steps}, {nostep}, option absent, carousel, a following phone, transition, handout and print')
