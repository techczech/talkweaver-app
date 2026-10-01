// The reaction bar against a real live worker: `wrangler dev` (local, throwaway secrets and state,
// nothing deployed), the presenter's own live client, and the real audience page in headless
// Chromium with its real WebSocket. It proves the whole path a tap takes: the bar, the follow client's
// queue, the worker, the presenter client, and the counts the status bar shows for the slide on
// screen (the same functions the preload bridge folds them with). Checks:
//   - a tap reaches the presenter's chip in under two seconds; replace, undo and bookmark net out;
//   - the chip follows the slide the presenter moves to;
//   - a device that drops offline keeps its taps and sends them once, in order, on reconnect;
//   - reactions paused by the presenter: the meaning reactions go and Bookmark stays; a tap made while
//     the phone was offline is refused when it reconnects (shown, mark not kept) and does not land after
//     the resume; the bookmark still counts once reactions resume.
// Usage: node scripts/test-reaction-bar-live.mjs
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { startLiveWorker } from './lib/live-worker-harness.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const failures = []
const check = (ok, label) => { if (!ok) failures.push(label); else console.log(`  ok  ${label}`) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(read, predicate, timeoutMs, label) {
  const started = Date.now()
  for (;;) {
    const value = read()
    if (predicate(value)) return { value, ms: Date.now() - started }
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out (${timeoutMs} ms) waiting for ${label}; last: ${JSON.stringify(value)}`)
    await sleep(25)
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-reaction-live-'))
const worker = await startLiveWorker()
let browser
let presenter
try {
  // The presenter's own client and its status-bar folding, bundled for node.
  const entry = join(scratch, 'presenter-side.ts')
  const repo = new URL('..', import.meta.url).pathname
  await writeFile(entry, `export { createLivePresenterClient } from '${repo}src/main/live-presenter-client'\nexport { AUDIENCE_FEEDBACK_START, audienceCountsView, nextAudienceFeedback } from '${repo}src/preload/present-live-state'\n`)
  const bundled = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' })
  const bundlePath = join(scratch, 'presenter-side.mjs')
  await writeFile(bundlePath, bundled.outputFiles[0].text)
  const { createLivePresenterClient, AUDIENCE_FEEDBACK_START, audienceCountsView, nextAudienceFeedback } = await import(pathToFileURL(bundlePath).href)

  const talkSlug = 'reaction-bar-live'
  const created = await fetch(`${worker.baseUrl}/sessions`, {
    method: 'POST', headers: { authorization: `Bearer ${worker.adminSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ talkSlug }),
  }).then((response) => response.json())

  // What the presenter's status bar holds: the main process's pushes folded the way the bridge does.
  let feedback = AUDIENCE_FEEDBACK_START
  let currentSlide = 'slide-a'
  let status = 'connecting'
  const chip = () => audienceCountsView(feedback, currentSlide, status).reactions
  presenter = createLivePresenterClient({
    baseUrl: worker.baseUrl, sessionId: created.sessionId, presenterToken: created.presenterToken,
    latest: { slideId: 'slide-a', reveal: 0, focus: null },
    onStatus: (next) => { status = next },
    onReactionSnapshot: (reactionCounts) => { feedback = nextAudienceFeedback(feedback, { kind: 'snapshot', reactionCounts, questions: [] }) },
    onReactionCounts: (slideId, counts) => { feedback = nextAudienceFeedback(feedback, { kind: 'reaction', slideId, counts }) },
    onQuestions: (questions) => { feedback = nextAudienceFeedback(feedback, { kind: 'questions', questions }) },
  })
  await until(() => status, (value) => value === 'live', 10_000, 'presenter live')

  // The real audience page for the same talk, pointed at the local worker.
  const FIXTURE = `---
title: Reaction bar live test
auto_title_slide: false
auto_thanks_slide: false
---

### What makes an agent useful? {id=slide-a}

- A chat can tell me how to fill in an expenses form.

### The evolution of agents {id=slide-b}

- AI as oracle

### How is the pace?
{id=slide-c} {reactions="Too fast","Just right","Too slow"}

- The pace question.

### Not all agents are agents
{id=slide-d} {reactions=agree,disagree}

- Some are workflows with a chat box.
`
  const sourcePath = join(scratch, 'live.md')
  await writeFile(sourcePath, FIXTURE)
  const model = await prepareSource(sourcePath, FIXTURE, 'Reaction bar live test', statSync(sourcePath))
  const html = buildShareHtml({
    title: 'Reaction bar live test', slug: talkSlug, liveTalkSlug: talkSlug, workerBaseUrl: worker.baseUrl,
    includeNotes: false, license: null, styles: extractStyles(model.fullHtml), slides: extractSlides(model.fullHtml),
  })
  const htmlPath = join(scratch, 'handout.html')
  await writeFile(htmlPath, html)

  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true })
  const page = await context.newPage()
  page.errors = []
  page.on('pageerror', (error) => page.errors.push(error.message))
  await page.addInitScript(() => {
    // The real WebSocket, watched: the test can cut it and hold a device offline.
    const Native = window.WebSocket
    window.__offline = false
    window.__sockets = []
    window.WebSocket = class extends Native {
      constructor(url, protocols) {
        if (window.__offline) throw new Error('offline')
        super(url, protocols)
        window.__sockets.push(this)
      }
    }
  })
  await page.goto(pathToFileURL(htmlPath).href + '#slide-a')
  await page.waitForSelector('#rxDock:not([hidden]) .rx', { timeout: 15_000 })
  const shown = () => page.evaluate(() => ({
    pressed: [...document.querySelectorAll('.rx[aria-pressed="true"]')].map((b) => b.dataset.rx),
    note: document.querySelector('.rx-note')?.textContent || '',
    slide: document.querySelector('.slide.active')?.dataset.id,
    words: document.querySelector('.rx-bar')?.classList.contains('words'),
  }))
  const tap = (id) => page.click(`.rx[data-rx="${id}"]`)
  const chipIs = (puzzled, helped, bookmark) => (value) => value && value.puzzled === puzzled && value.helped === helped && value.bookmark === bookmark

  // 1. A tap reaches the presenter's chip in under two seconds.
  let started = Date.now()
  await tap('puzzled')
  let seen = await until(chip, chipIs(1, 0, 0), 5000, 'puzzled 1 on the chip')
  check(Date.now() - started < 2000, `a tap reaches the presenter's chip in ${Date.now() - started} ms (under 2000)`)
  await tap('helped')
  seen = await until(chip, chipIs(0, 1, 0), 5000, 'replacement')
  check(true, `replacing Puzzled with Helped nets to helped 1, puzzled 0 (${seen.ms} ms)`)
  await tap('bookmark')
  await until(chip, chipIs(0, 1, 1), 5000, 'bookmark')
  check(true, 'the bookmark counts beside the meaning reaction')
  await tap('helped')
  await until(chip, chipIs(0, 0, 1), 5000, 'undo')
  check(true, 'tapping the selected reaction again takes it back (the chip goes down)')
  check((await shown()).pressed.join() === 'bookmark', 'the device shows only the bookmark held')

  // 2. The chip follows the slide the presenter moves to.
  currentSlide = 'slide-b'
  presenter.publish('slide-b', 0, null)
  await page.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'slide-b', null, { timeout: 5000 })
  check(chip() && chipIs(0, 0, 0)(chip()), 'the chip shows zeros on the new slide')
  const afterMove = await shown()
  check(afterMove.words === false, 'icons after the first reaction, on the next slide')
  await tap('puzzled')
  await until(chip, chipIs(1, 0, 0), 5000, 'puzzled on slide b')
  check(feedback.reactionCounts['slide-a']?.bookmark === 1 && feedback.reactionCounts['slide-b']?.puzzled === 1, 'counts are kept per slide')

  // 3. Offline: taps queue on the device and send once, in order, when it reconnects.
  await page.evaluate(() => { window.__offline = true; for (const socket of window.__sockets) socket.close() })
  await sleep(300)
  await tap('helped')
  await tap('bookmark')
  await sleep(400)
  let now = await shown()
  check(now.note === 'Will send when your phone reconnects', `offline: the tap says it will send later (${now.note})`)
  check(chipIs(1, 0, 0)(chip()), 'offline: nothing has reached the presenter yet')
  await page.evaluate(() => { window.__offline = false })
  await until(chip, chipIs(0, 1, 1), 20_000, 'queued reactions after reconnect')
  await sleep(500)
  check(chipIs(0, 1, 1)(chip()), `offline: on reconnect Helped replaced Puzzled and the bookmark landed, each once (${JSON.stringify(feedback.reactionCounts['slide-b'])})`)

  // 4. Reactions paused. A phone that is online hides the meaning reactions and keeps Bookmark (the
  // pause reaches it in well under three seconds); a tap made while the phone was offline and so had not
  // heard is refused as reactions_paused when it reconnects: shown, mark not kept, and it does not land
  // after the resume.
  await page.evaluate(() => { window.__offline = true; for (const socket of window.__sockets) socket.close() })
  await sleep(400)
  presenter.sendPoll({ type: 'switches.set', reactionsAllowed: false })
  await sleep(600)
  await tap('puzzled')
  await sleep(300)
  await page.evaluate(() => { window.__offline = false })
  for (let waited = 0; waited < 20_000; waited += 100) {
    now = await shown()
    if (!now.pressed.includes('puzzled') && now.note === 'The speaker has paused reactions') break
    await sleep(100)
  }
  check(now.note === 'The speaker has paused reactions' && !now.pressed.includes('puzzled'), `paused: the refusal is shown and the mark is not kept (${now.note} / ${now.pressed})`)
  const barNow = await page.evaluate(() => ({ puzzled: document.querySelector('.rx[data-rx="puzzled"]').hidden, helped: document.querySelector('.rx[data-rx="helped"]').hidden, bookmark: document.querySelector('.rx[data-rx="bookmark"]').hidden }))
  check(barNow.puzzled && barNow.helped && !barNow.bookmark, `paused: the meaning reactions are hidden and Bookmark stays (${JSON.stringify(barNow)})`)
  presenter.sendPoll({ type: 'switches.set', reactionsAllowed: true })
  await sleep(1500)
  check(chipIs(0, 1, 1)(chip()), `paused: after the resume the chip is helped 1, bookmark 1 and the refused puzzled did not land (${JSON.stringify(feedback.reactionCounts['slide-b'])})`)

  // 5. A slide's own set (ticket 04): the worker takes a custom label and a replacement reaction, and
  // the presenter's counts for that slide carry them by their stored ids.
  currentSlide = 'slide-c'
  presenter.publish('slide-c', 0, null)
  await page.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'slide-c', null, { timeout: 5000 })
  const setNow = await page.evaluate(() => [...document.querySelectorAll('.rx')].filter((b) => !b.hidden).map((b) => b.dataset.rx))
  check(setNow.join('|') === 'custom:Too fast|custom:Just right|custom:Too slow', `custom slide: the bar offers the labels (${setNow.join('|')})`)
  started = Date.now()
  await tap('custom:Just right')
  await until(chip, (value) => value && value['custom:Just right'] === 1, 5000, 'custom label on the chip')
  check(Date.now() - started < 2000, `a custom-label tap reaches the presenter in ${Date.now() - started} ms`)
  await tap('custom:Too slow')
  await until(chip, (value) => value && value['custom:Too slow'] === 1 && !value['custom:Just right'], 5000, 'custom replacement')
  check(true, 'one meaning reaction per slide holds for custom labels (Too slow replaced Just right)')
  currentSlide = 'slide-d'
  presenter.publish('slide-d', 0, null)
  await page.waitForFunction(() => document.querySelector('.slide.active')?.dataset.id === 'slide-d', null, { timeout: 5000 })
  const agreeNow = await page.evaluate(() => [...document.querySelectorAll('.rx')].filter((b) => !b.hidden).map((b) => b.dataset.rx))
  check(agreeNow.join() === 'agree,disagree', `replacement slide: Agree and Disagree, no bookmark (${agreeNow})`)
  await tap('disagree')
  await until(chip, (value) => value && value.disagree === 1, 5000, 'disagree on the chip')
  check(true, 'a replacement reaction is taken by the worker and counted for its slide')
  check(page.errors.length === 0, `no page errors (${page.errors.join('; ')})`)
} catch (error) {
  failures.push(String(error?.stack || error))
} finally {
  try { presenter?.disconnect() } catch {}
  await browser?.close()
  await worker.stop()
  await rm(scratch, { recursive: true, force: true })
}
if (failures.length) {
  console.error(`reaction bar live: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`)
  process.exit(1)
}
console.log('reaction bar live: a real tap reaches the presenter chip in under two seconds; replace, undo, bookmark, slide change, offline queue and pause refusal all behave against the local worker')
