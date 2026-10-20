// =============================================================================
// test:cards-look — 0.41 ticket 09 (ADR-0039: cards in the animated-scene design)
//
// What must hold, measured in Chromium on the 1280 x 720 stage:
//   1. `{cards}` (three cards of three points, and five points with one wrapping) and the box form of an icon list and of a
//      numbered list: each card is a subtle box in its own hue (the section accent, then --hue-2, then --hue-3); its title
//      row is a tinted chip (68/1920 of the width, the icon inside it) and a regular-weight ink title over a rule
//      in the hue; the points are highlight rows with no bullet, regular weight, at least the type floor; the only icon of a
//      card is the chip's; card height follows content (the cards align at their tops and a short card is not stretched).
//   2. Reveal (the presenter runtime): R then the right arrow steps one POINT at a time. A card is hidden until its first
//      point arrives; step n shows exactly n points; the last step shows everything. The handout (buildShareHtml) shows
//      every point, and its MODE_SELECTOR enumerates the same units in the same order (also guarded by
//      test:mode-selector-parity and test:reveal-cross-runtime).
//   3. Compiler: a card of points carries `.card-points`; a card of label groups keeps the old look (no `.card-points`);
//      a box card with points carries `.fl-card-pts` and is not itself a reveal unit.
// =============================================================================

import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tw-cards-'))
const points = (n, extra = []) => [...['Search and note', 'Draft and summarise', 'Organise and help', ...extra].slice(0, n)]
const card = (title, icon, pts) => [`- ${title} ${icon}`, ...pts.map((p) => `  - ${p}`)]
const THREE = [
  ...card('Personal assistant', '{icon=lucide:user}', points(3)),
  ...card('Tool for research', '{icon=lucide:wrench}', ['Write software', 'Code text', 'Ideation and checking']),
  ...card('Subject of research', '{icon=lucide:brain}', ['How models work', 'Training / finetuning', 'Impact of use']),
]
const LONG = [
  ...card('Personal assistant', '{icon=lucide:user}', points(5, ['Plan the week and keep track of deadlines', 'Translate and explain'])),
  ...card('Tool for research', '{icon=lucide:wrench}', ['Write software', 'Code text', 'Ideation and checking', 'Clean and reshape data', 'Find and compare sources']),
  ...card('Subject of research', '{icon=lucide:brain}', ['How models work', 'Training / finetuning', 'Impact of use', 'Bias and evaluation', 'Policy and governance']),
]
const source = [
  '---', 'title: Cards look', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '# Deck', '## Section', '',
  '### Cards', '{cards} {iconlist} {id=cards}', '', ...THREE, '',
  '### Cards long', '{cards} {iconlist} {id=cards-long}', '', ...LONG, '',
  '### Boxes', '{iconlist=boxes} {id=boxes}', '', ...THREE, '',
  '### Numbered', '{numbered} {iconlist=boxes} {id=numbered}', '', '1. First', '  - One', '  - Two', '2. Second', '  - Three', '  - Four', '3. Third', '  - Five', '  - Six', '',
  '### Label card', '{cards} {id=label-card}', '', '- Oracle', '  - Capabilities: answer questions', '  - Chatbots: ChatGPT, Gemini', '- Maker', '  - Capabilities: write code', '  - Tools: Cursor', ''
].join('\n')
const path = join(dir, 'cards.md')
writeFileSync(path, source, 'utf8')
const model = await prepareSource(path, source, 'Cards look', statSync(path))
const deckPath = join(dir, 'cards.html')
writeFileSync(deckPath, model.fullHtml, 'utf8')

let checks = 0
const check = (name, fn) => Promise.resolve(fn()).then(() => { checks += 1; console.log(`PASS ${name}`) })

const FORMS = {
  cards: { card: '.card-gallery.card-grid > .card.card-points', chip: ':scope > .card-icon', title: ':scope > h4', pts: ':scope > .feature-list > li', n: [3, 3, 3] },
  'cards-long': { card: '.card-gallery.card-grid > .card.card-points', chip: ':scope > .card-icon', title: ':scope > h4', pts: ':scope > .feature-list > li', n: [5, 5, 5] },
  boxes: { card: '.slide-content > .feature-list.fl-cards > li', chip: ':scope > .fl-icon', title: ':scope > .fl-text', pts: ':scope > .fl-sublist > li', n: [3, 3, 3] },
  numbered: { card: '.slide-content > .feature-list.fl-cards > li', chip: ':scope > .fl-icon', title: ':scope > .fl-text', pts: ':scope > .fl-sublist > li', n: [2, 2, 2] }
}

