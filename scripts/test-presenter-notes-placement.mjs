// Presenter notes placement (ADR-0028 §8, slide-design ticket 04). Two seams:
//  1. the pure NOTES_PLACEMENT block of the presenter template (placements, which panels show,
//     the remembered setting), extracted and run here;
//  2. the compiled presenter window in headless Chromium at 1440x900 and 1728x1117, measuring the
//     current slide's scale in each placement, the setting surviving a reload, the Preview size
//     cycle still working, and the header, controls bar and current-slide panel still present.
// Ticket 07 (teleprompter placements, the all-talks setting, J, automatic scroll, bottom notes
// during a poll) is covered by test-presenter-teleprompter.mjs.
// Usage: node scripts/test-presenter-notes-placement.mjs   (REPORT=1 prints the measured table)
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

// ── 1. The pure block ────────────────────────────────────────────────────────────────────────
const template = readFileSync(new URL('../compiler/assets/templates/presenter-popup-single-html.html', import.meta.url), 'utf8')
const START = '// === NOTES_PLACEMENT_START'
const END = '// === NOTES_PLACEMENT_END'
assert(template.includes(START) && template.includes(END), 'the template carries the NOTES_PLACEMENT block')
const block = template.slice(template.indexOf(START), template.indexOf(END))
const pure = new Function(`${block}\nreturn { NOTES_PLACEMENTS, DEFAULT_NOTES_PLACEMENT, normaliseNotesPlacement, notesPlacementPanels, readNotesPlacement, writeNotesSettings }`)()

assert.deepEqual(pure.NOTES_PLACEMENTS, ['off', 'bottom', 'sidebar', 'top-band', 'camera-column'])
assert.equal(pure.DEFAULT_NOTES_PLACEMENT, 'bottom', 'notes under the slide is the default')
for (const bad of [null, undefined, '', 'teleprompter', 'Bottom', 42]) assert.equal(pure.normaliseNotesPlacement(bad), 'bottom', `${String(bad)} falls back to the default`)
assert.deepEqual(pure.notesPlacementPanels('bottom', true), { notes: true, then: true }, 'bottom: Then stays beside the notes')
assert.deepEqual(pure.notesPlacementPanels('bottom', false), { notes: true, then: true }, 'bottom: the notes panel stays so the slide keeps its size')
assert.deepEqual(pure.notesPlacementPanels('sidebar', true), { notes: true, then: false }, 'sidebar: notes replace Then')
assert.deepEqual(pure.notesPlacementPanels('sidebar', false), { notes: false, then: true })
assert.deepEqual(pure.notesPlacementPanels('off', true), { notes: false, then: true }, 'off: no notes')
const store = new Map()
const fakeStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
assert.equal(pure.readNotesPlacement(fakeStorage, 'k'), 'bottom', 'nothing stored → default')
pure.writeNotesSettings(fakeStorage, 'k', { placement: 'sidebar' }, false)
assert.equal(pure.readNotesPlacement(fakeStorage, 'k'), 'sidebar', 'a stored placement is read back')
pure.writeNotesSettings(fakeStorage, 'k', { placement: 'nonsense' }, false)
assert.equal(pure.readNotesPlacement(fakeStorage, 'k'), 'bottom', 'only a known placement is ever written')
const throwing = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } }
assert.equal(pure.readNotesPlacement(throwing, 'k'), 'bottom', 'blocked storage reads as the default')
assert.doesNotThrow(() => pure.writeNotesSettings(throwing, 'k', { placement: 'off' }, false), 'blocked storage never throws')
assert.equal(pure.readNotesPlacement(null, 'k'), 'bottom', 'no storage reads as the default')

// ── 2. The presenter window, rendered ───────────────────────────────────────────────────────
const source = `---
title: Notes placement
auto_title_slide: false
auto_thanks_slide: false
---

### What makes an agent useful? {id=useful}

- A chat can tell me how to fill in an expenses form.
- An agent can find the form and fill it in.

:::notes
Start with the expenses form: a chat explains how to fill it in, and that is where most people stop.

Then the difference. An agent goes and finds the form, reads last year's claim, and fills in the fields it can. Point at the second line on the slide.

Ask the room: who has filled in an expenses form this month? Keep the answer short and move on.
:::

### Not all agents are agents {id=not-all}

A slide with no notes.

### Example from a recent trip {id=trip}

Another slide.

### Wrap-up {id=wrap}

The end.
`

