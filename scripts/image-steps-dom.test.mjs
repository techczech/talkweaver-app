// 0.38 ticket 03 — "Step through images" in a real presenter + projector pair (ADR-0034).
// The presenter is driven with the keyboard; every assertion reads the PROJECTOR window: the slide
// it shows, its lightbox state (the same `{open,index}` the venue screen is sent), the image it
// enlarges and the label under it.
//   1. four images: Next runs all → 1 → 2 → 3 → 4 → all again → next slide; Back reverses it from
//      any point; a label shows only where the image has one;
//   2. one image beside text: as placed → zoomed → as placed → next;
//   3. a full-bleed image: no step;
//   4. {reveal} plus images: the reveal steps first, then the images;
//   5. Esc during the sequence closes the zoom at "as laid out again", so the next Next moves on;
//   6. a video between two images is not a stop;
//   7. a jump from the outline closes the zoomed view;
//   8. setting off: Next goes straight on and Z still browses by hand; {no-image-steps} under a
//      talk that has the setting on behaves the same, and so does {nostep} (nothing steps there,
//      images included).
//   9. the handout / venue runtime lists a slide's zoomables in the deck's order (figures, then
//      image-grid cells), because the venue screen is sent the deck's lightbox index.
// Headless Chromium only (never the installed Chrome).
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const dir = await mkdtemp(join(tmpdir(), 'tw-image-steps-dom-'))
await mkdir(join(dir, 'assets'), { recursive: true })
for (const name of ['a', 'b', 'c', 'd']) await writeFile(join(dir, 'assets', `${name}.png`), PNG)
await writeFile(join(dir, 'assets', 'clip.mp4'), Buffer.alloc(64))

const slides = (token) => [
  '### Start', '{id=start}', '', '- Words only', '',
  '### Four', `${token} {id=four}`, '', '![First](assets/a.png "The first label")', '![Second](assets/b.png)', '![Third](assets/c.png "The third label")', '![Fourth](assets/d.png)', '',
  '### One', `${token} {id=one}`, '', '- A point', '- Another point', '', '![Solo](assets/a.png)', '',
  '### Bleed', `${token} {media} {id=bleed}`, '', '![Whole](assets/b.png)', '',
  '### Steps', `${token} {reveal} {id=steps}`, '', '- A', '- B', '', '![R1](assets/a.png)', '![R2](assets/b.png)', '',
  '### Mixed', `${token} {id=mixed}`, '', '![M1](assets/a.png)', '![](assets/clip.mp4)', '![M2](assets/b.png)', '',
  '### End', '{id=end}', '', '- Words only', ''
]
const build = async (name, frontmatter, token) => {
  const outline = ['---', 'title: Image steps', 'auto_title_slide: false', 'auto_thanks_slide: false', ...frontmatter, '---', '', ...slides(token)].join('\n')
  const path = join(dir, `${name}.md`)
  await writeFile(path, outline, 'utf8')
  return (await prepareSource(path, outline, null, await stat(path), {}, {})).fullHtml
}
const decks = {
  // The setting off for the talk; each slide switches it on.
  '/on.html': await build('on', [], '{image-steps}'),
  // Nothing set anywhere: today's behaviour.
  '/unset.html': await build('unset', [], ''),
  // The talk has it on; each slide switches it off.
  '/off.html': await build('off', ['image_steps: true'], '{no-image-steps}'),
  // The talk has it on and no slide says otherwise.
  '/talk.html': await build('talk', ['image_steps: true'], ''),
  // The talk has it on; every slide is {nostep}: no stepping at all, the images included.
  '/nostep.html': await build('nostep', ['image_steps: true'], '{nostep}')
}

const server = createServer((req, res) => {
  const path = req.url.split('?')[0]
  if (decks[path]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(decks[path]); return }
  if (path.startsWith('/assets/') && path.endsWith('.png')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return }
  res.writeHead(404); res.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ headless: true })
