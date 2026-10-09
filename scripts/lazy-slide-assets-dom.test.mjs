// Lazy slide assets on the published handout, in Chromium over a tiny static server that records the
// order of requests. The live service is stubbed (fetch + WebSocket) as in handout-home-live-dom.test.mjs.
//  1. Live home page (index.html): the speaker's slide's image is the first asset asked for, then the next
//     two and the previous one; a poll is answered while the images are still on their way.
//  2. Slides view (<slug>.html), not live: the slide on screen first; a failing image leaves the slide's
//     text and a quiet Retry, and Retry asks again.
//  3. The Download handout: no external asset reference, and opening it asks the server for nothing else.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { chromium } from 'playwright'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { buildHandoutHomePageHtml } from '../compiler/scripts/lib/handout-home-page.mjs'
import { publishLazyHandoutPages } from '../compiler/scripts/lib/handout-lazy-assets.mjs'

// A real PNG of random noise (incompressible, so well over the 8 KB threshold), different each time.
function noisePng(w, h) {
  const raw = randomBytes((w * 3 + 1) * h)
  for (let row = 0; row < h; row++) raw[row * (w * 3 + 1)] = 0
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const N = 8
const images = Array.from({ length: N }, (_, i) => noisePng(96, 54))
const slides = images.map((png, i) => ({
  html: `<section class="slide" data-id="s${i}" data-nav-title="Slide ${i}"><div class="slide-content"><h1>Slide ${i} words</h1><figure class="slide-figure fig"><img src="data:image/png;base64,${png.toString('base64')}" alt="Picture ${i}"></figure></div></section>`, notes: '',
}))
// Slide 7 also has a video whose poster is heavy (its own clip is tiny and stays inline).
slides[7].html = slides[7].html.replace('</figure>', `</figure><video id="posterVideo" poster="data:image/png;base64,${noisePng(96, 54).toString('base64')}" src="data:video/mp4;base64,AAAA"></video>`)
const pollSlide = { html: '<section class="slide" data-id="agentpoll" data-nav-title="Poll"><div class="slide-content"><h1>Which?</h1></div></section>', notes: '' }
const allSlides = [...slides, pollSlide]
const slug = 'lazy-talk'
const common = { title: 'Lazy talk', slides: allSlides, styles: '', slug, license: null, workerBaseUrl: 'https://live.example.test', liveTalkSlug: slug }

const dir = await mkdtemp(join(tmpdir(), 'tw-lazy-dom-'))
const download = buildShareHtml({ ...common, includeNotes: false })
publishLazyHandoutPages(dir, [
  { fileName: `${slug}-download.html`, html: download, lazy: false },
  { fileName: `${slug}.html`, html: buildShareHtml({ ...common, includeNotes: false, lazyAssets: true }) },
  // A page of its own with a lazy video (its file fails in 2b).
  { fileName: 'video.html', html: buildShareHtml({ ...common, includeNotes: false, lazyAssets: true, slides: [{ html: `<section class="slide" data-id="v0" data-nav-title="Video"><div class="slide-content"><h1>Video words</h1><figure class="slide-figure slide-video"><video id="lazyVideo" controls src="data:video/mp4;base64,${randomBytes(20000).toString('base64')}"></video></figure></div></section>`, notes: '' }] }) },
  { fileName: 'index.html', html: buildHandoutHomePageHtml({ ...common, lazyAssets: true, home: { url: 'https://handouts.example.test/k7m2', qr: '', downloadHref: `${slug}-download.html` } }) },
])
const page1 = await readFile(join(dir, 'index.html'), 'utf8')
const assetOf = (i) => {
  const src = [...page1.matchAll(/data-lazy-src="([^"]+)" alt="Picture (\d+)"/g)].find((m) => Number(m[2]) === i)
  assert.ok(src, `slide ${i}'s image is lazy`)
  return '/' + src[1]
}
const assetUrls = images.map((_, i) => assetOf(i))
const videoUrl = '/' + (await readFile(join(dir, 'video.html'), 'utf8')).match(/<video id="lazyVideo" controls data-lazy-src="([^"]+)"/)[1]
const waitFor = async (check, what, ms = 10000) => {
  const start = Date.now()
  while (!check()) { if (Date.now() - start > ms) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 20)) }
}
assert.ok(!/base64,iVBOR/.test(page1.replace(/<script[\s\S]*?<\/script>/g, '')), 'no heavy PNG left in the landing page')

// The server: records every request; holds asset answers a little (a slow phone network) and fails `failing`.
const requests = []
let failing = new Set()
let delayMs = 0
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(String(req.url).split('?')[0])
  requests.push(path)
  if (failing.has(path)) { res.writeHead(500); res.end('no'); return }
  if (path.startsWith('/slide-assets/') && delayMs) await new Promise((r) => setTimeout(r, delayMs))
  try {
    const body = await readFile(join(dir, normalize(path).replace(/^\/+/, '')))
    res.writeHead(200, { 'content-type': path.endsWith('.html') ? 'text/html' : 'image/png', 'cache-control': 'no-store' })
    res.end(body)
  } catch { res.writeHead(404); res.end() }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const assetRequests = () => requests.filter((p) => p.startsWith('/slide-assets/'))

