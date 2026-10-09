// "Play as a step" (0.38 ticket 05) in a real browser: presenter, projector and venue screen.
// The presenter is driven with the keyboard. After every press the test reads each file on the
// slide in four places: the projector window (the live display, which plays), the presenter's own
// window and its current-slide preview (both silent; the preview carries the "plays on Next"
// mark), and the venue screen, which is handed ONLY the fields worker/protocol.ts SlideState
// carries ({ slideId, reveal, focus, lightbox }) and must play the same file at the same step.
//
// Covers: a video and an audio chip with {play-on-next} (arrive stopped, Next plays, Next stops
// and moves on, Back stops and rewinds); two files on one slide; {reveal}; {emphasis-steps};
// {image-steps}; {nostep}; the option absent; the option beside {autoplay}; a projector window
// opened mid-step; a refused play() on the venue screen and on a plain deck; documents that must
// never play (a preview document, a handout, a following phone); the presenter's Play / Pause.
// Headless Chromium only (never the installed Chrome).
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { buildVenuePageHtml } from '../compiler/scripts/lib/venue-page.mjs'
import { markSlidePreviewHtml } from '../src/shared/slide-preview.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
// A real, silent 8-bit mono WAV (8 kHz): decodes in headless Chromium, makes no sound.
function silentWav(seconds) {
  const rate = 8000
  const n = rate * seconds
  const buf = Buffer.alloc(44 + n, 0x80)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8); buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34); buf.write('data', 36); buf.writeUInt32LE(n, 40)
  return buf
}

const dir = await mkdtemp(join(tmpdir(), 'tw-media-steps-dom-'))
await mkdir(join(dir, 'assets'), { recursive: true })
for (const name of ['a', 'b']) await writeFile(join(dir, 'assets', `${name}.png`), PNG)
await writeFile(join(dir, 'assets', 'theme.wav'), silentWav(20))
// A three-second VP9 clip (open-source Chromium decodes no H.264). {loop} keeps it running for the checks.
await writeFile(join(dir, 'assets', 'clip.webm'), await readFile(new URL('../e2e/fixtures/media-row-4x3.webm', import.meta.url)))

const slides = (option) => [
  '### Start', '{id=start}', '', '- Words only', '',
  '### Video', '{id=video}', '', 'Words beside the clip.', '', `![clip](assets/clip.webm)${option}{loop}`, '',
  '### Audio', '{id=audio}', '', 'Words beside the chip.', '', `![Theme](assets/theme.wav)${option}`, '',
  '### Two', '{id=two}', '', `![First](assets/theme.wav)${option}`, '', 'Words between the two.', '', `![Second](assets/theme.wav)${option}`, '',
  '### Reveal', '{reveal} {id=reveal}', '', '- Alpha', '- Beta', '', `![clip](assets/clip.webm)${option}{loop}`, '',
  '### Emphasis', '{emphasis-steps} {id=emphasis}', '', 'The first line has a **bold** word.', '', `![Theme](assets/theme.wav)${option}`, '', 'The last line has a ==marked== word.', '',
  '### Images', '{image-steps} {id=images}', '', `![Theme](assets/theme.wav)${option}`, '', '![One](assets/a.png)', '![Two](assets/b.png)', '',
  '### Nostep', '{nostep} {id=nostep}', '', 'Words beside the clip.', '', `![clip](assets/clip.webm)${option}{loop}`, '',
  '### Auto', '{id=auto}', '', 'Words beside the chip.', '', `![Theme](assets/theme.wav)${option}{autoplay}`, '',
  '### End', '{id=end}', '', '- Words only', ''
]
const build = async (name, option) => {
  const outline = ['---', 'title: Media steps', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', ...slides(option)].join('\n')
  const path = join(dir, `${name}.md`)
  await writeFile(path, outline, 'utf8')
  return prepareSource(path, outline, null, await stat(path), {}, {})
}
const on = await build('on', '{play-on-next}')
const off = await build('off', '')
const share = (html, extra = {}) => ({ title: 'Media steps', slug: 'media-steps', includeNotes: false, license: null, slides: extractSlides(html), styles: extractStyles(html), ...extra })
const venueFor = (html) => buildVenuePageHtml({ ...share(html), liveTalkSlug: 'media-steps', workerBaseUrl: 'https://live.example.test', qr: '<svg aria-label="QR code"></svg>', handoutUrl: 'https://handouts.fyi/k7m2' })
const pages = {
  '/on.html': on.fullHtml,
  '/off.html': off.fullHtml,
  '/venue/on.html': venueFor(on.fullHtml),
  '/venue/off.html': venueFor(off.fullHtml),
  '/handout.html': buildShareHtml(share(on.fullHtml)),
  '/follower.html': buildShareHtml(share(on.fullHtml, { liveTalkSlug: 'media-steps', workerBaseUrl: 'https://live.example.test' })),
  // A preview document: the runtime gate alone (the files kept), and the real preview marking.
  '/preview-gate.html': on.fullHtml.replace(/<body\b([^>]*)>/i, '<body$1 data-tw-preview>'),
  '/preview.html': markSlidePreviewHtml(on.fullHtml)
}
const server = createServer((req, res) => {
  const path = req.url.split('?')[0]
  if (pages[path]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(pages[path]); return }
  res.writeHead(404); res.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] })