let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`) } catch (error) { failures += 1; console.error(`FAIL ${name}\n  ${error.stack || error}`) }
}

/** What a window shows now. */
const view = (page) => page.evaluate(() => {
  const box = document.getElementById('lightbox')
  const open = Boolean(box) && !box.hidden && box.classList.contains('open')
  const focus = document.documentElement.dataset.twLiveFocus
  return {
    slide: document.querySelector('.slide.active')?.dataset.id ?? null,
    lightbox: JSON.parse(document.documentElement.dataset.twLiveLightbox || 'null'),
    zoomed: open ? document.getElementById('lightboxImg').alt : null,
    label: open ? document.getElementById('lightboxCaption').textContent : null,
    step: focus ? JSON.parse(focus).step : null
  }
})

async function pair(deck) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
  const session = `image-steps-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const presenter = await context.newPage()
  const projector = await context.newPage()
  for (const page of [presenter, projector]) page.on('pageerror', (error) => { failures += 1; console.error(`FAIL page error: ${error.message}`) })
  await projector.goto(`${origin}${deck}?audience=1&session=${session}`, { waitUntil: 'load' })
  await presenter.goto(`${origin}${deck}?presenter=1&session=${session}`, { waitUntil: 'load' })
  await presenter.waitForSelector('#presenterRoot, .presenter-root')
  let presses = 0
  /** Press a key in the presenter, wait until the projector has applied that state, return its view. */
  const press = async (key) => {
    presses += 1
    await presenter.keyboard.press(key)
    const sent = await presenter.evaluate(() => ({
      slide: document.querySelector('.slide.active')?.dataset.id ?? null,
      lightbox: document.documentElement.dataset.twLiveLightbox,
      focus: document.documentElement.dataset.twLiveFocus || ''
    }))
    await projector.waitForFunction((want) => document.querySelector('.slide.active')?.dataset.id === want.slide
      && document.documentElement.dataset.twLiveLightbox === want.lightbox
      && (document.documentElement.dataset.twLiveFocus || '') === want.focus, sent, { timeout: 5000 })
    const shown = await view(projector)
    // The presenter publishes the very state the projector shows (it is what the venue screen is sent).
    assert.deepEqual(JSON.parse(sent.lightbox), shown.lightbox, `press ${presses} (${key}): presenter and projector agree on the lightbox`)
    return shown
  }
  const next = () => press('ArrowRight')
  const back = () => press('ArrowLeft')
  return { context, presenter, projector, press, next, back }
}
const at = (shown) => ({ slide: shown.slide, lightbox: shown.lightbox, zoomed: shown.zoomed })
const laidOut = (slide, index = 0) => ({ slide, lightbox: { open: false, index }, zoomed: null })
const zoom = (slide, index, alt) => ({ slide, lightbox: { open: true, index }, zoomed: alt })

