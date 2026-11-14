// A `[Simulation:]` / `[Embed:]` page starts at its frame's real size (owner report on 0.44.0:
// "some of the widgets did not show up in the presentation audience window until I expanded them
// full screen"). The deck gave a page its document in the same turn as its slide stopped being
// display:none, so the page's script saw a 0x0 viewport and the real size then arrived with no
// resize event: a page that sized its canvas at start-up stayed blank until something resized it.
// Pages here paint only through their own code, sized from innerWidth/innerHeight when they start
// (once; with a resize handler; in a carousel card shown later; behind a reveal step). Checked in
// the deck as every presenting window runs it (the plain single-file deck: the audience window runs
// the same syncLocalEmbeds) and on the share page (handout, online page), after navigating to the
// slide and after loading on it: the page saw a non-zero size at start, and the pixels at the
// frame's centre are its colour. Headless bundled Chromium.
// Usage: node scripts/widget-start-size-dom.test.mjs   (TW_HEADLESS_SHELL=<path> to use another shell;
// TW_COMPILER_ROOT=<checkout> to compile with another checkout's compiler)
import { statSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
// TW_COMPILER_ROOT=<another checkout> compiles with that checkout's compiler (to show the fault on a release).
const compilerRoot = process.env.TW_COMPILER_ROOT ? resolve(process.env.TW_COMPILER_ROOT) : root
const lib = (name) => import(pathToFileURL(join(compilerRoot, 'compiler/scripts/lib', name)).href)
const { prepareSource } = await lib('08-source-adapters.mjs')
const { buildShareHtml } = await lib('09-output-builders.mjs')
const { extractSlides, extractStyles } = await lib('04-html-extraction.mjs')
const scratch = await mkdtemp(join(root, '.tw-widget-start-size-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))
const hardLimit = setTimeout(() => { console.error('widget-start-size: hard limit reached'); process.exit(2) }, 120000)

// A canvas filling the page's viewport as the page measures it; `start` decides when it is sized and painted.
const canvasPage = (name, color, start) => `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title><style>html,body{margin:0;height:100%;background:#fff;overflow:hidden}canvas{display:block}</style></head><body><canvas id="c"></canvas><script>window.__w={atStart:[innerWidth,innerHeight],drawn:false};const cv=document.getElementById("c");function size(){cv.width=innerWidth;cv.height=innerHeight}function paint(){const g=cv.getContext("2d");g.fillStyle=${JSON.stringify(`rgb(${color.join(',')})`)};g.fillRect(0,0,cv.width,cv.height);__w.drawn=cv.width>0&&cv.height>0}${start}</script></body></html>`
const PAGES = {
  'w-once': { file: 'once.html', color: [250, 100, 0], start: 'size();paint()' },
  'w-resize': { file: 'resize.html', color: [0, 120, 90], start: 'size();paint();addEventListener("resize",()=>{size();paint()})' },
  'w-card': { file: 'card page.html', color: [90, 90, 200], start: 'size();paint()' },
  'w-reveal': { file: 'reveal-ü.html', color: [160, 120, 20], start: 'size();paint()' },
}
await mkdir(join(scratch, 'widgets'))
for (const p of Object.values(PAGES)) await writeFile(join(scratch, 'widgets', p.file), canvasPage(p.file, p.color, p.start))
const outline = `---
title: Widget start size
auto_title_slide: false
auto_thanks_slide: false
---

### Opening {id=open}

- A plain slide first

### Sized once {id=w-once}

[Simulation: widgets/once.html]

### Follows resizes {id=w-resize}

[Simulation: widgets/resize.html]

### Carousel {id=w-card}
{carousel}

#### Card one

- Card one text

#### Card two

[Simulation: widgets/card page.html]

### Behind a reveal step {id=w-reveal}
{reveal}

- First point

[Simulation: widgets/reveal-ü.html]

### End {id=end}

- Done
`
const outlinePath = join(scratch, 'outline.md')
await writeFile(outlinePath, outline)
const model = await prepareSource(outlinePath, outline, null, statSync(outlinePath), {}, {})
const deckFile = join(scratch, 'deck.html')
await writeFile(deckFile, model.fullHtml)
const shareFile = join(scratch, 'share.html')
await writeFile(shareFile, buildShareHtml({ title: 'Widget start size', slug: 'widget-start-size', includeNotes: false, license: null, styles: extractStyles(model.fullHtml), slides: extractSlides(model.fullHtml) }))

const failures = []
let checks = 0
const check = (ok, label) => { checks++; if (!ok) failures.push(label); console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`) }

// The shown page of the active slide: what it measured at start, and the pixel at its frame's centre.
async function shownPage(page, slideId) {
  const handle = await page.waitForFunction((id) => {
    const slide = document.querySelector(`.slide[data-id="${id}"]`)
    const frames = [...(slide?.querySelectorAll('figure.slide-embed[data-embed="local"] > iframe') || [])]
    return frames.find((f) => f.hasAttribute('srcdoc') && f.getBoundingClientRect().width > 0) || null
  }, slideId, { timeout: 5000 }).catch(() => null)
  const frame = handle && handle.asElement()
  if (!frame) return { error: 'no loaded frame with a size' }
  const inner = await frame.contentFrame()
  await inner.waitForFunction(() => window.__w && window.__w.drawn, null, { timeout: 2000 }).catch(() => {})
  await page.waitForTimeout(300)
  const w = await inner.evaluate(() => window.__w || null)
  const box = await frame.boundingBox()
  const shot = await page.screenshot({ clip: { x: box.x + box.width / 2, y: box.y + box.height / 2, width: 1, height: 1 } })
  const { default: sharp } = await import('sharp')
  const { data } = await sharp(shot).raw().toBuffer({ resolveWithObject: true })
  return { atStart: w?.atStart, drawn: w?.drawn, pixel: [data[0], data[1], data[2]] }
}
const matches = (pixel, color) => Boolean(pixel && pixel.every((v, k) => Math.abs(v - color[k]) < 40))

// Steps the active slide forward until its page is in view (a carousel's second card, a reveal step).
async function stepUntilShown(page, slideId, advance) {
  for (let i = 0; i < 6; i++) {
    const shown = await page.evaluate((id) => {
      const f = document.querySelector(`.slide.active[data-id="${id}"] figure.slide-embed > iframe`)
      return Boolean(f && f.checkVisibility() && !f.closest('[data-mode-state="hidden"], .hidden-fragment'))
    }, slideId)
    if (shown) return true
    await advance()
    await page.waitForTimeout(250)
  }
  return false
}

let browser
try {
  browser = await chromium.launch({ headless: true, ...(process.env.TW_HEADLESS_SHELL ? { executablePath: process.env.TW_HEADLESS_SHELL } : {}) })
  const surfaces = [
    ['deck', pathToFileURL(deckFile).href, (page) => page.keyboard.press('ArrowRight')],
    ['share page', pathToFileURL(shareFile).href, (page) => page.keyboard.press('ArrowRight')],
  ]
  for (const [surface, url, advance] of surfaces) {
    for (const arrival of ['navigated to', 'loaded on']) {
      for (const [slideId, spec] of Object.entries(PAGES)) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
        page.on('pageerror', (e) => failures.push(`${surface}: page error ${e.message}`))
        if (arrival === 'navigated to') {
          await page.goto(url + '#open')
          await page.waitForTimeout(400)
          await page.evaluate((id) => { location.hash = '#' + id }, slideId)
        } else {
          await page.goto(url + '#' + slideId)
        }
        await page.waitForTimeout(400)
        const reached = await stepUntilShown(page, slideId, () => advance(page))
        const seen = reached ? await shownPage(page, slideId) : { error: 'the page never came into view' }
        const label = `${surface}, ${arrival} ${slideId}`
        check(Boolean(seen.atStart && seen.atStart[0] > 0 && seen.atStart[1] > 0), `${label}: the page starts at its frame's size (saw ${JSON.stringify(seen.atStart ?? seen.error)})`)
        check(Boolean(seen.drawn) && matches(seen.pixel, spec.color), `${label}: the page is drawn without any interaction (pixel ${JSON.stringify(seen.pixel)})`)
        await page.close()
      }
    }
  }
} finally {
  await browser?.close().catch(() => {})
  clearTimeout(hardLimit)
}
console.log(`\nwidget start size: ${checks - failures.length}/${checks} passed`)
if (failures.length) { console.log(failures.map((f) => '  - ' + f).join('\n')); process.exit(1) }
