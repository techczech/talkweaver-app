// =============================================================================
// test:fit-step-down — icon-row panels: the details step down to the type floor before the slide falls back, and a
// row that fits today is drawn as today. Measured in Chromium on neutral content written here.
//
//   1. A two-panel icon row a few px past its band at the size for its count (main draws it at full size and reports
//      it too long) and a three-panel icon row past the slide at today's last step, 2.4cqw (main falls back).
//      The fixture shapes are asserted first (how far over each one is at 2.4cqw), so the fixture keeps testing what it
//      says.
//   2. In every reveal state: no running text under the floor (1.9375cqw, stage.css --type-floor); one detail size for
//      the whole row, the same at every step.
//   3. The two-panel row is drawn exactly as main draws it: no step past 2.4cqw, no zoom. The three-panel row keeps the
//      Ocean drawing with its details stepped past 2.4cqw, at or over the floor, nothing past the slide. Ocean and
//      palette: classic (classic draws no panels: the same drawing at every step) both.
//   4. The handout page (share page) draws the same sizes as the deck; real page.pdf() print puts no word off its
//      page, never under the floor, and afterprint restores every slide's markup exactly (print runs where pdftotext,
//      poppler, is installed; elsewhere it is skipped with a message).
// The measures here are written apart from slide-fit.js's predicates. One browser, hard timeout, closed in finally.
// =============================================================================
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'tw-fit-step-down-'))
const HARD_LIMIT_MS = 480_000
const hardStop = setTimeout(() => { console.error(`test:fit-step-down: hard timeout after ${HARD_LIMIT_MS} ms`); process.exit(124) }, HARD_LIMIT_MS)

