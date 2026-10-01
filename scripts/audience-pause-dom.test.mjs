// What a following phone or laptop shows when the speaker pauses reactions or questions (ADR-0027
// amendment, 2026-09-29; reactions ticket 05), on the real published audience page in headless
// Chromium at 360x740 (phone) and 1440x900 (laptop), against a fake live socket that answers like the
// worker: a switch change arrives as switches.state, a snapshot carries the switches, a meaning
// reaction sent while reactions are paused is refused with reactions_paused and stores nothing, a
// bookmark is still accepted. The four states: both on, reactions paused (Ask and Bookmark), questions
// paused (the reactions, no Ask), both paused (Bookmark alone). The rules are in audience-reactions.test.mjs.
// Usage: node scripts/audience-pause-dom.test.mjs
//   SHOTS=<dir> saves the four states at 360x740 and 1440x900.
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
const sourceDir = await mkdtemp(join(tmpdir(), 'talkweaver-pause-src-'))
const sourcePath = join(sourceDir, 'pause.md')
await writeFile(sourcePath, FIXTURE)
const model = await prepareSource(sourcePath, FIXTURE, 'The current state of AI agents', statSync(sourcePath))
await rm(sourceDir, { recursive: true, force: true })
const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-pause-'))
const htmlPath = join(scratch, 'handout.html')
await writeFile(htmlPath, buildShareHtml({
  title: 'Pause browser test', slug: 'pause-test', liveTalkSlug: 'pause-test', workerBaseUrl: 'https://live.example.test',
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
async function open(browser, size, initial) {
  const context = await browser.newContext({ viewport: { width: size[0], height: size[1] }, hasTouch: size[0] < 700 })
  const page = await context.newPage()
  page.errors = []
  page.on('pageerror', (error) => page.errors.push(error.message))
  await page.addInitScript(initScript, initial)
  await page.goto(pathToFileURL(htmlPath).href + '#slide-a')
  await page.waitForFunction(() => window.__sockets.length >= 1)
  await page.evaluate(() => window.__sockets.at(-1).emit({ type: 'slide.state', slideId: 'slide-a', reveal: 0, focus: null, revision: 1 }))
  await page.waitForTimeout(150)
  return { page, context }
}
// What the person sees on the bar: which controls are visible, the one line of note, and how far
// the visible controls fill the row.
const bar = (page) => page.evaluate(() => {
  const dock = document.getElementById('rxDock')
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none'
  const on = !dock.hidden && shown(dock)
  const buttons = on ? [...dock.querySelectorAll('.rx, .rx-notebtn, .rx-ask')].filter(shown) : []
  const wrap = dock.querySelector('.rx-bar')
  const box = wrap ? wrap.getBoundingClientRect() : null
  const rects = buttons.map((b) => b.getBoundingClientRect())
  return {
    on, buttons: buttons.map((b) => b.dataset.rx || (b.classList.contains('rx-notebtn') ? 'note' : 'ask')),
    note: dock.querySelector('.rx-note')?.textContent.trim() || '',
    fill: box && rects.length ? Math.round(((Math.max(...rects.map((r) => r.right)) - Math.min(...rects.map((r) => r.left))) / box.width) * 100) : 0,
    sep: !!dock.querySelector('.rx-sep') && shown(dock.querySelector('.rx-sep')),
    scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
  }
})
// A switch change reaches the page within a few seconds; the fake pushes it at once, so wait only until it shows.
const until = async (page, wanted, label) => {
  let last
  for (let i = 0; i < 30; i++) { last = await bar(page); if (wanted(last)) return last; await page.waitForTimeout(100) }
  failures.push(`${label} (${JSON.stringify(last)})`)
  return last
}
const sent = (page) => page.evaluate(() => window.__sent.map((m) => (m.type === 'question.submit' ? ['question', m.text] : [m.reaction, m.withdrawn === true])))
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, name) }) }
// The phone's bar carries Note beside Ask (before it, or last when Ask is away); the laptop's has no Note.
const barButtons = (spec, name) => (name === 'phone' ? (spec.buttons.includes('ask') ? spec.buttons.flatMap((id) => (id === 'ask' ? ['note', 'ask'] : [id])) : [...spec.buttons, 'note']) : spec.buttons)
const STATES = {
  'both-on': { patch: { questionsAllowed: true, reactionsAllowed: true }, buttons: ['puzzled', 'helped', 'bookmark', 'ask'], note: '' },
  'reactions-paused': { patch: { questionsAllowed: true, reactionsAllowed: false }, buttons: ['bookmark', 'ask'], note: 'The speaker has paused reactions' },
  'questions-paused': { patch: { questionsAllowed: false, reactionsAllowed: true }, buttons: ['puzzled', 'helped', 'bookmark'], note: 'The speaker is not taking questions right now' },
  'both-paused': { patch: { questionsAllowed: false, reactionsAllowed: false }, buttons: ['bookmark'], note: 'The speaker has paused reactions and questions' },
}

