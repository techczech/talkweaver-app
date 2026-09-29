// Poll panel, composers, go-live panel and the venue-screen notice (ADR-0031, presenter redesign
// ticket 06; drawn in the round-2 presenter redesign drawings). The compiled presenter
// window in headless Chromium at 1440x900, with the recording preload (and through it the live
// bridge) bundled against a stub of electron and injected as the app injects it. Seams:
//  1. the poll panel in each drawn state — armed, collecting (results shown as they arrive),
//     collecting with results held, closed with results shown to the room: every action of the
//     state sits in the panel's head row, in view and unclipped, and works (it reaches the live
//     bridge, or changes what the screens show); the badges read "Single choice" and "Results held"
//     or "Results shown as they arrive"; the held note sits under the badges; live status appears
//     once, in the status bar, never in the panel;
//  2. the composers' open and submit functions: the Quick-poll and instant-slide composers open
//     from the bottom bar over a slide with notes at the bottom, their primary action is in view
//     without scrolling however long the form, ↵ opens the Quick poll, Show on every screen sends
//     the instant slide; chrome type scale only;
//  3. the go-live panel after Go live: dark, the join link, the venue-screen row, "1 venue screen
//     connected" once one follows, the hint; Esc hides it;
//  4. the venue-screen notice, driven by the live session's presence count (the "live:presence"
//     push): nothing until a venue screen has followed; "not following · reconnecting" when the
//     count drops to 0 while live; "following again" when it returns, gone after three seconds;
//     hidden while the laptop itself reconnects; the top bar still fits, collapsing no further
//     than the drawing (c7 at 1440, c8 at 1280).
// Every check is collected and all failures are reported together.
// Usage: node scripts/test-presenter-polls.mjs
//   SHOTS=<dir> saves the drawn states at 1440x900 (venue-lost also at 1280x800), with a running
//   talk (timer, recording, live, audience counts) as in the drawing.
//   DECK=<compiled deck.html> uses that deck instead of the fixture (the build shots use the demo
//   talk). SLIDE_NOTES is a slide with notes (default "two"); SLIDE_POLL a slide for the poll
//   states (default "held"); with DECK the armed poll is staged on SLIDE_POLL's data-poll, as the
//   drawing does.
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
const CHROME_SIZES = [13, 14, 16, 26]
const ORDER = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10']
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

### The evolution of agents {id=two}

- AI as oracle
- AI as tool maker
- AI as tool user

:::notes
Three stages, and the room will know the first two. AI as oracle is where most people still are: you ask, it answers, translates or summarises.

AI as tool maker came next. You ask for code, a chart or a small app, and it writes the thing.

The third stage is the one this talk is about. AI as tool user works with your files and your software to finish a task.
:::

### Have you let an AI agent work on your files this month? {id=held poll=single pollresults=held}

- Yes
- No
- Not sure

### What makes an agent useful? {id=three}

- A chat can tell me how to fill in an expenses form.
- An agent can find the form and fill it in.
`
const QUESTION = 'Have you let an AI agent work on your files this month?'
const OPTIONS = [{ optionId: 'a', label: 'Yes' }, { optionId: 'b', label: 'No' }, { optionId: 'c', label: 'Not sure' }]
const QUICK = { type: 'poll.state', pollId: 'quick-drawing', pollType: 'single', question: QUESTION, options: OPTIONS, visibility: 'live', open: true, revealed: false, tallies: { a: 9, b: 21, c: 6 } }
const STAGED = { pollId: 'staged-poll', type: 'single', question: QUESTION, options: OPTIONS, visibility: 'held' }

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-presenter-polls-'))
let browser
try {
  let htmlPath = process.env.DECK ? resolve(process.env.DECK) : null
  if (!htmlPath) {
    const sourcePath = join(scratch, 'polls.md')
    await writeFile(sourcePath, FIXTURE)
    const model = await prepareSource(sourcePath, FIXTURE, 'The current state of AI agents', statSync(sourcePath))
    htmlPath = join(scratch, 'polls-present.html')
    await writeFile(htmlPath, model.fullHtml)
  }
  const SLIDE_NOTES = process.env.SLIDE_NOTES || 'two'
  const SLIDE_POLL = process.env.SLIDE_POLL || 'held'
  const SLIDE_GOLIVE = process.env.SLIDE_GOLIVE || 'one'
  const stubPath = join(scratch, 'electron-stub.mjs')
  await writeFile(stubPath, `const ok = { success: true, status: 'confirmed' }
