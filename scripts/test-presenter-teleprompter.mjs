// Teleprompter notes and the all-talks notes setting (ADR-0028 §9, slide-design ticket 07).
// Two seams, as in test-presenter-notes-placement.mjs:
//  1. the pure NOTES_PLACEMENT block of the presenter template (settings, override resolution,
//     speed, J step, words → paragraph, bottom column choice), extracted and run here;
//  2. the compiled presenter window in headless Chromium at 1440x900 and 1728x1117: top band and
//     camera column against the locked drawings' measurements (copied from the teleprompter design round's
//     shot report into scripts/fixtures/teleprompter-drawn-measurements.json), J / ⇧J, automatic scroll, two talks sharing the all-talks setting with a
//     per-talk override, bottom notes hidden during a poll, long bottom notes reachable, and no
//     lone second column.
// Usage: node scripts/test-presenter-teleprompter.mjs
//   REPORT=1 prints the measured table; SHOTS=<dir> also saves the 1440x900 screenshots for review.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

// ── 1. The pure block ────────────────────────────────────────────────────────────────────────
const template = readFileSync(new URL('../compiler/assets/templates/presenter-popup-single-html.html', import.meta.url), 'utf8')
const START = '// === NOTES_PLACEMENT_START'
const END = '// === NOTES_PLACEMENT_END'
const block = template.slice(template.indexOf(START), template.indexOf(END))
const pure = new Function(`${block}\nreturn { NOTES_PLACEMENTS, NOTES_SETTINGS_KEY, notesOverrideKey, normaliseNotesWpm, stepNotesWpm, normaliseNotesSettings, readNotesSettings, readNotesPlacement, writeNotesSettings, notesPlacementPanels, notesBandStep, countWords, paragraphStarts, paragraphAtWords, notesDwellMs, advanceWords, bottomNotesColumns, isTeleprompterPlacement }`)()

assert.deepEqual(pure.NOTES_PLACEMENTS, ['off', 'bottom', 'sidebar', 'top-band', 'camera-column'])
assert.equal(pure.NOTES_SETTINGS_KEY, 'talkweaver:presenter:notes', 'the all-talks key the ticket names')
assert.equal(pure.notesOverrideKey('deck-y'), 'html-presentations:deck-y:notes-override')
assert.ok(pure.isTeleprompterPlacement('top-band') && pure.isTeleprompterPlacement('camera-column') && !pure.isTeleprompterPlacement('bottom'))
// Speed: words a minute, default 130, 60–220 in steps of 10.
assert.equal(pure.normaliseNotesWpm(undefined), 130)
assert.equal(pure.normaliseNotesWpm('fast'), 130)
assert.equal(pure.normaliseNotesWpm(10), 60, 'the floor is 60')
assert.equal(pure.normaliseNotesWpm(999), 220, 'the ceiling is 220')
assert.equal(pure.normaliseNotesWpm(134), 130, 'steps of 10')
assert.equal(pure.stepNotesWpm(130, 1), 140)
assert.equal(pure.stepNotesWpm(220, 1), 220, 'faster stops at 220')
assert.equal(pure.stepNotesWpm(60, -1), 60, 'slower stops at 60')
assert.deepEqual(pure.normaliseNotesSettings(null), { placement: 'bottom', scroll: 'hand', wpm: 130 }, 'defaults: bottom, by hand, 130')
assert.deepEqual(pure.normaliseNotesSettings({ placement: 'teleprompter', scroll: 'wild', wpm: 300 }), { placement: 'bottom', scroll: 'hand', wpm: 220 })
// Override vs all-talks resolution.
const store = new Map()
const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
const ovY = pure.notesOverrideKey('y')
assert.deepEqual(pure.readNotesSettings(storage, ovY), { placement: 'bottom', scroll: 'hand', wpm: 130, justThisTalk: false }, 'nothing stored → defaults')
store.set('html-presentations:y:notes-placement', 'sidebar')
assert.equal(pure.readNotesPlacement(storage, ovY), 'bottom', 'the old per-deck key is ignored')
pure.writeNotesSettings(storage, ovY, { placement: 'top-band', scroll: 'auto', wpm: 150 }, false)
assert.deepEqual(JSON.parse(store.get('talkweaver:presenter:notes')), { placement: 'top-band', scroll: 'auto', wpm: 150 })
assert.equal(store.has(ovY), false, 'an all-talks write leaves no override')
assert.equal(pure.readNotesPlacement(storage, pure.notesOverrideKey('x')), 'top-band', 'another talk reads the all-talks value')
pure.writeNotesSettings(storage, ovY, { placement: 'camera-column', scroll: 'hand', wpm: 100 }, true)
assert.deepEqual(pure.readNotesSettings(storage, ovY), { placement: 'camera-column', scroll: 'hand', wpm: 100, justThisTalk: true }, 'the override wins for its talk')
assert.equal(JSON.parse(store.get('talkweaver:presenter:notes')).placement, 'top-band', 'an override write leaves the all-talks value alone')
assert.equal(pure.readNotesPlacement(storage, pure.notesOverrideKey('x')), 'top-band', 'the override is only for its own talk')
pure.writeNotesSettings(storage, ovY, { placement: 'sidebar' }, false)
assert.equal(store.has(ovY), false, 'writing the all-talks value from a talk removes its override')
store.set(ovY, '{not json')
assert.equal(pure.readNotesPlacement(storage, ovY), 'sidebar', 'a broken override reads as absent')
const throwing = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } }
assert.equal(pure.readNotesPlacement(throwing, ovY), 'bottom', 'blocked storage reads as the default')
assert.doesNotThrow(() => pure.writeNotesSettings(throwing, ovY, { placement: 'off' }, true))
// Panels, J step, words → paragraphs, dwell, bottom columns.
assert.deepEqual(pure.notesPlacementPanels('top-band', false), { notes: true, then: false }, 'the band shows on every slide, never Then')
assert.deepEqual(pure.notesPlacementPanels('camera-column', true), { notes: true, then: false })
assert.equal(pure.notesBandStep(175, 39.7), 3 * 39.7, 'top band at 1440x900: 4.4 lines visible → a step of 3 lines')
assert.equal(pure.notesBandStep(89, 26.8), 2 * 26.8, 'bottom at 1440x900: 3.3 lines → 2 lines')
assert.equal(pure.notesBandStep(30, 26.8), 26.8, 'a step is at least one line')
assert.equal(pure.countWords('  Three  short\nwords '), 3)
assert.deepEqual(pure.paragraphStarts([4, 10, 6]), [0, 4, 14])
assert.equal(pure.paragraphAtWords([0, 4, 14], 3.9), 0)
assert.equal(pure.paragraphAtWords([0, 4, 14], 4), 1)
assert.equal(pure.paragraphAtWords([0, 4, 14], 20), 2, 'the end stays on the last paragraph')
assert.equal(pure.notesDwellMs(65, 130), 30000, 'a paragraph dwells for its words ÷ speed')
assert.equal(pure.advanceWords(0, 60000, 130, 500), 130)
assert.equal(pure.advanceWords(490, 60000, 130, 500), 500, 'progress stops at the end')
assert.equal(pure.bottomNotesColumns({ oneFits: true, twoFits: true, secondColumnLines: 0 }), 1)
assert.equal(pure.bottomNotesColumns({ oneFits: false, twoFits: true, secondColumnLines: 1 }), 1, 'never one line alone in the second column')
assert.equal(pure.bottomNotesColumns({ oneFits: false, twoFits: true, secondColumnLines: 2 }), 2)
assert.equal(pure.bottomNotesColumns({ oneFits: false, twoFits: false, secondColumnLines: 4 }), 1, 'too long for two columns → one scrolling column')

