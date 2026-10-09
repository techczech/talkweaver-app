// Ticket 04 of 0.38 — the audio chip in a real browser: its three states, the projector playing it
// from the presenter's M key / Play control, the silent presenter preview, and leaving the slide.
//  1. Plain deck: a manual chip is ready; an {autoplay} chip plays when its slide becomes live, shows
//     animated bars and a running time, ends as `finished`; a {loop} chip never finishes; leaving the
//     slide stops it and returns it to ready. The chip's width is identical in all three states and while
//     the time advances; the time uses tabular figures; reduced motion stops the bars.
//  2. Presenter + projector (paired over one session): M plays the file in the PROJECTOR window only;
//     the presenter's current-slide preview shows playing then finished and holds no <audio> element;
//     the Pause control pauses; going to the next slide stops the projector's audio.
//  3. Headless Chromium only (never the installed Chrome).
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { markSlidePreviewHtml } from '../src/shared/slide-preview.ts'

// A real, silent, one-second 8-bit mono WAV (8 kHz): decodes in headless Chromium, makes no sound.
function silentWav(seconds) {
  const rate = 8000
  const n = rate * seconds
  const buf = Buffer.alloc(44 + n, 0x80)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8); buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34); buf.write('data', 36); buf.writeUInt32LE(n, 40)
  return buf
}

const dir = await mkdtemp(join(tmpdir(), 'tw-audio-dom-'))
await mkdir(join(dir, 'assets'), { recursive: true })
await writeFile(join(dir, 'assets', 'short.wav'), silentWav(1))
await writeFile(join(dir, 'assets', 'a-very-long-file-name-for-a-chip-that-must-ellipsise-in-one-line-and-never-wrap.wav'), silentWav(1))
const outline = [
  '---', 'title: Audio chips', '---', '',
  '### Manual', '', 'Words on the slide.', '', '![Interview](assets/short.wav)', '',
  '### Auto', '', 'Words on the slide.', '', '![Theme](assets/short.wav){autoplay}', '',
  '### Looping', '', 'Words on the slide.', '', '![Loop](assets/short.wav){autoplay}{loop}', '',
  '### Long', '', '![A very long title that has to be cut with an ellipsis rather than wrap onto a second line or push the chip wider than its slide](assets/short.wav)', '',
  '### Nameless', '', '![](assets/a-very-long-file-name-for-a-chip-that-must-ellipsise-in-one-line-and-never-wrap.wav)', ''
].join('\n')
const outlinePath = join(dir, 'chips-outline.md')
await writeFile(outlinePath, outline, 'utf8')
const model = await prepareSource(outlinePath, outline, null, await stat(outlinePath), {}, {})
const ids = model.slides.map((s) => s.id)
const idOf = (heading) => model.slides.find((s) => s.title === heading || s.navTitle === heading).id