const answers = { 'recording:context': { testMode: true, talkSlug: 'polls', discardThresholdMs: 0 }, 'live:status': 'ended', 'live:snapshot': {},
  'live:end': { success: true, status: 'ended' }, 'live:poll-open': ok, 'live:poll-close': ok, 'live:poll-reveal': ok, 'live:poll-hide': ok, 'live:instant-action': ok,
  'live:go': { success: true, status: 'live', shortUrl: 'https://handouts.fyi/737u', qrSvg: '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="#fff"/><rect x="1" y="1" width="3" height="3"/><rect x="6" y="1" width="3" height="3"/><rect x="1" y="6" width="3" height="3"/><rect x="5" y="5" width="1" height="1"/><rect x="7" y="6" width="2" height="1"/><rect x="6" y="8" width="1" height="1"/></svg>' } }
window.__ipcCalls = []; window.__ipcOn = {}
export const ipcRenderer = {
  invoke: async (channel, ...args) => { window.__ipcCalls.push(channel); return channel in answers ? answers[channel] : {} },
  on(channel, fn) { (window.__ipcOn[channel] ||= []).push(fn) }, send() {}, removeListener() {}
}
window.__push = (channel, value) => { for (const fn of window.__ipcOn[channel] || []) fn(null, value) }
export const contextBridge = { exposeInMainWorld: (name, api) => { window[name] = api } }
export const clipboard = { writeText(value) { window.__copied = value }, readText: () => '', readImage: () => null }
`)
  const bundle = await build({ entryPoints: [join(repo, 'src/preload/present-recorder.ts')], bundle: true, write: false, format: 'iife', platform: 'browser', alias: { electron: stubPath }, logLevel: 'silent' })
  const preload = bundle.outputFiles[0].text
  const audienceFixture = `if (window === window.top && window.twLivePollBridge) window.twLivePollBridge.onAudience = (cb) => { window.__audience = cb }`

  browser = await chromium.launch({ headless: true })
  const settle = (page, ms = 250) => page.waitForTimeout(ms)
  const open = async ([width, height], slide) => {
    const context = await browser.newContext({ viewport: { width, height } })
    await context.addInitScript({ content: `if (window === window.top) {\n${preload}\n}` })
    await context.addInitScript({ content: audienceFixture })
    const page = await context.newPage()
    page.errors = []
    page.on('pageerror', (error) => page.errors.push(error.message))
    page.on('dialog', (dialog) => dialog.accept())
    await page.goto(`${pathToFileURL(htmlPath).href}?presenter=1${slide ? `#${slide}` : ''}`, { waitUntil: 'load', timeout: 120000 })
    await page.waitForFunction(() => /scale\(([\d.]+)\)/.test(document.querySelector('#currentPreview iframe')?.style.transform || ''), null, { timeout: 30000 })
    await page.waitForSelector('#presenterStatus #twrec-module', { timeout: 10000 }).catch(() => {})
    if (await page.isVisible('#twResume')) await tap(page, '#twResumeNo')
    await page.mouse.move(5, 500)
    return { page, context }
  }
  // The drawing's running talk for the shots: timer 15:42 into 30 minutes, a recording, live,
  // audience counts. The tests themselves only need the live status.
  const run = async (page) => {
    if (!SHOTS) { await page.evaluate(() => window.__push('live:status', 'live')); return }
    await page.evaluate(() => {
      const deck = (Object.keys(sessionStorage).find((x) => x.endsWith(':session')) || '').replace(/:session$/, '')
      sessionStorage.setItem(`${deck}:timer`, JSON.stringify({ targetSeconds: 1800, elapsedMs: 942000, runningSince: Date.now(), reminders: [5, 1] }))
    })
    await page.reload({ waitUntil: 'load' })
    await page.waitForFunction(() => /scale\(([\d.]+)\)/.test(document.querySelector('#currentPreview iframe')?.style.transform || ''), null, { timeout: 30000 })
    await page.waitForSelector('#presenterStatus #twrec-module', { timeout: 10000 }).catch(() => {})
    await page.click('#twrec-primary').catch(() => {})
    await page.waitForFunction(() => document.getElementById('twrec-module')?.dataset.rec === 'recording', null, { timeout: 5000 }).catch(() => {})
    await page.evaluate(() => {
      window.__push('live:status', 'live')
      window.__audience?.({ reactions: { puzzled: 2, helped: 5, bookmark: 1 }, questions: 3 })
    })
    await page.mouse.move(5, 500)
  }
  const shot = async (page, name) => { if (SHOTS) { await page.mouse.move(5, 500); await settle(page, 300); await page.screenshot({ path: join(SHOTS, name) }) } }
  if (SHOTS) await mkdir(SHOTS, { recursive: true })

  // Live status, counted where it is drawn: text naming the session's state, anywhere visible.
  const livePlaces = () => {
    const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]')
    return [...document.querySelectorAll('body *')].filter(shown)
      .filter((el) => !el.closest('#presenterMenuLive, .tw-menu, #liveGoPanel, .quick-poll-compose, #currentPreview, #nextPreview, #presenterFollowing'))
      .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && /\blive\b|reconnecting/i.test(n.textContent) && !/go live|end live|not live/i.test(n.textContent)))
      .map((el) => el.id || el.className)
  }
  // The poll panel as drawn: where its actions are and whether each is in view, unclipped, on one line.
  const pollPanel = () => {
    const panel = document.getElementById('presenterPollPanel')
    const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none' && !el.closest('[hidden]')
    if (!shown(panel)) return { shown: false }
    const box = panel.getBoundingClientRect()
    const head = panel.querySelector('.presenter-poll-head')
    const headBox = head?.getBoundingClientRect()
    const buttons = [...panel.querySelectorAll('button')].filter(shown).filter((b) => !b.closest('.presenter-poll-results'))
    const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim()
    const meta = panel.querySelector('.presenter-poll-meta')
    const held = document.getElementById('presenterPollHeldNote')
    const badges = [...panel.querySelectorAll('.presenter-poll-badge')].filter(shown)
    const hit = (b) => { const r = b.getBoundingClientRect(); return b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) }
    return {
      shown: true,
      chip: text(document.getElementById('presenterPollChip')),
      actions: buttons.filter((b) => b.id !== 'presenterPollDismiss').map((b) => b.querySelector('.tw-btn-label') ? text(b.querySelector('.tw-btn-label')) : text(b)),
      notInHead: buttons.filter((b) => !head?.contains(b)).map((b) => b.id),
      outOfView: buttons.filter((b) => { const r = b.getBoundingClientRect(); return r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5 || r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.bottom > innerHeight || !hit(b) }).map((b) => b.id),
      wrapped: buttons.filter((b) => b.getBoundingClientRect().height > 34).map((b) => b.id),
      noIcon: buttons.filter((b) => !b.querySelector(':scope > svg[class*="lucide-"]')).map((b) => b.id),
      oneHeadRow: buttons.every((b) => Math.abs(b.getBoundingClientRect().top - buttons[0].getBoundingClientRect().top) < 2),
      keys: Object.fromEntries(buttons.map((b) => [b.id, getComputedStyle(b, '::after').content])),
      badges: badges.map(text), count: text(document.getElementById('presenterPollCount')),
      heldShown: shown(held), heldText: text(held), heldInMeta: !!meta?.contains(held),
      heldUnderBadges: shown(held) && badges.every((b) => held.getBoundingClientRect().top >= b.getBoundingClientRect().bottom - 0.5),
      liveChip: !!panel.querySelector('#presenterPollLiveChip, .presenter-poll-live-chip'),
      headHeight: Math.round(headBox?.height || 0),
      fonts: [...new Set([...panel.querySelectorAll('.presenter-poll-head *, .presenter-poll-meta *, .presenter-poll-display-status')].filter(shown).filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())).map((el) => parseFloat(getComputedStyle(el).fontSize)))].sort((a, b) => a - b)
    }
  }
  const ipc = (page) => page.evaluate(() => window.__ipcCalls.slice())
  const callsSince = async (page, before) => (await ipc(page)).slice(before.length)

  // ── 1. The poll panel in each drawn state ─────────────────────────────────────────────────
  {
    const { page, context } = await open([1440, 900], SLIDE_POLL)
    await run(page)
    if (process.env.DECK) {
      await page.evaluate(([id, away, poll]) => { const s = document.querySelector(`.slide[data-id="${id}"]`); if (s) s.dataset.poll = JSON.stringify(poll); location.hash = '#' + away; setTimeout(() => { location.hash = '#' + id }, 50) }, [SLIDE_POLL, SLIDE_NOTES, STAGED])
      await settle(page, 600)
    }
    await settle(page, 500)
    const expect = (p, name, actions) => {
      check(p.shown, `${name}: the poll panel shows`)
      if (!p.shown) return
      check(JSON.stringify(p.actions) === JSON.stringify(actions), `${name}: the actions are ${actions.join(' · ')} (${p.actions.join(' · ')})`)
      check(p.notInHead.length === 0, `${name}: every action sits in the head row (not in it: ${p.notInHead.join(', ')})`)
      check(p.oneHeadRow, `${name}: the actions share one row at 1440`)
      check(p.outOfView.length === 0, `${name}: every action is in view and unclipped (${p.outOfView.join(', ')})`)
      check(p.wrapped.length === 0, `${name}: no action label wraps (${p.wrapped.join(', ')})`)
      check(!p.liveChip, `${name}: the panel has no live chip`)
      check(p.noIcon.length === 0, `${name}: every action carries its icon (none: ${p.noIcon.join(', ')})`)
      check(p.fonts.every((px) => CHROME_SIZES.includes(px)), `${name}: head and badges on the chrome sizes (${p.fonts.join(', ')})`)
    }
    const placesOnce = async (name) => {
      const places = await page.evaluate(livePlaces)
      check(places.length === 1 && places[0] === 'presenterLiveLabel', `${name}: live status appears once, in the status bar (${places.join(', ')})`)
    }

    // Armed: the slide's own poll, not yet open.
    let p = await page.evaluate(pollPanel)
    expect(p, 'armed', ['Open poll'])
    check(p.chip === 'Poll ready', `armed: chip "Poll ready" (${p.chip})`)
    check(p.badges.join(' | ') === 'Single choice | Results held', `armed: badges "Single choice", "Results held" (${p.badges.join(' | ')})`)
    check(p.keys.presenterPollOpen === '"Q"', `armed: Open poll shows its key Q (${p.keys.presenterPollOpen})`)
    check(!p.heldShown, 'armed: no held note before the poll opens')
    await placesOnce('armed')
    await shot(page, 'poll-armed-1440x900.png')
    let before = await ipc(page)
    await tap(page, '#presenterPollOpen'); await settle(page)
    check((await callsSince(page, before)).includes('live:poll-open'), 'armed: Open poll opens the poll through the live bridge')

    // Collecting, results shown as they arrive (a Quick poll, as drawn).
    await page.evaluate((m) => window.__push('live:poll-state', m), QUICK); await settle(page, 400)
    p = await page.evaluate(pollPanel)
    expect(p, 'collecting', ['Stop accepting responses', 'Show results', 'Dismiss Quick poll'])
    check(p.chip === 'Poll open · 36', `collecting: chip "Poll open · 36" (${p.chip})`)
    check(p.badges.join(' | ') === 'Single choice | Results shown as they arrive', `collecting: badges "Single choice", "Results shown as they arrive" (${p.badges.join(' | ')})`)
    check(p.count === '· 36 votes', `collecting: the count (${p.count})`)
    check(!p.heldShown, 'collecting: no held note while results are public')
    await placesOnce('collecting')
    await shot(page, 'poll-collecting-1440x900.png')
    before = await ipc(page)
    await tap(page, '#presenterPollClose'); await settle(page)
    check((await callsSince(page, before)).includes('live:poll-close'), 'collecting: Stop accepting responses closes the poll through the live bridge')

    // Collecting with results held.
    await page.evaluate((m) => window.__push('live:poll-state', m), { ...QUICK, visibility: 'held' }); await settle(page, 400)
    p = await page.evaluate(pollPanel)
    expect(p, 'collecting-held', ['Reveal results', 'Stop accepting responses', 'Dismiss Quick poll'])
    check(p.keys.presenterPollReveal === '"⇧ Q"' && p.keys.presenterPollClose === '"Q"', `collecting-held: Reveal and Stop show their keys (${p.keys.presenterPollReveal}, ${p.keys.presenterPollClose})`)
    check(p.badges.includes('Results held'), `collecting-held: badge "Results held" (${p.badges.join(' | ')})`)
    check(p.heldShown && p.heldInMeta && p.heldUnderBadges, `collecting-held: the held note shows under the badges (shown ${p.heldShown}, in the badges' block ${p.heldInMeta}, under them ${p.heldUnderBadges})`)
    check(p.heldText === 'Held: only you see results until you reveal them.', `collecting-held: the held note's words (${p.heldText})`)
    await placesOnce('collecting-held')
    await shot(page, 'poll-collecting-held-1440x900.png')
    before = await ipc(page)
    await tap(page, '#presenterPollReveal'); await settle(page)
    check((await callsSince(page, before)).includes('live:poll-reveal'), 'collecting-held: Reveal results reveals through the live bridge')

    // Closed, results shown to the room.
    await page.evaluate((m) => window.__push('live:poll-state', m), { ...QUICK, open: false, revealed: true, tallies: { a: 11, b: 24, c: 7 } }); await settle(page, 400)
    // Revealed results go to the screens by themselves; Show results does it otherwise.
    if (await page.isVisible('#presenterPollShowResults')) { await tap(page, '#presenterPollShowResults'); await settle(page, 400) }
    p = await page.evaluate(pollPanel)
    expect(p, 'results-shown', ['Reopen responses', 'Show question', 'Dismiss Quick poll'])
    check(p.chip === 'Poll closed · 42', `results-shown: chip "Poll closed · 42" (${p.chip})`)
    const audience = await page.evaluate(() => document.getElementById('presenterPollDisplayStatus')?.textContent || '')
    check(/^Audience sees: results\./.test(audience), `results-shown: Show results puts the results on screens (${audience})`)
    await placesOnce('results-shown')
    await shot(page, 'poll-results-shown-1440x900.png')
    before = await ipc(page)
    await tap(page, '#presenterPollOpen'); await settle(page)
    check((await callsSince(page, before)).includes('live:poll-open'), 'results-shown: Reopen responses reopens through the live bridge')
    await tap(page, '#presenterPollShowQuestion'); await settle(page, 300)
    p = await page.evaluate(pollPanel)
    check(p.actions.includes('Show results') && !p.actions.includes('Show question'), `results-shown: Show question puts the question back (${p.actions.join(' · ')})`)
    await tap(page, '#presenterQuickPollDismiss'); await settle(page, 300)
    p = await page.evaluate(pollPanel)
    check(p.shown && p.chip === 'Poll ready', `Dismiss Quick poll takes the Quick poll off the screens; the slide's own poll is back (${p.chip})`)
    await tap(page, '#presenterPollDismiss'); await settle(page, 300)
    check(!(await page.evaluate(pollPanel)).shown, '× hides the poll panel')
    check(page.errors.length === 0, `poll panel: no page errors (${page.errors.join('; ')})`)
    await context.close()
  }

  // ── 2. The composers over a slide with notes at the bottom ────────────────────────────────
  const composerFit = ([id, primary]) => {
    const card = document.getElementById(id)
    const button = document.getElementById(primary)
    const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none' && !el.closest('[hidden]')
    if (!shown(card) || !button) return { shown: false }
    const r = button.getBoundingClientRect()
    const bar = document.getElementById('presenterBottomBar')?.getBoundingClientRect()
    const notes = document.querySelector('.presenter-notes')?.getBoundingClientRect()
    const hitEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    const drawnText = [...card.querySelectorAll('*')].filter((el) => shown(el) && !el.closest('#instantComposeThumb, #instantPasteThumb') && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
    return {
      shown: true,
      inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
      aboveBar: !bar || r.bottom <= bar.top + 0.5,
      cardAboveBar: !bar || card.getBoundingClientRect().bottom <= bar.top + 0.5,
      topmost: button.contains(hitEl), hit: hitEl?.id || hitEl?.className || '',
      overNotes: !!notes && card.getBoundingClientRect().bottom > notes.top,
      scrolls: card.scrollHeight > card.clientHeight + 1,
      label: (button.textContent || '').replace(/\s+/g, ' ').trim(),
      fonts: [...new Set(drawnText.map((el) => parseFloat(getComputedStyle(el).fontSize)))].sort((a, b) => a - b),
      background: getComputedStyle(card).backgroundColor
    }
  }
  {
    const { page, context } = await open([1440, 900], SLIDE_NOTES)
    await run(page)
    await settle(page, 400)
    const placement = await page.evaluate(() => document.querySelector('.presenter-root')?.dataset.notesPlacement)
    check(placement === 'bottom', `composers: notes at the bottom, the default (${placement})`)
    // Quick poll from the bottom bar, filled as drawn.
    await tap(page, '#navQuickPoll'); await settle(page, 300)
    await page.fill('#quickPollQuestion', 'Which of these have you tried this month?').catch(() => failures.push('quick poll: no question field'))
    await page.click('[data-quick-poll-preset="Yes|No|Maybe"]').catch(() => failures.push('quick poll: no Yes / No / Maybe preset'))
    await settle(page, 200)
    let f = await page.evaluate(composerFit, ['presenterQuickPollCompose', 'quickPollOpen'])
    check(f.shown, 'quick poll: the composer opens from the bottom bar')
    if (f.shown) {
      check(f.inView && f.aboveBar && f.topmost, `quick poll: Open poll is in view without scrolling (in view ${f.inView}, above the bottom bar ${f.aboveBar}, topmost ${f.topmost}: ${f.hit})`)
      check(f.cardAboveBar, 'quick poll: the composer stops at the bottom bar')
      check(/^Open poll/.test(f.label), `quick poll: the primary action reads Open poll (${f.label})`)
      const icons = await page.evaluate(() => ({ title: !!document.querySelector('#presenterQuickPollCompose .quick-poll-title svg.lucide-vote'), open: !!document.querySelector('#quickPollOpen svg.lucide-lock-open') }))
      check(icons.title && icons.open, `quick poll: title and Open poll carry their icons (${JSON.stringify(icons)})`)
      check(f.fonts.every((px) => CHROME_SIZES.includes(px)), `quick poll: chrome sizes only (${f.fonts.join(', ')})`)
      const labels = await page.evaluate(() => ({
        results: document.querySelector('[data-quick-poll-visibility="live"]')?.textContent.trim(),
        field: document.querySelector('[data-quick-poll-visibility="live"]')?.closest('.quick-poll-field')?.querySelector(':scope > span')?.textContent.trim()
      }))
      check(labels.field === 'Results' && labels.results === 'Shown as they arrive', `quick poll: results segment "Results": "Shown as they arrive" / "Held" (${labels.field}: ${labels.results})`)
    }
    await shot(page, 'quickpoll-composer-1440x900.png')
    // A long form: every extra option pushes the form down; Open poll stays pinned in view.
    for (let i = 0; i < 6; i++) await page.click('#quickPollAddOption').catch(() => {})
    await page.evaluate(() => { const c = document.getElementById('presenterQuickPollCompose'); if (c) c.scrollTop = 0 })
    await settle(page, 200)
    f = await page.evaluate(composerFit, ['presenterQuickPollCompose', 'quickPollOpen'])
    check(f.shown && f.scrolls, `quick poll: a long form scrolls inside the composer (${f.scrolls})`)
    check(f.shown && f.inView && f.aboveBar && f.topmost, `quick poll: with a long form, Open poll is still in view without scrolling (in view ${f.inView}, above bar ${f.aboveBar}, topmost ${f.topmost}: ${f.hit})`)
    await page.evaluate(() => [...document.querySelectorAll('#quickPollOptions .quick-poll-remove')].slice(3).forEach((b) => b.click()))
    // ↵ opens it, as the key cap shows.
    const before = await ipc(page)
    await page.focus('#quickPollQuestion').catch(() => {})
    await page.keyboard.press('Enter'); await settle(page, 300)
    check((await callsSince(page, before)).includes('live:poll-open'), '↵ in the Quick-poll composer opens the poll through the live bridge')
    check(await page.evaluate(() => document.getElementById('presenterQuickPollCompose')?.hidden === true), 'the Quick-poll composer closes once the poll opens')
    // The poll it opened is a Quick poll: its panel offers Dismiss Quick poll in the head.
    const p = await page.evaluate(pollPanel)
    check(p.shown && p.actions.includes('Dismiss Quick poll') && p.notInHead.length === 0, `the new Quick poll's panel has Dismiss Quick poll in its head (${p.actions?.join(' · ')})`)
    await tap(page, '#presenterQuickPollDismiss'); await settle(page, 300)

    // Instant slide from the bottom bar.
    await tap(page, '#navInstant'); await settle(page, 300)
    await page.fill('#instantText', 'Break until 11:15 · coffee in the foyer').catch(() => failures.push('instant slide: no text field'))
    await settle(page, 300)
    f = await page.evaluate(composerFit, ['presenterInstantCompose', 'instantShow'])
    check(f.shown, 'instant slide: the composer opens from the bottom bar')
    if (f.shown) {
      check(f.inView && f.aboveBar && f.topmost, `instant slide: Show on every screen is in view without scrolling (in view ${f.inView}, above bar ${f.aboveBar}, topmost ${f.topmost}: ${f.hit})`)
      check(/^Show on every screen/.test(f.label), `instant slide: the primary action reads Show on every screen (${f.label})`)
      check(f.fonts.every((px) => CHROME_SIZES.includes(px)), `instant slide: chrome sizes only (${f.fonts.join(', ')})`)
      const title = await page.evaluate(() => document.querySelector('#presenterInstantCompose .quick-poll-title svg')?.classList.contains('lucide-zap'))
      check(title, 'instant slide: the title carries its icon')
      const tabs = await page.evaluate(() => [...document.querySelectorAll('[data-instant-tab] svg')].map((s) => [...s.classList].find((c) => c.startsWith('lucide-'))).join(' '))
      check(tabs === 'lucide-type lucide-image lucide-clock', `instant slide: the type tabs carry their icons (${tabs})`)
    }
    await shot(page, 'instant-composer-1440x900.png')
    const beforeInstant = await ipc(page)
    await tap(page, '#instantShow'); await settle(page, 300)
    check((await callsSince(page, beforeInstant)).includes('live:instant-action'), 'instant slide: Show on every screen sends it through the live bridge')
    check(page.errors.length === 0, `composers: no page errors (${page.errors.join('; ')})`)
    await context.close()
  }

  // ── 3 and 4. Go-live panel, then the venue-screen notice ──────────────────────────────────
  const topBar = () => {
    const bar = document.getElementById('presenterTopBar')
    const notice = document.getElementById('presenterVenueNotice')
    const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]')
    const texts = bar ? [...bar.querySelectorAll('*')].filter((el) => shown(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) : []
    const wrapped = texts.filter((el) => {
      const tops = []
      for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) { const r = document.createRange(); r.selectNodeContents(n); for (const x of r.getClientRects()) if (x.width > 0) tops.push(Math.round(x.top / 6)) }
      return new Set(tops).size > 1
    }).map((el) => el.id || el.className)
    return {
      notice: shown(notice) ? notice.innerText.replace(/\s+/g, ' ').trim() : null, tone: notice?.dataset.tone ?? null, tip: notice?.dataset.tip ?? '',
      icon: notice?.querySelector('svg') ? [...notice.querySelector('svg').classList].find((c) => c.startsWith('lucide-')) : null,
      beside: !!notice && notice.previousElementSibling?.id === 'presenterLiveStatus',
      live: document.getElementById('presenterLiveLabel')?.textContent.trim(),
      collapse: bar?.dataset.collapse ?? null, fits: bar?.dataset.fits ?? null, wrapped,
      sizes: [...new Set(texts.map((el) => parseFloat(getComputedStyle(el).fontSize)))].sort((a, b) => a - b),
      overflow: document.documentElement.scrollWidth > innerWidth
    }
  }
  const ladder = (t, name, reach) => {
    const steps = (t.collapse || '').split(' ').filter(Boolean)
    check(t.fits === 'true', `${name}: the top bar still fits (${t.fits}; ${t.collapse})`)
    check(steps.every((s, i) => s === ORDER[i]) && steps.length <= reach, `${name}: collapses in order, no further than c${reach} (${t.collapse || 'none'})`)
    check(t.wrapped.length === 0 && !t.overflow, `${name}: nothing wraps or overflows (${t.wrapped.join(', ')})`)
    check(t.sizes.every((px) => CHROME_SIZES.includes(px)), `${name}: chrome sizes only (${t.sizes.join(', ')})`)
  }
  {
    const { page, context } = await open([1440, 900], SLIDE_GOLIVE)
    await tap(page, '#presenterMenuLive'); await settle(page, 200)
    await tap(page, '#liveGoButton'); await settle(page, 500)
    await page.evaluate(() => window.__push('live:presence', { presenterConnected: true, venueScreens: 1 })); await settle(page, 300)
    const g = await page.evaluate(() => {
      const panel = document.getElementById('liveGoPanel')
      const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none' && !el.closest('[hidden]')
      if (!shown(panel)) return { shown: false }
      const r = panel.getBoundingClientRect()
      const bg = getComputedStyle(panel).backgroundColor.match(/\d+/g).map(Number)
      const texts = [...panel.querySelectorAll('*')].filter((el) => shown(el) && !el.closest('#liveQr') && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
      const count = document.getElementById('liveVenueCount')
      return {
        shown: true, inView: r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
        dark: (bg[0] + bg[1] + bg[2]) / 3 < 60,
        label: document.querySelector('.live-go-panel-label')?.textContent.trim(),
        url: document.getElementById('liveShortUrl')?.textContent.trim(), venue: document.getElementById('liveVenueUrl')?.textContent.trim(),
        venueFits: (() => { const v = document.getElementById('liveVenueUrl'); return !!v && v.scrollWidth <= v.clientWidth + 1 })(),
        count: shown(count) ? count.textContent.trim() : null, countIcon: !!count?.querySelector('svg.lucide-monitor-check'),
        hint: panel.querySelector('.live-go-panel-hint')?.textContent.replace(/\s+/g, ' ').trim() || null,
        sizes: [...new Set(texts.map((el) => parseFloat(getComputedStyle(el).fontSize)))].sort((a, b) => a - b)
      }
    })
    check(g.shown, 'go-live: the panel shows after Go live')
    if (g.shown) {
      check(g.dark, 'go-live: the panel takes the chrome style (dark card)')
      check(g.inView, 'go-live: the panel is in view')
      check(g.label === 'You are live', `go-live: "You are live" (${g.label})`)
      check(g.url === 'handouts.fyi/737u' && g.venue === 'handouts.fyi/737u/p', `go-live: join link and venue-screen link, shown without the scheme (${g.url}; ${g.venue})`)
      check(g.venueFits, 'go-live: the venue-screen link fits its row (no ellipsis)')
      check(g.count === '1 venue screen connected' && g.countIcon, `go-live: "1 venue screen connected" with its icon once one follows (${g.count}; icon ${g.countIcon})`)
      check(g.hint === 'Audience join link above. Esc hides this panel; Live › Show join link brings it back.', `go-live: the hint (${g.hint})`)
      check(g.sizes.every((px) => CHROME_SIZES.includes(px)), `go-live: chrome sizes only (${g.sizes.join(', ')})`)
    }
    await shot(page, 'golive-panel-1440x900.png')
    await tap(page, '#liveVenueCopy')
    const copied = await page.evaluate(() => window.__copied)
    check(copied === 'https://handouts.fyi/737u/p', `go-live: Copy takes the whole venue-screen link (${copied})`)
    await page.keyboard.press('Escape'); await settle(page, 200)
    check(await page.evaluate(() => document.getElementById('liveGoPanel')?.hidden === true), 'go-live: Esc hides the panel')
    await context.close()
  }
  {
    const { page, context } = await open([1440, 900], SLIDE_NOTES)
    await run(page)
    await settle(page, 400)
    let t = await page.evaluate(topBar)
    check(t.notice === null, `venue: no notice while no venue screen has followed (${t.notice})`)
    await page.evaluate(() => window.__push('live:presence', { presenterConnected: true, venueScreens: 0 })); await settle(page, 300)
    check((await page.evaluate(topBar)).notice === null, 'venue: still none when the count is 0 and no venue screen ever followed')
    await page.evaluate(() => window.__push('live:presence', { presenterConnected: true, venueScreens: 1 })); await settle(page, 300)
    check((await page.evaluate(topBar)).notice === null, 'venue: none while a venue screen follows')
    await page.evaluate(() => window.__push('live:presence', { presenterConnected: true, venueScreens: 0 })); await settle(page, 700)
    t = await page.evaluate(topBar)
    check(t.tone === 'lost' && /^Venue screen (not following · )?reconnecting$/.test(t.notice || ''), `venue: "Venue screen not following · reconnecting" when it drops (${t.notice}; ${t.tone})`)
    check(t.beside && t.live === 'Live', `venue: the notice sits beside the live status, which still reads Live (${t.beside}; ${t.live})`)
    check(t.icon === 'lucide-monitor-x', `venue: lost carries monitor-x (${t.icon})`)
    check(/^Venue screen not following · reconnecting/.test(t.tip), `venue: the tooltip keeps the full words (${t.tip})`)
    ladder(t, 'venue lost @1440', 7)
    check((t.collapse || '').includes('c7') === (t.notice === 'Venue screen reconnecting'), `venue: c7 shortens the notice, only then (${t.collapse}; ${t.notice})`)
    await shot(page, 'venue-lost-1440x900.png')
    await page.evaluate(() => window.__push('live:presence', { presenterConnected: true, venueScreens: 1 })); await settle(page, 500)
    t = await page.evaluate(topBar)
    check(t.tone === 'back' && t.notice === 'Venue screen following again' && t.icon === 'lucide-monitor-check', `venue: "Venue screen following again" when it returns (${t.notice}; ${t.tone}; ${t.icon})`)
    ladder(t, 'venue back @1440', 7)
    await shot(page, 'venue-back-1440x900.png')
    await settle(page, 3000)
    check((await page.evaluate(topBar)).notice === null, 'venue: "following again" goes after three seconds')
    await page.evaluate(() => window.__push('live:presence', { presenterConnected: true, venueScreens: 0 })); await settle(page, 200)
    await page.evaluate(() => window.__push('live:status', 'paused-reconnecting')); await settle(page, 300)
    t = await page.evaluate(topBar)
    check(t.notice === null && /^Live paused/.test(t.live), `venue: hidden while the laptop itself reconnects; the live status speaks (${t.notice}; ${t.live})`)
    await page.evaluate(() => window.__push('live:status', 'live')); await settle(page, 300)
    check((await page.evaluate(topBar)).tone === 'lost', 'venue: back to "not following" once the laptop is live again and the venue screen is still gone')
    await page.evaluate(() => window.__push('live:status', 'ended')); await settle(page, 300)
    check((await page.evaluate(topBar)).notice === null, 'venue: gone when the session ends')
    check(page.errors.length === 0, `venue: no page errors (${page.errors.join('; ')})`)
    await context.close()
  }
  {
    const { page, context } = await open([1280, 800], SLIDE_NOTES)
    await run(page)
    await page.evaluate(() => window.__push('live:presence', { presenterConnected: true, venueScreens: 1 }))
    await page.evaluate(() => window.__push('live:presence', { presenterConnected: true, venueScreens: 0 })); await settle(page, 700)
    const t = await page.evaluate(topBar)
    check(t.tone === 'lost' && /reconnecting$/.test(t.notice || ''), `venue lost @1280: the notice shows (${t.notice})`)
    ladder(t, 'venue lost @1280', 8)
    await shot(page, 'venue-lost-1280x800.png')
    await context.close()
  }

  assert.deepEqual(failures, [], `presenter polls, composers, go-live, venue notice:\n  ${failures.join('\n  ')}`)
  console.log('presenter polls: poll panel armed/collecting/held/results-shown (actions in the head row, in view, working; badges; held note; live status once), Quick-poll and instant-slide composers fit at 1440 over bottom notes (↵ and Show send), go-live panel, venue-screen notice lost/back/settle from the presence count — passed')
} finally {
  await browser?.close()
  await rm(scratch, { recursive: true, force: true })
}
