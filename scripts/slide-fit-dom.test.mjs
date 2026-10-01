import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractStyles, extractSlides } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { buildVenuePageHtml } from '../compiler/scripts/lib/venue-page.mjs'
import { slideFitRuntimeSource } from '../compiler/scripts/lib/01-cli-utils.mjs'

// HTML parity 02: the slide fit pipeline (compiler/assets/runtime/slide-fit.js) is ONE module the app
// and the share page (handout, /p venue) both inline. The share page scales a 1280×720 canvas with a
// CSS transform, under which getBoundingClientRect() is painted px while clientHeight/scrollHeight
// stay canvas px; the module divides rects by canvasScale(). This gate proves, at that seam:
//   1. the fixture really fits in the app (width step, list ladder, table ladder, carousel zoom);
//   2. the handout at 1280×720 (scale < 1) and 1920×1080 (scale 1.5) and the venue at 1920×1080 end
//      in exactly the app's fit state, with nothing past its band and no word past its card;
//   3. canvasScale reads 1 untransformed and the transform's factor under one.
// Mutation: TW_SLIDE_FIT_NO_SCALE=1 compiles the share page with canvasScale pinned to 1 (the scale
// correction removed). The gate must then fail on its own contract.
const isMutant = process.env.TW_SLIDE_FIT_NO_SCALE === '1' || process.env.TW_SLIDE_FIT_NO_FLOOR === '1'
const isNoFloorMutant = process.env.TW_SLIDE_FIT_NO_FLOOR === '1'
const FLOOR_CHECK = 'if (smallest && smallest * factor < floorPx - 0.01) {'
assert.ok(slideFitRuntimeSource.includes(FLOOR_CHECK), 'the module carries the type-floor check the floor mutation removes')
const SCALE_RETURN = 'return paintedWidth / layoutWidth;'
assert.ok(slideFitRuntimeSource.includes(SCALE_RETURN), 'the module carries the scale correction the mutation removes')

const source = `---
title: Slide fit probe
auto_title_slide: false
auto_thanks_slide: false
defaults: { icons: on }
---

### Cards with a long word {id=cards title=side list narrowcols=off}

- Every TalkWeaver layout in one deck
- The new Wave-1 frame features are called out per slide
- Open in TalkWeaver and step through to see reveals

### A long list {id=long}

- The first point takes one whole line of text on the slide
- The second point is about as long as the first one here
- The third point carries on in the same way as before
- The fourth point keeps the column honest and quite full
- The fifth point is where a plain list starts to run tight
- The sixth point pushes the column past its natural band
- The seventh point is the one the ladder has to make room for
- The eighth point makes sure the type step is reached as well

### A long table {id=table}

| Tool | What it does | When to use it |
| --- | --- | --- |
| Chat | Answers one question at a time in a window | Quick lookups and drafts |
| Projects | Keeps files and instructions together | Repeated work on one topic |
| Research | Reads many sources and writes a report | Questions that need sources |
| Agents | Runs tools in a loop until a task is done | Multi-step work on files |
| Code | Edits a repository and runs its tests | Software changes |
| Search | Finds pages on the web and cites them | Current facts |
| Voice | Talks with you out loud in real time | Hands-free questions |
| Images | Makes and edits pictures from a prompt | Slides and mockups |

### Stepwise cards {id=carousel cards carousel}

#### First

- The card gallery steps one card at a time and this card has many lines.
- A second point that also wraps onto a second line of the card.
- A third point that wraps as well, to make the card tall.
- A fourth point, so the first card is taller than the band.
- A fifth point for good measure, which wraps once more here.

#### Second

Each card is its own beat in presenter view.

### An overfull table {id=over}

| Tool | What it does | When to use it |
| --- | --- | --- |
${Array.from({ length: 3 }, () => [
  '| Chat | Answers one question at a time in a window | Quick lookups and drafts |',
  '| Projects | Keeps files and instructions together | Repeated work on one topic |',
  '| Research | Reads many sources and writes a report | Questions that need sources |',
  '| Agents | Runs tools in a loop until a task is done | Multi-step work on files |',
  '| Code | Edits a repository and runs its tests | Software changes |'
].join('\n')).join('\n')}
`

