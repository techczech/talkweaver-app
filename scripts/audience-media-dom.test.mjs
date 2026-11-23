// Compile a synthetic talk and open its paired audience window through the presenter control.
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { markSlidePreviewHtml } from '../src/shared/slide-preview.ts'

const scratch = await mkdtemp(join(import.meta.dirname, '../.tw-audience-media-'))
const fixture = join(import.meta.dirname, '../e2e/fixtures')
let browser
try {
  await cp(join(fixture, 'audience-media'), scratch, { recursive: true })
  const outline = join(scratch, 'outline.md')
  const model = await prepareSource(outline, await readFile(outline, 'utf8'), null, await stat(outline), {}, {})
  const deck = join(scratch, 'deck.html')
  await writeFile(deck, model.fullHtml)
  const editorDeck = join(scratch, 'editor.html')
  await writeFile(editorDeck, markSlidePreviewHtml(model.fullHtml, { localPages: true }))
  browser = await chromium.launch({ headless: true, args: ['--mute-audio'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  // The actual provider URL is resolved by the compiler. Hold the network boundary here so the
  // regression can run offline and never play third-party audio or depend on a provider's reply.
  await context.route(/^https?:/, route => {
    const url = new URL(route.request().url())
    if (url.hostname === 'www.youtube-nocookie.com' && url.pathname.startsWith('/embed/')) {
      return route.fulfill({ contentType: 'text/html', body: '<title>Offline provider fixture</title>' })
    }
    return route.abort()
  })
  const presenter = await context.newPage()
  const errors = []
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
  presenter.on('pageerror', error => errors.push(error.message))
  await presenter.goto(pathToFileURL(deck).href + '?presenter=1&session=audience-media#open')
  const [audience] = await Promise.all([context.waitForEvent('page'), presenter.keyboard.press('F5')])
  const go = async id => {
    await presenter.evaluate(id => { location.hash = id }, id)
    for (const page of [presenter, audience]) {
      await page.locator(`#stage .slide.active[data-id="${id}"]`).waitFor({ state: 'attached' })
    }
  }
  const report = []
  const check = async (name, run) => {
    try {
      await run()
      console.log('PASS', name)
    } catch (error) {
      report.push(name)
      console.error('FAIL', name, error.message)
    }
  }

  await check('local play, pause and precise seek', async () => {
    await go('local')
    const preview = presenter.frameLocator('#currentPreview > iframe[data-slide-id=local]:not(.preview-incoming)').locator('video[data-tw-playback-watched]')
    const projected = audience.locator('#stage .slide.active video')
    await preview.waitFor()
    await presenter.locator('#presenterMediaPlay').click()
    await audience.waitForFunction(() => document.querySelector('#stage .slide.active video')?.currentTime > 0.25, null, { timeout: 4000 })
    assert(await preview.evaluate(video => !video.paused && video.muted && video.volume === 0))
    assert(await projected.evaluate(video => !video.paused && !video.muted && video.volume > 0))
    await presenter.locator('#presenterMediaPause').click()
    await audience.waitForFunction(() => document.querySelector('#stage .slide.active video')?.paused, null, { timeout: 4000 })
    const owner = presenter.locator('#stage .slide.active video')
    for (const time of [4, 4.15]) {
      await preview.evaluate((video, time) => { video.currentTime = time }, time)
      await audience.waitForFunction(time => {
        const video = document.querySelector('#stage .slide.active video')
        return video.paused && !video.seeking && Math.abs(video.currentTime - time) < 0.035
      }, time, { timeout: 2500 }).catch(async () => {
        const media = await Promise.all([preview, owner, projected].map(locator => locator.evaluate(video => ({
          currentTime: video.currentTime, duration: video.duration, paused: video.paused, seeking: video.seeking,
        }))))
        throw new Error(`seek to ${time}s failed (Current / owner / audience): ${JSON.stringify(media)}`)
      })
    }
  })

  await check('embedded web video loads in both windows', async () => {
    await go('web')
    const player = 'head > title'
    const pane = presenter.frameLocator('#currentPreview > iframe[data-embed-video]')
    const screen = audience.frameLocator('#stage .slide.active iframe[data-embed-video]')
    for (const frame of [pane, screen]) {
      await frame.locator(player).waitFor({ state: 'attached', timeout: 4000 })
      assert.equal(await frame.locator(player).textContent(), 'Offline provider fixture')
    }
  })

  await check('widget startup, styles and scripts agree in the editor, presenter and audience', async () => {
    const editor = await context.newPage()
    const readWidget = frame => frame.locator('body').evaluate(body => ({
      started: window.widgetSizeAtStart,
      size: [innerWidth, innerHeight],
      font: getComputedStyle(body).font,
      background: getComputedStyle(body).backgroundColor,
      canvas: document.querySelector('canvas')?.getContext('2d').getImageData(1, 1, 1, 1).data.join(','),
      output: document.querySelector('output')?.value,
    }))
    for (const id of ['canvas', 'card']) {
      await go(id)
      await editor.goto(pathToFileURL(editorDeck).href + '#' + id)
      const pane = presenter.frameLocator('#currentPreview > iframe[data-embed-local]')
      const screen = audience.frameLocator('#stage .slide.active figure[data-embed="local"] iframe')
      const editorFrame = editor.frameLocator('#stage .slide.active figure[data-embed="local"] iframe')
      for (const frame of [pane, screen, editorFrame]) {
        await frame.locator(id === 'canvas' ? 'canvas' : 'output').waitFor({ timeout: 4000 })
      }
      // The outer presenter iframe lives at deck resolution and its CSS transform scales it
      // visually. Compare the inner layout and the dimensions seen by the widget on startup.
      const [current, projected, authoring] = await Promise.all([pane, screen, editorFrame].map(readWidget))
      console.log(id, JSON.stringify({ current, projected, authoring }))
      assert.deepEqual(projected, current, id + ' presenter')
      assert.deepEqual(projected, authoring, id + ' editor')
      assert.deepEqual(projected.started, projected.size, `${id} started before its final layout`)
      if (id === 'canvas') assert.equal(projected.canvas, '57,100,128,255')
      else assert.equal(projected.output, '0')
    }
  })
  assert.deepEqual(errors, [], 'no runtime errors')
  assert.deepEqual(report, [])
} finally {
  await browser?.close()
  await rm(scratch, { recursive: true, force: true })
}