const browser = await chromium.launch({ headless: true })
try {
  for (const [name, size] of [['phone', [360, 740]], ['laptop', [1440, 900]]]) {
    const { page, context } = await open(browser, size)
    // Each of the four states, reached by the speaker's change while the page is following.
    for (const [state, spec] of Object.entries(STATES)) {
      await page.evaluate((patch) => window.__setSwitches(patch), spec.patch)
      const b = await until(page, (x) => x.buttons.join() === barButtons(spec, name).join() && x.note === spec.note, `${name} ${state}: the bar shows ${barButtons(spec, name).join('+')} with "${spec.note}"`)
      check(b.on && b.scrollW <= b.innerW, `${name} ${state}: the bar is on and nothing overflows sideways (${JSON.stringify(b)})`)
      if (state === 'questions-paused' && name === 'phone') check(b.fill >= 95, `phone questions paused: the reactions spread across the row (${b.fill}%)`)
      if (state === 'both-paused' && name === 'phone') check(b.fill >= 95, `phone both paused: Bookmark takes the row (${b.fill}%)`)
      if (name === 'laptop' && !spec.buttons.includes('ask')) check(!b.sep, `laptop ${state}: no divider left without Ask`)
      await shot(page, `${name}-${state}-${size[0]}x${size[1]}.png`)
    }
    // Bookmark stays available while reactions are paused, alone or beside Ask: it sends and is accepted.
    await page.evaluate(() => window.__setSwitches({ questionsAllowed: false, reactionsAllowed: false }))
    await until(page, (x) => x.buttons.join() === barButtons({ buttons: ['bookmark'] }, name).join(), `${name}: both paused leaves Bookmark`)
    await page.click('.rx[data-rx="bookmark"]')
    await page.waitForTimeout(200)
    check(JSON.stringify(await sent(page)) === JSON.stringify([['bookmark', false]]), `${name}: a bookmark tapped while both are paused is sent (${JSON.stringify(await sent(page))})`)
    check(await page.evaluate(() => document.querySelector('.rx[data-rx="bookmark"]').getAttribute('aria-pressed')) === 'true', `${name}: and is accepted, the bookmark stays marked`)
    const accepted = await bar(page)
    check(/Saved on this|Bookmark saved|Sent to the speaker/.test(accepted.note), `${name}: the bookmark's own note takes the line for a moment (${accepted.note})`)
    // A is Ask's key: with questions paused it does nothing.
    await page.keyboard.press('a'); await page.waitForTimeout(150)
    check(!(await page.evaluate(() => !!document.querySelector('.ask-panel'))), `${name}: A opens nothing while questions are paused`)
    // Turning both back on restores the whole bar and drops the line.
    await page.evaluate(() => window.__setSwitches({ questionsAllowed: true, reactionsAllowed: true }))
    const restored = await until(page, (x) => x.buttons.join() === barButtons(STATES['both-on'], name).join(), `${name}: turning both back on restores the bar`)
    check(!/paused|not taking/.test(restored.note), `${name}: the pause line is gone (${restored.note})`)
    await page.keyboard.press('a'); await page.waitForTimeout(150)
    check(await page.evaluate(() => !!document.querySelector('.ask-panel')), `${name}: A opens Ask again`)
    await page.keyboard.press('Escape')
    check(page.errors.length === 0, `${name}: no page errors (${page.errors.join('; ')})`)
    await context.close()
  }
  // A page that arrives while a switch is off shows it from the snapshot.
  for (const [state, spec] of Object.entries(STATES)) {
    const { page, context } = await open(browser, [360, 740], spec.patch)
    const b = await bar(page)
    check(b.buttons.join() === barButtons(spec, 'phone').join() && b.note === spec.note, `arriving in ${state}: the snapshot sets the bar (${JSON.stringify(b)})`)
    await context.close()
  }
  // A question typed before the pause is refused as questions_paused: the text is kept, shown plainly.
  {
    const { page, context } = await open(browser, [360, 740])
    await page.click('.rx-ask'); await page.waitForSelector('.ask-panel')
    await page.fill('.ask-text', 'Why is the second one an agent?')
    await page.evaluate(() => window.__setSwitches({ questionsAllowed: false }))
    await page.waitForTimeout(120)
    check(await page.evaluate(() => !!document.querySelector('.ask-panel .ask-text')?.value), 'a question being typed is not lost when the speaker pauses questions')
    await page.click('[data-act="send"]'); await page.waitForTimeout(400)
    check(/not taking questions/.test(await page.evaluate(() => document.querySelector('.ask-panel')?.textContent || '')), 'sending it says the speaker is not taking questions, and keeps the text')
    await context.close()
  }
  assert.deepEqual(failures, [], `audience pause:\n  ${failures.join('\n  ')}`)
  console.log('audience pause DOM: phone 360x740 and laptop 1440x900 — four states within the push (both on; reactions paused shows Ask and Bookmark with the line; questions paused hides Ask and spreads the reactions; both paused leaves Bookmark), Bookmark sent and accepted while paused, A idle while questions are paused, restore, snapshot on arrival, a typed question kept')
} finally {
  await browser.close()
  await rm(scratch, { recursive: true, force: true })
}