// ── 2. The presenter window, rendered ───────────────────────────────────────────────────────
// Stand-in notes: the drawings' short (~40 words) and long (~150 words) notes, a five-paragraph
// note (lengthened in presenter redesign ticket 02 so it still overflows two columns under the
// slimmer ADR-0031 top bar at 1728x1117), a two-line note (the case that used to split into a lone second column) and a note whose
// first paragraph is four words (so automatic scroll leaves it within a second at 220 wpm).
const SHORT_NOTE = `Stand-in note. Start with the expenses form. A chat explains how to fill it in, and most people stop there. An agent goes and finds the form, reads last year's claim and fills in what it can. Point at line two.`
const LONG_NOTE = [
  `Stand-in note. Three stages, and the room will know the first two. AI as oracle is where most people still are: you ask, it answers, translates or summarises. That is useful, and it is also the ceiling most people assume.`,
  `AI as tool maker came next. You ask for code, a chart or a small app, and it writes the thing, but you still run it yourself and carry the result back. Most people here have tried this at least once, even if they did not call it that.`,
  `The third stage is the one this talk is about. AI as tool user works with your files and your software to finish a task. Give the expenses example again here, briefly. Then pause and ask who in the room has let a model touch their files. Expect few hands, and say that this is normal. Keep this slide under a minute.`,
].join('\n\n')
const FIVE_NOTE = [
  `First paragraph. Open with the question from the survey: how many of you have used a chatbot for work this week? Wait for the hands and count them out loud, then write the number on the flip chart so the room can see it.`,
  `Second paragraph. Most of the room will have tried one. Say that the interesting question is not whether they use it but what they hand over to it, and what they keep for themselves because it matters too much to delegate.`,
  `Third paragraph. Tell the story of the committee paper that was summarised in thirty seconds and then checked for an hour, because nobody trusted the summary and nobody could say where it came from.`,
  `Fourth paragraph. The checking is the work. Say it plainly: the tool saved the reading, not the judgement, and the judgement is what the committee pays for, whether or not anyone writes that down.`,
  `Fifth paragraph, the last one. End on the three questions to ask before handing a task over, and click to the next slide while the last question is still on screen, so that the room leaves with it in mind.`,
].join('\n\n')
const TWO_LINE_NOTE = `Remind them of the break at eleven, and that the coffee is in the room across the hall.`
const QUICK_NOTE = [
  `Four words to start.`,
  `Then the second paragraph carries the real content of this slide, long enough to need a few seconds of reading at any speed the presenter chooses.`,
  `And a third paragraph closes the note so the camera column has something still to come.`,
].join('\n\n')
const deckSource = (title) => `---
title: ${title}
auto_title_slide: false
auto_thanks_slide: false
---

### What makes an agent useful? {id=short}

- A chat can tell me how to fill in an expenses form.
- An agent can find the form and fill it in.

:::notes
${SHORT_NOTE}
:::

### The evolution of agents {id=long}

- AI as oracle
- AI as tool maker
- AI as tool user

:::notes
${LONG_NOTE}
:::

### Not all agents are agents {id=none}

A slide with no notes.

### Five paragraphs {id=five}

A slide with a long note.

:::notes
${FIVE_NOTE}
:::

### Housekeeping {id=twoline}

Coffee.

:::notes
${TWO_LINE_NOTE}
:::

### A quick start {id=quick}

Auto scroll.

:::notes
${QUICK_NOTE}
:::

### Wrap-up {id=wrap}

The end.
`
const POLL = {
  type: 'poll.state', pollId: 'quick-tp-test', pollType: 'single', question: 'Have you let an AI agent work on your files this month?',
  options: [{ optionId: 'a', label: 'Yes' }, { optionId: 'b', label: 'No' }, { optionId: 'c', label: 'Not sure' }],
  visibility: 'live', open: true, revealed: false, tallies: { a: 9, b: 21, c: 6 },
}
const REPORT = JSON.parse(readFileSync(new URL('./fixtures/teleprompter-drawn-measurements.json', import.meta.url), 'utf8'))
const drawn = (variant, state, size) => REPORT.find((r) => r.variant === variant && r.state === state && r.size === size)
// The ADR-0028 drawings had the old, taller top and bottom bars. The ADR-0031 status bar
// (presenter redesign ticket 02, +0.06) and bottom bar (ticket 05: a 40px row where the old
// control bar took about 57px, +0.03) give height back, so the previews may grow into it — never
// shrink below the drawing (−0.02), and by no more than that room (+0.09).
const nearDrawn = (value, drawnValue) => value >= drawnValue - 0.02 && value <= drawnValue + 0.09
const VARIANT = { 'top-band': 'a', 'camera-column': 'c' }
const SIZES = [[1440, 900], [1728, 1117]]
const SHOTS = process.env.SHOTS ? resolve(process.env.SHOTS) : null

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-teleprompter-'))
let browser
const errors = []
const table = []
try {
  const compile = async (name, title) => {
    const dir = join(scratch, name)
    await mkdir(dir)
    const sourcePath = join(dir, `${name}.md`)
    const source = deckSource(title)
    await writeFile(sourcePath, source)
    const model = await prepareSource(sourcePath, source, name, statSync(sourcePath))
    const htmlPath = join(dir, `${name}-present.html`)
    await writeFile(htmlPath, model.fullHtml)
    return pathToFileURL(htmlPath).href
  }
  // Two talks in two folders, as the app writes them (<talk dir>/<slug>-present.html).
  const talkX = await compile('talk-x', 'Talk X')
  const talkY = await compile('talk-y', 'Talk Y')
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  // Stub of the preload poll bridge (present-live-bridge.ts) so a Quick poll can be shown open.
  await context.addInitScript(() => {
    window.__tp = {}
    window.twLivePollBridge = { onState: (cb) => { window.__tp.state = cb }, onStatus: (cb) => { window.__tp.status = cb }, onJoin: () => {}, onOperation: () => {}, action: () => Promise.resolve({ ok: true }) }
  })

  // The Notes menu opens from the View menu (presenter redesign ticket 04).
  const openNotesMenu = async (page) => {
    if (await page.isVisible('#notesMenu')) return
    await page.click('#presenterMenuView')
    await page.click('#notesPlacementBtn')
  }
  const settle = async (page, ms = 150) => {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    await page.waitForTimeout(ms)
  }
  const open = async (url, W, H, slide) => {
    const page = await context.newPage()
    await page.setViewportSize({ width: W, height: H })
    page.on('pageerror', (error) => errors.push(`${W}x${H} ${url.split('/').pop()}: ${error.message}`))
    await page.goto(`${url}?presenter=1#${slide}`, { waitUntil: 'load' })
    await page.waitForFunction(() => /scale\(([\d.]+)\)/.test(document.querySelector('#currentPreview iframe')?.style.transform || ''), null, { timeout: 15000 })
    await settle(page, 300)
    // A reopened talk offers to resume where it left off; stay on the slide asked for.
    if (await page.isVisible('#twResume')) { await page.click('#twResumeNo'); await settle(page) }
    return page
  }
  const go = async (page, slide) => {
    await page.evaluate((id) => { location.hash = id }, slide)
    await page.waitForFunction((id) => decodeURIComponent(location.hash.slice(1)) === id && document.getElementById('presenterNotesBody').dataset.nextTitle !== undefined, slide)
    await settle(page, 250)
  }
  // Pick a placement the way a person does: open the Notes menu, press the option, close it.
  const choose = async (page, placement) => {
    await openNotesMenu(page)
    await page.click(`[data-notes-placement-option="${placement}"]`)
    await page.keyboard.press('Escape')
    await settle(page, 250)
  }
  // The "more J ▾" cue (0.34.0-preview.3 check: "more looks like a button but clicking does not do
  // anything"). What it is and where it is drawn; a cue drawn without an element (the old ::after)
  // reports the panel corner it sits in, so the click below lands where a person clicks.
  const moreCue = (page) => page.evaluate(() => {
    const panel = document.getElementById('presenterNotes')
    const el = panel.querySelector('.presenter-notes-more')
    if (el) {
      const r = el.getBoundingClientRect()
      return { tag: el.tagName, role: el.getAttribute('role'), label: el.getAttribute('aria-label') || el.title || '', tabIndex: el.tabIndex, disabled: Boolean(el.disabled), shown: getComputedStyle(el).display !== 'none' && r.width > 0, x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
    const after = getComputedStyle(panel, '::after')
    const p = panel.getBoundingClientRect()
    return { tag: null, role: null, label: '', tabIndex: -1, disabled: false, shown: after.content !== 'none', x: p.right - parseFloat(after.right || '12') - 20, y: p.bottom - parseFloat(after.bottom || '10') - 8 }
  })
  const focusedIsMore = (page) => page.evaluate(() => Boolean(document.activeElement?.closest?.('.presenter-notes-more')))
  // Click the cue with the mouse; it must step the notes as J does and leave the pause state alone.
  const clickMore = async (page, what, step) => {
    const c = await moreCue(page)
    assert.ok(c.shown, `${what}: the "more" cue is shown`)
    const a = await measure(page)
    await page.mouse.click(c.x, c.y)
    await settle(page)
    const b = await measure(page)
    const moved = b.body.scrollTop - a.body.scrollTop
    if (step != null) assert.ok(moved >= step - 2 && moved <= step + 24, `${what}: clicking "more" steps the notes as J does (${moved}px, a J step is ${step}px)`)
    else assert.ok(moved > 2, `${what}: clicking "more" scrolls the notes (${moved}px)`)
    assert.equal(b.auto, a.auto, `${what}: clicking "more" does not pause or resume the automatic scroll`)
    assert.equal(b.count, a.count, `${what}: clicking "more" does not change the slide`)
    assert.ok(c.tag === 'BUTTON' || c.role === 'button', `${what}: the "more" cue is a button`)
    assert.ok(c.tabIndex >= 0 && !c.disabled, `${what}: the "more" cue can take keyboard focus`)
    assert.match(c.label, /more notes \(J\)/i, `${what}: the "more" cue is labelled "More notes (J)"`)
    assert.ok(!(await focusedIsMore(page)), `${what}: a mouse click on "more" does not keep focus, so Space still changes the slide`)
    return moved
  }
  const measure = (page) => page.evaluate(() => {
    const scaleOf = (id) => { const m = /scale\(([\d.]+)\)/.exec(document.querySelector(`#${id} iframe`)?.style.transform || ''); return m ? Math.round(parseFloat(m[1]) * 1000) / 1000 : null }
    const shown = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0
    const body = document.getElementById('presenterNotesBody')
    const cs = getComputedStyle(body)
    const br = body.getBoundingClientRect()
    const current = document.getElementById('currentPreview').closest('.presenter-panel')
    const blocks = [...body.querySelectorAll('aside.notes > *')]
    return {
      placement: document.getElementById('presenterRoot').dataset.notesPlacement,
      label: document.getElementById('notesPlacementNow').textContent,
      scale: scaleOf('currentPreview'),
      nextScale: shown(document.getElementById('nextPreview')) ? scaleOf('nextPreview') : null,
      fontPx: Math.round(parseFloat(cs.fontSize) * 10) / 10,
      lineHeight: parseFloat(cs.lineHeight),
      body: { top: br.top, bottom: br.bottom, left: br.left, right: br.right, clientHeight: body.clientHeight, scrollTop: body.scrollTop, scrollHeight: body.scrollHeight },
      textCentreOffset: Math.round((br.left + br.right) / 2 - innerWidth / 2),
      empty: body.childNodes.length === 0,
      emptyText: getComputedStyle(body, '::before').content,
      nextTitle: body.dataset.nextTitle,
      cols: body.dataset.notesCols || null,
      more: document.getElementById('presenterNotes').dataset.notesMore === '1',
      auto: document.getElementById('presenterNotes').dataset.notesAuto || null,
      currentIndex: blocks.findIndex((b) => b.classList.contains('tp-current')),
      pastCount: blocks.filter((b) => b.classList.contains('tp-past')).length,
      blockTops: blocks.map((b) => b.getBoundingClientRect().top),
      lastBlockBottom: blocks.length ? blocks[blocks.length - 1].getBoundingClientRect().bottom : null,
      notesShown: shown(document.getElementById('presenterNotes')),
      thenShown: shown(document.getElementById('presenterFollowing')),
      pollShown: shown(document.getElementById('presenterPollPanel')),
      count: document.getElementById('presenterCount').textContent,
      viewport: { w: innerWidth, h: innerHeight },
      controlsBottom: document.querySelector('.presenter-controls').getBoundingClientRect().bottom,
      currentPanelKeeps: ['presenterInstantStrip', 'liveGoPanel', 'presenterInstantCompose', 'presenterInstantPaste', 'presenterQuickPollCompose', 'presenterPollPanel'].every((id) => current.contains(document.getElementById(id))),
      headerButtons: ['presenterMenuLive', 'presenterMenuPoll', 'presenterMenuView'].every((id) => shown(document.getElementById(id))),
      controlButtons: ['presenterPrev', 'presenterNext', 'presenterFocus', 'presenterHighlight'].every((id) => shown(document.getElementById(id))),
    }
  })
  const chromeUsable = (r, what) => {
    assert.ok(r.headerButtons, `${what}: every header button is shown`)
    assert.ok(r.controlButtons, `${what}: the controls bar buttons are shown`)
    assert.ok(r.currentPanelKeeps, `${what}: the go-live panel, poll panel and composers stay in the current-slide panel`)
    assert.ok(r.controlsBottom <= r.viewport.h + 0.5, `${what}: the controls bar is inside the window`)
  }
  // Each open is a fresh Quick poll in a live session; closing ends the session (the panel's ×
  // only hides a poll until the next slide, and a dismissed Quick poll stays the active one).
  const openPoll = async (page) => {
    await page.evaluate((poll) => { window.__tp.status?.('live'); window.__tp.state(poll) }, POLL)
    await settle(page, 400)
  }
  const closePoll = async (page) => {
    await page.evaluate(() => window.__tp.status?.('ended'))
    await settle(page, 300)
    assert.equal((await measure(page)).pollShown, false, 'the poll panel closes with the session')
  }
  // Words laid out in the right half of the bottom notes (the second column).
  const secondColumn = (page) => page.evaluate(() => {
    const body = document.getElementById('presenterNotesBody')
    // The middle of the notes panel's content box (the body itself narrows to one column).
    const panel = document.getElementById('presenterNotes')
    const pr = panel.getBoundingClientRect()
    const pcs = getComputedStyle(panel)
    const left = pr.left + parseFloat(pcs.paddingLeft) + parseFloat(pcs.borderLeftWidth)
    const right = pr.right - parseFloat(pcs.paddingRight) - parseFloat(pcs.borderRightWidth)
    const mid = (left + right) / 2
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    const words = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const m of node.textContent.matchAll(/\S+/g)) {
        const range = document.createRange()
        range.setStart(node, m.index)
        range.setEnd(node, m.index + m[0].length)
        const r = range.getBoundingClientRect()
        if (r.width > 0 && r.left >= mid) words.push({ word: m[0], top: Math.round(r.top) })
      }
    }
    return { words: words.length, lines: new Set(words.map((w) => w.top)).size, sample: words.slice(0, 3).map((w) => w.word).join(' ') }
  })
  const shoot = async (page, name) => { if (SHOTS) { await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, name) }) } }

  for (const [W, H] of SIZES) {
    const size = `${W}x${H}`
    const page = await open(talkX, W, H, 'long')
    await page.evaluate(() => localStorage.clear())
    await page.reload({ waitUntil: 'load' })
    await settle(page, 400)

    // ── Top band and camera column against the drawings: short, long, none, poll.
    for (const placement of ['top-band', 'camera-column']) {
      await go(page, 'long')
      await choose(page, placement)
      for (const [state, slide] of [['long', 'long'], ['short', 'short'], ['none', 'none']]) {
        await go(page, slide)
        const r = await measure(page)
        const d = drawn(VARIANT[placement], state, size)
        const what = `${size} ${placement} ${state}`
        assert.equal(r.placement, placement)
        assert.ok(nearDrawn(r.scale, d.scale), `${what}: current slide at ${r.scale}, drawn ${d.scale} (−0.02 / +0.09)`)
        assert.ok(nearDrawn(r.nextScale, d.nextScale), `${what}: Next at ${r.nextScale}, drawn ${d.nextScale} (−0.02 / +0.09)`)
        assert.ok(Math.abs(r.fontPx - d.notesFontPx) <= 0.5, `${what}: notes type ${r.fontPx}px, drawn ${d.notesFontPx}px`)
        assert.ok(r.notesShown && !r.thenShown, `${what}: notes shown, Then not`)
        chromeUsable(r, what)
        table.push({ size, placement, state, scale: r.scale, drawn: d.scale, nextScale: r.nextScale, fontPx: r.fontPx })
        if (state === 'none') {
          assert.ok(r.empty, `${what}: the notes body is empty`)
          if (placement === 'top-band') assert.equal(r.emptyText, '"No notes on this slide"', `${what}: the band says there are no notes`)
          else {
            assert.equal(r.nextTitle, 'Five paragraphs', `${what}: the empty column names the next slide`)
            assert.match(r.emptyText, /No notes on this slide/, `${what}: the column says there are no notes`)
          }
        }
        if (placement === 'camera-column' && state === 'long') {
          assert.equal(r.currentIndex, 0, `${what}: the first paragraph is the reading line`)
          assert.ok(Math.abs(r.textCentreOffset) <= 60, `${what}: the text sits near the window's centre line (${r.textCentreOffset}px)`)
        }
        if (placement === 'top-band' && state === 'long') assert.ok(r.more, `${what}: the band shows "more" for a long note`)
        if (placement === 'top-band' && state === 'short') assert.ok(!r.more, `${what}: no "more" cue when the note fits`)
        if (W === 1440 && state === 'long') await shoot(page, `${placement}-long-1440x900.png`)
      }
      await go(page, 'short')
      await openPoll(page)
      const r = await measure(page)
      const d = drawn(VARIANT[placement], 'poll', size)
      assert.ok(r.pollShown, `${size} ${placement}: the poll panel is open`)
      // A floor, not a band, since presenter redesign ticket 06: the poll panel's actions moved into
      // its head row, so the panel is shallower than when these placements were drawn and the slide
      // above it may take the height it gives back (top band: 0.43 against 0.23 drawn at 1440x900).
      assert.ok(r.scale >= d.scale - 0.02, `${size} ${placement} poll: current slide at ${r.scale}, at least the drawn ${d.scale} (−0.02)`)
      assert.ok(r.notesShown, `${size} ${placement} poll: the notes stay`)
      chromeUsable(r, `${size} ${placement} poll`)
      table.push({ size, placement, state: 'poll', scale: r.scale, drawn: d.scale })
      await closePoll(page)
    }

    // ── J / ⇧J. Top band: the visible lines less one. Arrows still change slides.
    await go(page, 'long')
    await choose(page, 'top-band')
    let a = await measure(page)
    assert.equal(a.body.scrollTop, 0)
    await page.keyboard.press('j')
    await settle(page)
    let b = await measure(page)
    const bandStep = pure.notesBandStep(a.body.clientHeight, a.lineHeight)
    assert.ok(bandStep > 0 && Math.abs(b.body.scrollTop - bandStep) <= 2, `${size} top band: J scrolls ${b.body.scrollTop}px, one band less a line is ${bandStep}px`)
    assert.equal(b.count, a.count, `${size} top band: J does not change the slide`)
    await page.keyboard.press('Shift+J')
    await settle(page)
    assert.equal((await measure(page)).body.scrollTop, 0, `${size} top band: ⇧J scrolls back`)
    // The "more" cue: a click steps as J does; Enter and Space on the focused cue do the same.
    await clickMore(page, `${size} top band`, bandStep)
    await page.keyboard.press('Shift+J')
    await settle(page)
    assert.equal((await measure(page)).body.scrollTop, 0, `${size} top band: ⇧J scrolls back after "more"`)
    for (const k of ['Enter', 'Space']) {
      await page.focus('#presenterNotesMore')
      await page.keyboard.press(k)
      await settle(page)
      b = await measure(page)
      assert.ok(Math.abs(b.body.scrollTop - bandStep) <= 2, `${size} top band: ${k} on the focused "more" cue steps the notes (${b.body.scrollTop}px)`)
      assert.equal(b.count, a.count, `${size} top band: ${k} on the focused "more" cue does not change the slide`)
      await page.keyboard.press('Shift+J')
      await settle(page)
    }
    await page.evaluate(() => document.activeElement?.blur())
    await page.keyboard.press('j')
    await page.keyboard.press('ArrowRight')
    await settle(page, 250)
    b = await measure(page)
    assert.notEqual(b.count, a.count, `${size}: → still changes the slide`)
    await page.keyboard.press('ArrowLeft')
    await settle(page, 250)
    assert.equal((await measure(page)).body.scrollTop, 0, `${size} top band: a slide change puts the notes back at the top`)
    if (W === 1440) { await page.keyboard.press('j'); await settle(page); await shoot(page, 'top-band-long-after-j-1440x900.png'); await page.keyboard.press('Shift+J') }

    // Camera column: a step is one paragraph, pinned to the top of the column, earlier ones faded.
    await choose(page, 'camera-column')
    a = await measure(page)
    assert.equal(a.currentIndex, 0)
    await page.keyboard.press('j')
    await settle(page)
    b = await measure(page)
    assert.equal(b.currentIndex, 1, `${size} camera column: J moves the reading line to the second paragraph`)
    assert.equal(b.pastCount, 1, `${size} camera column: the first paragraph is marked spoken`)
    assert.ok(Math.abs(b.blockTops[1] - b.body.top) <= 3, `${size} camera column: the second paragraph is pinned at the top of the column (${b.blockTops[1]} vs ${b.body.top})`)
    await page.keyboard.press('Shift+J')
    await settle(page)
    b = await measure(page)
    assert.ok(b.currentIndex === 0 && b.pastCount === 0 && b.body.scrollTop === 0, `${size} camera column: ⇧J moves back`)
    await page.keyboard.press('j')
    await go(page, 'short')
    await go(page, 'long')
    assert.equal((await measure(page)).currentIndex, 0, `${size} camera column: a slide change resets the reading line`)

    // ── Automatic scroll. Camera column: starts when a slide arrives; a four-word paragraph at
    // 220 words a minute dwells about 1.1s; J still steps; a click pauses and resumes.
    await openNotesMenu(page)
    await page.click('[data-notes-scroll-option="auto"]')
    for (let i = 0; i < 9; i++) await page.click('#notesWpmFaster')
    assert.equal(await page.textContent('#notesWpm'), '220', 'the speed steps up to 220')
    await page.click('#notesWpmFaster')
    assert.equal(await page.textContent('#notesWpm'), '220', 'the speed stops at 220')
    await page.keyboard.press('Escape')
    await go(page, 'quick')
    a = await measure(page)
    assert.equal(a.auto, 'running', `${size} camera column: automatic scroll runs on arrival`)
    assert.equal(a.currentIndex, 0)
    await page.waitForTimeout(1700)
    b = await measure(page)
    assert.equal(b.currentIndex, 1, `${size} camera column: automatic scroll moved to the second paragraph after its dwell`)
    await page.keyboard.press('j')
    await settle(page, 50)
    assert.equal((await measure(page)).currentIndex, 2, `${size} camera column: J steps while automatic scroll runs`)
    await go(page, 'long')
    await go(page, 'quick')
    await page.click('#presenterNotesBody')
    a = await measure(page)
    assert.equal(a.auto, 'paused', `${size}: a click on the notes pauses`)
    assert.equal(a.currentIndex, 0, `${size}: a slide arrival starts again from the first paragraph`)
    await page.waitForTimeout(1700)
    assert.equal((await measure(page)).currentIndex, 0, `${size}: paused, the reading line stays past the four-word dwell`)
    await page.click('#presenterNotesBody')
    assert.equal((await measure(page)).auto, 'running', `${size}: a second click resumes`)
    await page.waitForTimeout(1700)
    assert.equal((await measure(page)).currentIndex, 1, `${size}: resumed, the reading line moves on`)

    // Top band: the scroll moves at the set speed, and a speed change takes effect live.
    await choose(page, 'top-band')
    await go(page, 'long')
    a = await measure(page)
    assert.equal(a.auto, 'running')
    await page.waitForTimeout(1000)
    b = await measure(page)
    const fast = b.body.scrollTop - a.body.scrollTop
    assert.ok(fast > 2, `${size} top band: automatic scroll moves at 220 (${fast}px in 1s)`)
    await page.evaluate(() => { for (let i = 0; i < 16; i++) document.getElementById('notesWpmSlower').click() })
    assert.equal(await page.textContent('#notesWpm'), '60', 'the speed steps down to 60')
    a = await measure(page)
    await page.waitForTimeout(1000)
    b = await measure(page)
    const slow = b.body.scrollTop - a.body.scrollTop
    assert.ok(slow > 0 && fast / slow > 2, `${size} top band: slowing to 60 takes effect at once (${fast}px/s at 220 → ${slow}px/s at 60)`)
    await clickMore(page, `${size} top band, automatic scroll running`, bandStep)
    assert.equal((await measure(page)).auto, 'running', `${size} top band: automatic scroll still runs after "more"`)
    await page.click('#presenterNotesBody')
    a = await measure(page)
    await page.waitForTimeout(600)
    assert.equal((await measure(page)).body.scrollTop, a.body.scrollTop, `${size} top band: paused, the band stays`)
    await clickMore(page, `${size} top band, automatic scroll paused`, bandStep)
    assert.equal((await measure(page)).auto, 'paused', `${size} top band: automatic scroll stays paused after "more"`)
    await page.click('#presenterNotesBody')
    // Back to hand scrolling for the rest.
    await openNotesMenu(page)
    await page.click('[data-notes-scroll-option="hand"]')
    assert.equal(await page.isVisible('#notesMenuScroll'), true, 'the menu shows Scroll and Speed for a teleprompter placement')
    await page.click('[data-notes-placement-option="bottom"]')
    assert.equal(await page.isVisible('#notesMenuScroll'), false, 'the menu hides Scroll and Speed for bottom')
    await page.keyboard.press('Escape')
    assert.equal(await page.isVisible('#notesMenu'), false, 'Esc closes the Notes menu')
    await settle(page, 250)

    // ── Bottom: an open poll hides the notes and the slide keeps its no-poll size.
    await go(page, 'short')
    const noPoll = await measure(page)
    assert.equal(noPoll.placement, 'bottom')
    assert.ok(noPoll.notesShown)
    await openPoll(page)
    let withPoll = await measure(page)
    assert.ok(withPoll.pollShown, `${size} bottom: the poll panel is open`)
    assert.ok(!withPoll.notesShown, `${size} bottom: the notes hide while the poll is open`)
    assert.ok(Math.abs(withPoll.scale - noPoll.scale) <= 0.003, `${size} bottom: the slide keeps its no-poll size (${noPoll.scale} → ${withPoll.scale})`)
    chromeUsable(withPoll, `${size} bottom poll`)
    const pollFits = await page.evaluate(() => {
      const panel = document.querySelector('.presenter-current-panel').getBoundingClientRect()
      const poll = document.getElementById('presenterPollPanel').getBoundingClientRect()
      const slide = document.getElementById('currentPreview').getBoundingClientRect()
      return { under: poll.top >= slide.bottom - 0.5, inside: poll.bottom <= panel.bottom + 0.5, height: poll.height }
    })
    assert.ok(pollFits.under && pollFits.inside && pollFits.height > 40, `${size} bottom poll: the poll panel sits under the slide inside its panel (${JSON.stringify(pollFits)})`)
    if (W === 1440) await shoot(page, 'bottom-poll-1440x900.png')
    await closePoll(page)
    withPoll = await measure(page)
    assert.ok(withPoll.notesShown && !withPoll.pollShown, `${size} bottom: the notes come back when the poll closes`)
    // Sidebar and teleprompter placements keep their notes during a poll.
    for (const placement of ['sidebar', 'top-band', 'camera-column']) {
      await choose(page, placement)
      await openPoll(page)
      const r = await measure(page)
      assert.ok(r.pollShown && r.notesShown, `${size} ${placement}: the notes stay during a poll`)
      await closePoll(page)
    }
    await choose(page, 'bottom')

    // ── Bottom: no stand-in note leaves a lone word or line in the second column.
    for (const slide of ['short', 'long', 'five', 'twoline', 'quick']) {
      await go(page, slide)
      const col2 = await secondColumn(page)
      const r = await measure(page)
      assert.ok(col2.words === 0 || (col2.words > 1 && col2.lines > 1), `${size} bottom "${slide}": the second column holds ${col2.words} word(s) on ${col2.lines} line(s) ("${col2.sample}") (layout ${r.cols})`)
      table.push({ size, placement: 'bottom', state: slide, cols: r.cols, secondColumnWords: col2.words, secondColumnLines: col2.lines })
    }
    // ── Bottom: a five-paragraph note is fully reachable (J), with the "more" cue until the end.
    await go(page, 'five')
    a = await measure(page)
    assert.ok(a.more, `${size} bottom: a long note shows the "more" cue`)
    assert.equal(a.cols, '1', `${size} bottom: a note too long for two columns stays in one scrolling column`)
    if (W === 1440) await shoot(page, 'bottom-five-paragraphs-1440x900.png')
    await clickMore(page, `${size} bottom`, pure.notesBandStep(a.body.clientHeight, a.lineHeight))
    await page.keyboard.press('Shift+J')
    await settle(page)
    let presses = 0
    for (; presses < 40 && (await measure(page)).more; presses++) { await page.keyboard.press('j'); await settle(page, 30) }
    b = await measure(page)
    assert.ok(!b.more, `${size} bottom: J reaches the end of the note (${presses} presses)`)
    assert.ok(b.lastBlockBottom <= b.body.bottom + 1, `${size} bottom: the last paragraph is fully visible (${b.lastBlockBottom} vs ${b.body.bottom})`)
    assert.ok(b.body.scrollTop > 0)

    // The sidebar scrolls a long note with J too.
    await choose(page, 'sidebar')
    await go(page, 'five')
    a = await measure(page)
    await page.keyboard.press('j')
    await settle(page)
    b = await measure(page)
    assert.ok(a.more && b.body.scrollTop > 0, `${size} sidebar: J scrolls a long note`)
    await page.keyboard.press('Shift+J')
    await settle(page)
    await clickMore(page, `${size} sidebar`, Math.min(pure.notesBandStep(b.body.clientHeight, b.lineHeight), b.body.scrollHeight - b.body.clientHeight))

    // ── The command palette: a placement each, faster and slower.
    await page.keyboard.press('Meta+Shift+P')
    await page.fill('#presenterCommandSearch', 'notes placement')
    assert.equal((await page.$$('#presenterCommandResults button')).length, 5, 'the palette lists five placements')
    await page.click('#palette-notes-top-band')
    await settle(page, 250)
    assert.equal((await measure(page)).placement, 'top-band', 'the palette entry sets the placement')
    await page.keyboard.press('Meta+Shift+P')
    await page.fill('#presenterCommandSearch', 'notes scroll')
    assert.equal((await page.$$('#presenterCommandResults button')).length, 4, 'the palette offers by hand, automatically, faster and slower')
    await page.click('#palette-notes-faster')
    assert.equal(await page.textContent('#notesWpm'), '70', 'faster steps the speed by 10')

    // Screenshot of the open Notes menu (1440x900, camera column so Scroll and Speed show).
    if (W === 1440) {
      await choose(page, 'camera-column')
      await go(page, 'long')
      await openNotesMenu(page)
      await settle(page)
      await shoot(page, 'notes-menu-open-1440x900.png')
      await page.keyboard.press('Escape')
    }
    await page.close()
  }

  // ── One setting for all talks, with a per-talk override. Two talks, both presenters open.
  {
    const x = await open(talkX, 1440, 900, 'long')
    await x.evaluate(() => localStorage.clear())
    await x.reload({ waitUntil: 'load' })
    await settle(x, 300)
    const y = await open(talkY, 1440, 900, 'long')
    const ids = await Promise.all([x, y].map((p) => p.evaluate(() => document.body.dataset.deckId || location.pathname)))
    assert.notEqual(ids[0], ids[1], 'the two talks have different deck ids')
    await choose(x, 'top-band')
    await settle(y, 250)
    assert.equal((await measure(y)).placement, 'top-band', 'a change in talk X reaches talk Y at once')
    const stored = await x.evaluate(() => JSON.parse(localStorage.getItem('talkweaver:presenter:notes')))
    assert.deepEqual(stored, { placement: 'top-band', scroll: 'hand', wpm: 130 }, 'the all-talks value is stored as JSON')
    // Y: "Just this talk", then camera column.
    await openNotesMenu(y)
    await y.check('#notesJustThisTalk')
    await y.click('[data-notes-placement-option="camera-column"]')
    await y.keyboard.press('Escape')
    await settle(x, 250)
    assert.equal((await measure(x)).placement, 'top-band', 'talk X keeps the all-talks value when Y overrides')
    assert.equal((await measure(y)).placement, 'camera-column')
    assert.ok(await y.evaluate((id) => localStorage.getItem(`html-presentations:${id}:notes-override`) !== null, ids[1]), 'the override is stored for Y')
    // X changes the all-talks value; Y keeps its override, also after reopening.
    await choose(x, 'sidebar')
    await settle(y, 250)
    assert.equal((await measure(y)).placement, 'camera-column', 'talk Y with "Just this talk" ignores the all-talks change')
    await y.close()
    const y2 = await open(talkY, 1440, 900, 'long')
    assert.equal((await measure(y2)).placement, 'camera-column', 'the override survives reopening talk Y')
    await openNotesMenu(y2)
    assert.equal(await y2.isChecked('#notesJustThisTalk'), true, 'the menu shows "Just this talk" on')
    await y2.uncheck('#notesJustThisTalk')
    await y2.keyboard.press('Escape')
    await settle(y2, 250)
    assert.equal((await measure(y2)).placement, 'sidebar', 'turning "Just this talk" off returns Y to the all-talks value')
    assert.ok(await y2.evaluate((id) => localStorage.getItem(`html-presentations:${id}:notes-override`) === null, ids[1]), 'the override is gone')
    assert.equal((await x.evaluate(() => JSON.parse(localStorage.getItem('talkweaver:presenter:notes')))).placement, 'sidebar', 'turning the override off never copies it over the all-talks value')
    // A new talk opened later reads the all-talks value; the old per-deck key is ignored.
    await x.evaluate((id) => { localStorage.removeItem('talkweaver:presenter:notes'); localStorage.setItem(`html-presentations:${id}:notes-placement`, 'off') }, ids[0])
    await x.reload({ waitUntil: 'load' })
    await settle(x, 300)
    assert.equal((await measure(x)).placement, 'bottom', 'the old per-deck notes-placement key is ignored')
    await x.evaluate(() => localStorage.clear())
    await x.close()
    await y2.close()
  }
  assert.deepEqual(errors, [], 'no page errors')
} finally {
  await browser?.close()
  await rm(scratch, { recursive: true, force: true })
}
if (process.env.REPORT) for (const row of table) console.log(JSON.stringify(row))
const scaled = table.filter((r) => r.drawn != null)
console.log(`presenter teleprompter: pure block + ${scaled.length} layouts within −0.02 / +0.09 of the drawings (${scaled.map((r) => `${r.size} ${r.placement} ${r.state} ${r.scale}/${r.drawn}`).join(', ')}); J, automatic scroll, all-talks setting with override, bottom poll and long notes OK`)
