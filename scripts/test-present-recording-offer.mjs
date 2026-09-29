// Presenter-level check of the start-recording offer (2026-09-24), driving the REAL recorder preload
// (bundled as test-present-recorder-close.mjs does) with Playwright's fake clock, so the one-minute
// dwell runs in milliseconds. The timing rule itself is unit-tested in present-recording-offer.test.ts.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const bundled = await build({ entryPoints: ['src/preload/present-recorder.ts'], bundle: true, write: false, format: 'iife', globalName: 'Recorder', platform: 'browser', plugins: [{ name: 'preload-boundaries', setup(build) {
  build.onResolve({ filter: /^electron$|present-edit-bridge$|present-live-bridge$/ }, args => ({ path: args.path, namespace: 'test' }))
  build.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path === 'electron' ? 'export const ipcRenderer = window.testIpc' : 'export const mountEditBridge = () => {}; export const mountLiveBridge = () => {};', loader: 'js' }))
} }] })

const browser = await chromium.launch({ headless: true })
async function presenter() {
  const page = await browser.newPage()
  await page.clock.install({ time: 0 })
  await page.setContent('<section class="slide active" data-id="title"></section><section class="slide" data-id="two"></section><section class="slide" data-id="three"></section>')
  await page.evaluate(() => {
    window.testIpc = {
      on: () => {},
      invoke: async (name) => name === 'recording:context'
        ? { talkSlug: 'deck', talkTitle: 'Deck', timerTargetMin: 0, pathwayId: null, preferredPlannedRunId: null, discardThresholdMs: 20000, testMode: false }
        : { ok: true }
    }
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }, configurable: true })
    window.MediaRecorder = class {
      static isTypeSupported() { return true }
      start() {}
      stop() { this.ondataavailable({ data: new Blob(['captured audio']) }); queueMicrotask(() => this.onstop()) }
    }
    window.goTo = (id) => {
      for (const slide of document.querySelectorAll('.slide')) slide.classList.toggle('active', slide.dataset.id === id)
      history.replaceState(null, '', `#${id}`)
    }
    window.navKeys = []
    window.addEventListener('keydown', (event) => { window.navKeys.push({ key: event.key, prevented: event.defaultPrevented }) })
  })
  await page.addScriptTag({ content: bundled.outputFiles[0].text })
  await page.waitForSelector('#twrec-module')
  return page
}
const offerShown = (page) => page.evaluate(() => document.querySelector('.twrec-start-offer')?.classList.contains('show') ?? false)
const move = async (page, id) => { await page.evaluate((slide) => window.goTo(slide), id); await page.clock.runFor(300) }

try {
  // 1. Title up a full minute, forward to slide 2, not recording → the offer shows, names ⇧R,
  //    takes no focus, lets navigation keys through, and fades by itself after ~8 s.
  let page = await presenter()
  await page.clock.runFor(61_000)
  assert.equal(await offerShown(page), false, 'no offer while the title slide is still up')
  const focusBefore = await page.evaluate(() => document.activeElement?.tagName)
  await move(page, 'two')
  assert.equal(await offerShown(page), true, 'offer shows on leaving a title slide held for a minute')
  // Drawn (presenter redesign ticket 03): "Start recording? Offered once, fades in 8 seconds" + Record ⇧R.
  assert.match(await page.locator('.twrec-start-offer').innerText(), /Start recording\?[\s\S]*⇧R/, 'the toast names the key')
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), focusBefore, 'the toast takes no focus')
  assert.equal(await page.locator('.twrec-start-offer [tabindex="-1"]').count(), 1, 'its dismiss control is out of the tab order')
  await page.keyboard.press('ArrowRight')
  assert.deepEqual(await page.evaluate(() => window.navKeys.at(-1)), { key: 'ArrowRight', prevented: false }, 'slide navigation keys pass through untouched')
  await page.clock.runFor(7_000)
  assert.equal(await offerShown(page), true, 'still showing before ~8 s')
  await page.clock.runFor(1_500)
  assert.equal(await offerShown(page), false, 'fades by itself after ~8 s')
  console.log('PASS: offer shows after a minute on the title slide, names ⇧R, takes no focus, fades after ~8 s')

  // 2. At most once per presenting session.
  await move(page, 'title')
  await page.clock.runFor(61_000)
  await move(page, 'two')
  assert.equal(await offerShown(page), false, 'no second offer in the same session')
  console.log('PASS: at most once per session')
  await page.close()

  // 3. Title up less than a minute → no offer.
  page = await presenter()
  await page.clock.runFor(59_000)
  await move(page, 'two')
  assert.equal(await offerShown(page), false, 'no offer when the title slide was up under a minute')
  console.log('PASS: no offer under a minute')
  await page.close()

  // 4. Accept with ⇧R: the existing record command starts recording and dismisses the toast.
  page = await presenter()
  await page.clock.runFor(61_000)
  await move(page, 'two')
  assert.equal(await offerShown(page), true, 'offer shows before accepting')
  await page.keyboard.press('Shift+R')
  await page.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'recording')
  assert.equal(await offerShown(page), false, '⇧R dismisses the offer')
  console.log('PASS: ⇧R starts recording and dismisses the offer')
  await page.close()

  // 5. Recording already started on the title slide → no offer.
  page = await presenter()
  await page.keyboard.press('Shift+R')
  await page.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'recording')
  await page.clock.runFor(61_000)
  await move(page, 'two')
  assert.equal(await offerShown(page), false, 'no offer when recording already runs')
  console.log('PASS: no offer while recording')
  await page.close()
} finally { await browser.close() }
console.log('present recording offer: title-slide dwell, ⇧R accept, auto-fade, once per session, no focus passed')
