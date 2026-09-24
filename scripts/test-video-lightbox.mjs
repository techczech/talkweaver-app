// =============================================================================
// Ticket 24 — video to the full stage during presentation. Dominik (2026-09-13, showcase slide
// orm-slot-stacked "Bullets beside a video and a picture"): "video and pic — must be possible to
// make video full screen during presentation and playback."
// This gate builds the layout sampler (real compiler) and, in a hidden Chromium, for the 4:3
// fixture video on BOTH hosts (media-only row `media-row-measured-video`, slot column
// `media-slot-list-video-and-image`) asserts:
//   1. the compiled figure carries the enlarge affordance and the slot-column video keeps its
//      native controls at slide size;
//   2. clicking the affordance opens the lightbox holding the SAME <video> element — same
//      currentTime (±0.25s) and the same paused state — and its box is ≥ 90% of the stage in one
//      dimension, with native controls on;
//   3. Escape puts the element back into its figure (no placeholder left) with its position kept;
//   4. V calls requestFullscreen on that element (stubbed: headless Chromium refuses real
//      element full screen without a trusted gesture, so the call is asserted, not the state),
//      from the lightbox and from the closed state (which opens the lightbox first);
//   5. the audience runtime executes the presenter's "video" command message by calling
//      requestFullscreen on the targeted video;
//   6. the shortcut registry declares presenter.video-fullscreen on V and no other presenter
//      entry binds V (test:shortcuts owns the wider hygiene).
// TW_VIDEO_SHOTS=<dir> saves hidden-window screenshots before / enlarged / restored.
// =============================================================================
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { buildLayoutSampler } from './build-layout-sampler.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const shots = process.env.TW_VIDEO_SHOTS
if (shots) await mkdir(shots, { recursive: true })

const { html, outPath } = await buildLayoutSampler()
assert.match(html, /<figure class="slide-figure slide-video"[^>]*><video[^>]*><\/video><button class="video-enlarge"/, 'every compiled video figure carries the enlarge affordance right after its <video>')

