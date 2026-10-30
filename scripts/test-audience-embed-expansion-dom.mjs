// Every non-video HTML figure's Interact chip on the published online page and on the standalone
// file export expands the page to the whole browser viewport (a large, usable iframe with pointer
// and keyboard input, a visible "Return to slides" button, Escape closes) and keeps the page's
// own document state and sandbox. Real compilation (prepareSource, extractStyles) and the real
// buildShareHtml; headless bundled Chromium only. Fixtures are made hostile on purpose: nested
// card wrappers (transform/overflow/contain, which break `position: fixed`) and an explicit short
// figure height (the "strip"). Phone and desktop; local, Simulation and remote (a second local
// HTTP origin) frames; online (http) and offline (file://).
// Usage: node scripts/test-audience-embed-expansion-dom.mjs   (SHOTS=<dir> keeps screenshots)
import { statSync } from 'node:fs'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { buildVenuePageHtml } from '../compiler/scripts/lib/venue-page.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildHandoutHomePageHtml } from '../compiler/scripts/lib/handout-home-page.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const root = resolve(import.meta.dirname, '..')
const scratch = await mkdtemp(join(root, '.tw-embed-expansion-'))
// Removed on any exit, including a failure before the browser launches.
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))
const shots = process.env.SHOTS ? resolve(process.env.SHOTS) : null
if (shots) await mkdir(shots, { recursive: true })

// One stateful page: a button, a text field, and a nonce that changes if the document reloads.
const PAGE = '<!doctype html><title>Stateful page</title><body style="margin:0"><button id="count">Count</button><input id="text" aria-label="Text"><output id="n">0</output><script>window.nonce=Math.random();document.getElementById("count").onclick=()=>{var o=document.getElementById("n");o.textContent=Number(o.textContent)+1}</script>'
const remoteServer = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE) })
await new Promise(done => remoteServer.listen(0, 'localhost', done))
const REMOTE = `http://localhost:${remoteServer.address().port}/remote.html`

const outline = `---
title: Expansion
auto_title_slide: false
auto_thanks_slide: false
---

### Two local pages {id=two-local}

[Embed: page.html]

[Embed: page.html]

### A simulation {id=sim}

[Simulation: page.html]

### A remote page {id=remote}

[Embed: ${REMOTE}]

### End {id=end}

- Done
`
const outlinePath = join(scratch, 'outline.md')
await writeFile(outlinePath, outline)
await writeFile(join(scratch, 'page.html'), PAGE)
const model = await prepareSource(outlinePath, outline, null, statSync(outlinePath), {}, {})
const hostile = '.slide-embed{height:120px!important;aspect-ratio:auto!important;min-height:0!important}.slide-embed iframe{min-height:0!important}.tw-card,.tw-card-inner{transform:translateZ(0);overflow:hidden;contain:paint}'
// Nested card wrappers around every embed figure, as a card gallery or a slot would put them.
const wrap = html => html.replace(/(<figure class="slide-embed[\s\S]*?<\/figure>)/g, '<div class="tw-card"><div class="tw-card-inner">$1</div></div>')
const slides = extractSlides(model.fullHtml).map(slide => ({ ...slide, html: wrap(slide.html) }))
const styles = extractStyles(model.fullHtml) + hostile
const share = join(scratch, 'share.html')
await writeFile(share, buildShareHtml({ title: 'Expansion', slug: 'expansion', includeNotes: false, license: null, styles, slides }))
// The handout home page (index.html) is the same bundle in home mode with extra ancestors; its Live
// layout holds the running stage. A fake live service says a session is live so that layout shows.
const venueFile = join(scratch, 'venue.html')
await writeFile(venueFile, buildVenuePageHtml({ title: 'Expansion', slug: 'expansion', license: null, styles, slides, qr: '', handoutUrl: '' }))
const homeFile = join(scratch, 'home.html')
await writeFile(homeFile, buildHandoutHomePageHtml({ title: 'Expansion', slides, styles, slug: 'expansion', license: null, workerBaseUrl: 'https://live.example.test', liveTalkSlug: 'expansion', home: { url: 'https://handouts.example.test/k7m2', qr: '<svg aria-label="QR code"></svg>', event: 'Briefing', author: 'Speaker' } }))
const liveService = () => {
  window.fetch = async (url) => {
    const path = String(url)
    if (path.includes('/capabilities')) return { ok: true, status: 200, json: async () => ({ protocol: 2, build: '14-reactions-questions' }) }
    if (/\/sessions\/[^/]+\/status/.test(path)) return { ok: true, status: 200, json: async () => ({ status: 'live' }) }
    return { ok: true, status: 200, json: async () => ({ live: true, sessionId: 'session-1' }) }
  }
  window.WebSocket = class { static OPEN = 1; readyState = 0
    constructor() { queueMicrotask(() => { this.readyState = 1; this.onopen?.(); this.emit({ type: 'session.hello', protocol: 2, expiresAt: Date.now() + 600000 }) }) }
    send(raw) { const m = JSON.parse(raw); if (m.type === 'session.sync') queueMicrotask(() => this.emit({ type: 'session.snapshot', protocol: 2, sessionId: 'session-1', syncId: m.syncId, expiresAt: Date.now() + 600000, slideState: null, polls: [], receipts: [] })); if (m.type === 'session.ping') this.emit({ type: 'session.pong', nonce: m.nonce }) }
    close() { this.readyState = 3 }
    emit(m) { this.onmessage?.({ data: JSON.stringify(m) }) } }
}
const onlineServer = createServer(async (req, res) => { res.setHeader('content-type', 'text/html'); res.end(await (await import('node:fs/promises')).readFile(share)) })
await new Promise(done => onlineServer.listen(0, '127.0.0.1', done))
const ONLINE = `http://127.0.0.1:${onlineServer.address().port}/`
const OFFLINE = pathToFileURL(share).href

const failures = []
const check = (ok, label) => { if (!ok) failures.push(label) }
const sizes = { desktop: [1440, 900], phone: [390, 844] }
const CHIP = '.slide.active figure.slide-embed .embed-interact-chip'
const rectOf = (page, selector) => page.evaluate(sel => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight } }, selector)
const frameOf = (page, slideId, nth) => page.locator(`.slide[data-id="${slideId}"] figure.slide-embed iframe`).nth(nth)

