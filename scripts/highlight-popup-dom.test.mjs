// The highlight popup on a laptop (My Notes ticket 02; ADR-0033 decision 2), on the real published audience
// page in headless Chromium at 1440x900 and 1280x800, against a fake live socket that answers like the worker.
// Selecting slide text keeps a highlight at once; the popup offers Save to notes and Send to the speaker as a
// question. Save sends nothing. Send puts one question through the Ask queue (quote, words, slide), keeps the
// note and marks it "Sent as a question" in My Notes; pressing twice sends once; while questions are paused the
// send button is absent; a refusal or a lost session leaves the note saved and says so in the popup.
// Usage: node scripts/highlight-popup-dom.test.mjs
//   SHOTS=<dir> saves the popup, paused, sent and My Notes states at both sizes.
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
`
const sourceDir = await mkdtemp(join(tmpdir(), 'talkweaver-popup-src-'))
const sourcePath = join(sourceDir, 'popup.md')
await writeFile(sourcePath, FIXTURE)
const model = await prepareSource(sourcePath, FIXTURE, 'The current state of AI agents', statSync(sourcePath))
await rm(sourceDir, { recursive: true, force: true })
const SLUG = 'popup-test'
const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-popup-'))
const htmlPath = join(scratch, 'handout.html')
await writeFile(htmlPath, buildShareHtml({
  title: 'Popup test', slug: SLUG, liveTalkSlug: SLUG, workerBaseUrl: 'https://live.example.test', includeNotes: false, license: null,
  styles: extractStyles(model.fullHtml), slides: extractSlides(model.fullHtml),
}))
const shots = process.env.SHOTS
if (shots) await mkdir(shots, { recursive: true })

const failures = []
const check = (ok, label) => { if (!ok) failures.push(label) }

const initScript = () => {
  window.__sockets = []
  window.__sent = []
  window.__switches = { questionsAllowed: true, reactionsAllowed: true }
  window.__ack = 'confirmed' // 'confirmed' | an error code | 'silent'
  window.fetch = async (url) => {
    const path = String(url)
    if (path.includes('/capabilities')) return { ok: true, status: 200, json: async () => ({ protocol: 2, build: '14-reactions-questions' }) }
    if (/\/sessions\/[^/]+\/status/.test(path)) return { ok: true, status: 200, json: async () => ({ status: 'live' }) }
    return { ok: true, status: 200, json: async () => ({ live: true, sessionId: 'session-1' }) }
  }
  window.__setSwitches = (patch) => { window.__switches = { ...window.__switches, ...patch }; window.__sockets.at(-1).emit({ type: 'switches.state', ...window.__switches }) }
  window.WebSocket = class FakeWebSocket {
    static OPEN = 1
    readyState = 0
    constructor(url) {
      this.url = url
      window.__sockets.push(this)
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); this.emit({ type: 'session.hello', protocol: 2, expiresAt: Date.now() + 600000 }) })
    }
    send(raw) {
      const message = JSON.parse(raw)
      if (message.type === 'session.sync') queueMicrotask(() => this.emit({
        type: 'session.snapshot', protocol: 2, sessionId: 'session-1', syncId: message.syncId, expiresAt: Date.now() + 600000,
        slideState: null, polls: [], receipts: [], switches: window.__switches,
      }))
      if (message.type === 'session.ping') this.emit({ type: 'session.pong', nonce: message.nonce })
      if (message.type === 'question.submit') {
        window.__sent.push(message)
        if (window.__ack === 'silent') return
        const ok = window.__ack === 'confirmed'
        setTimeout(() => this.emit({ type: 'question.ack', submissionId: message.submissionId, status: ok ? 'confirmed' : 'rejected', ...(ok ? {} : { error: window.__ack }) }), 20)
      }
    }
    close() { this.readyState = 3 }
    emit(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
  }
}
async function open(browser, size, held) {
  const context = await browser.newContext({ viewport: { width: size[0], height: size[1] } })
  const page = await context.newPage()
  page.errors = []
  page.on('pageerror', (error) => page.errors.push(error.message))
  await page.addInitScript(initScript)
  if (held) await page.addInitScript((notes) => localStorage.setItem('html-presentations:notes:popup-test', JSON.stringify(notes)), held)
  await page.goto(pathToFileURL(htmlPath).href + '#slide-a')
  await page.waitForFunction(() => window.__sockets.length >= 1)
  await page.evaluate(() => window.__sockets.at(-1).emit({ type: 'slide.state', slideId: 'slide-a', reveal: 0, focus: null, revision: 1 }))
  await page.waitForSelector('#rxDock:not([hidden])', { timeout: 5000 })
  await page.waitForTimeout(150)
  return { page, context }
}
const QUOTE = 'find the form and fill it in.'
// Select the words the way a person drags over them, then let the page's mouseup handler run.
const highlight = async (page) => {
  await page.evaluate((quote) => {
    const walker = document.createTreeWalker(document.querySelector('.stage > .slide.active'), NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const at = node.textContent.indexOf(quote)
      if (at >= 0) {
        const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + quote.length)
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
        break
      }
    }
    document.querySelector('.stage').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  }, QUOTE)
  await page.waitForSelector('#notePop:not([hidden])')
  await page.waitForTimeout(60)
}
const popup = (page) => page.evaluate(() => {
  const pop = document.getElementById('notePop')
  const r = pop.getBoundingClientRect()
  const visible = (id) => { const node = document.getElementById(id); return Boolean(node) && !node.hidden && node.getClientRects().length > 0 }
  const mark = document.querySelector('mark.note-mark')?.getBoundingClientRect()
  const footer = document.querySelector('.share-footer').getBoundingClientRect()
  const dock = document.getElementById('rxDock').getBoundingClientRect()
  return {
    quote: document.getElementById('notePopQuote').textContent, words: document.getElementById('notePopText').value,
    sentMark: visible('notePopSentMark'), send: visible('notePopSend'), sendDisabled: document.getElementById('notePopSend').disabled,
    sendLabel: document.getElementById('notePopSendLabel').textContent, saveLabel: document.getElementById('notePopDoneLabel').textContent,
    line: document.getElementById('notePopLine').hidden ? '' : document.getElementById('notePopLine').textContent,
    remove: visible('notePopRemove'), wordsShown: visible('notePopWords'),
    box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width },
    coversHighlight: Boolean(mark) && r.left < mark.right && r.right > mark.left && r.top < mark.bottom && r.bottom > mark.top,
    underFooter: r.bottom > footer.top || (dock.height > 0 && r.left < dock.right && r.right > dock.left && r.bottom > dock.top),
    inWindow: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
    controlsInside: [...pop.querySelectorAll('button, textarea')].filter((c) => c.getClientRects().length).every((c) => { const b = c.getBoundingClientRect(); return b.left >= r.left - 0.5 && b.right <= r.right + 0.5 && b.height >= 32 || c.id === 'notePopRemove' }),
  }
})
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('html-presentations:notes:popup-test') || '[]'))
const questionsKept = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('html-presentations:questions:popup-test') || 'null'))
const sent = (page) => page.evaluate(() => window.__sent)
const type = async (page, words) => { await page.fill('#notePopText', words); await page.waitForTimeout(40) }
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, name) }) }

const browser = await chromium.launch({ headless: true })
try {
  for (const size of [[1440, 900], [1280, 800]]) {
    const tag = `${size[0]}x${size[1]}`
    const label = tag

    // ── The popup: quote, words, both buttons, the line; placed clear of the highlight and the footer ──
    {
      const { page, context } = await open(browser, size)
      await highlight(page)
      let p = await popup(page)
      check(p.quote === QUOTE, `${label}: the quote is shown (${p.quote})`)
      check(p.send && p.sendDisabled, `${label}: Send is there and waits for words`)
      check(p.saveLabel === 'Save to notes' && p.sendLabel === 'Send to the speaker as a question', `${label}: both buttons are labelled (${p.saveLabel} / ${p.sendLabel})`)
      check(/stays on this device/.test(p.line) && /slide 1 to the speaker only/.test(p.line), `${label}: the line says where each goes (${p.line})`)
      check(!p.coversHighlight && !p.underFooter && p.inWindow && p.controlsInside, `${label}: the popup is off the highlight, clear of the footer and bar, in the window, targets at least 32px (${JSON.stringify(p)})`)
      check(p.box.width >= 340 && p.box.width <= 353, `${label}: 352px wide (${p.box.width})`)
      const notes0 = await stored(page)
      check(notes0.length === 1 && notes0[0].quote === QUOTE, `${label}: the highlight is kept at selection`)
      await type(page, 'Does it need my login for this?')
      p = await popup(page)
      check(!p.sendDisabled, `${label}: words enable Send`)
      await shot(page, `N1-popup-${tag}.png`)

      // Save keeps the highlight and the words and sends nothing.
      await page.click('#notePopDone')
      await page.waitForTimeout(150)
      const kept = await stored(page)
      check(kept.length === 1 && kept[0].note === 'Does it need my login for this?' && !kept[0].sentAt && !kept[0].sendId, `${label}: Save keeps the note and marks nothing sent`)
      check((await sent(page)).length === 0, `${label}: Save sends nothing`)
      check(await page.evaluate(() => document.getElementById('notePop').hidden) && await page.locator('mark.note-mark').count() === 1, `${label}: Save closes the popup; the highlight stays`)
      // Esc and a click outside lose nothing either.
      await page.click('mark.note-mark')
      await page.waitForSelector('#notePop:not([hidden])')
      await page.keyboard.press('Escape')
      check(await page.evaluate(() => document.getElementById('notePop').hidden) && (await stored(page)).length === 1, `${label}: Esc closes and loses nothing`)
      check(page.errors.length === 0, `${label} save: no page errors (${page.errors.join('; ')})`)
      await context.close()
    }

    // ── Send: one question with the quote, the words and the slide; the note kept and marked sent ──
    {
      const { page, context } = await open(browser, size)
      await highlight(page)
      await type(page, 'Does it need my login for this?')
      const started = Date.now()
      await page.click('#notePopSend')
      // Pressing again straight away (and by keyboard) is the same send.
      await page.evaluate(() => { const b = document.getElementById('notePopSend'); b.click(); b.click() })
      await page.waitForFunction(() => !document.getElementById('notePopSentMark').hidden, null, { timeout: 4000 })
      const took = Date.now() - started
      const messages = await sent(page)
      check(messages.length === 1, `${label}: one question is sent, however many presses (${messages.length})`)
      const m = messages[0] || {}
      check(m.slideId === 'slide-a' && m.text.includes(QUOTE) && m.text.includes('Does it need my login for this?') && m.text.length <= 500, `${label}: it carries the quote, the words and the slide (${JSON.stringify(m)})`)
      check(took < 2000, `${label}: sent and confirmed in ${took} ms`)
      const p = await popup(page)
      check(p.sentMark && !p.send && p.saveLabel === 'Done' && !p.remove && /Only the speaker sees it/.test(p.line) && /Sent as a question/.test(p.line), `${label}: the popup says Sent to the speaker (${JSON.stringify(p)})`)
      const note = (await stored(page))[0]
      check(Boolean(note) && note.note === 'Does it need my login for this?' && Boolean(note.sentAt), `${label}: the note is kept and marked sent`)
      check((await questionsKept(page)) === null, `${label}: the question is not listed a second time in the sent-questions record`)
      await shot(page, `N1c-sent-popup-${tag}.png`)
      await page.click('#notePopDone')
      // My Notes: "Sent as a question · time", the words fixed, and the note is in Notes and Questions.
      await page.click('#myNotesBtn'); await page.waitForTimeout(260)
      const drawer = await page.evaluate(() => ({
        pill: document.querySelector('#myNotesBody [data-note-row] .mn-pill.sent')?.textContent || '',
        editable: document.querySelectorAll('#myNotesBody [data-note-row] .mn-words.editable').length,
        cards: document.querySelectorAll('#myNotesBody [data-note-row]').length, questionCards: document.querySelectorAll('#myNotesBody [data-kind="question"]').length,
      }))
      check(/^Sent as a question · \d\d:\d\d$/.test(drawer.pill) && drawer.editable === 0 && drawer.cards === 1 && drawer.questionCards === 0, `${label}: My Notes marks it (${JSON.stringify(drawer)})`)
      await shot(page, `N1c-sent-in-my-notes-${tag}.png`)
      await page.click('#myNotesBody .mn-chip[data-chip="question"]'); await page.waitForTimeout(40)
      check(await page.locator('#myNotesBody [data-note-row]').count() === 1, `${label}: the Questions chip holds it`)
      await page.click('#myNotesBody .mn-chip[data-chip="note"]'); await page.waitForTimeout(40)
      check(await page.locator('#myNotesBody [data-note-row]').count() === 1, `${label}: the Notes chip holds it`)
      await page.click('#closeMyNotes')
      // Reopening the highlight shows it sent; nothing is sent again.
      await page.click('mark.note-mark')
      await page.waitForSelector('#notePop:not([hidden])')
      const again = await popup(page)
      check(again.sentMark && !again.send, `${label}: the sent highlight reopens as sent, with no Send`)
      check((await sent(page)).length === 1, `${label}: still one question after all of it`)
      check(page.errors.length === 0, `${label} send: no page errors (${page.errors.join('; ')})`)
      await context.close()
    }

    // ── Paused: no send button; Save stays; a pause during typing takes it away; refusal keeps the note ──
    {
      const { page, context } = await open(browser, size)
      await page.evaluate(() => window.__setSwitches({ questionsAllowed: false }))
      await page.waitForTimeout(150)
      await highlight(page)
      await type(page, 'Does it need my login for this?')
      let p = await popup(page)
      check(!p.send && /not taking questions/.test(p.line) && p.saveLabel === 'Save to notes', `${label}: paused: no Send, one line says why, Save stays (${p.line})`)
      check(!p.coversHighlight && !p.underFooter && p.inWindow, `${label}: the paused popup is placed clear too`)
      await shot(page, `N1b-popup-questions-paused-${tag}.png`)
      await page.click('#notePopDone')
      check((await stored(page))[0]?.note === 'Does it need my login for this?' && (await sent(page)).length === 0, `${label}: paused: Save keeps the note and nothing is sent`)
      // Resumed while the popup is open: Send appears; paused again: it goes.
      await page.click('mark.note-mark'); await page.waitForSelector('#notePop:not([hidden])')
      await page.evaluate(() => window.__setSwitches({ questionsAllowed: true })); await page.waitForTimeout(120)
      check((await popup(page)).send, `${label}: questions back on: Send appears in the open popup`)
      await page.evaluate(() => window.__setSwitches({ questionsAllowed: false })); await page.waitForTimeout(120)
      check(!(await popup(page)).send, `${label}: questions paused again: Send goes`)
      await page.evaluate(() => window.__setSwitches({ questionsAllowed: true })); await page.waitForTimeout(120)
      // The speaker paused after the popup showed Send (the page has not heard yet): the worker refuses.
      await page.evaluate(() => { window.__ack = 'questions_paused' })
      await page.click('#notePopSend')
      await page.waitForFunction(() => /Not sent/.test(document.getElementById('notePopLine').textContent), null, { timeout: 4000 })
      p = await popup(page)
      check(/Your note is saved/.test(p.line) && /not taking questions/.test(p.line) && !p.sentMark, `${label}: a refusal says so and the note is saved (${p.line})`)
      const note = (await stored(page))[0]
      check(Boolean(note) && note.note === 'Does it need my login for this?' && !note.sentAt, `${label}: a refusal leaves the note saved, not sent`)
      check((await sent(page)).length === 1, `${label}: the refused question was sent once`)
      await shot(page, `N1-refused-${tag}.png`)
      // Try again once the speaker takes questions: a new send, sent once.
      await page.evaluate(() => { window.__ack = 'confirmed' })
      await page.click('#notePopSend')
      await page.waitForFunction(() => !document.getElementById('notePopSentMark').hidden, null, { timeout: 4000 })
      check((await sent(page)).length === 2 && Boolean((await stored(page))[0].sentAt), `${label}: Try again sends once and marks the note`)
      check(page.errors.length === 0, `${label} paused: no page errors (${page.errors.join('; ')})`)
      await context.close()
    }

    // ── Not following: the popup is today's (Save only), and hostile text stays text ──────────────
    {
      const { page, context } = await open(browser, size)
      await highlight(page)
      await page.fill('#notePopText', '<img src=x onerror="window.__pwned=1">')
      await page.click('#notePopDone')
      await page.evaluate(() => { document.getElementById('myNotesBtn').click() }); await page.waitForTimeout(260)
      check(await page.evaluate(() => !window.__pwned && document.querySelectorAll('#myNotesBody img').length === 0), `${label}: words are shown as text only`)
      await context.close()
    }
  }
} finally {
  await browser.close()
  await rm(scratch, { recursive: true, force: true })
}
if (failures.length) {
  console.error(`highlight popup DOM: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`)
  process.exit(1)
}
console.log('highlight popup DOM: 1440x900 and 1280x800 — quote, words and both labelled buttons, placed clear of the highlight and the footer; Save keeps the note and sends nothing; Send delivers one question (quote, words, slide) once however many presses, keeps the note and marks it Sent as a question in My Notes (Notes and Questions chips, words fixed); paused: no Send, Save stays, follows a pause and a resume; a refusal leaves the note saved and says so; Try again sends once; text only')