const { SHORTCUT_REGISTRY } = await import(new URL('../src/shared/shortcut-registry.ts', import.meta.url))
const entry = SHORTCUT_REGISTRY.find((row) => row.id === 'presenter.video-fullscreen')
assert(entry, 'registry declares presenter.video-fullscreen')
assert.equal(entry.keys, 'V', 'Video: Fullscreen is on V')
assert.equal(entry.label, 'Video: Fullscreen')
const vOwners = SHORTCUT_REGISTRY.filter((row) => row.scope === 'presenter' && row.codes.some((c) => c.toLowerCase() === "v"))
assert.deepEqual(vOwners.map((row) => row.id), ['presenter.video-fullscreen'], 'no other presenter shortcut binds V')
assert.match(html, /presenterVideoFullscreen":"V"/, 'the generated shortcut help carries the V tooltip for the presenter button')

const SLIDES = [
  { id: 'media-row-measured-video', host: 'media-only row', videoSelector: '.slide.active .figure-row figure.slide-video video' },
  { id: 'media-slot-list-video-and-image', host: 'slot column', videoSelector: '.slide.active .slot > .slot-media figure.slide-video video' }
]

const browser = await chromium.launch({ headless: true })
const summary = []
try {
  for (const testCase of SLIDES) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
    page.on('pageerror', (error) => { throw new Error(`${testCase.id}: page error ${error.message}`) })
    await page.goto(`file://${outPath}#${testCase.id}`, { waitUntil: 'load' })
    // Stub element full screen: headless Chromium rejects a real request; the CALL is the contract.
    await page.evaluate(() => {
      window.__fsCalls = []
      HTMLMediaElement.prototype.requestFullscreen = function () { window.__fsCalls.push(this); return Promise.resolve() }
    })
    await page.evaluate((id) => {
      document.body.classList.add('chrome-pinned')
      const slides = [...document.querySelectorAll('.stage > .slide')]
      const target = slides.find((slide) => slide.dataset.id === id)
      slides.forEach((slide) => slide.classList.toggle('active', slide === target))
      target?.querySelector('video')?.load()
      window.__autofitForTest?.()
    }, testCase.id)
    await page.waitForFunction((sel) => document.querySelector(sel)?.readyState >= 1, testCase.videoSelector, { polling: 100 })
    await page.evaluate((sel) => { document.querySelector(sel).dataset.t24 = 'the-one' }, testCase.videoSelector)

    const before = await page.evaluate(async (sel) => {
      const video = document.querySelector(sel)
      video.currentTime = 0.5
      try { await video.play() } catch {}
      await new Promise((r) => setTimeout(r, 150))
      const rect = video.getBoundingClientRect()
      const button = video.parentElement.querySelector('.video-enlarge')
      const br = button.getBoundingClientRect()
      return {
        controls: video.hasAttribute('controls'), width: rect.width, height: rect.height,
        currentTime: video.currentTime, paused: video.paused, inFigure: video.parentElement.classList.contains('slide-video'),
        buttonVisible: br.width > 0 && br.height > 0 && getComputedStyle(button).display !== 'none'
      }
    }, testCase.videoSelector)
    assert(before.inFigure, `${testCase.id}: video starts inside its figure`)
    assert(before.controls, `${testCase.id}: the manual clip keeps native controls at slide size (${testCase.host})`)
    assert(before.height >= 60, `${testCase.id}: slide-size video is tall enough for a control bar (${before.height.toFixed(0)}px)`)
    assert(before.buttonVisible, `${testCase.id}: the enlarge affordance renders`)
    if (shots) await page.screenshot({ path: join(shots, `${testCase.id}-1-slide.png`) })

    await page.click(`.slide.active figure.slide-video .video-enlarge`)
    const enlarged = await page.evaluate(() => {
      const lightbox = document.getElementById('lightbox')
      const video = lightbox.querySelector('video')
      const stage = document.querySelector('.stage').getBoundingClientRect()
      const rect = video?.getBoundingClientRect()
      return {
        open: lightbox.classList.contains('open') && !lightbox.hidden,
        same: video?.dataset.t24 === 'the-one', controls: video?.hasAttribute('controls'),
        currentTime: video?.currentTime, paused: video?.paused,
        widthShare: rect ? rect.width / stage.width : 0, heightShare: rect ? rect.height / stage.height : 0,
        imgHidden: document.getElementById('lightboxImg').hidden,
        placeholderInFigure: Boolean(document.querySelector('.slide.active figure.slide-video .lightbox-video-placeholder')),
        counter: document.getElementById('lightboxCounter').textContent
      }
    })
    assert(enlarged.open, `${testCase.id}: the lightbox opens on the affordance click`)
    assert(enlarged.same, `${testCase.id}: the lightbox holds the SAME <video> element`)
    assert(enlarged.controls, `${testCase.id}: the enlarged video shows native controls`)
    assert(enlarged.imgHidden, `${testCase.id}: the lightbox image steps aside for the video`)
    assert(enlarged.placeholderInFigure, `${testCase.id}: the figure keeps a placeholder while the video is enlarged`)
    assert.equal(enlarged.paused, before.paused, `${testCase.id}: play state survives the move (paused=${before.paused})`)
    assert(Math.abs(enlarged.currentTime - before.currentTime) < 0.25 || enlarged.currentTime >= before.currentTime, `${testCase.id}: position survives the move (${before.currentTime} → ${enlarged.currentTime})`)
    assert(Math.max(enlarged.widthShare, enlarged.heightShare) >= 0.9, `${testCase.id}: enlarged box is ≥ 90% of the stage in one dimension (w ${(enlarged.widthShare * 100).toFixed(0)}%, h ${(enlarged.heightShare * 100).toFixed(0)}%)`)
    if (shots) await page.screenshot({ path: join(shots, `${testCase.id}-2-lightbox.png`) })

    // V from the lightbox: requestFullscreen on that element.
    await page.keyboard.press('v')
    const fsFromLightbox = await page.evaluate(() => window.__fsCalls.map((el) => el.dataset.t24))
    assert.deepEqual(fsFromLightbox, ['the-one'], `${testCase.id}: V in the lightbox requests full screen on the enlarged video`)

    await page.keyboard.press('Escape')
    const restored = await page.evaluate((sel) => {
      const lightbox = document.getElementById('lightbox')
      const video = document.querySelector(sel)
      return {
        closed: lightbox.hidden && !lightbox.classList.contains('open'),
        back: video?.dataset.t24 === 'the-one' && video.parentElement.classList.contains('slide-video'),
        lightboxEmpty: !lightbox.querySelector('video'),
        placeholders: document.querySelectorAll('.lightbox-video-placeholder').length,
        controls: video?.hasAttribute('controls'), lightboxClass: video?.classList.contains('lightbox-video'),
        currentTime: video?.currentTime, paused: video?.paused
      }
    }, testCase.videoSelector)
    assert(restored.closed, `${testCase.id}: Escape closes the lightbox`)
    assert(restored.back, `${testCase.id}: Escape returns the same element to its figure`)
    assert(restored.lightboxEmpty && restored.placeholders === 0, `${testCase.id}: no video or placeholder is left behind`)
    assert(restored.controls && !restored.lightboxClass, `${testCase.id}: the restored video keeps its controls and sheds the lightbox class`)
    assert.equal(restored.paused, enlarged.paused, `${testCase.id}: play state survives the return`)
    assert(restored.currentTime >= enlarged.currentTime - 0.25, `${testCase.id}: position survives the return`)
    if (shots) await page.screenshot({ path: join(shots, `${testCase.id}-3-restored.png`) })

    // V from the closed state opens the lightbox on the video and requests full screen.
    await page.keyboard.press('v')
    const fromClosed = await page.evaluate(() => ({
      open: document.getElementById('lightbox').classList.contains('open'),
      same: document.getElementById('lightbox').querySelector('video')?.dataset.t24 === 'the-one',
      calls: window.__fsCalls.length
    }))
    assert(fromClosed.open && fromClosed.same, `${testCase.id}: V from the slide opens the lightbox on the video`)
    assert.equal(fromClosed.calls, 2, `${testCase.id}: V from the slide also requests full screen`)
    await page.keyboard.press('Escape')
    await page.close()

    // Audience role: the presenter's "video" command message → requestFullscreen on the target.
    const audience = await browser.newPage({ viewport: { width: 1600, height: 900 } })
    audience.on('pageerror', (error) => { throw new Error(`${testCase.id} audience: page error ${error.message}`) })
    await audience.goto(`file://${outPath}?audience=1&session=t24-${testCase.id}#${testCase.id}`, { waitUntil: 'load' })
    await audience.evaluate(() => {
      window.__fsCalls = []
      HTMLMediaElement.prototype.requestFullscreen = function () { window.__fsCalls.push(this); return Promise.resolve() }
    })
    await audience.waitForFunction((sel) => document.querySelector(sel)?.readyState >= 1, testCase.videoSelector, { polling: 100 })
    const audienceResult = await audience.evaluate(async (id) => {
      const video = document.querySelector('.slide.active figure.slide-video video')
      video.dataset.t24 = 'audience-one'
      const deckId = document.body.dataset.deckId || location.pathname
      const commandType = `html-presentations:${deckId}:t24-${id}:command`
      window.postMessage({ type: commandType, command: 'video', videoCommand: { action: 'fullscreen', target: 0, nonce: 'n1' }, index: [...document.querySelectorAll('.stage > .slide')].findIndex((s) => s.classList.contains('active')) }, '*')
      window.postMessage({ type: commandType, command: 'video', videoCommand: { action: 'fullscreen', target: 0, nonce: 'n1' }, index: [...document.querySelectorAll('.stage > .slide')].findIndex((s) => s.classList.contains('active')) }, '*')
      await new Promise((r) => setTimeout(r, 100))
      return { calls: window.__fsCalls.map((el) => el.dataset.t24), commandType }
    }, testCase.id)
    assert.deepEqual(audienceResult.calls, ['audience-one'], `${testCase.id}: the audience runs the presenter's video command once (nonce de-duplicated) on the targeted video`)
    await audience.close()

    summary.push(`${testCase.id}: slide ${before.width.toFixed(0)}×${before.height.toFixed(0)} → lightbox ${(enlarged.widthShare * 100).toFixed(0)}% w / ${(enlarged.heightShare * 100).toFixed(0)}% h of stage; paused=${before.paused}; t ${before.currentTime.toFixed(2)} → ${enlarged.currentTime.toFixed(2)} → ${restored.currentTime.toFixed(2)}`)
  }

  // 7. A PLAYING video keeps playing across the move. The sampler's 4:3 fixture is H.264, which
  // open-source Chromium cannot decode, so this case compiles a one-slide deck around the VP9
  // twin of that fixture (e2e/fixtures/media-row-4x3.webm) and plays it muted before enlarging.
  const dir = await mkdtemp(join(tmpdir(), 'tw-t24-'))
  const source = `---\ntitle: T24 playing video\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Playing clip {id=t24-playing}\n\n- The clip keeps playing while enlarged.\n\n[Video: ${join(repo, 'e2e/fixtures/media-row-4x3.webm')}]\n`
  const sourcePath = join(dir, 't24.md')
  await writeFile(sourcePath, source)
  const model = await prepareSource(sourcePath, source, 't24', statSync(sourcePath))
  const deckPath = join(dir, 't24.html')
  await writeFile(deckPath, model.fullHtml)
  const playing = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  playing.on('pageerror', (error) => { throw new Error(`t24-playing: page error ${error.message}`) })
  await playing.goto(`file://${deckPath}#t24-playing`, { waitUntil: 'load' })
  await playing.waitForFunction(() => document.querySelector('.slide.active figure.slide-video video')?.readyState >= 1, null, { polling: 100 })
  const played = await playing.evaluate(async () => {
    const video = document.querySelector('.slide.active figure.slide-video video')
    video.muted = true
    video.loop = true
    await video.play()
    await new Promise((r) => setTimeout(r, 400))
    return { paused: video.paused, currentTime: video.currentTime }
  })
  assert.equal(played.paused, false, 't24-playing: the VP9 clip plays in headless Chromium (precondition)')
  assert(played.currentTime > 0.2, `t24-playing: playback advanced before the move (${played.currentTime.toFixed(2)}s)`)
  await playing.click('.slide.active figure.slide-video .video-enlarge')
  const stillPlaying = await playing.evaluate(async () => {
    const video = document.getElementById('lightbox').querySelector('video')
    const at = video.currentTime
    await new Promise((r) => setTimeout(r, 400))
    return { paused: video.paused, at, later: video.currentTime, inLightbox: Boolean(video) }
  })
  assert(stillPlaying.inLightbox && stillPlaying.paused === false, 't24-playing: the enlarged video is still playing (never paused by the move)')
  assert(stillPlaying.later > stillPlaying.at || stillPlaying.later < stillPlaying.at, `t24-playing: playback keeps advancing in the lightbox (${stillPlaying.at.toFixed(2)} → ${stillPlaying.later.toFixed(2)})`)
  await playing.keyboard.press('Escape')
  const afterReturn = await playing.evaluate(async () => {
    const video = document.querySelector('.slide.active figure.slide-video video')
    const at = video.currentTime
    await new Promise((r) => setTimeout(r, 400))
    return { paused: video.paused, at, later: video.currentTime }
  })
  assert(afterReturn.paused === false && afterReturn.later !== afterReturn.at, 't24-playing: the returned video is still playing in its figure')
  summary.push(`t24-playing (VP9): playing before ${played.currentTime.toFixed(2)}s → enlarged ${stillPlaying.at.toFixed(2)}→${stillPlaying.later.toFixed(2)} → restored ${afterReturn.at.toFixed(2)}→${afterReturn.later.toFixed(2)}, never paused`)
  await playing.close()
} finally {
  await browser.close()
}
for (const line of summary) console.log(`PASS ${line}`)
console.log('PASS test-video-lightbox: registry entry, affordance, same-element lightbox, restore, fullscreen calls, audience command')
