import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { lockCaptureNetwork } from '../src/main/capture-network-frame.js'
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.route('**/*', route => route.abort())
  await page.addInitScript(lockCaptureNetwork)
  await page.goto('data:text/html,<h1>Trusted gate probe</h1><script>document.body.dataset.peer=typeof RTCPeerConnection;const f=document.createElement("iframe");document.body.append(f);document.body.dataset.child=typeof f.contentWindow.RTCPeerConnection;</script>')
  assert.equal(await page.locator('body').getAttribute('data-peer'), 'undefined')
  assert.equal(await page.locator('body').getAttribute('data-child'), 'undefined')
  const flags = await page.evaluate(() => {
    let restored = false
    try { Object.defineProperty(window, 'RTCPeerConnection', { value: function () {} }); restored = true } catch {}
    return { locked: globalThis.__twCaptureNetworkLocked, restored, worker: typeof Worker, transport: typeof WebTransport, configurable: Object.getOwnPropertyDescriptor(window, 'RTCPeerConnection').configurable }
  })
  assert.deepEqual(flags, { locked: true, restored: false, worker: 'undefined', transport: 'undefined', configurable: false })
  console.log('PASS: gate precedes source scripts, locks constructors and applies to a synchronously created child realm')
} finally { await browser.close() }
