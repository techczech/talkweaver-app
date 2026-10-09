// Current-pane composition and shared stage zoom at the compiled-deck seam. Headless only.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
const dir = await mkdtemp(join(tmpdir(), 'tw-embed-stage-'))
const outline = `---\ntitle: Embedded stage\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Page and words\n{id=page}\n\n- Words beside the page\n\n[Embed: page.html]\n\n### Page alone\n{id=alone}\n\n[Simulation: page.html]\n\n### Picture and words\n{id=picture}\n\n- Words beside a picture\n\n![Picture](picture.svg)\n\n### Both\n{id=both}\n\n![Picture](picture.svg)\n\n[Embed: page.html]\n\n### End\n{id=end}\n\n- Done\n`
const path = join(dir, 'outline.md')
await writeFile(path, outline)
await writeFile(join(dir, 'picture.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="red"/></svg>')
await writeFile(join(dir, 'page.html'), '<!doctype html><title>Stateful page</title><style>body{height:3000px}</style><button id="count">Count</button><input id="text"><output id="n">0</output><script>window.loads=1;document.getElementById("count").onclick=()=>document.getElementById("n").textContent=Number(document.getElementById("n").textContent)+1</script>')
const prepared = await prepareSource(path, outline, null, await stat(path), {}, {})
const server = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(prepared.fullHtml) })
let browser
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript(() => { if (window === window.top) navigator.sendBeacon = () => false })
  const presenter = await context.newPage()
  const errors = []
  presenter.on('pageerror', e => errors.push(e.message))
  await presenter.goto(`http://127.0.0.1:${server.address().port}/?presenter=1&session=stage#page`)
  await presenter.waitForSelector('#currentPreview .live-sim-frame')
  await presenter.mouse.click(3, 3)
  const [audience] = await Promise.all([context.waitForEvent('page'), presenter.keyboard.press('F5')])
  await audience.waitForLoadState('load')
  const live = async p => {
    for (let i = 0; i < 100; i++) {
      for (const f of p.frames()) if (f !== p.mainFrame() && await f.evaluate(() => document.title === 'Stateful page').catch(() => false)) return f
      await new Promise(r => setTimeout(r, 50))
    }
    throw new Error('live page missing')
  }
  const pf = await live(presenter), af = await live(audience)
  assert.equal((await presenter.frameLocator('#currentPreview > iframe:not(.live-sim-frame)').locator('h1,h2').first().textContent()).replace(/\s/g, ' '), 'Page and words')
  assert.equal((await presenter.frameLocator('#currentPreview > iframe:not(.live-sim-frame)').locator('li').first().textContent()).replace(/\s/g, ' '), 'Words beside the page')
  assert.equal(await presenter.locator('#currentPreview .live-sim-frame').count(), 1)
  const ratio = p => p.evaluate(() => { const s=document.querySelector('.slide.active .slot'); return s ? [...getComputedStyle(s).gridTemplateColumns.split(' ')].map(parseFloat) : null })
  // The page works IN ITS PLACE: the one frame lies over the labelled box's place in the slide picture.
  const PICTURE = '#currentPreview > iframe:not(.live-sim-frame)'
  const close = (a, b, what, tol = 2) => { for (const k of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(a[k] - b[k]) <= tol, `${what}: ${k} ${a[k]} vs ${b[k]}`) }
  const placed = async (what) => {
    await presenter.waitForFunction((sel) => {
      const f = document.querySelector('#currentPreview .live-sim-frame'), p = document.querySelector(sel)
      const slot = p?.contentDocument?.querySelector('figure.slide-embed iframe')
      if (!f || !slot) return false
      const a = f.getBoundingClientRect(), pr = p.getBoundingClientRect(), s = slot.getBoundingClientRect(), k = pr.width / 1280
      return Math.abs(a.x - pr.x - s.x * k) < 2 && Math.abs(a.y - pr.y - s.y * k) < 2 && Math.abs(a.width - s.width * k) < 2 && Math.abs(a.height - s.height * k) < 2
    }, PICTURE, { timeout: 5000 }).catch(() => { throw new Error(`${what}: the pane frame is not on the page's place in the slide`) })
  }
  await placed('first paint')
  const frameBox = await presenter.locator('#currentPreview .live-sim-frame').boundingBox(), pictureBox = await presenter.locator(PICTURE).boundingBox()
  assert.ok(frameBox.width < pictureBox.width * 0.75 && frameBox.width > pictureBox.width * 0.5, `the page takes its 70% place, not the pane (${frameBox.width} of ${pictureBox.width})`)
  close(await presenter.locator('#currentPreview .live-sim-cover').boundingBox(), frameBox, 'the cover lies on the page')
  // The page is laid out at the slide's own size and scaled, as the audience sees it.
  assert.ok(Math.abs(await pf.evaluate(() => innerWidth) - frameBox.width * 1280 / pictureBox.width) < 2, 'the pane page has its slide-size viewport')
  // Next shows the labelled box, never a second running page; the box is in the Current picture too.
  let running = 0
  for (const f of presenter.frames()) if (await f.evaluate(() => document.title === 'Stateful page').catch(() => false)) running += 1
  assert.equal(running, 1, 'one running page in the presenter window')
  assert.equal(await presenter.locator('#nextPreview .live-sim-frame').count(), 0)
  assert.equal(await presenter.frameLocator('#nextPreview > iframe').locator('.embed-poster').count(), 1, 'Next shows the labelled box')
  // The frame is the sandboxed pane frame: the slide frame's own tokens and permissions.
  const tokens = p => p.evaluate(() => { const f = document.querySelector('#currentPreview iframe.live-sim-frame') || document.querySelector('.slide.active figure.slide-embed iframe'); return [f.getAttribute('sandbox'), f.getAttribute('allow')] })
  const before = [await tokens(presenter), await tokens(audience)]
  assert.deepEqual(before[0], before[1], 'pane and audience frames carry the same sandbox and allow')
  assert.ok(before[0][0] && !/allow-same-origin/.test(before[0][0]), `sandboxed (${before[0][0]})`)
  const button = presenter.locator('#presenterEmbedFullscreen')
  assert.equal(await button.count(), 1)
  assert.equal(await button.getAttribute('data-tip'), 'Embedded page: full screen')
  assert.equal(await button.locator('svg.tw-ico').count(), 1, 'the button carries its lucide icon')
  // The button lies inside the page's top-right corner and never over the slide's title.
  const within = (b, f, what) => assert.ok(b.x >= f.x - 1 && b.y >= f.y - 1 && b.x + b.width <= f.x + f.width + 1 && b.y + b.height <= f.y + f.height + 1, `${what}: ${JSON.stringify(b)} not inside ${JSON.stringify(f)}`)
  { const b = await button.boundingBox(), t = await presenter.frameLocator(PICTURE).locator('h1,h2').first().boundingBox()
    within(b, frameBox, 'the button is inside the page frame')
    assert.ok(b.x > frameBox.x + frameBox.width / 2 && b.y < frameBox.y + frameBox.height / 2, 'the button is in the top-right corner')
    assert.ok(b.x >= t.x + t.width || b.x + b.width <= t.x || b.y >= t.y + t.height || b.y + b.height <= t.y, `the button does not cover the title (${JSON.stringify(b)} vs ${JSON.stringify(t)})`) }
  const columns = await ratio(audience)
  assert.ok(Math.abs(Math.max(...columns) / Math.min(...columns) - 7 / 3) < .02, `page/text ratio ${columns}`)
  const point = async () => {
    await presenter.mouse.click(3, 3)
    await presenter.keyboard.press('i')
    const preview = await presenter.locator('#currentPreview > iframe:not(.live-sim-frame)').boundingBox()
    await presenter.mouse.move(preview.x + preview.width * .6, preview.y + preview.height * .7)
    await audience.waitForFunction(() => {
      const ring = document.querySelector('.tw-pointer-ring circle'), stage = document.querySelector('.stage')
      const r = ring.getBoundingClientRect(), b = stage.getBoundingClientRect()
      return getComputedStyle(ring.parentElement).display !== 'none' && Math.abs(r.x+r.width/2-b.x-b.width*.6)<1 && Math.abs(r.y+r.height/2-b.y-b.height*.7)<1
    })
    const ring = await presenter.locator('.tw-pointer-ring circle').first().boundingBox()
    assert.ok(Math.abs(ring.x+ring.width/2-preview.x-preview.width*.6)<1)
    assert.ok(Math.abs(ring.y+ring.height/2-preview.y-preview.height*.7)<1)
    await presenter.keyboard.press('Escape')
  }
  await point()
  // Load events are counted on the frame elements, outside the embedded document, so a reload shows.
  await presenter.evaluate(() => { window.frameLoads=0; window.savedFrame=document.querySelector('#currentPreview .live-sim-frame'); window.savedFrame.addEventListener('load', () => { window.frameLoads++ }) })
  await audience.evaluate(() => { window.frameLoads=0; window.savedFrame=document.querySelector('.slide.active figure.slide-embed iframe'); window.savedFrame.addEventListener('load', () => { window.frameLoads++ }) })
  await presenter.keyboard.press('r')
  await presenter.frameLocator('#currentPreview > iframe:not(.live-sim-frame)').locator('.slide.mode-reveal').waitFor()
  await presenter.keyboard.press('r')
  await placed('after the slide picture was redrawn')
  await presenter.locator('#currentPreview .live-sim-cover').click()
  await pf.locator('#count').click()
  await pf.locator('#text').fill('kept')
  await af.waitForFunction(() => document.getElementById('n').textContent === '1' && document.getElementById('text').value === 'kept')
  await presenter.mouse.click(3, 3)
  await presenter.keyboard.press('z')
  await audience.waitForSelector('.slide.active.embed-full-screen')
  for (const p of [presenter, audience]) assert.equal(await p.evaluate(() => window.savedFrame === (document.querySelector('#currentPreview iframe.live-sim-frame') || document.querySelector('.slide.active figure.slide-embed iframe'))), true, 'same frame across zoom')
  assert.equal(await pf.locator('#text').inputValue(), 'kept')
  const bounds = await audience.locator('.slide.active figure.slide-embed iframe').boundingBox(), stage = await audience.locator('.stage').boundingBox()
  for (const k of ['x','y','width','height']) assert.ok(Math.abs(bounds[k]-stage[k]) < 1, `audience page ${k} equals the stage's (${bounds[k]} vs ${stage[k]})`)
  assert.deepEqual(await audience.evaluate(() => { const c = getComputedStyle(document.querySelector('.slide.active figure.slide-embed iframe')); return [c.borderTopWidth, c.borderTopLeftRadius] }), ['0px', '0px'], 'the full-screen page has no border and no rounded corners')
  within(await button.boundingBox(), await presenter.locator('#currentPreview .live-sim-frame').boundingBox(), 'the button is inside the full-screen page')
  close(await presenter.locator('#currentPreview .live-sim-frame').boundingBox(), await presenter.locator(PICTURE).boundingBox(), 'the pane page covers the whole slide picture')
  assert.equal(await button.getAttribute('aria-pressed'), 'true')
  // The slide stage, not the system's full screen; no new permission, no new document.
  for (const p of [presenter, audience]) assert.equal(await p.evaluate(() => document.fullscreenElement), null)
  assert.deepEqual([await tokens(presenter), await tokens(audience)], before, 'sandbox and allow unchanged by full screen')
  for (const p of [presenter, audience]) assert.equal(await p.evaluate(() => window.frameLoads), 0, 'the page frame was not reloaded')
  assert.equal(await af.locator('#text').inputValue(), 'kept')
  // The open outline takes Esc before the page full screen does; the next Esc restores the slide.
  await presenter.keyboard.press('o')
  await presenter.waitForFunction(() => document.getElementById('presenterOutlineDrawer').classList.contains('open'))
  await presenter.mouse.click(3, 3) // focus off the outline's search box, as when the person clicks the deck
  await presenter.keyboard.press('Escape')
  await presenter.waitForFunction(() => !document.getElementById('presenterOutlineDrawer').classList.contains('open'))
  assert.equal(await audience.locator('.embed-full-screen').count(), 1, 'Esc on the outline does not end full screen')
  await presenter.keyboard.press('Escape')
  await audience.waitForFunction(() => !document.querySelector('.embed-full-screen'))
  await presenter.keyboard.press('z')
  await audience.waitForSelector('.slide.active.embed-full-screen')
  // The same, with focus on a BUTTON inside the outline: that Esc closes only the outline.
  await presenter.keyboard.press('o')
  await presenter.waitForFunction(() => document.getElementById('presenterOutlineDrawer').classList.contains('open'))
  await presenter.evaluate(() => document.querySelector('#presenterOutlineDrawer .presenter-outline-expand').focus())
  assert.equal(await presenter.evaluate(() => document.activeElement.tagName), 'BUTTON', 'focus is on an outline button')
  await presenter.keyboard.press('Escape')
  await presenter.waitForFunction(() => !document.getElementById('presenterOutlineDrawer').classList.contains('open'))
  assert.equal(await audience.locator('.embed-full-screen').count(), 1, 'Esc with an outline button focused closes only the outline')
  await presenter.keyboard.press('Escape')
  await audience.waitForFunction(() => !document.querySelector('.embed-full-screen'))
  await presenter.keyboard.press('z')
  await audience.waitForSelector('.slide.active.embed-full-screen')
  // A sheet over the presenter takes Esc first; the page stays full screen.
  await presenter.keyboard.press('?')
  await presenter.locator('#twShortcuts:not([hidden])').waitFor()
  await presenter.keyboard.press('Escape')
  await presenter.locator('#twShortcuts').waitFor({ state: 'hidden' })
  assert.equal(await audience.locator('.embed-full-screen').count(), 1, 'Esc on the shortcut sheet does not end full screen')
  await point()
  await presenter.locator('#currentPreview .live-sim-cover').click()
  await pf.locator('#count').click()
  await af.waitForFunction(() => document.getElementById('n').textContent === '2')
  const box = await presenter.locator('#currentPreview .live-sim-frame').boundingBox()
  await presenter.mouse.move(box.x+box.width/2, box.y+box.height/2)
  await presenter.mouse.wheel(0, 450)
  await pf.waitForFunction(() => scrollY > 100)
  await af.waitForFunction(() => scrollY > 100)
  await presenter.keyboard.press('Escape') // disengage only
  await presenter.waitForFunction(() => !document.getElementById('currentPreview').classList.contains('embed-engaged'))
  assert.equal(await audience.locator('.embed-full-screen').count(), 1)
  await presenter.keyboard.press('Escape') // restore slide
  await audience.waitForFunction(() => !document.querySelector('.embed-full-screen'))
  await placed('back on the slide')
  for (const p of [presenter, audience]) assert.equal(await p.evaluate(() => window.savedFrame === (document.querySelector('#currentPreview iframe.live-sim-frame') || document.querySelector('.slide.active figure.slide-embed iframe'))), true, 'same frame after the slide is put back')
  for (const p of [presenter, audience]) assert.equal(await p.evaluate(() => window.frameLoads), 0, 'the page frame was not reloaded on the way back')
  await presenter.keyboard.press('Meta+Shift+p')
  await presenter.locator('#presenterCommandSearch').fill('Embedded page: full screen')
  await presenter.keyboard.press('Enter')
  await audience.waitForSelector('.embed-full-screen')
  await presenter.keyboard.press('Escape')
  await audience.waitForFunction(() => !document.querySelector('.embed-full-screen'))
  await presenter.keyboard.press('?')
  assert.ok((await presenter.locator('#twShortcutsBody').textContent()).includes('Embedded page: full screen'))
  await presenter.keyboard.press('Escape')
  await presenter.locator('#presenterEmbedFullscreen').click()
  await audience.waitForSelector('.embed-full-screen')
  await presenter.keyboard.press('ArrowRight')
  await audience.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'alone')
  assert.equal(await audience.locator('.embed-full-screen').count(), 0)
  assert.equal(await audience.locator('.slide.active .slot').count(), 0, 'page without body unchanged')
  // Title and page only: the pane shows the title and the page; full screen covers the stage here too.
  await presenter.waitForSelector('#currentPreview .live-sim-frame')
  assert.equal((await presenter.frameLocator(PICTURE).locator('h1,h2').first().textContent()).replace(/\s/g, ' ').trim(), 'Page alone')
  await placed('title and page')
  await presenter.mouse.click(3, 3)
  await presenter.keyboard.press('z')
  await audience.waitForSelector('.slide.active.embed-full-screen')
  { const b = await audience.locator('.slide.active figure.slide-embed iframe').boundingBox(), st = await audience.locator('.stage').boundingBox(); close(b, st, 'title-and-page slide: the page fills the stage') }
  await presenter.keyboard.press('z')
  await audience.waitForFunction(() => !document.querySelector('.embed-full-screen'))
  await presenter.keyboard.press('ArrowRight')
  await audience.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'picture')
  const pictureColumns = await ratio(audience)
  assert.ok(Math.max(...pictureColumns)/Math.min(...pictureColumns) < 3, 'picture proportions unchanged')
  await presenter.keyboard.press('ArrowRight')
  await presenter.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'both')
  await presenter.keyboard.press('z')
  await audience.waitForSelector('#lightbox.open')
  assert.equal(await audience.locator('.embed-full-screen').count(), 0, 'Z stays with picture when both exist')
  assert.deepEqual(errors, [])
  console.log('PASS Current chrome and one live page; 70/30 only page+copy; shared stage zoom retains frame/state, mirroring and real wheel; two Esc presses; leaving clears; picture keeps Z')
  await context.close()
} finally { await browser?.close(); await new Promise(r => server.close(r)); await rm(dir,{recursive:true,force:true}) }
