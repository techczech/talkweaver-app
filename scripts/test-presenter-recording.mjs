// The REC cluster and the recording toasts (ADR-0031 §3, presenter redesign ticket 03; drawn in
// the round-2 presenter redesign drawings, shots rec-* and toast-*). The compiled
// presenter window in headless Chromium with the recording preload bundled against a stub of
// electron and injected as the app injects it (as test:presenter-controls does). Seams:
//  1. the recording preload's state → view mapping, rendered in the presenter template: idle,
//     recording, paused, saving and saved each show the drawn mark, words, recorded length and
//     buttons, with the buttons' names and keys from the presenter-controls table; Pause, Resume
//     and Stop are 28px square, the chrome's next control size up from 26px (Dominik, preview.8,
//     28 Sep: "make pause and stop buttons slightly larger"), their icons still the one 16px step;
//  2. the controls do what they did: Record, Pause, Resume, Stop (saves a delivery recording),
//     Change (opens the run-kind picker and changes the kind), ⇧R and ⇧P, L; the run-kind picker
//     never opens when a recording starts;
//  3. each state fits the status bar at 1280x800 and 1440x900 beside L1's other status items
//     (timer running, live, section, reactions, questions): no wrap, no clip, only the chrome
//     sizes, collapse steps in the drawn order and no further than surfaces-drawn.md; c5 drops the
//     status words and c6 makes Record and Change icon-only;
//  4. the toasts (start offer, recording paused, save run, saved) sit under the status strip,
//     clear of the Next preview, in the chrome type scale, with their buttons named and keyed.
// Every check is collected and all failures are reported together.
// Usage: node scripts/test-presenter-recording.mjs
//   SHOTS=<dir> also saves each state at both sizes and the four toasts at 1440x900.
//   DECK=<compiled deck.html> uses that deck instead of the fixture (the build shots use the demo
//   talk); SLIDE_L1 (an id) is the slide the states are drawn on.
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
const FIXTURE_DECK = !process.env.DECK
const SIZES = [[1280, 800], [1440, 900]]
const STATES = ['idle', 'recording', 'paused', 'saving', 'saved']
const CHROME_SIZES = [13, 14, 16, 26]
const ORDER = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10']
// surfaces-drawn.md and round-2/shots/_report.json: the furthest step each drawn REC state reaches
// in L1 (saved at 1280 is not drawn; it may go as far as its own step, c6). Paused at 1440 is
// drawn at c1 and reaches c2 here: the REC cluster measures as drawn (paused is 88px wider than
// recording, as in the drawing), but the built top bar is 12px narrower than the drawing's (18px
// window padding, drawn 10px) and the strip's other L1 items measure about 10px wider, so the
// word "Section" goes as well.
const DRAWN_REACH = { 'idle-1280': 4, 'idle-1440': 1, 'recording-1280': 3, 'recording-1440': 1, 'paused-1280': 5, 'paused-1440': 2, 'saving-1280': 4, 'saving-1440': 1, 'saved-1280': 6, 'saved-1440': 1 }
// What each state shows (present-rec-view.ts, as drawn). Colours are the drawing's.
const GREY = 'rgb(93, 109, 124)', RED = 'rgb(239, 68, 68)', AMBER = 'rgb(245, 182, 74)'
const EXPECT = {
  idle: { mark: 'dot', dot: GREY, word: 'Not recording', wordCollapses: true, time: false, buttons: ['twrec-primary'] },
  recording: { mark: 'dot', dot: RED, word: 'REC', time: true, buttons: ['twrec-pause', 'twrec-stop'] },
  paused: { mark: 'dot', dot: AMBER, word: 'Recording paused', wordCollapses: true, time: true, timeColor: AMBER, buttons: ['twrec-resume', 'twrec-stop'] },
  saving: { mark: 'spinner', word: 'Saving recording…', time: true, buttons: [] },
  saved: { mark: 'check', word: 'Saved as Delivery', time: false, buttons: ['twrec-change-kind'] }
}
// Pause, Resume and Stop: the chrome's 28px control size (the segments and presets; the other
// status-bar buttons are 26px). The strip is 32px tall with a 1px border, so 28px still sits inside it.
const REC_ICON_BUTTON = 28
const TIPS = {
  'twrec-primary': ['Start recording', '⇧R'], 'twrec-pause': ['Pause recording', '⇧P'], 'twrec-resume': ['Resume recording', '⇧P'],
  'twrec-stop': ['Stop and save recording', '⇧R'], 'twrec-change-kind': ['Change run kind', 'L'],
  'twrec-start-record': ['Start recording', '⇧R'], 'twrec-toast-yes': ['Resume recording', '⇧P'], 'twrec-save-delivery': ['Save this run as a delivery', '↵'],
  'twrec-save-as': ['Save run as…', 'L'], 'twrec-saved-change': ['Change run kind', 'L']
}
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }
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