let browser
try {
  // TW_HEADLESS_SHELL: a chrome-headless-shell path for machines whose Playwright build is not installed.
  browser = await chromium.launch({ headless: true, ...(process.env.TW_HEADLESS_SHELL ? { executablePath: process.env.TW_HEADLESS_SHELL } : {}) })
  // Review regressions use the real venue builder and real sequential keyboard navigation.
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(pathToFileURL(venueFile).href + '#two-local')
    const frame = frameOf(page, 'two-local', 0)
    await page.locator(CHIP).first().click()
    check(await frame.evaluate(f => f.classList.contains('embed-live')), 'venue: Interact enables the existing local frame')
    check(!(await page.evaluate(() => document.body.classList.contains('share-embed-expanded'))), 'venue: interaction remains inline')
    const inside = await (await frame.elementHandle()).contentFrame()
    await inside.locator('#count').click({ timeout: 1000 }).catch(() => {})
    check(await inside.locator('#n').textContent() === '1', 'venue: a real pointer click reaches the local page')
    await page.close()
  }
  for (const [mode, url] of [['online', ONLINE], ['file', OFFLINE], ['home', pathToFileURL(homeFile).href], ['remote', ONLINE]]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    if (mode === 'home') await page.addInitScript(liveService)
    if (mode === 'file') await page.route(/^https?:/, route => route.abort())
    const slideId = mode === 'remote' ? 'remote' : 'two-local'
    await page.goto(url + '#' + slideId)
    await page.waitForFunction(() => document.querySelector('.slide.active iframe[srcdoc], .slide.active iframe[src]'))
    const frame = frameOf(page, slideId, 0)
    const chip = page.locator(CHIP).first()
    const ret = page.locator('#shareEmbedReturn')
    await page.evaluate(() => {
      const authored = document.createElement('button')
      authored.id = 'authoredInert'; authored.setAttribute('inert', 'authored'); authored.setAttribute('tabindex', '7')
      document.body.appendChild(authored)
      const sibling = document.createElement('button')
      sibling.id = 'authoredTab'; sibling.setAttribute('tabindex', '-1')
      document.querySelector('.slide.active figure').prepend(sibling)
      window.originalFocusAttributes = Array.from(document.querySelectorAll('*'), el => [el, el.getAttribute('inert'), el.getAttribute('tabindex')])
    })
    const restored = () => page.evaluate(() => window.originalFocusAttributes.every(([el, inert, tab]) => el.getAttribute('inert') === inert && el.getAttribute('tabindex') === tab))
    for (const exit of ['Escape', 'Enter', 'Space', 'navigation', 'print', 'stage']) {
      if (mode === 'home' && exit === 'navigation') continue // The home Live stage follows the speaker, not hash navigation.
      await chip.click()
      const inside = await (await frame.elementHandle()).contentFrame()
      await inside.locator('#text').focus()
      // From the last authored field, Tab must reach Return directly, not covered navigation.
      await page.keyboard.press('Tab')
      check(await ret.evaluate(el => el === document.activeElement), `${mode}/${exit}: Tab from frame reaches visible Return directly`)
      for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
        await page.keyboard.press(key)
        check(await page.evaluate(() => document.activeElement === document.querySelector('.slide.active iframe.embed-live') || document.activeElement === document.getElementById('shareEmbedReturn')), `${mode}/${exit}: ${key} stays within frame and Return`)
      }
      await ret.focus()
      if (exit === 'navigation') await page.evaluate(() => { location.hash = '#end' })
      else if (exit === 'print') await page.evaluate(() => dispatchEvent(new Event('beforeprint')))
      else if (exit === 'stage') await page.evaluate(() => { document.getElementById('phoneFull').click() })
      else await page.keyboard.press(exit)
      console.log(`FOCUS ${mode}/${exit}`)
      check(await page.waitForFunction(() => !document.body.classList.contains('share-embed-expanded'), null, { timeout: 1000 }).then(() => true).catch(() => false), `${mode}/${exit}: exit clears expansion`)
      if (await ret.isVisible()) await ret.click()
      check(await restored(), `${mode}/${exit}: cleanup preserves authored inert and tabindex attributes`)
      if (exit === 'navigation' || exit === 'stage') {
        await page.evaluate(id => { document.querySelector('#fsOverlay')?.classList.remove('is-open'); location.hash = '#' + id; window.dispatchEvent(new Event('resize')) }, slideId)
        await page.waitForFunction(id => document.querySelector(`.slide.active[data-id="${id}"] iframe[srcdoc], .slide.active[data-id="${id}"] iframe[src]`), slideId)
      }
    }
    await page.close()
  }
  for (const [mode, url] of [['online', ONLINE], ['file', OFFLINE]]) {
    for (const [device, [width, height]] of Object.entries(sizes)) {
      const context = await browser.newContext({ viewport: { width, height }, hasTouch: device === 'phone' })
      // Offline export: no network at all, so a local page cannot depend on it (the remote one is judged for expansion only).
      if (mode === 'file') await context.route(/^https?:/, route => route.abort())
      const page = await context.newPage()
      page.setDefaultTimeout(2500)
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      const cases = [['two-local', 0, 'local'], ['two-local', 1, 'local'], ['sim', 0, 'simulation'], ['remote', 0, 'remote']]
      for (const [slideId, nth, kind] of cases) {
        const label = `${mode}/${device}/${kind}#${nth}`
        try {
        // The remote page is only loaded over http; over file:// it stays unloaded, so only the expansion is judged there.
        const loadsInside = kind !== 'remote' || mode === 'online'
        await page.goto(`${url}#${slideId}`)
        await page.waitForSelector(`.slide.active[data-id="${slideId}"]`)
        const frame = frameOf(page, slideId, nth)
        if (loadsInside) await page.waitForFunction(([id, n]) => { const f = document.querySelectorAll(`.slide[data-id="${id}"] figure.slide-embed iframe`)[n]; return f && (f.hasAttribute('srcdoc') || f.src) }, [slideId, nth])
        const chip = page.locator(`.slide[data-id="${slideId}"] figure.slide-embed`).nth(nth).locator('.embed-interact-chip')
        const before = await frame.evaluate(f => ({ sandbox: f.getAttribute('sandbox'), strip: Math.round(f.getBoundingClientRect().height) }))
        check(await chip.count() === 1 && await chip.isVisible(), `${label}: the Interact chip is visible on the page`)
        if (await chip.count() === 0) continue
        check(/Expand and interact/.test(await chip.textContent()), `${label}: chip text is "Expand and interact" (got "${(await chip.textContent()).trim()}")`)
        // Make the page hold a state before expanding: it must survive expand and return.
        let inside = null
        if (loadsInside) {
          inside = await (await frame.elementHandle()).contentFrame()
          // State is set by script, never by pointer or focus: before the chip the page takes neither.
          if (inside) await inside.evaluate(() => { window.fixtureSentinel = 'kept'; document.getElementById('text').value = 'keep me' }).catch(() => { inside = null })
        }
        const nonceBefore = inside ? await inside.evaluate(() => window.nonce).catch(() => null) : null
        await chip.click()
        await page.waitForTimeout(250)
        const rect = await frame.evaluate(f => { const r = f.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight } })
        console.log(`MEASURE ${label}: iframe ${rect.w}x${rect.h} at (${rect.x},${rect.y}) in viewport ${rect.vw}x${rect.vh}; inline height before ${before.strip}`)
        check(rect.w >= rect.vw * 0.95 && rect.h >= rect.vh * 0.9, `${label}: expanded iframe fills the viewport (measured ${rect.w}x${rect.h} at ${rect.x},${rect.y} of ${rect.vw}x${rect.vh})`)
        check(rect.x >= -1 && rect.y >= -1 && rect.x + rect.w <= rect.vw + 1 && rect.y + rect.h <= rect.vh + 1, `${label}: expanded iframe stays inside the viewport`)
        const ret = page.locator('#shareEmbedReturn')
        check(await ret.count() === 1 && await ret.isVisible() && /Return to slides/.test(await ret.textContent()), `${label}: a visible "Return to slides" button (#shareEmbedReturn)`)
        check(await page.evaluate(() => document.body.classList.contains('share-embed-expanded')), `${label}: body.share-embed-expanded while expanded`)
        check(await page.evaluate(sel => document.querySelector(sel)?.classList.contains('embed-stage-expanded') ?? false, `.slide[data-id="${slideId}"] figure.slide-embed:nth-of-type(${nth + 1})`) || await page.locator(`.slide[data-id="${slideId}"] figure.slide-embed.embed-stage-expanded`).count() === 1, `${label}: figure carries .embed-stage-expanded`)
        check(await page.locator('.slide.embed-full-screen').count() === 1, `${label}: the active slide carries .embed-full-screen`)
        check(await frame.getAttribute('sandbox') === before.sandbox, `${label}: sandbox unchanged (${before.sandbox})`)
        if (kind !== 'remote') check(!(before.sandbox || '').includes('allow-same-origin'), `${label}: local page keeps an opaque origin (${before.sandbox})`)
        if (shots) await page.screenshot({ path: join(shots, `${label.replace(/[/#]/g, '-')}-expanded.png`) })
        // Pointer and keyboard input reach the page at the centre of the expanded frame.
        if (loadsInside && inside) {
          // Real pointer and keyboard through the browser's own hit-testing, at the page's real controls.
          await inside.locator('#text').click()
          await page.keyboard.press('End')
          await page.keyboard.type('abc')
          const typed = await inside.evaluate(() => document.getElementById('text').value)
          check(typed === 'keep meabc', `${label}: a click then typing reaches the field after the earlier text (got "${typed}")`)
          await inside.locator('#count').click()
          check(await inside.evaluate(() => document.getElementById('n').textContent) === '1', `${label}: a click on the page's button is counted once`)
          check(await inside.evaluate(() => { try { void parent.document.title; return false } catch { return true } }), `${label}: the page cannot read the parent document (no disclosure)`)
          const expandedViewport = await inside.evaluate(() => [innerWidth, innerHeight])
          check(expandedViewport[0] >= rect.vw * 0.9 && expandedViewport[1] >= rect.vh * 0.8, `${label}: the page's own viewport is large (${expandedViewport})`)
        }
        // Escape closes (a local agent forwards it; a remote page cannot, so press it on this page).
        if (kind === 'remote') await ret.focus()
        await page.keyboard.press('Escape')
        await page.waitForTimeout(250)
        check(!(await page.evaluate(() => document.body.classList.contains('share-embed-expanded'))), `${label}: Escape closes the expansion`)
        check(await ret.count() === 0 || !(await ret.isVisible()), `${label}: Return to slides is hidden after Escape`)
        const back = await frame.evaluate(f => Math.round(f.getBoundingClientRect().height))
        check(back <= before.strip + 2, `${label}: the figure returns to its slide size (${back} vs ${before.strip})`)
        const focus = await page.evaluate(() => { const a = document.activeElement; return a ? (a.className || a.tagName) : '' })
        check(/embed-interact-chip/.test(focus) || /^BODY$/.test(focus) === false && !/IFRAME/i.test(focus), `${label}: focus returns to the chip or the page, not the frame (${focus})`)
        if (inside) {
          check(await inside.evaluate(() => window.nonce).catch(() => null) === nonceBefore, `${label}: the page's document was not reloaded`)
          check(await inside.evaluate(() => window.fixtureSentinel).catch(() => null) === 'kept', `${label}: the page's script state survives return`)
          check(await inside.evaluate(() => document.getElementById('text').value).catch(() => '') === 'keep meabc', `${label}: the page's typed state survives return`)
        }
        // Expand again, then leave by the Return button; then navigation cleans up an open expansion.
        await chip.click(); await page.waitForTimeout(150)
        await ret.click(); await page.waitForTimeout(150)
        check(!(await page.evaluate(() => document.body.classList.contains('share-embed-expanded'))), `${label}: Return to slides closes the expansion`)
        if (mode === 'online' && device === 'desktop' && kind === 'local' && nth === 0) {
          // The Return button by keyboard: focus it, then Enter, and again with Space.
          for (const key of ['Enter', 'Space']) {
            await chip.click(); await page.waitForTimeout(150)
            await ret.focus()
            await page.keyboard.press(key)
            await page.waitForTimeout(150)
            check(!(await page.evaluate(() => document.body.classList.contains('share-embed-expanded'))), `${label}: Return to slides closes the expansion with ${key}`)
          }
        }
        await chip.click(); await page.waitForTimeout(150)
        await page.evaluate(() => { location.hash = '#end' }); await page.waitForTimeout(300)
        check(!(await page.evaluate(() => document.body.classList.contains('share-embed-expanded'))) && await page.locator('.embed-stage-expanded, .embed-full-screen').count() === 0, `${label}: moving to another slide cleans up the expansion`)
        } catch (error) { failures.push(`${label}: stopped by ${String(error.message).split('\n')[0]}`); await page.evaluate(() => document.querySelectorAll('iframe').forEach(f => f.classList.remove('embed-live'))).catch(() => {}) }
      }
      // Print while expanded: the real PDF path. beforeprint hands the page back to the slide, so no expansion
      // class remains, Return to slides is hidden and the labelled box stands where the page was.
      await page.goto(url + '?print#sim')
      await page.waitForSelector('.slide.active[data-id="sim"]', { state: 'attached' }).catch(() => failures.push(`${mode}/${device}: print fixture: the sim slide never became active`))
      await page.evaluate(() => { window.__print = { before: 0, after: 0 }; addEventListener('beforeprint', () => window.__print.before++); addEventListener('afterprint', () => window.__print.after++) })
      await page.locator('.slide[data-id="sim"] figure.slide-embed .embed-interact-chip').click()
      check(await page.evaluate(() => document.body.classList.contains('share-embed-expanded')), `${mode}/${device}: print fixture is expanded before printing`)
      const pdf = join(scratch, `print-${mode}-${device}.pdf`)
      await page.pdf({ path: pdf, width: '11in', height: '8.5in', printBackground: true })
      const printed = await page.evaluate(() => ({ events: window.__print, body: document.body.classList.contains('share-embed-expanded'), figure: document.querySelectorAll('.embed-stage-expanded').length, slide: document.querySelectorAll('.embed-full-screen').length }))
      check(printed.events.before >= 1, `${mode}/${device}: the browser fired beforeprint for page.pdf (${JSON.stringify(printed.events)})`)
      check(!printed.body && printed.figure === 0 && printed.slide === 0, `${mode}/${device}: printing clears the expansion classes (${JSON.stringify(printed)})`)
      await page.emulateMedia({ media: 'print' })
      check(!(await page.locator('#shareEmbedReturn').isVisible().catch(() => false)), `${mode}/${device}: print hides Return to slides`)
      check(!(await page.locator(CHIP).first().isVisible().catch(() => false)), `${mode}/${device}: print hides the chip`)
      check(await page.locator('.slide[data-id="sim"] figure.slide-embed .embed-poster').first().isVisible(), `${mode}/${device}: the labelled box stands in the print layout`)
      check(errors.length === 0, `${mode}/${device}: no page errors (${errors.join('; ')})`)
      await context.close()
    }
  }
  // Handout home page, Live layout: the same expansion from inside the extra ancestors.
  for (const [device, [width, height]] of Object.entries(sizes)) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: device === 'phone' })
    const page = await context.newPage()
    page.setDefaultTimeout(2500)
    await page.addInitScript(liveService)
    const label = `handout-home-live/${device}`
    try {
      await page.goto(pathToFileURL(homeFile).href + '#sim')
      await page.waitForSelector('.handout-home[data-layout="live"]', { state: 'attached' })
      await page.waitForFunction(() => document.querySelector('.slide.active[data-id="sim"] figure.slide-embed iframe[srcdoc]'))
      const frame = frameOf(page, 'sim', 0)
      const chip = page.locator('.slide[data-id="sim"] figure.slide-embed .embed-interact-chip')
      check(await chip.isVisible() && /Expand and interact/.test(await chip.textContent()), `${label}: the chip is visible on the Live stage ("${(await chip.textContent()).trim()}")`)
      await chip.click()
      await page.waitForTimeout(250)
      const rect = await frame.evaluate(f => { const r = f.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight } })
      console.log(`MEASURE ${label}: iframe ${rect.w}x${rect.h} at (${rect.x},${rect.y}) in viewport ${rect.vw}x${rect.vh}`)
      check(rect.w >= rect.vw * 0.95 && rect.h >= rect.vh * 0.9 && rect.x >= -1 && rect.y >= -1, `${label}: expanded iframe fills the viewport (measured ${rect.w}x${rect.h} at ${rect.x},${rect.y})`)
      check(await page.locator('#shareEmbedReturn').isVisible(), `${label}: Return to slides is visible`)
      const inside = await (await frame.elementHandle()).contentFrame()
      await inside.locator('#text').click()
      await page.keyboard.type('live')
      check(await inside.evaluate(() => document.getElementById('text').value) === 'live', `${label}: typing reaches the page`)
      // A focused text field keeps every key, Escape included (embed-protocol.js embedKeepsKeys, design 5.6): the way out
      // is then the Return button. Reported to the parent as a limit, not asserted as a defect.
      await page.keyboard.press('Escape')
      await page.waitForTimeout(250)
      if (await page.evaluate(() => document.body.classList.contains('share-embed-expanded'))) console.log(`NOTE ${label}: Escape is not forwarded while a text field of the page has the focus; Return to slides is the way out`)
      await page.locator('#shareEmbedReturn').click()
      await page.waitForTimeout(250)
      check(!(await page.evaluate(() => document.body.classList.contains('share-embed-expanded'))), `${label}: Return to slides closes the expansion with a text field focused`)
      check(await frame.evaluate(f => Math.round(f.getBoundingClientRect().height)) <= 140, `${label}: the figure returns to its place in the stage`)
      // Again, with the focus on a button of the page: Escape is forwarded and closes it.
      await chip.click()
      await page.waitForTimeout(250)
      await inside.locator('#count').click()
      await page.keyboard.press('Escape')
      await page.waitForTimeout(250)
      check(!(await page.evaluate(() => document.body.classList.contains('share-embed-expanded'))), `${label}: Escape closes the expansion (focus on a button of the page)`)
      check(await inside.evaluate(() => document.getElementById('text').value) === 'live', `${label}: the page's typed state survived both returns`)
    } catch (error) { failures.push(`${label}: stopped by ${String(error.message).split('\n')[0]}`) }
    await context.close()
  }
} finally {
  await browser?.close()
  remoteServer.close()
  onlineServer.close()
  await rm(scratch, { recursive: true, force: true })
}
if (failures.length) {
  console.error(`FAIL ${failures.length} embed expansion check(s):\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('PASS every non-video HTML figure expands to the whole viewport, keeps its state and sandbox, and closes cleanly (online and file, phone and desktop)')