let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`) } catch (error) { failures += 1; console.error(`FAIL ${name}\n  ${error.stack || error}`) }
}

/**
 * What one slide shows, read in the page. Every video figure and audio chip in page order, the
 * emphasis spans, and the lightbox. `inPreview` reads the presenter's Current pane instead.
 */
function readSlide(inPreview) {
  const doc = inPreview ? document.querySelector('#currentPreview iframe')?.contentDocument : document
  const slide = doc?.querySelector(inPreview ? '.slide' : '.slide.active')
  if (!slide) return null
  return {
    slide: slide.dataset.id,
    stamped: slide.hasAttribute('data-media-steps'),
    files: [...slide.querySelectorAll('figure.slide-video, .slide-audio')].map((file) => {
      const media = file.querySelector('video, audio')
      return {
        kind: file.classList.contains('slide-audio') ? 'audio' : 'video',
        option: file.hasAttribute('data-play-on-next'),
        step: file.getAttribute('data-media-step'),
        playing: media ? !media.paused : null,
        rewound: media ? media.currentTime === 0 : null,
        atEnd: media ? isFinite(media.duration) && media.currentTime >= media.duration - 0.05 : null,
        muted: media ? media.muted : null,
        chip: file.dataset.audioState ?? null,
        block: file.getAttribute('data-mode-state'),
        mark: file.querySelector('.media-step-mark')?.textContent ?? null,
        tap: file.querySelector('.media-step-tap')?.textContent ?? null
      }
    }),
    blocks: [...slide.querySelectorAll('.feature-list > li')].map((el) => el.getAttribute('data-mode-state')),
    emphasis: [...slide.querySelectorAll('[data-emph-step]')].map((el) => (el.getAttribute('data-emph-state') === 'off' ? 'off' : 'on')),
    mode: ['reveal', 'focus'].find((kind) => slide.classList.contains(`mode-${kind}`)) ?? null
  }
}
/** True once every {play-on-next} file on the live slide does what its step says. */
function settled() {
  const slide = document.querySelector('.slide.active')
  if (!slide) return false
  return [...slide.querySelectorAll('[data-play-on-next]')].every((file) => {
    const media = file.querySelector('video, audio')
    if (!media) return true
    if (file.getAttribute('data-media-step') !== 'playing') return media.paused
    return !media.paused && media.currentTime > 0 && (!file.classList.contains('slide-audio') || file.dataset.audioState === 'playing')
  })
}
const steps = (shown) => shown.files.map((file) => file.step)
const playing = (shown) => shown.files.map((file) => file.playing)

// The venue page and a following phone talk to the live service over a socket; this stand-in lets
// the test hand them the slide states the presenter publishes.
function liveServiceStandIn() {
  window.__sockets = []
  window.fetch = async (url) => ({ ok: true, json: async () => String(url).endsWith('/capabilities')
    ? { protocol: 2 } : String(url).endsWith('/status') ? { status: 'open' } : { live: true, sessionId: 'session-1' } })
  window.WebSocket = class {
    static OPEN = 1
    readyState = 1
    constructor(url) {
      this.url = url
      window.__sockets.push(this)
      queueMicrotask(() => { this.onopen?.(); this.emit({ type: 'session.hello', protocol: 2 }) })
    }
    send(raw) {
      const message = JSON.parse(raw)
      if (message.type === 'session.sync') queueMicrotask(() => this.emit({
        type: 'session.snapshot', protocol: 2, sessionId: 'session-1', syncId: message.syncId,
        expiresAt: Date.now() + 60000, slideState: null, polls: [], receipts: []
      }))
      if (message.type === 'session.ping') this.emit({ type: 'session.pong', nonce: message.nonce })
    }
    close() { this.readyState = 3 }
    emit(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
  }
}
// Counts every play() and load() a document makes.
function countMedia() {
  window.__plays = 0; window.__loads = 0
  const play = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function () { window.__plays += 1; return play.call(this) }
  const load = HTMLMediaElement.prototype.load
  HTMLMediaElement.prototype.load = function () { window.__loads += 1; return load.call(this) }
}
// A browser that wants a gesture before sound: play() is refused unless the element is muted or
// the test has "tapped" (window.__gesture).
function refuseSound() {
  window.__gesture = false; window.__plays = 0
  const play = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function () {
    window.__plays += 1
    return this.muted || window.__gesture ? play.call(this) : Promise.reject(new DOMException('play() failed because the user did not interact with the document first', 'NotAllowedError'))
  }
}

const published = {}   // slide states the presenter published, by label: replayed to other pages below
let revision = 0
const venueMessage = (sent) => ({ type: 'slide.state', slideId: sent.slide, reveal: sent.reveal, focus: sent.focus ? JSON.parse(sent.focus) : null, lightbox: JSON.parse(sent.lightbox), revision: (revision += 1) })

async function pair(deck) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, reducedMotion: 'reduce' })
  const session = `media-steps-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const presenter = await context.newPage()
  const projector = await context.newPage()
  const venue = await context.newPage()
  for (const page of [presenter, projector, venue]) page.on('pageerror', (error) => { failures += 1; console.error(`FAIL page error: ${error.message}`) })
  await venue.addInitScript(liveServiceStandIn)
  await projector.addInitScript(countMedia)
  await venue.setViewportSize({ width: 1280, height: 720 })
  await venue.goto(`${origin}/venue${deck}`, { waitUntil: 'load' })
  await venue.waitForFunction(() => window.__sockets.length === 1)
  await projector.goto(`${origin}${deck}?audience=1&session=${session}`, { waitUntil: 'load' })
  await presenter.goto(`${origin}${deck}?presenter=1&session=${session}`, { waitUntil: 'load' })
  await presenter.waitForSelector('#presenterRoot, .presenter-root')
  let presses = 0
  /**
   * Press a key in the presenter; wait until the projector has applied that state and its files
   * do what the step says; hand the venue page what the live session would carry and wait for it
   * the same way. Returns what the projector shows, after asserting that the venue screen plays
   * the same files, the presenter's own window plays nothing and its preview holds no sound.
   */
  const press = async (key, label = '') => {
    presses += 1
    await presenter.keyboard.press(key)
    const sent = await presenter.evaluate(() => ({
      slide: document.querySelector('.slide.active')?.dataset.id ?? null,
      lightbox: document.documentElement.dataset.twLiveLightbox,
      focus: document.documentElement.dataset.twLiveFocus || '',
      reveal: Number(document.documentElement.dataset.twLiveReveal) || 0
    }))
    if (label) published[label] = sent
    await projector.waitForFunction((want) => document.querySelector('.slide.active')?.dataset.id === want.slide
      && document.documentElement.dataset.twLiveLightbox === want.lightbox
      && (document.documentElement.dataset.twLiveFocus || '') === want.focus
      && (Number(document.documentElement.dataset.twLiveReveal) || 0) === want.reveal, sent, { timeout: 5000 })
    await projector.waitForFunction(settled, null, { timeout: 8000, polling: 50 })
    const shown = await projector.evaluate(readSlide, false)
    const at = `press ${presses} (${key}) on ${shown.slide}`
    // The venue screen: exactly the fields worker/protocol.ts SlideState carries.
    const message = venueMessage(sent)
    if (message.focus) {
      assert(message.focus.kind === 'reveal' || message.focus.kind === 'focus', `${at}: the focus kind is one the live protocol accepts`)
      assert(Number.isInteger(message.focus.step) && message.focus.step >= 0, `${at}: the focus step is a non-negative integer`)
      assert.deepEqual(Object.keys(message.focus).sort(), ['kind', 'step'], `${at}: the published focus has no new field`)
    }
    await venue.evaluate((state) => window.__sockets.at(-1).emit(state), message)
    await venue.locator(`.slide.active[data-id="${sent.slide}"]`).waitFor()
    await venue.waitForFunction(settled, null, { timeout: 8000, polling: 50 })
    const onVenue = await venue.evaluate(readSlide, false)
    // Files with the option only: without it the venue page shows a video as the handout does and
    // carries no <audio> for a chip, exactly as before this option existed.
    const audible = (reading) => reading.files.filter((file) => file.option).map((file) => [file.kind, file.step, file.playing])
    assert.deepEqual(audible(onVenue), audible(shown), `${at}: the venue screen plays what the projector plays`)
    assert.deepEqual([onVenue.blocks, onVenue.emphasis], [shown.blocks, shown.emphasis], `${at}: the venue screen shows the projector's step`)
    assert.equal(onVenue.files.filter((file) => !file.option).some((file) => file.playing), false, `${at}: the venue screen plays no file without the option`)
    // The presenter: its own window never plays, and its preview shows the step without sound.
    assert.equal(await presenter.evaluate(() => [...document.querySelectorAll('video, audio')].every((m) => m.paused && m.currentTime === 0)), true, `${at}: the presenter's window plays nothing`)
    let pane = null
    for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
      pane = await presenter.evaluate(readSlide, true)
      if (pane && pane.slide === shown.slide && JSON.stringify(steps(pane)) === JSON.stringify(steps(shown).map((step, i) => (shown.files[i].option ? step : null)))) break
      await presenter.waitForTimeout(25)
    }
    assert.deepEqual(steps(pane), steps(shown).map((step, i) => (shown.files[i].option ? step : null)), `${at}: the presenter's preview shows each file's step`)
    assert.equal(await presenter.evaluate(() => {
      const doc = document.querySelector('#currentPreview iframe').contentDocument
      return doc.querySelectorAll('audio').length === 0 && [...doc.querySelectorAll('video')].every((v) => v.paused)
    }), true, `${at}: the presenter's preview is silent`)
    return { ...shown, lightbox: JSON.parse(sent.lightbox), focus: message.focus, preview: pane, venue: onVenue }
  }
  return { context, session, presenter, projector, venue, press, next: (label) => press('ArrowRight', label), back: (label) => press('ArrowLeft', label) }
}

