// Ticket 2b, in a browser: the same outline search in the presenter view and in the exported pages. Compiles a small
// fixture talk with the real compiler (picture text handed in as the app does), then drives the REAL emitted pages in
// Playwright's chromium headless shell (never the real Chrome; PLAYWRIGHT_BROWSERS_PATH picks the install):
//   presenter deck (?presenter=1), share page / handout (notes included and left out), plain deck (overview drawer):
//   outline order is kept, non-matches dim, hits carry <mark>, the "in text: / in notes: / in picture:" line, a
//   thumbnail under hit rows only while searching, Up/Down/Enter move through hits in order, Esc closes.
// Output lands in .tw-2b-check/ (gitignored) so the pages can be opened by hand.
import { strict as assert } from 'node:assert'
import { mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = join(root, '.tw-2b-check')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const canonicalDir = realpathSync(dir)

// A one-pixel picture; the "OCR text" for it comes in through options.pictureText, keyed by the picture's path.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')
writeFileSync(join(dir, 'chart.png'), PNG)
const outline = ['---', 'title: Search fixture', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## Section One', '',
  '### Welcome {id=s1}', '', '- hello and welcome', '- the survey method', '',
  '### Method notes {id=s2}', '', '- we used a survey', '', ':::notes', 'remember the zebra demo', ':::', '',
  '## Section Two', '',
  '### The chart {id=s3}', '', '![A bar chart](chart.png)', '',
  '### Closing {id=s4}', '', '- thank you', '', ':::notes', 'ask about method', ':::', ''].join('\n')
const outlinePath = join(dir, 'fixture-outline.md')
writeFileSync(outlinePath, outline)
const model = await prepareSource(outlinePath, outline, 'fixture', statSync(outlinePath), undefined, {
  allowedAssetRoots: [dir],
  pictureText: { [join(canonicalDir, 'chart.png')]: 'Revenue by quarter\nzebra herd migration', [join(dir, 'chart.png')]: 'Revenue by quarter\nzebra herd migration' },
})
const deckPath = join(dir, 'deck.html')
writeFileSync(deckPath, model.fullHtml)
const slides = extractSlides(model.fullHtml)
const styles = extractStyles(model.fullHtml)
const sharePath = join(dir, 'share.html')
writeFileSync(sharePath, buildShareHtml({ title: 'Search fixture', slides, styles, includeNotes: true, slug: 'fixture' }))
const shareNoNotesPath = join(dir, 'share-no-notes.html')
writeFileSync(shareNoNotesPath, buildShareHtml({ title: 'Search fixture', slides, styles, includeNotes: false, slug: 'fixture' }))

let checks = 0
const pass = (name) => { checks++; console.log(`PASS ${name}`) }
const browser = await chromium.launch()
try {
  // One run of the checks against one page; `s` names its search box, list and how to open the outline.
  async function surface(name, url, s) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(url)
    await page.waitForLoadState('domcontentloaded')
    await s.open(page)
    const search = page.locator(s.search)
    const rows = page.locator(`${s.list} .slide-link:not(.slide-sublink)`)
    const titles = async () => (await rows.allInnerTexts()).map((t) => t.split('\n')[0].trim())
    // Each row's state keyed by its title: dim (not a hit), hit, or plain (no query).
    const stateOf = async () => {
      const list = await rows.evaluateAll((els) => els.map((el) => [el.querySelector('.slide-link-title').innerText.replace(/^\d+\.\s*/, '').trim(), el.classList.contains('tw-dim') ? 'dim' : el.classList.contains('tw-hit') ? 'hit' : 'plain']))
      return Object.fromEntries(list)
    }
    const hitsOnly = async () => Object.entries(await stateOf()).filter(([, v]) => v === 'hit').map(([k]) => k)
    const row = (title) => rows.filter({ hasText: title }).first()
    // The line and thumbnail under a hit sit just after the row (the row's own text stays its title).
    const detail = (title) => row(title).locator('xpath=following-sibling::*[1][contains(@class, "tw-hit-detail")]')

    // Nothing typed: every row plain, no marks, no snippet line, no thumbnails.
    assert.ok(Object.values(await stateOf()).every((v) => v === 'plain') && Object.keys(await stateOf()).length === 6, `${name}: plain without a query`)
    assert.equal(await page.locator(`${s.list} mark, ${s.list} .tw-snippet, ${s.list} .tw-thumb`).count(), 0, `${name}: no marks, lines or thumbnails without a query`)
    pass(`${name}: outline without a query is unchanged`)

    // "method": slide Welcome body, Method notes title; Closing only through its notes (when the page carries them).
    await search.fill('method')
    assert.deepEqual(await titles(), ['1. Section One', '2. Welcome', '3. Method notes', '4. Section Two', '5. The chart', '6. Closing'], `${name}: outline order kept while searching (no ranking)`)
    assert.deepEqual(await hitsOnly(), s.notes ? ['Welcome', 'Method notes', 'Closing'] : ['Welcome', 'Method notes'], `${name}: hits${s.notes ? ' (Closing through its notes)' : ' (no notes on this page)'}`)
    assert.equal((await stateOf())['The chart'], 'dim')
    const title2 = await row('Method notes').locator('.slide-link-title mark').allInnerTexts()
    assert.deepEqual(title2.map((t) => t.toLowerCase()), ['method'], `${name}: <mark> in the title`)
    assert.match(await detail('Welcome').locator('.tw-snippet').innerText(), /^in text: .*survey method$/, `${name}: "in text:" line quoting the body line`)
    assert.equal(await detail('Welcome').locator('.tw-snippet mark').innerText(), 'method')
    pass(`${name}: order kept, non-matches dim, hits marked, "in text:" line`)
    assert.equal(await detail('Welcome').locator('.tw-thumb').count(), 1, `${name}: thumbnail under a hit`)
    assert.equal(await detail('The chart').locator('.tw-thumb').count(), 0, `${name}: none under a dim row`)
    assert.equal(await detail('Welcome').locator('.tw-thumb .slide').count(), 1, `${name}: the thumbnail is the slide`)
    pass(`${name}: thumbnail under hit rows only`)
    assert.match(await page.locator(`${s.list} .tw-overview-hits`).innerText(), /^\d+ matches?$/)
    assert.equal(await page.locator(`${s.list} .section-head`).nth(0).locator('.tw-hit-count').innerText(), '2', `${name}: section hit count`)
    pass(`${name}: section hit counts`)

    // Notes and picture text (the app hands the compiler the stored picture text).
    await search.fill('zebra')
    assert.deepEqual(await hitsOnly(), s.notes ? ['Method notes', 'The chart'] : ['The chart'], `${name}: zebra`)
    assert.match(await detail('The chart').locator('.tw-snippet').innerText(), /^in picture: .*zebra/)
    if (s.notes) assert.match(await detail('Method notes').locator('.tw-snippet').innerText(), /^in notes: remember the zebra demo$/)
    pass(`${name}: "in picture:"${s.notes ? ' and "in notes:"' : ''} lines${s.notes ? '' : ' (notes not searched where absent)'}`)
    // Alt text reaches the DOM already.
    await search.fill('bar chart')
    assert.deepEqual(await hitsOnly(), ['The chart'], `${name}: alt text is picture text`)
    // Operators and prefixes are the app's.
    await search.fill('t:method')
    assert.deepEqual(await hitsOnly(), ['Method notes'], `${name}: t: searches titles`)
    await search.fill('s:welcome')
    assert.deepEqual(await hitsOnly(), ['Welcome'])
    await search.fill('e:"survey method"')
    assert.deepEqual(await hitsOnly(), ['Welcome'], `${name}: e: exact phrase`)
    await search.fill('qqqq')
    assert.deepEqual(await hitsOnly(), [])
    assert.equal(await page.locator(`${s.list} .tw-overview-hits`).innerText(), 'No slides match')
    pass(`${name}: operators, exact phrase and no-match message`)

    // Keyboard: Up/Down through hits in order (wrapping), dim rows skipped, Enter jumps, Esc closes.
    await search.fill('method')
    const highlighted = async () => (await page.locator(`${s.list} .tw-highlight`).innerText()).split('\n')[0].trim()
    assert.equal(await highlighted(), '2. Welcome', `${name}: starts on the first hit`)
    await search.press('ArrowDown')
    assert.equal(await highlighted(), '3. Method notes')
    await search.press('ArrowDown')
    assert.equal(await highlighted(), s.notes ? '6. Closing' : '2. Welcome', `${name}: Down skips the dim rows${s.notes ? '' : ' and wraps'}`)
    await search.press('ArrowUp')
    assert.equal(await highlighted(), '3. Method notes')
    pass(`${name}: Up/Down move through the hits in order`)
    await search.press('ArrowUp')
    await s.enterAndCheck(page, search)
    pass(`${name}: Enter jumps to the highlighted hit and closes`)
    await s.open(page)
    await search.fill('method')
    await search.press('Escape')
    assert.equal(await page.locator(s.drawer).evaluate((el) => el.classList.contains('open')), false, `${name}: Esc closes`)
    pass(`${name}: Esc closes`)
    assert.deepEqual(errors, [], `${name}: no page errors`)
    await page.close()
  }

  const shareCheck = (page) => page.evaluate(() => document.querySelector('.slide.active, section.slide.active')?.dataset.id)
  const share = (notes) => ({
    search: '#navSearch', list: '#navList', drawer: '#navPanel', notes,
    open: async (page) => { await page.locator('#overviewBtn').click(); await page.locator('#navSearch').waitFor() },
    enterAndCheck: async (page, search, title) => {
      await search.press('Enter')
      assert.equal(await page.locator('#navPanel').evaluate((el) => el.classList.contains('open')), false)
      assert.equal(await shareCheck(page), 's1')
    },
  })
  await surface('share page with notes', pathToFileURL(sharePath).href, share(false))
  await surface('share page without notes', pathToFileURL(shareNoNotesPath).href, share(false))

  const presenter = {
    search: '#presenterSearch', list: '#presenterOutline', drawer: '#presenterOutlineDrawer', notes: true,
    open: async (page) => { await page.locator('#outlineBtn').click(); await page.locator('#presenterSearch').waitFor() },
    enterAndCheck: async (page, search) => {
      await search.press('Enter')
      assert.equal(await page.locator('#presenterOutlineDrawer').evaluate((el) => el.classList.contains('open')), false)
      assert.equal(await page.evaluate(() => document.querySelector('.slide.active')?.dataset.id), 's1')
    },
  }
  await surface('presenter view', `${pathToFileURL(deckPath).href}?presenter=1&session=ov2b`, presenter)

  const deck = {
    search: '#overviewSearch', list: '#overviewList', drawer: '#overviewDrawer', notes: false,
    open: async (page) => { await page.locator('#overviewBtn').click().catch(async () => { await page.evaluate(() => document.querySelector('#overviewBtn')?.click()) }); await page.locator('#overviewSearch').waitFor() },
    enterAndCheck: async (page, search) => {
      await search.press('Enter')
      assert.equal(await page.locator('#overviewDrawer').evaluate((el) => el.classList.contains('open')), false)
    },
  }
  await surface('plain deck', pathToFileURL(deckPath).href, deck)
} finally {
  await browser.close()
}
console.log(`test-overview-dom: ${checks} groups passed`)
