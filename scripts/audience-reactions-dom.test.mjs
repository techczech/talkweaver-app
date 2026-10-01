// The reaction bar on the real published audience page (buildShareHtml with its follow runtime),
// in headless Chromium at 360x740 (phone layout) and 1440x900 and 1280x800 (laptop layout), against
// a fake live socket that records what the page sends and answers reaction.ack. Seams: the page DOM
// only; the state machine and the offline queue have their own unit test (audience-reactions.test.mjs).
// Usage: node scripts/audience-reactions-dom.test.mjs
//   SHOTS=<dir> saves the drawn states (following, first use, icons after, Puzzled + Bookmark) at
//   360x740 and 1440x900.
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

// The talk is compiled with the real compiler, so the canvas, its fit and its styles are the real ones.
const FIXTURE = `---
title: The current state of AI agents
auto_title_slide: false
auto_thanks_slide: false
---

### What makes an agent useful? {id=slide-a}

- A chat can tell me how to fill in an expenses form.
- An agent can find the form and fill it in.

### The evolution of agents {id=slide-b}

- AI as oracle
- AI as tool maker
- AI as tool user

### Where this leaves us {id=slide-c}

- Agents work with your files and software to complete a task.
`
const sourceDir = await mkdtemp(join(tmpdir(), 'talkweaver-reaction-src-'))
const sourcePath = join(sourceDir, 'reaction-bar.md')
await writeFile(sourcePath, FIXTURE)
const model = await prepareSource(sourcePath, FIXTURE, 'The current state of AI agents', statSync(sourcePath))
await rm(sourceDir, { recursive: true, force: true })
const slides = extractSlides(model.fullHtml)
const styles = extractStyles(model.fullHtml)
const build = (extra = {}) => buildShareHtml({
  title: 'Reaction bar browser test', slug: 'reaction-bar-test', liveTalkSlug: 'reaction-bar-test',
  workerBaseUrl: 'https://live.example.test', includeNotes: false, license: null, styles, slides, ...extra,
})

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-reaction-bar-'))
const htmlPath = join(scratch, 'handout.html')
const venuePath = join(scratch, 'venue.html')
await writeFile(htmlPath, build())
await writeFile(venuePath, build({ venue: true, venueQr: '<svg></svg>', venueUrl: 'https://example.test/x' }))
const shots = process.env.SHOTS
if (shots) await mkdir(shots, { recursive: true })

const failures = []
const check = (ok, label) => { if (!ok) failures.push(label) }