const IDS = ['cards', 'long', 'table', 'carousel', 'over']
const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-slide-fit-'))
const sourcePath = join(scratch, 'slide-fit.md')
await writeFile(sourcePath, source)
const model = await prepareSource(sourcePath, source, 'slide-fit', statSync(sourcePath))
const full = String(model.fullHtml)
const styles = extractStyles(full)
const slides = extractSlides(full)
const pin = (html) => {
  if (isNoFloorMutant) return html.replace(FLOOR_CHECK, 'if (false) {')
  return isMutant ? html.replace(SCALE_RETURN, 'return 1;') : html
}
const files = {
  app: pin(full),
  handout: pin(buildShareHtml({ title: 'Slide fit probe', slides, styles, includeNotes: false, slug: 'slide-fit', license: null })),
  venue: pin(buildVenuePageHtml({ title: 'Slide fit probe', slides, styles, slug: 'slide-fit', license: null, workerBaseUrl: 'https://live.invalid', liveTalkSlug: 'slide-fit', qr: '', handoutUrl: 'https://handouts.invalid/slide-fit' })),
}
for (const [name, html] of Object.entries(files)) await writeFile(join(scratch, name + '.html'), html)

// Fit state and canvas-px overflow of the active slide, read from the page itself.
function readFit({ id, src }) {
  const slide = [...document.querySelectorAll('.stage > .slide')].find((s) => s.dataset.id === id)
  if (!slide || !slide.classList.contains('active')) return { active: false }
  const content = slide.querySelector(':scope > .slide-content')
  const scale = slide.getBoundingClientRect().width / slide.offsetWidth
  const cs = getComputedStyle(slide)
  const rect = slide.getBoundingClientRect()
  const bandTop = rect.top + parseFloat(cs.paddingTop) * scale
  const bandBottom = rect.bottom - parseFloat(cs.paddingBottom) * scale
  let top = Infinity, bottom = -Infinity
  for (const child of content.children) {
    const r = (child.classList.contains('slot') && child.querySelector(':scope > .slot-copy') || child).getBoundingClientRect()
    if (r.height <= 0 || getComputedStyle(child).position === 'absolute') continue
    top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom)
  }
  const zoom = Number(content.style.zoom || 1)
  // Smallest running text on the slide (canvas px), the floor the whole-slide zoom may not cross.
  let smallest = Infinity
  for (const el of content.querySelectorAll('td, th, li, p, h1, span')) {
    if (el.closest('.footer, .sr-only, .gallery-nav, .kicker, .code-lang') || !el.textContent.trim() || el.children.length && ![...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim())) continue
    { const px = parseFloat(getComputedStyle(el).fontSize); if (px < smallest) { smallest = px; window.__who = el.className + '|' + el.tagName } }
  }
  const words = [...content.querySelectorAll('.feature-list > li, .icon-row > .ir-item')].filter((c) => c.scrollWidth - c.clientWidth > 1).length
  return {
    active: true, scale: Math.round(scale * 1000) / 1000,
    listFit: content.dataset.listFit || '', widthFit: content.dataset.listWidthFit || '',
    vars: ['--fs-body', '--list-lh', '--list-gap'].map((p) => content.style.getPropertyValue(p)).join('|'),
    zoom: Math.round(zoom * 100) / 100,
    textFit: content.dataset.textFit || '', tooTall: Number(content.dataset.textTooTall) || 0,
    smallest: Math.round(smallest * zoom * 100) / 100, who: window.__who, floor: Math.round(slide.clientWidth * 1.9375) / 100,
    overflow: bottom > top ? Math.round(Math.max(0, bottom - bandBottom, bandTop - top) / scale) : 0,
    words,
    // The module's own reading of the canvas scale (a fresh instance of the same source).
    moduleScale: Math.round(new Function(src + '\nreturn createSlideFit();')().canvasScale(content) * 1000) / 1000,
  }
}

const browser = await chromium.launch({ headless: true })
const errors = []
async function measure(name, viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 })
  page.setDefaultTimeout(8000)
  page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`))
  await page.route('**/*', (route) => route.request().url().startsWith('file:') || route.request().url().startsWith('data:') ? route.fallback() : route.abort())
  await page.goto(pathToFileURL(join(scratch, name + '.html')).href + '#' + IDS[0], { waitUntil: 'load' })
  const out = {}
  for (const id of IDS) {
    await page.evaluate((id) => { if (location.hash !== '#' + id) location.hash = '#' + id }, id)
    await page.evaluate(async () => {
      await document.fonts?.ready
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 200))))
    })
    out[id] = await page.evaluate(readFit, { id, src: slideFitRuntimeSource })
    assert.ok(out[id].active, `${name} ${viewport.width}x${viewport.height}: #${id} activates`)
  }
  await page.close()
  return out
}

