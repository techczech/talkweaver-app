import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
const bundled = await build({ entryPoints: ['src/preload/present-recorder.ts'], bundle: true, write: false, format: 'iife', globalName: 'Recorder', platform: 'browser', plugins: [{ name: 'preload-boundaries', setup(build) {
  build.onResolve({ filter: /^electron$|present-edit-bridge$|present-live-bridge$/ }, args => ({ path: args.path, namespace: 'test' }))
  build.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path === 'electron' ? 'export const ipcRenderer = window.testIpc' : 'export const mountEditBridge = () => {}; export const mountLiveBridge = () => {};', loader: 'js' }))
} }] })
const browser = await chromium.launch({ headless: true, channel: 'chrome' })
try {
  const page = await browser.newPage()
  await page.setContent('<section class="slide active" data-id="a"></section>')
  await page.evaluate(() => {
    window.ipcCalls = []
    window.listeners = {}
    window.saveFails = true
    window.saveDiscards = false
    window.closeFails = false
    window.ctx = { talkSlug: 'deck', talkTitle: 'Deck', timerTargetMin: 0, pathwayId: null, preferredPlannedRunId: null, discardThresholdMs: 20000, testMode: false }
    window.testIpc = {
      on: (name, callback) => { (window.listeners[name] ??= []).push(callback) },
      invoke: async (name, payload) => {
        window.ipcCalls.push([name, payload])
        if (name === 'recording:context') return window.ctx
        if (name === 'recording:save') return window.saveDiscards ? { ok: true, discarded: true } : window.saveFails ? { ok: false, error: 'disk failure' } : { ok: true, sessionId: 'audio-1', kind: 'delivery' }
        if (name === 'recording:close-window') return window.closeFails ? { ok: false, error: 'Live session is still open' } : { ok: true }
        return { ok: true }
      }
    }
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }, configurable: true })
    window.MediaRecorder = class {
      static isTypeSupported() { return true }
      start() {}
      stop() { this.ondataavailable({ data: new Blob(['captured audio']) }); queueMicrotask(() => this.onstop()) }
    }
  })
  await page.addScriptTag({ content: bundled.outputFiles[0].text })
  await page.locator('#twrec-primary').click()
  await page.locator('#twrec-stop').click()
  await page.evaluate(() => {
    for (const callback of window.listeners['recording:show-close-offer']) callback({}, { live: true, offerRunSave: false, audioArmed: true })
  })
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.twrec-close-modal').count(), 0, 'Escape dismisses the shared close offer before recorder shortcuts')
  assert.equal(await page.locator('#twrec-module').getAttribute('data-rec'), 'confirm', 'Escape never discards pending audio when cancelling close')
  await page.locator('#twrec-keep').click()
  await page.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'error')
  assert.equal(await page.locator('#twrec-keep').isVisible(), true, 'failed save exposes a retry control')
  assert.equal(await page.locator('#twrec-primary').isVisible(), false, 'new recording cannot overwrite pending audio')
  await page.locator('#twrec-discard').click()
  const result = await page.evaluate(async () => {
    const rec = window.rec = Recorder.createRecorderController(window.ctx)
    await rec.start()
    await rec.stop()
    await rec.confirmSave(true)
    return { state: rec.getState(), armed: rec.runGate().audioArmed }
  })
  assert.deepEqual(result, { state: 'error', armed: true }, 'failed save retains pending audio and close protection')
  const before = await page.evaluate(() => window.ipcCalls.filter(([name]) => name === 'recording:close-window').length)
  assert.match(await page.evaluate(async () => { try { await window.rec.closeWindow('keep'); return 'closed' } catch (e) { return e.message } }), /recording/i)
  assert.equal(await page.evaluate(() => window.ipcCalls.filter(([name]) => name === 'recording:close-window').length), before)
  assert.deepEqual(await page.evaluate(async () => { window.saveFails = false; return window.rec.confirmSave(true) }), { ok: true, sessionId: 'audio-1', kind: 'delivery' })
  assert.equal(await page.evaluate(() => window.rec.runGate().audioArmed), false)
  await page.evaluate(async () => { await window.rec.closeWindow('keep') })
  assert.equal(await page.evaluate(() => window.ipcCalls.filter(([name]) => name === 'recording:close-window').at(-1)[1]), 'keep')
  await page.evaluate(() => { window.closeFails = true })
  assert.match(await page.evaluate(async () => { try { await window.rec.closeWindow('end'); return 'closed' } catch (e) { return e.message } }), /Live session is still open/)
  assert.deepEqual(await page.evaluate(() => {
    let offer
    window.rec.onCloseOffer(value => { offer = value })
    for (const callback of window.listeners['recording:show-close-offer']) callback({}, { live: true, offerRunSave: false, audioArmed: false })
    return offer
  }), { live: true, offerRunSave: false, audioArmed: false })
  await page.evaluate(async () => {
    window.closeFails = false
    window.saveDiscards = true
    window.rec = Recorder.createRecorderController({ ...window.ctx, discardThresholdMs: 0 })
    await window.rec.start()
    await window.rec.stop(true)
  })
  assert.equal(await page.evaluate(() => window.ipcCalls.filter(([name]) => name === 'recording:save').at(-1)[1].force), true, 'explicit close/save forces preservation despite changed thresholds')
  assert.deepEqual(await page.evaluate(() => ({ state: window.rec.getState(), armed: window.rec.runGate().audioArmed })), { state: 'error', armed: true }, 'discarded save reply retains audio and protection')
  assert.match(await page.evaluate(async () => { try { await window.rec.closeWindow('keep'); return 'closed' } catch (e) { return e.message } }), /recording/i)
  assert.deepEqual(await page.evaluate(async () => { window.saveDiscards = false; return window.rec.confirmSave(true) }), { ok: true, sessionId: 'audio-1', kind: 'delivery' })
  console.log('present recorder close: real controller retains failed audio, retries save, guards close and carries live offer/action passed')
} finally { await browser.close() }
