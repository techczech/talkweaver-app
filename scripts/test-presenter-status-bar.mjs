// Presenter status bar (ADR-0031 §2 and §5, presenter redesign ticket 02). The compiled presenter
// window in headless Chromium, with the recording preload (and through it the live bridge) bundled
// against a stub of electron and injected as the app injects it. Seams:
//  1. the timer's state functions through their controls: clicking the clock pauses and resumes,
//     P still does, the popover sets the length, presets and reminders and resets the timer
//     without touching a recording;
//  2. live status (the live bridge's "live:status" push) appears in one place, the status bar,
//     and End live there ends the session; "Not live" is a button there ("Go live  G") that
//     starts going live, the command of Live menu → Go live and G (Dominik, preview.8, 28 Sep);
//  3. reactions and questions render only when supplied (a fixture through
//     twLivePollBridge.onAudience, the call a live feature will make), and the live bridge's own
//     onAudience feeds them for the slide on screen from the main process's live:audience pushes;
//  4. the top bar at 1280x800, 1440x900 and 1728x1117 in the idle, L1 and L2 states: no label
//     wraps, nothing clips, no horizontal overflow, only the chrome sizes 26 / 16 / 14 / 13px, one
//     UI typeface (monospace for clock, counter and recorded length), and the collapse steps
//     reached are the drawn order c1-c10, never further than surfaces-drawn.md's table.
// Every check is collected and all failures are reported together.
// Usage: node scripts/test-presenter-status-bar.mjs
//   SHOTS=<dir> also saves idle / L1 at the three sizes and the clock popover at 1440x900.
//   DECK=<compiled deck.html> uses that deck instead of the fixture (the build shots use the demo
//   talk); its slides SLIDE_IDLE / SLIDE_L1 (ids) default to the first slide and the fixture's.
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
// Checks that depend on the fixture's content (its 30-minute length, its timed section) skip for DECK.
const FIXTURE_DECK = !process.env.DECK
const SIZES = [[1280, 800], [1440, 900], [1728, 1117]]
const CHROME_SIZES = [13, 14, 16, 26]
const ORDER = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10']
// surfaces-drawn.md, "Where each applies": the furthest step each drawn state reaches.
const DRAWN_REACH = { 'idle-1280': 0, 'idle-1440': 0, 'idle-1728': 0, 'L1-1280': 3, 'L1-1440': 1, 'L1-1728': 0, 'L2-1440': 3, 'L2-1728': 0 }
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }
// A control that is missing is a failure to report, not a reason to stop the run.
const tap = async (page, selector) => { try { await page.click(selector, { timeout: 2000 }) } catch { failures.push(`no control to click: ${selector}`) } }

