// Lazy slide assets for the published handout: the loader's priority queue (live → the speaker's slide,
// the next two, the previous one, then the rest; not live → what is on screen, then the rest; a new
// slide re-prioritises what is still pending; drain) and the publisher's externaliser (heavy inline
// media → content-hashed files, placeholders of the same intrinsic size, small and unreadable stay inline).
import assert from 'node:assert/strict'
import { createSlideAssetQueue } from '../compiler/assets/runtime/lazy-slide-assets.js'
import { externaliseSlideAssets, imageSize } from '../compiler/scripts/lib/handout-lazy-assets.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'

const assets = (n) => Array.from({ length: n }, (_, i) => ({ url: `a${i}`, slides: [i] }))
const drain = (queue, allowIdle = true) => { const order = []; let next; while ((next = queue.take(allowIdle))) { order.push(next.url); queue.settle(next.url, true) } return order }

// Live: current first, then the next two, the previous one, then the rest (after the current, then before it).
{
  const q = createSlideAssetQueue(assets(8))
  q.setLive(true)
  q.setCurrent(4)
  assert.deepEqual(drain(q), ['a4', 'a5', 'a6', 'a3', 'a7', 'a2', 'a1', 'a0'])
  assert.equal(q.drained(), true)
}
// Live: without idle permission only the speaker's window comes out; the rest waits.
{
  const q = createSlideAssetQueue(assets(8))
  q.setLive(true)
  q.setCurrent(2)
  assert.deepEqual(drain(q, false), ['a2', 'a3', 'a4', 'a1'])
  assert.equal(q.hasUrgent(), false)
  assert.equal(q.drained(), false)
  assert.deepEqual(drain(q), ['a5', 'a6', 'a7', 'a0'])
}
// Re-prioritise: the speaker moves on mid-queue; the new slide jumps ahead of everything pending.
{
  const q = createSlideAssetQueue(assets(10))
  q.setLive(true)
  q.setCurrent(0)
  const first = q.take()
  assert.equal(first.url, 'a0')
  assert.equal(first.urgent, true)
  q.setCurrent(7)
  assert.equal(q.take().url, 'a7', 'the new current slide jumps the queue')
  assert.equal(q.take().url, 'a8')
  assert.equal(q.take().url, 'a9')
  assert.equal(q.take().url, 'a6')
  q.settle('a0', true)
  assert.equal(q.state('a0'), 'loaded')
  assert.equal(q.loading(), 4, 'a7 a8 a9 a6 still loading')
}
// Saturated: four requests in flight when the speaker moves; the new current slide is handed out at once.
{
  const q = createSlideAssetQueue(assets(10))
  q.setLive(true)
  q.setCurrent(3)
  for (let i = 0; i < 4; i++) q.take(false)
  assert.equal(q.loading(), 4)
  q.setCurrent(8)
  const now = q.takeCurrent()
  assert.equal(now.url, 'a8', 'the current slide\'s asset does not wait for a slot')
  assert.equal(now.urgent, true)
  assert.equal(q.takeCurrent(), null, 'only the current slide bypasses the limit')
  assert.equal(q.loading(), 5)
  q.setLive(false)
  assert.equal(q.takeCurrent(), null, 'not live: no current slide')
}
// Not live: visible slides first (in order), then the rest after them, then before.
{
  const q = createSlideAssetQueue(assets(6))
  q.setVisible(3, true)
  q.setVisible(1, true)
  assert.equal(q.take(false).url, 'a1')
  assert.equal(q.take(false).url, 'a3')
  assert.equal(q.take(false), null, 'nothing else is on screen')
  const rest = q.take(true)
  assert.equal(rest.urgent, false)
  assert.equal(rest.url, 'a2', 'idle work starts after the first visible slide')
  q.setVisible(5, true)
  assert.equal(q.take(false).url, 'a5', 'a slide scrolled into view outranks idle work')
}
// The live window outranks what is on screen; visible outranks the rest.
{
  const q = createSlideAssetQueue(assets(10))
  q.setLive(true)
  q.setCurrent(5)
  q.setVisible(0, true)
  assert.deepEqual(drain(q, false), ['a5', 'a6', 'a7', 'a4', 'a0'])
}
// An asset shared by two slides takes the better of the two; failed → requeue → pending again.
{
  const q = createSlideAssetQueue([{ url: 'x', slides: [0] }, { url: 'shared', slides: [1, 6] }])
  q.setLive(true)
  q.setCurrent(6)
  const got = q.take(false)
  assert.equal(got.url, 'shared')
  q.settle('shared', false)
  assert.equal(q.state('shared'), 'failed')
  assert.equal(q.take(false), null)
  q.requeue('shared')
  assert.equal(q.take(false).url, 'shared', 'a retried asset comes back at its rank')
  q.settle('shared', true)
  assert.equal(q.take(false), null)
  assert.equal(q.take(true).url, 'x')
  q.settle('x', true)
  assert.equal(q.drained(), true)
  // Leaving live drops the speaker's window: ranking falls back to visibility.
  const q2 = createSlideAssetQueue(assets(4))
  q2.setLive(true); q2.setCurrent(3); q2.setLive(false)
  assert.equal(q2.take(false), null)
}

