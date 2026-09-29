import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { buildVenuePageHtml, buildUnavailableVenuePageHtml } from '../compiler/scripts/lib/venue-page.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'

const gallerySlide = '<section class="slide" data-id="gallery"><h1>Images</h1><figure class="slide-figure"><img src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\'/%3E" alt="First"><figcaption>First</figcaption></figure><figure class="slide-figure"><img src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 2 2\'/%3E" alt="Second"><figcaption>Second</figcaption></figure></section>'

const html = buildVenuePageHtml({
  title: 'Venue test', slug: 'venue-test', liveTalkSlug: 'venue-test',
  workerBaseUrl: 'https://live.example.test', includeNotes: false, license: null,
  styles: '', qr: '<svg aria-label="QR code"></svg>', handoutUrl: 'https://handouts.fyi/k7m2',
  slides: [
    { html: '<section class="slide" data-id="title"><h1>Venue test</h1></section>', notes: '' },
    { html: '<section class="slide" data-id="content"><h1>Content</h1><ul class="feature-list"><li>One</li><li>Two</li><li>Three</li></ul></section>', notes: '' },
    { html: gallerySlide, notes: '' },
  ],
})
assert.match(buildUnavailableVenuePageHtml(), /This talk isn’t available/)
const dir = await mkdtemp(join(tmpdir(), 'tw-venue-'))
try {
  const path = join(dir, 'index.html')
  const unavailablePath = join(dir, '404.html')
  await writeFile(path, html)
  await writeFile(unavailablePath, buildUnavailableVenuePageHtml())
  const phonePath = join(dir, 'phone.html')
  await writeFile(phonePath, buildShareHtml({ title: 'Venue test', slug: 'venue-test', liveTalkSlug: 'venue-test',
    workerBaseUrl: 'https://live.example.test', includeNotes: false, license: null, styles: '',
    slides: [{ html: gallerySlide, notes: '' }] }))
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    await page.addInitScript(() => {
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
            expiresAt: Date.now() + 60000, slideState: window.__snapshotSlideState || null, polls: [], receipts: [],
          }))
          if (message.type === 'session.ping') this.emit({ type: 'session.pong', nonce: message.nonce })
        }
        close() { this.readyState = 3 }
        emit(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
      }
    })
    await page.goto(pathToFileURL(path).href)
    await page.waitForFunction(() => window.__sockets.length === 1)
    assert.match(await page.evaluate(() => window.__sockets[0].url), /kind=screen/)
    assert.equal(await page.locator('.slide.active').getAttribute('data-id'), 'title')
    assert.equal(await page.getByText('Click anywhere for full screen').isVisible(), true)
    await page.locator('body').click({ position: { x: 500, y: 400 } })
    assert.equal(await page.getByText('Click anywhere for full screen').isVisible(), false)
    await page.waitForFunction(() => Boolean(document.fullscreenElement))
    await page.evaluate(() => window.__sockets[0].emit({ type: 'slide.state', slideId: 'content', reveal: 0, focus: null, revision: 1 }))
    await page.locator('.slide.active[data-id="content"]').waitFor()
    await page.keyboard.press('ArrowLeft')
    assert.equal(await page.locator('.slide.active').getAttribute('data-id'), 'content', 'venue keys do nothing while presenter is online')
    await page.evaluate(() => window.__sockets[0].emit({ type: 'session.presence', presenterConnected: false, venueScreens: 1 }))
    assert.equal(await page.locator('.live-follow-status').isVisible(), false, 'the venue never shows a dropout notice')
    await page.keyboard.press('ArrowLeft')
    assert.equal(await page.locator('.slide.active').getAttribute('data-id'), 'title')
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.locator('.slide.active').getAttribute('data-id'), 'content')
    await page.keyboard.press('PageDown')
    assert.equal(await page.locator('.slide.active').getAttribute('data-id'), 'gallery', 'PageDown works while the laptop is offline')
    await page.keyboard.press('Backspace')
    assert.equal(await page.locator('.slide.active').getAttribute('data-id'), 'content', 'Backspace works while the laptop is offline')
    await page.keyboard.press('End')
    assert.equal(await page.locator('.slide.active').getAttribute('data-id'), 'gallery')
    await page.evaluate(() => window.__sockets[0].emit({ type: 'session.presence', presenterConnected: true, venueScreens: 1 }))
    assert.equal(await page.locator('.slide.active').getAttribute('data-id'), 'content', 'reconnect restores the last laptop slide without waiting for a new slide state')
    await page.evaluate(() => {
      window.__sockets[0].emit({ type: 'slide.state', slideId: 'title', reveal: 0, focus: null, revision: 2 })
    })
    await page.locator('.slide.active[data-id="title"]').waitFor()
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.locator('.slide.active').getAttribute('data-id'), 'title', 'venue keys stop when presenter returns')
    // Ticket 09: while the laptop drives the session, the presenting-mode keys are inert too.
    await page.evaluate(() => window.__sockets[0].emit({ type: 'slide.state', slideId: 'gallery', reveal: 0, focus: null, revision: 3 }))
    await page.locator('.slide.active[data-id="gallery"]').waitFor()
    for (const key of ['z', 'f', 'r', 'Z', 'F', 'R']) {
      await page.keyboard.press(key)
      assert.equal(await page.locator('.lightbox').isVisible(), false, `${key} opens no gallery while the laptop drives`)
      assert.equal(await page.locator('.slide.active.mode-active').count(), 0, `${key} starts no mode while the laptop drives`)
    }
    const galleryState = (open, index, revision) => ({ type: 'slide.state', slideId: 'gallery', reveal: 0,
      focus: null, lightbox: { open, index }, revision })
    await page.evaluate((state) => window.__sockets[0].emit(state), galleryState(true, 0, 4))
    await page.locator('.lightbox:visible #lightboxImg[alt="First"]').waitFor()
    assert.equal(await page.locator('#lightboxCounter').textContent(), '1 / 2')
    assert.equal(await page.locator('.lightbox-nav').first().isVisible(), false, 'venue gallery has no visible controls')
    assert.equal(await page.locator('.lightbox-bar').isVisible(), false, 'venue gallery has no footer')
    assert.deepEqual(await page.locator('.lightbox').boundingBox().then(({ x, y, width, height }) => ({ x, y, width, height })),
      { x: 0, y: 0, width: 1280, height: 720 }, 'venue gallery fills the screen')
    await page.evaluate((state) => window.__sockets[0].emit(state), galleryState(true, 1, 5))
    await page.locator('.lightbox:visible #lightboxImg[alt="Second"]').waitFor()
    assert.equal(await page.locator('#lightboxCounter').textContent(), '2 / 2')
    await page.evaluate((state) => {
      window.__snapshotSlideState = state
      document.getElementById('lightboxClose').click()
      window.__sockets[0].onclose?.()
    }, galleryState(true, 1, 5))
    await page.waitForFunction(() => window.__sockets.length === 2)
    await page.locator('.lightbox:visible #lightboxImg[alt="Second"]').waitFor()
    await page.evaluate((state) => window.__sockets[1].emit(state), galleryState(false, 1, 6))
    await page.locator('.lightbox').waitFor({ state: 'hidden' })
    assert.equal(await page.locator('.slide.active').getAttribute('data-id'), 'gallery')
    await page.evaluate(() => window.__sockets[1].emit({
      type: 'instant.state', slide: { kind: 'text', text: 'Take a short break', shownAt: Date.now() },
    }))
    await page.locator('.instant-slide-surface:visible .instant-slide-text').getByText('Take a short break').waitFor()
    await page.evaluate(() => window.__sockets[1].emit({
      type: 'instant.state',
      slide: { kind: 'link', url: 'https://example.test/resource',
        qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>',
        shownAt: Date.now() },
    }))
    await page.locator('.instant-slide-surface:visible .instant-slide-link').getByText(/example.test/).waitFor()
    assert.match(await page.locator('.instant-slide-surface .instant-slide-qr img').getAttribute('src'), /^data:image\/svg\+xml/)
    const imageBytes = await sharp({ create: { width: 960, height: 600, channels: 3, background: '#25749a' } }).webp().toBuffer()
    const imageSlide = { kind: 'image', dataUrl: `data:image/webp;base64,${imageBytes.toString('base64')}`, width: 960, height: 600, shownAt: Date.now() }
    await page.evaluate((slide) => window.__sockets[1].emit({ type: 'instant.state', slide }), imageSlide)
    const shownImage = page.locator('.instant-slide-surface:visible .instant-slide-image')
    await shownImage.waitFor()
    await page.waitForFunction(() => document.querySelector('.instant-slide-surface .instant-slide-image')?.naturalWidth === 960)
    assert.equal(await shownImage.evaluate((element) => element.naturalWidth), 960)
    assert.equal(await shownImage.evaluate((element) => getComputedStyle(element).objectFit), 'contain')
    await page.evaluate(() => window.__sockets[1].emit({ type: 'instant.state', slide: null }))
    assert.equal(await page.locator('.instant-slide-surface').isVisible(), false, 'clearing an instant slide reveals the venue slide')
    assert.equal(await page.locator('.slide.active').getAttribute('data-id'), 'gallery')
    for (const selector of ['.share-footer', '.help-fab', '.now-live-badge', '.live-follow-status', '.phone-bar', '.nav-panel']) {
      assert.equal(await page.locator(selector).first().isVisible(), false, `${selector} is hidden`)
    }
    assert.equal(await page.locator('button:visible').count(), 0, 'ordinary slides show no visible buttons')
    // Ticket 04 (V6): the talk's QR overlay follows the presenter from a slide with no QR code.
    await page.evaluate(() => window.__sockets[1].emit({ type: 'slide.state', slideId: 'content', reveal: 0, focus: null, talkQr: true, revision: 7 }))
    const talkQr = page.locator('#venueTalkQr')
    await talkQr.waitFor({ state: 'visible' })
    assert.equal(await page.locator('.slide.active').getAttribute('data-id'), 'content')
    assert.equal(await talkQr.locator('.qr-fs-url').textContent(), 'handouts.fyi/k7m2')
    assert.equal(await talkQr.locator('.qr-fs-url strong').textContent(), '/k7m2')
    assert.equal(await talkQr.locator('svg').count(), 1)
    assert.deepEqual(await talkQr.boundingBox().then(({ x, y, width, height }) => ({ x, y, width, height })),
      { x: 0, y: 0, width: 1280, height: 720 }, 'the QR overlay fills the venue screen')
    await page.evaluate(() => window.__sockets[1].emit({ type: 'slide.state', slideId: 'content', reveal: 0, focus: null, revision: 8 }))
    await talkQr.waitFor({ state: 'hidden' })
    assert.equal(await page.locator('.slide.active').getAttribute('data-id'), 'content', 'closing the QR overlay returns to the same slide')
    await page.evaluate(() => window.__sockets[1].emit({
      type: 'poll.state', pollId: 'poll-1', pollType: 'single', question: 'Choose one',
      options: [{ optionId: 'a', label: 'First' }, { optionId: 'b', label: 'Second' }],
      visibility: 'live', open: true, revealed: true, tallies: { a: 0, b: 0 },
    }))
    await page.getByText('Choose one').waitFor()
    assert.equal(await page.locator('.share-footer').isVisible(), false)
    await page.evaluate(() => window.__sockets[1].emit({ type: 'session.closed', reason: 'ended' }))
    await page.getByText('Slides and links').waitFor()
    assert.equal(await page.locator('.slide.active').getAttribute('data-id'), 'title')
    assert.equal(await page.locator('.audience-poll-surface').isVisible(), false)
    await page.keyboard.press('PageDown')
    assert.equal(await page.locator('.slide.active').getAttribute('data-id'), 'content', 'venue keys work after the session ends')
    assert.equal(await page.locator('#venueClosing').isVisible(), false, 'the closing card clears when the venue resumes its slideshow')
    await page.keyboard.press('PageUp')
    assert.equal(await page.locator('.slide.active').getAttribute('data-id'), 'title')

    const standalone = await browser.newPage()
    await standalone.addInitScript(() => {
      window.__sessionLive = false
      window.__sockets = []
      window.fetch = async () => ({ ok: true, json: async () => window.__sessionLive
        ? { live: true, sessionId: 'session-2' } : { live: false } })
      window.WebSocket = class {
        static OPEN = 1
        readyState = 1
        constructor() {
          window.__sockets.push(this)
          queueMicrotask(() => { this.onopen?.(); this.emit({ type: 'session.hello', protocol: 2 }) })
        }
        send(raw) {
          const message = JSON.parse(raw)
          if (message.type === 'session.sync') queueMicrotask(() => {
            this.emit({ type: 'session.snapshot', protocol: 2, sessionId: 'session-2', syncId: message.syncId,
              expiresAt: Date.now() + 60000, slideState: null, polls: [], receipts: [] })
            this.synced = true
          })
          if (message.type === 'session.ping') this.emit({ type: 'session.pong', nonce: message.nonce })
        }
        close() { this.readyState = 3 }
        emit(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
      }
    })
    await standalone.goto(pathToFileURL(path).href)
    await standalone.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'title')
    assert.equal(await standalone.evaluate(() => window.__sockets.length), 0, 'no live session was discovered')
    const nextKeys = ['ArrowRight', 'ArrowDown', 'Space', 'Enter', 'PageDown']
    const previousKeys = ['ArrowLeft', 'ArrowUp', 'Backspace', 'PageUp']
    for (const key of nextKeys) {
      await standalone.keyboard.press(key)
      assert.equal(await standalone.locator('.slide.active').getAttribute('data-id'), 'content', `${key} advances without a session`)
      await standalone.keyboard.press('Home')
    }
    for (const key of previousKeys) {
      await standalone.keyboard.press('End')
      await standalone.keyboard.press(key)
      assert.equal(await standalone.locator('.slide.active').getAttribute('data-id'), 'content', `${key} goes back without a session`)
      await standalone.keyboard.press('Home')
    }
    await standalone.keyboard.press('End')
    assert.equal(await standalone.locator('.slide.active').getAttribute('data-id'), 'gallery')
    await standalone.keyboard.press('Home')
    assert.equal(await standalone.locator('.slide.active').getAttribute('data-id'), 'title')
    const modified = await standalone.evaluate(() => {
      const event = new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, bubbles: true, cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    })
    assert.equal(modified, false, 'modified keys pass through')
    assert.equal(await standalone.locator('.slide.active').getAttribute('data-id'), 'title')
    // Ticket 09 (ADR-0026 amendment 2026-09-28): with no laptop the venue takes the presenting modes.
    const active = () => standalone.locator('.slide.active').getAttribute('data-id')
    const counter = () => standalone.locator('#lightboxCounter').textContent()
    const unitStates = () => standalone.locator('.slide.active .feature-list > li').evaluateAll((items) => items.map((li) => li.getAttribute('data-mode-state')))
    await standalone.keyboard.press('End')
    await standalone.keyboard.press('z')
    await standalone.locator('.lightbox:visible #lightboxImg[alt="First"]').waitFor()
    await standalone.keyboard.press('ArrowRight')
    assert.equal(await counter(), '2 / 2', 'arrows browse the gallery')
    await standalone.keyboard.press('ArrowLeft')
    assert.equal(await counter(), '1 / 2')
    await standalone.keyboard.press('End')
    assert.equal(await counter(), '2 / 2', 'End goes to the last image')
    await standalone.keyboard.press('Home')
    assert.equal(await counter(), '1 / 2', 'Home goes to the first image')
    assert.equal(await active(), 'gallery', 'browsing the gallery does not move the deck')
    await standalone.keyboard.press('Escape')
    await standalone.locator('.lightbox').waitFor({ state: 'hidden' })
    await standalone.keyboard.press('Z')
    await standalone.locator('.lightbox:visible').waitFor()
    await standalone.keyboard.press('z')
    await standalone.locator('.lightbox').waitFor({ state: 'hidden' })
    await standalone.keyboard.press('Home')
    await standalone.keyboard.press('ArrowRight')
    assert.equal(await active(), 'content')
    await standalone.keyboard.press('f')
    assert.equal(await standalone.locator('.slide.active.mode-active').count(), 1, 'F enters focus')
    assert.deepEqual(await unitStates(), ['fuzzy', 'fuzzy', 'fuzzy'])
    await standalone.keyboard.press('n')
    assert.deepEqual(await unitStates(), ['current', 'fuzzy', 'fuzzy'], 'N steps focus')
    await standalone.keyboard.press('n')
    assert.deepEqual(await unitStates(), ['soft', 'current', 'fuzzy'])
    await standalone.keyboard.press('p')
    assert.deepEqual(await unitStates(), ['current', 'fuzzy', 'fuzzy'], 'P steps focus back')
    await standalone.keyboard.press('?')
    await standalone.keyboard.press('/')
    assert.equal(await standalone.locator('#helpOverlay.open, .nav-panel.open').count(), 0, '? and / stay inert inside a mode')
    await standalone.keyboard.press('Escape')
    assert.equal(await standalone.locator('.slide.active.mode-active').count(), 0, 'Esc exits focus')
    await standalone.keyboard.press('r')
    assert.deepEqual(await unitStates(), ['hidden', 'hidden', 'hidden'], 'R enters reveal')
    await standalone.keyboard.press('ArrowRight')
    assert.deepEqual(await unitStates(), ['current', 'hidden', 'hidden'], 'arrows step reveal')
    await standalone.keyboard.press('n')
    assert.deepEqual(await unitStates(), ['soft', 'current', 'hidden'], 'N steps reveal')
    assert.equal(await active(), 'content', 'stepping reveal stays on the slide')
    await standalone.keyboard.press('R')
    assert.equal(await standalone.locator('.slide.active.mode-active').count(), 0, 'R toggles reveal off')
    for (const key of ['?', '/', 'o', 'n', 'Escape']) await standalone.keyboard.press(key)
    assert.equal(await standalone.locator('#helpOverlay.open, .nav-panel.open, #myNotesPanel.open, .notes-panel.open').count(), 0, 'reader-only keys stay inert on the venue page')
    assert.equal(await active(), 'content', 'reader-only keys do not move the deck')
    await standalone.keyboard.press('Home')
    await standalone.keyboard.press('ArrowRight')
    await standalone.evaluate(() => { window.__sessionLive = true })
    await standalone.waitForFunction(() => window.__sockets[0]?.synced, { timeout: 7000 })
    await standalone.evaluate(() => window.__sockets[0].emit({ type: 'slide.state', slideId: 'gallery', reveal: 0, focus: null, revision: 1 }))
    await standalone.locator('.slide.active[data-id="gallery"]').waitFor()
    await standalone.keyboard.press('ArrowLeft')
    assert.equal(await standalone.locator('.slide.active').getAttribute('data-id'), 'gallery', 'go-live restores laptop control')
    await standalone.close()
    await page.goto(pathToFileURL(unavailablePath).href)
    assert.equal(await page.getByText('This talk isn’t available').isVisible(), true)
    await page.goto(pathToFileURL(phonePath).href)
    await page.waitForFunction(() => window.__sockets.length === 1)
    await page.evaluate((state) => window.__sockets[0].emit(state), galleryState(true, 0, 1))
    assert.equal(await page.locator('.lightbox').isVisible(), false, 'presenter gallery does not open on a phone')
    await page.keyboard.press('z')
    assert.equal(await page.locator('.lightbox').isVisible(), true, 'phone keeps its local Z gallery')
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.__sockets[0].emit({ type: 'slide.state', slideId: 'gallery', reveal: 0, focus: null, talkQr: true, revision: 2 }))
    assert.equal(await page.locator('#venueTalkQr, .qr-fullscreen').count(), 0, 'a following phone is never shown the talk QR overlay')
  } finally { await browser.close() }
} finally { await rm(dir, { recursive: true, force: true }) }
console.log('venue screen DOM: title, gallery, presenting modes, QR overlay, reconnect, phone independence, poll, chrome and closing passed')
