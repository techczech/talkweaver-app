// Ask the speaker on the real published audience page (buildShareHtml with its follow runtime), in
// headless Chromium at 360x740 (a sheet over the phone page) and 1440x900 (a centred dialog), against
// a fake live socket that records what the page sends and answers question.ack. Seams: the page DOM
// (the box, its states, its keys, the name kept on the device, question text as text) and the
// visualViewport inset. The client's queue rules have their own unit test (audience-ask.test.mjs);
// the whole path to a presenter is test-ask-live.mjs.
// Usage: node scripts/audience-ask-dom.test.mjs
//   SHOTS=<dir> saves the drawn states: phone Q1 (compose), Q2 (name remembered), Q3 (sent), Q4
//   (offline), Q5 (failed), Q6 (keyboard open, simulated) and laptop B6, B7, B8.
import { statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

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
const sourceDir = await mkdtemp(join(tmpdir(), 'talkweaver-ask-src-'))
const sourcePath = join(sourceDir, 'ask.md')
await writeFile(sourcePath, FIXTURE)
const model = await prepareSource(sourcePath, FIXTURE, 'The current state of AI agents', statSync(sourcePath))
await rm(sourceDir, { recursive: true, force: true })
const slides = extractSlides(model.fullHtml)
const styles = extractStyles(model.fullHtml)
const build = (extra = {}) => buildShareHtml({
  title: 'Ask browser test', slug: 'ask-test', liveTalkSlug: 'ask-test',
  workerBaseUrl: 'https://live.example.test', includeNotes: false, license: null, styles, slides, ...extra,
})
const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-ask-'))
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
      if (message.type === 'question.submit') {
        window.__sent.push(message)
        setTimeout(() => this.emit({ type: 'question.ack', submissionId: message.submissionId,
          status: window.__ackError ? 'rejected' : 'confirmed', ...(window.__ackError ? { error: window.__ackError } : {}) }), 20)
      }
    }
    close() { this.readyState = 3 }
    emit(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
  }
}
// A visual viewport the test can shrink, as a phone keyboard does.
const viewportScript = () => {
  const target = new EventTarget()
  const viewport = Object.assign(target, { height: window.innerHeight, offsetTop: 0, width: window.innerWidth })
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
  window.__keyboard = (px) => { viewport.height = window.innerHeight - px; viewport.dispatchEvent(new Event('resize')) }
}

async function open(browser, size, path = htmlPath, hash = '#slide-a') {
  const context = await browser.newContext({ viewport: { width: size[0], height: size[1] }, hasTouch: size[0] < 700 })
  const page = await context.newPage()
  page.errors = []
  page.on('pageerror', (error) => page.errors.push(error.message))
  await page.addInitScript(initScript)
  await page.addInitScript(viewportScript)
  await page.goto(pathToFileURL(path).href + hash)
  await page.waitForFunction(() => window.__sockets.length >= 1)
  return { page, context }
}
const live = (page, slideId, revision) => page.evaluate(([id, rev]) => window.__sockets.at(-1).emit({ type: 'slide.state', slideId: id, reveal: 0, focus: null, revision: rev }), [slideId, revision])
const sent = (page) => page.evaluate(() => window.__sent.map((m) => ({ text: m.text, name: m.name ?? null, slideId: m.slideId, tMs: m.tMs, id: m.submissionId })))
const settle = (page, ms = 120) => page.waitForTimeout(ms)
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, name) }) }
const panelState = (page) => page.evaluate(() => {
  const panel = document.querySelector('.ask-panel')
  if (!panel) return null
  const r = panel.getBoundingClientRect()
  const send = panel.querySelector('[data-act="send"]')
  const q = (sel) => panel.querySelector(sel)
  return {
    state: panel.getAttribute('data-state'),
    rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height },
    heading: q('.ask-head h2')?.textContent,
    about: q('.ask-about')?.textContent || '',
    text: q('.ask-text')?.value ?? null,
    name: q('.ask-name')?.value ?? null,
    private: q('.ask-private')?.textContent || '',
    remembered: q('.ask-remembered')?.textContent || '',
    banner: q('.ask-banner')?.textContent || '',
    quote: q('.ask-quote')?.textContent ?? null,
    meta: q('.ask-meta')?.textContent ?? null,
    sentMark: q('.ask-sent-mark')?.textContent || '',
    buttons: [...panel.querySelectorAll('.ask-foot button')].map((b) => ({ label: b.textContent.trim(), disabled: b.disabled })),
    sendRect: send ? (({ bottom, top, height }) => ({ bottom, top, height }))(send.getBoundingClientRect()) : null,
    focus: document.activeElement === q('.ask-text') ? 'text' : document.activeElement?.getAttribute?.('data-act') || document.activeElement?.tagName,
    inset: getComputedStyle(panel).getPropertyValue('--kb').trim(),
    imgs: panel.querySelectorAll('img').length,
    scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
    minTarget: Math.min(...[...panel.querySelectorAll('button, input, textarea')].map((n) => { const b = n.getBoundingClientRect(); return Math.min(b.width, b.height) })),
    hint: q('.ask-hint')?.textContent || '',
  }
})
const closed = (page) => page.evaluate(() => !document.querySelector('.ask-panel'))
const activeSlide = (page) => page.evaluate(() => document.querySelector('.slide.active')?.dataset.id)
const bar = (page) => page.evaluate(() => ({ shown: !!document.getElementById('rxDock') && !document.getElementById('rxDock').hidden, note: document.querySelector('.rx-note')?.textContent || '' }))

