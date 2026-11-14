// test:carousel-dots-dom: a carousel card's content never runs into the gallery dots and is never cut off.
//
// A carousel shows one card in the band between the slide's title and its dots. The band is a flex share of the
// slide, so a card taller than its band spilled over the dots (the layout sampler's "A month with agents" cards in
// 0.43 and 0.44, Ocean and classic) and the slide fitter never saw it. The fitter now counts the card's overflow:
// the Ocean look falls back to its safe drawing, and the whole-slide zoom fits what is left.
// For each carousel, card and look (Ocean, classic) at 1280x720 and 1600x900, in headless Chromium:
//   - the card's content sits between the slide title and the dots, inside the slide, and nothing in it is clipped;
//   - a list card longer than its band is fitted by the list ladder;
//   - a card that needs the dots' band takes it (the dots move to the slide's foot padding); one that cannot be fitted
//     even then is reported (data-text-fit) and drawn as 0.44 drew it (data-carousel-legacy), so nothing it showed is lost;
//   - a carousel whose cards fit is drawn as before: Ocean look kept, no zoom;
//   - a card that needs more than its band (plain title) makes an Ocean slide fall back and is zoomed to fit;
//   - with the deck's control bar showing, the dots (in the band or in the slide's foot) take their own clicks;
//   - a side-title carousel keeps its 0.44 drawing: the card's min-height holds, the dots stay put from card to card.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { deflateSync } from 'node:zlib'
import { inClassicLook } from './lib/slide-markup-identity.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tw-carousel-dots-'))
function png(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.alloc(1 + width * 3, 0x60)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))])
}
const pic = join(dir, 'pic.png'); writeFileSync(pic, png(1000, 700))
const outline = [
  '---', 'title: Carousel dots', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '# Carousel dots', '', '## Everyday', '',
  // The layout sampler's slide, as written there.
  '### A month with agents (carousel)', '{id=agents} {carousel}', '',
  '#### Scheduled my calendar {id=agents-a}', '', 'Codex read the invitation thread, found the gaps, and booked the travel time around them.', '',
  '#### Built my own slide tools {id=agents-b}', '', 'The presentation system this very deck runs on — outlines in, talks out.', '',
  '#### Rescued old websites {id=agents-c}', '', 'Fifteen years of abandoned HTML, migrated and republished in an afternoon.', '',
  // A card a little longer than its band: it takes the dots' band (the dots move to the slide's foot).
  '### Longer card', '{id=long} {carousel}', '',
  '#### A longer account of the month {id=long-a}', '',
  'We read every invitation thread and calendar note, wrote down what each asked of us, and only then moved anything.', '',
  '#### Brief {id=long-b}', '', 'A brief card.', '',
  // A card that cannot be fitted at all (too long at the type floor even with the dots moved): reported, and drawn as
  // 0.44 drew it, so it shows at least what 0.44 showed.
  '### Too long', '{id=toolong} {carousel}', '',
  '#### A long account {id=toolong-a}', '',
  'We spent the first week reading every invitation thread, every calendar note and every travel booking, and wrote down what each one asked of us before anything was moved or answered.', '',
  'The second week went on the slide tools: outlines in, talks out, with every layout checked against real talks and every check written down where the next person would find it.', '',
  '#### Brief {id=toolong-b}', '', 'A brief card.', '',
  // A list card longer than its band: the list ladder fits it (leading, gaps, then type to the floor).
  '### List card', '{id=list} {carousel}', '',
  '#### Tools we use {id=list-a}', '', '- Mental checklists', '- Focus', '- Body parts', '- Physical objects', '- Computers', '- Notebooks', '',
  '#### Brief {id=list-b}', '', 'A brief card.', '',
  // A tall captioned picture card under a source line: the caption stays clear of the dots.
  '### Figure card', '{id=figure} {carousel}', '',
  'Source: a paper about the machine, 1963.', '',
  '#### The machine {id=figure-a}', '', `![The matchbox machine, as photographed for the paper](${pic})`, '',
  '#### Brief {id=figure-b}', '', 'A brief card.', '',
  // A card whose code block is too long for any fit (its own fit reports it): drawn as 0.44 drew it, so the code
  // panel shows no fewer lines than 0.44 showed.
  '### Code card', '{id=code} {carousel}', '',
  '#### A long listing {id=code-a}', '', '```', ...Array.from({ length: 40 }, (_, i) => `line ${i + 1} = compute(${i + 1}) + offset`), '```', '',
  '#### Brief {id=code-b}', '', 'A brief card.', '',
  // Cards that fit: drawn as before.
  '### Short cards', '{id=short} {carousel}', '',
  '#### One {id=short-a}', '', 'A line.', '', '#### Two {id=short-b}', '', 'Another line.', '',
  // A carousel with its title in a side rail keeps its 0.44 drawing: the band changes are the top-title regime's.
  '### Side carousel', '{id=side} {carousel} {sidebar}', '',
  '#### Scheduled my calendar {id=side-a}', '', 'Codex read the invitation thread, found the gaps, and booked the travel time around them.', '',
  '#### Short {id=side-b}', '', 'A line.', '',
  '#### A longer account of the month {id=side-c}', '', 'We read every invitation thread and calendar note, wrote down what each asked of us, and only then moved anything.', ''
].join('\n')
const CAROUSELS = [['agents', 3], ['long', 2], ['toolong', 2], ['list', 2], ['figure', 2], ['code', 2], ['short', 2]]
// Under the plain title (title_look: full; the default tab title is itself under the type floor, so it forbids any
// zoom) a card that needs more than the dots' band: in Ocean the slide falls back to the look's safe drawing, and the
// whole-slide zoom fits what is left, in both looks.
const plainOutline = [
  '---', 'title: Carousel zoom', 'auto_title_slide: false', 'auto_thanks_slide: false', 'title_look: full', '---', '',
  '# Carousel zoom', '', '## Everyday', '',
  '### Zoomed card', '{id=zoom} {carousel}', '',
  '#### An account of the month {id=zoom-a}', '',
  'We read every invitation thread and calendar note, wrote down what each one asked of us, then moved the travel time around the gaps we found.', '',
  '#### Brief {id=zoom-b}', '', 'A brief card.', ''
].join('\n')
const SIDE = [['side', 3]]

