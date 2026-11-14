// test:carousel-steps-dom: Next and Previous show every carousel card exactly once, in order.
//
// A carousel led by a picture or an embed (a block before its first #### card) draws that block as
// its own first card. Up to 0.44 the beats counted only the #### cards, so Next showed the picture,
// then the cards up to the last-but-one, then left the slide: the last card was never shown and the
// first card's address opened the picture. This walks real compiled decks in headless Chromium:
//   1. Next from the slide before each carousel to the slide after it, then Previous back again:
//      the cards shown are 0..n-1 once each (reverse on the way back), the counter agrees, and the
//      address (which the recorder's slide-change log reads) names the card on show.
//   2. Every card has its own address (a second leading picture or embed card too), and it opens that card.
//   3. The model's beats: one per drawn card, indices 0..n-1, count n.
//   4. Print: every card of every carousel prints, once, on its own page (one page per card), with a box.
// Shapes: all heading cards; picture first; embed first; picture and embed first; picture only;
// one card; a picture card in the middle; {carousel} over plain blocks (picture in the middle); a slide
// copied from another talk ({from=…});
// a {reveal} carousel whose cards step their lines.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tw-carousel-steps-'))

function png(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.alloc(1 + width * 3, 0x90)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const pic = join(dir, 'pic.png'); writeFileSync(pic, png(800, 450))
const embedPage = join(dir, 'embed.html'); writeFileSync(embedPage, '<!doctype html><title>e</title><p>embedded page</p>')

// Each shape: its outline lines and the number of cards it draws.
const SHAPES = [
  { id: 'all-heads', cards: 3, lines: ['{carousel}', '', '#### Alpha {id=all-heads-a}', '', 'First card words.', '', '#### Beta {id=all-heads-b}', '', 'Second card words.', '', '#### Gamma {id=all-heads-c}', '', 'Third card words.'] },
  { id: 'pic-first', cards: 3, lines: ['{carousel}', '', `![](${pic})`, '', '#### Alpha {id=pic-first-a}', '', 'First card words.', '', '#### Beta {id=pic-first-b}', '', 'Second card words.'] },
  { id: 'pic-one', cards: 2, lines: ['{carousel}', '', `![](${pic})`, '', '#### Alpha {id=pic-one-a}', '', 'Only heading card.'] },
  { id: 'embed-first', cards: 3, lines: ['{carousel}', '', `[Embed: ${embedPage}]`, '', '#### Alpha {id=embed-first-a}', '', 'First card words.', '', '#### Beta {id=embed-first-b}', '', 'Second card words.'] },
  { id: 'pic-embed', cards: 4, lines: ['{carousel}', '', `![](${pic})`, '', `[Embed: ${embedPage}]`, '', '#### Alpha {id=pic-embed-a}', '', 'First card words.', '', '#### Beta {id=pic-embed-b}', '', 'Second card words.'] },
  { id: 'pic-only', cards: 1, lines: ['{carousel}', '', `![](${pic})`] },
  { id: 'pic-only-card', cards: 1, lines: ['{carousel}', '', '#### Only {id=pic-only-card-a}', '', `![](${pic})`] },
  { id: 'one-card', cards: 1, lines: ['{carousel}', '', '#### Single {id=one-card-a}', '', 'The only card.'] },
  { id: 'pic-middle', cards: 3, lines: ['{carousel}', '', '#### Alpha {id=pic-middle-a}', '', 'First card words.', '', '#### Picture {id=pic-middle-b}', '', `![](${pic})`, '', '#### Gamma {id=pic-middle-c}', '', 'Third card words.'] },
  { id: 'flat-middle', cards: 3, lines: ['{carousel}', '', 'A first paragraph card.', '', 'Words that ride with the picture.', '', `![](${pic})`, '', 'A last paragraph card.'] },
  { id: 'from-copy', cards: 2, lines: ['{carousel} {from=another-talk#pics}', '', `![](${pic})`, '', '#### Alpha {id=from-copy-a}', '', 'Copied card words.'] },
  { id: 'reveal', cards: 3, reveal: true, lines: ['{carousel} {reveal}', '', `![](${pic})`, '', '#### Alpha {id=reveal-a}', '', '- one', '- two', '- three', '', '#### Beta {id=reveal-b}', '', '- four', '- five'] }
]

const outline = ['---', 'title: Carousel steps', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', '# Carousel steps', '', '## Shapes', '']
for (const shape of SHAPES) {
  outline.push(`### Before ${shape.id}`, `{id=before-${shape.id}}`, '', `Plain slide before ${shape.id}.`, '')
  // The first line is the slide's trigger line.
  const trigger = shape.lines[0] ? ` ${shape.lines[0]}` : ''
  outline.push(`### Carousel ${shape.id}`, `{id=${shape.id}}${trigger}`, ...shape.lines.slice(1), '')
}
outline.push('### The end', '{id=the-end}', '', 'Closing words.', '')
const outlineText = outline.join('\n')
const outlinePath = join(dir, 'outline.md')
writeFileSync(outlinePath, outlineText)
const model = await prepareSource(outlinePath, outlineText, 'carousel-steps', statSync(outlinePath))
const htmlPath = join(dir, 'deck.html')
writeFileSync(htmlPath, String(model.fullHtml))

// 3. The beats: one per drawn card. (A shape whose carousel has no #### children steps its cards
// inside one beat; it has no carousel beats.)
const failures = []
const check = (fn) => { try { fn() } catch (error) { failures.push(error.message) } }
for (const shape of SHAPES) {
  const own = model.beats.filter((beat) => beat.context?.container === 'carousel' && beat.context.sectionId === shape.id)
  if (!own.length) continue
  check(() => assert.deepEqual(own.map((beat) => [beat.context.index, beat.context.count]), Array.from({ length: shape.cards }, (_, i) => [i, shape.cards]), `${shape.id}: one beat per drawn card`))
}

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route(/^https?:/, (route) => route.abort())
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' })
  await page.waitForTimeout(400)
  const state = () => page.evaluate(() => {
    const slide = document.querySelector('#stage > .slide.active')
    const cards = slide ? [...slide.querySelectorAll('.card-gallery.carousel > .card')] : []
    const shown = cards.map((card, i) => (getComputedStyle(card).display !== 'none' ? i : -1)).filter((i) => i >= 0)
    const counter = slide?.querySelector('.gallery-counter')?.textContent?.trim() || ''
    const visibleUnits = slide ? [...slide.querySelectorAll('.card.active-card li')].filter((li) => getComputedStyle(li).visibility !== 'hidden' && getComputedStyle(li).opacity !== '0' && !li.classList.contains('step-hidden')).length : 0
    return { id: slide?.dataset.id || '', cards: cards.length, shown, counter, hash: location.hash.slice(1), visibleUnits }
  })
  const go = async (id) => {
    await page.evaluate((target) => { location.hash = target; window.dispatchEvent(new HashChangeEvent('hashchange')) }, id)
    await page.waitForTimeout(150)
  }
  const press = async (key) => { await page.keyboard.press(key); await page.waitForTimeout(90) }
  // Walk from one slide to another with a key; return the carousel states visited, in order.
  const walk = async (fromId, toId, key, shapeId) => {
    await go(fromId)
    const seen = []
    for (let i = 0; i < 40; i += 1) {
      await press(key)
      const now = await state()
      if (now.id === toId) return seen
      if (now.id !== shapeId) { seen.push({ ...now, stray: true }); return seen }
      seen.push(now)
    }
    return seen
  }
  const collapse = (seen) => seen.map((s) => s.shown.join(',')).filter((v, i, all) => i === 0 || all[i - 1] !== v)
  const order = (n) => Array.from({ length: n }, (_, i) => String(i))

  for (const [i, shape] of SHAPES.entries()) {
    const after = SHAPES[i + 1] ? `before-${SHAPES[i + 1].id}` : 'the-end'
    // 1. Forwards.
    const fwd = await walk(`before-${shape.id}`, after, 'ArrowRight', shape.id)
    check(() => assert(!fwd.some((s) => s.stray), `${shape.id}: Next stays on the carousel until it leaves for the next slide (${JSON.stringify(fwd.map((s) => s.id))})`))
    check(() => assert.equal(fwd[0]?.cards, shape.cards, `${shape.id}: draws ${shape.cards} cards`))
    check(() => assert.deepEqual(collapse(fwd), order(shape.cards), `${shape.id}: Next shows every card once, in order`))
    check(() => assert(fwd.every((s) => s.shown.length === 1), `${shape.id}: exactly one card on show at a time`))
    if (shape.cards > 1) check(() => assert(fwd.every((s) => s.counter === `${Number(s.shown[0]) + 1} / ${shape.cards}`), `${shape.id}: the counter agrees with the card (${fwd.map((s) => s.counter).join(' | ')})`))
    // The address follows the card (the recorder's slide-change log reads it): a leading picture or
    // embed card is the slide's own address (a later one <id>-media-<n>), a #### card its own.
    const ownBeats = model.beats.filter((beat) => beat.context?.container === 'carousel' && beat.context.sectionId === shape.id)
    if (ownBeats.length) check(() => assert.deepEqual(fwd.map((s) => s.hash), fwd.map((s) => ownBeats[s.shown[0]]?.slideId), `${shape.id}: the address names the card on show (${fwd.map((s) => s.hash).join(' | ')})`))
    if (shape.reveal) {
      const alpha = fwd.filter((s) => s.shown[0] === 1).map((s) => s.visibleUnits)
      check(() => assert(alpha.length >= 3 && alpha[alpha.length - 1] === 3 && alpha[0] < 3, `${shape.id}: the reveal steps the card's lines (${alpha.join(',')})`))
    }
    // 1b. Backwards from the next slide.
    const back = await walk(after, `before-${shape.id}`, 'ArrowLeft', shape.id)
    check(() => assert(!back.some((s) => s.stray), `${shape.id}: Previous from the next slide stays on the carousel until it leaves`))
    check(() => assert.deepEqual(collapse(back), order(shape.cards).reverse(), `${shape.id}: Previous shows every card once, in reverse order`))
    // 2. Each carousel beat's own address opens its card.
    const own = model.beats.filter((beat) => beat.context?.container === 'carousel' && beat.context.sectionId === shape.id)
    check(() => assert.equal(new Set(own.map((beat) => beat.slideId)).size, own.length, `${shape.id}: every card has its own address (${own.map((beat) => beat.slideId).join(', ')})`))
    for (const beat of own) {
      await page.goto('about:blank')
      await page.goto(`${pathToFileURL(htmlPath).href}#${beat.slideId}`, { waitUntil: 'load' })
      await page.waitForTimeout(250)
      const at = await state()
      check(() => assert.deepEqual([at.id, at.shown], [shape.id, [beat.context.index]], `${shape.id}: #${beat.slideId} opens card ${beat.context.index}`))
    }
    if (own.length) {
      await page.goto('about:blank')
      await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' })
      await page.waitForTimeout(250)
    }
  }
  // 4. Print: a carousel prints one page per card (slideFit.preparePrint clones the slide per card; a one-card
  // carousel prints as itself). Every card prints, once, with a box.
  await page.emulateMedia({ media: 'print' })
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')))
  await page.waitForTimeout(300)
  const printed = await page.evaluate((ids) => ids.map((id) => {
    const src = document.querySelector(`.slide[data-id="${id}"]`)
    const heights = []
    const box = (slide) => Math.round(slide?.querySelector('.card-gallery.carousel > .card.carousel-subslide.active-card')?.getBoundingClientRect().height || 0)
    // The source slide (hidden for the print) is followed by its pages, each in its own page canvas.
    for (let el = src?.nextElementSibling; el; el = el.nextElementSibling) {
      const pageSlide = el.matches('.slide.carousel-print-page') ? el : el.querySelector(':scope > .slide.carousel-print-page')
      if (!pageSlide) break
      heights.push(box(pageSlide))
    }
    if (!heights.length && src) heights.push(box(src))
    return [id, heights]
  }), SHAPES.map((shape) => shape.id))
  for (const [id, heights] of printed) {
    const want = SHAPES.find((shape) => shape.id === id).cards
    check(() => assert(heights.length === want && heights.every((h) => h > 20), `${id}: every card prints, once, with a box (${heights.join(', ')}; ${want} card(s))`))
  }
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
  await page.emulateMedia({ media: 'screen' })
  check(() => assert.deepEqual(errors, [], 'no page errors'))
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`carousel-steps-dom: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`)
  process.exit(1)
}
console.log(`carousel-steps-dom: ok (${SHAPES.length} carousel shapes, Next and Previous, addresses, beats)`)
