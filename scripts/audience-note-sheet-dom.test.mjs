// The phone's Note button beside Ask and its note sheet (My Notes ticket 03; ADR-0033, journey J2), on the real
// published audience page in headless Chromium at 360x740 and 430x932, against a fake live socket that answers
// like the worker. Proves: first use shows Note and Ask side by side on a second row and later use one row of
// icons, every target at least 44px with no sideways scroll; the sheet saves a note on this device (no quote, listed
// under its slide in My Notes, counted on the bar); unticked sends nothing, ticked sends exactly one question and
// marks the note sent; paused has no tick and the note still saves; a send lost with the queue after a reload is
// shown as "Not sent" with Try again (never "Sending…") and Try again sends once; the phone text view opens no
// highlight popup; a note's words are shown as text only.
// Usage: node scripts/audience-note-sheet-dom.test.mjs
//   SHOTS=<dir> saves the bar and sheet states at both sizes.
import { statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
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
`
const sourceDir = await mkdtemp(join(tmpdir(), 'talkweaver-note-src-'))
const sourcePath = join(sourceDir, 'note.md')
await writeFile(sourcePath, FIXTURE)
const model = await prepareSource(sourcePath, FIXTURE, 'The current state of AI agents', statSync(sourcePath))
await rm(sourceDir, { recursive: true, force: true })
const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-note-'))
const htmlPath = join(scratch, 'handout.html')
await writeFile(htmlPath, buildShareHtml({
  title: 'Note sheet browser test', slug: 'note-test', liveTalkSlug: 'note-test', workerBaseUrl: 'https://live.example.test',
  includeNotes: false, license: null, styles: extractStyles(model.fullHtml), slides: extractSlides(model.fullHtml),
}))
const shots = process.env.SHOTS
if (shots) await mkdir(shots, { recursive: true })
const failures = []
const check = (ok, label) => { if (!ok) failures.push(label) }

const initScript = (initial) => {
  window.__sockets = []
  window.__sent = []
  window.__switches = initial || { questionsAllowed: true, reactionsAllowed: true }
  window.fetch = async (url) => {
    const path = String(url)
    if (path.includes('/capabilities')) return { ok: true, status: 200, json: async () => ({ protocol: 2, build: '14-reactions-questions' }) }
    if (/\/sessions\/[^/]+\/status/.test(path)) return { ok: true, status: 200, json: async () => ({ status: 'live' }) }
    return { ok: true, status: 200, json: async () => ({ live: true, sessionId: 'session-1' }) }
  }
  // The worker's switch messages as a presenter's switches.set would cause them.
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
      if (message.type === 'reaction.send' || message.type === 'question.submit') {
        window.__sent.push(message)
        const refused = message.type === 'question.submit' ? !window.__switches.questionsAllowed : message.reaction !== 'bookmark' && !window.__switches.reactionsAllowed
        const error = message.type === 'question.submit' ? 'questions_paused' : 'reactions_paused'
        setTimeout(() => this.emit({ type: message.type === 'question.submit' ? 'question.ack' : 'reaction.ack', submissionId: message.submissionId, status: refused ? 'rejected' : 'confirmed', ...(refused ? { error } : {}) }), 20)
      }
    }
    close() { this.readyState = 3 }
    emit(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
  }
}
const NOTES_KEY = 'html-presentations:notes:note-test'
const STORAGE_INIT = (seed) => { if (seed && !sessionStorage.getItem('__seeded')) { sessionStorage.setItem('__seeded', '1'); localStorage.setItem(seed.key, seed.value) } }
async function open(browser, size, initial, seed) {
  const context = await browser.newContext({ viewport: { width: size[0], height: size[1] }, hasTouch: true })
  const page = await context.newPage()
  page.errors = []
  page.on('pageerror', (error) => page.errors.push(error.message))
  if (seed) await page.addInitScript(STORAGE_INIT, seed)
  await page.addInitScript(initScript, initial)
  await page.goto(pathToFileURL(htmlPath).href + '#slide-a')
  await page.waitForFunction(() => window.__sockets.length >= 1)
  await page.evaluate(() => window.__sockets.at(-1).emit({ type: 'slide.state', slideId: 'slide-a', reveal: 0, focus: null, revision: 1 }))
  await page.waitForTimeout(200)
  return { page, context }
}
const shot = async (page, name, size) => { if (shots) await page.screenshot({ path: join(shots, `${name}-${size[0]}x${size[1]}.png`) }) }
const questions = (page) => page.evaluate(() => window.__sent.filter((m) => m.type === 'question.submit').map((m) => ({ text: m.text, slideId: m.slideId, name: m.name || '', id: m.submissionId })))
const storedNotes = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '[]'), NOTES_KEY)
// The bar: where each control sits, its size, and whether the page scrolls sideways.
const barShape = (page) => page.evaluate(() => {
  const dock = document.getElementById('rxDock')
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none'
  const rect = (el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) } }
  const controls = [...dock.querySelectorAll('.rx, .rx-notebtn, .rx-ask')].filter(shown).map((el) => ({ id: el.dataset.rx || (el.classList.contains('rx-notebtn') ? 'note' : 'ask'), ...rect(el), text: el.textContent.trim() }))
  const bar = dock.querySelector('.rx-bar')
  return { mode: bar.classList.contains('words') ? 'words' : 'icons', controls, bar: rect(bar), count: dock.querySelector('.rx-count')?.textContent || '', countShown: !!dock.querySelector('.rx-count') && shown(dock.querySelector('.rx-count')), scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth }
})
const openMyNotes = async (page) => { await page.click('#myNotesBtn'); await page.waitForSelector('#myNotesPanel.open') }
const myNotesText = (page) => page.evaluate(() => document.getElementById('myNotesBody').innerText)

const browser = await chromium.launch({ headless: true })
try {
  for (const size of [[360, 740], [430, 932]]) {
    const at = `${size[0]}x${size[1]}`
    // ---- First use: words, two rows, Note beside Ask.
    {
      const { page, context } = await open(browser, size)
      const b = await barShape(page)
      const by = Object.fromEntries(b.controls.map((c) => [c.id, c]))
      check(b.mode === 'words' && b.controls.map((c) => c.id).join() === 'puzzled,helped,bookmark,note,ask', `${at} first use: five controls, Note before Ask (${JSON.stringify(b.controls.map((c) => c.id))})`)
      check(by.note && by.ask && Math.abs(by.note.t - by.ask.t) <= 1 && by.note.t >= by.bookmark.b - 1 && by.note.r <= by.ask.l + 1, `${at} first use: Note and Ask side by side on a second row (${JSON.stringify([by.note, by.ask])})`)
      check(by.note && /Note/.test(by.note.text) && /Ask/.test(by.ask.text), `${at} first use: Note and Ask carry their words`)
      check(b.controls.every((c) => c.h >= 44 && c.w >= 44), `${at} first use: every target at least 44px (${JSON.stringify(b.controls.map((c) => [c.id, c.w, c.h]))})`)
      check(b.scrollW <= b.innerW && b.controls.every((c) => c.l >= 0 && c.r <= b.innerW), `${at} first use: fits with no sideways scroll`)
      await shot(page, 'N2-bar-note-first-use', size)
      // The sheet, unticked.
      await page.click('.rx-notebtn')
      await page.waitForSelector('.ask-panel.mn-sheet')
      const head = await page.evaluate(() => ({ title: document.querySelector('.ask-head h2').textContent, about: document.querySelector('.ask-about').textContent, tick: !!document.querySelector('[data-act="tick"]'), tickLabel: document.querySelector('[data-act="tick"]')?.textContent, save: document.querySelector('[data-act="save-note"]').textContent.trim(), disabled: document.querySelector('[data-act="save-note"]').disabled, focus: document.activeElement.id }))
      check(head.title === 'Note on slide 1' && /What makes an agent useful/.test(head.about), `${at} sheet: headed with the slide (${head.title} | ${head.about})`)
      check(head.tick && /Also send to the speaker as a question/.test(head.tickLabel) && head.save === 'Save note' && head.disabled && head.focus === 'askText', `${at} sheet: tick offered, Save disabled until there are words, text box focused (${JSON.stringify(head)})`)
      await page.fill('.ask-text', 'Does it need my login for this?')
      await shot(page, 'N2b-note-sheet', size)
      const targets = await page.evaluate(() => [...document.querySelectorAll('.ask-panel button')].map((el) => { const r = el.getBoundingClientRect(); return [el.getAttribute('data-act'), Math.round(r.width), Math.round(r.height)] }))
      check(targets.every(([act, w, h]) => act === 'close' ? h >= 36 : h >= 44), `${at} sheet: targets at least 44px high (${JSON.stringify(targets)})`)
      const inside = await page.evaluate(() => { const p = document.querySelector('.ask-panel').getBoundingClientRect(); return p.left >= 0 && p.right <= window.innerWidth && p.bottom <= window.innerHeight + 1 && document.documentElement.scrollWidth <= window.innerWidth })
      check(inside, `${at} sheet: inside the window, no sideways scroll`)
      // Ticked: the name is asked, the button says both.
      await page.click('[data-act="tick"]')
      const ticked = await page.evaluate(() => ({ checked: document.querySelector('[data-act="tick"]').getAttribute('aria-checked'), name: !!document.querySelector('.ask-name'), save: document.querySelector('[data-act="save-note"]').textContent.trim(), text: document.querySelector('.ask-text').value }))
      check(ticked.checked === 'true' && ticked.name && ticked.save === 'Save and send to the speaker' && ticked.text === 'Does it need my login for this?', `${at} sheet ticked: name asked, "Save and send to the speaker", words kept (${JSON.stringify(ticked)})`)
      await page.fill('.ask-name', 'Priya')
      await shot(page, 'N2b-note-sheet-ticked', size)
      await page.click('[data-act="save-note"]')
      await page.waitForTimeout(500)
      const qs = await questions(page)
      check(qs.length === 1 && qs[0].text === 'Does it need my login for this?' && qs[0].slideId === 'slide-a' && qs[0].name === 'Priya', `${at} ticked: exactly one question through Ask with the words, slide and name (${JSON.stringify(qs)})`)
      check(await page.evaluate(() => !document.querySelector('.ask-panel')), `${at} ticked: the sheet closes on Save`)
      const notes = await storedNotes(page)
      check(notes.length === 1 && notes[0].type === 'slide' && notes[0].slideId === 'slide-a' && notes[0].note === 'Does it need my login for this?' && !notes[0].quote && typeof notes[0].sentAt === 'string' && notes[0].sentAt, `${at} ticked: kept as a slide note with no quote and marked sent (${JSON.stringify(notes)})`)
      const after = await barShape(page)
      check(after.countShown && after.count === '1', `${at} ticked: the bar counts one note on this slide (${after.count})`)
      check(/Sent to the speaker/.test(await page.evaluate(() => document.querySelector('.rx-note').textContent)), `${at} ticked: the bar says it was saved and sent`)
      await shot(page, 'N2c-note-saved-and-sent', size)
      await openMyNotes(page)
      const listed = await myNotesText(page)
      check(/Slide 1/.test(listed) && /Does it need my login for this\?/.test(listed) && /Sent as a question/.test(listed), `${at} My Notes: the note is under its slide and marked sent (${listed.replace(/\n+/g, ' | ').slice(0, 300)})`)
      check(await page.evaluate(() => !document.querySelector('#myNotesBody .mn-quote') && !document.querySelector('#myNotesBody [data-act="jump"]')), `${at} My Notes: a slide note has no quote and no Jump`)
      await page.click('#closeMyNotes')
      // A slide change moves the count to that slide's own notes.
      await page.evaluate(() => window.__sockets.at(-1).emit({ type: 'slide.state', slideId: 'slide-b', reveal: 0, focus: null, revision: 2 }))
      await page.waitForTimeout(200)
      check((await barShape(page)).count === '', `${at} slide change: the other slide shows no count`)
      check(page.errors.length === 0, `${at} first use: no page errors (${page.errors.join('; ')})`)
      await context.close()
    }
    // ---- Later use: icons in one row; unticked sends nothing.
    {
      const { page, context } = await open(browser, size)
      await page.click('.rx[data-rx="puzzled"]')
      await page.waitForTimeout(300)
      await page.evaluate(() => window.__sockets.at(-1).emit({ type: 'slide.state', slideId: 'slide-b', reveal: 0, focus: null, revision: 2 }))
      await page.waitForTimeout(200)
      const b = await barShape(page)
      const ids = b.controls.map((c) => c.id).join()
      check(b.mode === 'icons' && ids === 'puzzled,helped,bookmark,note,ask', `${at} later use: icons, Note before Ask (${b.mode} ${ids})`)
      check(new Set(b.controls.map((c) => c.t)).size === 1, `${at} later use: one row (${JSON.stringify(b.controls.map((c) => [c.id, c.t]))})`)
      check(b.controls.every((c) => c.h >= 44 && c.w >= 44), `${at} later use: every target at least 44px (${JSON.stringify(b.controls.map((c) => [c.id, c.w, c.h]))})`)
      check(b.scrollW <= b.innerW && b.controls.at(-1).r <= b.innerW && b.controls[0].l >= 0, `${at} later use: fits with no sideways scroll`)
      check(!b.countShown, `${at} later use: no count with no notes`)
      await shot(page, 'N2-bar-note-later', size)
      await page.click('.rx-notebtn')
      await page.waitForSelector('.ask-panel.mn-sheet')
      await page.fill('.ask-text', '<img src=x onerror="window.__pwned=1"> remember this')
      await page.click('[data-act="save-note"]')
      await page.waitForTimeout(400)
      check((await questions(page)).length === 0, `${at} unticked: nothing is sent`)
      const notes = await storedNotes(page)
      check(notes.length === 1 && !notes[0].sendId && !notes[0].sentAt && notes[0].type === 'slide', `${at} unticked: saved on this device only (${JSON.stringify(notes)})`)
      const after = await barShape(page)
      check(after.count === '1' && after.countShown, `${at} unticked: the count shows on the bar`)
      check(/Saved on this phone/.test(await page.evaluate(() => document.querySelector('.rx-note').textContent)), `${at} unticked: the bar says it was saved on this phone`)
      await shot(page, 'N2c-note-saved', size)
      await page.click('.rx-notebtn'); await page.waitForSelector('.ask-panel.mn-sheet')
      await page.fill('.ask-text', 'A second note'); await page.click('[data-act="save-note"]'); await page.waitForTimeout(300)
      check((await barShape(page)).count === '2', `${at} two notes: the count is 2`)
      await openMyNotes(page)
      const listed = await myNotesText(page)
      check(listed.includes('<img src=x onerror="window.__pwned=1"> remember this') && await page.evaluate(() => !window.__pwned && !document.querySelector('#myNotesBody img')), `${at} text only: the note's words show as text and nothing ran`)
      check(/A second note/.test(listed) && /Slide 2/.test(listed) && /Slide note/.test(listed) && !/Sent as a question/.test(listed), `${at} My Notes: both notes listed under slide 2 as slide notes, neither marked sent`)
      // Delete removes it from the bar's count too.
      await page.click('#myNotesBody [data-act="delete"]')
      await page.click('#closeMyNotes')
      check((await barShape(page)).count === '1', `${at} delete: the bar's count follows`)
      check(page.errors.length === 0, `${at} later use: no page errors (${page.errors.join('; ')})`)
      await context.close()
    }
    // ---- Paused: no tick, the note still saves, nothing is sent.
    {
      const { page, context } = await open(browser, size, { questionsAllowed: false, reactionsAllowed: true })
      const b = await barShape(page)
      check(b.controls.map((c) => c.id).join() === 'puzzled,helped,bookmark,note', `${at} paused: Note stays while Ask goes (${b.controls.map((c) => c.id)})`)
      check(b.controls.every((c) => c.h >= 44 && c.w >= 44) && b.scrollW <= b.innerW, `${at} paused: targets at least 44px, no sideways scroll (${JSON.stringify(b.controls.map((c) => [c.id, c.w, c.h]))})`)
      await page.click('.rx-notebtn'); await page.waitForSelector('.ask-panel.mn-sheet')
      const sheet = await page.evaluate(() => ({ tick: !!document.querySelector('[data-act="tick"]'), line: document.querySelector('.mn-paused')?.textContent || '', save: document.querySelector('[data-act="save-note"]').textContent.trim() }))
      check(!sheet.tick && /not taking questions/.test(sheet.line) && sheet.save === 'Save note', `${at} paused: no tick, one line says why (${JSON.stringify(sheet)})`)
      await page.fill('.ask-text', 'Does it need my login for this?')
      await shot(page, 'N2b-note-sheet-questions-paused', size)
      await page.click('[data-act="save-note"]'); await page.waitForTimeout(300)
      check((await questions(page)).length === 0 && (await storedNotes(page)).length === 1, `${at} paused: saved, nothing sent`)
      // A pause that arrives while the sheet is open takes the tick away.
      await page.evaluate(() => window.__setSwitches({ questionsAllowed: true }))
      await page.waitForTimeout(150)
      await page.click('.rx-notebtn'); await page.waitForSelector('.ask-panel.mn-sheet')
      await page.click('[data-act="tick"]')
      await page.evaluate(() => window.__setSwitches({ questionsAllowed: false }))
      await page.waitForTimeout(200)
      check(await page.evaluate(() => !document.querySelector('[data-act="tick"]') && document.querySelector('.ask-text') !== null), `${at} paused mid-sheet: the tick goes`)
      await page.fill('.ask-text', 'typed then paused'); await page.click('[data-act="save-note"]'); await page.waitForTimeout(300)
      check((await questions(page)).length === 0, `${at} paused mid-sheet: nothing is sent`)
      await context.close()
    }
    // ---- Lost with the session queue after a reload: "Not sent" with Try again, never "Sending…".
    {
      const seed = { key: NOTES_KEY, value: JSON.stringify([{ id: 'note-1', slideIndex: 0, slideId: 'slide-a', slideTitle: 'What makes an agent useful?', type: 'slide', note: 'Sent, then the queue was lost', createdAt: new Date().toISOString(), sendId: 'lost-submission-0001' }]) }
      const { page, context } = await open(browser, size, undefined, seed)
      await openMyNotes(page)
      const card = await page.evaluate(() => ({ text: document.querySelector('#myNotesBody [data-note-row]')?.innerText || '', retry: !!document.querySelector('#myNotesBody [data-act="retry-send"]'), sending: /Sending/.test(document.getElementById('myNotesBody').innerText) }))
      check(/Not sent/.test(card.text) && card.retry && !card.sending, `${at} lost send: "Not sent" with Try again, not "Sending…" (${JSON.stringify(card)})`)
      const retryBox = await page.evaluate(() => { const r = document.querySelector('#myNotesBody [data-act="retry-send"]').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] })
      check(retryBox[1] >= 44, `${at} lost send: Try again is at least 44px high (${retryBox})`)
      await page.waitForTimeout(500) // the drawer slides in
      await shot(page, 'N2c-note-not-sent', size)
      await page.click('#myNotesBody [data-act="retry-send"]')
      await page.waitForTimeout(500)
      const qs = await questions(page)
      check(qs.length === 1 && qs[0].id === 'lost-submission-0001' && qs[0].text === 'Sent, then the queue was lost', `${at} lost send: Try again sends once, under the same submission id (${JSON.stringify(qs)})`)
      const now = await myNotesText(page)
      check(/Sent as a question/.test(now) && !/Not sent/.test(now), `${at} lost send: after the answer the note is marked sent`)
      await context.close()
    }
    // ---- The phone text view opens no highlight popup.
    {
      const { page, context } = await open(browser, size)
      await page.evaluate(() => {
        const heading = document.querySelector('.slide.active h1, .slide.active h2, .slide.active li') || document.querySelector('.slide h1, .slide h2, .slide li')
        const range = document.createRange(); range.selectNodeContents(heading)
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range)
      })
      await page.evaluate(() => document.querySelector('.stage').dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
      await page.waitForTimeout(150)
      const seen = await page.evaluate((key) => ({ hidden: document.getElementById('notePop').hidden, notes: JSON.parse(localStorage.getItem(key) || '[]').length, marks: document.querySelectorAll('mark.note-mark').length }), NOTES_KEY)
      check(seen.hidden && seen.notes === 0 && seen.marks === 0, `${at} text view: a selection opens no popup and keeps no highlight (${JSON.stringify(seen)})`)
      await shot(page, 'N8-text-view-no-popup', size)
      await context.close()
    }
  }
  assert.deepEqual(failures, [], `audience note sheet:\n  ${failures.join('\n  ')}`)
  console.log('audience note sheet DOM: phone 360x740 and 430x932 — Note beside Ask (words in two rows, then one row of icons; targets 44px, no sideways scroll), the sheet headed with the slide, a saved note with no quote listed under its slide and counted on the bar, unticked sends nothing, ticked sends one question and marks it sent, paused has no tick, a lost send shows Not sent with Try again, no highlight popup in the text view, words as text only')
} finally {
  await browser.close()
  await rm(scratch, { recursive: true, force: true })
}