const browser = await chromium.launch({ headless: true })
try {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1600, height: 900 }]) {
    const key = `${viewport.width}x${viewport.height}`
    const page = await browser.newPage({ viewport })
    await page.goto(`file://${deckPath}`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    for (const [id, form] of Object.entries(FORMS)) {
      const look = await page.evaluate(({ id, form }) => {
        const slides = [...document.querySelectorAll('.stage > .slide')]
        const slide = slides.find((s) => s.dataset.id === id)
        slides.forEach((s) => s.classList.toggle('active', s === slide))
        window.__autofitForTest?.()
        const sr = slide.parentElement.getBoundingClientRect(), k = sr.width / slide.parentElement.offsetWidth
        const stageW = slide.parentElement.offsetWidth
        const R = (el) => { const r = el.getBoundingClientRect(); return { left: (r.left - sr.left) / k, right: (r.right - sr.left) / k, top: (r.top - sr.top) / k, bottom: (r.bottom - sr.top) / k, width: r.width / k, height: r.height / k } }
        const cs = (el, pseudo) => getComputedStyle(el, pseudo)
        const floor = (() => { const el = document.createElement('span'); el.style.cssText = 'position:absolute;visibility:hidden;font-size:var(--type-floor)'; slide.append(el); const v = parseFloat(getComputedStyle(el).fontSize); el.remove(); return v })() / k
        return {
          stageW, floor,
          cards: [...slide.querySelectorAll(form.card)].map((card) => {
            const chip = card.querySelector(form.chip)
            const title = card.querySelector(form.title)
            const pts = [...card.querySelectorAll(form.pts)]
            return {
              box: R(card), fill: cs(card).backgroundColor, border: cs(card).borderTopColor, borderW: parseFloat(cs(card).borderTopWidth) * 1 / k,
              chip: R(chip), chipFill: cs(chip).backgroundColor, chipColor: cs(chip).color, hasSvg: Boolean(chip.querySelector('svg')) || /^\d+$/.test(chip.textContent.trim()),
              titleW: cs(title).fontWeight, titlePx: parseFloat(cs(title).fontSize) / k, titleColor: cs(title).color, titleLeft: R(title).left, chipRight: R(chip).right,
              rule: (() => { const b = cs(card, '::before'); return { content: b.content, h: parseFloat(b.height) / k, bg: b.backgroundColor } })(),
              pts: pts.map((p) => ({ w: cs(p).fontWeight, px: parseFloat(cs(p).fontSize) / k, fill: cs(p).backgroundColor, marker: cs(p, '::before').content, display: cs(p).display, rect: R(p), icons: p.querySelectorAll('svg').length }))
            }
          })
        }
      }, { id, form })
      const label = `${key} ${id}`
      assert.equal(look.cards.length, 3, `${label}: three cards`)
      const hues = new Set()
      look.cards.forEach((c, i) => {
        assert(c.borderW >= 0.5 && c.borderW <= 3.5, `${label} card ${i + 1}: a thin box outline (${c.borderW.toFixed(2)}px)`)
        assert.notEqual(c.fill, 'rgba(0, 0, 0, 0)', `${label} card ${i + 1}: the card has a tinted fill`)
        hues.add(c.border)
        assert(Math.abs(c.chip.width - c.chip.height) < 0.6, `${label} card ${i + 1}: the chip is square`)
        assert(Math.abs(c.chip.width / 1280 * 1920 - 68) < 4, `${label} card ${i + 1}: the chip is 68/1920 wide (${(c.chip.width / 1280 * 1920).toFixed(1)}px at 1920)`)
        assert(c.hasSvg, `${label} card ${i + 1}: the chip holds the icon (or the number)`)
        assert.notEqual(c.chipFill, c.fill, `${label} card ${i + 1}: the chip is tinted apart from the card`)
        assert(parseInt(c.titleW, 10) <= 400, `${label} card ${i + 1}: regular-weight title (${c.titleW})`)
        assert(c.titlePx >= look.floor - 0.01, `${label} card ${i + 1}: title at the type floor or above (${c.titlePx.toFixed(1)} vs ${look.floor.toFixed(1)})`)
        assert(c.titleLeft > c.chipRight, `${label} card ${i + 1}: the title sits beside the chip`)
        assert(c.rule.content !== 'none' && c.rule.h >= 0.5, `${label} card ${i + 1}: a rule under the title row (${c.rule.content}, ${c.rule.h})`)
        assert.equal(c.pts.length, FORMS[id].n[i], `${label} card ${i + 1}: ${FORMS[id].n[i]} points`)
        c.pts.forEach((p, j) => {
          assert(parseInt(p.w, 10) <= 400, `${label} card ${i + 1} point ${j + 1}: regular weight (${p.w})`)
          assert(p.px >= look.floor - 0.01, `${label} card ${i + 1} point ${j + 1}: at the type floor or above (${p.px.toFixed(1)} vs ${look.floor.toFixed(1)})`)
          assert(p.marker === 'none' || p.marker === 'normal', `${label} card ${i + 1} point ${j + 1}: no bullet (${p.marker})`)
          assert.notEqual(p.fill, 'rgba(0, 0, 0, 0)', `${label} card ${i + 1} point ${j + 1}: a highlight row`)
          assert.equal(p.icons, 0, `${label} card ${i + 1} point ${j + 1}: no icon on a point`)
          assert(p.rect.left >= c.box.left && p.rect.right <= c.box.right + 0.5, `${label} card ${i + 1} point ${j + 1}: inside its card`)
        })
        assert(c.pts[c.pts.length - 1].rect.bottom <= c.box.bottom + 0.5, `${label} card ${i + 1}: the points sit inside the card`)
      })
      assert.equal(hues.size, 3, `${label}: the three cards take three hues`)
      const tops = look.cards.map((c) => c.box.top)
      assert(Math.max(...tops) - Math.min(...tops) < 1, `${label}: cards align at their tops`)
    }
    await page.close()
  }
  checks += 1; console.log('PASS look at both window sizes')

  // ---- reveal in the presenter runtime ----
  for (const [id, form] of Object.entries(FORMS)) {
    await check(`reveal ${id}: a point at a time, a card arrives with its first point`, async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
      await page.goto(`file://${deckPath}#${id}`, { waitUntil: 'load' })
      await page.evaluate(() => document.fonts?.ready)
      await page.waitForTimeout(250)
      await page.keyboard.press('r')
      await page.waitForTimeout(150)
      const total = form.n.reduce((a, b) => a + b, 0)
      const read = () => page.evaluate(({ form }) => {
        const slide = document.querySelector('.stage > .slide.active')
        const vis = (el) => { const s = getComputedStyle(el); return s.visibility !== 'hidden' && Number(s.opacity) > 0.01 }
        return [...slide.querySelectorAll(form.card)].map((card) => ({ card: vis(card), pts: [...card.querySelectorAll(form.pts)].map((p) => vis(p) && vis(card)) }))
      }, { form })
      for (let step = 0; step <= total; step += 1) {
        if (step > 0) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(260) }
        const state = await read()
        const shown = state.flatMap((c) => c.pts).filter(Boolean).length
        assert.equal(shown, step, `${id} step ${step}: exactly ${step} points are showing (got ${shown})`)
        state.forEach((c, i) => {
          const any = c.pts.some(Boolean)
          assert.equal(c.card, any || (step === total), `${id} step ${step}: card ${i + 1} is ${any ? 'in' : 'out'} (card visible ${c.card})`)
        })
      }
      await page.close()
    })
  }

  // ---- the handout shows all, and enumerates the same units ----
  await check('handout: every point is showing and the unit list matches the deck', async () => {
    const { extractSlides, extractStyles } = await import('../compiler/scripts/lib/04-html-extraction.mjs')
    const { buildShareHtml } = await import('../compiler/scripts/lib/09-output-builders.mjs')
    const { presenterSelectors, audienceSelectors } = await import('./lib/mode-selectors.mjs')
    const handout = buildShareHtml({ title: 'Cards', slides: extractSlides(model.fullHtml), styles: extractStyles(model.fullHtml), includeNotes: false, slug: 'cards-look', license: null })
    const handoutPath = join(dir, 'handout.html')
    writeFileSync(handoutPath, handout, 'utf8')
    const out = {}
    for (const [name, p, selectors] of [['deck', deckPath, presenterSelectors()], ['handout', handoutPath, audienceSelectors()]]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
      await page.goto(`file://${p}`, { waitUntil: 'load' })
      await page.waitForTimeout(300)
      out[name] = await page.evaluate(({ selector, ids }) => ids.map((id) => {
        const slide = document.querySelector(`.slide[data-id="${id}"]`)
        const raw = [...slide.querySelectorAll(selector)]
        return raw.filter((el, i) => raw.indexOf(el) === i).map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30))
      }), { selector: selectors.join(','), ids: Object.keys(FORMS) })
      if (name === 'handout') {
        const shown = await page.evaluate(() => [...document.querySelectorAll('.feature-list li')].every((el) => { const s = getComputedStyle(el); return s.visibility !== 'hidden' && Number(s.opacity) > 0.01 }))
        assert(shown, 'handout: no list item is hidden')
      }
      await page.close()
    }
    assert.deepEqual(out.handout, out.deck, 'the handout enumerates the deck\'s units in order')
    Object.keys(FORMS).forEach((id, i) => assert.equal(out.deck[i].length, Object.values(FORMS)[i].n.reduce((a, b) => a + b, 0), `${id}: one unit per point (the card is not a unit)`))
  })
} finally {
  await browser.close()
}

// ---- compiler output ----
await check('compiler: card-points on a card of points; a card of label groups keeps its look; box cards mark their points', () => {
  const html = model.fullHtml
  const slideHtml = (id) => { const i = html.indexOf(`data-id="${id}"`); return html.slice(i, html.indexOf('</section>', i)) }
  assert((slideHtml('cards').match(/card card-points/g) || []).length === 3, 'three card-points cards')
  const labels = slideHtml('label-card')
  assert(/<article class="card"[^>]*>/.test(labels) && !/card-points/.test(labels), 'a card of label groups is a plain .card')
  const boxes = slideHtml('boxes')
  assert((boxes.match(/<li class="fl-card-pts">/g) || []).length === 3, 'three box cards carry fl-card-pts')
  assert(/feature-list[^"]*fl-cards/.test(boxes), 'the box list carries fl-cards')
})

console.log(`\ntest:cards-look: ${checks} checks passed`)