try {
  // ── The compile step, as the pages see it ────────────────────────────────────────────────
  await check('the option beside {autoplay}: {play-on-next} wins, with a warning', async () => {
    assert.deepEqual(on.warnings.filter((w) => w.startsWith('play-on-next')), ['play-on-next-autoplay:auto:theme.wav'])
    assert.deepEqual(off.warnings.filter((w) => w.startsWith('play-on-next')), [])
  })

  {
    const { context, session, presenter, projector, venue, press, next, back } = await pair('/on.html')
    assert.equal((await projector.evaluate(readSlide, false)).slide, 'start')

    // ── a video ─────────────────────────────────────────────────────────────────────────────
    await check('video: arrives paused on its first frame; Next plays it on the projector only; Next stops it and moves on', async () => {
      let shown = await next('video-waiting')
      assert.equal(shown.slide, 'video')
      assert.deepEqual(shown.files, [{ kind: 'video', option: true, step: 'waiting', playing: false, rewound: true, atEnd: false, muted: false, chip: null, block: null, mark: null, tap: null }])
      assert.equal(shown.preview.files[0].mark, 'plays on Next', 'the presenter\'s preview marks the file before its step')
      assert.equal(await presenter.evaluate(() => Boolean(document.querySelector('#currentPreview iframe').contentDocument.querySelector('.media-step-mark svg'))), true, 'the mark carries an icon from the presenter\'s icon set')
      assert.equal(shown.venue.files[0].mark, null, 'no mark on the venue screen')
      shown = await next('video-playing')
      assert.equal(shown.slide, 'video', 'Next stays on the slide: the file is a step')
      assert.deepEqual([steps(shown), playing(shown), shown.files[0].muted, shown.files[0].mark], [['playing'], [true], false, null], 'the projector plays it, with sound, and shows no mark')
      assert.equal(shown.preview.files[0].mark, 'playing', 'the presenter\'s preview says the video is playing')
      // The slide's flat order is [paragraph, file]: its reveal order ends at step 3 (two blocks and
      // the closing step), so "no mode, one step taken" goes out as reveal step 3 + 1 + 1 (ADR-0035).
      assert.deepEqual(shown.focus, { kind: 'reveal', step: 5 }, 'sent in the existing focus field, as a reveal step past the slide\'s reveal order')
      // A re-render of the same step never restarts the file.
      const plays = await projector.evaluate(() => window.__plays)
      await projector.evaluate(() => window.dispatchEvent(new Event('resize')))
      await projector.waitForTimeout(300)
      assert.equal(await projector.evaluate(() => window.__plays), plays, 'a re-render asks for nothing')
      assert.equal(plays, 1, 'one press, one play()')
      shown = await next()
      assert.equal(shown.slide, 'audio', 'the next press moves on')
      const left = await projector.evaluate(() => { const v = document.querySelector('.slide[data-id="video"] video'); return { paused: v.paused, time: v.currentTime, step: v.closest('figure').getAttribute('data-media-step') } })
      assert.deepEqual(left, { paused: true, time: 0, step: null }, 'leaving the slide stops the file and returns it to "not yet played"')
    })

    await check('video: Back from the next slide never starts it: the slide lands finished, the video on its last frame; Back again: not yet played; Next plays it', async () => {
      const plays = await projector.evaluate(() => window.__plays)
      let shown = await back()
      assert.deepEqual([shown.slide, steps(shown), playing(shown)], ['video', ['played'], [false]], 'nothing plays on the projector')
      assert.deepEqual([steps(shown.venue), playing(shown.venue)], [['played'], [false]], 'nor on the venue screen')
      assert.equal(await projector.evaluate(() => window.__plays), plays, 'no play() was asked for')
      // Sent in the existing focus field: one past the no-mode range (reveal order 3, + 1, + 1 step, + 1).
      assert.deepEqual(shown.focus, { kind: 'reveal', step: 6 })
      assert.equal(shown.preview.files[0].mark, null, 'the presenter sees no "plays on Next" mark: it has played')
      for (const page of [projector, venue]) {
        await page.waitForFunction(() => { const v = document.querySelector('.slide.active video'); return isFinite(v.duration) && v.currentTime >= v.duration - 0.05 }, null, { timeout: 8000 })
      }
      shown = await projector.evaluate(readSlide, false)
      assert.deepEqual([shown.files[0].atEnd, shown.files[0].playing], [true, false], 'the video rests on its last frame')
      shown = await back()
      assert.deepEqual([shown.slide, steps(shown), playing(shown), shown.files[0].rewound], ['video', ['waiting'], [false], true], 'one Back: not yet played, on its first frame')
      assert.deepEqual([steps(shown.venue), playing(shown.venue), shown.venue.files[0].rewound], [['waiting'], [false], true])
      assert.equal(shown.preview.files[0].mark, 'plays on Next')
      assert.equal(await projector.evaluate(() => window.__plays), plays, 'still no play()')
      shown = await next()
      assert.deepEqual([shown.slide, steps(shown), playing(shown)], ['video', ['playing'], [true]], 'Next onto its step plays it')
      shown = await back()
      assert.deepEqual([steps(shown), playing(shown), shown.files[0].rewound], [['waiting'], [false], true], 'Back from the playing step stops it and rewinds it')
      assert.equal((await back()).slide, 'start')
      await next()
    })

    await check('the presenter\'s Play / Pause still works on the file by hand, before and at its step', async () => {
      const video = () => projector.evaluate(() => { const v = document.querySelector('.slide.active video'); return { paused: v.paused, moved: v.currentTime > 0, step: v.closest('figure').getAttribute('data-media-step') } })
      await presenter.waitForFunction(() => !document.getElementById('presenterMedia')?.hidden)
      await presenter.keyboard.press('m')
      await projector.waitForFunction(() => { const v = document.querySelector('.slide.active video'); return !v.paused && v.currentTime > 0 })
      assert.deepEqual(await video(), { paused: false, moved: true, step: 'waiting' }, 'M plays it before its step')
      await presenter.click('#presenterMediaPause')
      await projector.waitForFunction(() => document.querySelector('.slide.active video').paused)
      let shown = await next()
      assert.deepEqual([steps(shown), playing(shown)], [['playing'], [true]], 'Next still starts it')
      await presenter.click('#presenterMediaPause')
      await projector.waitForFunction(() => document.querySelector('.slide.active video').paused)
      await projector.evaluate(() => window.dispatchEvent(new Event('resize')))
      await projector.waitForTimeout(300)
      assert.deepEqual(await video(), { paused: true, moved: true, step: 'playing' }, 'paused by hand at its step, it stays paused')
      await presenter.click('#presenterMediaPlay')
      await projector.waitForFunction(() => !document.querySelector('.slide.active video').paused)
      assert.equal((await video()).paused, false, 'Play resumes it')
    })

    // ── a projector window opened mid-step ──────────────────────────────────────────────────
    await check('a projector window opened while the file plays starts it', async () => {
      const late = await context.newPage()
      late.on('pageerror', (error) => { failures += 1; console.error(`FAIL page error: ${error.message}`) })
      await late.goto(`${origin}/on.html?audience=1&session=${session}`, { waitUntil: 'load' })
      await late.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'video', null, { timeout: 8000 })
      await late.waitForFunction(settled, null, { timeout: 8000, polling: 50 })
      const shown = await late.evaluate(readSlide, false)
      assert.deepEqual([steps(shown), playing(shown), shown.files[0].muted], [['playing'], [true], false], 'it joins at the playing step, with sound')
      await late.close()
    })

    // ── an audio chip ───────────────────────────────────────────────────────────────────────
    await check('audio chip: ready on arrival; Next plays it on the projector only; Next shows it finished and moves on; Back stops and rewinds', async () => {
      let shown = await next('audio-waiting')
      assert.equal(shown.slide, 'audio')
      assert.deepEqual([steps(shown), playing(shown), shown.files[0].chip, shown.files[0].rewound], [['waiting'], [false], 'ready', true])
      assert.equal(shown.preview.files[0].mark, 'plays on Next')
      assert.equal(shown.venue.files[0].mark, null)
      shown = await next('audio-playing')
      assert.deepEqual([shown.slide, steps(shown), playing(shown), shown.files[0].chip], ['audio', ['playing'], [true], 'playing'])
      assert.equal(shown.venue.files[0].chip, 'playing', 'the venue screen\'s chip plays too')
      assert.equal(shown.preview.files[0].mark, null, 'the mark goes once the file plays')
      await presenter.waitForFunction(() => document.querySelector('#currentPreview iframe')?.contentDocument?.querySelector('.slide-audio')?.dataset.audioState === 'playing', null, { timeout: 8000 })
      shown = await back()
      assert.deepEqual([shown.slide, steps(shown), playing(shown), shown.files[0].chip, shown.files[0].rewound], ['audio', ['waiting'], [false], 'ready', true], 'Back stops it and rewinds it')
      shown = await next()
      assert.deepEqual([steps(shown), shown.files[0].chip], [['playing'], 'playing'])
      shown = await next()
      assert.equal(shown.slide, 'two')
      assert.deepEqual(await projector.evaluate(() => { const a = document.querySelector('.slide[data-id="audio"] audio'); return { paused: a.paused, time: a.currentTime, chip: a.closest('.slide-audio').dataset.audioState } }), { paused: true, time: 0, chip: 'ready' })
    })

    await check('audio chip: Back from the next slide never starts it: the chip shows finished; Back again: ready and rewound; Next plays it', async () => {
      const plays = await projector.evaluate(() => window.__plays)
      let shown = await back()
      assert.deepEqual([shown.slide, steps(shown), playing(shown), shown.files[0].chip], ['audio', ['played'], [false], 'finished'], 'nothing plays on the projector')
      assert.deepEqual([steps(shown.venue), playing(shown.venue), shown.venue.files[0].chip], [['played'], [false], 'finished'], 'nor on the venue screen')
      assert.equal(shown.preview.files[0].mark, null)
      shown = await back()
      assert.deepEqual([shown.slide, steps(shown), playing(shown), shown.files[0].chip, shown.files[0].rewound], ['audio', ['waiting'], [false], 'ready', true])
      assert.deepEqual([steps(shown.venue), playing(shown.venue), shown.venue.files[0].chip], [['waiting'], [false], 'ready'])
      assert.equal(await projector.evaluate(() => window.__plays), plays, 'no play() was asked for by either Back')
      shown = await next()
      assert.deepEqual([steps(shown), playing(shown), shown.files[0].chip], [['playing'], [true], 'playing'], 'Next onto its step plays it')
      assert.equal((await next()).slide, 'two')
    })

    // ── two files on one slide ──────────────────────────────────────────────────────────────
    await check('two files on one slide: each is a step in page order, and only the newest plays', async () => {
      let shown = await projector.evaluate(readSlide, false)
      assert.deepEqual([shown.slide, steps(shown), playing(shown)], ['two', ['waiting', 'waiting'], [false, false]])
      shown = await next()
      assert.deepEqual([shown.slide, steps(shown), playing(shown), shown.files.map((f) => f.chip)], ['two', ['playing', 'waiting'], [true, false], ['playing', 'ready']])
      assert.deepEqual(shown.preview.files.map((f) => f.mark), [null, 'plays on Next'])
      shown = await next()
      assert.deepEqual([shown.slide, steps(shown), playing(shown), shown.files.map((f) => f.chip)], ['two', ['played', 'playing'], [false, true], ['finished', 'playing']], 'the first stops and shows finished; the second plays')
      assert.deepEqual(shown.venue.files.map((f) => f.chip), ['finished', 'playing'])
      shown = await back()
      assert.deepEqual([steps(shown), playing(shown), shown.files.map((f) => f.chip)], [['waiting', 'waiting'], [false, false], ['ready', 'ready']], 'Back: the second is rewound, and the first is not started again (Back never starts a file)')
      await next(); await next()
      assert.equal((await next()).slide, 'reveal')
    })

    // ── with {reveal} ───────────────────────────────────────────────────────────────────────
    await check('{reveal}: the file is one step among the others; the press that shows it starts it', async () => {
      const seen = []
      let shown = await projector.evaluate(readSlide, false)
      for (let i = 0; i < 12 && shown.slide === 'reveal'; i += 1) {
        seen.push({ blocks: shown.blocks.join(' '), file: shown.files[0].block, step: shown.files[0].step, playing: shown.files[0].playing, mode: shown.mode })
        shown = await next()
      }
      assert.equal(shown.slide, 'emphasis')
      assert.equal(seen.length, 5, 'arrival, three blocks (two items and the file), the closing step')
      assert(seen.every((s) => s.mode === 'reveal'))
      const at = seen.findIndex((s) => s.step === 'playing')
      assert(at > 0, 'the file plays at one step')
      assert.equal(seen.filter((s) => s.step === 'playing').length, 1)
      assert.equal(seen[at].file, 'current', 'the step that shows the file is the step that plays it: one step, not two')
      seen.forEach((s, i) => {
        if (i < at) assert.deepEqual([s.file, s.step, s.playing], ['hidden', 'waiting', false], `step ${i}: hidden and not started`)
        if (i > at) assert.deepEqual([s.step, s.playing], ['played', false], `step ${i}: stopped`)
      })
      assert.equal(seen.at(-1).file, 'full')
      // Back across the slide: the exact reverse.
      shown = await back()
      const reverse = []
      for (let i = 0; i < 12 && shown.slide === 'reveal'; i += 1) { reverse.push(shown.files[0].step); shown = await back() }
      assert.deepEqual(reverse, seen.map((s) => s.step).filter((step) => step !== 'playing').reverse(), 'Back passes over the step that plays the file: it is hidden again, never started')
      assert.equal(shown.slide, 'two')
      // Forward again: off the end of Two, then through Reveal's five presses.
      for (let i = 0; i < 6; i += 1) await next()
    })

    // ── with {emphasis-steps} ───────────────────────────────────────────────────────────────
    await check('{emphasis-steps}: emphasis and the file interleave in page order', async () => {
      let shown = await projector.evaluate(readSlide, false)
      assert.deepEqual([shown.slide, shown.emphasis, steps(shown)], ['emphasis', ['off', 'off'], ['waiting']])
      shown = await next()
      assert.deepEqual([shown.emphasis, steps(shown), playing(shown)], [['on', 'off'], ['waiting'], [false]], 'the bold above the file comes first')
      shown = await next()
      assert.deepEqual([shown.emphasis, steps(shown), playing(shown)], [['on', 'off'], ['playing'], [true]], 'then the file plays; the highlight below it is still off')
      shown = await next()
      assert.deepEqual([shown.slide, shown.emphasis, steps(shown), playing(shown), shown.files[0].chip], ['emphasis', ['on', 'on'], ['played'], [false], 'finished'], 'then the file stops and the highlight comes on')
      assert.equal((await next()).slide, 'images')
    })

    // ── with {image-steps} ──────────────────────────────────────────────────────────────────
    await check('{image-steps}: the file first, then the images; the file stops when the images begin', async () => {
      let shown = await projector.evaluate(readSlide, false)
      assert.deepEqual([shown.slide, steps(shown), shown.files.length], ['images', ['waiting'], 1], 'the audio chip is the only file; images are not files')
      shown = await next()
      assert.deepEqual([steps(shown), playing(shown), shown.lightbox], [['playing'], [true], { open: false, index: 0 }], 'Next plays the file before any image is enlarged')
      shown = await next()
      assert.deepEqual([shown.slide, steps(shown), playing(shown), shown.lightbox], ['images', ['played'], [false], { open: true, index: 0 }], 'then the first image, and the file stops')
      shown = await back()
      assert.deepEqual([steps(shown), playing(shown), shown.files[0].chip, shown.lightbox], [['waiting'], [false], 'ready', { open: false, index: 0 }], 'Back out of the first image does not start the file again')
      shown = await next()
      assert.deepEqual([steps(shown), playing(shown)], [['playing'], [true]])
      await next()
      shown = await next()
      assert.deepEqual([steps(shown), shown.lightbox], [['played'], { open: true, index: 1 }])
      shown = await next()
      assert.deepEqual([steps(shown), playing(shown), shown.lightbox], [['played'], [false], { open: false, index: 2 }], 'the slide again: the file stays stopped')
      assert.equal((await next()).slide, 'nostep')
      shown = await back()
      assert.deepEqual([shown.slide, steps(shown), playing(shown), shown.lightbox], ['images', ['played'], [false], { open: false, index: 2 }], 'Back lands after the images: nothing plays')
      await back(); await back()
      shown = await back()
      assert.deepEqual([steps(shown), playing(shown), shown.lightbox], [['played'], [false], { open: false, index: 0 }], 'Back out of the images: the slide as laid out, the file still finished')
      shown = await back()
      assert.deepEqual([steps(shown), playing(shown), shown.files[0].chip], [['waiting'], [false], 'ready'])
      for (let i = 0; i < 5; i += 1) await next()
    })

    // ── {nostep} ────────────────────────────────────────────────────────────────────────────
    await check('{nostep}: the file behaves as a file without the option', async () => {
      const shown = await projector.evaluate(readSlide, false)
      assert.equal(shown.slide, 'nostep')
      assert.deepEqual([shown.stamped, shown.files.map((f) => [f.option, f.step, f.playing])], [false, [[false, null, false]]])
      const after = await next()
      assert.equal(after.slide, 'auto', 'Next goes straight to the next slide')
    })

    // ── the option beside {autoplay} ────────────────────────────────────────────────────────
    await check('the option beside {autoplay}: nothing plays on arrival; Next plays it', async () => {
      await projector.waitForTimeout(500)
      let shown = await projector.evaluate(readSlide, false)
      assert.deepEqual([shown.slide, steps(shown), playing(shown), shown.files[0].chip], ['auto', ['waiting'], [false], 'ready'])
      assert.equal(await projector.evaluate(() => document.querySelector('.slide.active .slide-audio').hasAttribute('data-audio-autoplay')), false)
      shown = await next()
      assert.deepEqual([shown.slide, steps(shown), playing(shown)], ['auto', ['playing'], [true]])
      assert.equal((await next()).slide, 'end')
    })
    await context.close()
  }

  // ── a jump to a slide lands at its start ──────────────────────────────────────────────────
  await check('jumping to a slide (not stepping back onto it) lands at its start: the file waits', async () => {
    const { context, presenter, projector, next } = await pair('/on.html')
    for (const id of ['audio', 'video', 'two']) {
      if (id === 'video') { await next(); await projector.waitForFunction(() => document.querySelector('.slide.active .slide-audio')?.dataset.audioState === 'playing') }
      await presenter.evaluate((target) => { location.hash = target }, id)
      await projector.waitForFunction((target) => document.querySelector('.slide.active')?.dataset.id === target, id, { timeout: 5000 })
      await projector.waitForFunction(settled, null, { timeout: 8000, polling: 50 })
      const shown = await projector.evaluate(readSlide, false)
      assert.deepEqual([shown.slide, steps(shown), playing(shown)], [id, shown.files.map(() => 'waiting'), shown.files.map(() => false)], `${id}: at its start`)
    }
    await context.close()
  })

  // ── the option absent ─────────────────────────────────────────────────────────────────────
  await check('the option absent: no new attribute anywhere, no step, nothing plays', async () => {
    const markup = off.fullHtml.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, '')
    assert.doesNotMatch(markup, /data-play-on-next|data-media-steps|data-media-step|media-step-/, 'the compiled talk carries no file-step markup')
    assert.match(markup, /<div class="slide-audio" data-audio-state="ready" data-audio-autoplay /, 'an {autoplay} chip is still an {autoplay} chip')
    const { context, projector, venue, next } = await pair('/off.html')
    const visited = []
    for (let i = 0; i < 20; i += 1) {
      const shown = await next()
      if (shown.lightbox.open) continue
      if (visited.at(-1) !== shown.slide) visited.push(shown.slide)
      for (const page of [projector, venue]) {
        assert.equal(await page.evaluate(() => document.querySelectorAll('[data-play-on-next], [data-media-steps], [data-media-step], .media-step-mark, .media-step-tap').length), 0, `${shown.slide}: nothing is marked`)
      }
      // The {autoplay} chip of the Auto slide is the one file that plays, as it always did, and only on the projector.
      if (shown.slide !== 'auto') assert.deepEqual(playing(shown), shown.files.map(() => false), `${shown.slide}: nothing plays`)
      if (shown.slide === 'end') break
    }
    // Next goes slide to slide, apart from the steps the slides had before: Reveal's own and the image sequence.
    assert.deepEqual(visited, ['video', 'audio', 'two', 'reveal', 'emphasis', 'images', 'nostep', 'auto', 'end'])
    await context.close()
  })

  // ── the venue screen, fed only SlideState, with a browser that refuses sound ──────────────
  await check('venue screen, play() refused: a video plays muted with "Tap for sound"; an audio chip shows "Tap to play"; neither is marked started until it plays', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const venue = await context.newPage()
    venue.on('pageerror', (error) => { failures += 1; console.error(`FAIL page error: ${error.message}`) })
    await venue.addInitScript(liveServiceStandIn)
    await venue.addInitScript(refuseSound)
    await venue.goto(`${origin}/venue/on.html`, { waitUntil: 'load' })
    await venue.waitForFunction(() => window.__sockets.length === 1)
    const send = async (label) => {
      await venue.evaluate((state) => window.__sockets.at(-1).emit(state), venueMessage(published[label]))
      await venue.locator(`.slide.active[data-id="${published[label].slide}"]`).waitFor()
    }
    const file = () => venue.evaluate(() => {
      const el = document.querySelector('.slide.active [data-play-on-next]')
      const media = el.querySelector('video, audio')
      return { step: el.getAttribute('data-media-step'), started: el.hasAttribute('data-media-step-started'), playing: !media.paused, muted: media.muted, tap: el.querySelector('.media-step-tap')?.textContent ?? null, chip: el.dataset.audioState ?? null }
    })
    await send('video-waiting')
    assert.deepEqual(await file(), { step: 'waiting', started: false, playing: false, muted: false, tap: null, chip: null })
    assert.equal(await venue.evaluate(() => window.__plays), 0, 'nothing is asked to play before its step')
    await send('video-playing')
    await venue.waitForFunction(() => document.querySelector('.slide.active .media-step-tap'), null, { timeout: 8000 })
    await venue.waitForFunction(() => { const v = document.querySelector('.slide.active video'); return !v.paused && v.currentTime > 0 }, null, { timeout: 8000 })
    assert.deepEqual(await file(), { step: 'playing', started: true, playing: true, muted: true, tap: 'Tap for sound', chip: null }, 'silence is not acceptable: it plays, muted, and offers sound')
    // The same step sent again (a reconnect) does not restart it or drop the control.
    const before = await venue.evaluate(() => window.__plays)
    await send('video-playing')
    await venue.waitForTimeout(200)
    assert.equal(await venue.evaluate(() => window.__plays), before, 'a repeated state asks for nothing')
    assert.equal((await file()).tap, 'Tap for sound')
    await venue.evaluate(() => { window.__gesture = true })
    await venue.click('.slide.active .media-step-tap')
    assert.deepEqual(await file(), { step: 'playing', started: true, playing: true, muted: false, tap: null, chip: null }, 'the tap turns the sound on')
    // Muted again by a refusal, then the step moves on: stopped, unmuted, no control left.
    await venue.evaluate(() => { window.__gesture = false })
    await send('video-waiting')
    assert.deepEqual(await file(), { step: 'waiting', started: false, playing: false, muted: false, tap: null, chip: null })
    await send('video-playing')
    await venue.waitForFunction(() => document.querySelector('.slide.active .media-step-tap'), null, { timeout: 8000 })
    await send('audio-waiting')
    assert.deepEqual(await venue.evaluate(() => { const v = document.querySelector('.slide[data-id="video"] video'); return { paused: v.paused, muted: v.muted, time: v.currentTime, tap: Boolean(v.closest('figure').querySelector('.media-step-tap')) } }), { paused: true, muted: false, time: 0, tap: false })
    // The audio chip.
    assert.deepEqual(await file(), { step: 'waiting', started: false, playing: false, muted: false, tap: null, chip: 'ready' })
    assert.equal(await venue.evaluate(() => document.querySelectorAll('.slide.active .slide-audio audio').length), 1, 'the venue page keeps the <audio> of a {play-on-next} chip')
    await send('audio-playing')
    await venue.waitForFunction(() => document.querySelector('.slide.active .media-step-tap'), null, { timeout: 8000 })
    assert.deepEqual(await file(), { step: 'playing', started: false, playing: false, muted: false, tap: 'Tap to play', chip: 'ready' }, 'refused: the chip stays ready and is not marked started')
    await venue.evaluate(() => { window.__gesture = true })
    await venue.click('.slide.active .media-step-tap')
    await venue.waitForFunction(() => document.querySelector('.slide.active .slide-audio').dataset.audioState === 'playing', null, { timeout: 8000 })
    assert.deepEqual(await file(), { step: 'playing', started: true, playing: true, muted: false, tap: null, chip: 'playing' })
    await context.close()
  })

  // ── a plain deck (no presenter): the same rule for a refused play() ───────────────────────
  await check('plain deck: Next plays the file; a refused play() falls back to muted with "Tap for sound"', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    page.on('pageerror', (error) => { failures += 1; console.error(`FAIL page error: ${error.message}`) })
    await page.addInitScript(refuseSound)
    await page.goto(`${origin}/on.html#video`, { waitUntil: 'load' })
    await page.waitForSelector('.slide.active video')
    await page.evaluate(() => { window.__gesture = true })
    await page.keyboard.press('ArrowRight')
    await page.waitForFunction(settled, null, { timeout: 8000, polling: 50 })
    let shown = await page.evaluate(readSlide, false)
    assert.deepEqual([shown.slide, steps(shown), playing(shown), shown.files[0].muted, shown.files[0].tap, shown.files[0].mark], ['video', ['playing'], [true], false, null, null])
    await page.keyboard.press('ArrowLeft')
    await page.waitForFunction(settled, null, { timeout: 8000, polling: 50 })
    await page.evaluate(() => { window.__gesture = false })
    await page.keyboard.press('ArrowRight')
    await page.waitForFunction(() => document.querySelector('.slide.active .media-step-tap'), null, { timeout: 8000 })
    shown = await page.evaluate(readSlide, false)
    assert.deepEqual([steps(shown), playing(shown), shown.files[0].muted, shown.files[0].tap], [['playing'], [true], true, 'Tap for sound'])
    await page.keyboard.press('ArrowRight')
    await page.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'audio')
    assert.deepEqual(await page.evaluate(() => { const v = document.querySelector('.slide[data-id="video"] video'); return { paused: v.paused, muted: v.muted, tap: Boolean(v.closest('figure').querySelector('.media-step-tap')) } }), { paused: true, muted: false, tap: false })
    await page.close()
  })

  // ── a file played by hand before its step is rewound when the slide is left ────────────────
  await check('a file played by hand before its step is rewound when the slide is left: back on the slide it is at its start', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    page.on('pageerror', (error) => { failures += 1; console.error(`FAIL page error: ${error.message}`) })
    const goTo = async (id) => {
      await page.evaluate((target) => { location.hash = target }, id)
      await page.waitForFunction((target) => document.querySelector('.slide.active')?.dataset.id === target, id)
    }
    const media = (id) => page.evaluate((target) => {
      const m = document.querySelector(`.slide[data-id="${target}"] :is(video, audio)`)
      const file = m.closest('[data-play-on-next]')
      return { paused: m.paused, time: m.currentTime, step: file.getAttribute('data-media-step'), chip: file.dataset.audioState ?? null }
    }, id)
    await page.goto(`${origin}/on.html#video`, { waitUntil: 'load' })
    await page.waitForSelector('.slide.active video')
    // Paused by hand part-way, then the slide is left.
    await page.evaluate(() => document.querySelector('.slide.active video').play())
    await page.waitForFunction(() => document.querySelector('.slide.active video').currentTime > 0.2)
    await page.evaluate(() => document.querySelector('.slide.active video').pause())
    assert.equal((await media('video')).step, 'waiting', 'played by hand, its step has not come')
    await goTo('start')
    assert.deepEqual(await media('video'), { paused: true, time: 0, step: null, chip: null }, 'left while paused part-way: rewound')
    await goTo('video')
    assert.deepEqual(await media('video'), { paused: true, time: 0, step: 'waiting', chip: null }, 'back on the slide: its first frame')
    // Still playing by hand when the slide is left.
    await page.evaluate(() => document.querySelector('.slide.active video').play())
    await page.waitForFunction(() => document.querySelector('.slide.active video').currentTime > 0.2)
    await goTo('audio')
    assert.deepEqual(await media('video'), { paused: true, time: 0, step: null, chip: null }, 'left while playing: stopped and rewound')
    // The same for an audio chip.
    await page.evaluate(() => document.querySelector('.slide.active audio').play())
    await page.waitForFunction(() => document.querySelector('.slide.active audio').currentTime > 0.2)
    await page.evaluate(() => document.querySelector('.slide.active audio').pause())
    await goTo('start')
    assert.deepEqual(await media('audio'), { paused: true, time: 0, step: null, chip: 'ready' })
    await goTo('audio')
    assert.deepEqual(await media('audio'), { paused: true, time: 0, step: 'waiting', chip: 'ready' }, 'the chip is ready and at its start')
    await page.close()
  })

  // ── the keyboard on the "Tap for sound" / "Tap to play" control ───────────────────────────
  await check('Space and Enter on the focused tap control activate it and do not move the deck; arrows still do', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    page.on('pageerror', (error) => { failures += 1; console.error(`FAIL page error: ${error.message}`) })
    await page.addInitScript(refuseSound)
    await page.goto(`${origin}/on.html#video`, { waitUntil: 'load' })
    await page.waitForSelector('.slide.active video')
    const tap = '.slide.active .media-step-tap'
    const state = () => page.evaluate(() => {
      const file = document.querySelector('.slide.active [data-play-on-next]')
      const m = file.querySelector('video, audio')
      return { slide: document.querySelector('.slide.active').dataset.id, step: file.getAttribute('data-media-step'), playing: !m.paused, muted: m.muted, tap: file.querySelector('.media-step-tap')?.textContent ?? null }
    })
    await page.keyboard.press('ArrowRight')
    await page.waitForSelector(tap)
    // Another key on the focused control still reaches the deck.
    await page.focus(tap)
    await page.keyboard.press('ArrowLeft')
    await page.waitForFunction(() => document.querySelector('.slide.active [data-play-on-next]').getAttribute('data-media-step') === 'waiting')
    assert.deepEqual(await state(), { slide: 'video', step: 'waiting', playing: false, muted: false, tap: null }, 'Left on the control is the deck\'s Back')
    await page.keyboard.press('ArrowRight')
    await page.waitForSelector(tap)
    for (const key of ['Space', 'Enter']) {
      await page.waitForFunction(() => !document.querySelector('.slide.active :is(video, audio)').paused || document.querySelector('.slide.active .slide-audio'))
      await page.focus(tap)
      await page.evaluate(() => { window.__gesture = true })
      await page.keyboard.press(key)
      await page.waitForFunction(() => { const m = document.querySelector('.slide.active :is(video, audio)'); return m && !m.paused && !m.muted })
      await page.waitForTimeout(200)
      const now = await state()
      assert.deepEqual([now.step, now.playing, now.muted, now.tap], ['playing', true, false, null], `${key} activates the control`)
      assert.equal(now.slide, key === 'Space' ? 'video' : 'audio', `${key} does not move the deck`)
      if (key === 'Space') {
        // On to the audio chip, with sound refused again: "Tap to play".
        await page.evaluate(() => document.activeElement?.blur())
        await page.keyboard.press('ArrowRight')
        await page.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'audio')
        await page.evaluate(() => { window.__gesture = false })
        await page.keyboard.press('ArrowRight')
        await page.waitForSelector(tap)
        assert.equal((await state()).tap, 'Tap to play')
      }
    }
    await page.close()
  })

  // ── documents that never play ─────────────────────────────────────────────────────────────
  for (const [route, label] of [['preview-gate', 'a preview document with the files still present (the runtime gate)'], ['preview', 'a document marked by markSlidePreviewHtml (thumbnails, Slide Focus, Inspector)']]) {
    await check(`${label} never calls play() or load(), also when stepped`, async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
      await page.addInitScript(countMedia)
      for (const id of ['video', 'audio']) {
        await page.goto(`${origin}/${route}.html#${id}`, { waitUntil: 'load' })
        await page.waitForSelector(`.slide.active[data-id="${id}"]`)
        await page.keyboard.press('ArrowRight')
        await page.waitForTimeout(400)
        const seen = await page.evaluate(() => ({
          preview: document.body.hasAttribute('data-tw-preview'), slide: document.querySelector('.slide.active').dataset.id,
          plays: window.__plays, loads: window.__loads,
          stepped: document.querySelectorAll('[data-media-step], .media-step-tap, .media-step-mark').length,
          playing: [...document.querySelectorAll('video, audio')].some((m) => !m.paused)
        }))
        assert.deepEqual(seen, { preview: true, slide: id, plays: 0, loads: 0, stepped: 0, playing: false }, `${id}: the file is shown in its static form`)
      }
      await page.close()
    })
  }
  await check('a handout and a following phone show the file in its static form and never play it', async () => {
    assert.equal((pages['/handout.html'].match(/<audio\b/g) || []).length, 0, 'the handout carries no <audio>')
    for (const route of ['/handout.html', '/follower.html']) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
      await page.addInitScript(countMedia)
      if (route === '/follower.html') await page.addInitScript(liveServiceStandIn)
      await page.goto(`${origin}${route}#video`, { waitUntil: 'load' })
      if (route === '/follower.html') {
        await page.waitForFunction(() => window.__sockets.length === 1)
        for (const label of ['video-playing', 'audio-playing']) {
          await page.evaluate((state) => window.__sockets.at(-1).emit(state), venueMessage(published[label]))
          await page.locator(`.slide.active[data-id="${published[label].slide}"]`).waitFor()
          await page.waitForTimeout(200)
        }
      } else {
        await page.keyboard.press('ArrowRight')
        await page.waitForTimeout(300)
      }
      const seen = await page.evaluate(() => ({ plays: window.__plays, loads: window.__loads, audio: document.querySelectorAll('audio').length, stepped: document.querySelectorAll('[data-media-step], .media-step-tap, .media-step-mark').length, playing: [...document.querySelectorAll('video')].some((v) => !v.paused) }))
      assert.deepEqual(seen, { plays: 0, loads: 0, audio: 0, stepped: 0, playing: false }, route)
      await page.close()
    }
  })
} finally {
  await browser.close()
  server.close()
}

if (failures) { console.error(`\n${failures} failing`); process.exit(1) }
console.log('PASS media-steps DOM: video, audio chip, two files, {reveal}, {emphasis-steps}, {image-steps}, {nostep}, option absent, with {autoplay}, late projector, venue from SlideState alone, refused play(), preview documents, handout and phone, presenter preview and Play / Pause')
