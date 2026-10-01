// Ticket 04: the presenter chip follows the slide's own reactions (round-2 D3, D4, D11). The compiled
// presenter window in headless Chromium with the recording preload (and through it the live bridge)
// bundled against a stub of electron, fed by the main process's live:status and live:audience pushes
// exactly as in test-presenter-status-bar.mjs § 3b. Seams: the compiled slide's data-reactions, the
// live bridge's counts for the slide on screen (audienceCountsView), and the chip's DOM and tooltip.
//   - standard slide: three icons with counts, as before;
//   - {reactions=agree,disagree}: thumbs-up and thumbs-down with their counts (D3);
//   - {reactions="Too fast","Just right","Too slow"}: numbers only, "2 · 14 · 1", the labels with
//     their counts in the tooltip (D11), in the labels' order;
//   - {reactions=off}: the chip is gone, the questions counter stays (D4);
//   - paused reactions keep the paused tooltip over a custom chip's labels.
// Usage: node scripts/test-presenter-reaction-sets.mjs   (SHOTS=<dir> saves D3, D4, D11 at 1440x900)
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const SHOTS = process.env.SHOTS ? resolve(process.env.SHOTS) : null
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }

const FIXTURE = `---
title: The current state of AI agents
auto_title_slide: false
auto_thanks_slide: false
---

### What makes an agent useful? {id=std}

- A chat can tell me how to fill in an expenses form.
- An agent can find the form and fill it in.

### Not all agents are agents
{id=agree} {reactions=agree,disagree}

- Some are workflows with a chat box.

### Join the newsletter
{id=off} {reactions=off}

- ainewsroundup.pages.dev

### This means 2026 is the year of agents
{id=custom} {reactions="Too fast","Just right","Too slow"}
`

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-reaction-chip-'))
let browser
try {
  const sourcePath = join(scratch, 'chip.md')
  await writeFile(sourcePath, FIXTURE)
  const model = await prepareSource(sourcePath, FIXTURE, 'The current state of AI agents', statSync(sourcePath))
  const htmlPath = join(scratch, 'chip-present.html')
  await writeFile(htmlPath, model.fullHtml)
  const stubPath = join(scratch, 'electron-stub.mjs')
  await writeFile(stubPath, `const answers = { 'recording:context': { testMode: true, talkSlug: 'chip', discardThresholdMs: 0 }, 'live:status': 'ended', 'live:snapshot': {}, 'live:switches': { success: true } }
window.__ipcCalls = []; window.__ipcOn = {}
export const ipcRenderer = {
  invoke: async (channel, ...args) => { window.__ipcCalls.push(channel); return channel in answers ? answers[channel] : {} },
  on(channel, fn) { (window.__ipcOn[channel] ||= []).push(fn) }, send() {}, removeListener() {}
}
window.__push = (channel, value) => { for (const fn of window.__ipcOn[channel] || []) fn(null, value) }
export const contextBridge = { exposeInMainWorld: (name, api) => { window[name] = api } }
export const clipboard = { writeText() {} }
`)
  const bundle = await build({ entryPoints: [join(repo, 'src/preload/present-recorder.ts')], bundle: true, write: false, format: 'iife', platform: 'browser', alias: { electron: stubPath }, logLevel: 'silent' })
  const preload = bundle.outputFiles[0].text

  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript({ content: `if (window === window.top) {\n${preload}\n}` })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${pathToFileURL(htmlPath).href}?presenter=1#std`, { waitUntil: 'load', timeout: 120000 })
  await page.waitForFunction(() => /scale\(([\d.]+)\)/.test(document.querySelector('#currentPreview iframe')?.style.transform || ''), null, { timeout: 30000 })
  await page.waitForSelector('#presenterStatus #twrec-module', { timeout: 10000 }).catch(() => {})
  if (await page.isVisible('#twResume')) await page.click('#twResumeNo')
  await page.mouse.move(5, 500)
  const settle = (ms = 300) => page.waitForTimeout(ms)
  const chip = () => page.evaluate(() => {
    const el = document.getElementById('presenterReactions')
    const q = document.getElementById('presenterQuestions')
    const shown = !!el && !el.hidden && el.getClientRects().length > 0
    return {
      shown,
      text: shown ? el.innerText.replace(/\s+/g, ' ').trim() : null,
      names: shown ? [...el.querySelectorAll(':scope > [data-rx]')].map((span) => span.getAttribute('aria-label')).join(' | ') : null,
      icons: shown ? [...el.querySelectorAll('svg')].map((svg) => [...svg.classList].find((c) => c.startsWith('lucide-'))).filter((c) => c !== 'lucide-pause').join(' ') : null,
      tip: el?.dataset.tip || '',
      questions: q && !q.hidden ? q.innerText.trim() : null,
      inBar: !!el?.closest('#presenterStatus'),
      barOverflow: document.getElementById('presenterTopBar') ? document.getElementById('presenterTopBar').scrollWidth > document.getElementById('presenterTopBar').clientWidth + 1 : false,
    }
  })
  const goTo = async (id) => {
    for (let i = 0; i < 8 && (await page.evaluate(() => location.hash)) !== `#${id}`; i++) {
      const at = await page.evaluate((target) => { const ids = [...document.querySelectorAll('.stage > .slide, .slide')].map((s) => s.dataset.id); return [ids.indexOf(location.hash.slice(1)), ids.indexOf(target)] }, id)
      await page.keyboard.press(at[0] < at[1] ? 'ArrowRight' : 'ArrowLeft'); await settle(250)
    }
    await settle(400)
  }
  const shot = async (name) => { if (SHOTS) { await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, name) }) } }

  await page.evaluate(() => window.__push('live:status', 'live')); await settle()
  await page.evaluate(() => window.__push('live:audience', {
    kind: 'snapshot',
    reactionCounts: {
      std: { puzzled: 2, helped: 5, bookmark: 1 },
      agree: { agree: 11, disagree: 4, puzzled: 7 },
      custom: { 'custom:Too fast': 2, 'custom:Just right': 14, 'custom:Too slow': 1 },
      off: { puzzled: 3 },
    },
    questions: [{ answered: false }, { answered: false }, { answered: false }, { answered: false }, { answered: true }],
  })); await settle()

  let c = await chip()
  check(c.shown && c.text === '2 5 1' && c.icons === 'lucide-frown lucide-lightbulb lucide-bookmark', `standard slide: the three standard counts with their icons (${JSON.stringify(c)})`)
  check(c.names === 'Puzzled by this: 2 | Helped me understand: 5 | Bookmarked: 1', `standard slide: named counts (${c.names})`)

  await goTo('agree')
  c = await chip()
  check(c.shown && c.text === '11 4' && c.icons === 'lucide-thumbs-up lucide-thumbs-down', `D3 replacement set: Agree and Disagree with their icons, nothing else (${JSON.stringify(c)})`)
  check(c.names === 'Agree: 11 | Disagree: 4', `D3: each count named (${c.names})`)
  check(c.questions === '4' && c.inBar && !c.barOverflow, `D3: the questions counter beside it, all in the status bar (${JSON.stringify(c)})`)
  await page.mouse.move(700, 450)
  await shot('D3-chip-agree-disagree-1440x900.png')

  await goTo('custom')
  c = await chip()
  check(c.shown && c.text === '2 · 14 · 1' && c.icons === '', `D11 custom labels: numbers only, in the labels' order (${JSON.stringify(c)})`)
  check(c.tip === 'Too fast 2 · Just right 14 · Too slow 1', `D11: the labels with their counts in the tooltip (${c.tip})`)
  check(c.names === 'Too fast: 2 | Just right: 14 | Too slow: 1', `D11: each number named for a screen reader (${c.names})`)
  const box = await page.evaluate(() => { const r = document.getElementById('presenterReactions').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })
  await page.mouse.move(box[0], box[1]); await settle(500)
  const tipShown = await page.evaluate(() => document.querySelector('.tw-tip:not([hidden]) .tw-tip-name')?.textContent || document.querySelector('.tw-tip:not([hidden])')?.textContent || '')
  check(tipShown.includes('Too fast 2 · Just right 14 · Too slow 1'), `D11: hovering the chip shows the labels (${tipShown})`)
  await shot('D11-chip-custom-labels-1440x900.png')
  // A live count for this slide updates the numbers and the tooltip.
  await page.evaluate(() => window.__push('live:audience', { kind: 'reaction', slideId: 'custom', counts: { 'custom:Too fast': 3, 'custom:Just right': 14, 'custom:Too slow': 1 } })); await settle()
  c = await chip()
  check(c.text === '3 · 14 · 1' && c.tip === 'Too fast 3 · Just right 14 · Too slow 1', `D11: a live update changes number and tooltip (${JSON.stringify(c)})`)
  await page.mouse.move(5, 500)

  await goTo('off')
  c = await chip()
  check(!c.shown && c.questions === '4', `D4 reactions off: the chip is gone, the questions counter stays (${JSON.stringify(c)})`)
  await page.mouse.move(700, 450)
  await shot('D4-chip-reactions-off-1440x900.png')
  await page.mouse.move(5, 500)

  await goTo('std')
  c = await chip()
  check(c.shown && c.text === '2 5 1' && c.icons === 'lucide-frown lucide-lightbulb lucide-bookmark' && c.names === 'Puzzled by this: 2 | Helped me understand: 5 | Bookmarked: 1', `back on the standard slide: the standard chip again (${JSON.stringify(c)})`)
  check(c.tip === 'Reactions to this slide', `standard slide: the standard tooltip, not a custom one left behind (${c.tip})`)

  // Paused reactions: the paused tooltip wins over the custom labels while the switch is off.
  await goTo('custom')
  await page.click('#presenterMenuPoll'); await settle()
  await page.click('#liveAllowReactions'); await settle()
  await page.keyboard.press('Escape'); await settle()
  c = await chip()
  check(c.shown && c.text.startsWith('3 · 14 · 1') && /paused/i.test(c.tip), `paused: the custom chip keeps its counts, the tooltip says paused (${JSON.stringify(c)})`)
  await page.click('#presenterMenuPoll'); await settle()
  await page.click('#liveAllowReactions'); await settle()
  await page.keyboard.press('Escape'); await settle()
  c = await chip()
  check(c.tip === 'Too fast 3 · Just right 14 · Too slow 1', `resumed: the labels come back to the tooltip (${c.tip})`)

  await page.evaluate(() => window.__push('live:status', 'ended')); await settle()
  c = await chip()
  check(!c.shown && c.questions === null, `ended: chip and counter go (${JSON.stringify(c)})`)
  check(errors.length === 0, `no page errors (${errors.join('; ')})`)
  await context.close()

  assert.deepEqual(failures, [], `presenter reaction sets:\n  ${failures.join('\n  ')}`)
  console.log('presenter reaction sets: the chip follows the slide — standard icons, a replacement set (D3), custom labels as numbers with the labels in the tooltip (D11), gone on reactions off with the counter kept (D4), paused tooltip wins')
} finally {
  await browser?.close()
  await rm(scratch, { recursive: true, force: true })
}