// Thresholds from the ticket: the drawn variants measured 74% / 94% (bottom) and 86% / 105%
// (sidebar); "off" must beat both.
const SIZES = [
  { W: 1440, H: 900, bottom: 0.72, sidebar: 0.84 },
  { W: 1728, H: 1117, bottom: 0.92, sidebar: 1.03 },
]
const PLACEMENTS = ['bottom', 'sidebar', 'off']

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-notes-placement-'))
let browser
const errors = []
const table = []
try {
  const sourcePath = join(scratch, 'notes-placement.md')
  await writeFile(sourcePath, source)
  const model = await prepareSource(sourcePath, source, 'notes-placement', statSync(sourcePath))
  const htmlPath = join(scratch, 'notes-placement.html')
  await writeFile(htmlPath, model.fullHtml)
  const url = `${pathToFileURL(htmlPath).href}?presenter=1#useful`
  // Browser launch failures must fail this test; generated markup is not equivalent evidence.
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()

  const fitted = (page) => page.waitForFunction(() => {
    const t = document.querySelector('#currentPreview iframe')?.style.transform || ''
    const m = /scale\(([\d.]+)\)/.exec(t)
    return m && parseFloat(m[1]) > 0.01
  }, null, { timeout: 15000 })
  // The Notes menu opens from the View menu (presenter redesign ticket 04).
  const openNotesMenu = async (page) => {
    if (await page.isVisible('#notesMenu')) return
    await page.click('#presenterMenuView')
    await page.click('#notesPlacementBtn')
  }
  const settle = async (page) => {
    // Two frames for the ResizeObserver refit after a layout change.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    await page.waitForTimeout(150)
  }
  const measure = (page) => page.evaluate(() => {
    const scaleOf = (id) => {
      const m = /scale\(([\d.]+)\)/.exec(document.querySelector(`#${id} iframe`)?.style.transform || '')
      return m ? Math.round(parseFloat(m[1]) * 1000) / 1000 : null
    }
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right } }
    const shown = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0
    const current = document.getElementById('currentPreview').closest('.presenter-panel')
    return {
      placement: document.getElementById('presenterRoot').dataset.notesPlacement,
      previewSize: document.getElementById('presenterRoot').dataset.previewSize || 'medium',
      label: document.getElementById('notesPlacementNow').textContent,
      scale: scaleOf('currentPreview'),
      nextScale: scaleOf('nextPreview'),
      notesShown: shown(document.getElementById('presenterNotes')),
      notesText: document.getElementById('presenterNotesBody').textContent.trim().length,
      notes: rect(document.getElementById('presenterNotes')),
      thenShown: shown(document.getElementById('presenterFollowing')),
      nextShown: shown(document.getElementById('nextPreview')),
      header: rect(document.querySelector('.presenter-root > header')),
      controls: rect(document.querySelector('.presenter-controls')),
      viewport: { w: innerWidth, h: innerHeight },
      currentPanelKeeps: ['presenterInstantStrip', 'liveGoPanel', 'presenterInstantCompose', 'presenterInstantPaste', 'presenterQuickPollCompose', 'presenterPollPanel']
        .every((id) => current.contains(document.getElementById(id))),
      headerButtons: ['presenterMenuLive', 'presenterMenuPoll', 'presenterMenuView']
        .every((id) => shown(document.getElementById(id))),
      controlButtons: ['presenterPrev', 'presenterNext', 'presenterFocus', 'presenterHighlight'].every((id) => shown(document.getElementById(id))),
    }
  })
  const chromeUsable = (r, what) => {
    assert.ok(r.headerButtons, `${what}: every header button is shown`)
    assert.ok(r.controlButtons, `${what}: the controls bar buttons are shown`)
    assert.ok(r.currentPanelKeeps, `${what}: the instant strip, go-live panel, poll panel and composers stay in the current-slide panel`)
    assert.ok(r.header.y >= 0 && r.header.h < 90, `${what}: the header sits on one line at the top (height ${r.header.h})`)
    assert.ok(r.controls.bottom <= r.viewport.h + 0.5, `${what}: the controls bar is inside the window (bottom ${r.controls.bottom} of ${r.viewport.h})`)
  }

  for (const { W, H, bottom, sidebar } of SIZES) {
    const page = await context.newPage()
    await page.setViewportSize({ width: W, height: H })
    page.on('pageerror', (error) => errors.push(`${W}x${H}: ${error.message}`))
    await page.goto(url, { waitUntil: 'load' })
    await fitted(page)
    await page.evaluate(() => localStorage.clear())
    await page.reload({ waitUntil: 'load' })
    await fitted(page)
    await settle(page)
    const results = {}
    for (const placement of PLACEMENTS) {
      if (placement !== 'bottom') {
        await openNotesMenu(page)
        await page.click(`[data-notes-placement-option="${placement}"]`)
        await page.keyboard.press('Escape')
        await settle(page)
      }
      const r = await measure(page)
      assert.equal(r.placement, placement, `${W}x${H}: the Notes menu sets ${placement}`)
      assert.equal(r.label, `Now: ${placement}, by hand`, `${W}x${H}: the View menu's Notes item names the placement`)
      chromeUsable(r, `${W}x${H} ${placement}`)
      const panels = pure.notesPlacementPanels(placement, true)
      assert.equal(r.notesShown, panels.notes, `${W}x${H} ${placement}: the stylesheet shows the notes as the pure block says`)
      assert.equal(r.thenShown, panels.then, `${W}x${H} ${placement}: the stylesheet shows Then as the pure block says`)
      results[placement] = r
      table.push({ size: `${W}x${H}`, placement, scale: r.scale, nextScale: r.nextScale, notesBox: r.notes && r.notesShown ? [Math.round(r.notes.w), Math.round(r.notes.h)] : null })
    }
    const { bottom: b, sidebar: s, off: o } = results
    assert.ok(b.scale >= bottom, `${W}x${H} bottom: current slide at ${b.scale}, needs ≥ ${bottom}`)
    assert.ok(s.scale >= sidebar, `${W}x${H} sidebar: current slide at ${s.scale}, needs ≥ ${sidebar}`)
    assert.ok(o.scale > b.scale && o.scale > s.scale, `${W}x${H} off: current slide at ${o.scale} beats bottom ${b.scale} and sidebar ${s.scale}`)
    assert.ok(b.notesShown && b.notesText > 0 && b.thenShown && b.nextShown, `${W}x${H} bottom: notes, Next and Then all show`)
    assert.ok(b.notes.w > W * 0.9, `${W}x${H} bottom: the notes run the full width (${b.notes.w})`)
    assert.ok(s.notesShown && s.notesText > 0 && !s.thenShown && s.nextShown, `${W}x${H} sidebar: notes replace Then beside the slide`)
    assert.ok(!o.notesShown && o.thenShown && o.nextShown, `${W}x${H} off: no notes; Next and Then show`)

    // A slide without notes: bottom keeps the notes panel (the slide does not change size).
    await page.evaluate(() => document.querySelector('[data-notes-placement-option="bottom"]').click())
    await settle(page)
    await page.keyboard.press('ArrowRight')
    await settle(page)
    const bare = await measure(page)
    assert.equal(bare.placement, 'bottom')
    assert.equal(bare.notesText, 0, 'the second slide has no notes')
    assert.ok(bare.notesShown && bare.thenShown, 'bottom: the empty notes panel and Then stay')
    assert.equal(bare.scale, b.scale, 'bottom: the current slide keeps its size on a slide without notes')
    await page.keyboard.press('ArrowLeft')
    await settle(page)

    // The instant strip and the poll panel open under the slide in every placement without
    // covering it or pushing the controls bar out of the window.
    for (const placement of PLACEMENTS) {
      for (const shown of [['presenterInstantStrip'], ['presenterPollPanel'], ['presenterInstantStrip', 'presenterPollPanel']]) {
        const r = await page.evaluate(async ([p, ids]) => {
          document.querySelector(`[data-notes-placement-option="${p}"]`).click()
          for (const id of ids) document.getElementById(id).hidden = false
          await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
          const q = (id) => document.getElementById(id).getBoundingClientRect()
          const panel = document.querySelector('.presenter-current-panel').getBoundingClientRect()
          const out = {
            preview: q('currentPreview'), panel,
            parts: ids.map((id) => ({ id, top: q(id).top, bottom: q(id).bottom })),
            notes: q('presenterNotes'), controls: document.querySelector('.presenter-controls').getBoundingClientRect(),
          }
          for (const id of ids) document.getElementById(id).hidden = true
          return JSON.parse(JSON.stringify(out))
        }, [placement, shown])
        const what = `${W}x${H} ${placement} with ${shown.join(' + ')}`
        for (const part of r.parts) {
          assert.ok(part.top >= r.preview.bottom - 0.5, `${what}: ${part.id} sits under the slide (${part.top} vs ${r.preview.bottom})`)
          assert.ok(part.bottom <= r.panel.bottom + 0.5, `${what}: ${part.id} is inside the current-slide panel`)
        }
        assert.ok(r.controls.bottom <= H + 0.5, `${what}: the controls bar stays in the window`)
        // Ticket 07: an open poll hides the bottom notes (test-presenter-teleprompter.mjs); the
        // instant strip alone keeps them in their row.
        if (placement === 'bottom' && !shown.includes('presenterPollPanel')) assert.ok(r.notes.height >= 100 && r.notes.top >= r.panel.bottom, `${what}: the notes keep their row (${r.notes.height}px)`)
        if (placement === 'bottom' && shown.includes('presenterPollPanel')) assert.equal(r.notes.height, 0, `${what}: the notes hide while the poll panel is open`)
      }
    }
    await settle(page)

    // The Preview size cycle still works in every placement and never hides the chrome.
    for (const placement of PLACEMENTS) {
      await page.evaluate((p) => document.querySelector(`[data-notes-placement-option="${p}"]`).click(), placement)
      await settle(page)
      const before = await measure(page)
      await page.keyboard.press('[') // medium → small
      await settle(page)
      const small = await measure(page)
      assert.equal(small.previewSize, 'small', `${W}x${H} ${placement}: [ steps the Preview size to small`)
      assert.ok(small.nextScale < before.nextScale, `${W}x${H} ${placement}: small shrinks Next (${before.nextScale} → ${small.nextScale})`)
      chromeUsable(small, `${W}x${H} ${placement} small`)
      await page.keyboard.press('[') // small → off
      await settle(page)
      const off = await measure(page)
      assert.equal(off.previewSize, 'off')
      assert.ok(!off.nextShown, `${W}x${H} ${placement}: Preview off hides Next`)
      if (placement === 'bottom') assert.ok(off.notesShown && off.notesText > 0, `${W}x${H} bottom: Preview off keeps the notes`)
      assert.ok(off.scale >= before.scale, `${W}x${H} ${placement}: Preview off does not shrink the current slide`)
      chromeUsable(off, `${W}x${H} ${placement} preview off`)
      await page.keyboard.press(']') // off → small
      await page.keyboard.press(']') // small → medium
      await settle(page)
      const back = await measure(page)
      assert.equal(back.previewSize, 'medium')
      assert.equal(back.scale, before.scale, `${W}x${H} ${placement}: back at medium the slide returns to its size`)
    }

    // The placement persists across presenter sessions: pick sidebar, close, open again.
    await page.evaluate(() => document.querySelector('[data-notes-placement-option="sidebar"]').click())
    await page.close()
    const again = await context.newPage()
    await again.setViewportSize({ width: W, height: H })
    again.on('pageerror', (error) => errors.push(`${W}x${H} reopen: ${error.message}`))
    await again.goto(url, { waitUntil: 'load' })
    await fitted(again)
    await settle(again)
    const reopened = await measure(again)
    assert.equal(reopened.placement, 'sidebar', `${W}x${H}: the placement survives a new presenter session`)
    assert.equal(reopened.label, 'Now: sidebar, by hand')
    assert.equal(reopened.scale, s.scale, `${W}x${H}: the reopened sidebar layout matches`)

    // The command palette offers the placements (no new chord).
    await again.keyboard.press('Meta+Shift+P')
    await again.fill('#presenterCommandSearch', 'notes placement')
    const offered = await again.$$eval('#presenterCommandResults button', (bs) => bs.map((b) => b.querySelector('.tw-pal-name')?.textContent || b.textContent))
    assert.equal(offered.length, 5, `the palette lists five placements (${offered.join(' | ')})`)
    await again.click('#palette-notes-off')
    await settle(again)
    assert.equal((await measure(again)).placement, 'off', 'the palette entry sets the placement')
    await again.evaluate(() => localStorage.clear())
    await again.close()
  }
  assert.deepEqual(errors, [], 'no page errors')
} finally {
  await browser?.close()
  await rm(scratch, { recursive: true, force: true })
}
if (process.env.REPORT) for (const row of table) console.log(JSON.stringify(row))
console.log(`presenter notes placement: pure block + ${table.length} rendered layouts OK (${table.map((r) => `${r.size} ${r.placement} ${Math.round(r.scale * 100)}%`).join(', ')})`)
