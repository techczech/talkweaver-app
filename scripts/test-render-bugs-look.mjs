// =============================================================================
// test:render-bugs-look — 0.37 slide design round 2, ticket 10 (two slides that rendered wrongly)
//
//   1. A statement slide with a screenshot ("Codex", {statement}). The image took the whole content
//      column at its natural height and pushed the caption paragraph below the slide edge (the deck
//      fit pass then shrank the whole slide to 0.81 and still lost it). At 1920x1080 the title, the
//      image and the caption must all lie inside the slide, the image unclipped and un-zoomed.
//   2. A carousel with nothing to step through ("Chatbot vs agent", {contrast}{notitle} {carousel}
//      over a heading with no blocks). It rendered fully blank, with no word about it. The compiler
//      now says so (carousel-empty) and the heading shows. A carousel WITH content still opens on
//      its first sub-slide (guard).
// Read from a real compiled deck in headless Chromium.
// =============================================================================

import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const dir = mkdtempSync(join(tmpdir(), 'render-bugs-'))

// A 1600x1300 screenshot-shaped PNG (solid grey, with a darker frame) — taller than the column.
function png(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.alloc(1 + width * 3, 0xd0)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const imgPath = join(dir, 'screenshot.png')
writeFileSync(imgPath, png(1600, 1300))

const outline = [
  '---', 'title: Render bugs probe', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## Bugs', '',
  '### Codex', '{statement}{id=shot-statement}', `![The Codex desktop app](${imgPath})`, 'Codex is now a ChatGPT Desktop App', '',
  '### Codex notitle', '{statement}{notitle}{id=shot-notitle}', `![The Codex desktop app](${imgPath})`, 'Codex is now a ChatGPT Desktop App', '',
  '### Chatbot vs agent', '{contrast}{notitle}{id=empty-carousel} {carousel}', '',
  '### Two steps', '{notitle}{id=full-carousel} {carousel}', '', 'First step', '', 'Second step', ''
].join('\n')
const outlinePath = join(dir, 'render-bugs-outline.md')
writeFileSync(outlinePath, outline)
const model = await prepareSource(outlinePath, outline, 'render-bugs', statSync(outlinePath))
assert.ok(model.warnings.some((w) => w.startsWith('carousel-empty:empty-carousel')), 'an empty carousel is reported: ' + JSON.stringify(model.warnings))
assert.ok(!model.warnings.some((w) => w.startsWith('carousel-empty:full-carousel')), 'a carousel with content is not')
const htmlPath = join(dir, 'deck.html')
writeFileSync(htmlPath, String(model.fullHtml))

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await page.goto(`file://${htmlPath}`, { waitUntil: 'load' })
await page.evaluate(() => document.fonts?.ready)
await page.waitForTimeout(800)

async function show(id) {
  await page.evaluate((target) => { location.hash = target; window.dispatchEvent(new HashChangeEvent('hashchange')) }, id)
  await page.waitForFunction((target) => document.querySelector('#stage > .slide.active')?.dataset.id === target, id)
  await page.evaluate(() => Promise.all([...document.querySelectorAll('.slide.active img')].map((i) => i.decode?.().catch(() => {}))))
  await page.waitForTimeout(300)
}
const inside = (r, label) => {
  const slop = 1
  assert.ok(r.top >= -slop && r.left >= -slop && r.bottom <= 1080 + slop && r.right <= 1920 + slop,
    `${label} lies inside the 1920x1080 slide, got ${JSON.stringify(r)}`)
}
const rectOf = (selector) => page.evaluate((sel) => {
  const el = document.querySelector(`#stage > .slide.active ${sel}`)
  if (!el) return null
  const b = el.getBoundingClientRect()
  return { top: b.top, left: b.left, bottom: b.bottom, right: b.right, width: b.width, height: b.height }
}, selector)

for (const id of ['shot-statement', 'shot-notitle']) {
  await show(id)
  const img = await rectOf('.slide-figure img')
  const caption = await rectOf('.slide-content > p')
  assert.ok(img && caption, `${id}: image and caption are drawn`)
  inside(img, `${id} image`)
  inside(caption, `${id} caption`)
  assert.ok(img.bottom <= caption.top + 1, `${id}: the caption sits below the image, not over it`)
  assert.ok(img.width > 300 && img.height > 300, `${id}: the image keeps a usable size, got ${img.width}x${img.height}`)
  const zoom = await page.evaluate(() => document.querySelector('#stage > .slide.active > .slide-content').style.zoom)
  assert.ok(zoom === '' || Number(zoom) === 1, `${id}: no whole-slide zoom is needed, got ${zoom}`)
  if (id === 'shot-statement') inside(await rectOf('h1'), 'the rail title')
  const scroll = await page.evaluate(() => { const c = document.querySelector('#stage > .slide.active > .slide-content'); return c.scrollHeight - c.clientHeight })
  assert.ok(scroll <= 1, `${id}: the content column does not overflow (by ${scroll}px)`)
}
console.log('PASS statement with a screenshot: image, caption and title inside the slide, unclipped')

await show('empty-carousel')
const emptyTitle = await rectOf('h1:not(.sr-only)')
assert.ok(emptyTitle && emptyTitle.width > 50, 'an empty carousel shows its heading rather than a blank slide')
inside(emptyTitle, 'the empty carousel heading')
console.log('PASS empty carousel: warned about, heading shown')

await show('full-carousel')
const first = await page.evaluate(() => {
  const subs = [...document.querySelectorAll('#stage > .slide.active .carousel-subslide')]
  const one = subs[0]
  return { count: subs.length, active: one?.classList.contains('active-card'), display: one && getComputedStyle(one).display, height: one?.getBoundingClientRect().height }
})
assert.equal(first.count, 2)
assert.ok(first.active && first.display !== 'none' && first.height > 100, 'the first sub-slide is visible on arrival: ' + JSON.stringify(first))
console.log('PASS carousel with content: first sub-slide visible on arrival')

await browser.close()