const JOBS = ['Sow the early peas along the fence', 'Prune the apple trees before the buds open', 'Water the seedlings every second morning', 'Cut the long grass after the flowers seed', 'Pot on the young plants into larger pots', 'Clear the weed from the edges of the water', 'Lay the hedge where it has grown thin', 'Turn the heap and add the green waste', 'Label and dry the saved seed in paper', 'Oil the blades and hang the tools up', 'Check the frames and add a new super', 'Pick the leaves before the plants flower', 'Tie the new stems to the arches', 'Lift the onions and dry them in the sun', 'Coppice the hazel in the far corner', 'Paint the gate and fix the latch', 'Clean the gutters into the water butts', 'Plant the bulbs a hand deep in autumn']
const THREE_LINES = ['Plans: choose the beds, order the seed and share the tools fairly', 'Work: water, weed and harvest on the days agreed with the others', 'Records: write down what grew, what failed and what to try next year']
function outline({ panelItems = 9, threeLines = THREE_LINES } = {}) {
  const out = ['---', 'title: Fit step-down', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', '## Cases', '']
  out.push('### Who does what', '{iconrow}{reveal}{id=panel-tight}', '')
  out.push('- Visitors {icon=lucide:sprout}', '  - Walk the paths', '  - Read the labels')
  out.push('- Volunteers {icon=lucide:shovel}')
  for (const job of JOBS.slice(0, panelItems)) out.push(`  - ${job.split(' ').slice(0, 5).join(' ')}`)
  out.push('', '### Three ways to help', '{iconrow}{reveal}{id=panel-three}', '')
  for (const [i, who] of ['Neighbours', 'Volunteers', 'Visitors'].entries()) {
    out.push(`- ${who} {icon=lucide:${['sprout', 'shovel', 'map'][i]}}`)
    for (const line of threeLines) out.push(`  - ${line}`)
  }
  out.push('')
  return out.join('\n')
}

// In-page measures (independent of slide-fit.js).
function measureActive() {
  const slide = document.querySelector('.stage > .slide.active')
  const content = slide.querySelector(':scope > .slide-content')
  const k = slide.getBoundingClientRect().width / slide.clientWidth
  const floor = slide.clientWidth * 1.9375 / 100
  const scope = content.querySelector('.card.carousel-subslide.active-card > .slide-content') || content
  const sizes = []
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
  for (let node; (node = walker.nextNode());) {
    const el = node.parentElement
    if (!node.data.trim() || !el || el.closest('.sr-only, .qr-caption, .gallery-nav, .kicker, .slide-head, h1, h2, h3, h4, .ir-label, thead, th')) continue
    if (getComputedStyle(el).display === 'none') continue
    sizes.push(Math.round(parseFloat(getComputedStyle(el).fontSize) * 100) / 100)
  }
  const cs = getComputedStyle(slide), ccs = getComputedStyle(content)
  const band = slide.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - (parseFloat(ccs.paddingTop) || 0) - (parseFloat(ccs.paddingBottom) || 0)
  const top0 = slide.getBoundingClientRect().top
  let top = Infinity, bottom = -Infinity
  const railHead = slide.dataset.titleLayout === 'left' ? content.querySelector(':scope > .slide-head:not(.slide-head-quiet)') : null
  for (const child of (scope === content ? content.children : scope.parentElement.children)) {
    if (child === railHead) continue
    const r = child.getBoundingClientRect()
    if (!(r.height > 0)) continue
    top = Math.min(top, (r.top - top0) / k); bottom = Math.max(bottom, (r.bottom - top0) / k)
  }
  const outside = []
  const slideBox = slide.getBoundingClientRect()
  for (const el of slide.querySelectorAll('.slide-content *')) {
    const st = getComputedStyle(el)
    if (st.visibility === 'hidden' || Number(st.opacity) === 0 || st.display === 'none' || el.closest('.sr-only')) continue
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim())) continue
    const r = el.getBoundingClientRect()
    if (r.left < slideBox.left - 1 || r.right > slideBox.right + 1 || r.top < slideBox.top - 1 || r.bottom > slideBox.bottom + 1) outside.push(el.textContent.trim().slice(0, 30))
  }
  const grid = content.querySelector(':scope > .columns-grid')
  const head = content.querySelector(':scope > .slide-head')
  return {
    id: slide.dataset.id, look: slide.dataset.look, listFit: (scope === content ? content : scope).dataset.listFit || '', textFit: content.dataset.textFit || '',
    floor, sizes, min: Math.min(...sizes), max: Math.max(...sizes), band, height: bottom - top, outside,
    detail: [...content.querySelectorAll('.ir-desc > li')].map((li) => parseFloat(getComputedStyle(li).fontSize)),
    detailInline: [...content.querySelectorAll('.ir-item')].some((el) => el.style.getPropertyValue('--oc-detail')),
    zoom: parseFloat(content.style.zoom) || 1,
    columns: grid && head ? { gridLeft: (grid.getBoundingClientRect().left - slideBox.left) / k, headRight: (head.getBoundingClientRect().right - slideBox.left) / k, gridRight: (grid.getBoundingClientRect().right - slideBox.left) / k, width: slide.clientWidth } : null,
  }
}
// The panel at the old last step (2.4cqw): how far past the slide's own edges it reaches (what sends the look to the
// fall-back on main), in canvas px.
function beyondStageAtOldStep() {
  const slide = document.querySelector('.stage > .slide.active')
  const content = slide.querySelector(':scope > .slide-content')
  const items = [...content.querySelectorAll('.ir-item')]
  const saved = items.map((el) => el.getAttribute('style'))
  const look = slide.dataset.look
  slide.dataset.look = 'ocean'
  items.forEach((el) => el.style.setProperty('--oc-detail', 'max(var(--type-floor, 31px), 2.4cqw)'))
  const box = slide.getBoundingClientRect(), k = box.width / slide.clientWidth
  let over = -Infinity
  for (const el of content.querySelectorAll('.icon-row *')) { const r = el.getBoundingClientRect(); if (r.height > 0) over = Math.max(over, (r.bottom - box.bottom) / k, (box.top - r.top) / k) }
  items.forEach((el, i) => { if (saved[i] === null) el.removeAttribute('style'); else el.setAttribute('style', saved[i]) })
  slide.dataset.look = look
  return over
}
// The panel at the old last step (2.4cqw): how far over the slide it would be.
function panelAtOldStep() {
  const slide = document.querySelector('.stage > .slide.active')
  const content = slide.querySelector(':scope > .slide-content')
  const items = [...content.querySelectorAll('.ir-item')]
  const saved = items.map((el) => el.getAttribute('style'))
  items.forEach((el) => el.style.setProperty('--oc-detail', 'max(var(--type-floor, 31px), 2.4cqw)'))
  const box = slide.getBoundingClientRect()
  let bottom = -Infinity, top = Infinity
  for (const el of content.querySelectorAll('.icon-row, .icon-row *')) { const r = el.getBoundingClientRect(); if (r.height > 0) { bottom = Math.max(bottom, r.bottom); top = Math.min(top, r.top) } }
  const k = box.width / slide.clientWidth
  const cs = getComputedStyle(slide)
  const over = Math.max((bottom - box.bottom) / k + parseFloat(cs.paddingBottom), (box.top - top) / k + parseFloat(cs.paddingTop))
  items.forEach((el, i) => { if (saved[i] === null) el.removeAttribute('style'); else el.setAttribute('style', saved[i]) })
  return over
}

