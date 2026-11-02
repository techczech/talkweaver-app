// The capture gallery in the deck (compiler/assets/templates/presenter-popup-single-html.html): a web
// page slide with saved views shows them, never the frame, wherever the page is not live (preview,
// exports, handouts); in TalkWeaver's own decks (?livepage=1) the presenter's Capture (c) and Saved
// views (g) drive main's report, the audience window follows main's word, a failed page falls back to
// the latest saved view, and only JPEG data: pictures from main are ever shown. Headless shell, hidden.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { createHash } from 'node:crypto'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { LIVE_PAGE_CAPTURES_DIR, captureEntryName, captureImagePath, encodeCaptureEntry } from '../compiler/scripts/lib/live-page-captures.mjs'

const URL_A = 'https://example.org'
mkdirSync(new URL('../research/', import.meta.url), { recursive: true })
const dir = mkdtempSync(join(process.cwd(), 'research/scratch-live-page-gallery-dom-'))
// A real 2×2 JPEG (sharp is a dependency of the app).
const sharp = (await import('sharp')).default
const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#c33' } }).jpeg().toBuffer()
const image = captureImagePath(createHash('sha256').update(jpeg).digest('hex'))
mkdirSync(join(dir, LIVE_PAGE_CAPTURES_DIR), { recursive: true })
writeFileSync(join(dir, image), jpeg)
const saved = {
  id: 'cap-000000000001', image, capturedAt: '2026-10-27T10:00:00.000Z', currentUrl: `${URL_A}/private?token=abc`, slideId: 'page',
  width: 2, height: 2, bytes: jpeg.length, source: 'audience', viewport: { w: 1280, h: 720, zoom: 1 }, scroll: { fx: 0, fy: 0.5 }
}
writeFileSync(join(dir, LIVE_PAGE_CAPTURES_DIR, captureEntryName(saved)), encodeCaptureEntry(URL_A, saved))
const other = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#36c" } }).jpeg().toBuffer()
const NEW_VIEW = `data:image/jpeg;base64,${other.toString("base64")}`