const browser = await chromium.launch({ headless: true })
try {
  // ── Phone, 360x740: a sheet ──────────────────────────────────────────────────────────────
  {
    const { page, context } = await open(browser, [360, 740])
    await live(page, 'slide-a', 1); await settle(page)
    check((await bar(page)).shown, 'phone: the bar is up (Ask is on it)')
    check(await closed(page), 'phone: the box is closed until asked for')
    await page.click('.rx-ask'); await settle(page)
    let p = await panelState(page)
    check(p && p.state === 'compose', 'phone: Ask opens the box')
    check(p && Math.abs(p.rect.bottom - 740) <= 1 && p.rect.width >= 359 && p.rect.top > 200, `phone: a sheet at the foot of the screen (${JSON.stringify(p?.rect)})`)
    check(p && p.heading === 'Ask the speaker' && /Slide 1/.test(p.about) && /What makes an agent useful\?/.test(p.about), `phone: headed with its slide (${p?.about})`)
    check(p && /Only the speaker sees this/.test(p.private), 'phone: says only the speaker sees it')
    check(p && p.focus === 'text', `phone: focus goes to the field (${p?.focus})`)
    check(p && p.buttons.length === 1 && p.buttons[0].label === 'Send' && p.buttons[0].disabled, 'phone: Send waits for some text')
    check(p && p.minTarget >= 44 && p.scrollW <= p.innerW, `phone: every control at least 44px, no horizontal scroll (${p?.minTarget}, ${p?.scrollW}>${p?.innerW})`)
    check(await page.evaluate(() => getComputedStyle(document.querySelector('.ask-hint')).display === 'none'), 'phone: no keyboard hint on a phone')
    await shot(page, 'Q1-ask-compose-360x740.png')

    await page.fill('.ask-text', 'Why did the agent ask for my password?')
    await page.fill('.ask-name', '  Priya  ')
    p = await panelState(page)
    check(p.buttons[0].disabled === false, 'phone: Send is on once there is text')
    check(await page.evaluate(() => localStorage.getItem('talkweaver:live-name')) === 'Priya', 'phone: the name is kept on the device under the existing key')
    check(await page.evaluate(() => document.getElementById('liveName').value) === 'Priya', 'phone: the page\'s own name field follows')
    await page.click('[data-act="send"]'); await settle(page, 250)
    const s = await sent(page)
    check(s.length === 1 && s[0].text === 'Why did the agent ask for my password?' && s[0].name === 'Priya' && s[0].slideId === 'slide-a' && Number.isSafeInteger(s[0].tMs), `phone: one question.submit with text, name, slide and time (${JSON.stringify(s)})`)
    p = await panelState(page)
    check(p.state === 'sent' && /Sent to the speaker/.test(p.sentMark) && p.quote === 'Why did the agent ask for my password?' && /from Priya/.test(p.meta), `phone: sent, with the question repeated (${p?.state} ${p?.meta})`)
    check(p.buttons.map((b) => b.label).join('|') === 'Ask another|Done' && p.focus === 'another', `phone: Ask another and Done, focus on Ask another (${p?.focus})`)
    await shot(page, 'Q3-ask-sent-360x740.png')
    await page.click('[data-act="another"]'); await settle(page)
    p = await panelState(page)
    check(p.state === 'compose' && p.text === '' && p.name === 'Priya' && /Remembered on this phone/.test(p.remembered), `phone: Ask another is empty with the name remembered (${p?.name} / ${p?.remembered})`)
    await shot(page, 'Q2-ask-name-remembered-360x740.png')
    await page.keyboard.press('Escape'); await settle(page)
    check(await closed(page), 'phone: Escape closes the sheet')

    // The name survives a reload of the page.
    await page.reload(); await page.waitForFunction(() => window.__sockets.length >= 1); await live(page, 'slide-a', 1); await settle(page)
    await page.click('.rx-ask'); await settle(page)
    p = await panelState(page)
    check(p.name === 'Priya' && /Remembered on this phone/.test(p.remembered), `phone: the name is still there after a reload (${p?.name})`)
    await page.keyboard.press('Escape')

    // The keyboard: the sheet sits above it and Send stays in view.
    await page.click('.rx-ask'); await settle(page)
    await page.fill('.ask-text', 'A long question '.repeat(20))
    await page.evaluate(() => window.__keyboard(290)); await settle(page, 200)
    p = await panelState(page)
    check(p.inset === '290px' && Math.abs(p.rect.bottom - 450) <= 1 && p.sendRect.bottom <= 451 && p.sendRect.top >= 0, `phone: with a 290px keyboard the sheet sits above it and Send stays in view (${p?.inset} ${JSON.stringify(p?.rect)} ${JSON.stringify(p?.sendRect)})`)
    await page.evaluate(() => { const k = document.createElement('div'); k.id = 'kbsim'; k.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:290px;background:#d4d7dc;z-index:200;font:12px system-ui;color:#555;padding:8px'; k.textContent = 'Phone keyboard, simulated 290px'; document.body.appendChild(k) })
    await shot(page, 'Q6-ask-keyboard-open-360x740.png')
    await page.evaluate(() => { document.getElementById('kbsim').remove(); window.__keyboard(0) }); await settle(page, 200)
    p = await panelState(page)
    check(p.inset === '0px' && Math.abs(p.rect.bottom - 740) <= 1, `phone: the sheet drops back when the keyboard goes (${p?.inset})`)
    await page.keyboard.press('Escape')
    check(page.errors.length === 0, `phone: no page errors (${page.errors.join('; ')})`)
    await context.close()
  }

  // ── Phone: offline queues, a refusal keeps the text, a pause is not resent ───────────────
  {
    const { page, context } = await open(browser, [360, 740])
    await live(page, 'slide-a', 1); await settle(page)
    await page.evaluate(() => { window.__offline = true; window.__sockets.at(-1).readyState = 3; window.__sockets.at(-1).onclose?.() })
    await settle(page, 100)
    await page.click('.rx-ask'); await settle(page)
    await page.fill('.ask-text', 'Sent from a lift')
    await page.click('[data-act="send"]'); await settle(page)
    let p = await panelState(page)
    check(p.state === 'offline' && /Not sent yet/.test(p.banner) && p.buttons.some((b) => /Waiting to send/.test(b.label) && b.disabled), `phone: offline says Not sent yet and waits (${p?.state} / ${p?.banner})`)
    check((await sent(page)).length === 0, 'phone: nothing is sent while offline')
    check(p.text === 'Sent from a lift', 'phone: the text is kept while it waits')
    await shot(page, 'Q4-ask-offline-360x740.png')
    await page.evaluate(() => { window.__offline = false })
    await page.waitForFunction(() => window.__sent.length >= 1, null, { timeout: 15000 })
    await settle(page, 300)
    p = await panelState(page)
    check(p.state === 'sent' && (await sent(page)).length === 1, `phone: on reconnect it sends once and the box says sent (${p?.state})`)
    await page.click('[data-act="done"]'); await settle(page)
    check(await closed(page), 'phone: Done closes')

    // Offline, closed at once, sent later: the bar says so.
    await page.evaluate(() => { window.__offline = true; window.__sockets.at(-1).readyState = 3; window.__sockets.at(-1).onclose?.() })
    await settle(page, 100)
    await page.click('.rx-ask'); await settle(page)
    await page.fill('.ask-text', 'Closed before it left')
    await page.click('[data-act="send"]'); await settle(page)
    await page.click('.ask-x'); await settle(page)
    check(await closed(page), 'phone: an offline question can be closed')
    await page.evaluate(() => { window.__offline = false })
    await page.waitForFunction(() => window.__sent.length >= 2, null, { timeout: 15000 })
    await settle(page, 300)
    check(/Question sent to the speaker/.test((await bar(page)).note), `phone: the bar says it went when the box is closed (${(await bar(page)).note})`)

    // A limit refusal: shown plainly, text kept, no Try again.
    await page.evaluate(() => { window.__ackError = 'participant_limit_reached' })
    await page.click('.rx-ask'); await settle(page)
    await page.fill('.ask-text', 'One too many')
    await page.click('[data-act="send"]'); await settle(page, 250)
    p = await panelState(page)
    check(p.state === 'failed' && /Could not send/.test(p.banner) && /most questions allowed/.test(p.banner), `phone: a limit refusal is shown plainly (${p?.banner})`)
    check(p.text === 'One too many' && !p.buttons.some((b) => /Try again/.test(b.label)), `phone: the text is kept and Try again is not offered for a limit (${p?.text} / ${JSON.stringify(p?.buttons)})`)
    await shot(page, 'Q5-ask-failed-360x740.png')
    const n = (await sent(page)).length
    await settle(page, 800)
    check((await sent(page)).length === n, 'phone: a refusal is not retried')

    // Reopening shows the failed question with its text; a limit leaves nothing to send.
    await page.keyboard.press('Escape')
    await page.click('.rx-ask'); await settle(page)
    p = await panelState(page)
    check(p.state === 'failed' && p.text === 'One too many', `phone: reopening shows the failed question with its text (${p?.state})`)
    await page.keyboard.press('Escape')

    // A refusal that may pass: Try again sends it again with the text kept.
    await live(page, 'slide-b', 2); await settle(page)
    await page.evaluate(() => { window.__ackError = 'storage_failed' })
    await page.click('.rx-ask'); await settle(page)
    await page.fill('.ask-text', 'Storage hiccup')
    await page.click('[data-act="send"]'); await settle(page, 250)
    p = await panelState(page)
    check(p.state === 'failed' && p.text === 'Storage hiccup' && p.buttons.some((b) => /Try again/.test(b.label)), `phone: a storage failure keeps the text and offers Try again (${p?.state})`)
    await page.evaluate(() => { window.__ackError = null })
    await page.click('[data-act="send"]'); await settle(page, 250)
    p = await panelState(page)
    check(p.state === 'sent', `phone: Try again sends it (${p?.state})`)
    await page.click('[data-act="done"]')

    // A pause refusal stores nothing and is never resent after a reconnect.
    await page.evaluate(() => { window.__ackError = 'questions_paused' })
    await page.click('.rx-ask'); await settle(page)
    await page.fill('.ask-text', 'During the pause')
    await page.click('[data-act="send"]'); await settle(page, 250)
    p = await panelState(page)
    check(p.state === 'failed' && /not taking questions/.test(p.banner) && p.text === 'During the pause', `phone: a paused refusal is shown and the text kept (${p?.banner})`)
    await page.keyboard.press('Escape')
    const beforeReconnect = (await sent(page)).length
    await page.evaluate(() => { window.__ackError = null; window.__sockets.at(-1).readyState = 3; window.__sockets.at(-1).onclose?.() })
    await page.waitForFunction(() => window.__sockets.length >= 3, null, { timeout: 15000 })
    await settle(page, 1500)
    check((await sent(page)).length === beforeReconnect, 'phone: the refused question is not resent after the reconnect')
    check(page.errors.length === 0, `phone: no page errors (${page.errors.join('; ')})`)
    await context.close()
  }

  // ── Laptop, 1440x900 and 1280x800: a centred dialog and its keys ─────────────────────────
  for (const size of [[1440, 900], [1280, 800]]) {
    const label = `laptop ${size[0]}x${size[1]}`
    const { page, context } = await open(browser, size)
    await live(page, 'slide-a', 1); await settle(page)
    await page.click('.rx-ask'); await settle(page)
    let p = await panelState(page)
    const cx = (p.rect.left + p.rect.right) / 2, cy = (p.rect.top + p.rect.bottom) / 2
    check(p && p.rect.width <= 520 && p.rect.width >= 500 && Math.abs(cx - size[0] / 2) <= 1 && Math.abs(cy - size[1] / 2) <= 1, `${label}: a centred dialog at most 520px wide (${JSON.stringify(p?.rect)})`)
    check(/Slide 1/.test(p.about) && p.focus === 'text' && /(⌘ ↵|Ctrl ↵) sends · Esc closes/.test(p.hint), `${label}: headed with its slide, focus in the field, keys stated (${p?.hint})`)
    check(p.minTarget >= 32, `${label}: every control at least 32px (${p?.minTarget})`)
    if (size[0] === 1440) await shot(page, 'B6-ask-compose-1440x900.png')
    // Enter adds a line and does not send.
    await page.fill('.ask-text', 'First line')
    await page.keyboard.press('Enter'); await page.keyboard.type('Second line'); await settle(page)
    check((await sent(page)).length === 0 && (await panelState(page)).text === 'First line\nSecond line', `${label}: Enter adds a line and does not send`)
    // Esc closes and keeps the draft for that slide.
    await page.keyboard.press('Escape'); await settle(page)
    check(await closed(page), `${label}: Esc closes`)
    check(await page.evaluate(() => document.activeElement?.classList.contains('rx-ask')), `${label}: focus returns to Ask`)
    await page.keyboard.press('a'); await settle(page)
    p = await panelState(page)
    check(p && p.text === 'First line\nSecond line', `${label}: A reopens it with the draft kept (${p?.text})`)
    await page.keyboard.press('Escape'); await settle(page)
    // The draft belongs to its slide.
    await live(page, 'slide-b', 2); await settle(page)
    await page.keyboard.press('a'); await settle(page)
    p = await panelState(page)
    check(p && p.text === '' && /Slide 2/.test(p.about), `${label}: another slide starts empty and is headed with its own number (${p?.text} / ${p?.about})`)
    await page.keyboard.press('Escape'); await settle(page)
    await live(page, 'slide-a', 3); await settle(page)
    await page.keyboard.press('a'); await settle(page)
    p = await panelState(page)
    check(p && p.text === 'First line\nSecond line', `${label}: back on the first slide the draft is there`)
    // Keys typed in the box never move the deck.
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('r'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Home'); await page.keyboard.press('End'); await page.keyboard.press('z')
    check(await activeSlide(page) === 'slide-a' && (await sent(page)).length === 0, `${label}: keys pressed in the box do not reach the deck`)
    // Tab stays inside.
    for (let i = 0; i < 8; i++) await page.keyboard.press('Tab')
    check(await page.evaluate(() => !!document.activeElement?.closest('.ask-panel')), `${label}: Tab stays inside the box`)
    // Ctrl+Enter sends.
    await page.click('.ask-text')
    await page.keyboard.press('Control+Enter'); await settle(page, 250)
    let s = await sent(page)
    check(s.length === 1 && s[0].text === 'First line\nSecond line' && s[0].name === null, `${label}: Ctrl+Enter sends (${JSON.stringify(s)})`)
    p = await panelState(page)
    check(p.state === 'sent', `${label}: and the box says sent`)
    if (size[0] === 1440) await shot(page, 'B7-ask-sent-1440x900.png')
    await page.click('[data-act="done"]'); await settle(page)
    await page.keyboard.press('a'); await settle(page)
    await page.fill('.ask-text', 'Via Command')
    await page.keyboard.press('Meta+Enter'); await settle(page, 250)
    s = await sent(page)
    check(s.length === 2 && s[1].text === 'Via Command', `${label}: Cmd+Enter sends`)
    await page.keyboard.press('Escape'); await settle(page)
    check(await closed(page), `${label}: Esc closes the sent box`)

    // A: not with modifiers, not in text fields, not when Ask is not offered.
    await page.keyboard.press('Control+a'); await settle(page)
    check(await closed(page), `${label}: Ctrl+A does not open Ask`)
    await page.keyboard.press('Meta+a'); await page.keyboard.press('Alt+a'); await page.keyboard.press('Shift+a'); await settle(page)
    check(await closed(page), `${label}: Cmd+A, Alt+A and Shift+A do not open Ask`)
    await page.click('#followLiveBtn'); await settle(page)
    check((await bar(page)).shown === false, `${label}: (Stop following hides the bar)`)
    await page.keyboard.press('a'); await settle(page)
    check(await closed(page), `${label}: A does nothing while Ask is not offered (not following)`)
    await page.click('#followLiveBtn'); await settle(page)
    check((await bar(page)).shown === true, `${label}: (following again)`)
    await page.click('#helpBtn'); await settle(page)
    await page.keyboard.press('a'); await settle(page)
    check(await closed(page), `${label}: A does nothing while the shortcuts list is open`)
    const helpHasA = await page.evaluate(() => [...document.querySelectorAll('.help-row')].some((r) => r.querySelector('kbd')?.textContent === 'A' && /Ask the speaker/.test(r.textContent)))
    check(helpHasA, `${label}: the ? list has the A row`)
    await page.keyboard.press('Escape'); await settle(page)
    // In the page's name field, A is typed.
    await page.focus('#liveName'); await page.keyboard.press('a'); await settle(page)
    check(await closed(page) && (await page.evaluate(() => document.getElementById('liveName').value.endsWith('a'))), `${label}: A typed in a text field types and does not open Ask`)
    await page.evaluate(() => document.activeElement.blur())
    // Typing A inside the box does not reopen or break it.
    await page.keyboard.press('a'); await settle(page)
    await page.fill('.ask-text', ''); await page.keyboard.press('a'); await page.keyboard.press('A'); await settle(page)
    check((await panelState(page)).text === 'aA', `${label}: A typed in the box is text`)
    await page.keyboard.press('Escape')
    check(page.errors.length === 0, `${label}: no page errors (${page.errors.join('; ')})`)
    await context.close()
  }

  // ── Laptop: offline dialog, and the name field ───────────────────────────────────────────
  {
    const { page, context } = await open(browser, [1440, 900])
    await live(page, 'slide-a', 1); await settle(page)
    await page.evaluate(() => { window.__offline = true; window.__sockets.at(-1).readyState = 3; window.__sockets.at(-1).onclose?.() })
    await settle(page, 100)
    await page.keyboard.press('a'); await settle(page)
    await page.fill('.ask-text', 'Is there a recording?')
    await page.fill('.ask-name', 'Sam')
    await page.keyboard.press('Control+Enter'); await settle(page)
    const p = await panelState(page)
    check(p.state === 'offline' && /Your browser is offline/.test(p.banner) && p.buttons.map((b) => b.label).join('|').startsWith('Close|Waiting to send'), `laptop: offline dialog with Close and Waiting to send (${p?.banner} / ${JSON.stringify(p?.buttons)})`)
    await shot(page, 'B8-ask-offline-1440x900.png')
    await page.evaluate(() => { window.__offline = false })
    await page.waitForFunction(() => window.__sent.length >= 1, null, { timeout: 15000 })
    await context.close()
  }

  // ── A result after a reload, and a question that cannot be kept ─────────────────────────
  {
    const { page, context } = await open(browser, [1440, 900])
    await live(page, 'slide-a', 1); await settle(page)
    await page.evaluate(() => { window.__offline = true; window.__sockets.at(-1).readyState = 3; window.__sockets.at(-1).onclose?.() })
    await settle(page, 100)
    await page.keyboard.press('a'); await settle(page)
    await page.fill('.ask-text', 'Sent before the reload')
    await page.keyboard.press('Control+Enter'); await settle(page)
    await page.evaluate(() => { window.__ackError = 'questions_paused' })
    await page.evaluate(() => { sessionStorage.__keep = '1' })
    await page.reload(); await page.waitForFunction(() => window.__sockets.length >= 1)
    await page.evaluate(() => { window.__ackError = 'questions_paused' })
    await live(page, 'slide-a', 1)
    await page.waitForFunction(() => window.__sent.length >= 1, null, { timeout: 15000 })
    await settle(page, 400)
    check(/Your question was not sent\. Open Ask to see why\./.test((await bar(page)).note), `reload: the refusal is said in the bar (${(await bar(page)).note})`)
    await page.keyboard.press('a'); await settle(page)
    const p = await panelState(page)
    check(p && p.state === 'failed' && p.text === 'Sent before the reload' && /not taking questions/.test(p.banner), `reload: Ask opens with the text back and the reason (${p?.state} ${p?.text})`)
    await page.keyboard.press('Escape')
    // Storage full: the wrong message must not be "ended".
    await page.evaluate(() => { window.__ackError = null; const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('talkweaver:live-reactions:')) throw new Error('full'); return set.call(this, k, v) } })
    await page.keyboard.press('a'); await settle(page)
    await page.fill('.ask-text', 'Cannot be kept')
    await page.keyboard.press('Control+Enter'); await settle(page)
    const q = await panelState(page)
    check(q.state === 'failed' && /Could not keep your question on this device\. Copy it, then try again\./.test(q.banner) && q.text === 'Cannot be kept', `unkept: the right message and the text kept (${q?.banner})`)
    await context.close()
  }

  // ── Question text and names are text, never HTML ─────────────────────────────────────────
  {
    const { page, context } = await open(browser, [1440, 900])
    await live(page, 'slide-a', 1); await settle(page)
    await page.evaluate(() => { window.__pwned = 0 })
    await page.click('.rx-ask'); await settle(page)
    const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>'
    await page.fill('.ask-text', evil)
    await page.fill('.ask-name', '<b onmouseover="window.__pwned=3">Mallory</b>')
    await page.keyboard.press('Control+Enter'); await settle(page, 400)
    const p = await panelState(page)
    check(p.quote === evil && p.imgs === 0 && /from <b onmouseover/.test(p.meta), `text: the sent view shows the question and name as text (${p?.quote})`)
    check(await page.evaluate(() => window.__pwned === 0 && !document.querySelector('.ask-panel script, .ask-panel b')), 'text: nothing in the page ran or was created from them')
    const s = await sent(page)
    check(s[0].text === evil, 'text: the worker gets the raw text (it is escaped when shown, not when sent)')
    await context.close()
  }

  // ── Nothing on the venue screen ──────────────────────────────────────────────────────────
  {
    const venueHtml = build({ venue: true, venueQr: '<svg></svg>', venueUrl: 'https://example.test/x' })
    check(!venueHtml.includes('.ask-panel{') && !venueHtml.includes('Ask the speaker a question (live)'), 'venue: no Ask styles and no A row')
    const { page, context } = await open(browser, [1440, 900], venuePath, '')
    await live(page, 'slide-a', 1); await settle(page, 300)
    await page.keyboard.press('a'); await settle(page)
    check(await closed(page), 'venue: A opens nothing')
    await context.close()
  }
} finally {
  await browser.close()
  await rm(scratch, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`audience ask DOM: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`)
  process.exit(1)
}
console.log('audience ask DOM: phone sheet at 360x740 and laptop dialog at 1440x900 and 1280x800 — send, sent, Ask another, name kept on the device, offline queue, refusals keep the text, pause not resent, Esc keeps the draft per slide, Cmd/Ctrl+Enter, A only where it should fire, keys stay out of the deck, the keyboard inset, question text as text, nothing on the venue screen')
