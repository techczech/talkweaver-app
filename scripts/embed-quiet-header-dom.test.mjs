// A quiet (nav-only, {notitle}) header must never take the media slot's height: the embedded page
// stays inside the slide on the audience screen, in the presenter's Current pane and in Next.
// Synthetic talk, headless Chromium, three audience sizes. Regression for the 0.43.0-alpha.5 widget
// slides whose frame started at y = slide height and was clipped away everywhere.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const dir = await mkdtemp(join(tmpdir(), 'tw-quiet-header-'))
const outline = `---
title: Quiet header containment
auto_title_slide: false
auto_thanks_slide: false
---

### Start
{id=start}

- A plain slide before the widgets

### Dashboard map {notitle}
{id=dash} {titlelook=default}
[Embed: page.html]

### Second report {notitle}
{id=report}
[Embed: page.html]

### Picture only {notitle}
{id=pic}

![A red square](picture.svg)

### Widget with a title
{id=titled}
[Embed: page.html]
`
const path = join(dir, 'outline.md')
await writeFile(path, outline)
await writeFile(join(dir, 'picture.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="red"/></svg>')
await writeFile(join(dir, 'page.html'), '<!doctype html><title>Synthetic widget</title><body style="margin:0;background:#fde"><h1>Widget</h1><p>Visible content</p></body>')
const prepared = await prepareSource(path, outline, null, await stat(path), {}, {})
const server = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(prepared.fullHtml) })
let browser
const inside = (inner, outer, what, tol = 1.5) => assert.ok(
  inner.width > 8 && inner.height > 8 && inner.x >= outer.x - tol && inner.y >= outer.y - tol && inner.x + inner.width <= outer.x + outer.width + tol && inner.y + inner.height <= outer.y + outer.height + tol,
  `${what}: ${JSON.stringify(inner)} is not inside ${JSON.stringify(outer)}`)
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript(() => { if (window === window.top) navigator.sendBeacon = () => false })
  const presenter = await context.newPage()
  const errors = []
  presenter.on('pageerror', e => errors.push(e.message))
  await presenter.goto(`http://127.0.0.1:${server.address().port}/?presenter=1&session=quiet#start`)
  await presenter.waitForSelector('#currentPreview > iframe')
  await presenter.mouse.click(3, 3)
  const [audience] = await Promise.all([context.waitForEvent('page'), presenter.keyboard.press('F5')])
  await audience.waitForLoadState('load')
  audience.on('pageerror', e => errors.push(e.message))
  const go = async id => {
    await presenter.evaluate(id => { location.hash = id }, id)
    await presenter.waitForFunction(id => document.querySelector('#stage .slide.active')?.dataset.id === id, id)
    await audience.waitForFunction(id => document.querySelector('#stage .slide.active')?.dataset.id === id, id)
    await presenter.waitForTimeout(500)
  }
  const PICTURE = '#currentPreview > iframe:not(.live-sim-frame)'
  for (const [w, h] of [[1024, 768], [1280, 720], [1920, 1080]]) {
    await audience.setViewportSize({ width: w, height: h })
    for (const id of ['dash', 'report']) {
      const what = `${id} at ${w}x${h}`
      await go('start')
      // Next shows the widget's labelled box inside its own preview.
      const nextBox = await presenter.locator('#nextPreview > iframe').boundingBox()
      await presenter.waitForFunction(() => document.querySelector('#nextPreview > iframe')?.contentDocument?.querySelector('figure.slide-embed'))
      const nextSlot = await presenter.frameLocator('#nextPreview > iframe').locator('figure.slide-embed').boundingBox()
      inside(nextSlot, nextBox, `Next, ${what}`)
      await go(id)
      // Audience: the frame lies inside the stage, and the quiet header is still there for navigation.
      const stage = await audience.locator('#stage').boundingBox()
      const frame = await audience.locator('#stage .slide.active figure.slide-embed iframe').boundingBox()
      inside(frame, stage, `audience frame, ${what}`)
      assert.ok(frame.width * frame.height > stage.width * stage.height * 0.4, `audience frame is most of the slide, ${what}`)
      const head = await audience.evaluate(() => {
        const e = document.querySelector('#stage .slide.active .slide-head-quiet'); const r = e.getBoundingClientRect()
        return { h: r.height, text: e.querySelector('h1')?.textContent.trim(), srOnly: getComputedStyle(e.querySelector('h1')).position }
      })
      assert.ok(head.h < 2, `the quiet header takes no height (${head.h}), ${what}`)
      assert.ok(head.text && head.srOnly === 'absolute', `the quiet header keeps its screen-reader title, ${what}`)
      // Current: the live frame lies over the slide picture, inside the pane, at the slot's place.
      await presenter.waitForSelector('#currentPreview .live-sim-frame')
      await presenter.waitForFunction(sel => {
        const f = document.querySelector('#currentPreview .live-sim-frame'), p = document.querySelector(sel)
        const slot = p?.contentDocument?.querySelector('figure.slide-embed iframe')
        if (!f || !slot) return false
        const a = f.getBoundingClientRect(), pr = p.getBoundingClientRect(), s = slot.getBoundingClientRect(), k = pr.width / 1280
        return Math.abs(a.x - pr.x - s.x * k) < 2 && Math.abs(a.y - pr.y - s.y * k) < 2 && Math.abs(a.width - s.width * k) < 2 && Math.abs(a.height - s.height * k) < 2
      }, PICTURE, { timeout: 5000 }).catch(() => { throw new Error(`Current frame is not at the slot's place, ${what}`) })
      inside(await presenter.locator('#currentPreview .live-sim-frame').boundingBox(), await presenter.locator('#currentPreview').boundingBox(), `Current frame, ${what}`)
      // Z toggle keeps the frame inside both surfaces.
      await presenter.mouse.click(3, 3)
      await presenter.keyboard.press('z')
      await audience.waitForSelector('.slide.active.embed-full-screen')
      inside(await audience.locator('#stage .slide.active figure.slide-embed iframe').boundingBox(), await audience.locator('#stage').boundingBox(), `audience frame in Z, ${what}`)
      inside(await presenter.locator('#currentPreview .live-sim-frame').boundingBox(), await presenter.locator('#currentPreview').boundingBox(), `Current frame in Z, ${what}`)
      await presenter.keyboard.press('z')
      await audience.waitForFunction(() => !document.querySelector('.embed-full-screen'))
      // A resize of the presenter window refits Current to the same place.
      await presenter.setViewportSize({ width: 1300, height: 820 })
      await presenter.waitForTimeout(400)
      inside(await presenter.locator('#currentPreview .live-sim-frame').boundingBox(), await presenter.locator('#currentPreview').boundingBox(), `Current frame after resize, ${what}`)
      await presenter.setViewportSize({ width: 1440, height: 900 })
      await presenter.waitForTimeout(300)
    }
  }
  // A picture-only {notitle} slide: same header, same zero footprint.
  await audience.setViewportSize({ width: 1280, height: 720 })
  await go('pic')
  assert.ok(await audience.evaluate(() => document.querySelector('#stage .slide.active .slide-head-quiet').getBoundingClientRect().height < 2), 'the quiet header of a picture-only slide takes no height')
  // A titled widget keeps its heading above the page.
  await go('titled')
  { const t = await audience.locator('#stage .slide.active h1').boundingBox(), f = await audience.locator('#stage .slide.active figure.slide-embed iframe').boundingBox()
    inside(f, await audience.locator('#stage').boundingBox(), 'titled widget frame')
    assert.ok(t.height > 10, 'the visible title is painted') }
  assert.deepEqual(errors, [], 'no page errors')
  console.log('embed-quiet-header-dom: the widget stays inside the slide on the audience screen, Current and Next at 1024x768, 1280x720 and 1920x1080')
} finally {
  await browser?.close()
  server.close()
  await rm(dir, { recursive: true, force: true })
}
