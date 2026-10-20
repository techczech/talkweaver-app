// =============================================================================
// test:table-newest-row-dom — 0.41 ticket 10 (table, 20-table.html: "the newest row tinted in the accent while it builds")
//
// A {reveal} table builds row by row. At every step, in the projector (audience window) and in the presenter's Current
// pane alike, exactly the newest row shown carries the section tint (--tint) and no other row does, at every step up to
// and including the last row (the last row is tinted at its own step). A banded row that is not the newest keeps its
// band. At the all-shown step after the last row no row is tinted; the same holds in a static view (a table with no
// {reveal}) and in the handout. The handout reader's own Reveal tints the same way.
// Browser: Playwright's bundled Chromium (never the installed Chrome).
// =============================================================================

import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'

const dir = await mkdtemp(join(tmpdir(), 'tw-table-newest-row-'))
const ROWS = [
  '| Aspect | Advantage | Trade-off |', '| --- | --- | --- |',
  '| Retrieval | Outputs are easier to find later | You need to save and name things well |',
  '| Scale | Easier to work across many local files | You must know what folder you share |',
  '| Privacy | Some tasks stay mostly local | Some tasks still use remote models |',
  '| Cost | No per-request fee | You run the machine |'
]
const outline = [
  '---', 'title: Table newest row', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '# Deck', '## Section', '',
  '### Start', '{id=start}', '', '- Words only', '',
  '### Trade-offs built', '{table} {reveal} {id=built}', '', ...ROWS, '',
  '### Trade-offs static', '{table} {id=static}', '', ...ROWS, '',
  '### End', '{id=end}', '', '- Words only', ''
].join('\n')
const path = join(dir, 'table.md')
await writeFile(path, outline, 'utf8')
const deckHtml = (await prepareSource(path, outline, null, await stat(path), {}, {})).fullHtml
const handoutHtml = buildShareHtml({ title: 'Table newest row', slug: 'table-newest-row', includeNotes: false, license: null,
  slides: extractSlides(deckHtml), styles: extractStyles(deckHtml) })
const pages = { '/deck.html': deckHtml, '/handout.html': handoutHtml }
const server = createServer((req, res) => {
  const body = pages[req.url.split('?')[0]]
  if (body) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); return }
  res.writeHead(404); res.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

/**
 * Each body row of the table on show: 'tint' (every cell has the slide's --tint), 'band', 'plain' or 'hidden' (a row
 * still to come), with its reveal state. `inPreview` reads the presenter's Current pane.
 */
function readRows(inPreview) {
  const doc = inPreview ? document.querySelector('#currentPreview iframe')?.contentDocument : document
  const slide = doc?.querySelector(inPreview ? '.slide' : '.slide.active')
  if (!slide) return null
  const probe = doc.createElement('span')
  probe.style.cssText = 'position:absolute;visibility:hidden;background:var(--tint)'
  slide.append(probe)
  const tint = getComputedStyle(probe).backgroundColor
  probe.remove()
  const clear = 'rgba(0, 0, 0, 0)'
  const rows = [...slide.querySelectorAll('.slide-table tbody tr')].map((tr) => {
    const bgs = [...tr.children].map((cell) => getComputedStyle(cell).backgroundColor)
    const look = getComputedStyle(tr).visibility === 'hidden' ? 'hidden'
      : bgs.every((bg) => bg === tint) ? 'tint' : bgs.some((bg) => bg === tint) ? 'part-tint'
        : bgs.every((bg) => bg === clear) ? 'plain' : 'band'
    return look
  })
  return { slide: slide.dataset.id, tint, rows }
}

