// =============================================================================
// test:carousel-item-look — GitHub #127: a {carousel} item shows its content the way the same
// content shows on a slide of its own.
//
//   a. An item with a line of text and a 1500x844 picture: the picture's column takes the item's
//      band (>= 40% of the item's height) and the picture is not clipped by it.
//   b. An item led by bold text draws the boxed chip like an ordinary statement (bold is inline,
//      its colour differs from its background) and its paragraphs carry no accent bar.
//   c. An item with a picture and a link line, and an item with only a picture, keep working.
//   d. Ordinary slides (text + picture, picture + link, picture only, bold-led statement) measure
//      what they measured before the change; the numbers were recorded on the unchanged tree
//      (HEAD of next/0.39) at 1280x720 with this same outline.
// Read from a real compiled deck in headless Chromium.
// =============================================================================

import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const dir = mkdtempSync(join(tmpdir(), 'carousel-item-'))

function png(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.alloc(1 + width * 3, 0xd0)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const wide = join(dir, 'wide.png'); writeFileSync(wide, png(1500, 844))
const shot = join(dir, 'shot.png'); writeFileSync(shot, png(1147, 523))

const outline = [
  // 0.41 ticket 02: the index tab is the default title look; the recorded numbers below are under the plain title.
  '---', 'title: Carousel item probe', 'auto_title_slide: false', 'auto_thanks_slide: false', 'title_look: full', '---', '',
  '# Probe', '', '## Section', '',
  '### About me', '{id=car} {carousel}', '',
  '#### My work', '', '**Alexis Rivera**', '[rivera-works.org](https://rivera-works.org)', '', 'Riverside Learning Hub', 'Northfield Colleges', '',
  '#### What I used to do', '', 'Reading and Writing Innovation Lab', `![](${wide})`, '',
  '#### AI Trends Tracking', '', `![](${shot})`, '[ainewsroundup.pages.dev](https://ainewsroundup.pages.dev)', '',
  '#### Only picture', '', `![](${wide})`, '',
  '### My work', '{id=ord-bold}', '', '**Alexis Rivera**', '[rivera-works.org](https://rivera-works.org)', '', 'Riverside Learning Hub', 'Northfield Colleges', '',
  '### What I used to do', '{id=ord-pic}', '', 'Reading and Writing Innovation Lab', `![](${wide})`, '',
  '### AI Trends Tracking', '{id=ord-link}', '', `![](${shot})`, '[ainewsroundup.pages.dev](https://ainewsroundup.pages.dev)', '',
  '### Only picture', '{id=ord-only}', '', `![](${wide})`, ''
].join('\n')
const outlinePath = join(dir, 'outline.md')
writeFileSync(outlinePath, outline)
const model = await prepareSource(outlinePath, outline, 'carousel-item', statSync(outlinePath))
const htmlPath = join(dir, 'deck.html')
writeFileSync(htmlPath, String(model.fullHtml))

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
await page.goto(`file://${htmlPath}`, { waitUntil: 'load' })
await page.evaluate(() => document.fonts?.ready)
await page.waitForTimeout(600)

async function show(id) {
  await page.evaluate((target) => { location.hash = target; window.dispatchEvent(new HashChangeEvent('hashchange')) }, id)
  await page.waitForFunction((target) => document.querySelector('#stage > .slide.active')?.dataset.id === target, id)
  await page.evaluate(() => Promise.all([...document.querySelectorAll('.slide.active img')].map((i) => i.decode?.().catch(() => {}))))
  await page.waitForTimeout(300)
}
const rects = (selector) => page.evaluate((sel) => [...document.querySelectorAll(`#stage > .slide.active ${sel}`)]
  .filter((el) => getComputedStyle(el).display !== 'none' && !el.closest('.carousel-subslide:not(.active-card)'))
  .map((el) => { const b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] }), selector)

// --- carousel items -----------------------------------------------------------------------
await show('car')
const items = []
for (let i = 0; i < 4; i += 1) {
  items.push(await page.evaluate(() => {
    const item = document.querySelector('#stage > .slide.active .carousel-subslide.active-card')
    const box = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height } }
    const strong = item.querySelector('.content-p strong')
    const sc = strong && getComputedStyle(strong)
    const par = item.querySelector('.content-p')
    return {
      item: box(item),
      media: item.querySelector('.slot-media') && box(item.querySelector('.slot-media')),
      img: item.querySelector('img') && box(item.querySelector('img')),
      imgNatural: item.querySelector('img') && [item.querySelector('img').naturalWidth, item.querySelector('img').naturalHeight],
      strong: strong && { display: sc.display, color: sc.color, bg: sc.backgroundColor, w: strong.getBoundingClientRect().width, parentW: strong.parentElement.getBoundingClientRect().width },
      bars: [...item.querySelectorAll('.content-p')].map((p) => getComputedStyle(p).borderLeftWidth),
      parBar: par && getComputedStyle(par).borderLeftWidth
    }
  }))
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(400)
}
const [bold, text, link, only] = items

