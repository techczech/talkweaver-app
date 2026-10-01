// Ticket 04: the reaction bar on the real published audience page shows each slide's own set
// ({reactions=…}, round-2 P8, P9, P9b; round-3 carries the same rules to the laptop bar). The talk is
// compiled with the real compiler and published with buildShareHtml, then opened in headless
// Chromium at 360x740 and 430x932 (phone layout) and 1440x900 and 1280x800 (laptop layout) against
// a fake live socket (as audience-reactions-dom.test.mjs). Seams: the compiled slide's
// data-reactions and the page DOM; the tap rules have their own unit test.
//   - standard slide: the three standard reactions and Ask;
//   - {reactions=off}: only Ask (P8); with questions paused as well, no bar on the laptop and only
//     Note (My Notes) on the phone;
//   - {reactions=agree,disagree}: Agree and Disagree with icons and words, no bookmark (P9);
//   - {reactions=agree,disagree,bookmark}: the bookmark only when named;
//   - {reactions="Too fast","Just right","Too slow"}: words always, no icon, also after first use (P9b);
//   - a custom label with markup renders as text; a tap sends `custom:<label>`; the bar changes with
//     the live slide.
// Usage: node scripts/audience-reaction-sets-dom.test.mjs   (SHOTS=<dir> saves the drawn states)
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

### What makes an agent useful? {id=s-std}

- A chat can tell me how to fill in an expenses form.
- An agent can find the form and fill it in.

### Join MondAI for the latest news
{id=s-off} {reactions=off}

- ainewsroundup.pages.dev

### Not all agents are agents
{id=s-agree} {reactions=agree,disagree}

- Some are workflows with a chat box.

### Agents you can return to
{id=s-agree-bm} {reactions=agree,disagree,bookmark}

- A bookmark only when the slide names it.

### This means 2026 is the year of agents
{id=s-custom} {reactions="Too fast","Just right","Too slow"}

- The pace question.

### Labels are text
{id=s-markup} {reactions="<img src=x onerror=window.__pwned=1>","A & B"}