const browser = await chromium.launch({ headless: true })
let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`) } catch (error) { failures += 1; console.error(`FAIL ${name}\n  ${error.stack || error}`) }
}
// Row i of the static table: banded where i is odd (every second body row), else plain.
const base = (i) => (i % 2 === 1 ? 'band' : 'plain')
// What a {reveal} table of n rows shows at `step` (0 = arrival, n = last row shown, n+1 = all-shown): rows shown so far,
// the newest tinted at every step up to n, nothing tinted at the all-shown step n+1.
const expected = (n, step) => Array.from({ length: n }, (_, i) => {
  if (step > n) return base(i)
  if (i >= step) return 'hidden'
  return i === step - 1 ? 'tint' : base(i)
})

try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, reducedMotion: 'reduce' })
  const session = `table-newest-${Date.now()}`
  const presenter = await context.newPage()
  const projector = await context.newPage()
  for (const page of [presenter, projector]) page.on('pageerror', (error) => { failures += 1; console.error(`FAIL page error: ${error.message}`) })
  await projector.goto(`${origin}/deck.html?audience=1&session=${session}`, { waitUntil: 'load' })
  await presenter.goto(`${origin}/deck.html?presenter=1&session=${session}`, { waitUntil: 'load' })
  await presenter.waitForSelector('#presenterRoot, .presenter-root')

  // Press in the presenter; wait for the projector to show the same reveal step; compare it with the Current pane.
  const press = async (key) => {
    await presenter.keyboard.press(key)
    const sent = await presenter.evaluate(() => ({
      slide: document.querySelector('.slide.active')?.dataset.id ?? null,
      focus: document.documentElement.dataset.twLiveFocus || '',
      reveal: Number(document.documentElement.dataset.twLiveReveal) || 0
    }))
    await projector.waitForFunction((want) => document.querySelector('.slide.active')?.dataset.id === want.slide
      && (document.documentElement.dataset.twLiveFocus || '') === want.focus
      && (Number(document.documentElement.dataset.twLiveReveal) || 0) === want.reveal, sent, { timeout: 5000 })
    const shown = await projector.evaluate(readRows, false)
    let pane = null
    for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
      pane = await presenter.evaluate(readRows, true)
      if (JSON.stringify(pane?.rows) === JSON.stringify(shown?.rows)) break
      await presenter.waitForTimeout(25)
    }
    assert.deepEqual(pane?.rows, shown?.rows, `${key} on ${shown?.slide}: the presenter's Current pane shows the projector's rows`)
    return shown
  }
  const N = 4

  await check('deck: each step tints exactly the newest row; none once the last row is shown or after; presenter and projector agree', async () => {
    let shown = await press('ArrowRight')
    for (let i = 0; i < 4 && shown.slide !== 'built'; i += 1) shown = await press('ArrowRight')
    assert.equal(shown.slide, 'built', 'Next reaches the table')
    assert.notEqual(shown.tint, 'rgba(0, 0, 0, 0)', 'the slide has a section tint')
    assert.deepEqual(shown.rows, expected(N, 0), 'arrival: every row still to come')
    for (let step = 1; step <= N; step += 1) {
      shown = await press('ArrowRight')
      assert.equal(shown.slide, 'built', `step ${step}: still on the table`)
      assert.deepEqual(shown.rows, expected(N, step), `step ${step}`)
      assert(shown.rows.filter((r) => r === 'tint').length === 1, `step ${step}: one row tinted`)
    }
    shown = await press('ArrowRight')
    assert.equal(shown.slide, 'built', 'the all-shown step is still on the table')
    assert.deepEqual(shown.rows, expected(N, N + 1), 'fully built: no row tinted, banding as static')
  })

  await check('deck: stepping back moves the tint back to the newest row still shown', async () => {
    let shown = await press('ArrowLeft')
    assert.deepEqual(shown.rows, expected(N, N), 'back to the last row shown: it is tinted at its own step')
    for (let step = N - 1; step >= 1; step -= 1) {
      shown = await press('ArrowLeft')
      assert.equal(shown.slide, 'built')
      assert.deepEqual(shown.rows, expected(N, step), `back to step ${step}`)
    }
  })

  await check('deck: a table with no {reveal} is static, banded and untinted', async () => {
    let shown = await press('ArrowRight')
    for (let i = 0; i < 2 * N + 2 && shown.slide !== 'static'; i += 1) shown = await press('ArrowRight')
    assert.equal(shown.slide, 'static')
    assert.deepEqual(shown.rows, Array.from({ length: N }, (_, i) => base(i)))
  })
  await context.close()

  await check('handout: no row tinted; the reader\'s own Reveal tints the newest row and clears when built', async () => {
    const page = await browser.newPage({ viewport: { width: 1500, height: 900 } })
    page.on('pageerror', (error) => { failures += 1; console.error(`FAIL page error: ${error.message}`) })
    await page.goto(`${origin}/handout.html`, { waitUntil: 'load' })
    const go = (id) => page.evaluate((id) => { location.hash = `#${id}` }, id)
    await go('built')
    await page.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'built')
    let shown = await page.evaluate(readRows, false)
    assert.deepEqual(shown.rows, Array.from({ length: N }, (_, i) => base(i)), 'the handout shows the table static')
    await page.locator('#revealBtn').click()
    shown = await page.evaluate(readRows, false)
    assert.deepEqual(shown.rows, expected(N, 0), 'Reveal on: every row still to come')
    for (let step = 1; step <= N + 1; step += 1) {
      await page.keyboard.press('ArrowRight')
      shown = await page.evaluate(readRows, false)
      assert.deepEqual(shown.rows, expected(N, step), `handout step ${step}`)
    }
    for (let step = N; step >= 1; step -= 1) {
      await page.keyboard.press('ArrowLeft')
      shown = await page.evaluate(readRows, false)
      assert.deepEqual(shown.rows, expected(N, step), `handout back to step ${step}`)
    }
    await page.close()
  })
} finally {
  await browser.close()
  server.close()
}
if (failures) { console.error(`table-newest-row-dom: ${failures} failure(s)`); process.exit(1) }
console.log('table-newest-row-dom: all checks passed')
