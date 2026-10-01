// The slide list's marks and "Take it away" on the real published audience page (ADR-0033, ticket 04), in
// headless Chromium: the Overview at 1440x900 and the phone slide list at 360x740 carry one mark per kind
// present on each row, a legend, and open the slide on a click; the phone list has the My Notes strip; the
// drawer's foot has Print or save as PDF (a notes page: notes with slide titles, not the slides, one A4 page),
// Copy as Markdown and Download .md, and no Download JSON. Seams: the page DOM and the two pure builders
// (audience-my-notes.test.mjs). Usage: node scripts/audience-my-notes-list-dom.test.mjs
//   SHOTS=<dir> saves the Overview, the phone list, the drawer foot and the printed notes page (PDF).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
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
const SLUG = 'my-notes-list-test'
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
    { id: 'note-1', slideIndex: 3, slideId: 'slide-d', slideTitle: 'Prompt before travel', type: 'text', quote: 'Ask first, then go.', ranges: [], note: 'Try this at work', createdAt: '2026-09-22T10:32:00', sentAt: '2026-09-22T10:42:00' },
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
  localStorage.setItem('html-presentations:notes:my-notes-list-test', JSON.stringify(held.notes))
  localStorage.setItem('html-presentations:reactions:my-notes-list-test', JSON.stringify(held.reactions))
  localStorage.setItem('html-presentations:questions:my-notes-list-test', JSON.stringify(held.questions))
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
const kindsOn = (page, scope) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((row) => (row.querySelector('.mn-marks')?.dataset.marks || '')), scope)
const EXPECT = ['bookmark puzzled question', 'note bookmark', 'helped poll', 'note question', '']
const pageCount = (pdf) => Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [pdf]).toString())[1])
const pdfText = (pdf) => execFileSync('pdftotext', ['-layout', pdf, '-']).toString()
const notesPage = async (context, page) => {
  const [popup] = await Promise.all([context.waitForEvent('page'), page.click('#notesPrint')])
  await popup.waitForLoadState('domcontentloaded')
  return popup
}
try {
  // ── Laptop: the Overview ────────────────────────────────────────────────────────────────────
  {
    const { page, context } = await open(browser, [1440, 900], HELD)
    await live(page, 'slide-a', 1); await settle(page, 200)
    await page.click('#overviewBtn'); await settle(page, 260)
    const rows = await kindsOn(page, '#navList .slide-link')
    const legend = await page.evaluate(() => [...document.querySelectorAll('#navPanel .mn-legend span[data-kind]')].map((n) => n.dataset.kind + ':' + n.textContent))
    check(rows.join('|') === EXPECT.join('|'), `laptop: each Overview row shows exactly the kinds present (${rows.join('|')})`)
    check(legend.join() === 'note:Note,bookmark:Bookmark,puzzled:Puzzled,helped:Helped,question:Question,poll:Poll answer', `laptop: the legend names the six marks (${legend})`)
    const geometry = await page.evaluate(() => {
      const panel = document.getElementById('navPanel').getBoundingClientRect()
      const leg = document.querySelector('#navPanel .mn-legend').getBoundingClientRect()
      const inside = [...document.querySelectorAll('#navList .mn-marks')].every((m) => { const r = m.getBoundingClientRect(); return r.right <= panel.right + 1 && r.left >= panel.left })
      return { legendTop: leg.top - panel.top, inside, over: document.documentElement.scrollWidth - innerWidth }
    })
    check(geometry.inside && geometry.over <= 0, `laptop: marks sit inside the drawer, no sideways scroll (${JSON.stringify(geometry)})`)
    check(await page.evaluate(() => getComputedStyle(document.querySelector('#navPanel .mn-legend')).position === 'sticky'), 'laptop: the legend is sticky, so it stays in view when the list scrolls')
    await shot(page, 'overview-marks-1440x900.png')
    // A row opens its slide.
    await page.click('#navList .slide-link[data-pos="2"]'); await settle(page, 200)
    check((await slideCount(page)).startsWith('3 /'), `laptop: clicking a row opens the slide (${await slideCount(page)})`)
    check(!(await page.evaluate(() => document.getElementById('navPanel').classList.contains('open'))), 'laptop: the Overview closes')
    // A mark added while the list is closed shows the next time it opens.
    await page.evaluate(() => { const k = 'html-presentations:reactions:my-notes-list-test'; const v = JSON.parse(localStorage.getItem(k)); v.runs['session-1']['slide-e'] = { r: 'helped', b: false }; localStorage.setItem(k, JSON.stringify(v)) })
    await page.click('#overviewBtn'); await settle(page, 200)
    check((await kindsOn(page, '#navList .slide-link'))[4] === 'helped', 'laptop: a mark kept since shows on the next opening')
    await page.click('#closeOverview')
    check(page.errors.length === 0 && page.requests.length === 0, `laptop overview: no page errors, no network (${page.errors.join('; ')}${page.requests.join(',')})`)
    await context.close()
  }

  // ── Phone: the slide list ────────────────────────────────────────────────────────────────────
  {
    const { page, context } = await open(browser, [360, 740], HELD, '')
    await settle(page, 300)
    check(await page.evaluate(() => document.body.classList.contains('phone-list-mode')), 'phone: opens on the slide list')
    const top = await page.evaluate(() => {
      const list = document.getElementById('phoneList')
      const head = list.querySelector('.mn-listhead')
      const strip = head?.querySelector('.mn-open-notes')
      const r = strip?.getBoundingClientRect()
      return { first: list.firstElementChild === head, text: strip?.textContent, h: r?.height, w: r?.width, legend: [...(head?.querySelectorAll('.mn-legend span[data-kind]') || [])].length }
    })
    check(top.first && top.text === 'My Notes4 slides' && top.h >= 44 && top.legend === 6, `phone: the My Notes strip is first, at least 44px, with the legend under it (${JSON.stringify(top)})`)
    const rows = await kindsOn(page, '#phoneList .pslide-row')
    check(rows.join('|') === EXPECT.join('|'), `phone: each list row shows exactly the kinds present (${rows.join('|')})`)
    const fit = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - innerWidth, listOver: document.getElementById('phoneList').scrollWidth - document.getElementById('phoneList').clientWidth,
      outside: [...document.querySelectorAll('#phoneList .mn-marks')].filter((m) => { const r = m.getBoundingClientRect(); return r.right > innerWidth || r.left < 0 }).length }))
    check(fit.over <= 0 && fit.listOver <= 0 && fit.outside === 0, `phone: no sideways scroll, marks inside the screen (${JSON.stringify(fit)})`)
    await shot(page, 'slide-list-marks-360x740.png')
    // The strip opens My Notes.
    await page.click('#phoneList .mn-open-notes'); await settle(page, 260)
    check(await isOpen(page), 'phone: the strip opens My Notes')
    await closeDrawer(page)
    // The legend stays in view while the list scrolls.
    await page.evaluate(() => { document.getElementById('phoneList').scrollTop = 900 }); await settle(page, 80)
    check(await page.evaluate(() => document.querySelector('#phoneList .mn-listhead').getBoundingClientRect().top <= 1 && getComputedStyle(document.querySelector('#phoneList .mn-listhead')).position === 'sticky'), 'phone: the strip and legend stay in view when the list scrolls')
    await page.evaluate(() => { document.getElementById('phoneList').scrollTop = 0 })
    // A row opens its slide.
    await page.click('#phoneList .pslide-row[data-index="1"]'); await settle(page, 200)
    check(await page.evaluate(() => document.body.classList.contains('phone-detail-mode')) && (await slideCount(page)).startsWith('2 /'), `phone: tapping a row opens the slide (${await slideCount(page)})`)
    // Removing a bookmark in My Notes updates the list.
    await page.click('.phone-bar button'); await settle(page, 200)
    check(await page.evaluate(() => document.body.classList.contains('phone-list-mode')), 'phone: Back returns to the list')
    await page.click('#phoneList .mn-open-notes'); await settle(page, 260)
    await page.click('#myNotesBody .mn-chip[data-chip="bookmark"]'); await settle(page, 60)
    await page.click('#myNotesBody .mn-remove >> nth=0'); await settle(page, 100)
    await closeDrawer(page)
    check((await kindsOn(page, '#phoneList .pslide-row'))[0] === 'puzzled question', `phone: taking a bookmark off in My Notes takes its mark off the list (${(await kindsOn(page, '#phoneList .pslide-row'))[0]})`)
    check(page.errors.length === 0, `phone list: no page errors (${page.errors.join('; ')})`)
    await context.close()
  }

  // ── Empty phone: the strip says so ───────────────────────────────────────────────────────────
  {
    const { page, context } = await open(browser, [360, 740], null, '')
    await settle(page, 300)
    const text = await page.evaluate(() => ({ strip: document.querySelector('#phoneList .mn-open-notes')?.textContent, marks: document.querySelectorAll('#phoneList .mn-marks').length }))
    check(text.strip === 'My NotesNothing yet' && text.marks === 0, `phone empty: the strip says nothing yet and no row has a mark (${JSON.stringify(text)})`)
    await context.close()
  }

  // ── The drawer's foot and what it takes away ─────────────────────────────────────────────────
  for (const [label, size] of [['laptop', [1440, 900]], ['phone', [360, 740]]]) {
    const phone = size[0] < 700
    const { page, context } = await open(browser, size, HELD)
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {})
    await live(page, 'slide-a', 1); await settle(page, 200)
    await openDrawer(page)
    const foot = await page.evaluate(() => {
      const foot = document.querySelector('.mn-foot')
      const box = (sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r ? { w: r.width, h: r.height, top: r.top } : null }
      return {
        buttons: [...foot.querySelectorAll('button')].map((b) => b.id + ':' + b.textContent.trim()),
        primary: box('#notesPrint'), copy: box('#notesCopyMd'), download: box('#notesDownloadMd'),
        json: document.querySelectorAll('#notesDownloadJson').length, jsonText: /json/i.test(foot.textContent),
        inView: foot.getBoundingClientRect().bottom <= innerHeight + 1, clipped: [...foot.querySelectorAll('button')].filter((b) => b.scrollWidth > b.clientWidth + 1).length, primaryBg: getComputedStyle(document.getElementById('notesPrint')).backgroundColor,
      }
    })
    check(foot.buttons.join('|') === 'notesPrint:Print or save as PDF|notesCopyMd:Copy as Markdown|notesDownloadMd:Download .md', `${label}: the foot has Print or save as PDF, then Copy as Markdown and Download .md (${foot.buttons})`)
    check(foot.json === 0 && !foot.jsonText, `${label}: Download JSON is gone`)
    check(foot.primary.w > foot.copy.w && foot.primary.top < foot.copy.top && foot.primaryBg === 'rgb(15, 75, 216)', `${label}: Print is the main action, above and wider than the options (${JSON.stringify([foot.primary, foot.copy, foot.download])} ${foot.primaryBg})`)
    const target = phone ? 44 : 32
    check(foot.primary.h >= target - 1 && foot.copy.h >= target - 1 && foot.download.h >= target - 1 && foot.inView, `${label}: every foot control at least ${target}px and the foot in view (${foot.primary.h} ${foot.copy.h} ${foot.download.h})`)
    check(foot.clipped === 0, `${label}: no foot button clips its words`)
    await shot(page, `drawer-foot-${size[0]}x${size[1]}.png`)

    // Markdown: every kind, slide order.
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#notesDownloadMd')])
    const file = join(scratch, `${label}-notes.md`)
    await download.saveAs(file)
    const md = readFileSync(file, 'utf8')
    check(download.suggestedFilename() === 'my-notes-list-test-notes.md', `${label}: the download is the .md (${download.suggestedFilename()})`)
    const at = (text) => md.indexOf(text)
    const order = ['## Slide 1: What makes an agent useful?', '## Slide 2: The evolution of agents', '## Slide 3: Where this leaves us', '## Slide 4: Prompt before travel'].map(at)
    check(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])) && !md.includes('## Slide 5'), `${label}: Markdown has the slides that hold something, in slide order (${order})`)
    for (const [text, why] of [['- Bookmarked', 'bookmark'], ['- Puzzled by this', 'puzzled'], ['- Helped me understand', 'helped'], ['- Poll answer: What do you mainly use AI for?', 'poll answer'], ['You chose: Writing and editing', 'the answer'],
      ['- Question sent to the speaker', 'question'], ['- > Ask first, then go.', 'highlight'], ['  Try this at work', 'note words'], ['  Sent to the speaker as a question', 'sent note'], ['- > AI as tool user', 'second highlight']]) {
      check(md.includes(text), `${label}: Markdown holds the ${why}`)
    }
    check(md.startsWith('# Notes: My Notes browser test\n'), `${label}: Markdown opens with the talk (${md.split('\n')[0]})`)
    // Copy puts the same text on the clipboard (or says it could not).
    await page.click('#notesCopyMd'); await settle(page, 80)
    const copied = await page.evaluate(() => document.querySelector('#notesCopyMd .btn-label').textContent)
    check(copied === 'Copied', `${label}: Copy as Markdown says Copied (${copied})`)
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null))
    if (clip !== null) check(clip === md, `${label}: the clipboard holds the same Markdown`)

    // Print: the notes page in its own tab.
    const popup = await notesPage(context, page)
    const inPage = await popup.evaluate(() => ({
      title: document.querySelector('h1')?.textContent, sections: [...document.querySelectorAll('section h2')].map((h) => h.textContent),
      slides: document.querySelectorAll('.slide, [data-slide], canvas, iframe, img, script').length, pwned: window.__pwned || null,
      text: document.body.innerText,
    }))
    check(inPage.title === 'Notes — My Notes browser test', `${label}: the notes page is titled with the talk (${inPage.title})`)
    check(inPage.sections.join('|') === 'Slide 1 What makes an agent useful?|Slide 2 The evolution of agents|Slide 3 Where this leaves us|Slide 4 Prompt before travel', `${label}: one section per slide that holds something, with its title (${inPage.sections})`)
    check(inPage.slides === 0 && !inPage.text.includes('A chat can tell me how to fill in an expenses form') && !inPage.text.includes('Agents work with your files'), `${label}: no slide is on the page (${inPage.slides})`)
    check(inPage.text.includes(HOSTILE) && !inPage.pwned, `${label}: what people typed is text on the page`)
    const pdf = join(scratch, `${label}-notes.pdf`)
    await popup.pdf({ path: pdf, format: 'A4', preferCSSPageSize: true, printBackground: true })
    const text = pdfText(pdf)
    check(pageCount(pdf) === 1, `${label}: the notes print on one page (${pageCount(pdf)})`)
    check(text.includes('What makes an agent useful?') && text.includes('Puzzled by this') && !text.includes('Print or save as PDF') && !text.includes('Allow pop-ups'), `${label}: the printed page has the notes and not the screen bar`)
    check(!text.includes('An agent can find the form and fill it in.') || text.includes('Ask first, then go.'), `${label}: slides are not printed`)
    if (shots) { await mkdir(shots, { recursive: true }); execFileSync('cp', [pdf, join(shots, `notes-page-${label}.pdf`)]); await popup.screenshot({ path: join(shots, `notes-page-screen-${label}.png`) }) }
    await popup.close()
    check(page.errors.length === 0, `${label} foot: no page errors (${page.errors.join('; ')})`)
    await context.close()
  }

  // ── Empty: one line prints ───────────────────────────────────────────────────────────────────
  {
    const { page, context } = await open(browser, [1440, 900], null)
    await settle(page, 200)
    await openDrawer(page)
    check(await page.evaluate(() => document.getElementById('myNotesPanel').classList.contains('mn-is-empty') && getComputedStyle(document.getElementById('notesPrint')).backgroundColor === 'rgb(255, 255, 255)'), 'empty: the foot stays, its main button quiet')
    const popup = await notesPage(context, page)
    const text = await popup.evaluate(() => document.querySelector('main').innerText)
    check(text.includes('There is nothing to print yet. No notes have been made on this device.') && (await popup.locator('section').count()) === 0, `empty: the page is one line (${text})`)
    const pdf = join(scratch, 'empty.pdf')
    await popup.pdf({ path: pdf, format: 'A4', preferCSSPageSize: true })
    check(pageCount(pdf) === 1, 'empty: one page')
    if (shots) execFileSync('cp', [pdf, join(shots, 'notes-page-empty.pdf')])
    await popup.close()
    await context.close()
  }
} finally {
  await browser.close()
  await rm(scratch, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`audience My Notes list and foot DOM: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`)
  process.exit(1)
}
console.log('audience My Notes list and foot DOM: Overview at 1440x900 and phone list at 360x740 — exactly the kinds present on each row, legend, row opens the slide, the phone My Notes strip, marks follow what the device holds; the foot has Print or save as PDF then Copy as Markdown and Download .md, no JSON; Markdown holds every kind in slide order; the printed page is the notes with slide titles on one page, no slides, text only; empty prints one line')
