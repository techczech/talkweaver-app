// The My Notes drawer on the real published audience page (buildShareHtml with its follow runtime), in
// headless Chromium at 360x740 (phone layout) and 1440x900 (laptop layout), with a fake live socket. What
// a device holds for a talk is put into localStorage before the page loads, exactly as the page's own
// keys keep it. Seams: the page DOM only; the read model has its own unit test (audience-my-notes.test.mjs).
// Usage: node scripts/audience-my-notes-dom.test.mjs
//   SHOTS=<dir> saves the drawn states (All, a chip, Remove, empty) at 360x740 and 1440x900.
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

### Prompt before travel {id=slide-d}

- Ask first, then go.

### Key trends {id=slide-e}

- Prices fall.
`
const sourceDir = await mkdtemp(join(tmpdir(), 'talkweaver-mynotes-src-'))
const sourcePath = join(sourceDir, 'my-notes.md')
await writeFile(sourcePath, FIXTURE)
const model = await prepareSource(sourcePath, FIXTURE, 'The current state of AI agents', statSync(sourcePath))
await rm(sourceDir, { recursive: true, force: true })
const slides = extractSlides(model.fullHtml)
const styles = extractStyles(model.fullHtml)
const SLUG = 'my-notes-test'
const build = () => buildShareHtml({
  title: 'My Notes browser test', slug: SLUG, liveTalkSlug: SLUG,
  workerBaseUrl: 'https://live.example.test', includeNotes: false, license: null, styles, slides,
})
const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-mynotes-'))
const htmlPath = join(scratch, 'handout.html')
await writeFile(htmlPath, build())
const shots = process.env.SHOTS
if (shots) await mkdir(shots, { recursive: true })

const failures = []
const check = (ok, label) => { if (!ok) failures.push(label) }

// What one device holds: highlights and notes out of slide order, reaction marks in two live runs (the
// same Puzzled on slide a in both), a reaction taken back (slide e: no entry), a question and a poll answer.
const HOSTILE = '<img src=x onerror="window.__pwned=1"> and <b>bold</b>'
const HELD = {
  notes: [
    { id: 'note-1', slideIndex: 3, slideId: 'slide-d', slideTitle: 'Prompt before travel', type: 'text', quote: 'Ask first, then go.', ranges: [], note: 'Try this at work', createdAt: '2026-09-22T10:32:00' },
    { id: 'note-2', slideIndex: 1, slideId: 'slide-b', slideTitle: 'The evolution of agents', type: 'text', quote: 'AI as tool user', ranges: [], note: HOSTILE, createdAt: '2026-09-22T10:40:00' },
  ],
  reactions: { v: 2, used: true, runs: {
    'session-1': { 'slide-a': { r: 'puzzled', b: true }, 'slide-c': { r: 'helped', b: false } },
    'session-0': { 'slide-a': { r: 'puzzled', b: false }, 'slide-b': { r: null, b: true } },
  } },
  questions: { v: 1, items: [{ submissionId: 'q-1', slideId: 'slide-a', text: HOSTILE, name: '<i>Sam</i>', at: '2026-09-22T10:44:00' }] },
  poll: { key: 'talkweaver:poll-answer:session-0:poll-1', value: { slideId: 'slide-c', question: 'What do you mainly use AI for?', answer: 'Writing and editing', at: '2026-09-22T10:18:00' } },
}
const seed = (held) => {
  if (!held) return
  localStorage.setItem('html-presentations:notes:my-notes-test', JSON.stringify(held.notes))
  localStorage.setItem('html-presentations:reactions:my-notes-test', JSON.stringify(held.reactions))
  localStorage.setItem('html-presentations:questions:my-notes-test', JSON.stringify(held.questions))
  localStorage.setItem(held.poll.key, JSON.stringify(held.poll.value))
}

const initScript = () => {
  window.__sockets = []
  window.__sent = []
  window.__fetches = []
  window.__capabilities = { protocol: 2, build: '14-reactions-questions' }
  window.fetch = async (url) => {
    const path = String(url)
    window.__fetches.push(path)
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
      if (message.type === 'reaction.send') { window.__sent.push(message); setTimeout(() => this.emit({ type: 'reaction.ack', submissionId: message.submissionId, status: 'confirmed' }), 20) }
      if (message.type === 'question.submit') { window.__sent.push(message); setTimeout(() => this.emit({ type: 'question.ack', submissionId: message.submissionId, status: 'confirmed' }), 20) }
      if (message.type === 'vote.submit') queueMicrotask(() => this.emit({ type: 'vote.ack', submissionId: message.submissionId, pollId: message.pollId, status: 'confirmed', choice: message.choice }))
    }
    close() { this.readyState = 3 }
    emit(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
  }
}

async function open(browser, size, held, hash = '#slide-a') {
  const context = await browser.newContext({ viewport: { width: size[0], height: size[1] }, hasTouch: size[0] < 700 })
  const page = await context.newPage()
  page.errors = []
  page.requests = []
  page.on('pageerror', (error) => page.errors.push(error.message))
  page.on('request', (request) => { if (!request.url().startsWith('file:')) page.requests.push(request.url()) })
  await page.addInitScript(initScript)
  await page.addInitScript(seed, held)
  await page.goto(pathToFileURL(htmlPath).href + hash)
  await page.waitForFunction(() => window.__sockets.length >= 1)
  return { page, context }
}
const live = (page, slideId, revision) => page.evaluate(([id, rev]) => window.__sockets.at(-1).emit({ type: 'slide.state', slideId: id, reveal: 0, focus: null, revision: rev }), [slideId, revision])
const settle = (page, ms = 120) => page.waitForTimeout(ms)
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, name) }) }
const isOpen = (page) => page.evaluate(() => document.getElementById('myNotesPanel').classList.contains('open'))
const openDrawer = async (page) => { await page.click('#myNotesBtn'); await settle(page, 260) }
const closeDrawer = async (page) => { await page.click('#closeMyNotes'); await settle(page, 60) }
const groups = (page) => page.evaluate(() => [...document.querySelectorAll('#myNotesBody .mn-group')].map((g) => ({
  slide: Number(g.dataset.slide), heading: g.querySelector('h3').textContent,
  marks: [...g.querySelectorAll('.mn-mark')].map((m) => m.dataset.mark),
  cards: [...g.querySelectorAll('.mn-card')].map((c) => c.dataset.kind),
  also: g.querySelector('.mn-also')?.textContent || '',
})))
const chipState = (page) => page.evaluate(() => [...document.querySelectorAll('#myNotesBody .mn-chip')].filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.dataset.chip))
const chip = async (page, id) => { await page.click(`#myNotesBody .mn-chip[data-chip="${id}"]`); await settle(page, 40) }
const summary = (gs) => gs.map((g) => `${g.slide}:${[...g.marks, ...g.cards].join('+')}`).join(' ')
const slideCount = (page) => page.evaluate(() => document.getElementById('slideCount')?.textContent || '')
const stored = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), key)