// b. bold-led item
assert.ok(bold.strong, 'the bold-led item has a bold run')
assert.notEqual(bold.strong.display, 'block', `bold is not display:block, got ${bold.strong.display}`)
assert.ok(bold.strong.w < bold.strong.parentW - 20, `bold is not full width (${bold.strong.w} of ${bold.strong.parentW})`)
assert.notEqual(bold.strong.color, bold.strong.bg, `bold text colour differs from its background (${bold.strong.color} on ${bold.strong.bg})`)
assert.ok(bold.bars.every((b) => parseFloat(b) === 0), `a statement item's paragraphs carry no accent bar, got ${bold.bars}`)
console.log('PASS bold-led item: inline boxed chip, readable colours, no left bars')

// a. text + picture item
const inside = (inner, outer, label) => assert.ok(inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1 && inner.left >= outer.left - 1 && inner.right <= outer.right + 1, `${label} lies inside its box`)
for (const [name, it] of [['text + picture', text], ['picture + link', link]]) {
  assert.ok(it.media && it.img, `${name}: picture drawn`)
  assert.ok(it.media.h >= 0.4 * it.item.h, `${name}: media column is at least 40% of the item (${Math.round(it.media.h)} of ${Math.round(it.item.h)})`)
  inside(it.img, it.media, `${name} picture`)
  const natural = it.imgNatural[0] / it.imgNatural[1]
  assert.ok(Math.abs(it.img.w / it.img.h - natural) < 0.02, `${name}: picture keeps its aspect (${it.img.w}x${it.img.h})`)
  assert.ok(it.img.h > 100, `${name}: picture is not a strip (${it.img.h}px high)`)
}
console.log('PASS text + picture and picture + link items: media column fills the band, picture unclipped')

// c. picture-only item (fine before; stays fine)
assert.ok(only.img && only.img.h > 200 && Math.abs(only.img.w / only.img.h - 1500 / 844) < 0.02, `picture-only item shows the whole picture (${only.img?.w}x${only.img?.h})`)
console.log('PASS picture-only item unchanged')

// d. ordinary slides, values recorded on the tree as built (the ord-bold fixture text was replaced by invented text for the public copy, so its rects were re-recorded)
const expected = {
  'ord-pic': { '.slot': [[72, 155, 1137, 504]], '.slot-media': [[72, 155, 432, 504]], '.slot-copy': [[549, 352, 659, 110]], img: [[72, 286, 432, 243]] },
  'ord-link': { '.slot': [[72, 155, 1137, 504]], '.slot-media': [[72, 155, 432, 504]], '.slot-copy': [[549, 380, 659, 55]], img: [[72, 309, 432, 197]] },
  'ord-only': { img: [[178, 140, 923, 519]] },
  // 0.41 ticket 04 (ADR-0039): an ordinary statement carries the accent bar and its gap, so its paragraphs are wider and the second wraps to more lines.
  'ord-bold': { '.content-p': [[563, 249, 599, 61], [563, 311, 599, 160]] }
}
for (const [id, checks] of Object.entries(expected)) {
  await show(id)
  for (const [sel, want] of Object.entries(checks)) {
    const got = await rects(sel)
    assert.deepEqual(got, want, `${id} ${sel} measures as before the change: ${JSON.stringify(got)}`)
  }
}
await show('ord-bold')
const ordBold = await page.evaluate(() => { const s = document.querySelector('#stage > .slide.active .content-p strong'); const c = getComputedStyle(s); return { display: c.display, color: c.color, bg: c.backgroundColor } })
assert.equal(ordBold.display, 'inline', 'ordinary statement bold is inline')
assert.equal(ordBold.color, 'rgb(253, 253, 251)', 'ordinary statement bold is paper-coloured')
assert.notEqual(ordBold.color, ordBold.bg, 'ordinary statement chip is readable')
assert.equal(bold.strong.color, ordBold.color, 'a carousel item chip uses the ordinary statement text colour')
assert.equal(bold.strong.display, ordBold.display, 'a carousel item chip uses the ordinary statement display')
console.log('PASS ordinary text + picture, picture + link, picture-only and statement slides measure as before')

await browser.close()
