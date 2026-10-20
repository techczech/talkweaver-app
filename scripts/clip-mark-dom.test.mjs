// A recording notes when a slide video starts: the REAL deck runtime as a presenter + projector pair
// (one session, same compiled file with the presenter's clip references), with the real recorder
// preload on the presenter. The video plays in the projector; the projector reports it over the peer
// channel; the presenter's recorder logs exactly one clip mark with the slide, the authored
// reference and the position. Nothing is logged while not recording, or while paused. A plain
// compile (no presenter option) carries no reference, so a deck outside the presenter window has none.
// Headless Chromium only (never the installed Chrome).
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const clip = join(repo, 'e2e/fixtures/media-row-4x3.webm')
const bundled = await build({
  entryPoints: [join(repo, 'src/preload/present-recorder.ts')], bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent',
  plugins: [{ name: 'preload-boundaries', setup(b) {
    b.onResolve({ filter: /^electron$|present-edit-bridge$|present-live-bridge$/ }, (args) => ({ path: args.path, namespace: 'test' }))
    b.onLoad({ filter: /.*/, namespace: 'test' }, (args) => ({ contents: args.path === 'electron' ? 'export const ipcRenderer = window.testIpc' : 'export const mountEditBridge = () => {}; export const mountLiveBridge = () => {};', loader: 'js' }))
  } }]
})

const FAKES = () => {
  window.calls = []
  window.testIpc = {
    on: () => {},
    invoke: async (name, payload) => {
      window.calls.push([name, payload && typeof payload === 'object' ? { ...payload, bytes: payload.bytes ? payload.bytes.byteLength : undefined } : payload])
      if (name === 'recording:context') return { talkSlug: 'deck', talkTitle: 'Deck', timerTargetMin: 0, pathwayId: null, preferredPlannedRunId: null, discardThresholdMs: 0, testMode: false }
      if (name === 'recording:stream-open') return { ok: true, sessionId: 'sess-x' }
      if (name === 'recording:save') return { ok: true, sessionId: 'sess-x', kind: 'delivery' }
      return { ok: true }
    }
  }
  class FakeTrack extends EventTarget { constructor() { super(); this.readyState = 'live' } getSettings() { return { deviceId: 'default', groupId: 'g1' } } stop() { this.readyState = 'ended' } }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: async () => { const t = new FakeTrack(); return { getTracks: () => [t], getAudioTracks: () => [t] } },
    enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'default', groupId: 'g1' }],
    addEventListener() {}, removeEventListener() {}
  } })
  window.MediaRecorder = class {
    static isTypeSupported() { return true }
    constructor() { this.state = 'inactive' }
    start() { this.state = 'recording'; this.timer = setInterval(() => this.ondataavailable?.({ data: new Blob(['x'.repeat(64)]) }), 50) }
    pause() { this.state = 'paused' }
    resume() { this.state = 'recording' }
    stop() { clearInterval(this.timer); this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['last']) }); queueMicrotask(() => this.onstop?.(new Event('stop'))) }
  }
}

const outline = ['---', 'title: Clip marks', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '### Before {id=before}', '', 'Words.', '', '### Demo {id=demo}', '', 'Words.', '', `[Video: ${clip}]`, ''].join('\n')
const outlinePath = join(repo, 'e2e/fixtures/clip-marks-outline.md')
const compile = (extra) => prepareSource(outlinePath, outline, 'clip-marks', { isDirectory: () => false }, {}, { allowedAssetRoots: [join(repo, 'e2e/fixtures')], ...extra })
const presenterDeck = (await compile({ presenterClipRefs: true })).fullHtml
const plainDeck = (await compile()).fullHtml

// The app's own way: the presenter deck is a file:// page and the projector is the window it opens
// itself (F5 / window.open), so a play reaches the presenter over BOTH the channel and postMessage.
// Slides: `before`, `pair` (two videos), `solo` (one video, reached by navigation, so its id is not
// the hash the deck was opened on).
const pairOutline = ['---', 'title: Clip pairs', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '### Before {id=before}', '', 'Words.', '', '### Pair {id=pair}', '', `[Video: ${clip}]`, '', `[Video: ${clip}]`, '',
  '### Solo {id=solo}', '', `[Video: ${clip}]`, ''].join('\n')