- Author labels are shown as text.
`
const sourceDir = await mkdtemp(join(tmpdir(), 'talkweaver-reaction-sets-src-'))
const sourcePath = join(sourceDir, 'reaction-sets.md')
await writeFile(sourcePath, FIXTURE)
const model = await prepareSource(sourcePath, FIXTURE, 'The current state of AI agents', statSync(sourcePath))
await rm(sourceDir, { recursive: true, force: true })
const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-reaction-sets-'))
const htmlPath = join(scratch, 'handout.html')
await writeFile(htmlPath, buildShareHtml({
  title: 'Reaction sets browser test', slug: 'reaction-sets-test', liveTalkSlug: 'reaction-sets-test',
  workerBaseUrl: 'https://live.example.test', includeNotes: false, license: null,
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
  window.fetch = async (url) => {
    const path = String(url)
    if (path.includes('/capabilities')) return { ok: true, status: 200, json: async () => ({ protocol: 2, build: '14-reactions-questions' }) }
    if (/\/sessions\/[^/]+\/status/.test(path)) return { ok: true, status: 200, json: async () => ({ status: 'live' }) }
    return { ok: true, status: 200, json: async () => ({ live: true, sessionId: 'session-1' }) }
  }
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
        type: 'session.snapshot', protocol: 2, sessionId: 'session-1', syncId: message.syncId,
        expiresAt: Date.now() + 600000, slideState: null, polls: [], receipts: [], switches: window.__switches,
      }))
      if (message.type === 'session.ping') this.emit({ type: 'session.pong', nonce: message.nonce })
      if (message.type === 'reaction.send') {
        window.__sent.push(message)
        setTimeout(() => this.emit({ type: 'reaction.ack', submissionId: message.submissionId, status: 'confirmed' }), 20)
      }
    }
    close() { this.readyState = 3 }
    emit(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
  }
  window.__setSwitches = (patch) => { window.__switches = { ...window.__switches, ...patch }; window.__sockets.at(-1).emit({ type: 'switches.state', ...window.__switches }) }
}

async function open(browser, size) {
  const context = await browser.newContext({ viewport: { width: size[0], height: size[1] }, hasTouch: size[0] < 700 })
  const page = await context.newPage()
  page.errors = []
  page.on('pageerror', (error) => page.errors.push(error.message))
  await page.addInitScript(initScript)
  await page.goto(pathToFileURL(htmlPath).href + '#s-std')
  await page.waitForFunction(() => window.__sockets.length >= 1)
  return { page, context }
}
let revision = 0
const live = async (page, slideId) => { await page.evaluate(([id, rev]) => window.__sockets.at(-1).emit({ type: 'slide.state', slideId: id, reveal: 0, focus: null, revision: rev }), [slideId, ++revision]); await page.waitForTimeout(150) }
const bar = (page) => page.evaluate(() => {
  const dock = document.getElementById('rxDock')
  const shown = !!dock && !dock.hidden && dock.getClientRects().length > 0
  const visible = (el) => !el.hidden && el.getClientRects().length > 0
  const reactions = shown ? [...dock.querySelectorAll('.rx')].filter(visible) : []
  const ask = shown ? dock.querySelector('.rx-ask') : null
  const clipped = (el) => !el || getComputedStyle(el).clip === 'rect(0px, 0px, 0px, 0px)'
  return {
    shown,
    ids: reactions.map((b) => b.dataset.rx),
    names: reactions.map((b) => b.getAttribute('aria-label')),
    words: reactions.filter((b) => !clipped(b.querySelector('.rx-w'))).map((b) => b.querySelector('.rx-w').textContent),
    icons: reactions.map((b) => b.querySelector('.rx-ico svg') ? [...b.querySelector('.rx-ico svg').classList].find((c) => c.startsWith('lucide-') && c !== 'lucide') : null),
    ask: !!ask && visible(ask),
    note: dock?.querySelector('.rx-note')?.textContent || '',
    sizes: [...reactions, ...(ask && visible(ask) ? [ask] : [])].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] }),
    right: Math.max(0, ...[...reactions, ...(ask && visible(ask) ? [ask] : [])].map((b) => Math.round(b.getBoundingClientRect().right))),
    barWidth: shown ? Math.round(dock.querySelector('.rx-bar').getBoundingClientRect().width) : 0,
    canvasWidth: Math.round(document.getElementById('stage')?.getBoundingClientRect().width || 0),
    scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
    markup: dock ? dock.querySelectorAll('img').length : 0,
  }
})
const sent = (page) => page.evaluate(() => window.__sent.map((m) => [m.reaction, m.slideId, m.withdrawn === true]))
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, name) }) }
const STANDARD = ['Puzzled by this', 'Helped me understand', 'Bookmark: I need to return to this']

const browser = await chromium.launch({ headless: true })
try {
  for (const size of [[360, 740], [430, 932], [1440, 900], [1280, 800]]) {
    const at = `${size[0]}x${size[1]}`
    const phone = size[0] < 700
    const minTarget = phone ? 44 : 32
    const { page, context } = await open(browser, size)
    await page.waitForTimeout(150)
    await live(page, 's-std')
    let b = await bar(page)
    check(b.shown && b.names.join('|') === STANDARD.join('|') && b.ask, `${at} standard: the standard three and Ask (${b.names})`)

    // P8: reactions off leaves only Ask.
    await live(page, 's-off')
    b = await bar(page)
    check(b.shown && b.ids.length === 0 && b.ask, `${at} P8 off: only Ask (${JSON.stringify(b.ids)} ask ${b.ask})`)
    check(b.sizes.every(([w, h]) => w >= minTarget && h >= minTarget), `${at} P8: Ask at least ${minTarget}px (${JSON.stringify(b.sizes)})`)
    check(b.scrollW <= b.innerW, `${at} P8: no horizontal scroll`)
    await shot(page, `P8-reactions-off-${at}.png`)
    // Off with questions paused: nothing to press, no bar.
    await page.evaluate(() => window.__setSwitches({ questionsAllowed: false })); await page.waitForTimeout(150)
    b = await bar(page)
    // The phone keeps Note (My Notes 03) when there is nothing else to press; the laptop has no bar.
    const noteOnly = await page.evaluate(() => { const n = document.querySelector('#rxDock:not([hidden]) .rx-notebtn'); return !!n && !n.hidden && n.getClientRects().length > 0 })
    if (phone) check(b.shown && b.ids.length === 0 && !b.ask && noteOnly, `${at} off + questions paused: only Note is left (${JSON.stringify(b)})`)
    else check(!b.shown, `${at} off + questions paused: no bar at all (${JSON.stringify(b)})`)
    await page.evaluate(() => window.__setSwitches({ questionsAllowed: true })); await page.waitForTimeout(150)
    check((await bar(page)).shown, `${at} questions back on: Ask returns on the off slide`)

    // P9: a replacement set, named reactions with icons and words, no bookmark.
    await live(page, 's-agree')
    b = await bar(page)
    check(b.shown && b.ids.join() === 'agree,disagree' && b.ask, `${at} P9: Agree and Disagree, no bookmark (${b.ids})`)
    check(b.words.join('|') === 'Agree|Disagree', `${at} P9: words on first use (${b.words})`)
    check(b.icons.join() === 'lucide-thumbs-up,lucide-thumbs-down', `${at} P9: their registered icons (${b.icons})`)
    check(b.sizes.every(([w, h]) => w >= minTarget && h >= minTarget) && b.scrollW <= b.innerW, `${at} P9: targets and no scroll (${JSON.stringify(b.sizes)})`)
    if (!phone) check(b.barWidth <= b.canvasWidth + 1, `${at} P9: the bar no wider than the slide (${b.barWidth} > ${b.canvasWidth})`)
    await shot(page, `P9-replacement-agree-${at}.png`)
    await page.click('.rx[data-rx="agree"]'); await page.waitForTimeout(200)
    check(JSON.stringify((await sent(page)).at(-1)) === JSON.stringify(['agree', 's-agree', false]), `${at} P9: a tap sends agree (${JSON.stringify(await sent(page))})`)
    await page.click('.rx[data-rx="disagree"]'); await page.waitForTimeout(200)
    b = await bar(page)
    check(/^Changed to Disagree/.test(b.note), `${at} P9: one meaning reaction per slide applies to the set (${b.note})`)

    // The bookmark only when named; the one-per-slide rule leaves it independent.
    await live(page, 's-agree-bm')
    b = await bar(page)
    check(b.ids.join() === 'agree,disagree,bookmark', `${at} named bookmark: Agree, Disagree, Bookmark (${b.ids})`)
    check(b.words.length === 0 && b.icons.join() === 'lucide-thumbs-up,lucide-thumbs-down,lucide-bookmark', `${at} after first use: icons only for named reactions (${b.words} / ${b.icons})`)
    await page.click('.rx[data-rx="agree"]'); await page.waitForTimeout(200)
    await page.click('.rx[data-rx="bookmark"]'); await page.waitForTimeout(200)
    check(JSON.stringify((await sent(page)).slice(-2)) === JSON.stringify([['agree', 's-agree-bm', false], ['bookmark', 's-agree-bm', false]]), `${at} named bookmark: both sent (${JSON.stringify(await sent(page))})`)

    // P9b: custom labels, words always (also after first use), no icon; a tap sends custom:<label>.
    await live(page, 's-custom')
    b = await bar(page)
    check(b.ids.join('|') === 'custom:Too fast|custom:Just right|custom:Too slow', `${at} P9b: the three labels (${b.ids})`)
    check(b.words.join('|') === 'Too fast|Just right|Too slow' && b.icons.every((icon) => icon === null), `${at} P9b: words always, no icon, after first use too (${b.words} / ${b.icons})`)
    check(b.sizes.every(([w, h]) => w >= minTarget && h >= minTarget) && b.scrollW <= b.innerW, `${at} P9b: targets and no scroll (${JSON.stringify(b.sizes)})`)
    if (!phone) check(b.barWidth <= b.canvasWidth + 1, `${at} P9b: the bar no wider than the slide`)
    await shot(page, `P9b-custom-labels-${at}.png`)
    await page.click('.rx[data-rx="custom:Just right"]'); await page.waitForTimeout(200)
    b = await bar(page)
    check(JSON.stringify((await sent(page)).at(-1)) === JSON.stringify(['custom:Just right', 's-custom', false]), `${at} P9b: a tap sends custom:Just right (${JSON.stringify((await sent(page)).at(-1))})`)
    check(/Just right · sent to the speaker|Sent to the speaker/.test(b.note), `${at} P9b: the note after a custom tap (${b.note})`)
    await shot(page, `P9b-custom-tapped-${at}.png`)
    // Paused reactions on a custom slide: the labels go, Ask stays, the pause line names reactions.
    // (A moment's note outranks the pause line for a few seconds; a new slide clears it.)
    await page.evaluate(() => window.__setSwitches({ reactionsAllowed: false })); await page.waitForTimeout(150)
    await live(page, 's-agree'); await live(page, 's-custom')
    b = await bar(page)
    check(b.ids.length === 0 && b.ask && /paused reactions/.test(b.note), `${at} paused: custom labels hidden, Ask with the pause line (${b.ids} / ${b.note})`)
    await live(page, 's-off')
    b = await bar(page)
    check(b.ask && !/paused reactions/.test(b.note), `${at} paused on an off slide: no reactions to mention (${b.note})`)
    await page.evaluate(() => window.__setSwitches({ reactionsAllowed: true })); await page.waitForTimeout(150)

    // Author labels are text, never markup.
    await live(page, 's-markup')
    b = await bar(page)
    check(b.words.join('|') === '<img src=x onerror=window.__pwned=1>|A & B' && b.markup === 0, `${at} labels are text (${b.words} / ${b.markup} img)`)
    check(!(await page.evaluate(() => window.__pwned)), `${at} a label never runs`)

    // Back to the standard slide: the standard set again.
    await live(page, 's-std')
    b = await bar(page)
    check(b.ids.join() === 'puzzled,helped,bookmark', `${at} the bar follows the slide back to the standard set (${b.ids})`)
    check(page.errors.length === 0, `${at} no page errors (${page.errors.join('; ')})`)
    await context.close()
  }
} finally {
  await browser.close()
  await rm(scratch, { recursive: true, force: true })
}

assert.deepEqual(failures, [], `audience reaction sets:\n  ${failures.join('\n  ')}`)
console.log('audience reaction sets DOM: phone 360x740 and 430x932, laptop 1440x900 and 1280x800 — standard, off (Ask only; with questions paused only Note on the phone, no bar on the laptop), replacement set with icons and no bookmark, named bookmark, custom labels in words always, taps send their ids, labels as text, the bar follows the slide')