try {
  // ── Setting on for each slide ({image-steps}; the talk leaves it unset) ─────────────────────
  {
    const { context, presenter, projector, press, next, back } = await pair('/on.html')
    assert.deepEqual(at(await view(projector)), laidOut('start'))

    await check('four images: Next runs all → 1 → 2 → 3 → 4 → all again → next slide', async () => {
      assert.deepEqual(at(await next()), laidOut('four'), 'the slide as laid out')
      const first = await next()
      assert.deepEqual(at(first), zoom('four', 0, 'First'))
      assert.equal(first.label, 'The first label', 'a labelled image shows its label')
      const second = await next()
      assert.deepEqual(at(second), zoom('four', 1, 'Second'))
      assert.equal(second.label, '', 'an image without a label shows none')
      const third = await next()
      assert.deepEqual(at(third), zoom('four', 2, 'Third'))
      assert.equal(third.label, 'The third label')
      assert.deepEqual(at(await next()), zoom('four', 3, 'Fourth'))
      assert.deepEqual(at(await next()), laidOut('four', 4), 'all again: the zoom is closed and the slide is still Four')
      assert.deepEqual(at(await next()), laidOut('one'), 'then the next slide')
    })

    await check('four images: Back reverses it, also from the middle', async () => {
      assert.deepEqual(at(await back()), laidOut('four', 4), 'Back from the next slide lands on "all again"')
      assert.deepEqual(at(await back()), zoom('four', 3, 'Fourth'))
      assert.deepEqual(at(await back()), zoom('four', 2, 'Third'))
      assert.deepEqual(at(await next()), zoom('four', 3, 'Fourth'), 'Next from the middle goes forward again')
      assert.deepEqual(at(await back()), zoom('four', 2, 'Third'))
      assert.deepEqual(at(await back()), zoom('four', 1, 'Second'))
      assert.deepEqual(at(await back()), zoom('four', 0, 'First'))
      assert.deepEqual(at(await back()), laidOut('four'), 'back to the slide as laid out')
      assert.deepEqual(at(await back()), laidOut('start'), 'then the previous slide')
    })

    await check('Esc during the sequence leaves the slide at "all again": the next Next moves on', async () => {
      assert.deepEqual(at(await next()), laidOut('four'))
      assert.deepEqual(at(await next()), zoom('four', 0, 'First'))
      assert.deepEqual(at(await next()), zoom('four', 1, 'Second'))
      assert.deepEqual(at(await press('Escape')), laidOut('four', 4), 'Esc closes the zoom; the slide stays')
      assert.deepEqual(at(await next()), laidOut('one'), 'Next does not start the images over')
    })

    await check('one image beside text: as placed → zoomed → as placed → next, and back', async () => {
      const solo = await next()
      assert.deepEqual(at(solo), zoom('one', 0, 'Solo'))
      assert.equal(solo.label, '', 'alt text is not a label')
      assert.deepEqual(at(await next()), laidOut('one', 1))
      assert.deepEqual(at(await next()), laidOut('bleed'))
      assert.deepEqual(at(await back()), laidOut('one', 1))
      assert.deepEqual(at(await back()), zoom('one', 0, 'Solo'))
      assert.deepEqual(at(await next()), laidOut('one', 1))
      assert.deepEqual(at(await next()), laidOut('bleed'))
    })

    await check('a full-bleed image does not step, and Z still enlarges it by hand', async () => {
      assert.equal(await projector.evaluate(() => Boolean(document.querySelector('.slide.active > .slide-content.layout-media > figure.slide-figure img'))), true,
        'the compiler laid the lone image out full-bleed')
      assert.deepEqual(at(await press('z')), zoom('bleed', 0, 'Whole'))
      assert.deepEqual(at(await press('Escape')), laidOut('bleed'))
      assert.deepEqual(at(await next()), laidOut('steps'), 'Next goes straight to the next slide')
      assert.deepEqual(at(await back()), laidOut('bleed'), 'and Back straight back')
      await next()
    })

    await check('{reveal} plus images: the reveal steps run first, then the images', async () => {
      let shown = await view(projector)
      assert.deepEqual(at(shown), laidOut('steps'))
      assert.equal(shown.step, 0, 'the slide arrives with nothing revealed')
      const revealSteps = []
      for (let i = 0; i < 12; i += 1) {
        shown = await next()
        if (shown.lightbox.open) break
        assert.equal(shown.slide, 'steps', 'no slide change before the images')
        revealSteps.push(shown.step)
      }
      assert(revealSteps.length >= 2, `the reveal steps ran first (${revealSteps})`)
      assert.deepEqual(revealSteps, revealSteps.map((_, i) => i + 1), 'one reveal step per Next')
      const full = revealSteps.at(-1)
      assert.deepEqual(at(shown), zoom('steps', 0, 'R1'), 'then the first image')
      assert.equal(shown.step, full, 'the slide stays fully revealed behind the zoom')
      assert.deepEqual(at(await next()), zoom('steps', 1, 'R2'))
      shown = await next()
      assert.deepEqual(at(shown), laidOut('steps', 2), 'the slide again')
      assert.equal(shown.step, full, 'fully revealed')
      assert.equal(await projector.evaluate(() => document.querySelectorAll('.slide.active [data-mode-state="hidden"]').length), 0, 'nothing is hidden again')
      assert.deepEqual(at(await next()), laidOut('mixed'))
      // Back: the slide again (fully revealed) → images in reverse → the slide → un-reveal.
      shown = await back()
      assert.deepEqual(at(shown), laidOut('steps', 2))
      assert.equal(shown.step, full, 'entered backwards, the slide is fully revealed')
      assert.deepEqual(at(await back()), zoom('steps', 1, 'R2'))
      assert.deepEqual(at(await back()), zoom('steps', 0, 'R1'))
      shown = await back()
      assert.deepEqual(at(shown), laidOut('steps'))
      assert.equal(shown.step, full)
      shown = await back()
      assert.deepEqual(at(shown), laidOut('steps'))
      assert.equal(shown.step, full - 1, 'then Back undoes the reveal steps')
      // Forward again to the end of the slide for the next check.
      for (let i = 0; i < 12 && (await view(projector)).slide === 'steps'; i += 1) await next()
      assert.equal((await view(projector)).slide, 'mixed')
    })

    await check('a video between two images is not part of the sequence', async () => {
      assert.deepEqual(await projector.evaluate(() => [...document.querySelectorAll('.slide.active figure.slide-figure img, .slide.active figure.slide-figure video')].map((el) => el.tagName)),
        ['IMG', 'VIDEO', 'IMG'], 'the slide holds image, video, image')
      assert.deepEqual(at(await next()), zoom('mixed', 0, 'M1'))
      assert.deepEqual(at(await next()), zoom('mixed', 2, 'M2'), 'the video (position 1) is skipped')
      assert.deepEqual(at(await next()), laidOut('mixed', 3))
      assert.deepEqual(at(await back()), zoom('mixed', 2, 'M2'))
      assert.deepEqual(at(await back()), zoom('mixed', 0, 'M1'))
      assert.equal(await projector.evaluate(() => document.querySelectorAll('.lightbox-video').length), 0, 'the video never reached the zoomed view')
    })

    await check('a jump from the outline closes the zoomed view', async () => {
      assert.equal((await view(projector)).zoomed, 'M1')
      // A slide-addressed jump (what an outline click and Home / End run).
      await presenter.evaluate(() => { location.hash = 'four' })
      await projector.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'four')
      const shown = await view(projector)
      assert.deepEqual(at(shown), laidOut('four'), 'the zoom is closed and the slide starts as laid out')
      assert.deepEqual(at(await view(presenter)), laidOut('four'))
      assert.deepEqual(at(await next()), zoom('four', 0, 'First'), 'its sequence starts from the first image')
    })
    await context.close()
  }

  // ── Setting off (nothing set), and switched off per slide under a talk that has it on ───────
  for (const [deck, why] of [['/unset.html', 'setting off'], ['/off.html', '{no-image-steps} under a talk that has it on']]) {
    const { context, projector, press, next, back } = await pair(deck)
    await check(`${why}: Next and Back move slide to slide, exactly as before`, async () => {
      const seen = []
      for (let i = 0; i < 12; i += 1) {
        const shown = await next()
        if (shown.lightbox.open) throw new Error(`Next opened the zoomed view on ${shown.slide}`)
        if (seen.at(-1) !== shown.slide) seen.push(shown.slide)
        if (shown.slide === 'end') break
      }
      assert.deepEqual(seen, ['four', 'one', 'bleed', 'steps', 'mixed', 'end'])
      for (const slide of ['mixed', 'steps']) assert.deepEqual(at(await back()), laidOut(slide))
    })
    await check(`${why}: Z still enlarges by hand, arrows browse every zoomable, Esc closes`, async () => {
      for (let i = 0; i < 12 && (await view(projector)).slide !== 'four'; i += 1) await back()
      assert.deepEqual(at(await view(projector)), laidOut('four'))
      assert.deepEqual(at(await press('z')), zoom('four', 0, 'First'))
      assert.deepEqual(at(await next()), zoom('four', 1, 'Second'))
      assert.deepEqual(at(await next()), zoom('four', 2, 'Third'))
      assert.deepEqual(at(await next()), zoom('four', 3, 'Fourth'))
      assert.deepEqual(at(await next()), zoom('four', 3, 'Fourth'), 'the last image holds: the gallery never leaves the slide')
      assert.deepEqual(at(await back()), zoom('four', 2, 'Third'))
      assert.deepEqual(at(await press('Escape')), laidOut('four', 2), 'Esc closes where it was')
      assert.deepEqual(at(await next()), laidOut('one'), 'and Next goes to the next slide')
    })
    await context.close()
  }

  // ── {nostep} under a talk that has the setting on ────────────────────────────────────
  {
    const { context, next } = await pair('/nostep.html')
    await check('{nostep}: the image sequence has no stops — Next goes straight to the next slide', async () => {
      for (const want of ['four', 'one', 'bleed', 'steps', 'mixed', 'end']) {
        const shown = await next()
        assert.deepEqual(at(shown), laidOut(want), `Next lands on ${want} with the zoom closed`)
      }
    })
    await context.close()
  }

  // ── The talk-level key alone ──────────────────────────────────────────────────────────────
  {
    const { context, next } = await pair('/talk.html')
    await check('image_steps: true in the talk steps every slide with images', async () => {
      assert.deepEqual(at(await next()), laidOut('four'))
      assert.deepEqual(at(await next()), zoom('four', 0, 'First'))
    })
    await context.close()
  }

  // ── The share runtime (handout, phone, venue) addresses the same list ─────────────────────
  await check('the handout runtime lists figures then image-grid cells, as the deck does', async () => {
    const dot = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"
    const slide = `<section class="slide" data-id="grid" data-image-steps><h1>Grid</h1>`
      + `<figure class="slide-figure"><img src="${dot}" alt="Figure"></figure>`
      + `<div class="image-grid"><div class="ig-cell"><div class="ig-media"><img src="${dot}" alt="Cell"></div><div class="ig-note"><h4>Cell note</h4></div></div></div></section>`
    const sharePath = join(dir, 'share.html')
    await writeFile(sharePath, buildShareHtml({ title: 'Share', slug: 'share', includeNotes: false, license: null, styles: '', slides: [{ html: slide, notes: '' }] }))
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    page.on('pageerror', (error) => { failures += 1; console.error(`FAIL share page error: ${error.message}`) })
    await page.goto(`file://${sharePath}`, { waitUntil: 'load' })
    await page.locator('.slide.active[data-id="grid"]').waitFor()
    await page.keyboard.press('z')
    await page.locator('.lightbox:visible #lightboxImg[alt="Figure"]').waitFor()
    assert.equal(await page.locator('#lightboxCounter').textContent(), '1 / 2')
    await page.keyboard.press('ArrowRight')
    await page.locator('.lightbox:visible #lightboxImg[alt="Cell"]').waitFor()
    assert.equal(await page.locator('#lightboxCaption').textContent(), 'Cell note')
    // The handout does not step: the data-image-steps stamp means nothing to it, and Esc closes.
    await page.keyboard.press('Escape')
    await page.locator('.lightbox').waitFor({ state: 'hidden' })
    await page.close()
  })
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
if (failures > 0) { console.error(`${failures} image-steps DOM check(s) failed`); process.exit(1) }
console.log('PASS image-steps DOM: four images, one image, full-bleed, reveal first, Esc, video skipped, outline jump, setting off, {nostep}')
