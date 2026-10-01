// Ask the speaker against a real live worker: `wrangler dev` (local, throwaway secrets and state,
// nothing deployed), the presenter's own live client, and the real audience page in headless Chromium
// with its real WebSocket. It proves the whole path a question takes: the box, the follow client's
// queue, the worker, the presenter client, and the state the presenter window folds with the same
// functions the preload bridge uses. Checks:
//   - a question typed on the phone reaches the presenter within two seconds, with its slide, name and
//     text exactly as typed, and no other audience socket is told anything about it;
//   - a device that is offline keeps the question and sends it once on reconnect;
//   - Mark answered (the presenter's question.answer) folds it, and the audience is told nothing;
//   - questions paused by the presenter: refusal shown, text kept, and the refused question does not
//     land after the resume;
//   - the per-participant limit (20) is shown plainly and not retried;
//   - a highlight's note sent as a question from the laptop popup (My Notes ticket 02) reaches the presenter
//     within two seconds with its quote, words and slide, once, and the note is marked sent;
//   - a phone note (My Notes ticket 03): saved unticked it sends nothing; ticked it reaches the presenter within
//     two seconds with its words and slide, once, and the note is kept with no quote and marked sent.
// Usage: node scripts/test-ask-live.mjs
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
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
    const value = await read()
    if (predicate(value)) return { value, ms: Date.now() - started }
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out (${timeoutMs} ms) waiting for ${label}; last: ${JSON.stringify(value)}`)
    await sleep(25)
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-ask-live-'))
const worker = await startLiveWorker()
let browser
let presenter
try {
  const entry = join(scratch, 'presenter-side.ts')
  const repo = new URL('..', import.meta.url).pathname
  await writeFile(entry, `export { createLivePresenterClient } from '${repo}src/main/live-presenter-client'\nexport { AUDIENCE_FEEDBACK_START, audienceCountsView, nextAudienceFeedback } from '${repo}src/preload/present-live-state'\n`)
  const bundled = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' })
  const bundlePath = join(scratch, 'presenter-side.mjs')
  await writeFile(bundlePath, bundled.outputFiles[0].text)
  const { createLivePresenterClient, AUDIENCE_FEEDBACK_START, audienceCountsView, nextAudienceFeedback } = await import(pathToFileURL(bundlePath).href)

  const talkSlug = 'ask-live'
  const created = await fetch(`${worker.baseUrl}/sessions`, {
    method: 'POST', headers: { authorization: `Bearer ${worker.adminSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ talkSlug }),
  }).then((response) => response.json())

  // What the presenter window holds: the main process's pushes folded the way the bridge does.
  let feedback = AUDIENCE_FEEDBACK_START
  let status = 'connecting'
  presenter = createLivePresenterClient({
    baseUrl: worker.baseUrl, sessionId: created.sessionId, presenterToken: created.presenterToken,
    latest: { slideId: 'slide-a', reveal: 0, focus: null },
    onStatus: (next) => { status = next },
    onReactionSnapshot: (reactionCounts) => { feedback = nextAudienceFeedback(feedback, { kind: 'snapshot', reactionCounts, questions: feedback.questions }) },
    onReactionCounts: (slideId, counts) => { feedback = nextAudienceFeedback(feedback, { kind: 'reaction', slideId, counts }) },
    onQuestions: (questions) => { feedback = nextAudienceFeedback(feedback, { kind: 'questions', questions }) },
  })
  await until(() => status, (value) => value === 'live', 10_000, 'presenter live')
  const questions = () => feedback.questions

  const FIXTURE = `---
title: Ask live test
auto_title_slide: false
auto_thanks_slide: false
---

### What makes an agent useful? {id=slide-a}

- A chat can tell me how to fill in an expenses form.

### The evolution of agents {id=slide-b}

- AI as oracle
`
  const sourcePath = join(scratch, 'live.md')
  await writeFile(sourcePath, FIXTURE)
  const model = await prepareSource(sourcePath, FIXTURE, 'Ask live test', statSync(sourcePath))
  const htmlPath = join(scratch, 'handout.html')
  await writeFile(htmlPath, buildShareHtml({
    title: 'Ask live test', slug: talkSlug, liveTalkSlug: talkSlug, workerBaseUrl: worker.baseUrl,
    includeNotes: false, license: null, styles: extractStyles(model.fullHtml), slides: extractSlides(model.fullHtml),
  }))

  browser = await chromium.launch({ headless: true })
  const initScript = () => {
    const Native = window.WebSocket
    window.__offline = false
    window.__sockets = []
    window.__frames = []
    window.WebSocket = class extends Native {
      constructor(url, protocols) {
        if (window.__offline) throw new Error('offline')
        super(url, protocols)
        window.__sockets.push(this)
        this.addEventListener('message', (event) => window.__frames.push(String(event.data)))
      }
    }
  }
  const openAudience = async (size) => {
    const context = await browser.newContext({ viewport: { width: size[0], height: size[1] }, hasTouch: size[0] < 700 })
    const page = await context.newPage()
    page.errors = []
    page.on('pageerror', (error) => page.errors.push(error.message))
    await page.addInitScript(initScript)
    await page.goto(pathToFileURL(htmlPath).href + '#slide-a')
    await page.waitForSelector('#rxDock:not([hidden]) .rx-ask', { timeout: 15_000 })
    return { page, context }
  }
  const phone = await openAudience([360, 740])
  const bystander = await openAudience([1440, 900])
  const box = (page) => page.evaluate(() => {
    const panel = document.querySelector('.ask-panel')
    return panel ? { state: panel.getAttribute('data-state'), banner: panel.querySelector('.ask-banner')?.textContent || '', text: panel.querySelector('.ask-text')?.value ?? null, buttons: [...panel.querySelectorAll('.ask-foot button')].map((b) => b.textContent.trim()) } : null
  })
  const ask = async (page, text, name) => {
    await page.click('.rx-ask')
    await page.fill('.ask-text', text)
    if (name !== undefined) await page.fill('.ask-name', name)
    await page.click('[data-act="send"]')
  }

  // 1. Typed on the phone, in the presenter's state within two seconds.
  const started = Date.now()
  await ask(phone.page, 'Why did the agent ask for my password?', 'Priya')
  const arrived = await until(questions, (list) => list.length === 1, 5000, 'the question at the presenter')
  check(Date.now() - started < 2000, `a question reaches the presenter's state in ${Date.now() - started} ms (under 2000)`)
  const first = arrived.value[0]
  check(first.text === 'Why did the agent ask for my password?' && first.name === 'Priya' && first.slideId === 'slide-a' && first.answered === false, `with its text, name and slide (${JSON.stringify(first)})`)
  check(feedback.questionsWaiting === 1 && audienceCountsView(feedback, 'slide-a', 'live').questions === 1, 'the presenter counter says 1 waiting')
  await until(() => phone.page.evaluate(() => document.querySelector('.ask-panel')?.getAttribute('data-state')), (value) => value === 'sent', 5000, 'the box saying sent')
  check(true, 'the phone box says Sent to the speaker')
  await phone.page.click('[data-act="done"]')
  await sleep(500)
  const seen = await bystander.page.evaluate(() => window.__frames.join('\n'))
  check(!seen.includes('Why did the agent ask') && !/questions\.state|question\.ack/.test(seen), 'no other audience socket is told anything about the question')
  const phoneFrames = await phone.page.evaluate(() => window.__frames.join('\n'))
  check(!phoneFrames.includes('questions.state') && !phoneFrames.includes('Priya'), 'the asker is sent nothing but its own ack (no question state)')
  check(!(await bystander.page.evaluate(() => document.body.innerText)).includes('Why did the agent ask'), 'and nothing appears on another audience screen')

  // 2. Offline: kept on the device, sent once on reconnect.
  await phone.page.evaluate(() => { window.__offline = true; for (const socket of window.__sockets) socket.close() })
  await sleep(400)
  await ask(phone.page, 'Asked from a train tunnel')
  await sleep(500)
  let now = await box(phone.page)
  check(now?.state === 'offline' && /Not sent yet/.test(now.banner) && now.buttons.some((b) => /Waiting to send/.test(b)), `offline: the box says Not sent yet and waits (${JSON.stringify(now)})`)
  check(questions().length === 1, 'offline: nothing has reached the presenter yet')
  await phone.page.evaluate(() => { window.__offline = false })
  await until(questions, (list) => list.length === 2, 20_000, 'the queued question after reconnect')
  await sleep(600)
  check(questions().length === 2 && questions().filter((item) => item.text === 'Asked from a train tunnel').length === 1, 'offline: on reconnect it arrives once')
  check((await box(phone.page))?.state === 'sent', 'offline: and the open box says sent')
  await phone.page.click('[data-act="done"]')

  // 3. Mark answered folds it; the audience is told nothing.
  const framesBefore = (await phone.page.evaluate(() => window.__frames.length)) + (await bystander.page.evaluate(() => window.__frames.length))
  presenter.sendPoll({ type: 'question.answer', questionId: first.questionId, answered: true })
  await until(questions, (list) => list.find((item) => item.questionId === first.questionId)?.answered === true, 5000, 'the answered mark')
  check(feedback.questionsWaiting === 1, 'answered: the waiting count drops to 1')
  await sleep(500)
  const framesAfter = (await phone.page.evaluate(() => window.__frames.length)) + (await bystander.page.evaluate(() => window.__frames.length))
  check(framesAfter === framesBefore, `answered: no audience device is told (${framesAfter - framesBefore} frames)`)

  // 4. Questions paused: Ask goes from the bar; a box already open keeps its text, and sending it is
  // refused (shown, text kept); the refused question does not land after the resume.
  await phone.page.click('.rx-ask')
  await phone.page.fill('.ask-text', 'During the pause')
  presenter.sendPoll({ type: 'switches.set', questionsAllowed: false })
  await sleep(700)
  check(await phone.page.evaluate(() => document.querySelector('.rx-ask').hidden === true), 'paused: Ask is gone from the bar within a second')
  await phone.page.click('[data-act="send"]')
  await sleep(600)
  now = await box(phone.page)
  check(now?.state === 'failed' && /not taking questions/.test(now.banner) && now.text === 'During the pause', `paused: the refusal is shown and the text kept (${JSON.stringify(now)})`)
  await phone.page.keyboard.press('Escape')
  presenter.sendPoll({ type: 'switches.set', questionsAllowed: true })
  await sleep(1500)
  check(questions().length === 2, `paused: after the resume the refused question did not land (${questions().length} questions)`)
  // The text is still there; Try again works now.
  await phone.page.click('.rx-ask')
  now = await box(phone.page)
  check(now?.state === 'failed' && now.text === 'During the pause', 'paused: reopening shows the kept text')
  await phone.page.click('[data-act="send"]')
  await until(questions, (list) => list.length === 3 && list.some((item) => item.text === 'During the pause'), 5000, 'Try again after the resume')
  check(true, 'paused: Try again sends it once questions are back on')
  await phone.page.click('[data-act="done"]')

  // 5. The per-participant limit is shown plainly and not retried.
  let sentCount = 3
  while (sentCount < 20) {
    await phone.page.keyboard.press('a')
    await phone.page.fill('.ask-text', `Filler ${sentCount}`)
    await phone.page.keyboard.press('Control+Enter')
    await until(() => phone.page.evaluate(() => document.querySelector('.ask-panel')?.getAttribute('data-state')), (value) => value === 'sent', 5000, `filler ${sentCount} sent`)
    await phone.page.click('[data-act="done"]')
    sentCount++
  }
  check(questions().length === 20, `the twentieth question is in (${questions().length})`)
  await ask(phone.page, 'One too many')
  await sleep(800)
  now = await box(phone.page)
  check(now?.state === 'failed' && /most questions allowed/.test(now.banner) && !now.buttons.some((b) => /Try again/.test(b)), `limit: shown plainly, no Try again (${JSON.stringify(now)})`)
  await sleep(1500)
  check(questions().length === 20, 'limit: not retried')
  // 6. A highlight's note sent from the laptop popup (a second participant): one question, quote + words + slide, within two seconds.
  {
    const already = questions().length
    const laptop = await openAudience([1440, 900])
    await laptop.page.evaluate(() => {
      const walker = document.createTreeWalker(document.querySelector('.stage > .slide.active'), NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        const at = node.textContent.indexOf('fill in an expenses form')
        if (at >= 0) { const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + 24); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); break }
      }
      document.querySelector('.stage').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await laptop.page.waitForSelector('#notePop:not([hidden])')
    await laptop.page.fill('#notePopText', 'Does it need my login for this?')
    const noteStarted = Date.now()
    await laptop.page.click('#notePopSend')
    await laptop.page.evaluate(() => { const b = document.getElementById('notePopSend'); b.click(); b.click() })
    const landed = await until(questions, (list) => list.length === already + 1, 5000, 'the highlight question at the presenter')
    check(Date.now() - noteStarted < 2000, `a highlight's question reaches the presenter's state in ${Date.now() - noteStarted} ms (under 2000)`)
    const q = landed.value[landed.value.length - 1]
    check(q.slideId === 'slide-a' && q.text.includes('fill in an expenses form') && q.text.includes('Does it need my login for this?') && q.answered === false, `with its quote, words and slide (${JSON.stringify(q)})`)
    await laptop.page.waitForFunction(() => !document.getElementById('notePopSentMark').hidden, null, { timeout: 5000 })
    await sleep(600)
    check(questions().length === already + 1, 'sent once, however many presses')
    const marked = await laptop.page.evaluate(() => JSON.parse(localStorage.getItem('html-presentations:notes:ask-live') || '[]').map((n) => ({ words: n.note, sent: Boolean(n.sentAt) })))
    check(marked.length === 1 && marked[0].sent && marked[0].words === 'Does it need my login for this?', `the note is kept and marked sent (${JSON.stringify(marked)})`)
    await laptop.context.close()
  }

  // 7. A note written on a phone (a third participant): unticked sends nothing; ticked sends one question.
  {
    const already = questions().length
    const third = await openAudience([360, 740])
    await third.page.click('.rx-notebtn')
    await third.page.fill('.ask-text', 'Only for me')
    await third.page.click('[data-act="save-note"]')
    await sleep(1200)
    check(questions().length === already, 'a phone note saved unticked sends nothing')
    await third.page.click('.rx-notebtn')
    await third.page.fill('.ask-text', 'Does it need my login for this?')
    await third.page.click('[data-act="tick"]')
    const noteStarted = Date.now()
    await third.page.click('[data-act="save-note"]')
    const landed = await until(questions, (list) => list.length === already + 1, 5000, 'the phone note as a question at the presenter')
    check(Date.now() - noteStarted < 2000, `a ticked phone note reaches the presenter's state in ${Date.now() - noteStarted} ms (under 2000)`)
    const q = landed.value[landed.value.length - 1]
    check(q.slideId === 'slide-a' && q.text === 'Does it need my login for this?' && q.answered === false, `with its words and slide (${JSON.stringify(q)})`)
    await third.page.waitForFunction(() => JSON.parse(localStorage.getItem('html-presentations:notes:ask-live') || '[]').some((n) => n.sentAt), null, { timeout: 5000 })
    await sleep(600)
    check(questions().length === already + 1, 'a ticked phone note is sent once')
    const kept = await third.page.evaluate(() => JSON.parse(localStorage.getItem('html-presentations:notes:ask-live') || '[]').map((n) => ({ words: n.note, type: n.type, quote: n.quote || '', sent: Boolean(n.sentAt) })))
    check(kept.length === 2 && kept.every((n) => n.type === 'slide' && !n.quote) && kept.filter((n) => n.sent).length === 1 && kept.find((n) => n.sent).words === 'Does it need my login for this?', `both notes kept with no quote, only the ticked one marked sent (${JSON.stringify(kept)})`)
    check(await third.page.evaluate(() => document.querySelector('.rx-count')?.textContent === '2'), 'the bar counts both notes')
    // The question that really went out shows in what the person takes away and in the slide list (ticket 04).
    const [download] = await Promise.all([third.page.waitForEvent('download'), third.page.evaluate(() => document.getElementById('notesDownloadMd').click())])
    const md = readFileSync(await download.path(), 'utf8')
    check(md.includes('- Note on the slide: Does it need my login for this?\n  Sent to the speaker as a question') && md.includes('- Note on the slide: Only for me\n') && md.indexOf('Only for me') >= 0, `the Markdown holds both notes and marks the sent one (${JSON.stringify(md)})`)
    await third.page.click('.phone-bar button')
    await sleep(200)
    const marks = await third.page.evaluate(() => document.querySelector('#phoneList .pslide-row[data-index="0"] .mn-marks')?.dataset.marks)
    check(marks === 'note question', `slide 1 in the phone list shows Note and Question (${marks})`)
    check(third.page.errors.length === 0, `no page errors on the phone note (${third.page.errors.join('; ')})`)
    await third.context.close()
  }

  check(phone.page.errors.length === 0 && bystander.page.errors.length === 0, `no page errors (${[...phone.page.errors, ...bystander.page.errors].join('; ')})`)
} catch (error) {
  failures.push(String(error?.stack || error))
} finally {
  try { presenter?.disconnect() } catch {}
  await browser?.close()
  await worker.stop()
  await rm(scratch, { recursive: true, force: true })
}
if (failures.length) {
  console.error(`ask live: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`)
  process.exit(1)
}
console.log('ask live: a real question reaches the presenter state in under two seconds and no other screen; offline queue sends once; Mark answered folds it without telling the audience; a pause refusal keeps the text and does not land after the resume; the participant limit is shown plainly and not retried; a highlight note and a ticked phone note each arrive once with their words and slide')
