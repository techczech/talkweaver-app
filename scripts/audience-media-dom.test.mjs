// Compile a synthetic talk and open its paired audience window through the presenter control.
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
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
  context.setDefaultTimeout(10000)
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
  const go = async id => {
    await presenter.evaluate(id => { location.hash = id }, id)
    for (const page of [presenter, audience].filter(Boolean)) {
      await page.locator(`#stage .slide.active[data-id="${id}"]`).waitFor({ state: 'attached' })
    }
  }
  let audience
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

  const owner = presenter.locator('#stage .slide.active video')
  const previewFrame = presenter.locator('#currentPreview > iframe[data-slide-id=local]:not(.preview-incoming)')
  const preview = previewFrame.contentFrame()
  const visibleVideo = preview.locator('video')
  const videoBar = root => root.getByRole('group', { name: 'Video playback' })
  async function waitForVideo(video, predicate, expected, label, timeout = 3500) {
    const handle = await video.elementHandle()
    try {
      await (await handle.ownerFrame()).waitForFunction(predicate, { el: handle, ...expected }, { timeout, polling: 30 })
    } catch (error) {
      const state = await handle.evaluate(el => ({
        time: el.currentTime, duration: el.duration, paused: el.paused, muted: el.muted,
        volume: el.volume, seeking: el.seeking, ready: el.readyState,
      }))
      throw new Error(label + ' — ' + JSON.stringify(state), { cause: error })
    } finally {
      await handle.dispose()
    }
  }
  async function singleFootBar(video, label) {
    await waitForVideo(video, ({ el }) => {
      const bar = el.parentElement.querySelector('.tw-video-seek')
      if (!bar || el.controls || bar.hidden) return false
      const clip = el.getBoundingClientRect()
      const chrome = bar.getBoundingClientRect()
      const enlarge = el.parentElement.querySelector('.video-enlarge')
      return clip.width > 0 && chrome.height > 0 && chrome.top >= clip.top - 1 &&
        Math.abs(clip.left - chrome.left) < 1.5 && Math.abs(clip.right - chrome.right) < 1.5 &&
        Math.abs(clip.bottom - chrome.bottom) < 1.5 &&
        (!enlarge || getComputedStyle(enlarge).display === 'none')
    }, {}, label + ' has one transport at the video foot')
    const bar = video.locator('..').getByRole('group', { name: 'Video playback' })
    assert.equal(await bar.count(), 1)
    assert.equal(await bar.getByRole('button', { name: 'Back to start' }).locator('svg').count(), 1)
    assert.match(await bar.evaluate(el => getComputedStyle(el).backgroundImage), /^linear-gradient/)
  }
  async function atTogether(time, ...players) {
    for (const [index, video] of players.entries()) {
      await waitForVideo(video, ({ el, time }) => !el.seeking && Math.abs(el.currentTime - time) < 0.035,
        { time }, 'seek to ' + time + 's on player ' + (index + 1))
    }
  }
  async function audioState(video, muted, playing, label, timeout) {
    await waitForVideo(video, ({ el, muted, playing }) => el.muted === muted && (muted ? el.volume === 0 : el.volume > 0) &&
      (!playing || (!el.paused && el.currentTime > 0)), { muted, playing }, label, timeout)
  }

  await check('video controls, precise seek and audio handoff', async () => {
    await go('local')
    await visibleVideo.waitFor()
    await presenter.locator('#presenterMediaPlay').click()
    await audioState(owner, false, true, 'presenter audible before opening audience')
    await audioState(visibleVideo, true, true, 'Current plays as a silent mirror')
    ;[audience] = await Promise.all([context.waitForEvent('page'), presenter.keyboard.press('F5')])
    const projected = audience.locator('#stage .slide.active video')
    await audioState(projected, false, true, 'audience audible after joining mid-clip')
    assert(await owner.evaluate(el => el.muted && el.volume === 0), 'owner is already silent when audience receives sound')
    await audioState(visibleVideo, true, true, 'Current stays silent with audience open')
    await audience.close()
    audience = null
    await audioState(owner, false, true, 'presenter sound returns after closing audience', 1200)
    ;[audience] = await Promise.all([context.waitForEvent('page'), presenter.keyboard.press('F5')])
    const projection = audience.locator('#stage .slide.active')
    const audienceVideo = projection.locator('video')
    await audioState(audienceVideo, false, true, 'audience audible again after reopening')
    assert(await owner.evaluate(el => el.muted && el.volume === 0), 'owner silent again')
    await presenter.locator('#presenterMediaPause').click()
    await audience.waitForFunction(() => document.querySelector('#stage .slide.active video')?.paused)
    assert.equal(await previewFrame.evaluate(frame => getComputedStyle(frame).pointerEvents), 'auto')
    assert.equal(await previewFrame.getAttribute('aria-hidden'), null)
    await singleFootBar(visibleVideo, 'Presenter Current')
    await singleFootBar(audienceVideo, 'Audience')
    const bar = videoBar(preview)
    assert.equal(await bar.getByRole('button', { name: 'Back to start' }).getAttribute('title'), 'Back to start (0)')
    assert.match(await bar.getByRole('slider').getAttribute('title'), /back 5 seconds \(,\).*forward 5 seconds \(\.\)/)
    const scrub = bar.getByRole('slider', { name: 'Video position' })
    await scrub.waitFor()
    const restart = bar.getByRole('button', { name: 'Back to start' })
    const play = bar.getByRole('button', { name: 'Play', exact: true })
    const focusedControl = () => bar.evaluate(el => el.ownerDocument.activeElement?.getAttribute('aria-label'))
    await presenter.bringToFront()
    await waitForVideo(visibleVideo, ({ el }) => Number.isFinite(el.duration) && el.duration > 0 && !el.seeking,
      {}, 'Current duration is ready before keyboard focus')
    await restart.click()
    await restart.focus()
    const focusState = await restart.evaluate(button => ({
      focused: button.ownerDocument.activeElement?.outerHTML.slice(0, 160),
      disabled: button.disabled,
      panePending: button.ownerDocument.defaultView?.frameElement?.parentElement?.inert,
      docFocus: button.ownerDocument.hasFocus(),
    }))
    assert.equal(await focusedControl(), 'Back to start', JSON.stringify(focusState))
    await restart.press('Tab')
    assert.equal(await focusedControl(), 'Play', 'Tab from Back to start reaches Play')
    await play.press('Tab')
    assert.equal(await focusedControl(), 'Video position', 'Tab from Play reaches the seek bar')
    assert.match(await bar.locator('output').textContent(), /0:\d{2} \/ 0:\d{2}/)
    for (const time of [4, 4.15]) {
      await scrub.fill(String(time))
      await atTogether(time, visibleVideo, owner, audienceVideo)
    }
    await bar.getByRole('button', { name: 'Back to start' }).click()
    await atTogether(0, visibleVideo, owner, audienceVideo)
    for (const [key, time] of [['.', 5], [',', 0], ['.', 5], ['0', 0]]) {
      await presenter.keyboard.press(key)
      await atTogether(time, visibleVideo, owner, audienceVideo)
    }
    await scrub.focus()
    await presenter.keyboard.press('.')
    await atTogether(5, visibleVideo, owner, audienceVideo)
    await videoBar(projection).getByRole('slider').fill('3')
    await atTogether(3, visibleVideo, owner, audienceVideo)
    await videoBar(projection).getByRole('button', { name: 'Back to start' }).click()
    await atTogether(0, visibleVideo, owner, audienceVideo)
  })

  await check('Slide view allows scrubbing while still previews leave controls out', async () => {
    const editor = await context.newPage()
    await editor.goto(pathToFileURL(editorDeck).href + '#local')
    await editor.locator('#stage .slide.active[data-id="local"]').waitFor()
    assert.equal(await videoBar(editor).count(), 0, 'still picture has no video transport')

    const editorHost = join(scratch, 'slide-view.html')
    await build({
      stdin: { sourcefile: 'video-look.tsx', loader: 'tsx', resolveDir: join(import.meta.dirname, '..'), contents: `
        import { createRoot } from 'react-dom/client'
        import WorkspaceSlideView from './src/renderer/src/components/WorkspaceSlideView.tsx'
        import FixedDeckPreview from './src/renderer/src/components/FixedDeckPreview.tsx'
        import './src/renderer/src/styles.css'
        import './src/renderer/src/workspace-views.css'
        const noop = () => {}
        window.tw = { slide: { renderPreview: async () => ${JSON.stringify(pathToFileURL(editorDeck).href)} } }
        const root = createRoot(document.getElementById('root'))
        window.showSlide = id => root.render(<WorkspaceSlideView path="/fixture-outline.md" outline="Fixture"
          row={{ slide_id: id }} index={1} count={4} place="Audience media" notes={[]} notesKey="" notesOpen={false}
          onOpenReveal={noop} onToggleNotes={noop} onNotesChange={noop} onNotesEngaged={noop}
          attachEditor={noop} onTalkDetails={noop} editable emptySlide={false} sourceRecovery={false} />)
        const inspector = new URL(location.href).searchParams.has('inspector')
        if (inspector) {
          root.render(<aside aria-label="Inspector" style={{ width: 'min(34vw, 430px)', margin: '24px 20px 0 auto' }}>
            <FixedDeckPreview title="Inspector live preview" src={${JSON.stringify(pathToFileURL(editorDeck).href + '#local')}} />
          </aside>)
        } else window.showSlide('local')
      ` },
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(scratch, 'slide-view.js'),
    })
    await writeFile(editorHost, '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="slide-view.css"><div id="root"></div><script src="slide-view.js"></script>')
    await editor.goto(pathToFileURL(editorHost).href)
    const frame = editor.locator('iframe[title="Slide preview"]')
    const slide = frame.contentFrame().locator('#stage .slide.active')
    assert.equal(await frame.getAttribute('src'), pathToFileURL(editorDeck).href + '#local',
      'the video opt-in preserves the compiled picture address')
    const bar = videoBar(slide)
    await editor.waitForFunction(() => document.querySelector('iframe[title="Slide preview"]')?.style.pointerEvents === '')
    const player = slide.locator('video')
    await singleFootBar(player, 'Slide view')
    assert(await frame.evaluate(iframe => iframe.allowFullscreen))
    await player.evaluate(video => {
      video.requestFullscreen = () => { video.dataset.fullscreenRequested = '1'; return Promise.resolve() }
    })
    await bar.getByRole('button', { name: 'Video full screen' }).click()
    assert.equal(await player.getAttribute('data-fullscreen-requested'), '1')
    await bar.getByRole('button', { name: 'Play', exact: true }).click()
    await waitForVideo(player, ({ el }) => !el.paused && el.currentTime > 0.1, {}, 'manual playback in Slide view')
    await bar.getByRole('button', { name: 'Pause', exact: true }).click()
    await bar.getByRole('slider').fill('4')
    await atTogether(4, player)
    await bar.getByRole('button', { name: 'Back to start' }).click()
    await atTogether(0, player)
    await bar.getByRole('slider').press('.')
    await atTogether(5, player)
    const inspector = await context.newPage()
    await inspector.goto(pathToFileURL(editorHost).href + '?inspector=1')
    const inspectorVideo = inspector.frameLocator('iframe[title="Inspector live preview"]').locator('#stage .slide.active video')
    await singleFootBar(inspectorVideo, 'Inspector live preview')
    if (process.env.TW_VIDEO_LOOK) {
      await bar.getByRole('slider').fill('4')
      await atTogether(4, player)
      await waitForVideo(player, ({ el }) => el.readyState >= 2, {}, 'Slide view frame ready for capture')
      await videoBar(preview).getByRole('slider').fill('4')
      await atTogether(4, visibleVideo)
      const inspectorBar = videoBar(inspector.frameLocator('iframe[title="Inspector live preview"]'))
      await inspectorBar.getByRole('button', { name: 'Play', exact: true }).click()
      await inspectorBar.getByRole('button', { name: 'Pause', exact: true }).click()
      await inspectorBar.getByRole('slider').fill('4')
      await atTogether(4, inspectorVideo)
      await mkdir(process.env.TW_VIDEO_LOOK, { recursive: true })
      for (const [width, height] of [[1440, 900], [1000, 631]]) {
        for (const colorScheme of ['light', 'dark']) {
          const shots = [['presenter', presenter, visibleVideo], ['slide', editor, player], ['inspector', inspector, inspectorVideo]]
          for (const [name, page, video] of shots) {
            await page.setViewportSize({ width, height })
            await page.emulateMedia({ colorScheme })
            await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, colorScheme)
            await page.evaluate(() => document.fonts.ready)
            await singleFootBar(video, name + ' ' + width + '×' + height)
            if (name === 'presenter') {
              await page.waitForFunction(() => {
                const buttons = Array.from(document.querySelectorAll('#presenterBottomBar > div button'))
                  .filter(button => button.getClientRects().length)
                  .map(button => button.getBoundingClientRect()).sort((a, b) => a.left - b.left)
                return buttons.every((button, index) => index === 0 || button.left >= buttons[index - 1].right - 1)
              })
            }
            await video.evaluate(el => el.ownerDocument.activeElement?.blur())
            await page.mouse.move(1, 1)
            await page.screenshot({ path: join(process.env.TW_VIDEO_LOOK, name + '-' + width + 'x' + height + '-' + colorScheme + '.png'), animations: 'disabled' })
          }
        }
      }
    }
    await inspector.close()
    await editor.evaluate(() => window.showSlide('open'))
    await slide.filter({ hasText: 'Synthetic local media and widgets.' }).waitFor()
    assert.equal(await frame.evaluate(iframe => getComputedStyle(iframe).pointerEvents), 'none', 'ordinary Slide view remains read-only')
    await editor.close()
  })

  await check('embedded web video loads in both windows', async () => {
    assert(audience, 'paired window opened')
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