const initScript = () => {
  window.__sockets = []
  window.__sent = []
  window.__offline = false
  window.__ackError = null
  window.__autoAck = true
  window.__capabilities = { protocol: 2, build: '14-reactions-questions' }
  window.fetch = async (url) => {
    const path = String(url)
    if (path.includes('/capabilities')) return { ok: true, status: 200, json: async () => window.__capabilities }
    if (/\/sessions\/[^/]+\/status/.test(path)) return { ok: true, status: 200, json: async () => ({ status: 'live' }) }
    return { ok: true, status: 200, json: async () => ({ live: true, sessionId: 'session-1' }) }
  }
  window.WebSocket = class FakeWebSocket {
    static OPEN = 1
    readyState = 0
    constructor(url) {
      this.url = url
      window.__sockets.push(this)
      queueMicrotask(() => {
        if (window.__offline) { this.readyState = 3; this.onclose?.(); return }
        this.readyState = 1
        this.onopen?.()
        this.emit({ type: 'session.hello', protocol: 2, expiresAt: Date.now() + 600000 })
      })
    }
    send(raw) {
      const message = JSON.parse(raw)
      if (message.type === 'session.sync') queueMicrotask(() => this.emit({
        type: 'session.snapshot', protocol: 2, sessionId: 'session-1', syncId: message.syncId,
        expiresAt: Date.now() + 600000, slideState: null, polls: [], receipts: [],
      }))
      if (message.type === 'session.ping') this.emit({ type: 'session.pong', nonce: message.nonce })
      if (message.type === 'reaction.send') {
        window.__sent.push(message)
        if (window.__autoAck) setTimeout(() => this.emit({ type: 'reaction.ack', submissionId: message.submissionId,
          status: window.__ackError ? 'rejected' : 'confirmed', ...(window.__ackError ? { error: window.__ackError } : {}) }), 20)
      }
    }
    close() { this.readyState = 3 }
    emit(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
  }
}

async function open(browser, size, path = htmlPath, hash = '#slide-a') {
  const context = await browser.newContext({ viewport: { width: size[0], height: size[1] }, hasTouch: size[0] < 700 })
  const page = await context.newPage()
  page.errors = []
  page.on('pageerror', (error) => page.errors.push(error.message))
  await page.addInitScript(initScript)
  await page.goto(pathToFileURL(path).href + hash)
  await page.waitForFunction(() => window.__sockets.length >= 1)
  return { page, context }
}
const live = (page, slideId, revision) => page.evaluate(([id, rev]) => window.__sockets.at(-1).emit({ type: 'slide.state', slideId: id, reveal: 0, focus: null, revision: rev }), [slideId, revision])
const bar = (page) => page.evaluate(() => {
  const dock = document.getElementById('rxDock')
  const shown = !!dock && !dock.hidden && dock.getClientRects().length > 0
  const buttons = shown ? [...dock.querySelectorAll('.rx, .rx-ask')] : []
  const clipped = (el) => !!el && getComputedStyle(el).clip === 'rect(0px, 0px, 0px, 0px)'
  return {
    shown,
    mode: shown ? (dock.querySelector('.rx-bar').classList.contains('icons') ? 'icons' : 'words') : null,
    pressed: buttons.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.rx),
    names: buttons.map((b) => b.getAttribute('aria-label')),
    visibleWords: buttons.filter((b) => b.classList.contains('rx') && !clipped(b.querySelector('.rx-w'))).map((b) => b.querySelector('.rx-w').textContent),
    note: dock?.querySelector('.rx-note')?.textContent || '',
    sizes: buttons.map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] }),
    tops: buttons.map((b) => Math.round(b.getBoundingClientRect().top)),
    scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
  }
})
const sent = (page) => page.evaluate(() => window.__sent.map((m) => [m.reaction, m.slideId, m.withdrawn === true]))
const settle = (page, ms = 120) => page.waitForTimeout(ms)
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, name) }) }

