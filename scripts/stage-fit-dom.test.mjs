import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { stageFitRuntimeSource } from '../compiler/scripts/lib/01-cli-utils.mjs'

// HTML parity 03 / ADR-0030: the app's slide views scale ONE fixed canvas. The presentation window
// (plain and ?audience=1) lays every slide out on the 1280×720 stage and createStageFit
// (compiler/assets/runtime/stage-fit.js) scales it uniformly into the window, centred, letterboxed
// in the slide background; the presenter's previews run the projector's fit pipeline on the same
// canvas. This gate proves, at that seam:
//   1. at every window size and shape the stage keeps its 1280×720 layout box, is scaled by
//      min(W/1280, H/720), centred, and nothing is cropped (a 4:3 and a 21:9 window letterbox);
//   2. the composition does not change with the window: every title and list row has the same
//      canvas-px box, and the slide the same fit state, as at 1280×720 (survey cause C4);
//   3. the letterbox takes the active slide's background;
//   4. the presenter's Current preview lands each slide in the projector's fit state and boxes.
// Mutation: TW_STAGE_FIT_NO_SCALE=1 compiles the deck with the scale pinned to 1. The gate must then
// fail on its own scale contract.
const isMutant = process.env.TW_STAGE_FIT_NO_SCALE === '1'
const SCALE_LINE = 'const scale = Math.min(availW / width, availH / height);'
assert.ok(stageFitRuntimeSource.includes(SCALE_LINE), 'the module carries the scale the mutation pins')

const source = `---
title: Stage fit probe
auto_title_slide: false
auto_thanks_slide: false
---

## Part one {id=part}

### A title long enough to wrap differently in a wider content column than the canvas {id=wide title=top}

- The first point is long enough to wrap onto a second line of the slide column
- The second point is as long as the first and wraps in the same place
- A third point, shorter

### A long list {id=long}

- The first point takes one whole line of text on the slide
- The second point is about as long as the first one here
- The third point carries on in the same way as before
- The fourth point keeps the column honest and quite full
- The fifth point is where a plain list starts to run tight
- The sixth point pushes the column past its natural band
- The seventh point is the one the ladder has to make room for
- The eighth point makes sure the type step is reached as well
`

const IDS = ['part', 'wide', 'long']
const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-stage-fit-'))
const sourcePath = join(scratch, 'stage-fit.md')
await writeFile(sourcePath, source)
const model = await prepareSource(sourcePath, source, 'stage-fit', statSync(sourcePath))
let html = String(model.fullHtml)
assert.ok(html.includes(SCALE_LINE), 'the compiled deck inlines the stage fit runtime')
if (isMutant) html = html.replace(SCALE_LINE, 'const scale = 1;')
const htmlPath = join(scratch, 'stage-fit.html')
await writeFile(htmlPath, html)
const url = pathToFileURL(htmlPath).href

// Stage geometry, fit state and canvas-px boxes of the active slide, read from the page itself.
// Works in the deck and inside a preview iframe (whose stage has no id).
function readStage(id) {
  const stage = document.querySelector('.stage')
  const slide = [...stage.querySelectorAll(':scope > .slide')].find((s) => s.dataset.id === id)
  if (!slide || !slide.classList.contains('active')) return { active: false }
  const rect = stage.getBoundingClientRect()
  const scale = rect.width / stage.offsetWidth
  const content = slide.querySelector(':scope > .slide-content')
  const r1 = (n) => Math.round(n * 10) / 10
  const boxes = [...content.querySelectorAll('h1:not(.sr-only), li')].map((el) => {
    const r = el.getBoundingClientRect()
    return [el.tagName.toLowerCase(), r1((r.left - rect.left) / scale), r1((r.top - rect.top) / scale), r1(r.width / scale), r1(r.height / scale)]
  })
  return {
    active: true,
    layout: [stage.offsetWidth, stage.offsetHeight],
    painted: [rect.left, rect.top, rect.width, rect.height].map(r1),
    window: [innerWidth, innerHeight],
    scale: Math.round(scale * 10000) / 10000,
    fit: [content.dataset.listFit || '', content.dataset.listWidthFit || '', ['--fs-body', '--list-lh', '--list-gap'].map((p) => content.style.getPropertyValue(p)).join('|'), content.style.zoom || '1'].join(' '),
    boxes,
    letterbox: getComputedStyle(stage.parentElement).backgroundColor,
    slideBg: getComputedStyle(slide).backgroundColor,
  }
}
const settle = (page) => page.evaluate(async () => {
  await document.fonts?.ready
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 200))))
})

const browser = await chromium.launch({ headless: true })
const errors = []
async function project(viewport, query = '') {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 })
  page.setDefaultTimeout(8000)
  page.on('pageerror', (error) => errors.push(`${viewport.width}x${viewport.height}${query}: ${error.message}`))
  await page.route('**/*', (route) => /^(file|data|blob|about):/.test(route.request().url()) ? route.fallback() : route.abort())
  await page.goto(`${url}${query}#${IDS[0]}`, { waitUntil: 'load' })
  const out = {}
  for (const id of IDS) {
    await page.evaluate((id) => { if (location.hash !== '#' + id) location.hash = '#' + id }, id)
    await settle(page)
    out[id] = await page.evaluate(readStage, id)
    assert.ok(out[id].active, `${viewport.width}x${viewport.height}${query}: #${id} activates`)
  }
  await page.close()
  return out
}

