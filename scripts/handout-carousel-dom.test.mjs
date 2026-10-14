// Carousels in the HTML handout, in Chromium at 1280 and 390 wide. The handout is built the way the Download
// handout is (scripts/lib/handout-carousel-fixture.mjs: carousels of 3, 2, 2 and 2 items between plain slides).
//  1. Controls (desktop and phone): previous and next buttons, one dot per item, "1 / 3", labelled, dots at least
//     12px with a 32px hit area (44px on touch), visible focus, below the slide and never over it, gone on a slide
//     with no carousel; a talk with no carousel carries none of the markup.
//  2. Stepping in the ordinary mode, in Reveal and in Focus: Next, Previous and the arrow keys walk the items
//     before leaving the slide, both ways; coming back with Previous opens the first item (as before).
//  3. Buttons and dots step it; on the phone a horizontal swipe on the stage steps it and the text under the stage
//     still holds every item.
// HANDOUT_CAROUSEL_SHOTS_DIR keeps pictures of the carousel at both sizes.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { buildCarouselHandout, CAROUSEL_WORDS } from './lib/handout-carousel-fixture.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tw-handout-carousel-'))
const shots = process.env.HANDOUT_CAROUSEL_SHOTS_DIR ? resolve(process.env.HANDOUT_CAROUSEL_SHOTS_DIR) : ''
if (shots) mkdirSync(shots, { recursive: true })
const { htmlPath } = await buildCarouselHandout(dir, 'carousel')
const plain = await buildCarouselHandout(dir, 'plain', {}, '# Plain\n\n## S\n\n### One {id=one}\n{statement}\n\nJust a statement.\n')
const venue = await buildCarouselHandout(dir, 'venue', { venue: true })
const url = (path, id) => `${pathToFileURL(path).href}#${id}`
const browser = await chromium.launch({ headless: true })

const state = (page) => page.evaluate(() => {
  const slide = document.querySelector('.slide.active')
  const bar = document.getElementById('carouselBar')
  const shown = [...document.querySelectorAll('.slide.active .card.carousel-subslide')].filter((el) => getComputedStyle(el).display !== 'none')
  return {
    id: slide && slide.dataset.id,
    shown: shown.map((el) => el.textContent.replace(/\s+/g, ' ').trim()),
    counter: bar && !bar.hidden ? bar.querySelector('.car-count').textContent : null,
    bar: Boolean(bar && !bar.hidden)
  }
})
// A fresh load each time: going to the same address with only the hash changed would not reload the page.
const open = async (page, id) => { await page.goto('about:blank'); await page.goto(url(htmlPath, id), { waitUntil: 'load' }); await page.waitForTimeout(500) }
const step = async (page, key) => { await key(); await page.waitForTimeout(120) }

async function controls(page, label, touch) {
  const bar = await page.evaluate(() => {
    const bar = document.getElementById('carouselBar')
    const box = (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right } }
    const dot = bar.querySelector('.car-dot')
    const before = getComputedStyle(dot, '::before')
    const slideRect = document.getElementById('stage').querySelector('.slide.active').getBoundingClientRect()
    return {
      barBox: box(bar), prev: box(bar.querySelector('.car-prev')), next: box(bar.querySelector('.car-next')),
      prevLabel: bar.querySelector('.car-prev').getAttribute('aria-label'), nextLabel: bar.querySelector('.car-next').getAttribute('aria-label'),
      dotLabels: [...bar.querySelectorAll('.car-dot')].map((d) => d.getAttribute('aria-label')),
      dotBox: box(dot), dotDraw: parseFloat(before.width), counterFont: parseFloat(getComputedStyle(bar.querySelector('.car-count')).fontSize),
      slideBottom: slideRect.bottom, innerWidth, innerHeight
    }
  })
  assert.deepEqual(bar.dotLabels, ['Item 1 of 3', 'Item 2 of 3', 'Item 3 of 3'], `${label}: dot labels`)
  assert.equal(bar.prevLabel, 'Previous item', `${label}: previous label`)
  assert.equal(bar.nextLabel, 'Next item', `${label}: next label`)
  assert(bar.dotDraw >= 12, `${label}: dots are at least 12px (${bar.dotDraw})`)
  const hit = touch ? 44 : 32
  assert(bar.dotBox.w >= hit && bar.dotBox.h >= hit, `${label}: dot hit area at least ${hit}px (${bar.dotBox.w}x${bar.dotBox.h})`)
  for (const side of ['prev', 'next']) assert(bar[side].w >= hit - 8 && bar[side].h >= hit - 8, `${label}: ${side} button is large enough (${bar[side].w}x${bar[side].h})`)
  assert(bar.counterFont >= 13, `${label}: the counter is legible (${bar.counterFont}px)`)
  assert(bar.slideBottom <= bar.barBox.top + 1, `${label}: the bar sits below the slide (slide ends ${bar.slideBottom}, bar starts ${bar.barBox.top})`)
  assert(bar.barBox.left >= 0 && bar.barBox.right <= bar.innerWidth + 1, `${label}: the bar is inside the window`)
  assert(bar.barBox.bottom <= bar.innerHeight, `${label}: the bar is on screen`)
  // Nothing covers the controls: the element at each control's centre is the control.
  const covered = await page.evaluate(() => [...document.querySelectorAll('#carouselBar button')].filter((b) => { const r = b.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !(at && (at === b || b.contains(at))) }).length)
  assert.equal(covered, 0, `${label}: no control is covered by anything`)
  // Keyboard: Tab reaches the next button and it shows a focus ring.
  await page.evaluate(() => document.querySelector('#carouselBar .car-prev').focus())
  for (let i = 0; i < 6; i += 1) {
    const on = await page.evaluate(() => document.activeElement.classList.contains('car-next'))
    if (on) break
    await page.keyboard.press('Tab')
  }
  const ring = await page.evaluate(() => { const el = document.activeElement; const cs = getComputedStyle(el); return { next: el.classList.contains('car-next'), style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) } })
  assert(ring.next && ring.style !== 'none' && ring.width >= 2, `${label}: keyboard focus reaches Next with a visible ring (${JSON.stringify(ring)})`)
}