const browser = await chromium.launch({ headless: true })
try {
  // ── Phone, 360x740 ───────────────────────────────────────────────────────────────────────
  {
    const { page, context } = await open(browser, [360, 740])
    await settle(page)
    check((await bar(page)).shown === true, 'phone: following live shows the bar under the slide')
    await live(page, 'slide-a', 1); await settle(page)
    let b = await bar(page)
    check(b.shown && b.names.join('|') === 'Puzzled by this|Helped me understand|Bookmark: I need to return to this|Ask the speaker a question', `phone: standard set and Ask, named (${b.names})`)
    check(b.mode === 'words' && b.visibleWords.length === 3, `phone: first use shows words (${b.mode} ${b.visibleWords})`)
    check(b.sizes.every(([w, h]) => w >= 44 && h >= 44), `phone: every target at least 44px (${JSON.stringify(b.sizes)})`)
    check(b.scrollW <= b.innerW, `phone: no horizontal scroll (${b.scrollW} > ${b.innerW})`)
    check(await page.evaluate(() => document.querySelector('.rx-ask').getAttribute('aria-disabled') === null), 'phone: Ask is a live control (the question box has its own tests, audience-ask-dom.test.mjs)')
    await page.click('.rx-ask'); await settle(page)
    check(await page.evaluate(() => Boolean(document.querySelector('.ask-panel'))) && (await sent(page)).length === 0, 'phone: Ask opens the question box and sends nothing by itself')
    await page.keyboard.press('Escape'); await settle(page)
    const dockBox = await page.evaluate(() => { const d = document.getElementById('rxDock').getBoundingClientRect(); const s = document.getElementById('stageFit').getBoundingClientRect(); const t = document.getElementById('phoneScript').getBoundingClientRect(); return { dockTop: d.top, stageBottom: s.bottom, dockBottom: d.bottom, scriptTop: t.top } })
    check(Math.abs(dockBox.dockTop - dockBox.stageBottom) <= 1 && dockBox.dockBottom <= dockBox.scriptTop + 1, `phone: docked between the slide and its text (${JSON.stringify(dockBox)})`)
    await shot(page, 'phone-360x740-following-first-use.png')

    await page.click('.rx[data-rx="puzzled"]'); await settle(page, 200)
    b = await bar(page)
    check(JSON.stringify(await sent(page)) === JSON.stringify([['puzzled', 'slide-a', false]]), `phone: a tap sends one reaction (${JSON.stringify(await sent(page))})`)
    check(b.pressed.join() === 'puzzled' && b.note === 'Sent to the speaker. Only they see it.', `phone: selected with the note (${b.pressed} / ${b.note})`)
    check(b.mode === 'words', 'phone: the words stay on the slide of the first tap')

    await live(page, 'slide-b', 2); await settle(page)
    b = await bar(page)
    check(b.mode === 'icons' && b.visibleWords.length === 0 && b.pressed.length === 0 && b.note === '', `phone: icons after, a fresh slide is unselected (${b.mode} ${b.pressed})`)
    check(b.names.slice(0, 3).join('|') === 'Puzzled by this|Helped me understand|Bookmark: I need to return to this', 'phone: icons keep their accessible names')
    check(b.sizes.every(([w, h]) => w >= 44 && h >= 44), `phone: icon targets at least 44px (${JSON.stringify(b.sizes)})`)
    await shot(page, 'phone-360x740-icons-after.png')
    await page.click('.rx[data-rx="helped"]'); await settle(page, 200)
    b = await bar(page)
    check(b.pressed.join() === 'helped' && /Helped me understand · sent to the speaker/.test(b.note), `phone: icon tap names the reaction in the note (${b.note})`)
    await page.click('.rx[data-rx="puzzled"]'); await settle(page, 200)
    b = await bar(page)
    check(b.pressed.join() === 'puzzled' && /^Changed to Puzzled by this/.test(b.note), `phone: tapping another moves the selection (${b.pressed} / ${b.note})`)
    await page.click('.rx[data-rx="puzzled"]'); await settle(page, 200)
    b = await bar(page)
    check(b.pressed.length === 0 && /^Reaction taken back/.test(b.note), `phone: tapping the selected one undoes it (${b.pressed} / ${b.note})`)
    check(JSON.stringify(await sent(page)) === JSON.stringify([['puzzled', 'slide-a', false], ['helped', 'slide-b', false], ['puzzled', 'slide-b', false], ['puzzled', 'slide-b', true]]),
      `phone: select, replace (one message), undo (withdrawn) (${JSON.stringify(await sent(page))})`)
    await page.click('.rx[data-rx="puzzled"]'); await settle(page, 200)
    await page.click('.rx[data-rx="bookmark"]'); await settle(page, 200)
    b = await bar(page)
    check(b.pressed.join() === 'puzzled,bookmark' && b.note === 'Sent to the speaker. Bookmark saved on this phone.', `phone: bookmark is independent of the meaning reaction (${b.pressed} / ${b.note})`)
    await shot(page, 'phone-360x740-puzzled-and-bookmark.png')
    await live(page, 'slide-a', 3); await settle(page)
    b = await bar(page)
    check(b.pressed.join() === 'puzzled', `phone: back on the first slide its own reaction is still held (${b.pressed})`)

    // Not following: the bar goes, and returns on Return to presenter.
    await page.click('#nextBtn'); await settle(page)
    b = await bar(page)
    check(b.shown === false && await page.locator('#returnToPresenterBtn').isVisible(), 'phone: hidden once the person moves on their own')
    await page.click('#returnToPresenterBtn'); await settle(page)
    check((await bar(page)).shown === true, 'phone: back on Return to presenter')
    await page.click('#followLiveBtn'); await settle(page)
    check((await bar(page)).shown === false, 'phone: hidden after Stop following')
    await page.click('#followLiveBtn'); await settle(page)
    check((await bar(page)).shown === true, 'phone: back on Follow live')
    check(page.errors.length === 0, `phone: no page errors (${page.errors.join('; ')})`)
    await context.close()
  }

  // ── Phone: a refused reaction is shown and not kept; offline queues and sends once ───────────
  {
    const { page, context } = await open(browser, [360, 740])
    await live(page, 'slide-a', 1); await settle(page)
    await page.evaluate(() => { window.__ackError = 'reactions_paused' })
    await page.click('.rx[data-rx="puzzled"]'); await settle(page, 250)
    let b = await bar(page)
    check(b.pressed.length === 0 && b.note === 'The speaker has paused reactions', `phone: a paused refusal is shown and the mark is not kept (${b.pressed} / ${b.note})`)
    await page.evaluate(() => { window.__ackError = 'participant_limit_reached' })
    await page.click('.rx[data-rx="helped"]'); await settle(page, 250)
    b = await bar(page)
    check(b.pressed.length === 0 && /^Could not send/.test(b.note), `phone: a limit refusal is shown plainly (${b.note})`)
    const count = (await sent(page)).length
    await settle(page, 700)
    check((await sent(page)).length === count, 'phone: a refusal is not retried')
    await page.evaluate(() => { window.__ackError = null })

    await page.evaluate(() => { window.__offline = true; window.__sockets.at(-1).readyState = 3; window.__sockets.at(-1).onclose?.() })
    await settle(page, 100)
    await page.click('.rx[data-rx="helped"]'); await settle(page)
    b = await bar(page)
    check(b.pressed.join() === 'helped' && b.note === 'Will send when your phone reconnects', `phone: an offline tap is kept and says so (${b.pressed} / ${b.note})`)
    const before = (await sent(page)).length
    await page.click('.rx[data-rx="bookmark"]'); await settle(page)
    check((await sent(page)).length === before, 'phone: nothing is sent while offline')
    await page.evaluate(() => { window.__offline = false })
    await page.waitForFunction((n) => window.__sent.length >= n + 2, before, { timeout: 15000 })
    await settle(page, 300)
    const after = await page.evaluate(() => window.__sent.map((m) => [m.reaction, m.withdrawn === true, m.submissionId]))
    const tail = after.slice(before)
    check(tail.length === 2 && tail[0][0] === 'helped' && tail[1][0] === 'bookmark' && new Set(after.map((m) => m[2])).size === after.length,
      `phone: on reconnect the queue sends once, in order (${JSON.stringify(tail)})`)
    b = await bar(page)
    check(b.pressed.join() === 'helped,bookmark' && !/Will send/.test(b.note), `phone: the note clears when it has sent (${b.note})`)
    await context.close()
  }

  // ── An old worker: no bar. A refused first tap leaves the bookmark tapped after it alone ──────
  {
    const context = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true })
    const page = await context.newPage()
    await page.addInitScript(initScript)
    await page.addInitScript(() => { window.__capabilities = { protocol: 2, build: '13-instant-images' } })
    await page.goto(pathToFileURL(htmlPath).href + '#slide-a')
    await page.waitForFunction(() => window.__sockets.length >= 1)
    await live(page, 'slide-a', 1); await settle(page, 400)
    check((await bar(page)).shown === false && await page.evaluate(() => !document.body.classList.contains('has-rx-bar')), 'old worker: the bar does not show against a worker build older than reactions')
    await context.close()
  }
  {
    const { page, context } = await open(browser, [360, 740])
    await live(page, 'slide-a', 1); await settle(page)
    await page.evaluate(() => { window.__autoAck = false })
    await page.click('.rx[data-rx="puzzled"]'); await page.click('.rx[data-rx="bookmark"]'); await settle(page, 200)
    check((await bar(page)).pressed.join() === 'puzzled,bookmark', 'refusal: both taps show at once')
    await page.evaluate(() => { const first = window.__sent[0]; window.__sockets.at(-1).emit({ type: 'reaction.ack', submissionId: first.submissionId, status: 'rejected', error: 'reactions_paused' }) })
    await settle(page, 200)
    check((await bar(page)).pressed.join() === 'bookmark', `refusal: the refused Puzzled is put back, the later Bookmark stays (${(await bar(page)).pressed})`)
    await context.close()
  }

  // ── Laptop, 1440x900 and 1280x800 ────────────────────────────────────────────────────────
  for (const size of [[1440, 900], [1280, 800]]) {
    const label = `laptop ${size.join('x')}`
    const { page, context } = await open(browser, size)
    await live(page, 'slide-a', 1); await settle(page, 300)
    let b = await bar(page)
    const geometry = () => page.evaluate(() => {
      const wrap = document.querySelector('.rx-wrap').getBoundingClientRect()
      const stage = document.getElementById('stage').getBoundingClientRect()
      const buttons = [...document.querySelectorAll('.rx, .rx-ask')].map((e) => e.getBoundingClientRect())
      const barEl = document.querySelector('.rx-bar').getBoundingClientRect()
      return { wrapW: Math.round(wrap.width), stageW: Math.round(stage.width), stageBottom: Math.round(stage.bottom), wrapTop: Math.round(wrap.top), barH: Math.round(barEl.height), rowTops: [...new Set(buttons.map((r) => Math.round(r.top)))], rightmost: Math.round(Math.max(...buttons.map((r) => r.right)) - stage.left), footerTop: Math.round(document.querySelector('.share-footer').getBoundingClientRect().top), dockBottom: Math.round(document.getElementById('rxDock').getBoundingClientRect().bottom) }
    })
    let g = await geometry()
    check(b.shown && b.mode === 'words', `${label}: shows the bar with words on first use`)
    check(g.rowTops.length === 1, `${label}: one row (${g.rowTops})`)
    check(Math.abs(g.wrapW - g.stageW) <= 1 && g.rightmost <= g.stageW, `${label}: no wider than the slide canvas (bar ${g.wrapW}, canvas ${g.stageW}, content ends ${g.rightmost})`)
    check(b.sizes.every(([w, h]) => w >= 32 && h >= 32), `${label}: every target at least 32px (${JSON.stringify(b.sizes)})`)
    check(b.scrollW <= b.innerW, `${label}: no horizontal scroll`)
    check(g.dockBottom <= g.footerTop + 1 && g.stageBottom <= g.wrapTop + 2 + 40, `${label}: the slide refits above the bar (canvas bottom ${g.stageBottom}, bar top ${g.wrapTop})`)
    await shot(page, `laptop-${size.join('x')}-following-first-use.png`)

    // Keyboard: Tab reaches the bar; Enter and Space tap and never reach the deck keys.
    await page.evaluate(() => document.querySelector('#overviewBtn').blur())
    await page.keyboard.press('Tab')
    const first = await page.evaluate(() => document.activeElement?.getAttribute('data-rx') || document.activeElement?.id || document.activeElement?.className)
    check(first === 'puzzled', `${label}: one Tab reaches the bar (${first})`)
    await page.keyboard.press('Enter'); await settle(page, 200)
    b = await bar(page)
    check(b.pressed.join() === 'puzzled' && await page.locator('.slide.active').getAttribute('data-id') === 'slide-a', `${label}: Enter taps and the slide stays (${b.pressed})`)
    check(await page.locator('#returnToPresenterBtn').isHidden(), `${label}: Enter does not stop following`)
    await page.keyboard.press('Space'); await settle(page, 200)
    b = await bar(page)
    check(b.pressed.length === 0 && await page.locator('.slide.active').getAttribute('data-id') === 'slide-a', `${label}: Space undoes and the slide stays (${b.pressed})`)
    check(JSON.stringify(await sent(page)) === JSON.stringify([['puzzled', 'slide-a', false], ['puzzled', 'slide-a', true]]), `${label}: tap then undo sent (${JSON.stringify(await sent(page))})`)
    check((await bar(page)).note === 'Taken back', `${label}: laptop note (${(await bar(page)).note})`)
    await page.keyboard.press('Tab'); await page.keyboard.press('Enter'); await settle(page, 200)
    b = await bar(page)
    check(b.pressed.join() === 'helped', `${label}: Tab moves through the bar (${b.pressed})`)
    await page.keyboard.press('Tab'); await page.keyboard.press('Enter'); await settle(page, 200)
    b = await bar(page)
    check(b.pressed.join() === 'helped,bookmark' && b.note === 'Sent to the speaker. Bookmark saved on this device.', `${label}: bookmark from the keyboard, independent (${b.pressed} / ${b.note})`)

    await live(page, 'slide-b', 2); await settle(page, 300)
    b = await bar(page); g = await geometry()
    check(b.mode === 'icons' && b.visibleWords.length === 0, `${label}: icons after`)
    check(b.sizes.every(([w, h]) => w >= 32 && h >= 32), `${label}: icon targets at least 32px (${JSON.stringify(b.sizes)})`)
    check(g.rowTops.length === 1 && Math.abs(g.wrapW - g.stageW) <= 1, `${label}: icons in one row at the canvas width`)
    await page.hover('.rx[data-rx="puzzled"]')
    const tip = await page.evaluate(() => { const t = document.querySelector('.rx[data-rx="puzzled"] .rx-tip'); return { text: t.textContent, shown: getComputedStyle(t).display !== 'none' } })
    check(tip.shown && tip.text === 'Puzzled by this', `${label}: an icon has its tooltip on hover (${JSON.stringify(tip)})`)
    await shot(page, `laptop-${size.join('x')}-icons-after.png`)
    await page.click('.rx[data-rx="puzzled"]'); await page.click('.rx[data-rx="bookmark"]'); await settle(page, 250)
    await page.mouse.move(5, 5)
    await shot(page, `laptop-${size.join('x')}-puzzled-and-bookmark.png`)
    await page.click('#nextBtn'); await settle(page, 300)
    check((await bar(page)).shown === false, `${label}: hidden when not following`)
    check(page.errors.length === 0, `${label}: no page errors (${page.errors.join('; ')})`)
    await context.close()
  }

  // ── The bar's marks are kept on the device, per talk and slide, beside My Notes' key ─────────
  {
    const { page, context } = await open(browser, [1440, 900])
    await live(page, 'slide-b', 1); await settle(page)
    await page.click('.rx[data-rx="helped"]'); await settle(page, 200)
    const stored = await page.evaluate(() => ({ keys: Object.keys(localStorage).filter((k) => k.startsWith('html-presentations:')), value: JSON.parse(localStorage.getItem('html-presentations:reactions:reaction-bar-test') || 'null') }))
    check(stored.keys.includes('html-presentations:reactions:reaction-bar-test'), `storage: a key beside My Notes' (${stored.keys})`)
    check(stored.value?.used === true && stored.value.runs?.['session-1']?.['slide-b']?.r === 'helped', `storage: kept per talk, run and slide (${JSON.stringify(stored.value)})`)
    await context.close()
  }

  // ── Nothing on the venue screen ──────────────────────────────────────────────────────────
  {
    const venueHtml = build({ venue: true, venueQr: '<svg></svg>', venueUrl: 'https://example.test/x' })
    check(!venueHtml.includes('id="rxDock"') && !venueHtml.includes('.rx-dock{'), 'venue: no dock element and no bar styles')
    const { page, context } = await open(browser, [1440, 900], venuePath, '')
    await live(page, 'slide-a', 1); await settle(page, 300)
    check(await page.evaluate(() => !document.getElementById('rxDock') && !document.querySelector('.rx, .rx-ask, .rx-bar, .has-rx-bar')), 'venue: nothing about reactions on the venue screen')
    check((await sent(page)).length === 0, 'venue: nothing is sent')
    await context.close()
  }
} finally {
  await browser.close()
  await rm(scratch, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`audience reactions DOM: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`)
  process.exit(1)
}
console.log('audience reactions DOM: phone 360x740 and laptop 1440x900 and 1280x800 — bar while following, words then icons, tap / replace / undo / independent bookmark, refusals shown, offline queue sends once in order, keyboard Enter and Space, hidden when not following, marks kept beside My Notes, none on the venue screen')