try {
  const base = await project({ width: 1280, height: 720 })
  assert.ok(['leading', 'gap', 'type'].includes(base.long.fit.split(' ')[0]), `1280x720: the long list spends the ladder (${base.long.fit})`)
  assert.ok(base.wide.boxes.filter(([t]) => t === 'h1')[0][4] > 80, '1280x720: the long title wraps onto more than one line')

  const runs = [[{ width: 1920, height: 1080 }, ''], [{ width: 1920, height: 1080 }, '?audience=1'], [{ width: 1024, height: 768 }, ''], [{ width: 2560, height: 1080 }, ''], [{ width: 1280, height: 720 }, '?audience=1']]
  for (const [viewport, query] of runs) {
    const got = await project(viewport, query)
    const at = `${viewport.width}x${viewport.height}${query}`
    const want = Math.min(viewport.width / 1280, viewport.height / 720)
    for (const id of IDS) {
      const g = got[id], b = base[id]
      // 1. One fixed canvas, scaled uniformly, centred, never cropped.
      assert.deepEqual(g.layout, [1280, 720], `${at} #${id}: the stage keeps its 1280x720 layout box`)
      assert.ok(Math.abs(g.scale - want) < 0.001, `${at} #${id}: the stage scales the canvas by ${want.toFixed(4)} (got ${g.scale})`)
      const [left, top, w, h] = g.painted
      assert.ok(left >= -0.5 && top >= -0.5 && left + w <= viewport.width + 0.5 && top + h <= viewport.height + 0.5, `${at} #${id}: nothing is cropped (${g.painted})`)
      assert.ok(Math.abs(left - (viewport.width - w) / 2) <= 1 && Math.abs(top - (viewport.height - h) / 2) <= 1, `${at} #${id}: the canvas is centred and letterboxed (${g.painted})`)
      // 2. The composition is the 1280×720 composition.
      assert.equal(g.fit, b.fit, `${at} #${id}: fit state matches 1280x720`)
      assert.equal(g.boxes.length, b.boxes.length, `${at} #${id}: same blocks`)
      g.boxes.forEach((box, i) => assert.ok(box.slice(1).every((v, k) => Math.abs(v - b.boxes[i][k + 1]) <= 1), `${at} #${id}: ${box[0]} ${i} keeps its canvas box (${box} vs ${b.boxes[i]})`))
    }
    // 3. The letterbox is the slide background.
    assert.notEqual(got.part.slideBg, 'rgba(0, 0, 0, 0)', 'the section slide paints its own background')
    assert.equal(got.part.letterbox, got.part.slideBg, `${at}: the letterbox takes the section slide's background`)
    assert.equal(got.wide.letterbox, 'rgba(0, 0, 0, 0)', `${at}: a transparent slide leaves the page background to show`)
  }

  // 4. The presenter's Current preview: the projector's fit state and boxes on the same canvas.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  page.setDefaultTimeout(8000)
  page.on('pageerror', (error) => errors.push(`presenter: ${error.message}`))
  await page.goto(`${url}?presenter=1#${IDS[0]}`, { waitUntil: 'load' })
  for (const id of IDS) {
    await page.evaluate((id) => { if (location.hash !== '#' + id) location.hash = '#' + id }, id)
    const frame = await (await page.waitForFunction((id) => {
      const f = document.querySelector('#currentPreview iframe')
      return f?.contentDocument?.readyState === 'complete' && f.contentDocument.querySelector(`.slide.active[data-id="${id}"]`) ? f : null
    }, id)).asElement().contentFrame()
    await settle(frame)
    const p = await frame.evaluate(readStage, id)
    const b = base[id]
    assert.deepEqual(p.layout, [1280, 720], `preview #${id}: the preview lays the slide out on the 1280x720 canvas`)
    assert.equal(p.fit, b.fit, `preview #${id}: fit state matches the projector (${p.fit} vs ${b.fit})`)
    p.boxes.forEach((box, i) => assert.ok(box.slice(1).every((v, k) => Math.abs(v - b.boxes[i][k + 1]) <= 1), `preview #${id}: ${box[0]} ${i} keeps the projector's box (${box} vs ${b.boxes[i]})`))
  }
  await page.close()
  assert.deepEqual(errors, [], 'no runtime errors')
} finally {
  await browser.close()
  await rm(scratch, { recursive: true, force: true })
}

if (!isMutant) {
  const child = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', fileURLToPath(import.meta.url)], {
    env: { ...process.env, TW_STAGE_FIT_NO_SCALE: '1' }, encoding: 'utf8',
  })
  assert.notEqual(child.status, 0, 'with the scale pinned to 1 the gate fails')
  assert.match(child.stdout + child.stderr, /scales the canvas by/, `mutant fails on the scale contract, not elsewhere:\n${(child.stdout + child.stderr).slice(-1500)}`)
  console.log('stage fit mutation (scale pinned to 1): FAILS as required')
}
console.log(isMutant
  ? 'stage fit (mutant): PASS — this must not happen'
  : `stage fit: ${IDS.length} slides — 1920x1080, audience, 4:3 and 21:9 windows scale the 1280x720 canvas with the 1280x720 composition; letterbox in the slide background; presenter preview fits as the projector`)
