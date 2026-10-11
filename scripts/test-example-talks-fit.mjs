// test:example-talks-fit — onboarding 0.38.1 ticket 09: every slide of the five example talks fits.
//
// The compiler's fit warnings (text-too-long and friends) are estimates that do not measure practice
// quotations, so this test measures the real thing: each talk in resources/example-vault/ is compiled
// (prepareSource → model.fullHtml), opened at 1280×720 in chrome-headless-shell (Playwright's headless
// Chromium), and every slide is made the active one in turn. A slide passes when the deck's own fit
// runtime has not marked it too long (data-text-fit) and nothing on it reaches past the slide's
// padding band. Every practice quotation is drawn in the practice style (ticket 05) and its key caps
// are real key caps, not escaped text.
//
// SHOTS=<folder> saves every slide as <talk>-NN-<id>.png, for reading the slides by eye.
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const BUNDLE = join(REPO, 'resources', 'example-vault')
const SHOTS = process.env.SHOTS || ''
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const ONLY = process.env.TALK || ''

const talks = readdirSync(BUNDLE, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
  .map((entry) => entry.name)
  .filter((slug) => !ONLY || slug === ONLY)
  .sort()

const scratch = mkdtempSync(join(tmpdir(), 'tw-example-talks-fit-'))

// Fit state of the active slide, read from the page itself (as scripts/slide-fit-dom.test.mjs reads it).
function readFit(id) {
  const slide = [...document.querySelectorAll('.stage > .slide')].find((s) => s.dataset.id === id)
  if (!slide || !slide.classList.contains('active')) return { active: false }
  const content = slide.querySelector(':scope > .slide-content')
  const scale = slide.getBoundingClientRect().width / slide.offsetWidth
  const cs = getComputedStyle(slide)
  const rect = slide.getBoundingClientRect()
  const bandTop = rect.top + parseFloat(cs.paddingTop) * scale
  const bandBottom = rect.bottom - parseFloat(cs.paddingBottom) * scale
  let top = Infinity
  let bottom = -Infinity
  for (const child of content?.children ?? []) {
    const r = (child.classList.contains('slot') && child.querySelector(':scope > .slot-copy') || child).getBoundingClientRect()
    if (r.height <= 0 || getComputedStyle(child).position === 'absolute') continue
    top = Math.min(top, r.top)
    bottom = Math.max(bottom, r.bottom)
  }
  const quotes = [...slide.querySelectorAll('blockquote')]
  return {
    active: true,
    textFit: content?.dataset.textFit || '',
    overflow: bottom > top ? Math.round(Math.max(0, bottom - bandBottom, bandTop - top) / scale) : 0,
    zoom: Number(content?.style.zoom || 1),
    escapedKbd: slide.innerHTML.includes('&lt;kbd&gt;'),
    practiceQuotes: quotes.filter((q) => q.classList.contains('practice-quote')).length,
    quotesWithCaps: quotes.filter((q) => q.querySelector('kbd.key-cap')).length
  }
}

let passed = 0
const failures = []
const browser = await chromium.launch({ headless: true })
try {
  for (const slug of talks) {
    const path = join(BUNDLE, slug, `${slug}-outline.md`)
    const text = readFileSync(path, 'utf8')
    const model = await prepareSource(path, text, slug, statSync(path))
    const ids = model.slides.map((slide) => slide.id)
    const deck = join(scratch, `${slug}.html`)
    writeFileSync(deck, model.fullHtml, 'utf8')
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })
    page.setDefaultTimeout(8000)
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/*', (route) => (route.request().url().startsWith('file:') || route.request().url().startsWith('data:') ? route.fallback() : route.abort()))
    await page.goto(`${pathToFileURL(deck).href}#${ids[0]}`, { waitUntil: 'load' })
    for (const [index, id] of ids.entries()) {
      await page.evaluate((target) => { if (location.hash !== `#${target}`) location.hash = `#${target}` }, id)
      await page.evaluate(async () => {
        await document.fonts?.ready
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150))))
      })
      const fit = await page.evaluate(readFit, id)
      const name = `${slug} #${index + 1} ${id}`
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${slug}-${String(index + 1).padStart(2, '0')}-${id}.png`) })
      const problems = []
      if (!fit.active) problems.push('did not become the active slide')
      if (fit.textFit === 'too-long') problems.push('marked too long by the fit runtime')
      if (fit.overflow > 0) problems.push(`reaches ${fit.overflow}px past the slide's band`)
      if (fit.escapedKbd) problems.push('shows <kbd> as text')
      if (fit.quotesWithCaps !== fit.practiceQuotes) problems.push(`${fit.quotesWithCaps} quotations with key caps, ${fit.practiceQuotes} in the practice style`)
      if (problems.length) failures.push(`${name}: ${problems.join('; ')}`)
      else passed += 1
      if (process.env.VERBOSE) console.log(`  ${name}: ${JSON.stringify(fit)}`)
    }
    if (errors.length) failures.push(`${slug}: page errors ${errors.join(' | ')}`)
    await page.close()
    console.log(`  ok  ${slug}: ${ids.length} slides measured`)
  }
} finally {
  await browser.close()
  rmSync(scratch, { recursive: true, force: true })
}
for (const failure of failures) console.error(`FAIL  ${failure}`)
assert.equal(failures.length, 0, `${failures.length} slide(s) do not fit`)
console.log(`test:example-talks-fit — ${passed} slides fit, in ${talks.length} talks`)
