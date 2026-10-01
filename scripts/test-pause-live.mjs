// The presenter's phone switches against a real live worker: `wrangler dev` (local, throwaway secrets
// and state, nothing deployed), the presenter's own live client sending switches.set the way the
// presenter window's Live menu does (through the main process's operation queue), and the real audience
// page in headless Chromium (a phone at 360x740 and a laptop at 1440x900) with its real WebSocket.
// Checks, in each of the four states (both on, reactions paused, questions paused, both paused):
//   - the bar on the phone and on the laptop shows what the state leaves (Bookmark stays whenever
//     reactions are paused, including when both are) within three seconds of the presenter's change;
//   - a bookmark tapped while both are paused is accepted and reaches the presenter after the resume;
//   - a page that arrives while both are paused shows Bookmark alone from the worker's snapshot;
//   - turning both back on restores the bar.
// Usage: node scripts/test-pause-live.mjs   (SHOTS=<dir> saves each state; default <OS temp>/tw-r05-shots)
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
    const value = await read()
    if (predicate(value)) return { value, ms: Date.now() - started }
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out (${timeoutMs} ms) waiting for ${label}; last: ${JSON.stringify(value)}`)
    await sleep(25)
  }
}
const SHOTS = process.env.SHOTS || join(tmpdir(), 'tw-r05-shots')

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-pause-live-'))
const worker = await startLiveWorker()
let browser
let presenter
try {
  await mkdir(SHOTS, { recursive: true })
  const entry = join(scratch, 'presenter-side.ts')
  const repo = new URL('..', import.meta.url).pathname
  await writeFile(entry, `export { createLivePresenterClient } from '${repo}src/main/live-presenter-client'\nexport { AUDIENCE_FEEDBACK_START, nextAudienceFeedback } from '${repo}src/preload/present-live-state'\n`)
  const bundled = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' })
  const bundlePath = join(scratch, 'presenter-side.mjs')
  await writeFile(bundlePath, bundled.outputFiles[0].text)
  const { createLivePresenterClient, AUDIENCE_FEEDBACK_START, nextAudienceFeedback } = await import(pathToFileURL(bundlePath).href)

  const talkSlug = 'pause-live'
  const created = await fetch(`${worker.baseUrl}/sessions`, {
    method: 'POST', headers: { authorization: `Bearer ${worker.adminSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ talkSlug }),
  }).then((response) => response.json())
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

  const FIXTURE = `---
title: Pause live test
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
  const model = await prepareSource(sourcePath, FIXTURE, 'Pause live test', statSync(sourcePath))
  const htmlPath = join(scratch, 'handout.html')
  await writeFile(htmlPath, buildShareHtml({
    title: 'Pause live test', slug: talkSlug, liveTalkSlug: talkSlug, workerBaseUrl: worker.baseUrl,
    includeNotes: false, license: null, styles: extractStyles(model.fullHtml), slides: extractSlides(model.fullHtml),
  }))
  browser = await chromium.launch({ headless: true })
  const openAudience = async (size) => {
    const context = await browser.newContext({ viewport: { width: size[0], height: size[1] }, hasTouch: size[0] < 700 })
    const page = await context.newPage()
    page.errors = []
    page.on('pageerror', (error) => page.errors.push(error.message))
    await page.goto(pathToFileURL(htmlPath).href + '#slide-a')
    await page.waitForSelector('#rxDock:not([hidden]) .rx-bar', { state: 'attached', timeout: 15_000 })
    return { page, context }
  }
  const shape = (page) => page.evaluate(() => {
    const dock = document.getElementById('rxDock')
    const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none'
    return { buttons: dock.hidden ? [] : [...dock.querySelectorAll('.rx, .rx-ask')].filter(shown).map((b) => b.dataset.rx || 'ask'), note: dock.querySelector('.rx-note')?.textContent.trim() || '' }
  })
  const phone = await openAudience([360, 740])
  const laptop = await openAudience([1440, 900])
  const STATES = [
    ['both-on', { questionsAllowed: true, reactionsAllowed: true }, ['puzzled', 'helped', 'bookmark', 'ask'], ''],
    ['reactions-paused', { questionsAllowed: true, reactionsAllowed: false }, ['bookmark', 'ask'], 'The speaker has paused reactions'],
    ['questions-paused', { questionsAllowed: false, reactionsAllowed: true }, ['puzzled', 'helped', 'bookmark'], 'The speaker is not taking questions right now'],
    ['both-paused', { questionsAllowed: false, reactionsAllowed: false }, ['bookmark'], 'The speaker has paused reactions and questions'],
    ['both-on-again', { questionsAllowed: true, reactionsAllowed: true }, ['puzzled', 'helped', 'bookmark', 'ask'], ''],
  ]
  let bothPausedShot = false
  for (const [name, switches, buttons, note] of STATES) {
    if (name !== 'both-on') presenter.sendPoll({ type: 'switches.set', ...switches })
    const started = Date.now()
    for (const [where, { page }] of [['phone', phone], ['laptop', laptop]]) {
      const { ms } = await until(() => shape(page), (value) => value.buttons.join() === buttons.join() && (note ? value.note === note : !/paused|not taking/.test(value.note)), 6000, `${where} ${name}`)
      check(Date.now() - started < 3000, `${name}: the ${where} bar shows ${buttons.join('+')}${note ? ` with "${note}"` : ''} ${Date.now() - started} ms after the presenter's change (under 3000; waited ${ms})`)
    }
    await phone.page.screenshot({ path: join(SHOTS, `live-phone-${name}-360x740.png`) })
    await laptop.page.screenshot({ path: join(SHOTS, `live-laptop-${name}-1440x900.png`) })
    if (name === 'both-paused' && !bothPausedShot) {
      bothPausedShot = true
      // Bookmark while both are paused: accepted by the worker; the presenter's count follows the resume.
      await phone.page.click('.rx[data-rx="bookmark"]')
      await sleep(600)
      check(await phone.page.evaluate(() => document.querySelector('.rx[data-rx="bookmark"]').getAttribute('aria-pressed')) === 'true' && !/could not|Could not/.test((await shape(phone.page)).note),
        'both paused: a bookmark is accepted by the worker (marked, no refusal shown)')
      check(!feedback.reactionCounts['slide-a'] || !feedback.reactionCounts['slide-a'].bookmark, 'both paused: the presenter is not sent counts during the pause')
      // A page that arrives now is set from the worker's snapshot.
      const late = await openAudience([360, 740])
      const lateShape = await until(() => shape(late.page), (value) => value.buttons.join() === 'bookmark', 6000, 'the late page set from the snapshot')
      check(lateShape.value.buttons.join() === 'bookmark' && lateShape.value.note === note, `both paused: a page arriving now shows Bookmark alone from the snapshot (${JSON.stringify(lateShape.value)})`)
      await late.context.close()
    }
  }
  await until(() => feedback.reactionCounts['slide-a']?.bookmark, (value) => value === 1, 5000, 'the bookmark at the presenter after the resume')
  check(true, 'after the resume the presenter counts the bookmark made during the pause')
  check(phone.page.errors.length === 0 && laptop.page.errors.length === 0, `no page errors (${[...phone.page.errors, ...laptop.page.errors].join('; ')})`)
} catch (error) {
  failures.push(String(error?.stack || error))
} finally {
  try { presenter?.disconnect() } catch {}
  await browser?.close()
  await worker.stop()
  await rm(scratch, { recursive: true, force: true })
}
if (failures.length) {
  console.error(`pause live: ${failures.length} failure(s)\n - ${failures.join('\n - ')}`)
  process.exit(1)
}
console.log('pause live: against a real worker, the presenter\'s switches.set reaches a following phone and laptop within three seconds in each of the four states; Bookmark stays whenever reactions are paused and its count reaches the presenter after the resume; a page arriving during a pause is set from the snapshot; both back on restores the bar')