const pairDeck = (await prepareSource(outlinePath, pairOutline, 'clip-pairs', { isDirectory: () => false }, {}, { allowedAssetRoots: [join(repo, 'e2e/fixtures')], presenterClipRefs: true })).fullHtml
const tmp = await mkdtemp(join(tmpdir(), 'tw-clip-pairs-'))
const pairFile = join(tmp, 'deck.html')
await writeFile(pairFile, pairDeck)

const server = createServer((req, res) => {
  const html = req.url.startsWith('/plain') ? plainDeck : req.url.startsWith('/deck') ? presenterDeck : null
  if (!html) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

let failures = 0
const check = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`) } catch (e) { failures++; console.error(`FAIL ${name}\n     ${e?.stack ?? e}`) } }
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--allow-file-access-from-files'] })
try {
  await check('a plain compile carries no clip reference', () => { assert.equal(plainDeck.includes('data-video-ref="'), false); assert.equal(presenterDeck.includes(`data-video-ref="${clip}"`), true) })

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const session = 'clipsess1'
  const audience = await context.newPage()
  const presenter = await context.newPage()
  await presenter.addInitScript(FAKES)
  await audience.goto(`${origin}/deck.html?audience=1&session=${session}#demo`, { waitUntil: 'load' })
  await presenter.goto(`${origin}/deck.html?presenter=1&session=${session}#demo`, { waitUntil: 'load' })
  await presenter.addScriptTag({ content: bundled.outputFiles[0].text })
  await presenter.waitForSelector('#twrec-primary')
  await audience.waitForSelector('.slide.active video')
  const playInAudience = (at) => audience.evaluate(async (t) => {
    const v = document.querySelector('.slide.active video')
    v.muted = true
    if (t !== undefined) v.currentTime = t
    await v.play()
    return v.currentTime
  }, at)
  const pauseInAudience = () => audience.evaluate(() => document.querySelector('.slide.active video').pause())
  const clipMarks = async () => (await presenter.evaluate(() => window.calls.filter(([c]) => c === 'recording:save').map(([, p]) => p.rawMarks)))[0]?.filter((m) => m.event === 'clip') ?? []

  await check('a play in the projector while not recording logs nothing', async () => {
    await playInAudience(0.1)
    await pauseInAudience()
    await presenter.waitForTimeout(400)
    assert.equal(await presenter.evaluate(() => window.calls.filter(([c]) => c === 'recording:save').length), 0)
  })

  await check('while recording, a play in the projector is exactly one clip mark with slide, reference and position', async () => {
    await presenter.locator('#twrec-primary').click()
    await presenter.waitForFunction(() => window.calls.some(([c]) => c === 'recording:stream-append'))
    const at = await playInAudience(0.2)
    await presenter.waitForFunction(() => !!document.documentElement.dataset.twClipPlay)
    await presenter.waitForTimeout(500) // both peer paths have delivered by now
    await pauseInAudience()
    await presenter.locator('#twrec-pause').click()
    await playInAudience() // paused: not logged
    await pauseInAudience()
    await presenter.waitForTimeout(400)
    await presenter.locator('#twrec-resume').click()
    const resumedAt = await playInAudience() // a resume gives the position
    await presenter.waitForTimeout(500)
    await presenter.locator('#twrec-stop').click()
    await presenter.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'saved')
    const marks = await clipMarks()
    assert.equal(marks.length, 2, JSON.stringify(marks))
    assert.deepEqual(marks.map((m) => [m.slideId, m.clip.src]), [['demo', clip], ['demo', clip]])
    assert.ok(Math.abs(marks[0].clip.atS - 0.2) < 0.1 && marks[0].clip.atS <= at + 0.01, `atS ${marks[0].clip.atS}`)
    assert.ok(marks[1].clip.atS >= marks[0].clip.atS && marks[1].clip.atS <= resumedAt + 0.01, `resume atS ${marks[1].clip.atS}`)
    assert.ok(marks[0].tMs > 0 && marks[1].tMs > marks[0].tMs)
  })

  // Two videos starting together, the app's way (both delivery paths), repeated: exactly two marks each.
  const appContext = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const appPresenter = await appContext.newPage()
  await appPresenter.addInitScript(FAKES)
  await appPresenter.goto(`file://${pairFile}?presenter=1&session=clippair1#before`, { waitUntil: 'load' })
  await appPresenter.addScriptTag({ content: bundled.outputFiles[0].text })
  await appPresenter.waitForSelector('#twrec-primary')
  const popupWait = appContext.waitForEvent('page')
  await appPresenter.keyboard.press('F5')
  const projector = await popupWait
  await projector.waitForLoadState('load')
  const ROUNDS = 25
  const savedMarks = async () => (await appPresenter.evaluate(() => window.calls.filter(([c]) => c === 'recording:save').map(([, p]) => p.rawMarks)))[0]?.filter((m) => m.event === 'clip') ?? []
  await appPresenter.locator('#twrec-primary').click()
  await appPresenter.waitForFunction(() => window.calls.some(([c]) => c === 'recording:stream-append'))
  await appPresenter.keyboard.press('ArrowRight') // on to `pair`
  await projector.waitForFunction(() => document.querySelectorAll('.slide.active video').length === 2)
  const settle = () => appPresenter.waitForTimeout(450)
  const playAll = (page) => page.evaluate(async () => {
    const vs = [...document.querySelectorAll('.slide.active video')]
    vs.forEach((v) => { v.muted = true; v.pause(); v.currentTime = 0 })
    await Promise.all(vs.map((v) => v.play()))
  })
  await appPresenter.evaluate(() => { window.clipSeen = 0; document.addEventListener('tw-clip-play', () => window.clipSeen++) })
  const seenSoFar = () => appPresenter.evaluate(() => window.clipSeen)

  await check(`two videos started in one tick, ${ROUNDS} times, the app's own windows: two marks each time`, async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const before = await seenSoFar()
      await playAll(projector)
      await settle()
      const got = (await seenSoFar()) - before
      assert.equal(got, 2, `round ${i}: ${got} clip plays reached the recorder`)
    }
  })

  await check('a slide whose id is not the hash the deck opened on is logged under its own id', async () => {
    await appPresenter.keyboard.press('ArrowRight') // on to `solo`
    await projector.waitForFunction(() => document.querySelectorAll('.slide.active video').length === 1 && document.querySelector('.slide.active').dataset.id === 'solo')
    const before = await seenSoFar()
    await playAll(projector)
    await settle()
    assert.equal((await seenSoFar()) - before, 1)
  })

  await check('a play in the lightbox (V) is one mark', async () => {
    await projector.evaluate(() => { document.querySelectorAll('.slide.active video').forEach((v) => { v.pause(); v.currentTime = 0 }) })
    await settle()
    const before = await seenSoFar()
    await projector.keyboard.press('v')
    await projector.waitForSelector('video.lightbox-video', { timeout: 3000 })
    await projector.evaluate(async () => { const v = document.querySelector('video.lightbox-video'); v.muted = true; v.currentTime = 0; await v.play() })
    await settle()
    assert.equal((await seenSoFar()) - before, 1)
    await projector.keyboard.press('Escape')
    await projector.waitForSelector('video.lightbox-video', { state: 'detached', timeout: 3000 })
  })

  await check('a play naming a slide that is no longer at that index is dropped', async () => {
    await appPresenter.evaluate(() => { document.querySelector('.slide[data-id="solo"]').dataset.id = 'drifted' })
    await projector.evaluate(() => { document.querySelectorAll('video').forEach((v) => v.pause()) })
    await settle()
    const before = await seenSoFar()
    await projector.evaluate(async () => { const v = document.querySelector('.slide.active video'); v.muted = true; v.currentTime = 0; await v.play() })
    await settle()
    assert.equal((await seenSoFar()) - before, 0)
    await appPresenter.evaluate(() => { document.querySelector('.slide[data-id="drifted"]').dataset.id = 'solo' })
  })

  await check('the saved run holds one clip mark per start: 2 per pair round, 1 solo, 1 lightbox', async () => {
    await appPresenter.locator('#twrec-stop').click()
    await appPresenter.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'saved')
    const marks = await savedMarks()
    assert.equal(marks.filter((m) => m.slideId === 'pair').length, ROUNDS * 2, JSON.stringify(marks.map((m) => m.slideId)))
    assert.equal(marks.filter((m) => m.slideId === 'solo').length, 2, JSON.stringify(marks.map((m) => m.slideId)))
    assert.equal(marks.length, ROUNDS * 2 + 2)
    assert.ok(marks.every((m) => m.clip.src === clip && m.clip.atS >= 0 && m.clip.atS <= 86400))
  })
} finally {
  await browser.close()
  server.close()
}
if (failures) { console.error(`\n${failures} clip-mark check(s) failed`); process.exit(1) }
console.log('\nclip marks: all checks passed')