function stub() {
  window.__liveSockets = []
  window.__live = window.__live ?? false
  window.fetch = async (url) => {
    const u = String(url)
    if (u.endsWith('/capabilities')) return { ok: true, status: 200, json: async () => ({ protocol: 2, build: '20' }) }
    return { ok: true, status: 200, json: async () => (window.__live ? { live: true, sessionId: 'session-1', protocol: 2 } : { live: false }) }
  }
  window.WebSocket = class {
    static OPEN = 1
    readyState = 0
    sent = []
    constructor(url) {
      this.url = url
      window.__liveSockets.push(this)
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); this.emit({ type: 'session.hello', protocol: 2, expiresAt: Date.now() + 6e6 }) })
    }
    send(raw) {
      const m = JSON.parse(raw)
      this.sent.push(m)
      if (m.type === 'session.ping') this.emit({ type: 'session.pong', nonce: m.nonce })
      if (m.type === 'session.sync') queueMicrotask(() => this.emit({ type: 'session.snapshot', protocol: 2, sessionId: 'session-1', syncId: m.syncId, expiresAt: Date.now() + 6e6, slideState: null, polls: [], receipts: [] }))
      if (m.type === 'vote.submit') queueMicrotask(() => this.emit({ type: 'vote.ack', submissionId: m.submissionId, pollId: m.pollId, status: 'confirmed', choice: m.choice }))
    }
    close() { this.readyState = 3 }
    emit(m) { this.onmessage?.({ data: JSON.stringify(m) }) }
  }
}
const emit = (page, message) => page.evaluate((m) => window.__liveSockets.at(-1).emit(m), message)