async function show(page, id) {
  await page.evaluate((target) => { location.hash = target }, id)
  await page.waitForFunction((target) => document.querySelector('.stage > .slide.active')?.dataset.id === target, id, { timeout: 8000 })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(250)
}
async function steps(page) {
  return page.evaluate(() => { const s = document.querySelector('.stage > .slide.active'); return s.querySelectorAll('.mode-el').length })
}

const CASES = ['panel-tight', 'panel-three']
let browser
async function deckFor(palette) {
  const source = join(work, `fit-step-down-${palette}-outline.md`)
  const text = '---\n' + (palette === 'classic' ? 'palette: classic\n' : '') + outline().replace(/^---\n/, '')
  writeFileSync(source, text)
  const model = await prepareSource(source, text, `fit-step-down-${palette}`, statSync(source), undefined, { allowedAssetRoots: [work] })
  const deck = join(work, `deck-${palette}.html`)
  writeFileSync(deck, String(model.fullHtml))
  return { deck, model }
}
const cqwOf = (m, px) => px / (m.floor / 1.9375)
try {
  browser = await chromium.launch({ headless: true })
  const report = {}
  let oceanModel, oceanDeck
  for (const palette of ['ocean', 'classic']) {
    const { deck, model } = await deckFor(palette)
    if (palette === 'ocean') { oceanModel = model; oceanDeck = deck }
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
    await page.goto(pathToFileURL(deck).href, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts.ready)
    for (const id of CASES) {
      const tag = `${palette} ${id}`
      await show(page, id)
      const oldStep = id === 'panel-tight' && palette === 'ocean' ? await page.evaluate(panelAtOldStep) : null
      if (oldStep !== null) assert.ok(oldStep > 0 && oldStep < 40, `${tag}: at the old last step (2.4cqw) the panel should be a little too tall, measured ${oldStep.toFixed(1)}px`)
      const n = await steps(page)
      const states = [await page.evaluate(measureActive)]
      for (let i = 0; i < n; i += 1) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(160); const m = await page.evaluate(measureActive); if (m.id !== id) break; states.push(m) }
      const first = states[0]
      assert.ok(first.sizes.length, `${tag}: no running text measured`)
      assert.ok(states.length > 1, `${tag}: no reveal steps walked`)
      for (const [i, m] of states.entries()) {
        assert.ok(m.min >= m.floor - 0.5, `${tag} step ${i}: text at ${m.min}px under the floor ${m.floor.toFixed(2)}px`)
        assert.deepEqual(m.sizes, first.sizes, `${tag} step ${i}: type changed size between reveal steps`)
        assert.equal(m.look, first.look, `${tag} step ${i}: drawing changed between reveal steps`)
        assert.deepEqual(m.detail, first.detail, `${tag} step ${i}: details changed size between reveal steps`)
        assert.equal(m.zoom, first.zoom, `${tag} step ${i}: zoom changed between reveal steps`)
      }
      if (palette === 'ocean') assert.equal(new Set(first.detail).size, 1, `${tag}: one detail size for the whole row (${[...new Set(first.detail)]})`)
      // A two-panel row a few px past its band, drawn at full size (main reports it too long and does not zoom it):
      // drawn exactly as main draws it: main's ladder (down to 2.4cqw) and no step past it, no zoom.
      if (id === 'panel-tight' && palette === 'ocean') {
        assert.equal(first.look, 'ocean', `${tag}: keeps the Ocean drawing`)
        assert.ok(cqwOf(first, first.detail[0]) >= 2.4 - 0.01, `${tag}: details at ${cqwOf(first, first.detail[0]).toFixed(3)}cqw, past main's last step (2.4cqw)`)
        assert.equal(first.zoom, 1, `${tag}: zoomed`)
        assert.equal(first.textFit, 'too-long', `${tag}: the fixture should run past its band at full size, as on main`)
      }
      // A three-panel row whose details at 2.4cqw run past the slide (main falls back): keeps the look, details stepped.
      if (id === 'panel-three' && palette === 'ocean') {
        const beyond = await page.evaluate(beyondStageAtOldStep)
        assert.ok(beyond > 1.5, `${tag}: fixture does not reach past the slide at 2.4cqw (${beyond.toFixed(1)}px)`)
        assert.equal(first.look, 'ocean', `${tag}: keeps the Ocean drawing`)
        const cqw = cqwOf(first, first.detail[0])
        assert.ok(cqw < 2.4 - 0.01 && first.detail[0] >= first.floor - 0.5, `${tag}: details at ${cqw.toFixed(3)}cqw, expected under 2.4cqw and at or over the floor`)
        assert.deepEqual(first.outside, [], `${tag}: text outside the slide`)
        report[`${tag} beyond the slide at 2.4cqw`] = Math.round(beyond * 10) / 10
      }
      report[tag] = { oldPanelExcess: oldStep === null ? null : Math.round(oldStep * 10) / 10, states: states.length, look: first.look, listFit: first.listFit, textFit: first.textFit, min: first.min, floor: Math.round(first.floor * 100) / 100, detail: first.detail[0] ?? null }
    }
    await page.close()
  }
  const model = oceanModel
  const deck = oceanDeck
  const share = join(work, 'share.html')
  writeFileSync(share, buildShareHtml({ title: 'Fit step-down', slug: 'fit-step-down', slides: extractSlides(model.fullHtml), styles: extractStyles(model.fullHtml) }))
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  await page.goto(pathToFileURL(deck).href, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  console.log(JSON.stringify(report, null, 1))

  // The handout page draws the same sizes as the deck.
  const handout = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  await handout.goto(pathToFileURL(share).href, { waitUntil: 'load' })
  await handout.evaluate(() => document.fonts.ready)
  await handout.waitForTimeout(400)
  const wanted = ['panel-tight', 'panel-three']
  const sizesOf = () => { const slide = document.querySelector('.stage > .slide.active'); if (!slide) return null; const ratio = (el) => parseFloat(getComputedStyle(el).fontSize) / slide.clientWidth; return { id: slide.dataset.id, look: slide.dataset.look, ratios: [...slide.querySelectorAll('td, .ir-desc > li, .feature-list > li, ul > li')].slice(0, 4).map((el) => Math.round(ratio(el) * 1e5) / 1e5) } }
  const onHandout = {}
  const count = await handout.evaluate(() => document.querySelectorAll('.stage > .slide').length)
  for (let i = 0; i < count * 6 && Object.keys(onHandout).length < wanted.length; i += 1) {
    const got = await handout.evaluate(sizesOf)
    if (got?.id && wanted.includes(got.id) && !onHandout[got.id]) onHandout[got.id] = got
    await handout.keyboard.press('ArrowRight')
    await handout.waitForTimeout(120)
  }
  for (const id of wanted) {
    await show(page, id)
    const deckGot = await page.evaluate(sizesOf)
    const got = onHandout[id]
    assert.ok(got, `${id}: not reached on the handout page`)
    assert.equal(got.look, deckGot.look, `${id}: handout draws another look`)
    got.ratios.forEach((r, i) => assert.ok(Math.abs(r - deckGot.ratios[i]) < 0.0005, `${id}: handout size ${r} against deck ${deckGot.ratios[i]} (per canvas width)`))
  }
  await handout.close()

  // Real print: no word off its page, never under the floor on paper, markup restored after.
  await show(page, 'panel-three')
  // Markup compared with attributes in a fixed order (restoring may set them in another order).
  const before = await page.evaluate(() => { const canon = (n) => n.nodeType === 3 ? n.data : n.nodeType !== 1 ? '' : `<${n.tagName}${[...n.attributes].map((a) => ` ${a.name}="${a.value}"`).sort().join('')}>${[...n.childNodes].map(canon).join('')}</${n.tagName}>`; return [...document.querySelectorAll('.stage > .slide')].map(canon) })
  await page.evaluate(() => addEventListener('beforeprint', () => {
    const out = []
    for (const slide of document.querySelectorAll('.slide[data-id]')) {
      const floor = slide.clientWidth * 1.9375 / 100
      let min = Infinity
      for (const el of slide.querySelectorAll('.slide-content td, .slide-content li, .slide-content .ir-desc > li')) {
        if (getComputedStyle(el).display === 'none') continue
        min = Math.min(min, parseFloat(getComputedStyle(el).fontSize))
      }
      if (min < Infinity) out.push({ id: slide.dataset.id, min, floor })
    }
    window.__printSizes = out
  }))
  const pdf = join(work, 'deck.pdf')
  await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true })
  const printed = await page.evaluate(() => window.__printSizes)
  assert.ok(printed?.length, 'beforeprint measured no slide')
  for (const p of printed) assert.ok(p.min >= p.floor - 0.5, `print ${p.id}: ${p.min}px under the floor ${p.floor.toFixed(2)}px`)
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
  const after = await page.evaluate(() => { const canon = (n) => n.nodeType === 3 ? n.data : n.nodeType !== 1 ? '' : `<${n.tagName}${[...n.attributes].map((a) => ` ${a.name}="${a.value}"`).sort().join('')}>${[...n.childNodes].map(canon).join('')}</${n.tagName}>`; return [...document.querySelectorAll('.stage > .slide')].map(canon) })
  assert.equal(after.length, before.length, 'print changed the number of slides')
  after.forEach((html, i) => {
    if (html === before[i]) return
    let at = 0; while (at < html.length && html[at] === before[i][at]) at += 1
    assert.fail(`print left slide ${i + 1} changed at ${at}: before …${JSON.stringify(before[i].slice(Math.max(0, at - 60), at + 160))}… after …${JSON.stringify(html.slice(Math.max(0, at - 60), at + 160))}…`)
  })
  let hasPoppler = true
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }) } catch { hasPoppler = false }
  if (!hasPoppler) console.log('test:fit-step-down: pdftotext (poppler) is not installed here: the words-on-page check of print is skipped')
  const bbox = hasPoppler ? execFileSync('pdftotext', ['-bbox-layout', pdf, '-'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }) : ''
  let pages = 0, offPage = 0
  for (const m of bbox.matchAll(/<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g)) {
    pages += 1
    const w = Number(m[1]), h = Number(m[2])
    for (const word of m[3].matchAll(/<word\s+([^>]+)>/g)) {
      const b = Object.fromEntries([...word[1].matchAll(/(xMin|xMax|yMin|yMax)="([\d.-]+)"/g)].map((x) => [x[1], Number(x[2])]))
      if (b.xMin < -0.5 || b.yMin < -0.5 || b.xMax > w + 0.5 || b.yMax > h + 0.5) offPage += 1
    }
  }
  if (hasPoppler) assert.ok(pages >= CASES.length, `print: ${pages} pages for ${CASES.length} slides`)
  assert.equal(offPage, 0, `print: ${offPage} words off their page`)
  console.log(`test:fit-step-down: ${CASES.length} cases at every reveal step, the handout page and print (${pages} pages): the three-panel row steps past 2.4cqw instead of falling back, the two-panel row is drawn as main draws it, never under the floor`)
} finally {
  clearTimeout(hardStop)
  await browser?.close()
  rmSync(work, { recursive: true, force: true })
}