// ── The externaliser ──────────────────────────────────────────────────────────
const png = (w, h, pad) => {
  const b = Buffer.alloc(33 + pad)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20)
  b.fill(7, 33)
  return b
}
const jpeg = (w, h, pad) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 3]), Buffer.alloc(pad, 1)])
assert.deepEqual(imageSize(png(1600, 900, 0), 'image/png'), { w: 1600, h: 900 })
assert.deepEqual(imageSize(jpeg(1200, 800, 0), 'image/jpeg'), { w: 1200, h: 800 })
assert.equal(imageSize(Buffer.from('nope'), 'image/png'), null)

const big = png(1600, 900, 20000).toString('base64')
const small = png(10, 10, 100).toString('base64')
const opaque = Buffer.alloc(20000, 3).toString('base64') // claims PNG, no readable size
const slide = (id, body) => ({ html: `<section class="slide" data-id="${id}"><div class="slide-content"><h1>${id}</h1>${body}</div></section>`, notes: '' })
const slides = [
  slide('one', `<figure><img src="data:image/png;base64,${big}" alt="Chart"></figure>`),
  slide('two', `<img src="data:image/png;base64,${small}" alt="tiny"><img src="data:image/png;base64,${opaque}" alt="opaque">`),
  slide('three', `<img alt="again" src="data:image/png;base64,${big}"><video controls src="data:video/mp4;base64,${Buffer.alloc(30000, 5).toString('base64')}"></video>`),
]
const page = buildShareHtml({ title: 'Lazy', slides, styles: '', includeNotes: false, slug: 'lazy', license: null, lazyAssets: true })
const { html, files } = externaliseSlideAssets(page)
assert.equal(files.length, 2, 'one image file (shared by two slides) and one video')
assert.match(files[0].path, /^slide-assets\/[0-9a-f]{20}\.png$/)
assert.match(files[1].path, /^slide-assets\/[0-9a-f]{20}\.mp4$/)
assert.equal(html.split(`data-lazy-src="${files[0].path}"`).length - 1, 2)
assert.ok(html.includes(`src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1600' height='900'%3E%3C/svg%3E" data-lazy-src="${files[0].path}" alt="Chart"`), 'the placeholder keeps the image\'s size')
assert.ok(html.includes(small), 'an image under 8 KB stays inline')
assert.ok(html.includes(opaque), 'an image whose size cannot be read stays inline')
assert.ok(!html.includes(big), 'the heavy image left the page')
assert.match(html, /<video controls data-lazy-src="slide-assets\/[0-9a-f]{20}\.mp4" preload="none">/)
assert.ok(html.length < page.length - 40000)

// Without lazyAssets the page carries no loader, and the externaliser is never asked: the Download handout.
const offline = buildShareHtml({ title: 'Lazy', slides, styles: '', includeNotes: false, slug: 'lazy', license: null })
assert.ok(!offline.includes('createLazySlideAssets'), 'the self-contained handout has no loader')
assert.ok(page.includes('createLazySlideAssets'))

// A video's poster is published beside the page too (data-lazy-poster), whether or not its video is.
{
  const poster = png(1280, 720, 20000).toString('base64')
  const posterPage = buildShareHtml({ title: 'Poster', slides: [slide('v', `<video controls poster="data:image/png;base64,${poster}" src="data:video/mp4;base64,${Buffer.alloc(30000, 6).toString('base64')}"></video><video poster="data:image/png;base64,${poster}" src="clip.mp4"></video>`)], styles: '', includeNotes: false, slug: 'p', license: null, lazyAssets: true })
  const out = externaliseSlideAssets(posterPage)
  assert.equal(out.files.length, 2, 'one poster (shared) and one video')
  const posterPath = out.files.find((f) => f.type === 'image/png').path
  assert.equal(out.html.split(`data-lazy-poster="${posterPath}"`).length - 1, 2)
  assert.ok(!out.html.includes(poster))
  assert.match(out.html, /<video poster|<video data-lazy-poster|<video controls data-lazy-poster/)
}

console.log('lazy slide assets: queue + externaliser ok')
