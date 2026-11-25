import assert from 'node:assert/strict'
import { copyFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const scratch = await mkdtemp(join(tmpdir(), 'tw-presenter-markers-'))
const clip = '![Watering rota demo](clip.webm){controls}'
const markers = ['[Marker: 0:00 Intro]', '[Marker: 0:03 The demo]', '[Marker: 0:08 Result]']
const many = Array.from({ length: 11 }, (_, second) => `[Marker: 0:${String(second).padStart(2, '0')} Part ${second + 1}]`)
const source = [
  '---', 'title: Community garden update', 'auto_title_slide: false', 'auto_thanks_slide: false', '---',
  '', '### How the watering rota works {id=three}', '', clip, ...markers,
  '', ':::notes', 'Let the intro run. Jump to the demo and then the result if time runs short.', ':::',
  '', '### Twelve parts {id=many}', '', clip, ...many, '[Marker: 0:13 Credits]',
  '', '### Unmarked clip {id=plain}', '', clip,
  '', '### Two clips {id=two}', '', clip, '[Marker: 0:04 First clip]',
  '![Second clip](second.webm){controls}', '[Marker: 0:07 Second clip]',
  '', '## Grid {id=grid}{grid-linear}', '', '### First card {id=card-a}', '', clip, ...markers,
  '', '### Second card {id=card-b}', '', '- Notes for the next card.',
  '', '## End {id=end}', '', 'Thank you.', ''
].join('\n')
let browser
try {
  const fixture = join(import.meta.dirname, '../e2e/fixtures/video-playback-12s.webm')
  await copyFile(fixture, join(scratch, 'clip.webm'))
  await copyFile(fixture, join(scratch, 'second.webm'))
  const outline = join(scratch, 'garden-outline.md')
  await writeFile(outline, source)
  const model = await prepareSource(outline, source, null, await stat(outline), {}, {})
  const deck = join(scratch, 'deck.html')
  await writeFile(deck, model.fullHtml)
  browser = await chromium.launch({ headless: true, args: ['--mute-audio'] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const errors = []
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
  const presenter = await context.newPage()
  await presenter.goto(pathToFileURL(deck).href + '?presenter=1&session=marker-test#three')
  await presenter.evaluate(() => {
    window.markerGuideCommands = []
    window.addEventListener('tw-guide-command-ran', event => window.markerGuideCommands.push(event.detail))
  })
  const rows = presenter.locator('#presenterMarkerList button')
  const following = presenter.locator('#presenterFollowing')
  const currentFrame = id => presenter.frameLocator(`#currentPreview > iframe[data-slide-id="${id}"]:not(.preview-incoming)`)
  const ticks = id => currentFrame(id).locator('.tw-video-marker-tick')
  const video = page => page.locator('#stage .slide.active video').first()
  const until = async (player, t, paused = true) => {
    const handle = await player.elementHandle()
    try {
      await (await handle.ownerFrame()).waitForFunction(({ el, t, paused }) =>
        el.paused === paused && !el.seeking && (paused ? Math.abs(el.currentTime - t) < 0.05 : el.currentTime >= t && el.currentTime < t + 2),
      { el: handle, t, paused })
    } finally { await handle.dispose() }
  }
  const go = async id => {
    await presenter.evaluate(value => { location.hash = value }, id)
    await presenter.locator(`#stage .slide.active[data-id="${id}"]`).waitFor({ state: 'attached' })
  }
  const look = async (label, page = presenter, widths = [[1440, 900], [1000, 631]]) => {
    if (process.env.TW_PRESENTER_MARKER_LOOK !== '1') return
    for (const [width, height] of widths) {
      await page.setViewportSize({ width, height })
      await page.evaluate(() => new Promise(requestAnimationFrame))
      const shot = await page.screenshot({ type: 'jpeg', quality: 85, animations: 'disabled' })
      console.log(`PRESENTER_MARKER_LOOK ${label}-${width} ${shot.toString('base64')}`)
    }
  }

  await rows.nth(2).waitFor()
  await ticks('three').nth(2).waitFor()
  assert.equal(await rows.count(), 3)
  assert.equal(await ticks('three').count(), 3)
  assert.equal(await following.locator('#followingPreview').isVisible(), false)
  assert.equal(await following.locator('#followingHeading').isVisible(), false)
  assert(await following.locator('#markerHeading').evaluate(heading => {
    const hint = heading.querySelector('#markerHint')
    const list = heading.parentElement.querySelector('#presenterMarkerList')
    return Math.abs(list.getBoundingClientRect().right - hint.getBoundingClientRect().right) < 1
  }))
  const [audience] = await Promise.all([context.waitForEvent('page'), presenter.keyboard.press('F5')])
  const projected = video(audience)
  await projected.waitFor()
  await presenter.keyboard.press('2')
  await until(projected, 3)
  await until(currentFrame('three').locator('video'), 3)
  assert(await presenter.evaluate(() => window.markerGuideCommands.includes('presenter.video-marker')))
  await rows.nth(1).evaluate(button => {
    if (!button.hasAttribute('data-current')) throw new Error('The marker reached by key 2 is not highlighted')
  })
  assert.equal(await audience.locator('.tw-video-marker-tick').count(), 0)
  assert.equal(await audience.locator('#presenterMarkerList button').count(), 0)
  assert.equal(await audience.locator('#stage .slide.active .tw-video-seek').isVisible(), false)
  assert.equal(await projected.evaluate(el => el.controls), false)
  await look('presenter-three')
  await look('audience', audience, [[1440, 900]])

  await presenter.locator('#presenterMediaPlay').click()
  await until(projected, 3, false)
  await ticks('three').nth(2).click()
  await until(projected, 8, false)
  await presenter.locator('#presenterMediaPause').click()
  await rows.first().click()
  await until(projected, 0)

  async function palette(command, target, viaShortcut = false) {
    if (viaShortcut && process.platform === 'darwin') {
      await presenter.keyboard.press('ControlOrMeta+Shift+P')
    } else {
      await presenter.locator('#presenterMenuView').click()
      await presenter.locator('#viewCommands').click()
    }
    const search = presenter.locator('#presenterCommandSearch')
    await search.waitFor({ state: 'visible' })
    await search.fill(command)
    await presenter.locator(`[data-palette-id="${target}"]:not(:disabled)`).click()
    await search.waitFor({ state: 'hidden' })
  }
  await palette('Video: Next marker', 'video-marker-next')
  await until(projected, 3)
  await palette('Video: Previous marker', 'video-marker-previous', true)
  await until(projected, 0)
  assert(await presenter.evaluate(() => ['presenter.video-marker-next', 'presenter.video-marker-previous']
    .every(id => window.markerGuideCommands.includes(id))))

  await go('many')
  await rows.nth(11).waitFor()
  await ticks('many').nth(10).waitFor()
  assert.equal(await rows.nth(11).isDisabled(), true)
  assert.match(await rows.nth(11).textContent(), /Credits · past the end/)
  assert.equal(await ticks('many').count(), 11)
  assert.equal(await currentFrame('many').locator('.tw-video-marker-ticks').getAttribute('data-labels'), null)
  await presenter.setViewportSize({ width: 1000, height: 631 })
  const numbers = currentFrame('many').locator('.tw-video-marker-tick-key')
  const track = await numbers.first().elementHandle()
  try {
    await (await track.ownerFrame()).waitForFunction(firstNumber => {
      const caps = [...firstNumber.closest('.tw-video-marker-ticks').querySelectorAll('.tw-video-marker-tick-key')]
        .map(key => key.getBoundingClientRect())
      return caps.length === 9 && caps.every((cap, index) => !index || cap.left >= caps[index - 1].right - 0.5)
    }, track)
  } finally { await track.dispose() }
  await presenter.setViewportSize({ width: 1440, height: 900 })
  await presenter.keyboard.press('3')
  await until(video(presenter), 2)
  await look('presenter-many')
  await go('plain')
  await following.locator('#followingHeading').waitFor()
  assert.equal(await rows.count(), 0)
  assert.equal(await ticks('plain').count(), 0)
  await audience.locator('#stage .slide.active[data-id="plain"] .tw-video-seek').waitFor()
  await look('presenter-none')
  await audience.close()

  await go('two')
  await rows.first().waitFor()
  assert.match(await rows.first().textContent(), /First clip/)
  await presenter.locator('#presenterMediaSelect').selectOption('1')
  await rows.first().getByText('Second clip').waitFor()
  await presenter.keyboard.press('1')
  await until(presenter.locator('#stage .slide.active video').nth(1), 7)
  await until(video(presenter), 0)
  assert.equal(await ticks('two').count(), 1)
  await go('grid')
  await presenter.keyboard.press('2')
  await presenter.locator('#stage .slide.active[data-id="card-b"]').waitFor({ state: 'attached' })
  assert(await presenter.evaluate(() => window.markerGuideCommands.includes('presenter.grid-child')))
  assert.deepEqual(errors, [])
  console.log('PASS presenter marker ticks, list, digit jump, keyless commands, grid priority and paired audience playback')
} finally {
  await browser?.close()
  await rm(scratch, { recursive: true, force: true })
}