try {
  // ---- Desktop -------------------------------------------------------------------------------------------
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await open(page, 'para-car')
  const P = CAROUSEL_WORDS.paragraph
  assert.deepEqual(await state(page), { id: 'para-car', shown: [P[0]], counter: '1 / 3', bar: true }, 'desktop: opens on item 1 with the bar')
  await controls(page, 'desktop', false)
  if (shots) { await open(page, 'para-car'); await page.screenshot({ path: join(shots, 'carousel-1280.png') }) }

  // Ordinary mode: Next and the arrow keys, both ways, then out of the slide.
  await open(page, 'para-car')
  await step(page, () => page.click('#nextBtn'))
  assert.deepEqual((await state(page)).shown, [P[1]], 'Next steps to item 2')
  await step(page, () => page.keyboard.press('ArrowRight'))
  assert.deepEqual((await state(page)).shown, [P[2]], 'ArrowRight steps to item 3')
  await step(page, () => page.keyboard.press('ArrowLeft'))
  assert.deepEqual((await state(page)).shown, [P[1]], 'ArrowLeft steps back to item 2')
  await step(page, () => page.click('#prevBtn'))
  assert.deepEqual((await state(page)).shown, [P[0]], 'Previous steps back to item 1')
  await step(page, () => page.keyboard.press('ArrowRight')); await step(page, () => page.keyboard.press('ArrowRight'))
  await step(page, () => page.keyboard.press('ArrowRight'))
  assert.deepEqual(await state(page), { id: 'head-car', shown: [CAROUSEL_WORDS.heading[0]].map((w) => `First heading item ${w}`), counter: '1 / 2', bar: true }, 'past the last item the next slide opens (its own carousel, item 1)')
  await step(page, () => page.keyboard.press('ArrowLeft'))
  assert.deepEqual(await state(page), { id: 'para-car', shown: [P[0]], counter: '1 / 3', bar: true }, 'Previous from the next slide opens the first item (as before)')

  // The bar's own buttons and dots.
  await step(page, () => page.click('#carouselBar .car-next'))
  assert.equal((await state(page)).counter, '2 / 3', 'the bar Next steps')
  await step(page, () => page.click('#carouselBar .car-dot:nth-child(3)'))
  assert.deepEqual((await state(page)).shown, [P[2]], 'a dot opens its item')
  assert.equal(await page.evaluate(() => document.querySelector('#carouselBar .car-next').getAttribute('aria-disabled')), 'true', 'Next is dimmed on the last item')
  await step(page, () => page.click('#carouselBar .car-prev'))
  assert.equal((await state(page)).counter, '2 / 3', 'the bar Previous steps')

  // Reveal and Focus: the same stepping.
  for (const [mode, toggle] of [['Reveal', () => page.click('#revealBtn')], ['Focus', () => page.keyboard.press('f')]]) {
    await open(page, 'para-car')
    await step(page, toggle)
    await step(page, () => page.click('#nextBtn'))
    assert.deepEqual((await state(page)).shown, [P[1]], `${mode}: the Next button steps to item 2`)
    await step(page, () => page.keyboard.press('ArrowRight'))
    assert.deepEqual((await state(page)).shown, [P[2]], `${mode}: ArrowRight steps to item 3`)
    await step(page, () => page.keyboard.press('ArrowLeft'))
    assert.deepEqual((await state(page)).shown, [P[1]], `${mode}: ArrowLeft steps back`)
    await step(page, () => page.click('#prevBtn'))
    assert.deepEqual((await state(page)).shown, [P[0]], `${mode}: the Previous button steps back`)
    await step(page, () => page.keyboard.press('ArrowRight')); await step(page, () => page.keyboard.press('ArrowRight'))
    assert.equal((await state(page)).id, 'para-car', `${mode}: still on the carousel at its last item`)
    await step(page, () => page.keyboard.press('ArrowRight'))
    assert.equal((await state(page)).id, 'head-car', `${mode}: past the last item the next slide opens`)
    await step(page, () => page.keyboard.press('ArrowLeft'))
    assert.deepEqual(await state(page), { id: 'para-car', shown: [P[0]], counter: '1 / 3', bar: true }, `${mode}: Previous from the next slide opens item 1`)
  }

  // No bar off a carousel.
  await open(page, 'opening')
  assert.equal((await state(page)).bar, false, 'a plain slide shows no carousel bar')
  await open(page, 'tall-car')
  await step(page, () => page.keyboard.press('ArrowRight'))
  assert.equal((await state(page)).counter, '2 / 2', 'tall carousel steps')
  assert.deepEqual(errors, [], 'no page errors on desktop')

  // A talk with no carousel: no bar markup, and the venue screen keeps its in-slide dots instead of the bar.
  const pagePlain = await browser.newPage({ viewport: { width: 1280, height: 760 } })
  await pagePlain.goto(url(plain.htmlPath, 'one'), { waitUntil: 'load' }); await pagePlain.waitForTimeout(300)
  assert.equal(await pagePlain.evaluate(() => document.querySelectorAll('#carouselBar, .gallery-nav, .carousel-print-page').length), 0, 'a talk with no carousel has no carousel markup')
  await pagePlain.close()
  const pageVenue = await browser.newPage({ viewport: { width: 1280, height: 760 } })
  const venueErrors = []
  pageVenue.on('pageerror', (e) => venueErrors.push(e.message))
  await pageVenue.goto(url(venue.htmlPath, 'para-car'), { waitUntil: 'load' }); await pageVenue.waitForTimeout(400)
  assert.equal(await pageVenue.evaluate(() => document.getElementById('carouselBar')), null, 'the venue screen builds no carousel bar')
  assert.deepEqual(venueErrors, [], 'the venue build loads without errors')
  await pageVenue.close()
  await page.close()

  // ---- Phone ---------------------------------------------------------------------------------------------
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const phone = await ctx.newPage()
  const phoneErrors = []
  phone.on('pageerror', (e) => phoneErrors.push(e.message))
  await phone.goto(url(htmlPath, 'para-car'), { waitUntil: 'load' }); await phone.waitForTimeout(700)
  assert.equal(await phone.evaluate(() => document.body.classList.contains('phone-detail-mode')), true, 'phone: the slide is open with its stage')
  assert.deepEqual(await state(phone), { id: 'para-car', shown: [P[0]], counter: '1 / 3', bar: true }, 'phone: the bar shows')
  await controls(phone, 'phone', true)
  const script = await phone.evaluate(() => document.getElementById('phoneScript').textContent)
  for (const word of P) assert(script.includes(word.replace('.', '')), `phone: the text under the stage still holds "${word}"`)
  await phone.goto(url(htmlPath, 'para-car'), { waitUntil: 'load' }); await phone.waitForTimeout(500)
  if (shots) await phone.screenshot({ path: join(shots, 'carousel-390.png') })
  await phone.tap('#carouselBar .car-next'); await phone.waitForTimeout(150)
  assert.equal((await state(phone)).counter, '2 / 3', 'phone: tapping Next steps')
  await phone.tap('#carouselBar .car-dot:nth-child(1)'); await phone.waitForTimeout(150)
  assert.equal((await state(phone)).counter, '1 / 3', 'phone: tapping a dot opens its item')
  // Swipe on the stage: left steps forward, right steps back; a mostly vertical drag does nothing.
  const cdp = await ctx.newCDPSession(phone)
  const box = await phone.evaluate(() => { const r = document.getElementById('stageFit').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })
  const swipe = async (dx, dy) => {
    const x = box.x + box.w / 2, y = box.y + box.h / 2
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx / 2, y: y + dy / 2 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx, y: y + dy }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await phone.waitForTimeout(150)
  }
  await swipe(-120, 0)
  assert.equal((await state(phone)).counter, '2 / 3', 'phone: a swipe left steps forward')
  await swipe(120, 0)
  assert.equal((await state(phone)).counter, '1 / 3', 'phone: a swipe right steps back')
  await swipe(120, 0)
  assert.equal((await state(phone)).counter, '1 / 3', 'phone: a swipe right on item 1 stays on the carousel')
  await swipe(-30, 90)
  assert.equal((await state(phone)).counter, '1 / 3', 'phone: a mostly vertical drag does not step')
  assert.deepEqual(phoneErrors, [], 'no page errors on the phone')
  console.log('handout carousel: controls sized and labelled at 1280 and 390, Next/Previous/arrows step in ordinary, Reveal and Focus, dots, buttons and swipe work, no carousel markup in a plain talk')
} finally {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
}