const FIXTURE = `---
title: The current state of AI agents
duration: 30min
auto_title_slide: false
auto_thanks_slide: false
---

### The current state of AI agents {id=one}

From Codex and ChatGPT Work and more

## Where agents came from
{timer=10min}

### The evolution of agents {id=two}

- AI as oracle
- AI as tool maker
- AI as tool user

:::notes
Three stages, and the room will know the first two.
:::

### What makes an agent useful? {id=three}

- A chat can tell me how to fill in an expenses form.
- An agent can find the form and fill it in.
`

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-status-bar-'))
let browser
try {
  let htmlPath = process.env.DECK ? resolve(process.env.DECK) : null
  if (!htmlPath) {
    const sourcePath = join(scratch, 'status.md')
    await writeFile(sourcePath, FIXTURE)
    const model = await prepareSource(sourcePath, FIXTURE, 'The current state of AI agents', statSync(sourcePath))
    htmlPath = join(scratch, 'status-present.html')
    await writeFile(htmlPath, model.fullHtml)
  }
  const SLIDE_IDLE = process.env.SLIDE_IDLE || (process.env.DECK ? '' : 'one')
  const SLIDE_L1 = process.env.SLIDE_L1 || 'two'
  // The recording preload as the app ships it; electron stubbed. invoke() answers the channels the
  // preloads call and logs them; on() keeps the handlers so the test can push live status.
  const stubPath = join(scratch, 'electron-stub.mjs')
  await writeFile(stubPath, `const answers = { 'recording:context': { testMode: true, talkSlug: 'status', discardThresholdMs: 0 }, 'live:status': 'ended', 'live:snapshot': {}, 'live:end': { success: true, status: 'ended' }, 'live:go': { success: true, status: 'connecting', shortUrl: 'https://handouts.fyi/737u', qrSvg: '' } }
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
  // The audience-counts fixture: the call a live reactions / questions feature makes.
  const audienceFixture = `if (window === window.top && window.twLivePollBridge) window.twLivePollBridge.onAudience = (cb) => { window.__audience = cb }`

  browser = await chromium.launch({ headless: true })
  const open = async ([width, height], slide, { fixture = true } = {}) => {
    const context = await browser.newContext({ viewport: { width, height } })
    await context.addInitScript({ content: `if (window === window.top) {\n${preload}\n}` })
    if (fixture) await context.addInitScript({ content: audienceFixture })
    const page = await context.newPage()
    page.errors = []
    page.on('pageerror', (error) => page.errors.push(error.message))
    page.dialogs = []
    page.dialogAnswer = true
    page.on('dialog', (dialog) => { page.dialogs.push(dialog.message()); if (page.dialogAnswer) dialog.accept(); else dialog.dismiss() })
    await page.goto(`${pathToFileURL(htmlPath).href}?presenter=1${slide ? `#${slide}` : ''}`, { waitUntil: 'load', timeout: 120000 })
    await page.waitForFunction(() => /scale\(([\d.]+)\)/.test(document.querySelector('#currentPreview iframe')?.style.transform || ''), null, { timeout: 30000 })
    await page.waitForSelector('#presenterStatus #twrec-module', { timeout: 10000 }).catch(() => {})
    if (await page.isVisible('#twResume')) await tap(page, '#twResumeNo')
    await page.mouse.move(5, 500)
    return { page, context }
  }
  const settle = (page, ms = 250) => page.waitForTimeout(ms)
  const state = (page) => page.evaluate(() => {
    const clock = document.getElementById('twClock')
    const start = document.getElementById('twStartTimerBtn')
    const pop = document.getElementById('twDurationSetter')
    return {
      clock: clock?.textContent, status: clock?.dataset.status, clockTip: document.getElementById('twClockBtn')?.dataset.tip,
      startShown: !!start && !start.hidden && start.getBoundingClientRect().width > 0, startTip: start?.dataset.tip,
      popOpen: !!pop && !pop.hidden, expanded: document.getElementById('twDurationBtn')?.getAttribute('aria-expanded'),
      rec: document.getElementById('twrec-module')?.dataset.rec, recClock: document.getElementById('twrec-clock')?.textContent,
      remind10: document.querySelector('.tw-reminder[data-remind="10"]')?.getAttribute('aria-pressed'),
      input: document.getElementById('twDurationInput')?.value
    }
  })

  // ── 1. The timer through its controls ─────────────────────────────────────────────────────
  {
    const { page, context } = await open([1440, 900], 'two')
    let s = await state(page)
    check(s.status === 'idle' && (FIXTURE_DECK ? s.clock === '30:00' : /^\d\d:\d\d$/.test(s.clock)), `timer: idle at the talk length (${s.status} ${s.clock})`)
    check(s.clockTip === 'Start timer' && s.startShown && s.startTip === 'Start timer', `timer: idle clock and Start timer are named "Start timer" (${s.clockTip}, ${s.startShown}, ${s.startTip})`)
    await tap(page, '#twClockBtn'); await settle(page)
    s = await state(page)
    check(s.status === 'running' && s.clockTip === 'Pause timer' && !s.startShown, `timer: clicking the clock starts it (${s.status}, ${s.clockTip}, start shown ${s.startShown})`)
    await tap(page, '#twClockBtn'); await settle(page)
    s = await state(page)
    check(s.status === 'paused' && s.clockTip === 'Resume timer' && s.startShown && s.startTip === 'Resume timer', `timer: clicking the clock again pauses it (${s.status}, ${s.clockTip}, ${s.startTip})`)
    await page.keyboard.press('p'); await settle(page)
    check((await state(page)).status === 'running', 'timer: P still resumes')
    await page.keyboard.press('p'); await settle(page)
    check((await state(page)).status === 'paused', 'timer: P still pauses')
    // The popover: chevron and T open it; presets, the stepper and reminders set it; Esc and a
    // press outside close it.
    await tap(page, '#twDurationBtn'); await settle(page)
    s = await state(page)
    check(s.popOpen && s.expanded === 'true', `popover: the chevron opens it (${s.popOpen}, ${s.expanded})`)
    const popText = await page.evaluate(() => document.getElementById('twDurationSetter')?.innerText || '')
    for (const text of ['Talk length', 'minutes', 'Reminders before the end', 'Reset timer', 'Back to 00:00. The recording is not affected.', 'Click the clock, or press P, to pause or resume.']) check(popText.includes(text), `popover: shows "${text}"`)
    const presets = await page.evaluate(() => [...document.querySelectorAll('#twDurationSetter [data-minutes]')].map((b) => b.textContent.trim()).join(' '))
    check(presets === '10 15 20 30 45 60 90', `popover: presets 10 to 90 minutes (${presets})`)
    await tap(page, '#twDurationSetter [data-minutes="45"]'); await settle(page)
    s = await state(page)
    check(s.clock === '45:00' && s.status === 'idle' && !s.popOpen, `popover: a preset sets the length (${s.clock}, ${s.status}, open ${s.popOpen})`)
    await page.keyboard.press('t'); await settle(page)
    check((await state(page)).popOpen, 'popover: T opens it')
    await tap(page, '#twDurationPlus'); await settle(page)
    check((await state(page)).clock === '50:00', 'popover: + adds five minutes')
    await tap(page, '#twDurationMinus'); await tap(page, '#twDurationMinus'); await settle(page)
    check((await state(page)).clock === '40:00', 'popover: − takes five minutes off')
    await tap(page, '.tw-reminder[data-remind="10"]'); await settle(page)
    check((await state(page)).remind10 === 'true', 'popover: the −10 min reminder chip turns on')
    await tap(page, '.tw-reminder[data-remind="10"]'); await settle(page)
    check((await state(page)).remind10 === 'false', 'popover: and off')
    await page.keyboard.press('Escape'); await settle(page)
    check(!(await state(page)).popOpen, 'popover: Esc closes it')
    // Reset while recording: the timer goes back, the recording carries on.
    await tap(page, '#twClockBtn')
    await page.waitForFunction(() => document.getElementById('twrec-primary')?.offsetParent != null, null, { timeout: 5000 }).catch(() => {})
    await page.click('#twrec-primary').catch(() => {})
    await page.waitForFunction(() => document.getElementById('twrec-module')?.dataset.rec === 'recording', null, { timeout: 5000 }).catch(() => {})
    await settle(page, 1300)
    const before = await state(page)
    check(before.rec === 'recording' && before.status === 'running', `reset: set-up has the timer running and a recording (${before.status}, ${before.rec})`)
    await tap(page, '#twDurationBtn'); await settle(page)
    await tap(page, '#twResetBtn'); await settle(page, 1100)
    const after = await state(page)
    check(after.status === 'idle' && after.clock === '40:00', `reset: Reset timer goes back to the start (${after.status} ${after.clock})`)
    check(after.rec === 'recording' && after.recClock >= before.recClock, `reset: the recording is not touched (${before.rec} ${before.recClock} → ${after.rec} ${after.recClock})`)
    await page.mouse.click(700, 500); await settle(page)
    check(!(await state(page)).popOpen, 'popover: a press outside closes it')
    check(page.errors.length === 0, `timer: no page errors (${page.errors.join('; ')})`)
    await context.close()
  }

  // ── 2 and 3. Live status once, End live, reactions and questions ─────────────────────────
  {
    const { page, context } = await open([1440, 900], 'two')
    const live = () => page.evaluate(() => {
      const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]')
      // The poll's results-visibility badge ("Live") says how results show, not the session's status
      // (ticket 06 renames it "Results shown as they arrive"). The Live menu button names a menu,
      // not the session's status (ticket 04).
      const texts = [...document.querySelectorAll('body *')].filter(shown).filter((el) => el.id !== 'presenterPollVisibility' && !el.closest('#presenterMenuLive')).filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && /\blive\b|reconnecting/i.test(n.textContent) && !/go live|end live|not live/i.test(n.textContent)))
      const slot = document.getElementById('presenterLiveStatus')
      return {
        places: texts.map((el) => el.id || el.className), slot: shown(slot) ? document.getElementById('presenterLiveLabel').textContent.trim() : null, tone: slot?.dataset.tone,
        endLive: shown(document.getElementById('presenterEndLive')),
        // "Not live" is the Go live button (preview.8 feedback): a real button, named Go live, key G.
        notLive: (() => {
          const b = document.getElementById('presenterGoLive')
          if (!b || !shown(b)) return null
          return { tag: b.tagName, text: b.textContent.trim(), tip: b.dataset.tip, key: b.dataset.key, cursor: getComputedStyle(b).cursor, border: getComputedStyle(b).borderTopStyle, inSlot: !!b.closest('#presenterLiveStatus'), icon: [...(b.querySelector(':scope > svg.tw-ico')?.classList || [])].find((c) => c.startsWith('lucide-')) || null }
        })(),
        // Go live is the Live menu's session item (ticket 04): it offers Go live, or End live session.
        goLive: document.getElementById('liveGoButton')?.dataset.tip === 'Go live' && !!document.getElementById('liveGoButton')?.closest('#presenterLiveMenu'),
        pollChip: shown(document.getElementById('presenterPollLiveChip')), statusBar: !!slot?.closest('#presenterStatus')
      }
    })
    let l = await live()
    check(l.slot === 'Not live' && !l.endLive && l.goLive && l.places.length === 0, `live: before a session the status bar says "Not live" and Go live is offered (${JSON.stringify(l)})`)
    const n = l.notLive
    check(n?.tag === 'BUTTON' && n.inSlot && n.text === 'Not live' && n.tip === 'Go live' && n.key === 'G' && n.icon === 'lucide-radio', `live: "Not live" in the status bar is a button named "Go live  G" with the radio icon (${JSON.stringify(n)})`)
    check(n?.cursor === 'pointer' && n.border === 'solid', `live: "Not live" looks like a button (pointer, bordered) (${JSON.stringify(n)})`)
    if (n) {
      // The section chip (slide "two" is in the fixture's timed section) is revealed by the runtime's
      // one-second tick, and when it appears it pushes Go live left. Measure only after that, or the
      // pointer lands on the chip and the tooltip is the chip's, not Go live's.
      if (FIXTURE_DECK) await page.waitForFunction(() => { const c = document.getElementById('sectionTimer'); return !!c && !c.hidden && c.getClientRects().length > 0 }, null, { timeout: 5000 }).catch(() => failures.push('live: the section timer chip never appeared for the timed section'))
      const box = await page.locator('#presenterGoLive').boundingBox()
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await settle(page, 400)
      const tip = await page.evaluate(() => { const t = document.querySelector('.tw-tip'); if (!t || t.hidden) return null; const k = t.querySelector('.tw-tip-key'); return `${t.querySelector('.tw-tip-name')?.textContent ?? t.textContent}  ${k && !k.hidden ? k.textContent : ''}`.trim() })
      check(tip === 'Go live  G', `live: hovering "Not live" shows "Go live  G" (${tip})`)
      await page.mouse.move(5, 500)
    }
    await page.evaluate(() => window.__push('live:status', 'live')); await settle(page)
    l = await live()
    check(l.statusBar && l.slot?.startsWith('Live') && l.tone === 'live' && l.endLive && !l.goLive, `live: live status shows in the status bar with End live (${JSON.stringify(l)})`)
    check(l.places.length === 1, `live: live status appears in exactly one place (${l.places.join(', ')})`)
    await page.evaluate(() => window.__push('live:poll-state', { type: 'poll.state', pollId: 'quick-a', pollType: 'single', question: 'Tried an agent?', options: [{ optionId: 'a', label: 'Yes' }, { optionId: 'b', label: 'No' }], visibility: 'live', open: true, revealed: false, tallies: { a: 3, b: 1 } }))
    await settle(page)
    l = await live()
    check(!l.pollChip && l.places.length === 1, `live: still one place while a poll collects (poll LIVE chip shown ${l.pollChip}; ${l.places.join(', ')})`)
    await page.evaluate(() => window.__push('live:status', 'paused-reconnecting')); await settle(page)
    l = await live()
    check(l.slot?.startsWith('Live paused · reconnecting') && l.endLive && l.places.length === 1, `live: reconnecting shows once, End live stays (${JSON.stringify(l)})`)
    await page.evaluate(() => window.__push('live:status', 'live')); await settle(page)
    await tap(page, '#presenterEndLive'); await settle(page, 400)
    const calls = await page.evaluate(() => window.__ipcCalls)
    l = await live()
    check(calls.includes('live:end'), `live: End live in the status bar ends the session (ipc: ${calls.join(', ')})`)
    check(l.slot === 'Not live' && l.goLive && !l.endLive, `live: after ending, "Not live" and Go live again (${JSON.stringify(l)})`)
    // Only "Not live" is the button: while a session is up the slot is status text beside End live.
    check(l.notLive?.text === 'Not live', `live: after ending, "Not live" is the Go live button again (${JSON.stringify(l.notLive)})`)
    // Pressing "Not live" goes live: the same command as Live menu → Go live and G.
    await page.evaluate(() => { window.__ipcCalls.length = 0 })
    await tap(page, '#presenterGoLive'); await settle(page, 400)
    const goCalls = await page.evaluate(() => window.__ipcCalls)
    l = await live()
    check(goCalls.includes('live:go'), `live: pressing "Not live" starts going live (ipc: ${goCalls.join(', ')})`)
    check(l.slot === 'Going live…' && !l.notLive, `live: then the status bar says "Going live…" and "Not live" is no longer a button (${JSON.stringify(l)})`)
    await page.evaluate(() => window.__push('live:status', 'live')); await settle(page)
    l = await live()
    check(l.slot?.startsWith('Live') && l.endLive && !l.notLive, `live: while live the slot is status text with End live, not a button (${JSON.stringify(l)})`)
    await page.keyboard.press('Escape')
    // Another window takes the session over ('superseded', 2026-09-28): main treats it as finished,
    // so this window is "Not live" with Go live offered, and G starts a NEW session — never
    // "End this live session?" and live:end.
    await page.evaluate(() => window.__push('live:status', 'superseded')); await settle(page)
    l = await live()
    check(l.slot === 'Not live' && l.notLive?.text === 'Not live' && !l.endLive, `live: superseded shows "Not live" as the Go live button, without End live (${JSON.stringify(l)})`)
    // G on a superseded window asks first (Fable, 2026-09-28). Cancel: nothing is sent, the state stays.
    const SUPERSEDED_ASK = 'Another window took over this talk’s live session. Start a new session here? New joiners and venue screens will follow this one.'
    await page.evaluate(() => { window.__ipcCalls.length = 0 })
    page.dialogs.length = 0
    page.dialogAnswer = false
    await page.mouse.move(5, 500)
    await page.keyboard.press('g'); await settle(page, 400)
    let supersededCalls = await page.evaluate(() => window.__ipcCalls)
    l = await live()
    check(page.dialogs.length === 1 && page.dialogs[0] === SUPERSEDED_ASK, `live: G after superseded asks "${SUPERSEDED_ASK}" (dialogs: ${page.dialogs.join(' | ')})`)
    check(!supersededCalls.includes('live:go') && !supersededCalls.includes('live:end'), `live: Cancel sends nothing (ipc: ${supersededCalls.join(', ')})`)
    check(l.slot === 'Not live' && l.notLive?.text === 'Not live' && !l.endLive, `live: after Cancel the window is still "Not live" with Go live offered (${JSON.stringify(l)})`)
    // Confirm: a new session starts here.
    await page.evaluate(() => { window.__ipcCalls.length = 0 })
    page.dialogs.length = 0
    page.dialogAnswer = true
    await page.keyboard.press('g'); await settle(page, 400)
    supersededCalls = await page.evaluate(() => window.__ipcCalls)
    l = await live()
    check(page.dialogs.length === 1 && page.dialogs[0] === SUPERSEDED_ASK, `live: G after superseded asks once before starting (dialogs: ${page.dialogs.join(' | ')})`)
    check(supersededCalls.includes('live:go') && !supersededCalls.includes('live:end'), `live: on confirm G starts going live, never ends (ipc: ${supersededCalls.join(', ')})`)
    check(l.slot === 'Going live…', `live: on confirm the status bar says "Going live…" (${JSON.stringify(l)})`)
    // The "Not live" button asks the same question on the same seam; Cancel sends nothing.
    await page.evaluate(() => window.__push('live:status', 'superseded')); await settle(page)
    await page.keyboard.press('Escape')
    for (const answer of [false, true]) {
      await page.evaluate(() => { window.__ipcCalls.length = 0 })
      page.dialogs.length = 0
      page.dialogAnswer = answer
      await tap(page, '#presenterGoLive'); await settle(page, 400)
      const buttonCalls = await page.evaluate(() => window.__ipcCalls)
      check(page.dialogs[0] === SUPERSEDED_ASK && buttonCalls.includes('live:go') === answer && !buttonCalls.includes('live:end'), `live: pressing "Not live" after superseded asks, then ${answer ? 'starts' : 'sends nothing'} (ipc: ${buttonCalls.join(', ')}; dialogs: ${page.dialogs.join(' | ')})`)
      if (answer) break
      await page.evaluate(() => window.__push('live:status', 'superseded')); await settle(page)
    }
    await page.keyboard.press('Escape')
    // Reactions and questions: nothing until a feature supplies counts.
    const counts = () => page.evaluate(() => ({
      reactions: document.getElementById('presenterReactions')?.hidden === false ? document.getElementById('presenterReactions').innerText.replace(/\s+/g, ' ').trim() : null,
      questions: document.getElementById('presenterQuestions')?.hidden === false ? document.getElementById('presenterQuestions').innerText.trim() : null,
      inBar: !!document.querySelector('#presenterStatus #presenterReactions') && !!document.querySelector('#presenterStatus #presenterQuestions'),
      icons: [...document.querySelectorAll('#presenterReactions svg, #presenterQuestions svg')].map((s) => [...s.classList].find((c) => c.startsWith('lucide-'))).join(' ')
    }))
    let c = await counts()
    check(c.reactions === null && c.questions === null, `audience: no reactions or questions until supplied (${JSON.stringify(c)})`)
    const hasHook = await page.evaluate(() => typeof window.__audience === 'function')
    check(hasHook, 'audience: the status bar asks the live bridge for counts (twLivePollBridge.onAudience)')
    if (hasHook) {
      await page.evaluate(() => window.__audience({ reactions: { puzzled: 2, helped: 5, bookmark: 1 }, questions: 3 })); await settle(page)
      c = await counts()
      check(c.inBar && c.reactions === '2 5 1' && c.questions === '3', `audience: fixture counts render in the status bar (${JSON.stringify(c)})`)
      check(c.icons === 'lucide-frown lucide-lightbulb lucide-bookmark lucide-message-circle-question-mark', `audience: lucide icons (${c.icons})`)
      await page.evaluate(() => window.__audience({ reactions: null, questions: null })); await settle(page)
      c = await counts()
      check(c.reactions === null && c.questions === null, 'audience: they go when the counts go')
    }
    check(page.errors.length === 0, `live: no page errors (${page.errors.join('; ')})`)
    await context.close()
  }

  // ── 3b. The live bridge itself feeds the chip and counter (no fixture): counts for the slide on screen ──
  {
    const { page, context } = await open([1440, 900], 'one', { fixture: false })
    const counts = () => page.evaluate(() => ({
      reactions: document.getElementById('presenterReactions')?.hidden === false ? document.getElementById('presenterReactions').innerText.replace(/\s+/g, ' ').trim() : null,
      questions: document.getElementById('presenterQuestions')?.hidden === false ? document.getElementById('presenterQuestions').innerText.trim() : null,
      names: [...document.querySelectorAll('#presenterReactions > span')].map((el) => el.getAttribute('aria-label')).join(' | '),
    }))
    const push = (payload) => page.evaluate((value) => window.__push('live:audience', value), payload)
    let c = await counts()
    check(c.reactions === null && c.questions === null, `audience bridge: nothing before a session is live (${JSON.stringify(c)})`)
    await page.evaluate(() => window.__push('live:status', 'live')); await settle(page)
    c = await counts()
    check(c.reactions === '0 0 0' && c.questions === '0', `audience bridge: live with no reactions yet shows zeros (${JSON.stringify(c)})`)
    await push({ kind: 'snapshot', reactionCounts: { one: { puzzled: 2, helped: 5, bookmark: 1 }, two: { helped: 1 } }, questions: [{ answered: false }, { answered: true }] }); await settle(page)
    c = await counts()
    if (SHOTS) { await mkdir(SHOTS, { recursive: true }); await page.mouse.move(700, 450); await page.screenshot({ path: join(SHOTS, 'presenter-chip-slide-one-1440x900.png') }) }
    check(c.reactions === '2 5 1' && c.questions === '1', `audience bridge: a snapshot shows the current slide's counts and the unanswered questions (${JSON.stringify(c)})`)
    check(c.names === 'Puzzled by this: 2 | Helped me understand: 5 | Bookmarked: 1', `audience bridge: each count is named (${c.names})`)
    await push({ kind: 'reaction', slideId: 'one', counts: { puzzled: 3, helped: 5, bookmark: 1 } }); await settle(page)
    c = await counts()
    check(c.reactions === '3 5 1', `audience bridge: a live update changes the chip (${JSON.stringify(c)})`)
    await push({ kind: 'reaction', slideId: 'two', counts: { helped: 9 } }); await settle(page)
    c = await counts()
    check(c.reactions === '3 5 1', `audience bridge: another slide's update leaves this slide's chip alone (${JSON.stringify(c)})`)
    for (let i = 0; i < 4 && (await page.evaluate(() => location.hash)) !== '#two'; i++) { await page.keyboard.press('ArrowRight'); await settle(page, 250) }
    await settle(page, 400)
    c = await counts()
    check(c.reactions === '0 9 0', `audience bridge: the chip changes with the slide (${JSON.stringify(c)})`)
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'presenter-chip-slide-two-1440x900.png') })
    await page.evaluate(() => window.__push('live:status', 'paused-reconnecting')); await settle(page)
    c = await counts()
    check(c.reactions === '0 9 0', `audience bridge: kept while the session reconnects (${JSON.stringify(c)})`)
    await page.evaluate(() => window.__push('live:status', 'ended')); await settle(page)
    c = await counts()
    check(c.reactions === null && c.questions === null, `audience bridge: gone when the session ends (${JSON.stringify(c)})`)
    check(page.errors.length === 0, `audience bridge: no page errors (${page.errors.join('; ')})`)
    await context.close()
  }

  // ── 4. The top bar at three sizes in idle, L1 and L2 ──────────────────────────────────────
  const measure = () => {
    // (The header itself when there is no status bar, so a template without one fails each check.)
    const bar = document.getElementById('presenterTopBar') || document.querySelector('#presenterRoot > header')
    if (!bar) return null
    const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]')
    // Visually hidden labels (the accessible names of icon-only buttons) are not drawn text.
    const drawn = (el) => { for (let p = el; p && p !== bar; p = p.parentElement) if (getComputedStyle(p).clipPath === 'inset(50%)') return false; return true }
    const textEls = [...bar.querySelectorAll('*')].filter((el) => shown(el) && drawn(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
    const wrapped = textEls.filter((el) => {
      const tops = []
      for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) { const r = document.createRange(); r.selectNodeContents(n); for (const x of r.getClientRects()) if (x.width > 0) tops.push(Math.round(x.top)) }
      return new Set(tops.map((t) => Math.round(t / 6))).size > 1
    }).map((el) => `${el.id || el.className}: ${el.textContent.trim().slice(0, 30)}`)
    const box = bar.getBoundingClientRect()
    const controls = [...bar.querySelectorAll('button, .tw-st, #presenterTitle, .tw-count, .tw-clock')].filter((el) => shown(el) && !el.closest('.tw-duration-setter, .notes-menu'))
    const clipped = controls.filter((el) => { const r = el.getBoundingClientRect(); return r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < -0.5 || r.bottom > innerHeight + 0.5 })
      .concat(controls.filter((el) => el.id !== 'presenterTitle' && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible'))
      .map((el) => el.id || el.className)
    const title = document.getElementById('presenterTitle')
    const mono = new Set(textEls.filter((el) => /monospace/.test(getComputedStyle(el).fontFamily)).map((el) => el.id || el.className))
    const families = new Set(textEls.map((el) => getComputedStyle(el).fontFamily.split(',')[0].trim()))
    return {
      sizes: [...new Set(textEls.map((el) => parseFloat(getComputedStyle(el).fontSize)))].sort((a, b) => a - b),
      families: [...families], mono: [...mono], wrapped, clipped,
      pageOverflow: document.documentElement.scrollWidth > innerWidth, barOverflow: bar.scrollWidth > bar.clientWidth + 1,
      titleWidth: Math.round(title.getBoundingClientRect().width),
      collapse: bar.dataset.collapse ?? null, fits: bar.dataset.fits ?? null,
      statusItems: [...document.querySelectorAll('#presenterStatus > .tw-st')].filter(shown).map((el) => el.id)
    }
  }
  const setState = async (page, key) => {
    if (key === 'idle') return
    // A running 30-minute talk 15:42 in (14:18 left), a recording, live, the section and the
    // audience counts; L2 is the reconnecting live session.
    // The timer's persisted state (sessionStorage html-presentations:<deck>:timer), restored on reload.
    await page.evaluate(() => {
      const deck = (Object.keys(sessionStorage).find((x) => x.endsWith(':session')) || '').replace(/:session$/, '')
      sessionStorage.setItem(`${deck}:timer`, JSON.stringify({ targetSeconds: 1800, elapsedMs: 942000, runningSince: Date.now(), reminders: [5, 1] }))
    })
    await page.reload({ waitUntil: 'load' })
    await page.waitForFunction(() => /scale\(([\d.]+)\)/.test(document.querySelector('#currentPreview iframe')?.style.transform || ''), null, { timeout: 30000 })
    await page.waitForSelector('#presenterStatus #twrec-module', { timeout: 10000 }).catch(() => {})
    await page.click('#twrec-primary').catch(() => {})
    await page.waitForFunction(() => document.getElementById('twrec-module')?.dataset.rec === 'recording', null, { timeout: 5000 }).catch(() => {})
    await page.evaluate((k) => {
      window.__push?.('live:status', k === 'L2' ? 'paused-reconnecting' : 'live')
      window.__audience?.(k === 'L2' ? { reactions: { puzzled: 1, helped: 3, bookmark: 0 }, questions: 3 } : { reactions: { puzzled: 2, helped: 5, bookmark: 1 }, questions: 3 })
    }, key)
    await page.mouse.move(5, 500)
  }
  if (SHOTS) await mkdir(SHOTS, { recursive: true })
  const reached = []
  for (const key of ['idle', 'L1', 'L2']) {
    for (const size of SIZES) {
      const name = `${key}-${size[0]}`
      const { page, context } = await open(size, key === 'idle' ? SLIDE_IDLE : SLIDE_L1)
      await setState(page, key)
      await settle(page, 700)
      const m = await page.evaluate(measure)
      if (!m) { check(false, `${name}: no status bar (#presenterTopBar)`); await context.close(); continue }
      reached.push(`${key}@${size.join('x')}: ${m.collapse || 'none'}`)
      check(m.fits === 'true', `${name}: the top bar reports that it fits (${m.fits}; ${m.collapse})`)
      check(m.wrapped.length === 0, `${name}: no label wraps (${m.wrapped.join('; ')})`)
      check(m.clipped.length === 0, `${name}: nothing clips (${m.clipped.join(', ')})`)
      check(!m.pageOverflow && !m.barOverflow, `${name}: no horizontal overflow (page ${m.pageOverflow}, bar ${m.barOverflow})`)
      check(m.sizes.every((px) => CHROME_SIZES.includes(px)), `${name}: only the chrome sizes 26/16/14/13px (${m.sizes.join(', ')})`)
      check(m.families.length <= 2 && m.mono.every((id) => /twClock$|presenterCount|tw-count|rec-clock/.test(id)), `${name}: one UI typeface, monospace only for clock, counter and recorded length (${m.families.join(' | ')}; mono: ${m.mono.join(', ')})`)
      check(m.titleWidth >= 119, `${name}: the title keeps at least 120px (${m.titleWidth})`)
      const steps = (m.collapse || '').split(' ').filter(Boolean)
      check(steps.every((step, i) => step === ORDER[i]), `${name}: collapse steps follow the drawn order (${m.collapse})`)
      if (name in DRAWN_REACH) check(steps.length <= DRAWN_REACH[name], `${name}: collapses no further than the drawing (${m.collapse || 'none'}; drawn up to ${DRAWN_REACH[name] ? `c${DRAWN_REACH[name]}` : 'none'})`)
      if (key !== 'idle') check(['presenterRecSlot', 'presenterLiveStatus', 'presenterReactions', 'presenterQuestions'].every((id) => m.statusItems.includes(id)), `${name}: recording, live, reactions and questions all show (${m.statusItems.join(', ')})`)
      if (key === 'L1' && FIXTURE_DECK) check(m.statusItems.includes('sectionTimer') || steps.includes('c9'), `${name}: the section chip shows (${m.statusItems.join(', ')})`)
      check(page.errors.length === 0, `${name}: no page errors (${page.errors.join('; ')})`)
      if (SHOTS && key !== 'L2') await page.screenshot({ path: join(SHOTS, `${key}-${size[0]}x${size[1]}.png`) })
      if (SHOTS && key === 'L1' && size[0] === 1440) {
        await tap(page, '#twDurationBtn'); await settle(page, 300)
        await page.screenshot({ path: join(SHOTS, 'clock-popover-1440x900.png') })
        const pop = await page.evaluate(measure)
        if (pop) check(pop.sizes.every((px) => CHROME_SIZES.includes(px)), `clock popover: only the chrome sizes (${pop.sizes.join(', ')})`)
      }
      await context.close()
    }
  }

  // The ladder itself: narrowing the window adds steps in order, and each step does what the
  // table says to the thing it names.
  {
    const { page, context } = await open([1280, 800], SLIDE_L1)
    await setState(page, 'L1')
    await settle(page, 500)
    const seen = []
    for (const width of [1280, 1200, 1120, 1060, 1000, 960]) {
      await page.setViewportSize({ width, height: 800 }); await settle(page, 300)
      const r = await page.evaluate(() => {
        const bar = document.getElementById('presenterTopBar') || document.createElement('div')
        const vis = (sel) => { const el = document.querySelector(sel); return !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none' }
        return { collapse: bar.dataset.collapse, sub: vis('#twClockSub'), word: vis('#sectionTimer .tw-st-word'), slideWord: vis('.tw-count-word'), endLabel: vis('#presenterEndLive > .tw-btn-label'), section: vis('#sectionTimer') }
      })
      seen.push(`${width}: ${r.collapse || 'none'}`)
      const steps = (r.collapse || '').split(' ').filter(Boolean)
      check(steps.every((step, i) => step === ORDER[i]), `ladder @${width}: steps in order (${r.collapse})`)
      check(steps.includes('c1') === !r.sub, `ladder @${width}: c1 drops the line under the clock (${r.collapse}; shown ${r.sub})`)
      if (FIXTURE_DECK && !steps.includes('c9')) check(steps.includes('c2') === !r.word, `ladder @${width}: c2 drops the word "Section" (${r.collapse}; shown ${r.word})`)
      check(steps.includes('c3') === !r.slideWord, `ladder @${width}: c3 drops "Slide" (${r.collapse}; shown ${r.slideWord})`)
      check(steps.includes('c4') === !r.endLabel, `ladder @${width}: c4 makes End live icon-only (${r.collapse}; label ${r.endLabel})`)
      if (FIXTURE_DECK) check(steps.includes('c9') === !r.section, `ladder @${width}: c9 drops the Section chip (${r.collapse}; shown ${r.section})`)
    }
    check(seen.some((s) => s.includes('c4')), `ladder: narrowing reaches c4 at least (${seen.join(' · ')})`)
    reached.push(`ladder: ${seen.join(' · ')}`)
    await context.close()
  }

  assert.deepEqual(failures, [], `presenter status bar:\n  ${failures.join('\n  ')}`)
  console.log(`presenter status bar: timer (clock, P, popover length/presets/reminders/reset beside a recording), live status once with End live, reactions and questions from a fixture, fit at 3 sizes × idle/L1/L2 — collapse ${reached.join('; ')}`)
} finally {
  await browser?.close()
  await rm(scratch, { recursive: true, force: true })
}