const browser = await chromium.launch({ headless: true })
try {
  // 1. Live home page: the speaker is on slide 3.
  {
    requests.length = 0
    delayMs = 1500
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const page = await context.newPage()
    await page.addInitScript(() => { window.__live = true })
    await page.addInitScript(stub)
    await page.goto(`${origin}/index.html`)
    await page.waitForFunction(() => document.getElementById('liveFollowStatus')?.textContent === 'live')
    assert.deepEqual(assetRequests(), [], 'live, speaker\'s slide not yet known: nothing fetched')
    await emit(page, { type: 'slide.state', slideId: 's3', reveal: 0, focus: null, revision: 1 })
    await page.locator('#hhLive .slide.active[data-id="s3"]').waitFor()
    await waitFor(() => assetRequests().length >= 4, 'four asset requests')
    const firstFour = assetRequests().slice(0, 4)
    assert.equal(firstFour[0], assetUrls[3], 'the speaker\'s slide\'s image is the first asset asked for')
    assert.deepEqual([...firstFour].sort(), [assetUrls[3], assetUrls[4], assetUrls[5], assetUrls[2]].sort(), 'then the next two and the previous one')

    // Every slot is busy (four requests held by the server) when the speaker jumps to slide 0: its image
    // is asked for at once, before any of the four comes back.
    const answered = () => page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/slide-assets/')).length)
    assert.equal(await answered(), 0, 'all four still in flight')
    await emit(page, { type: 'slide.state', slideId: 's0', reveal: 0, focus: null, revision: 2 })
    await waitFor(() => assetRequests().includes(assetUrls[0]), 'the new current slide\'s image is asked for')
    assert.equal(assetRequests()[4], assetUrls[0], 'the new current slide jumps the queue')
    assert.equal(await answered(), 0, 'asked for before any in-flight request finished')

    // A poll opens while the pictures are still on the way: it is answered without waiting for them.
    await emit(page, { type: 'slide.state', slideId: 'agentpoll', reveal: 0, focus: null, revision: 3 })
    await emit(page, { type: 'poll.state', pollId: 'poll-1', slideId: 'agentpoll', pollType: 'single', question: 'Which?', options: [{ optionId: 'o1', label: 'This one' }, { optionId: 'o2', label: 'That one' }], visibility: 'held', open: true, revealed: false })
    const card = page.locator('#hhLive #audiencePollSurface .poll-card')
    await card.waitFor({ state: 'visible' })
    await card.getByText('That one', { exact: true }).click()
    await card.locator('.poll-submit').click()
    await page.waitForFunction(() => window.__liveSockets.at(-1).sent.some((m) => m.type === 'vote.submit'))
    const unloaded = await page.evaluate(() => [...document.querySelectorAll('.slide img[data-lazy-src]')].filter((img) => img.getAttribute('data-lazy-state') !== 'loaded').length)
    assert.ok(unloaded > 0, `the vote went before every picture had landed (${unloaded} still on the way)`)

    // The rest arrive at idle; every image ends up showing its file.
    await page.waitForFunction((n) => document.querySelectorAll('.slide img[data-lazy-state="loaded"]').length === n, N, { timeout: 20000 })
    await page.waitForFunction(() => /^slide-assets\/[0-9a-f]{20}\.png$/.test(document.querySelector('.slide #posterVideo')?.getAttribute('poster') || ''))
    assert.equal(new Set(assetRequests()).size, N + 1, 'every picture and the poster, each asked for once')
    const shown = await page.locator('#hhLive .slide[data-id="s3"] img').evaluate((img) => [img.getAttribute('src'), img.naturalWidth])
    assert.deepEqual(shown, [assetUrls[3].slice(1), 96])
    console.log('live request order:', assetRequests().map((p) => assetUrls.indexOf(p)).join(' '))
    await context.close()
  }

  // 2. Slides view, not live, laptop, opened on slide 5 whose image fails.
  {
    requests.length = 0
    delayMs = 0
    failing = new Set([assetUrls[5]])
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    await page.addInitScript(stub)
    await page.goto(`${origin}/${slug}.html#s5`)
    const slide = page.locator('.slide.active[data-id="s5"]')
    await slide.waitFor()
    await slide.locator('.lazy-retry').waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(assetRequests()[0], assetUrls[5], 'not live: the slide on screen is asked for first')
    assert.equal(await slide.locator('h1').textContent(), 'Slide 5 words', 'the slide\'s text stays')
    assert.equal(await slide.locator('img').getAttribute('data-lazy-state'), 'failed')
    const box = await slide.locator('img').boundingBox()
    assert.ok(box && box.width > 0 && Math.abs(box.width / box.height - 96 / 54) < 0.05, 'the placeholder keeps the picture\'s shape')
    failing = new Set()
    const before = assetRequests().filter((p) => p === assetUrls[5]).length
    await slide.locator('.lazy-retry').click()
    await page.waitForFunction(() => document.querySelector('.slide[data-id="s5"] img').getAttribute('data-lazy-state') === 'loaded')
    assert.equal(assetRequests().filter((p) => p === assetUrls[5]).length, before + 1, 'Retry asks again')
    assert.equal(await slide.locator('.lazy-retry').count(), 0, 'the retry goes once the picture shows')
    await context.close()
  }

  // 2b. A video whose file is missing (404): not marked loaded; the slide keeps its text and offers Retry.
  {
    requests.length = 0
    failing = new Set()
    await rm(join(dir, videoUrl.slice(1)))
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    await page.addInitScript(stub)
    await page.goto(`${origin}/video.html`)
    const slide = page.locator('.slide.active[data-id="v0"]')
    await slide.locator('.lazy-retry').waitFor({ state: 'visible', timeout: 10000 })
    assert.ok(requests.includes(videoUrl), 'the video was asked for')
    assert.equal(await slide.locator('video').getAttribute('data-lazy-state'), 'failed', 'a 404 video is not marked loaded')
    assert.equal(await slide.locator('.lazy-retry').textContent(), 'Video not loaded · Retry')
    assert.equal(await slide.locator('h1').textContent(), 'Video words')
    const before = requests.filter((p) => p === videoUrl).length
    await slide.locator('.lazy-retry').click()
    await waitFor(() => requests.filter((p) => p === videoUrl).length > before, 'Retry asks for the video again')
    await context.close()
  }

  // 3. The Download handout is one file.
  {
    assert.ok(!/data-lazy-src|slide-assets\//.test(download), 'the Download handout has no lazy references')
    const refs = [...download.matchAll(/<(?:img|video|source|script|link|iframe)\b[^>]*\s(?:src|href)="([^"]*)"/gi)].map((m) => m[1])
    assert.deepEqual(refs.filter((u) => !/^data:/.test(u) && u !== ''), [], 'every asset reference in the Download handout is inline')
    const home = await readFile(join(dir, 'index.html'), 'utf8')
    assert.match(home, new RegExp(`<a class="hh-btn" href="${slug}-download.html" download="${slug}.html">Download</a>`))
    requests.length = 0
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    await page.addInitScript(stub)
    await page.goto(`${origin}/${slug}-download.html#s5`)
    await page.waitForFunction(() => document.querySelector('.slide.active img')?.complete && document.querySelector('.slide.active img').naturalWidth === 96)
    await page.waitForTimeout(300)
    assert.deepEqual(requests, [`/${slug}-download.html`], 'opening the Download handout fetches nothing else')
    await context.close()
  }
  console.log('lazy slide assets dom: live order, retry, self-contained download ok')
} finally {
  await browser.close()
  server.close()
  await rm(dir, { recursive: true, force: true })
}