const failures = []
const check = (fn) => { try { fn() } catch (error) { failures.push(error.message) } }
const browser = await chromium.launch({ headless: true })
try {
  for (const [look, text] of [['ocean', outline], ['classic', inClassicLook(outline)]]) {
    const outlinePath = join(dir, `${look}.md`)
    writeFileSync(outlinePath, text)
    const model = await prepareSource(outlinePath, text, `carousel-dots-${look}`, statSync(outlinePath))
    const htmlPath = join(dir, `${look}.html`)
    writeFileSync(htmlPath, String(model.fullHtml))
    for (const viewport of [{ width: 1280, height: 720 }, { width: 1600, height: 900 }]) {
      const page = await browser.newPage({ viewport })
      try {
        for (const [id, count] of CAROUSELS) {
          await page.goto('about:blank')
          await page.goto(`${pathToFileURL(htmlPath).href}#${id}`, { waitUntil: 'load' })
          await page.evaluate(() => document.fonts?.ready)
          await page.waitForTimeout(500)
          for (let card = 0; card < count; card += 1) {
            if (card) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(400) }
            const m = await page.evaluate(() => {
              const slide = document.querySelector('#stage > .slide.active')
              const content = slide.querySelector(':scope > .slide-content')
              const inner = slide.querySelector('.card.carousel-subslide.active-card > .slide-content')
              const kids = [...inner.querySelectorAll('*')].filter((el) => getComputedStyle(el).display !== 'none' && !el.closest('.slot-media')).map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0)
              const head = content.querySelector(':scope > .slide-head').getBoundingClientRect()
              const nav = content.querySelector(':scope > .gallery-nav')?.getBoundingClientRect()
              const box = slide.getBoundingClientRect()
              const navBox = content.querySelector(':scope > .gallery-nav')?.getBoundingClientRect()
              return {
                id: slide.dataset.id, look: slide.dataset.look, zoom: content.style.zoom || '', textFit: content.dataset.textFit || '',
                top: Math.min(...kids.map((k) => k.top)), bottom: Math.max(...kids.map((k) => k.bottom)), dots: content.dataset.carouselDots || 'band',
                clipped: [...inner.parentElement.querySelectorAll('*')].some((el) => { const cs = getComputedStyle(el); return /hidden|clip|auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1 && !el.closest('figure') }),
                headBottom: head.bottom, navTop: nav ? nav.top : null, navBottom: nav ? nav.bottom : null, slideBottom: box.bottom,
                navInside: Boolean(navBox) && navBox.left >= box.left - 1 && navBox.right <= box.right + 1,
                navShown: Boolean(navBox) && getComputedStyle(content.querySelector(':scope > .gallery-nav')).visibility !== 'hidden',
                legacy: 'carouselLegacy' in content.dataset, cardMinH: getComputedStyle(inner).minHeight, cardJustify: getComputedStyle(inner).justifyContent
              }
            })
            const where = `${look} ${viewport.width} ${id} card ${card} (${JSON.stringify({ look: m.look, zoom: m.zoom, fit: m.textFit, dots: m.dots })})`
            check(() => assert.equal(m.id, id, `${where}: on the carousel`))
            check(() => assert(m.navTop != null, `${where}: the dots are drawn`))
            const tooLong = (id === 'toolong' || id === 'code') && card === 0
            if (!tooLong) check(() => assert(!m.clipped, `${where}: nothing in the card is clipped or scrolled away`))
            if (!tooLong) check(() => assert(m.bottom <= m.navTop + 1, `${where}: the card's content ends above the dots (content ${m.bottom.toFixed(1)}, dots ${m.navTop?.toFixed(1)})`))
            if (!tooLong) check(() => assert(m.top >= m.headBottom - 1, `${where}: the card's content starts below the slide title (content ${m.top.toFixed(1)}, title ${m.headBottom.toFixed(1)})`))
            check(() => assert(m.navBottom <= m.slideBottom + 1 && m.navInside, `${where}: the dots are inside the slide`))
            if (tooLong && id === 'toolong') check(() => assert.equal(m.textFit, 'too-long', `${where}: a card too long even at the type floor is reported, as any slide is`))
            if (tooLong) check(() => assert(m.legacy && m.dots === 'band' && m.cardMinH !== '0px' && m.cardJustify === 'center', `${where}: a card that cannot be fitted is drawn as 0.44 drew it (${JSON.stringify([m.legacy, m.dots, m.cardMinH, m.cardJustify])})`))
            if (!tooLong) check(() => assert(!m.legacy, `${where}: a card that can be fitted keeps the band drawing`))
            if (id === 'agents' || id === 'short' || id === 'list') check(() => assert.equal(m.textFit, '', `${where}: nothing is left too long to fit`))
            if (id === 'long' && look === 'ocean') check(() => assert.equal(m.look, 'ocean-safe', `${where}: a card past its band, still inside the slide, makes the slide fall back from the Ocean look`))
            if (id === 'long') check(() => assert.equal(m.dots, 'foot', `${where}: a card that needs the dots' band takes it; the dots move to the slide's foot`))
            if (id === 'agents' || id === 'short') check(() => assert.equal(m.dots, 'band', `${where}: cards that fit keep the dots under them`))
            if (id === 'short') check(() => assert.equal(m.zoom, '', `${where}: cards that fit are not zoomed`))
            if (id === 'short' && look === 'ocean') check(() => assert.equal(m.look, 'ocean', `${where}: cards that fit keep the Ocean look`))
          }
        }
        // Steps 3 and 4 of the fit: the look's fall-back (Ocean) and the zoom.
        {
          const plainPath = join(dir, `${look}-plain.md`)
          const plainText = look === 'ocean' ? plainOutline : inClassicLook(plainOutline)
          writeFileSync(plainPath, plainText)
          const plain = await prepareSource(plainPath, plainText, `carousel-zoom-${look}`, statSync(plainPath))
          const plainHtml = join(dir, `${look}-plain.html`)
          writeFileSync(plainHtml, String(plain.fullHtml))
          await page.goto('about:blank')
          await page.goto(`${pathToFileURL(plainHtml).href}#zoom`, { waitUntil: 'load' })
          await page.evaluate(() => document.fonts?.ready)
          await page.waitForTimeout(600)
          const z = await page.evaluate(() => {
            const slide = document.querySelector('#stage > .slide.active')
            const content = slide.querySelector(':scope > .slide-content')
            const inner = slide.querySelector('.card.carousel-subslide.active-card > .slide-content')
            const kids = [...inner.querySelectorAll('*')].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0)
            const nav = content.querySelector(':scope > .gallery-nav').getBoundingClientRect()
            const head = content.querySelector(':scope > .slide-head').getBoundingClientRect()
            return { look: slide.dataset.look || '', zoom: Number(content.style.zoom || 1), fit: content.dataset.textFit || '', top: Math.min(...kids.map((k) => k.top)), bottom: Math.max(...kids.map((k) => k.bottom)), navTop: nav.top, headBottom: head.bottom }
          })
          const where = `${look} ${viewport.width} zoom (${JSON.stringify({ look: z.look, zoom: z.zoom, fit: z.fit })})`
          if (look === 'ocean') check(() => assert.equal(z.look, 'ocean-safe', `${where}: a card that needs more than its band makes the slide fall back from the Ocean look`))
          check(() => assert(z.zoom < 1 && z.fit === '', `${where}: the whole-slide zoom fits what the band cannot hold`))
          check(() => assert(z.bottom <= z.navTop + 1 && z.top >= z.headBottom - 1, `${where}: the zoomed card sits between the slide title and the dots`))
        }
        // The dots take their own clicks with the deck's control bar showing: in the band, and in the slide's foot.
        for (const id of ['agents', 'long']) {
          await page.goto('about:blank')
          await page.goto(`${pathToFileURL(htmlPath).href}#${id}`, { waitUntil: 'load' })
          await page.waitForTimeout(500)
          await page.mouse.move(viewport.width / 2, viewport.height / 2)
          await page.mouse.move(viewport.width / 2 + 5, viewport.height / 2 + 5)
          await page.waitForTimeout(450)
          const hit = await page.evaluate(() => {
            const slide = document.querySelector('#stage > .slide.active')
            const dot = slide.querySelectorAll('.gallery-nav .gallery-dot')[1]
            const r = dot.getBoundingClientRect()
            const x = r.left + r.width / 2, y = r.top + r.height / 2
            const at = document.elementFromPoint(x, y)
            const bar = document.querySelector('footer.footer').getBoundingClientRect()
            return { x, y, at: at ? `${at.tagName}.${String(at.className).slice(0, 40)}#${at.id}` : '', own: Boolean(at && (at === dot || dot.contains(at))), barShown: !document.body.classList.contains('chrome-idle'), navBottom: slide.querySelector('.gallery-nav').getBoundingClientRect().bottom, barTop: bar.top }
          })
          const where = `${look} ${viewport.width} ${id}`
          check(() => assert(hit.barShown, `${where}: the control bar is showing for the hit test`))
          check(() => assert(hit.own && hit.navBottom <= hit.barTop + 1, `${where}: the second dot is under the pointer, clear of the control bar (dots end ${hit.navBottom.toFixed(1)}, bar starts ${hit.barTop.toFixed(1)}; under the pointer: ${hit.at})`))
          await page.mouse.click(hit.x, hit.y)
          await page.waitForTimeout(300)
          const counter = await page.evaluate(() => document.querySelector('#stage > .slide.active .gallery-counter')?.textContent.trim())
          check(() => assert(/^2 \//.test(counter || ''), `${where}: clicking the second dot shows the second card (${counter})`))
        }
        // A side-title carousel draws as in 0.44: the slide's min-height still holds the card, the dots do not move into
        // the foot, and the gallery and the dots stay put from card to card.
        for (const [id, count] of SIDE) {
          await page.goto('about:blank')
          await page.goto(`${pathToFileURL(htmlPath).href}#${id}`, { waitUntil: 'load' })
          await page.waitForTimeout(500)
          const seen = []
          for (let card = 0; card < count; card += 1) {
            if (card) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(400) }
            seen.push(await page.evaluate(() => {
              const slide = document.querySelector('#stage > .slide.active')
              const content = slide.querySelector(':scope > .slide-content')
              const inner = slide.querySelector('.card.carousel-subslide.active-card > .slide-content')
              const g = content.querySelector(':scope > .card-gallery').getBoundingClientRect()
              const n = content.querySelector(':scope > .gallery-nav').getBoundingClientRect()
              return { layout: slide.dataset.titleLayout, minH: getComputedStyle(inner).minHeight, dots: content.dataset.carouselDots || 'band', zoom: content.style.zoom || '', gallery: [Math.round(g.top), Math.round(g.bottom)], nav: Math.round(n.top) }
            }))
          }
          const where = `${look} ${viewport.width} ${id}`
          check(() => assert(seen.every((m) => m.layout !== 'top'), `${where}: the title is beside the cards (${seen[0].layout})`))
          check(() => assert(seen.every((m) => m.minH !== '0px' && m.dots === 'band'), `${where}: the card keeps the slide's min-height and the dots stay under the gallery (${JSON.stringify(seen.map((m) => [m.minH, m.dots]))})`))
          check(() => assert(seen.every((m) => m.nav === seen[0].nav && m.gallery.join() === seen[0].gallery.join()), `${where}: the gallery and the dots stay put from card to card (${JSON.stringify(seen.map((m) => [m.gallery, m.nav]))})`))
        }
      } finally {
        await page.close()
      }
    }
  }
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`carousel-dots-dom: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`)
  process.exit(1)
}
console.log('carousel-dots-dom: ok (7 top-title carousels and a side-title one, Ocean and classic, 1280 and 1600 wide, dots clicked with the control bar showing)')