const browser = await chromium.launch({ headless: true })
try {
  for (const [label, size, target] of [['laptop', [1440, 900], 32], ['phone', [360, 740], 44]]) {
    const phone = size[0] < 700
    const tag = `${size[0]}x${size[1]}`

    // ── Empty: the sentence and its how-to; nothing is looked up ───────────────────────────
    {
      const { page, context } = await open(browser, size, null)
      await settle(page, 200)
      const before = await page.evaluate(() => ({ fetches: window.__fetches.length, sent: window.__sent.length }))
      const requestsBefore = page.requests.length
      await openDrawer(page)
      const text = await page.evaluate(() => ({
        lead: document.querySelector('#myNotesBody .mn-lead')?.textContent, how: document.querySelector('#myNotesBody .mn-how')?.textContent,
        chips: document.querySelectorAll('#myNotesBody .mn-chip').length, groups: document.querySelectorAll('#myNotesBody .mn-group').length,
      }))
      check(text.lead === 'Your notes stay on the device you took them on.', `${label}: empty state sentence (${text.lead})`)
      check(text.how === (phone ? 'Tap Note under a slide to write a note.' : 'Select text on a slide to highlight it and add a note.'), `${label}: one line of how to add (${text.how})`)
      check(text.chips === 0 && text.groups === 0, `${label}: empty shows no chips and no slides`)
      const after = await page.evaluate(() => ({ fetches: window.__fetches.length, sent: window.__sent.length }))
      check(after.fetches === before.fetches && after.sent === before.sent && page.requests.length === requestsBefore, `${label}: opening My Notes makes no request to look for notes (${JSON.stringify(before)} -> ${JSON.stringify(after)}, ${page.requests.length - requestsBefore} network)`)
      check(await page.locator('#notesCopyMd').isVisible(), `${label}: the foot keeps today's export buttons`)
      await shot(page, `empty-${tag}.png`)
      await closeDrawer(page)
      check(page.errors.length === 0, `${label} empty: no page errors (${page.errors.join('; ')})`)
      await context.close()
    }

    // ── A device holding everything ─────────────────────────────────────────────────────────
    {
      const { page, context } = await open(browser, size, HELD)
      await live(page, 'slide-a', 1); await settle(page, 200)
      const netBefore = page.requests.length
      const fetchesBefore = await page.evaluate(() => window.__fetches.length)
      await openDrawer(page)
      check(await isOpen(page), `${label}: the My Notes button opens the drawer`)

      let gs = await groups(page)
      check(summary(gs) === '1:bookmark+puzzled+question 2:bookmark+note 3:helped+poll 4:note',
        `${label}: All lists each kind once under its slide in slide order; the taken-back reaction (slide 5) and the empty slide are absent (${summary(gs)})`)
      check(gs.map((g) => g.heading).join('|') === 'Slide 1 — What makes an agent useful?|Slide 2 — The evolution of agents|Slide 3 — Where this leaves us|Slide 4 — Prompt before travel',
        `${label}: headings carry number and title (${gs.map((g) => g.heading)})`)
      check((await chipState(page)).join() === 'all', `${label}: All is the chip set on opening`)
      check(await page.evaluate(() => [...document.querySelectorAll('#myNotesBody .mn-chip')].map((c) => c.textContent).join('|')) === 'All|Notes|Bookmarks|Puzzled|Helped|Questions|Poll answers', `${label}: the seven chips in order`)
      check((await page.locator('.mn-mark[data-mark="puzzled"]').count()) === 1, `${label}: Puzzled marked in two live runs is listed once`)

      // Each chip lists only its kind.
      const expect = { note: '2:note 4:note', bookmark: '1:bookmark 2:bookmark', puzzled: '1:puzzled', helped: '3:helped', question: '1:question', poll: '3:poll' }
      for (const [id, want] of Object.entries(expect)) {
        await chip(page, id)
        gs = await groups(page)
        check(summary(gs) === want && (await chipState(page)).join() === id, `${label}: the ${id} chip lists only ${id} (${summary(gs)})`)
      }
      await chip(page, 'puzzled')
      gs = await groups(page)
      check(gs[0].also === 'Also here: a bookmark, 1 question', `${label}: the Puzzled view says what else is on the slide (${gs[0].also})`)
      await shot(page, `chip-puzzled-${tag}.png`)
      await chip(page, 'helped')
      check((await groups(page))[0].also === 'Also here: a poll answer', `${label}: the Helped view's line`)

      // Text only: hostile question, name and note text stay text.
      await chip(page, 'all')
      const rendered = await page.evaluate(() => ({
        images: document.querySelectorAll('#myNotesBody img, #myNotesBody b, #myNotesBody i').length, pwned: window.__pwned === 1,
        words: [...document.querySelectorAll('#myNotesBody .mn-words')].map((n) => n.textContent),
        meta: [...document.querySelectorAll('#myNotesBody .mn-meta')].map((n) => n.textContent),
      }))
      check(rendered.images === 0 && !rendered.pwned, `${label}: no element is made from question, name or note text (${rendered.images})`)
      check(rendered.words.includes(HOSTILE) && rendered.meta.includes('Sent as <i>Sam</i>'), `${label}: question text, name and note text are shown as typed (${JSON.stringify(rendered.words)} ${JSON.stringify(rendered.meta)})`)
      await shot(page, `all-${tag}.png`)

      // Layout: no sideways scroll, every control at the target size, everything inside the drawer.
      const layout = await page.evaluate(() => {
        const panel = document.getElementById('myNotesPanel').getBoundingClientRect()
        const controls = [...document.querySelectorAll('#myNotesPanel button')].filter((b) => b.getClientRects().length && getComputedStyle(b).clip !== 'rect(0px, 0px, 0px, 0px)')
        const body = document.getElementById('myNotesBody')
        return {
          small: controls.map((b) => { const r = b.getBoundingClientRect(); return [b.textContent.trim() || b.getAttribute('aria-label'), Math.round(r.width), Math.round(r.height)] }),
          outside: controls.filter((b) => { const r = b.getBoundingClientRect(); return r.left < panel.left - 1 || r.right > panel.right + 1 }).map((b) => b.textContent),
          bodyOverflow: body.scrollWidth - body.clientWidth, pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
          footVisible: document.querySelector('.mn-foot').getBoundingClientRect().bottom <= window.innerHeight + 1,
        }
      })
      check(layout.small.every(([, w, h]) => h >= target - 1 && w >= Math.min(target, 44) - 1), `${label}: every control at least ${target}px (${JSON.stringify(layout.small.filter(([, w, h]) => h < target - 1 || w < Math.min(target, 44) - 1))})`)
      check(layout.outside.length === 0 && layout.bodyOverflow <= 0 && layout.pageOverflow <= 0 && layout.footVisible, `${label}: nothing clipped or scrolling sideways, the foot in view (${JSON.stringify({ o: layout.outside, b: layout.bodyOverflow, p: layout.pageOverflow })})`)

      // Remove: the bookmark on slide 1 leaves My Notes and the bar; nothing is sent.
      const barBefore = await page.evaluate(() => [...document.querySelectorAll('.rx[aria-pressed="true"]')].map((b) => b.dataset.rx))
      check(barBefore.join() === 'puzzled,bookmark', `${label}: the bar shows this run's marks on slide 1 (${barBefore})`)
      await page.focus('.mn-mark[data-mark="bookmark"] .mn-remove')
      await shot(page, `remove-before-${tag}.png`)
      await page.click('.mn-mark[data-mark="bookmark"] .mn-remove'); await settle(page, 150)
      gs = await groups(page)
      check(summary(gs) === '1:puzzled+question 2:bookmark+note 3:helped+poll 4:note', `${label}: Remove clears the bookmark from My Notes (${summary(gs)})`)
      const held = await stored(page, 'html-presentations:reactions:my-notes-test')
      check(held.runs['session-1']['slide-a'].b === false && held.runs['session-1']['slide-a'].r === 'puzzled', `${label}: this run's bookmark is cleared on the device, its reaction kept (${JSON.stringify(held.runs['session-1']['slide-a'])})`)
      await page.click('.mn-group[data-slide="2"] .mn-mark[data-mark="bookmark"] .mn-remove'); await settle(page, 100)
      check(!(await stored(page, 'html-presentations:reactions:my-notes-test')).runs['session-0']?.['slide-b'], `${label}: a bookmark held only by an earlier live run is cleared too, so it does not come back`)
      check(await page.evaluate(() => [...document.querySelectorAll('.rx[aria-pressed="true"]')].map((b) => b.dataset.rx).join()) === 'puzzled', `${label}: the bar's mark for the run is cleared`)
      await shot(page, `remove-after-${tag}.png`)
      await page.click('.mn-mark[data-mark="puzzled"] .mn-remove'); await settle(page, 150)
      gs = await groups(page)
      check(summary(gs) === '1:question 2:note 3:helped+poll 4:note' && await page.evaluate(() => document.querySelectorAll('.rx[aria-pressed="true"]').length) === 0, `${label}: Remove on a reaction clears it from My Notes and the bar (${summary(gs)})`)
      check(await page.evaluate(() => window.__sent.length) === 0, `${label}: Remove sends nothing to the speaker`)
      check(page.requests.length === netBefore && await page.evaluate(() => window.__fetches.length) === fetchesBefore, `${label}: no request of any kind was made to list or remove (${page.requests.length - netBefore} network, ${await page.evaluate(() => window.__fetches.length) - fetchesBefore} fetch)`)

      // The chip stays set when a slide is opened, and is cleared when the drawer closes.
      await chip(page, 'note')
      const first = await slideCount(page)
      await page.click('.mn-group[data-slide="4"] .mn-open'); await settle(page, 150)
      if (phone) check(!(await isOpen(page)), `${label}: on a phone Open slide steps the drawer aside`)
      else check(await isOpen(page), `${label}: on a laptop the drawer stays open beside the slide`)
      const second = await slideCount(page)
      check(second !== first && /^4 \//.test(second), `${label}: Open slide moved the page to slide 4 (${first} -> ${second})`)
      if (phone) await openDrawer(page)
      check((await chipState(page)).join() === 'note' && summary(await groups(page)) === '2:note 4:note', `${label}: the chip is still Notes after Open slide (${await chipState(page)})`)
      await closeDrawer(page)
      check(!(await isOpen(page)), `${label}: Close closes the drawer`)
      await openDrawer(page)
      check((await chipState(page)).join() === 'all', `${label}: the chip is cleared once the drawer closes (${await chipState(page)})`)
      await page.keyboard.press('Escape'); await settle(page, 60)
      check(!(await isOpen(page)), `${label}: Escape closes the drawer`)

      // Delete a note; the note's words edit in place.
      await openDrawer(page)
      await page.click('.mn-card[data-note-row="note-1"] .mn-words'); await settle(page, 60)
      await page.fill('.mn-edit', 'Changed words'); await page.keyboard.press('Escape'); await settle(page, 60)
      check((await stored(page, 'html-presentations:notes:my-notes-test')).find((n) => n.id === 'note-1').note === 'Changed words', `${label}: a note's words edit in place and are kept`)
      await page.click('.mn-card[data-note-row="note-1"] [data-act="delete"]'); await settle(page, 60)
      check(summary(await groups(page)) === '1:question 2:note 3:helped+poll', `${label}: Delete removes a note (${summary(await groups(page))})`)
      check(page.errors.length === 0, `${label}: no page errors (${page.errors.join('; ')})`)
      await context.close()
    }

    // ── What the page itself records: a question the worker confirmed, a poll answer given ──
    {
      const { page, context } = await open(browser, size, null)
      await live(page, 'slide-b', 1); await settle(page, 250)
      await page.keyboard.press('a'); await settle(page, 80)
      await page.fill('.ask-text', HOSTILE)
      await page.fill('.ask-name', '<u>Ann</u>')
      await page.click('.ask-panel [data-act="send"]'); await settle(page, 250)
      await page.click('.ask-panel [data-act="done"]'); await settle(page, 60)
      const log = await stored(page, 'html-presentations:questions:my-notes-test')
      check(log?.items?.length === 1 && log.items[0].slideId === 'slide-b' && log.items[0].text === HOSTILE && log.items[0].name === '<u>Ann</u>' && typeof log.items[0].at === 'string',
        `${label}: a confirmed question is kept on the device with text, name, slide and time (${JSON.stringify(log)})`)
      await live(page, 'slide-c', 2); await settle(page, 100)
      await page.evaluate(() => window.__sockets.at(-1).emit({
        type: 'poll.state', pollId: 'poll-x', slideId: 'slide-c', pollType: 'single', question: 'Choose one', options: [{ optionId: 'a', label: 'First' }, { optionId: 'b', label: 'Second <b>' }],
        visibility: 'live', open: true, revealed: true, tallies: { a: 0, b: 0 },
      }))
      await settle(page, 100)
      await page.click('#audiencePollSurface .poll-option:nth-of-type(2)').catch(() => page.getByText('Second <b>', { exact: true }).click())
      await page.click('#audiencePollSurface .poll-submit'); await settle(page, 200)
      const answer = await stored(page, 'talkweaver:poll-answer:session-1:poll-x')
      check(answer?.slideId === 'slide-c' && answer.question === 'Choose one' && answer.answer === 'Second <b>', `${label}: a confirmed poll answer is kept with its slide, question and words (${JSON.stringify(answer)})`)
      await page.click('#audiencePollSurface .poll-dismiss'); await settle(page, 60) // the poll card covers the footer until it is dismissed
      await openDrawer(page)
      const gs = await groups(page)
      check(summary(gs) === '2:question 3:poll', `${label}: both show in My Notes without a reload (${summary(gs)})`)
      const texts = await page.evaluate(() => ({ q: document.querySelector('.mn-card[data-kind="question"] .mn-words')?.textContent, a: document.querySelector('.mn-card[data-kind="poll"] .mn-poll-a')?.textContent, pwned: window.__pwned === 1 }))
      check(texts.q === HOSTILE && texts.a === 'You chose: Second <b>' && !texts.pwned, `${label}: shown as text (${JSON.stringify(texts)})`)
      check(page.errors.length === 0, `${label} record: no page errors (${page.errors.join('; ')})`)
      await context.close()
    }
  }
} finally {
  await browser.close()
  await rm(scratch, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`audience My Notes DOM: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`)
  process.exit(1)
}
console.log('audience My Notes DOM: phone 360x740 and laptop 1440x900 — empty state and no lookup, All by slide with each kind once, each chip only its kind, text only, Remove on a bookmark and a reaction (device and bar only, nothing sent), chip kept through Open slide and cleared on close, questions and poll answers recorded')