try {
  const app = await measure('app', { width: 1280, height: 720 })
  // 1. The fixture exercises every fit the share page used to lack (survey cause C1).
  assert.match(app.cards.widthFit, /cqw$/, `app: the card width step engages on the long word (${JSON.stringify(app.cards)})`)
  assert.ok(['leading', 'gap', 'type'].includes(app.long.listFit), `app: the long list spends the ladder (${JSON.stringify(app.long)})`)
  assert.ok(['leading', 'gap', 'type'].includes(app.table.listFit), `app: the long table spends the ladder (${JSON.stringify(app.table)})`)
  // ADR-0033 §1: the whole-slide zoom never takes text below the floor; a slide that still overflows
  // there keeps zoom 1 and is marked too-long with how much too tall it is.
  for (const id of IDS) {
    const got = app[id]
    assert.ok(got.zoom === 1 || got.smallest >= got.floor - 0.05, `app #${id}: zoom ${got.zoom} keeps text at or above the floor (${got.smallest} vs ${got.floor}, ${got.who})`)
  }
  assert.equal(app.over.zoom, 1, `app: an overfull table keeps zoom 1 (${JSON.stringify(app.over)})`)
  assert.equal(app.over.textFit, 'too-long', 'app: an overfull table is marked data-text-fit=too-long')
  assert.ok(app.over.tooTall >= 20, `app: the overfull table reports how much too tall it is (${app.over.tooTall}%)`)
  assert.ok(app.over.smallest >= app.over.floor - 0.05, `app: the overfull table stays at the floor (${app.over.smallest} vs ${app.over.floor})`)
  assert.equal(app.long.textFit, '', 'app: a slide that fits is not marked')
  assert.equal(app.cards.words, 0, 'app: after the width step every word sits inside its card')
  assert.equal(app.long.moduleScale, 1, 'app: canvasScale is exactly 1 on an untransformed stage')

  const runs = [['handout', { width: 1280, height: 720 }], ['handout', { width: 1920, height: 1080 }], ['venue', { width: 1920, height: 1080 }]]
  for (const [name, viewport] of runs) {
    const got = await measure(name, viewport)
    const at = `${name} ${viewport.width}x${viewport.height}`
    for (const id of IDS) {
      const a = app[id], h = got[id]
      // 3. The module reads the canvas scale the share page applied.
      assert.ok(h.scale !== 1, `${at}: the canvas is transformed (${h.scale})`)
      assert.equal(h.moduleScale, h.scale, `${at} #${id}: canvasScale reads the transform`)
      // 2. Same fit state as the app, measured on the same 1280-wide canvas.
      assert.equal(h.listFit, a.listFit, `${at} #${id}: list ladder matches the app (${h.listFit} vs ${a.listFit}; ${h.vars} vs ${a.vars})`)
      assert.equal(h.widthFit, a.widthFit, `${at} #${id}: width step matches the app`)
      assert.equal(h.vars, a.vars, `${at} #${id}: fitted tokens match the app`)
      assert.ok(Math.abs(h.zoom - a.zoom) <= 0.01, `${at} #${id}: zoom matches the app (${h.zoom} vs ${a.zoom})`)
      assert.equal(h.textFit, a.textFit, `${at} #${id}: too-long mark matches the app`)
      if (id !== 'carousel' && id !== 'over') assert.ok(h.overflow <= 1, `${at} #${id}: nothing past its band (${h.overflow} canvas px)`)
      assert.equal(h.words, a.words, `${at} #${id}: no word past its card (${h.words} vs app ${a.words})`)
    }
  }
  assert.deepEqual(errors, [], 'no runtime errors')
} finally {
  await browser.close()
  await rm(scratch, { recursive: true, force: true })
}

if (!isMutant) {
  const floorChild = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', fileURLToPath(import.meta.url)], {
    env: { ...process.env, TW_SLIDE_FIT_NO_FLOOR: '1' }, encoding: 'utf8',
  })
  assert.notEqual(floorChild.status, 0, 'with the type-floor check removed the gate fails')
  assert.match(floorChild.stdout + floorChild.stderr, /keeps zoom 1|too-long|floor/, `floor mutant fails on the floor contract:\n${(floorChild.stdout + floorChild.stderr).slice(-1500)}`)
  console.log('slide fit mutation (type-floor check removed): FAILS as required')
  const child = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', fileURLToPath(import.meta.url)], {
    env: { ...process.env, TW_SLIDE_FIT_NO_SCALE: '1' }, encoding: 'utf8',
  })
  assert.notEqual(child.status, 0, 'with the scale correction removed the gate fails')
  assert.match(child.stdout + child.stderr, /match(?:es)? the app|past its band|past its card/, `mutant fails on the fit contract, not elsewhere:\n${(child.stdout + child.stderr).slice(-1500)}`)
  console.log('slide fit mutation (canvasScale pinned to 1): FAILS as required')
}
console.log(isMutant
  ? 'slide fit (mutant): PASS — this must not happen'
  : `slide fit: ${IDS.length} slides — handout (1280x720, 1920x1080) and venue (1920x1080) fit exactly as the app`)
