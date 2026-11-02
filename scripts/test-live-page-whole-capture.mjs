// Entire page saved views (src/main/live-page-whole-capture.ts): the protocol commands asked for are
// fixed and their numbers are computed and checked here; the picture is bounded in width, height,
// bytes and time; developer tools already attached are refused; the debugger is always detached.
// Plain Node, a fake debugger; no Electron.
import assert from 'node:assert/strict'
import { captureWholePage, jpegSize, readLayoutMetrics, wholePageClip, WHOLE_PAGE_TEXT } from '../src/main/live-page-whole-capture.ts'
import { MAX_CAPTURE_HEIGHT, MAX_CAPTURE_IMAGE_BYTES, MAX_CAPTURE_WIDTH } from '../compiler/scripts/lib/live-page-captures.mjs'

let passed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}`); throw err }
}
/** A baseline JPEG of the given size (SOF0 header only: enough for the size reader). */
const jpegOf = (w, h, pad = 0) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, ...new Array(12 + pad).fill(0)])
const metrics = (cssW, pageH, dpr = 2) => ({
  cssLayoutViewport: { clientWidth: cssW, clientHeight: 700, pageX: 0, pageY: 300 },
  cssContentSize: { x: 0, y: 0, width: cssW, height: pageH },
  contentSize: { x: 0, y: 0, width: cssW * dpr, height: pageH * dpr }
})
function fakeDebugger({ attached = false, layout = metrics(1280, 3000), shot, hang = false } = {}) {
  const d = {
    attached, attaches: 0, detaches: 0, commands: [],
    isAttached() { return d.attached },
    attach(v) { if (d.attached) throw new Error('already'); d.attached = true; d.attaches++; d.version = v },
    detach() { d.attached = false; d.detaches++ },
    async sendCommand(method, params) {
      d.commands.push({ method, params })
      if (hang) return new Promise(() => {})
      if (method === 'Page.getLayoutMetrics') return layout
      if (method === 'Page.captureScreenshot') {
        if (shot === 'throw') throw new Error('Target closed')
        const c = params.clip
        return { data: Buffer.from(shot ?? jpegOf(Math.round(c.width * c.scale * 2), Math.round(c.height * c.scale * 2))).toString('base64') }
      }
      throw new Error(`unexpected ${method}`)
    }
  }
  return d
}

console.log('live page whole capture')

await test('layout numbers checked; clip: full width scaled to ≤1920 stored px, as tall as the page or cut at the limit', () => {
  assert.deepEqual(readLayoutMetrics(metrics(1280, 3000)), { cssWidth: 1280, pageHeight: 3000, dpr: 2 })
  for (const bad of [null, {}, { cssLayoutViewport: { clientWidth: 'x' }, cssContentSize: { width: 1, height: 1 } }, metrics(1280, Infinity), metrics(0, 10)]) assert.equal(readLayoutMetrics(bad), null)
  const c = wholePageClip({ cssWidth: 1280, pageHeight: 3000, dpr: 2 })
  assert.equal(c.scale, 0.75); assert.equal(c.height, 3000); assert.equal(c.truncated, false)
  assert.ok(c.width * c.scale * 2 <= MAX_CAPTURE_WIDTH)
  const tall = wholePageClip({ cssWidth: 1280, pageHeight: 50000, dpr: 2 })
  assert.equal(tall.truncated, true)
  assert.ok(tall.height * tall.scale * 2 <= MAX_CAPTURE_HEIGHT, 'cut at the tallest picture kept')
  assert.equal(wholePageClip({ cssWidth: 800, pageHeight: 900, dpr: 1 }).scale, 1, 'never scaled up')
})

await test('capture: fixed commands, captureBeyondViewport from the top, no page script; detached after', async () => {
  const d = fakeDebugger()
  const r = await captureWholePage(d)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(d.commands.map((c) => c.method), ['Page.getLayoutMetrics', 'Page.captureScreenshot'], 'nothing else (no Runtime.evaluate, no scrolling, no resize)')
  const p = d.commands[1].params
  assert.deepEqual([p.format, p.captureBeyondViewport, p.clip.x, p.clip.y], ['jpeg', true, 0, 0])
  assert.deepEqual([r.width, r.height, r.truncated, r.pageHeight], [1920, 4500, false, 3000])
  assert.equal(d.detaches, 1); assert.equal(d.attached, false)
  assert.deepEqual(jpegSize(jpegOf(640, 480)), { width: 640, height: 480 })
  assert.equal(jpegSize(new Uint8Array([0xff, 0xd8, 0xff])), null)
})

await test('refusals: developer tools attached (not taken over), unreadable size, too wide/tall/large, protocol error, too slow — always detached', async () => {
  const busy = fakeDebugger({ attached: true })
  assert.deepEqual(await captureWholePage(busy), { ok: false, message: WHOLE_PAGE_TEXT.busy })
  assert.equal(busy.attaches, 0); assert.equal(busy.detaches, 0, 'someone else\'s session is left alone')
  const odd = fakeDebugger({ layout: { nope: 1 } })
  assert.equal((await captureWholePage(odd)).message, WHOLE_PAGE_TEXT.unreadable); assert.equal(odd.detaches, 1)
  const wide = fakeDebugger({ shot: jpegOf(4000, 100) })
  assert.equal((await captureWholePage(wide)).message, WHOLE_PAGE_TEXT.tooLarge); assert.equal(wide.detaches, 1)
  const tall = fakeDebugger({ shot: jpegOf(1000, MAX_CAPTURE_HEIGHT + 50) })
  assert.equal((await captureWholePage(tall)).message, WHOLE_PAGE_TEXT.tooLarge)
  const heavy = fakeDebugger({ shot: jpegOf(100, 100, MAX_CAPTURE_IMAGE_BYTES + 10) })
  assert.equal((await captureWholePage(heavy)).message, WHOLE_PAGE_TEXT.tooLarge, 'refused before it is decoded')
  const notJpeg = fakeDebugger({ shot: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]) })
  assert.equal((await captureWholePage(notJpeg)).message, WHOLE_PAGE_TEXT.failed)
  const broken = fakeDebugger({ shot: 'throw' })
  assert.equal((await captureWholePage(broken)).message, WHOLE_PAGE_TEXT.failed); assert.equal(broken.detaches, 1)
  const slow = fakeDebugger({ hang: true })
  const t0 = Date.now()
  assert.equal((await captureWholePage(slow, 50)).message, WHOLE_PAGE_TEXT.slow)
  assert.ok(Date.now() - t0 < 1000); assert.equal(slow.detaches, 1, 'detached on timeout')
})

await test('a page taller than kept is cut and says so', async () => {
  const d = fakeDebugger({ layout: metrics(1280, 40000) })
  const r = await captureWholePage(d)
  assert.equal(r.ok, true); assert.equal(r.truncated, true)
  assert.ok(r.height <= MAX_CAPTURE_HEIGHT)
})

console.log(`live page whole capture: ${passed} passed`)