let browser
try {
  const outline = `---\ntitle: Gallery\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n### Radio Times {id=page}\n\n[Embed: ${URL_A}]\n\n### After {id=after}\n\n- A slide after\n`
  const path = join(dir, 'gallery-outline.md'); writeFileSync(path, outline)
  const model = await prepareSource(path, outline, null, statSync(path), {}, {})
  assert.doesNotMatch(model.fullHtml, /token=abc/, 'the address the page had reached is not published')
  const deckPath = join(dir, 'gallery-deck.html'); writeFileSync(deckPath, model.fullHtml)
  const deck = pathToFileURL(deckPath).href
  browser = await chromium.launch({ headless: true, ...(process.env.TW_HEADLESS_SHELL ? { executablePath: process.env.TW_HEADLESS_SHELL } : {}) })
  const errors = []
  const open = async (query, hash) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    page.on('pageerror', (e) => errors.push(String(e)))
    const requests = []
    page.on('request', (r) => requests.push(r.url()))
    await page.goto(`${deck}?${query}#${hash}`)
    await page.waitForTimeout(700)
    return { page, requests }
  }
  const slot = async (page) => page.evaluate(() => window.__twLivePageSlot ? window.__twLivePageSlot() : 'no function')

  // Not live (an exported deck, the editor's preview, a handout page): the saved view IS the slide.
  const { page: plain, requests: plainReq } = await open('', 'page')
  const fig = plain.locator('.slide.active figure.slide-embed.has-saved-views')
  await fig.waitFor()
  assert.equal(await fig.locator(':scope > iframe').getAttribute('src'), null, 'the frame is never loaded')
  assert.ok(await fig.locator('.embed-saved-view img').isVisible())
  assert.match(await fig.locator('.embed-saved-view figcaption').textContent(), /Saved view, captured 27 Oct 2026/)
  assert.ok(await fig.locator('.embed-open-link').isVisible(), 'Open the original stays')
  assert.ok(!plainReq.some((u) => u.startsWith(URL_A)), 'no request to the site')
  await plain.close()

  // The offline HTML handout (the same builders the app's share/handout export uses): the picture
  // travels inside the file; the frame is never loaded; nothing is fetched from the site.
  const { extractStyles, extractSlides } = await import('../compiler/scripts/lib/04-html-extraction.mjs')
  const { buildShareHtml } = await import('../compiler/scripts/lib/09-output-builders.mjs')
  const handoutHtml = buildShareHtml({ title: 'Gallery', slides: extractSlides(model.fullHtml), styles: extractStyles(model.fullHtml), includeNotes: false, slug: 'gallery' })
  assert.match(handoutHtml, /<img src="data:image\/jpeg;base64,/, 'picture inside the handout file')
  assert.doesNotMatch(handoutHtml, /token=abc|live-page-captures\/|cap-000000000001/)
  const handoutPath = join(dir, 'gallery-handout.html'); writeFileSync(handoutPath, handoutHtml)
  const h = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  h.on('pageerror', (e) => errors.push(`handout: ${e}`))
  const hReq = []
  h.on('request', (q) => hReq.push(q.url()))
  await h.goto(`${pathToFileURL(handoutPath).href}#page`); await h.waitForTimeout(700)
  const hFig = h.locator('figure.slide-embed.has-saved-views').first()
  assert.ok(await hFig.locator('.embed-saved-view img').first().isVisible(), 'saved view visible in the handout')
  assert.equal(await hFig.locator(':scope > iframe').getAttribute('src'), null)
  assert.ok(!hReq.some((u) => u.startsWith(URL_A)), 'the handout fetches nothing from the site')
  await h.close()

  // Presenter in TalkWeaver: Capture and Saved views in the strip; the report carries them.
  const { page: p } = await open('presenter=1&livepage=1', 'page')
  const pane = p.locator('#currentPreview')
  await pane.locator('.live-page-slot').waitFor()
  assert.equal(await pane.locator('.live-page-gallery').textContent(), 'Saved views (1)')
  let r = await slot(p)
  assert.deepEqual([r.captureSeq, r.gallery, r.visible], [0, { on: false, index: 0 }, true])
  // c and g are the presenter's Guide and Go live keys: the gallery has buttons only, and the keys keep their meaning.
  await p.keyboard.press('c'); r = await slot(p); assert.equal(r.captureSeq, 0, 'c is not Capture')
  await pane.locator('.live-page-capture').click(); r = await slot(p)
  assert.equal(r.captureSeq, 1, 'Capture asks main for one capture')
  assert.match(await pane.locator('.live-page-capture-note').textContent(), /Capturing/)
  await p.evaluate(() => window.__twLivePageCaptured(JSON.stringify({ v: 1, slideId: 'page', url: 'https://example.org/', ok: true, message: 'Saved this view.', count: 2 })))
  assert.match(await pane.locator('.live-page-capture-note').textContent(), /Saved this view/)
  // Only a JPEG data: picture is ever taken from main's message.
  await p.evaluate(() => window.__twLivePageCaptured(JSON.stringify({ v: 1, url: 'https://example.org/', add: { src: 'https://evil.example/x.jpg', capturedAt: 'x' } })))
  await p.evaluate(() => window.__twLivePageCaptured(JSON.stringify({ v: 1, url: 'https://example.org/', add: { src: 'data:image/svg+xml,<svg onload=alert(1)>', capturedAt: 'x' } })))
  assert.match(await pane.locator('.live-page-gallery').textContent(), /\(1\)/, 'refused pictures not added')
  await p.evaluate((src) => window.__twLivePageCaptured(JSON.stringify({ v: 1, url: 'https://example.org/', add: { src, capturedAt: '2026-10-27T11:00:00.000Z' } })), NEW_VIEW)
  assert.match(await pane.locator('.live-page-gallery').textContent(), /\(2\)/, 'a view saved now joins the gallery at once')
  // Saved views: instead of the live page (the view hidden), latest first; ‹ › step; Live again: the page.
  await pane.locator('.live-page-gallery').click(); r = await slot(p)
  assert.deepEqual([r.visible, r.gallery], [false, { on: true, index: 1 }])
  assert.ok(await pane.locator('.live-page-slot .live-page-saved img').isVisible())
  assert.match(await pane.locator('.live-page-saved-caption').textContent(), /Saved view 2 of 2/)
  assert.equal(await pane.locator('.live-page-capture').isDisabled(), true, 'no capture while saved views are shown')
  await pane.locator('.live-page-gallery-step[data-step="-1"]').click(); r = await slot(p)
  assert.equal(r.gallery.index, 0)
  assert.equal(await pane.locator('.live-page-gallery').textContent(), 'Live')
  await pane.locator('.live-page-gallery').click(); r = await slot(p)
  assert.deepEqual([r.visible, r.gallery.on], [true, false])
  // The page fails to load: the latest saved view is shown by itself; Reload goes back to the page.
  await p.evaluate(() => window.__twLivePageState(JSON.stringify({ v: 1, slideId: 'page', state: 'failed', host: 'x', message: 'net::ERR_INTERNET_DISCONNECTED' })))
  r = await slot(p); assert.deepEqual([r.visible, r.gallery], [false, { on: true, index: 1 }])
  await pane.locator('.live-page-reload').click(); r = await slot(p)
  assert.equal(r.gallery.on, false); assert.equal(r.reloadSeq, 1)
  // Main's word on the slide's saved views (read from the talk's current text after any surface saved
  // or removed one) replaces the compiled and added ones; another slide's word changes nothing here;
  // only JPEG data: pictures are kept; null goes back to the compiled deck's views.
  const tell = (views, slideId = 'page') => p.evaluate(([v, s]) => window.__twLivePageViews(JSON.stringify({ v: 1, slideId: s, url: 'https://example.org/', views: v })), [views, slideId])
  const three = [NEW_VIEW, NEW_VIEW.replace(/.{4}$/, 'AAA='), NEW_VIEW.replace(/.{4}$/, 'BBB=')].map((src, i) => ({ src, alt: `Saved view ${i}`, capturedAt: '2026-10-27T22:22:00.000Z', mode: 'view' }))
  await tell(three)
  assert.equal(await pane.locator('.live-page-gallery').textContent(), 'Saved views (3)', 'another window\'s new view shows here')
  await tell(three.slice(0, 1), 'after')
  assert.equal(await pane.locator('.live-page-gallery').textContent(), 'Saved views (3)', 'another slide\'s list is not this one\'s')
  await pane.locator('.live-page-gallery').click(); r = await slot(p)
  assert.deepEqual(r.gallery, { on: true, index: 2 })
  await tell([...three.slice(0, 1), { src: 'https://evil.example/x.jpg', mode: 'view' }])
  assert.equal(await pane.locator('.live-page-gallery').textContent(), 'Live')
  r = await slot(p); assert.deepEqual(r.gallery, { on: true, index: 0 }, 'one removed elsewhere: the position clamped; a non-JPEG refused')
  await tell([])
  assert.equal(await pane.locator('.live-page-gallery').textContent(), 'No saved views', 'the last one removed: none, the live page again')
  r = await slot(p); assert.deepEqual([r.visible, r.gallery.on], [true, false])
  await tell(null)
  assert.equal(await pane.locator('.live-page-gallery').textContent(), 'Saved views (2)', 'null: the compiled and added views again')
  await p.close()

  // Audience in TalkWeaver: shows what main says the presenter chose.
  const { page: a } = await open('audience=1&livepage=1', 'page')
  await a.locator('.slide.active .live-page-slot').waitFor()
  r = await slot(a); assert.deepEqual([r.visible, r.captureSeq, r.gallery.on], [true, 0, false])
  await a.evaluate(() => window.__twLivePageGallery(JSON.stringify({ v: 1, url: 'https://example.org/', on: true, index: 0 })))
  r = await slot(a); assert.equal(r.visible, false, 'the view is hidden while a saved view shows')
  assert.ok(await a.locator('.slide.active .live-page-slot .live-page-saved img').isVisible())
  await a.evaluate(() => window.__twLivePageGallery(JSON.stringify({ v: 1, url: 'https://another.example/', on: true, index: 0 })))
  r = await slot(a); assert.equal(r.visible, true, 'another page\'s choice is not this slide\'s')
  await a.evaluate(() => window.__twLivePageGallery('{"v":1,"on":"yes"}'))
  r = await slot(a); assert.equal(r.visible, true)
  await a.close()

  assert.deepEqual(errors, [], 'no page errors')
  console.log('live page gallery dom: saved views stand in where not live (frame never loaded, date shown, Open kept); presenter Capture/Saved views/step buttons (c, g keep their meaning)/auto fallback; audience follows main; only JPEG data: pictures; private address not published')
} finally {
  await browser?.close()
  rmSync(dir, { recursive: true, force: true })
}