### Thank you {id=four}

Questions welcome.
`

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-presenter-recording-'))
let browser
try {
  let htmlPath = process.env.DECK ? resolve(process.env.DECK) : null
  if (!htmlPath) {
    const sourcePath = join(scratch, 'recording.md')
    await writeFile(sourcePath, FIXTURE)
    const model = await prepareSource(sourcePath, FIXTURE, 'The current state of AI agents', statSync(sourcePath))
    htmlPath = join(scratch, 'recording-present.html')
    await writeFile(htmlPath, model.fullHtml)
  }
  const SLIDE_L1 = process.env.SLIDE_L1 || 'two'
  // The recording preload as the app ships it; electron stubbed. invoke() answers the channels the
  // preloads call and logs them with their payloads. While window.__holdSave is set, recording:save
  // waits for window.__releaseSave() — the only way to see "saving" long enough to read it.
  const stubPath = join(scratch, 'electron-stub.mjs')
  await writeFile(stubPath, `const answers = { 'recording:context': { testMode: true, talkSlug: 'rec', talkTitle: 'Rec', discardThresholdMs: 0 }, 'live:status': 'ended', 'live:snapshot': {}, 'recording:set-kind': { ok: true } }
window.__ipcCalls = []; window.__ipcOn = {}; window.__holdSave = false; let release = null
window.__releaseSave = () => { const r = release; release = null; r?.() }
let sessions = 0
export const ipcRenderer = {
  invoke: async (channel, ...args) => {
    const payload = args[0] && typeof args[0] === 'object' ? { ...args[0], audio: args[0].audio ? 'bytes' : undefined } : args[0]
    window.__ipcCalls.push({ channel, payload })
    if (channel === 'recording:save') {
      if (window.__holdSave) await new Promise((r) => { release = r })
      sessions += 1
      return { ok: true, sessionId: 's' + sessions, kind: payload.kind }
    }
    return channel in answers ? answers[channel] : {}
  },
  on(channel, fn) { (window.__ipcOn[channel] ||= []).push(fn) }, send() {}, removeListener() {}
}
window.__push = (channel, value) => { for (const fn of window.__ipcOn[channel] || []) fn(null, value) }
export const contextBridge = { exposeInMainWorld: (name, api) => { window[name] = api } }
export const clipboard = { writeText() {} }
`)
  const bundle = await build({ entryPoints: [join(repo, 'src/preload/present-recorder.ts')], bundle: true, write: false, format: 'iife', platform: 'browser', alias: { electron: stubPath }, logLevel: 'silent' })
  const preload = bundle.outputFiles[0].text
  const audienceFixture = `if (window === window.top && window.twLivePollBridge) window.twLivePollBridge.onAudience = (cb) => { window.__audience = cb }`

  browser = await chromium.launch({ headless: true })
  const ready = async (page) => {
    await page.waitForFunction(() => /scale\(([\d.]+)\)/.test(document.querySelector('#currentPreview iframe')?.style.transform || ''), null, { timeout: 30000 })
    await page.waitForSelector('#presenterStatus #twrec-module', { timeout: 10000 }).catch(() => failures.push('the REC cluster is not in the status bar'))
    if (await page.isVisible('#twResume')) await tap(page, '#twResumeNo')
  }
  const open = async ([width, height], slide, { clock = false } = {}) => {
    const context = await browser.newContext({ viewport: { width, height } })
    await context.addInitScript({ content: `if (window === window.top) {\n${preload}\n}` })
    await context.addInitScript({ content: audienceFixture })
    const page = await context.newPage()
    if (clock) await page.clock.install()
    page.errors = []
    page.on('pageerror', (error) => page.errors.push(error.message))
    page.on('dialog', (dialog) => dialog.accept())
    await page.goto(`${pathToFileURL(htmlPath).href}?presenter=1${slide ? `#${slide}` : ''}`, { waitUntil: 'load', timeout: 120000 })
    await ready(page)
    await page.mouse.move(5, 500)
    return { page, context }
  }
  const settle = (page, ms = 250) => page.waitForTimeout(ms)
  // L1: a running 30-minute talk 15:42 in, live, the section and the audience counts.
  const setL1 = async (page) => {
    await page.evaluate(() => {
      const deck = (Object.keys(sessionStorage).find((x) => x.endsWith(':session')) || '').replace(/:session$/, '')
      sessionStorage.setItem(`${deck}:timer`, JSON.stringify({ targetSeconds: 1800, elapsedMs: 942000, runningSince: Date.now(), reminders: [5, 1] }))
    })
    await page.reload({ waitUntil: 'load' })
    await ready(page)
    await page.evaluate(() => {
      window.__push?.('live:status', 'live')
      window.__audience?.({ reactions: { puzzled: 2, helped: 5, bookmark: 1 }, questions: 3 })
    })
    await page.mouse.move(5, 500)
  }
  const recIs = (page, st) => page.waitForFunction((s) => document.getElementById('twrec-module')?.dataset.rec === s, st, { timeout: 6000 }).then(() => true).catch(() => false)
  // Drive the recorder through its own buttons from idle to the state.
  const toState = async (page, target) => {
    if (target === 'idle') return true
    await tap(page, '#twrec-primary')
    if (!await recIs(page, 'recording')) return false
    await settle(page, 1200) // a recorded length that reads 00:01
    if (target === 'recording') return true
    if (target === 'paused') { await tap(page, '#twrec-pause'); return recIs(page, 'paused') }
    await page.evaluate(() => { window.__holdSave = true })
    await tap(page, '#twrec-stop')
    if (!await recIs(page, 'saving')) return false
    if (target === 'saving') return true
    await page.evaluate(() => { window.__holdSave = false; window.__releaseSave() })
    return recIs(page, 'saved')
  }
  const readCluster = (page) => page.evaluate(() => {
    const m = document.getElementById('twrec-module')
    if (!m) return null
    const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none' && !el.closest('[hidden]')
    const $ = (id) => document.getElementById(id)
    const label = $('twrec-label'), clock = $('twrec-clock'), dot = $('twrec-dot')
    const buttons = [...m.querySelectorAll('button')].filter(vis)
    return {
      rec: m.dataset.rec, inStrip: !!m.closest('#presenterStatus'),
      mark: vis(dot) ? 'dot' : vis($('twrec-spinner')) ? 'spinner' : vis($('twrec-ok')) ? 'check' : 'none',
      dot: vis(dot) ? getComputedStyle(dot).backgroundColor : null,
      word: vis(label) ? label.textContent : null, wordText: label?.textContent ?? null,
      time: vis(clock) ? clock.textContent : null, timeColor: vis(clock) ? getComputedStyle(clock).color : null,
      timePx: vis(clock) ? parseFloat(getComputedStyle(clock).fontSize) : null, wordPx: label ? parseFloat(getComputedStyle(label).fontSize) : null,
      buttons: buttons.map((b) => b.id),
      tips: Object.fromEntries(buttons.map((b) => [b.id, [b.dataset.tip, b.dataset.key ?? '']])),
      labelShown: Object.fromEntries(buttons.map((b) => [b.id, vis(b.querySelector(':scope > .tw-btn-label')) && getComputedStyle(b.querySelector(':scope > .tw-btn-label')).clipPath !== 'inset(50%)'])),
      icons: Object.fromEntries(buttons.map((b) => [b.id, [...(b.querySelector(':scope > svg.tw-ico')?.classList || [])].find((c) => c.startsWith('lucide-')) || null])),
      boxes: Object.fromEntries(buttons.map((b) => { const r = b.getBoundingClientRect(); const svg = b.querySelector(':scope > svg.tw-ico'); return [b.id, { w: Math.round(r.width), h: Math.round(r.height), icon: svg ? getComputedStyle(svg).width : null }] })),
      picker: !!document.querySelector('.twrec-picker')
    }
  })
  const measure = () => {
    const bar = document.getElementById('presenterTopBar')
    if (!bar) return null
    const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]')
    const drawn = (el) => { for (let p = el; p && p !== bar; p = p.parentElement) if (getComputedStyle(p).clipPath === 'inset(50%)') return false; return true }
    const textEls = [...bar.querySelectorAll('*')].filter((el) => shown(el) && drawn(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
    const wrapped = textEls.filter((el) => {
      const tops = []
      for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) { const r = document.createRange(); r.selectNodeContents(n); for (const x of r.getClientRects()) if (x.width > 0) tops.push(Math.round(x.top)) }
      return new Set(tops.map((t) => Math.round(t / 6))).size > 1
    }).map((el) => `${el.id || el.className}: ${el.textContent.trim().slice(0, 30)}`)
    const box = bar.getBoundingClientRect()
    const controls = [...bar.querySelectorAll('button, .tw-st, #presenterTitle, .tw-count, .tw-clock, #twrec-module > *')].filter((el) => shown(el) && !el.closest('.tw-duration-setter, .notes-menu, .tw-menu'))
    const clipped = controls.filter((el) => { const r = el.getBoundingClientRect(); return r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < -0.5 || r.bottom > innerHeight + 0.5 })
      .concat(controls.filter((el) => el.id !== 'presenterTitle' && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible'))
      .map((el) => el.id || el.className)
    const slot = document.getElementById('presenterRecSlot')?.getBoundingClientRect()
    const strip = document.getElementById('presenterStatus')?.getBoundingClientRect()
    return {
      sizes: [...new Set(textEls.map((el) => parseFloat(getComputedStyle(el).fontSize)))].sort((a, b) => a - b), wrapped, clipped,
      pageOverflow: document.documentElement.scrollWidth > innerWidth, barOverflow: bar.scrollWidth > bar.clientWidth + 1,
      collapse: bar.dataset.collapse ?? null, fits: bar.dataset.fits ?? null,
      slotInStrip: !!slot && !!strip && slot.left >= strip.left - 0.5 && slot.right <= strip.right + 0.5 && slot.top >= strip.top - 0.5 && slot.bottom <= strip.bottom + 0.5,
      statusItems: [...document.querySelectorAll('#presenterStatus > .tw-st')].filter(shown).map((el) => el.id)
    }
  }
  const checkState = (name, st, c, steps) => {
    const e = EXPECT[st]
    if (!c) { check(false, `${name}: no REC cluster`); return }
    check(c.rec === st, `${name}: the recorder is ${st} (${c.rec})`)
    check(c.inStrip, `${name}: the cluster sits in the status bar`)
    check(c.mark === e.mark, `${name}: mark is the ${e.mark} (${c.mark})`)
    if (e.dot) check(c.dot === e.dot, `${name}: dot colour ${e.dot} (${c.dot})`)
    const wordGone = e.wordCollapses && steps.includes('c5')
    check(c.wordText === e.word, `${name}: words "${e.word}" (${c.wordText})`)
    check(wordGone ? c.word === null : c.word === e.word, `${name}: the words ${wordGone ? 'go at c5' : 'show'} (${c.word})`)
    if (!wordGone) check(c.wordPx === 13, `${name}: status words at 13px (${c.wordPx})`)
    check(e.time ? /^\d\d:\d\d$/.test(c.time || '') : c.time === null, `${name}: recorded length ${e.time ? 'shows' : 'does not show'} (${c.time})`)
    if (e.time) check(c.timePx === 16, `${name}: recorded length at 16px (${c.timePx})`)
    if (e.timeColor) check(c.timeColor === e.timeColor, `${name}: recorded length in ${e.timeColor} (${c.timeColor})`)
    check(JSON.stringify(c.buttons) === JSON.stringify(e.buttons), `${name}: buttons ${e.buttons.join(', ') || 'none'} (${c.buttons.join(', ') || 'none'})`)
    for (const id of c.buttons) {
      if (TIPS[id]) check(JSON.stringify(c.tips[id]) === JSON.stringify(TIPS[id]), `${name}: ${id} tooltip "${TIPS[id].join('  ')}" (${c.tips[id]?.join('  ')})`)
      check(!!c.icons[id], `${name}: ${id} has its lucide icon`)
    }
    // Pause, Resume and Stop are icon-only as drawn; Record and Change show their label until c6.
    for (const id of ['twrec-pause', 'twrec-resume', 'twrec-stop']) if (c.buttons.includes(id)) check(!c.labelShown[id], `${name}: ${id} is icon-only`)
    for (const id of ['twrec-pause', 'twrec-resume', 'twrec-stop']) if (c.buttons.includes(id)) {
      const b = c.boxes[id]
      check(b?.w === REC_ICON_BUTTON && b.h === REC_ICON_BUTTON && b.icon === '16px', `${name}: ${id} is ${REC_ICON_BUTTON}px square with its 16px icon (${JSON.stringify(b)})`)
    }
    for (const id of ['twrec-primary', 'twrec-change-kind']) if (c.buttons.includes(id)) check(c.labelShown[id] === !steps.includes('c6'), `${name}: ${id} ${steps.includes('c6') ? 'is icon-only at c6' : 'shows its label'} (${c.labelShown[id]})`)
    check(!c.picker, `${name}: no run-kind picker`)
  }

  if (SHOTS) await mkdir(SHOTS, { recursive: true })
  const reached = []

  // ── 1 + 3. Each state, drawn and fitted, at both sizes in L1 ──────────────────────────────
  for (const st of STATES) {
    for (const size of SIZES) {
      const name = `${st}-${size[0]}`
      const { page, context } = await open(size, SLIDE_L1)
      await setL1(page)
      if (!await toState(page, st)) { check(false, `${name}: could not reach ${st} through the cluster's buttons`); await context.close(); continue }
      await page.mouse.move(5, 500)
      await settle(page, 600)
      const m = await page.evaluate(measure)
      if (!m) { check(false, `${name}: no status bar`); await context.close(); continue }
      const steps = (m.collapse || '').split(' ').filter(Boolean)
      reached.push(`${name}: ${m.collapse || 'none'}`)
      checkState(name, st, await readCluster(page), steps)
      check(m.fits === 'true', `${name}: the top bar reports that it fits (${m.fits}; ${m.collapse})`)
      check(m.slotInStrip, `${name}: the cluster stays inside the status strip`)
      check(m.wrapped.length === 0, `${name}: no label wraps (${m.wrapped.join('; ')})`)
      check(m.clipped.length === 0, `${name}: nothing clips (${m.clipped.join(', ')})`)
      check(!m.pageOverflow && !m.barOverflow, `${name}: no horizontal overflow (page ${m.pageOverflow}, bar ${m.barOverflow})`)
      check(m.sizes.every((px) => CHROME_SIZES.includes(px)), `${name}: only the chrome sizes 26/16/14/13px (${m.sizes.join(', ')})`)
      check(steps.every((step, i) => step === ORDER[i]), `${name}: collapse steps follow the drawn order (${m.collapse})`)
      check(steps.length <= DRAWN_REACH[name], `${name}: collapses no further than the drawing (${m.collapse || 'none'}; up to c${DRAWN_REACH[name]})`)
      check(['presenterRecSlot', 'presenterLiveStatus', 'presenterReactions', 'presenterQuestions'].every((id) => m.statusItems.includes(id)), `${name}: recording, live, reactions and questions all show (${m.statusItems.join(', ')})`)
      check(page.errors.length === 0, `${name}: no page errors (${page.errors.join('; ')})`)
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `rec-${st}-${size[0]}x${size[1]}.png`) })
      if (st === 'saving') await page.evaluate(() => { window.__holdSave = false; window.__releaseSave() })
      await context.close()
    }
  }

  // c5 and c6 on a narrower window: the words go, then Record and Change drop their labels.
  for (const st of ['idle', 'paused', 'saved']) {
    const { page, context } = await open([1280, 800], SLIDE_L1)
    await setL1(page)
    if (!await toState(page, st)) { check(false, `ladder ${st}: could not reach ${st}`); await context.close(); continue }
    const seen = []
    for (const width of [1200, 1120, 1060, 1000]) {
      await page.setViewportSize({ width, height: 800 }); await settle(page, 300)
      const collapse = await page.evaluate(() => document.getElementById('presenterTopBar')?.dataset.collapse || '')
      const steps = collapse.split(' ').filter(Boolean)
      seen.push(`${width}: ${collapse || 'none'}`)
      checkState(`ladder ${st} @${width}`, st, await readCluster(page), steps)
    }
    if (st !== 'saved') check(seen.some((s) => s.includes('c5')), `ladder ${st}: narrowing reaches c5 (${seen.join(' · ')})`)
    check(seen.some((s) => s.includes('c6')), `ladder ${st}: narrowing reaches c6 (${seen.join(' · ')})`)
    reached.push(`ladder ${st}: ${seen.join(' · ')}`)
    await context.close()
  }

  // ── 2. The controls do what they did ──────────────────────────────────────────────────────
  {
    const { page, context } = await open([1440, 900], SLIDE_L1)
    const calls = (channel) => page.evaluate((ch) => window.__ipcCalls.filter((c) => c.channel === ch).map((c) => c.payload), channel)
    // Buttons.
    await tap(page, '#twrec-primary')
    check(await recIs(page, 'recording'), 'Record starts a recording')
    await settle(page, 300)
    check(!await page.$('.twrec-picker'), 'the run-kind picker does not open when a recording starts')
    await tap(page, '#twrec-pause'); check(await recIs(page, 'paused'), 'Pause recording pauses')
    await tap(page, '#twrec-resume'); check(await recIs(page, 'recording'), 'Resume recording resumes')
    await tap(page, '#twrec-stop'); check(await recIs(page, 'saved'), 'Stop and save recording stops and saves')
    const saves = await calls('recording:save')
    check(saves.length === 1 && saves[0].mode === 'recording' && saves[0].kind === 'delivery' && saves[0].audio === 'bytes', `Stop saves the audio as a delivery recording (${JSON.stringify(saves)})`)
    await tap(page, '#twrec-change-kind')
    check(await page.waitForSelector('.twrec-picker', { timeout: 3000 }).then(() => true).catch(() => false), 'Change opens the run-kind picker')
    await tap(page, '.twrec-kind[data-kind="rehearsal"]')
    await page.waitForFunction(() => document.getElementById('twrec-label')?.textContent === 'Saved as Rehearsal', null, { timeout: 3000 }).catch(() => {})
    const kinds = await calls('recording:set-kind')
    check(kinds.length === 1 && kinds[0].kind === 'rehearsal' && kinds[0].sessionId === 's1', `Change sets the saved run's kind (${JSON.stringify(kinds)})`)
    check((await readCluster(page))?.word === 'Saved as Rehearsal', 'the cluster names the new kind')
    // Keys: ⇧R starts from saved, ⇧P pauses and resumes, ⇧R stops; L opens the picker, Esc closes it.
    await page.keyboard.press('Shift+R'); check(await recIs(page, 'recording'), '⇧R starts a new recording')
    await settle(page, 200)
    check(!await page.$('.twrec-picker'), '⇧R opens no run-kind picker')
    await page.keyboard.press('Shift+P'); check(await recIs(page, 'paused'), '⇧P pauses the recording')
    await page.keyboard.press('Shift+P'); check(await recIs(page, 'recording'), '⇧P resumes the recording')
    await page.keyboard.press('Shift+R'); check(await recIs(page, 'saved'), '⇧R stops and saves')
    check((await calls('recording:save')).length === 2, '⇧R saved the second recording')
    await page.keyboard.press('l')
    check(await page.waitForSelector('.twrec-picker', { timeout: 3000 }).then(() => true).catch(() => false), 'L opens the run-kind picker')
    await page.keyboard.press('Escape')
    check(!await page.$('.twrec-picker'), 'Esc closes the picker')
    check(page.errors.length === 0, `controls: no page errors (${page.errors.join('; ')})`)
    await context.close()
  }

  // ── 4. The toasts ─────────────────────────────────────────────────────────────────────────
  const readToast = (page, selector) => page.evaluate((sel) => {
    const t = document.querySelector(sel)
    if (!t) return null
    const r = t.getBoundingClientRect(), st = document.getElementById('presenterStatus')?.getBoundingClientRect()
    const next = document.getElementById('nextPreview')?.closest('.presenter-panel')?.getBoundingClientRect()
    const nav = document.querySelector('.presenter-controls')?.getBoundingClientRect()
    const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none' && !el.closest('[hidden]')
    const textEls = [...t.querySelectorAll('*')].filter((el) => shown(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
    const buttons = [...t.querySelectorAll('button')].filter(shown)
    const icons = [...t.querySelectorAll('svg')].filter(shown).map((s) => getComputedStyle(s).width)
    return {
      show: t.classList.contains('show') && getComputedStyle(t).opacity === '1', text: t.innerText.replace(/\s+/g, ' ').trim(),
      underStrip: !!st && r.top >= st.bottom && r.top <= st.bottom + 24,
      clearOfNext: !next || r.right <= next.left || r.left >= next.right || r.bottom <= next.top || r.top >= next.bottom,
      clearOfNav: !nav || r.bottom <= nav.top,
      sizes: [...new Set(textEls.map((el) => parseFloat(getComputedStyle(el).fontSize)))].sort((a, b) => a - b),
      icons: [...new Set(icons)], tips: Object.fromEntries(buttons.filter((b) => b.id).map((b) => [b.id, [b.dataset.tip, b.dataset.key ?? '']])),
      wraps: t.getBoundingClientRect().height > 46
    }
  }, selector)
  const checkToast = (name, t, text, ids) => {
    if (!t) { check(false, `${name}: no toast`); return }
    check(t.show, `${name}: shows`)
    check(text.test(t.text), `${name}: reads ${text} (${t.text})`)
    check(t.underStrip, `${name}: sits under the status strip`)
    check(t.clearOfNext && t.clearOfNav, `${name}: clear of the Next preview and the bottom bar`)
    check(!t.wraps, `${name}: one line`)
    check(t.sizes.every((px) => px === 13 || px === 14), `${name}: chrome sizes 14px text, 13px buttons (${t.sizes.join(', ')})`)
    check(t.icons.every((w) => w === '16px'), `${name}: lucide icons at 16px (${t.icons.join(', ')})`)
    for (const id of ids) check(JSON.stringify(t.tips[id]) === JSON.stringify(TIPS[id]), `${name}: ${id} tooltip "${TIPS[id].join('  ')}" (${t.tips[id]?.join('  ')})`)
  }
  const toastShot = async (page, file) => { if (SHOTS) { await page.mouse.move(5, 500); await settle(page, 350); await page.screenshot({ path: join(SHOTS, file) }) } }
  // Start offer: the title slide held for a minute, then forward (Playwright's clock skips the wait).
  {
    const { page, context } = await open([1440, 900], process.env.SLIDE_TITLE || (FIXTURE_DECK ? 'one' : ''), { clock: true })
    await page.evaluate(() => { window.__push?.('live:status', 'live'); window.__audience?.({ reactions: { puzzled: 2, helped: 5, bookmark: 1 }, questions: 3 }) })
    await settle(page, 400)
    await page.clock.fastForward(61_000)
    await settle(page, 300)
    await page.keyboard.press('ArrowRight')
    await settle(page, 600)
    await page.mouse.move(5, 500)
    const t = await readToast(page, '.twrec-start-offer')
    checkToast('start offer', t, /^Start recording\? Offered once, fades in 8 seconds Record ⇧R$/, ['twrec-start-record'])
    await toastShot(page, 'toast-start-offer-1440x900.png')
    await tap(page, '#twrec-start-record')
    check(await recIs(page, 'recording'), 'start offer: its Record button starts a recording')
    check(!(await readToast(page, '.twrec-start-offer'))?.show, 'start offer: goes when the recording starts')
    check(!await page.$('.twrec-picker'), 'start offer: no run-kind picker on start')
    await context.close()
  }
  // Recording paused, then a slide move.
  {
    const { page, context } = await open([1440, 900], SLIDE_L1)
    await setL1(page)
    await toState(page, 'paused')
    await page.keyboard.press('ArrowRight')
    await settle(page, 600)
    const t = await readToast(page, '.twrec-paused-offer')
    checkToast('paused toast', t, /^Recording is paused\. Resume\? Resume recording ⇧P$/, ['twrec-toast-yes'])
    await toastShot(page, 'toast-rec-paused-1440x900.png')
    await tap(page, '#twrec-toast-yes')
    check(await recIs(page, 'recording'), 'paused toast: Resume recording resumes')
    await context.close()
  }
  // Last slide: save the run, then the saved note with Change.
  {
    const { page, context } = await open([1440, 900], SLIDE_L1)
    await setL1(page)
    await page.keyboard.press('End')
    await page.waitForFunction(() => document.querySelector('.twrec-save-offer')?.classList.contains('show'), null, { timeout: 6000 }).catch(() => {})
    await settle(page, 300)
    const t = await readToast(page, '.twrec-save-offer')
    checkToast('save toast', t, /^Last slide\. Save this run to History\? Save as Delivery ↵ Save as… L$/, ['twrec-save-delivery', 'twrec-save-as'])
    await toastShot(page, 'toast-save-run-1440x900.png')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.querySelector('.twrec-saved-note')?.classList.contains('show'), null, { timeout: 6000 }).catch(() => {})
    await settle(page, 300)
    const runs = await page.evaluate(() => window.__ipcCalls.filter((c) => c.channel === 'recording:save').map((c) => c.payload))
    check(runs.length === 1 && runs[0].mode === 'run' && runs[0].kind === 'delivery', `save toast: Enter saves the run as a delivery (${JSON.stringify(runs)})`)
    const s = await readToast(page, '.twrec-saved-note')
    checkToast('saved toast', s, /^Saved to History as Delivery · \d\d:\d\d Change L$/, ['twrec-saved-change'])
    await toastShot(page, 'toast-saved-1440x900.png')
    await tap(page, '#twrec-saved-change')
    check(await page.waitForSelector('.twrec-picker', { timeout: 3000 }).then(() => true).catch(() => false), 'saved toast: Change opens the run-kind picker')
    await page.keyboard.press('Escape')
    check(page.errors.length === 0, `toasts: no page errors (${page.errors.join('; ')})`)
    await context.close()
  }

  assert.deepEqual(failures, [], `presenter recording:\n  ${failures.join('\n  ')}`)
  console.log(`presenter recording: idle, recording, paused, saving and saved drawn and fitted at 1280 and 1440 beside L1; Record, Pause, Resume, Stop, Change, ⇧R, ⇧P and L as before, no picker on start; four toasts under the strip — collapse ${reached.join('; ')}`)
} finally {
  await browser?.close()
  await rm(scratch, { recursive: true, force: true })
}