const server = createServer((req, res) => {
  if (!/^\/deck(-gate|-preview)?\.html/.test(req.url)) { res.writeHead(404); res.end(); return }
  // /deck.html?...: the deck as compiled. /deck-gate.html: only the preview hook added, the <audio> kept
  // (the runtime gate alone). /deck-preview.html: the real preview marking (hook, and the <audio> dropped).
  const html = req.url.startsWith('/deck-gate') ? model.fullHtml.replace(/<body\b([^>]*)>/i, '<body$1 data-tw-preview>') : req.url.startsWith('/deck-preview') ? markSlidePreviewHtml(model.fullHtml) : model.fullHtml
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] })
let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`) } catch (error) { failures++; console.error(`FAIL ${name}\n     ${error?.stack ?? error}`) }
}
const chipState = (page, selector = '.slide.active .slide-audio') => page.evaluate((sel) => document.querySelector(sel)?.dataset.audioState, selector)
const waitState = (page, want, selector = '.slide.active .slide-audio') =>
  page.waitForFunction(([sel, w]) => document.querySelector(sel)?.dataset.audioState === w, [selector, want], { timeout: 8000, polling: 50 })

try {
  // ── 1. plain deck ─────────────────────────────────────────────────────────────────────────
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('pageerror', (error) => { throw new Error(`page error ${error.message}`) })
  await page.goto(`${origin}/deck.html#${idOf('Manual')}`, { waitUntil: 'load' })
  await page.waitForSelector('.slide.active .slide-audio')

  await check('the chip is a plain block with the speaker icon, the title and no media markup', async () => {
    const info = await page.evaluate(() => {
      const chip = document.querySelector('.slide.active .slide-audio')
      return {
        title: chip.querySelector('.slide-audio-title').textContent,
        icon: Boolean(chip.querySelector('.slide-audio-icon svg')),
        tag: chip.tagName,
        inFigure: Boolean(chip.closest('figure')),
        layout: document.querySelector('.slide.active .slide-content').className,
        zoomable: document.querySelectorAll('.slide.active figure.slide-figure, .slide.active video').length
      }
    })
    assert.equal(info.title, 'Interview')
    assert(info.icon)
    assert.equal(info.tag, 'DIV')
    assert.equal(info.inFigure, false)
    assert.equal(info.zoomable, 0, 'no figure or video: nothing for the Z gallery or a reveal step')
    assert.doesNotMatch(info.layout, /layout-(media|copy-visual|list-visual)/)
    assert.equal(await chipState(page), 'ready')
  })

  await check('ready, playing and finished: the chip keeps one width, the time is tabular', async () => {
    const widths = {}
    const measure = (label) => page.evaluate(() => document.querySelector('.slide.active .slide-audio').getBoundingClientRect().width).then((w) => { widths[label] = w })
    await measure('ready')
    await page.evaluate(() => { const a = document.querySelector('.slide.active .slide-audio audio'); a.play() })
    await waitState(page, 'playing')
    await measure('playing')
    const tabular = await page.evaluate(() => getComputedStyle(document.querySelector('.slide.active .slide-audio-time')).fontVariantNumeric)
    assert.match(tabular, /tabular-nums/)
    await page.waitForFunction(() => document.querySelector('.slide.active .slide-audio-time').textContent !== '0:00' || document.querySelector('.slide.active .slide-audio').dataset.audioState === 'finished', null, { timeout: 8000 })
    await waitState(page, 'finished')
    await measure('finished')
    const visible = await page.evaluate(() => getComputedStyle(document.querySelector('.slide.active .slide-audio-time')).visibility)
    assert.equal(visible, 'visible', 'the finished chip keeps its elapsed time')
    assert(Math.abs(widths.ready - widths.playing) < 0.5 && Math.abs(widths.ready - widths.finished) < 0.5, JSON.stringify(widths))
  })

  await check('the bars animate while playing and stop under reduced motion', async () => {
    await page.evaluate(() => { document.querySelector('.slide.active .slide-audio audio').play() })
    await waitState(page, 'playing')
    const name = () => page.evaluate(() => getComputedStyle(document.querySelector('.slide.active .slide-audio-bars > i')).animationName)
    assert.match(await name(), /slide-audio-bar/)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    assert.equal(await name(), 'none')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  })

  await check('leaving the slide stops the audio and returns the chip to ready', async () => {
    await page.evaluate(() => { document.querySelector('.slide.active .slide-audio audio').play() })
    await waitState(page, 'playing')
    await page.evaluate((id) => { location.hash = id }, idOf('Long'))
    await page.waitForFunction((id) => document.querySelector('.slide.active')?.dataset.id === id, idOf('Long'))
    const left = await page.evaluate((id) => {
      const audio = document.querySelector(`.slide[data-id="${id}"] .slide-audio audio`)
      return { paused: audio.paused, time: audio.currentTime, state: audio.closest('.slide-audio').dataset.audioState }
    }, idOf('Manual'))
    assert.deepEqual(left, { paused: true, time: 0, state: 'ready' })
  })

  await check('a paused clip is rewound on leaving the slide, so Play starts from the top', async () => {
    await page.evaluate((id) => { location.hash = id }, idOf('Manual'))
    await page.waitForFunction((id) => document.querySelector('.slide.active')?.dataset.id === id, idOf('Manual'))
    // A longer clip is not needed: pause at once, then force a non-zero position (a mid-clip pause).
    await page.evaluate(() => { document.querySelector('.slide.active .slide-audio audio').play() })
    await waitState(page, 'playing')
    await page.waitForFunction(() => document.querySelector('.slide.active .slide-audio audio').currentTime > 0.1)
    await page.evaluate(() => document.querySelector('.slide.active .slide-audio audio').pause())
    await waitState(page, 'ready')
    assert.equal(await page.evaluate(() => document.querySelector('.slide.active .slide-audio audio').currentTime > 0), true, 'paused mid-clip')
    await page.evaluate((id) => { location.hash = id }, idOf('Long'))
    await page.waitForFunction((id) => document.querySelector('.slide.active')?.dataset.id === id, idOf('Long'))
    assert.equal(await page.evaluate((id) => document.querySelector(`.slide[data-id="${id}"] .slide-audio audio`).currentTime, idOf('Manual')), 0)
  })

  await check('{autoplay} starts when the slide becomes live, and plays once', async () => {
    await page.evaluate((id) => { location.hash = id }, idOf('Auto'))
    await waitState(page, 'playing')
    await waitState(page, 'finished')
    await page.evaluate(() => window.dispatchEvent(new Event('resize'))) // a re-render must not restart a finished clip
    await page.waitForTimeout(300)
    assert.equal(await chipState(page), 'finished')
  })

  await check('{loop} keeps playing past the end of the file', async () => {
    await page.evaluate((id) => { location.hash = id }, idOf('Looping'))
    await waitState(page, 'playing')
    await page.waitForTimeout(1500)
    assert.equal(await chipState(page), 'playing')
    assert.equal(await page.evaluate(() => document.querySelector('.slide.active .slide-audio audio').loop), true)
  })

  await check('a long title is cut to one line and the chip stays inside the slide', async () => {
    await page.evaluate((id) => { location.hash = id }, idOf('Long'))
    await page.waitForSelector('.slide.active .slide-audio')
    const m = await page.evaluate(() => {
      const chip = document.querySelector('.slide.active .slide-audio')
      const title = chip.querySelector('.slide-audio-title')
      const content = document.querySelector('.slide.active .slide-content').getBoundingClientRect()
      return { clipped: title.scrollWidth > title.clientWidth, overflow: getComputedStyle(title).textOverflow, nowrap: getComputedStyle(title).whiteSpace, chipRight: chip.getBoundingClientRect().right, contentRight: content.right, height: chip.getBoundingClientRect().height }
    })
    assert.equal(m.clipped, true)
    assert.equal(m.overflow, 'ellipsis')
    assert.equal(m.nowrap, 'nowrap')
    assert(m.chipRight <= m.contentRight + 1, `${m.chipRight} > ${m.contentRight}`)
    assert(m.height < 80, `one line, got ${m.height}px`)
  })

  await check('with no title the chip shows the file name without its extension', async () => {
    await page.evaluate((id) => { location.hash = id }, idOf('Nameless'))
    await page.waitForSelector('.slide.active .slide-audio')
    assert.match(await page.evaluate(() => document.querySelector('.slide.active .slide-audio-title').textContent), /^a-very-long-file-name-for-a-chip.*never-wrap$/)
  })

  // ── 1b. surfaces that must never play ──────────────────────────────────────────────────────
  const counting = () => {
    window.__plays = 0; window.__loads = 0
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function () { window.__plays++; return play.call(this) }
    const load = HTMLMediaElement.prototype.load
    HTMLMediaElement.prototype.load = function () { window.__loads++; return load.call(this) }
  }
  for (const [route, label] of [['deck-gate', 'a preview document with the <audio> still present (runtime gate)'], ['deck-preview', 'a document marked by markSlidePreviewHtml (thumbnails, Slide Focus, Inspector)']]) {
    await check(`an {autoplay} chip is never played or loaded in ${label}`, async () => {
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } })
      await p.addInitScript(counting)
      const audioRequests = []
      p.on('request', (r) => { if (/\.(wav|mp3)(\?|$)|^data:audio/.test(r.url())) audioRequests.push(r.url().slice(0, 40)) })
      await p.goto(`${origin}/${route}.html#${idOf('Auto')}`, { waitUntil: 'load' })
      await p.waitForSelector('.slide.active .slide-audio')
      await p.waitForTimeout(1200)
      const seen = await p.evaluate(() => ({ plays: window.__plays, loads: window.__loads, state: document.querySelector('.slide.active .slide-audio').dataset.audioState, audios: document.querySelectorAll('audio').length, preview: document.body.hasAttribute('data-tw-preview') }))
      assert.equal(seen.preview, true)
      assert.deepEqual({ plays: seen.plays, loads: seen.loads, state: seen.state }, { plays: 0, loads: 0, state: 'ready' })
      if (route === 'deck-preview') assert.equal(seen.audios, 0, 'the preview document carries no <audio>')
      assert.deepEqual(audioRequests, [])
      await p.close()
    })
  }

  // ── 1c. autoplay refused by the browser ────────────────────────────────────────────────────
  await check('a refused autoplay leaves the chip ready, and the next render of the slide tries again', async () => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    await p.addInitScript(() => {
      window.__reject = true; window.__plays = 0
      const play = HTMLMediaElement.prototype.play
      HTMLMediaElement.prototype.play = function () {
        window.__plays++
        return window.__reject ? Promise.reject(new DOMException('blocked', 'NotAllowedError')) : play.call(this)
      }
    })
    await p.goto(`${origin}/deck.html#${idOf('Auto')}`, { waitUntil: 'load' })
    await p.waitForSelector('.slide.active .slide-audio')
    await p.waitForFunction(() => window.__plays >= 1)
    await p.waitForTimeout(200)
    assert.deepEqual(await p.evaluate(() => { const c = document.querySelector('.slide.active .slide-audio'); return { state: c.dataset.audioState, marked: 'audioAutoplayed' in c.dataset } }), { state: 'ready', marked: false })
    await p.evaluate(() => { window.__reject = false; location.hash = ''; })
    await p.evaluate((id) => { location.hash = id }, idOf('Manual'))
    await p.evaluate((id) => { location.hash = id }, idOf('Auto'))
    await waitState(p, 'playing')
    await p.close()
  })
  await page.close()

  // ── 2. presenter + projector ──────────────────────────────────────────────────────────────
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
  const session = 'audio-chip-' + Date.now()
  const presenter = await context.newPage()
  const audience = await context.newPage()
  for (const p of [presenter, audience]) p.on('pageerror', (error) => { throw new Error(`page error ${error.message}`) })
  await audience.goto(`${origin}/deck.html?audience=1&session=${session}`, { waitUntil: 'load' })
  await presenter.goto(`${origin}/deck.html?presenter=1&session=${session}`, { waitUntil: 'load' })
  await presenter.waitForSelector('#presenterRoot, .presenter-root')
  await presenter.keyboard.press('ArrowRight') // Manual slide
  await audience.waitForFunction((id) => document.querySelector('.slide.active')?.dataset.id === id, idOf('Manual'))
  await presenter.waitForFunction(() => !document.getElementById('presenterMedia')?.hidden)

  const previewChip = (p) => p.evaluate(() => {
    const doc = document.querySelector('#currentPreview iframe')?.contentDocument
    const chip = doc?.querySelector('.slide-audio')
    return chip ? { state: chip.dataset.audioState, time: chip.querySelector('.slide-audio-time').textContent, audio: doc.querySelectorAll('audio').length } : null
  })
  const waitPreview = (want) => presenter.waitForFunction((w) => {
    const chip = document.querySelector('#currentPreview iframe')?.contentDocument?.querySelector('.slide-audio')
    return chip?.dataset.audioState === w
  }, want, { timeout: 8000, polling: 50 })

  await check('the presenter media row names the chip, and its preview starts ready with no <audio>', async () => {
    assert.equal(await presenter.evaluate(() => document.getElementById('presenterMediaLabel').textContent), 'Interview')
    await presenter.waitForFunction(() => document.querySelector('#currentPreview iframe')?.contentDocument?.querySelector('.slide-audio'))
    assert.deepEqual(await previewChip(presenter), { state: 'ready', time: '0:00', audio: 0 })
  })

  await check('M plays the file in the projector only; the preview shows playing then finished, silently', async () => {
    await presenter.keyboard.press('m')
    await waitState(audience, 'playing')
    assert.equal(await audience.evaluate(() => document.querySelector('.slide.active .slide-audio audio').paused), false, 'the projector plays it')
    assert.equal(await presenter.evaluate(() => [...document.querySelectorAll('audio')].every((a) => a.paused && a.currentTime === 0)), true, 'the presenter window never plays it')
    await waitPreview('playing')
    assert.equal((await previewChip(presenter)).audio, 0, 'the preview holds no audio element')
    await waitState(audience, 'finished')
    await waitPreview('finished')
    assert.match((await previewChip(presenter)).time, /^0:0[01]$/)
  })

  await check('the Pause control pauses the projector', async () => {
    await presenter.keyboard.press('m')
    await waitState(audience, 'playing')
    await presenter.click('#presenterMediaPause')
    await waitState(audience, 'ready')
    assert.equal(await audience.evaluate(() => document.querySelector('.slide.active .slide-audio audio').paused), true)
    await waitPreview('ready')
  })

  await check('going to the next slide stops the projector audio', async () => {
    await presenter.keyboard.press('m')
    await waitState(audience, 'playing')
    await presenter.keyboard.press('ArrowRight')
    await audience.waitForFunction((id) => document.querySelector('.slide.active')?.dataset.id === id, idOf('Auto'))
    const old = await audience.evaluate((id) => {
      const a = document.querySelector(`.slide[data-id="${id}"] .slide-audio audio`)
      return { paused: a.paused, state: a.closest('.slide-audio').dataset.audioState }
    }, idOf('Manual'))
    assert.deepEqual(old, { paused: true, state: 'ready' })
  })

  await check('after a refused autoplay the presenter Play control still starts the projector', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    const sess = 'audio-reject-' + Date.now()
    const proj = await ctx.newPage()
    const pres = await ctx.newPage()
    await proj.addInitScript(() => {
      window.__reject = true
      const play = HTMLMediaElement.prototype.play
      HTMLMediaElement.prototype.play = function () { return window.__reject ? Promise.reject(new DOMException('blocked', 'NotAllowedError')) : play.call(this) }
    })
    await proj.goto(`${origin}/deck.html?audience=1&session=${sess}`, { waitUntil: 'load' })
    await pres.goto(`${origin}/deck.html?presenter=1&session=${sess}`, { waitUntil: 'load' })
    await pres.waitForSelector('#presenterRoot, .presenter-root')
    await pres.keyboard.press('ArrowRight')
    await pres.keyboard.press('ArrowRight') // the {autoplay} slide
    await proj.waitForFunction((id) => document.querySelector('.slide.active')?.dataset.id === id, idOf('Auto'))
    await proj.waitForTimeout(300)
    assert.equal(await chipState(proj), 'ready')
    await proj.evaluate(() => { window.__reject = false })
    await pres.waitForFunction(() => !document.getElementById('presenterMedia')?.hidden)
    await pres.click('#presenterMediaPlay')
    await waitState(proj, 'playing')
    await ctx.close()
  })
  await context.close()
} finally {
  await browser.close()
  server.close()
}
console.log(failures ? `\n${failures} failing` : '\nall passing')
process.exit(failures ? 1 : 0)
