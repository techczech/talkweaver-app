// Onboarding 0.38.1 ticket 10: the Present chapter as its own column in the presenter (locked drawing
// state 07). The compiled presenter window in headless Chromium (Playwright's chrome-headless-shell),
// with the recording preload (and through it the edit bridge, the live bridge and the Guide) bundled
// against a stub of electron, injected as the app injects it. Seams:
//  1. the button: "Guide · Present N of M" in the bottom bar beside Outline, with no key and a small ×
//     that asks main to turn the switch off; not there while main sends no view (the Guide button off);
//  2. the column: the button and the palette's row each toggle it (C does nothing); opening adds one column and no
//     overlay (no element of the column overlaps the stage, Next, Then, Notes, the top bar or the
//     bottom bar), in the bottom, sidebar, off and camera-column placements at 1024, 1280 and 1512 px;
//     main is told open once and closed once;
//  3. geometry: the window never changes size (review round 1); the column is clamp(320px, 24vw,
//     400px) inside the page, the stage stays visible, the bars extend over it; closing restores the
//     stage, Next and Notes;
//  4. the column's content: sub-groups with counts, tried and untried rows, the practice line, the
//     live commands listed apart; a pushed tick ticks and flashes the row and updates the chip;
//  5. the tick reports: a key, a rebound key, the palette and a bar button each report their command
//     once through the bridge (one guide:command-ran per id per page), the Guide button reports presenter-palette.guide;
//  6. outputs: the compiled deck, the handout, the share page and the venue page carry no Guide column
//     markup or styles.
// Every check is collected and all failures are reported together.
// Usage: node scripts/test-presenter-guide.mjs   (SHOTS=<dir> saves the open column at 1024, 1280 and 1512 x 900)
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { buildVenuePageHtml } from '../compiler/scripts/lib/venue-page.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const { SHORTCUT_REGISTRY } = await import(new URL('../src/shared/shortcut-registry.ts', import.meta.url))
const { presentGuideView, PRESENTER_COMMAND_IDS, GUIDE_COLUMN_WIDTH, GUIDE_COLUMN_MIN_WIDTH } = await import(new URL('../src/shared/guide-present.ts', import.meta.url))
const { deriveChapters } = await import(new URL('../src/shared/guide-chapters.ts', import.meta.url))
const { emptyGuideLearn } = await import(new URL('../src/shared/guide-learn.ts', import.meta.url))
const SHOTS = process.env.SHOTS ? resolve(process.env.SHOTS) : null
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }

const chordOf = (id) => SHORTCUT_REGISTRY.find((r) => r.id === id)?.keys ?? ''
const PRESENT = deriveChapters().find((c) => c.task === 'Present')
const viewWith = (ran) => presentGuideView(PRESENT, { ...emptyGuideLearn(), ran }, chordOf, true)
const TRIED = ['presenter.audience', 'presenter.edit', 'presenter.next', 'presenter.previous', 'presenter.first', 'presenter.last', 'presenter.timer', 'presenter.reveal', 'presenter.focus', 'presenter.highlight']
const VIEW = viewWith(TRIED)

const FIXTURE = `---
title: Lightning round
duration: 5min
auto_title_slide: false
auto_thanks_slide: false
---

## 06 Present

### Move through the talk {id=s21}

> **Try it.** Press <kbd>→</kbd> for the next slide, <kbd>←</kbd> to go back, and <kbd>O</kbd> for the outline.

:::notes
Open the presenter, step through, then show the outline.
:::

### Jump and keep time {id=s22}

- Home and End
- Skip and return

:::notes
Five minutes go quickly.
:::

### Thank you {id=s23}

Questions, then coffee.
`

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-presenter-guide-'))
let browser
try {
  const sourcePath = join(scratch, 'lightning-round-outline.md')
  await writeFile(sourcePath, FIXTURE)
  const model = await prepareSource(sourcePath, FIXTURE, 'Lightning round', statSync(sourcePath))
  const fixturePath = join(scratch, 'guide-present.html')
  await writeFile(fixturePath, model.fullHtml)

  // ── 6. the outputs carry no Guide column ────────────────────────────────────────────────────
  {
    const slides = extractSlides(model.fullHtml)
    const styles = extractStyles(model.fullHtml)
    const common = { title: model.title, slides, styles, slug: 'lightning-round', license: null }
    const outputs = {
      'compiled deck': model.fullHtml,
      handout: buildShareHtml({ ...common, includeNotes: false }),
      'share page': buildShareHtml({ ...common, includeNotes: true }),
      'live handout': buildShareHtml({ ...common, includeNotes: false, workerBaseUrl: 'https://live.example', liveTalkSlug: 'lightning-round' }),
      'venue page': buildVenuePageHtml({ ...common, workerBaseUrl: 'https://live.example', qr: '<svg></svg>', handoutUrl: 'https://handouts.example/lightning-round' })
    }
    for (const [name, html] of Object.entries(outputs)) {
      for (const marker of ['twguide-col', 'twguide-styles', 'twg-', 'data-tw-guide', '--tw-guide-w', 'Guide · Present']) check(!html.includes(marker), `${name}: no Guide column markup or styles (${marker})`)
      check(!/id=["']twguide-chip/.test(html), `${name}: no Guide chip element`)
    }
  }

  // The recording preload as the app ships it; electron stubbed. invoke() logs [channel, argument] and
  // answers what main would: the Present chapter, and the column's open record.
  const stubPath = join(scratch, 'electron-stub.mjs')
  await writeFile(stubPath, `const answers = {
  'recording:context': { testMode: true, talkSlug: 'lightning-round', discardThresholdMs: 0 }, 'live:status': 'ended', 'live:snapshot': {},
  'guide:present-chapter': window.__guideReply === undefined ? ${JSON.stringify({ view: VIEW, open: false })} : window.__guideReply,
  'guide:present-column': { open: true },
  'guide:command-ran': { id: null, ticked: false }
}
window.__ipcCalls = []; window.__ipcOn = {}
export const ipcRenderer = {
  invoke: async (channel, ...args) => { window.__ipcCalls.push([channel, args[0] ?? null]); return channel in answers ? answers[channel] : {} },
  on(channel, fn) { (window.__ipcOn[channel] ||= []).push(fn) }, send(channel, value) { window.__ipcCalls.push([channel, value]) }, removeListener() {}
}
window.__push = (channel, value) => { for (const fn of window.__ipcOn[channel] || []) fn(null, value) }
export const contextBridge = { exposeInMainWorld: (name, api) => { window[name] = api } }
export const clipboard = { writeText() {}, readText() { return '' }, readImage() { return { isEmpty: () => true } } }
`)
  const bundle = await build({ entryPoints: [join(repo, 'src/preload/present-recorder.ts')], bundle: true, write: false, format: 'iife', platform: 'browser', alias: { electron: stubPath }, logLevel: 'silent' })
  const preload = bundle.outputFiles[0].text

  browser = await chromium.launch({ headless: true })
  const open = async ({ size = [1440, 900], placement = null, reply } = {}) => {
    const context = await browser.newContext({ viewport: { width: size[0], height: size[1] } })
    context.setDefaultTimeout(5000)
    const setup = [
      reply !== undefined ? `window.__guideReply = ${JSON.stringify(reply)};` : '',
      'window.open = () => null;'
    ].join('\n')
    await context.addInitScript({ content: `if (window === window.top) {\n${setup}\n${preload}\n}` })
    const page = await context.newPage()
    page.errors = []
    page.on('pageerror', (error) => page.errors.push(error.message))
    page.on('dialog', (dialog) => dialog.accept())
    await page.goto(`${pathToFileURL(fixturePath).href}?presenter=1`, { waitUntil: 'load', timeout: 120000 })
    await page.waitForFunction(() => /scale\(([\d.]+)\)/.test(document.querySelector('#currentPreview iframe')?.style.transform || ''), null, { timeout: 30000 })
    await page.waitForSelector('#twedit-btn', { timeout: 10000 }).catch(() => {})
    if (await page.isVisible('#twResume')) await page.click('#twResumeNo').catch(() => {})
    if (placement) {
      await page.evaluate((p) => document.querySelector(`[data-notes-placement-option="${p}"]`)?.click(), placement)
      await page.waitForTimeout(200)
      await page.keyboard.press('Escape')
    }
    await page.mouse.move(5, 500)
    await page.waitForTimeout(250)
    return { page, context }
  }
  const settle = (page, ms = 250) => page.waitForTimeout(ms)
  const guard = async (name, fn) => { try { await fn() } catch (error) { failures.push(`${name}: stopped: ${String(error.message).split('\n')[0]}`) } }
  const calls = (page, channel) => page.evaluate((c) => window.__ipcCalls.filter(([ch]) => ch === c).map(([, a]) => a), channel)
  // Rectangles of the presenter's parts, as laid out now.
  const rects = (page) => page.evaluate(() => {
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width && r.height ? { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom } : null }
    const q = (s) => document.querySelector(s)
    return {
      stage: box(q('.presenter-current-panel')), preview: box(q('#currentPreview')),
      next: box(q('.presenter-side > .presenter-panel:first-child')), then: box(q('#presenterFollowing')), notes: box(q('#presenterNotes')),
      top: box(q('#presenterTopBar')), bottom: box(q('#presenterBottomBar')), column: box(q('#twguide-col')),
      columnParts: [...document.querySelectorAll('#twguide-col *')].map(box).filter(Boolean),
      vw: innerWidth, vh: innerHeight, inline: q('#presenterRoot').style.gridTemplateColumns, attr: q('#presenterRoot').dataset.twGuide || null
    }
  })
  const overlaps = (a, b) => !!a && !!b && a.x < b.r - 0.5 && b.x < a.r - 0.5 && a.y < b.b - 0.5 && b.y < a.b - 0.5
  const near = (a, b, d = 1.5) => Math.abs(a - b) <= d

  // ── 1. the chip ─────────────────────────────────────────────────────────────────────────────
  await guard('chip', async () => {
    const { page, context } = await open()
    const chip = await page.evaluate(() => {
      const el = document.getElementById('twguide-chip')
      return el && { text: el.textContent.replace(/\s+/g, ' ').trim(), besideOutline: el.parentElement?.previousElementSibling?.id === 'outlineBtn' && el.closest('#presenterBottomBar') !== null, inTop: el.closest('#presenterTopBar') !== null, pressed: el.getAttribute('aria-pressed'), tip: el.dataset.tip, key: el.dataset.key, icon: !!el.querySelector('svg.lucide-graduation-cap'), hide: !!document.querySelector('#twguide-hide svg') }
    })
    check(!!chip, 'the Guide button is there')
    if (chip) {
      check(chip.text === `Guide · Present${VIEW.tried} of ${VIEW.total}` || chip.text === `Guide · Present ${VIEW.tried} of ${VIEW.total}`, `the button reads "Guide · Present ${VIEW.tried} of ${VIEW.total}" and carries no key (${chip.text})`)
      check(chip.besideOutline && !chip.inTop, 'the button is in the bottom bar, at the left, next to Outline (owner check 10 Oct)')
      check(chip.hide, 'a small × sits beside it (hides the button)')
      check(chip.pressed === 'false', 'the chip is not pressed while the column is closed')
      check(chip.icon, 'the chip carries lucide graduation-cap')
      check(chip.tip === 'Guide: Present chapter' && !chip.key, `the tooltip names the command and shows no key (${chip.tip} ${chip.key})`)
    }
    check(!(await page.$('#twguide-col')), 'the column is not rendered until it is opened (lazy)')
    await page.keyboard.press('c')
    await page.keyboard.press('C')
    await settle(page)
    check(!(await page.$('#twguide-col')) && (await calls(page, 'guide:present-column')).length === 0, 'C does nothing: the Guide has no key')
    // The bottom bar keeps its items clear of each other with the button in it.
    const bottomOverlap = await page.evaluate(() => {
      const items = [...document.querySelectorAll('#presenterBottomBar button, #twguide-chipwrap')].filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
      const boxes = items.map((el) => [el.id || el.textContent.trim().slice(0, 12), el.getBoundingClientRect()])
      const out = []
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const [na, a] = boxes[i]; const [nb, b] = boxes[j]
        if (na === 'twguide-chipwrap' && (nb === 'twguide-chip' || nb === 'twguide-hide')) continue
        if (nb === 'twguide-chipwrap' && (na === 'twguide-chip' || na === 'twguide-hide')) continue
        if (a.width && b.width && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(`${na} / ${nb}`)
      }
      return out
    })
    check(bottomOverlap.length === 0, `the Guide button overlaps nothing in the bottom bar at 1440 (${bottomOverlap.join(', ')})`)
    // The × is hidden until hover or focus, then asks main to turn the switch off: one bare request.
    const hideShown = await page.evaluate(() => getComputedStyle(document.getElementById('twguide-hide')).opacity)
    check(hideShown === '0', `the × is quiet until hover (${hideShown})`)
    await page.hover('#twguide-chip')
    await settle(page, 200)
    check((await page.evaluate(() => getComputedStyle(document.getElementById('twguide-hide')).opacity)) === '1', 'the × shows on hover')
    await page.click('#twguide-hide')
    await settle(page)
    check(JSON.stringify(await calls(page, 'guide:present-hide-button')) === '[null]', 'the × sends one request with no argument')
    // The top bar still holds its items without overlap at 1440.
    const topOverlap = await page.evaluate(() => {
      const items = [...document.querySelectorAll('#presenterTopBar .tw-topbar-left > *, #presenterTopBar .tw-menu-btn')].filter((el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
      const boxes = items.map((el) => [el.id || el.className, el.getBoundingClientRect()])
      const out = []
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const [na, a] = boxes[i]; const [nb, b] = boxes[j]
        if (a.width && b.width && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(`${na} / ${nb}`)
      }
      return out
    })
    check(topOverlap.length === 0, `the chip overlaps nothing in the top bar at 1440 (${topOverlap.join(', ')})`)
    // Guide button off: main pushes no view; the chip goes and C does nothing.
    await page.evaluate(() => window.__push('guide:present-chapter-changed', { view: null, open: false }))
    await settle(page)
    check(!(await page.$('#twguide-chip')), 'the Guide button off: no chip')
    await page.keyboard.press('c')
    await settle(page)
    check(!(await page.$('#twguide-col')), 'the Guide button off: no column')
    check((await calls(page, 'guide:present-column')).length === 0, 'the Guide button off: nothing sent to main')
    check(page.errors.length === 0, `chip: no page errors (${page.errors.join('; ')})`)
    await context.close()
    // A window that starts with the switch off has no chip either.
    const off = await open({ reply: { view: null, open: false } })
    check(!(await off.page.$('#twguide-chip')), 'opened with the Guide button off: no chip')
    await off.context.close()
  })

  // ── 2, 3. the column: toggles, no overlay, the open record, geometry ──────────────────────
  // The column never resizes or moves the window (review round 1): it takes clamp(320px, 24vw, 400px)
  // inside the page, the stage, Next and Notes reflow into what is left, and the bars extend over it.
  const expectedWidth = (vw) => Math.min(GUIDE_COLUMN_WIDTH, Math.max(GUIDE_COLUMN_MIN_WIDTH, vw * 0.24))
  for (const placement of [null, 'sidebar', 'off', 'camera-column']) {
    for (const width of [1024, 1280, 1512]) {
      const label = `${placement || 'bottom (default)'} at ${width}x900`
      await guard(`column, ${label}`, async () => {
        const { page, context } = await open({ placement, size: [width, 900] })
        const before = await rects(page)
        await page.click('#twguide-chip')
        await settle(page, 400)
        const after = await rects(page)
        check(!!after.column, `${label}: the Guide button opens the column`)
        check(after.attr === 'open', `${label}: the presenter makes room for the column`)
        check((await page.$$('#twguide-col')).length === 1, `${label}: one column`)
        check(after.vw === before.vw && after.vh === before.vh, `${label}: the window keeps its size (${before.vw}x${before.vh} → ${after.vw}x${after.vh})`)
        const record = await calls(page, 'guide:present-column')
        check(JSON.stringify(record) === '[true]', `${label}: main is told the column is open, once (${JSON.stringify(record)})`)
        check(after.column && near(after.column.w, expectedWidth(after.vw)), `${label}: the column is clamp(320px, 24vw, 400px) = ${expectedWidth(after.vw)} px (${after.column?.w})`)
        for (const part of ['stage', 'next', 'then', 'notes', 'top', 'bottom']) {
          const others = [after.column, ...after.columnParts]
          if (after[part]) check(!others.some((c) => overlaps(c, after[part])), `${label}: no part of the column overlaps ${part}`)
        }
        check(after.column && after.column.r <= after.vw && after.column.x >= 0 && after.column.y >= (after.top?.b ?? 0) && after.column.b <= (after.bottom?.y ?? after.vh), `${label}: the column sits between the top and bottom bars, inside the window`)
        check(after.column && after.column.x > Math.max(after.stage?.r ?? 0, after.next?.r ?? 0, after.notes?.r ?? 0), `${label}: the column is to the right of the stage, Next and Notes`)
        check(after.stage && after.preview && after.preview.w >= 200 && after.preview.h >= 100 && after.preview.r <= (after.column?.x ?? after.vw), `${label}: the stage stays visible beside the column (${after.preview?.w}x${after.preview?.h})`)
        check(after.top && after.column && near(after.top.r, after.column.r) && near(after.top.x, before.top.x), `${label}: the top bar spans the window, over the column (${after.top?.x}–${after.top?.r}; column to ${after.column?.r})`)
        check(after.bottom && after.column && near(after.bottom.r, after.column.r) && near(after.bottom.x, before.bottom.x), `${label}: the bottom bar spans the window, under the column`)
        if (SHOTS && !placement) { await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `presenter-guide-open-${width}x900.png`) }) }
        // Close by the chip: main is told once; the page is back as it was.
        await page.click('#twguide-chip')
        await settle(page, 400)
        const closeCalls = await calls(page, 'guide:present-column')
        check(JSON.stringify(closeCalls) === '[true,false]', `${label}: main is told the column is closed, once (${JSON.stringify(closeCalls)})`)
        const closed = await rects(page)
        check(closed.vw === before.vw && closed.vh === before.vh, `${label}: the window keeps its size after closing`)
        check(!closed.column && closed.attr === null, `${label}: the column and its room are gone`)
        check(closed.inline === before.inline, `${label}: the root's columns are its own (${JSON.stringify(closed.inline)})`)
        for (const part of ['stage', 'next', 'notes']) if (before[part]) check(closed[part] && near(closed[part].w, before[part].w) && near(closed[part].x, before[part].x), `${label}: ${part} is back as it was`)
        check(page.errors.length === 0, `${label}: no page errors (${page.errors.join('; ')})`)
        await context.close()
      })
    }
  }

  await guard('the palette row and the column\'s close button', async () => {
    const { page, context } = await open()
    await page.keyboard.press('Meta+Shift+p')
    await settle(page)
    await page.keyboard.type('guide')
    await settle(page)
    const row = await page.evaluate(() => [...document.querySelectorAll('.tw-pal-row')].filter((r) => r.getClientRects().length).map((r) => ({ id: r.dataset.paletteId, text: r.textContent, disabled: r.disabled })))
    const guideRow = row.find((r) => r.id === 'guide')
    check(guideRow && !guideRow.disabled && /Guide: Present chapter/.test(guideRow.text) && !/\bC\b/.test(guideRow.text.replace('Guide: Present chapter', '')), `the palette lists "Guide: Present chapter" with no key (${JSON.stringify(guideRow)})`)
    await page.keyboard.press('Enter')
    await settle(page)
    check(!!(await page.$('#twguide-col')), 'the palette row opens the column')
    check((await page.getAttribute('#twguide-chip', 'aria-pressed')) === 'true', 'the chip is pressed while the column is open')
    await page.click('#twguide-col .twg-x')
    await settle(page)
    check(!(await page.$('#twguide-col')), 'the column\'s × closes it')
    await page.click('#twguide-chip'); await settle(page)
    await page.click('#twguide-chip'); await settle(page)
    check(!(await page.$('#twguide-col')), 'the button twice: open, then closed')
    check(JSON.stringify(await calls(page, 'guide:present-column')) === '[true,false,true,false]', 'each open and close asked once')
    await context.close()
  })

  // ── 4. the column's content and a pushed tick ───────────────────────────────────────────────
  await guard('content', async () => {
    const { page, context } = await open()
    await page.click('#twguide-chip')
    await settle(page)
    const content = await page.evaluate(() => {
      const col = document.getElementById('twguide-col')
      const t = (s) => col.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() || ''
      return {
        head: t('.twg-head'), title: t('.twg-title'), note: t('.twg-note'), card: t('.twg-card-h'), live: t('.twg-live'),
        groups: [...col.querySelectorAll('.twg-cg-h')].map((h) => [h.querySelector('b').textContent, h.querySelector('.twg-gd').textContent, h.getAttribute('aria-expanded')]),
        rows: [...col.querySelectorAll('.twg-row')].map((r) => [r.dataset.commandRow, r.dataset.ticked, [...r.querySelectorAll('kbd')].map((k) => k.textContent).join(' ')]),
        icons: [...col.querySelectorAll('svg')].map((s) => [...s.classList].find((c) => c.startsWith('lucide-')))
      }
    })
    check(content.head === 'Guide', `the column is headed Guide (${content.head})`)
    // "All chapters": the way to the other chapters, which live in the TalkWeaver window (owner check 10 Oct).
    const all = await page.evaluate(() => { const b = document.querySelector('#twguide-col [data-guide-all-chapters]'); return b && { text: b.textContent.trim(), first: b === document.querySelector('#twguide-col .twg-scroll').firstElementChild } })
    check(all && all.text === 'All chapters' && all.first, `"All chapters" is the first thing in the column (${JSON.stringify(all)})`)
    await page.click('#twguide-col [data-guide-all-chapters]')
    await settle(page)
    check(JSON.stringify(await calls(page, 'guide:present-all-chapters')) === '[null]', 'All chapters sends one request with no argument')
    check(!JSON.stringify(await page.evaluate(() => window.__ipcCalls)).includes('Share'), 'no other chapter\'s name or data is in anything the presenter holds or sent')
    check(content.title === `Present${VIEW.status}`.replace(/\s+/g, ' ') || content.title === `Present ${VIEW.status}`, `Present and "${VIEW.status}" (${content.title})`)
    check(content.note === 'Practice talk: Lightning round (open now), section “06 Present”.', `the practice line (${content.note})`)
    check(content.card === `This chapter${VIEW.tried} of ${VIEW.total}` || content.card === `This chapter ${VIEW.tried} of ${VIEW.total}`, `This chapter with its count (${content.card})`)
    check(content.live.startsWith(`${VIEW.live} live commands are listed apart`) && content.live.includes('after the live service is set up'), `the live commands are listed apart (${content.live})`)
    check(JSON.stringify(content.groups.map((g) => g[0])) === JSON.stringify(VIEW.subgroups.map((g) => g.name)), `the sub-groups in order (${content.groups.map((g) => g[0]).join(', ')})`)
    check(content.groups.every(([name, count]) => { const g = VIEW.subgroups.find((x) => x.name === name); return count === `${g.tried} of ${g.total}` }), 'each sub-group shows its own count')
    const firstOpen = VIEW.subgroups.find((g) => g.tried < g.total).name
    check(content.groups.filter((g) => g[2] === 'true').map((g) => g[0]).join() === firstOpen, `the first sub-group with something left starts open (${firstOpen})`)
    const next = content.rows.find((r) => r[0] === 'presenter.next')
    check(!next || (next[1] === 'true' && next[2] === '→ Space +3'), `Next is ticked with "→ Space +3" (${JSON.stringify(next)})`)
    check(content.rows.some((r) => r[1] === 'false'), 'untried rows are drawn untried')
    for (const name of ['lucide-graduation-cap', 'lucide-x', 'lucide-presentation', 'lucide-check', 'lucide-radio']) check(content.icons.includes(name), `lucide icon ${name}`)
    // Open a sub-group, then main pushes a tick: the row ticks and flashes, counts and chip follow.
    await page.click('#twguide-col .twg-cg[data-subgroup="Move through slides"] .twg-cg-h')
    await settle(page)
    const ticked = viewWith([...TRIED, 'presenter.overview'])
    await page.evaluate((reply) => window.__push('guide:present-chapter-changed', reply), { view: ticked, open: true })
    await settle(page, 150)
    const after = await page.evaluate(() => ({
      row: document.querySelector('#twguide-col [data-command-row="presenter.overview"]')?.className || '',
      ticked: document.querySelector('#twguide-col [data-command-row="presenter.overview"]')?.dataset.ticked,
      chip: document.querySelector('#twguide-chip b')?.textContent, status: document.querySelector('#twguide-col .twg-title small')?.textContent
    }))
    check(after.ticked === 'true' && /is-flash/.test(after.row), `a pushed tick ticks and flashes the row (${JSON.stringify(after)})`)
    check(after.chip === `${ticked.tried} of ${ticked.total}` && after.status === ticked.status, `the chip and the chapter count follow (${after.chip}, ${after.status})`)
    // Strings from main are text: markup in a label stays text.
    const hostile = viewWith(TRIED)
    hostile.subgroups[0].rows[0].label = '<img src=x onerror="window.__xss=1">'
    hostile.subgroups[0].name = '<b>bold</b>'
    await page.evaluate((reply) => window.__push('guide:present-chapter-changed', reply), { view: hostile, open: true })
    await settle(page, 150)
    await page.click('#twguide-col .twg-cg-h').catch(() => {})
    await settle(page, 150)
    const safe = await page.evaluate(() => ({ img: !!document.querySelector('#twguide-col img'), bold: !!document.querySelector('#twguide-col .twg-cg-h b b'), xss: window.__xss === 1 }))
    check(!safe.img && !safe.bold && !safe.xss, `labels and names from main are set as text (${JSON.stringify(safe)})`)
    check(page.errors.length === 0, `content: no page errors (${page.errors.join('; ')})`)
    await context.close()
  })

  // ── 5. the tick reports ──────────────────────────────────────────────────────────────────────
  await guard('reports', async () => {
    const { page, context } = await open()
    const reported = () => calls(page, 'guide:command-ran')
    await page.keyboard.press('ArrowRight'); await settle(page)
    check(JSON.stringify(await reported()) === '["presenter.next"]', `→ reports presenter.next (${JSON.stringify(await reported())})`)
    await page.keyboard.press('ArrowRight'); await settle(page)
    await page.click('#presenterNext'); await settle(page)
    check((await reported()).filter((id) => id === 'presenter.next').length === 1, 'a second → and the Next button send nothing more (once per page)')
    await page.click('#presenterPrev'); await settle(page)
    check((await reported()).includes('presenter.previous'), 'the Previous button reports presenter.previous')
    await page.keyboard.press('o'); await settle(page)
    await page.keyboard.press('Escape'); await settle(page)
    check((await reported()).includes('presenter.overview'), 'O reports presenter.overview')
    await page.keyboard.press('Shift+?'); await settle(page)
    await page.keyboard.press('Escape'); await settle(page)
    check((await reported()).includes('presenter.help'), '? reports presenter.help')
    await page.click('#twguide-chip'); await settle(page)
    check((await reported()).includes('presenter-palette.guide'), 'the Guide button reports presenter-palette.guide')
    await page.click('#twguide-chip'); await settle(page)
    // The palette: a key-less entry reports itself; one with a key reports its key's command.
    await page.keyboard.press('Meta+Shift+p'); await settle(page)
    await page.keyboard.type('reset timer'); await settle(page)
    await page.keyboard.press('Enter'); await settle(page)
    check((await reported()).includes('presenter-palette.reset-timer'), 'the palette\'s Reset timer reports presenter-palette.reset-timer')
    await page.keyboard.press('Meta+Shift+p'); await settle(page)
    await page.keyboard.type('notes: sidebar'); await settle(page)
    await page.keyboard.press('Enter'); await settle(page)
    check((await reported()).includes('presenter-palette.notes-sidebar'), 'Notes: sidebar reports its palette id')
    // A menu item reports its command (View → Focus mode).
    await page.click('#presenterMenuView').catch(() => {}); await settle(page, 150)
    await page.click('#viewFocus').catch(() => {}); await settle(page)
    check((await reported()).includes('presenter.focus'), 'View → Focus mode reports presenter.focus')
    // A key that does nothing here reports nothing (B with no jump to return from).
    await page.keyboard.press('b'); await settle(page)
    check(!(await reported()).includes('presenter.return'), 'B with nothing to return to reports nothing')
    const all = await reported()
    check(new Set(all).size === all.length, `each id is sent once (${all.join(', ')})`)
    check(all.every((id) => PRESENTER_COMMAND_IDS.has(id)), 'only ids on the registries\' presenter list are sent')
    check(page.errors.length === 0, `reports: no page errors (${page.errors.join('; ')})`)
    await context.close()
  })
  // Review round 1: a deck page's own script may dispatch the event with any id it likes. Only ids on
  // the registries' finite presenter list are retained and forwarded; anything else is dropped silently.
  await guard('made-up ids from the deck page are dropped', async () => {
    const { page, context } = await open()
    const reported = () => calls(page, 'guide:command-ran')
    await page.evaluate(() => {
      const fire = (detail) => window.dispatchEvent(new CustomEvent('tw-guide-command-ran', { detail }))
      for (let i = 0; i < 500; i++) {
        const r = Math.random().toString(36).slice(2, 10).replace(/[^a-z]/g, 'x')
        fire(`presenter.${r}`); fire(`presenter-palette.${r}`)
      }
      for (const id of ['presenter.not-a-command', 'presenter-palette.not-an-entry', 'presenter.Next', 'delete-slide', '__proto__', '', null, 42, { id: 'presenter.next' }]) fire(id)
    })
    await settle(page)
    check((await reported()).length === 0, `no made-up id reaches main (${(await reported()).slice(0, 5).join(', ')}…)`)
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('tw-guide-command-ran', { detail: 'presenter.timer' })))
    await settle(page)
    check(JSON.stringify(await reported()) === '["presenter.timer"]', `a listed id still goes, once (${(await reported()).length} sent: ${JSON.stringify((await reported()).slice(-3))})`)
    check(page.errors.length === 0, `made-up ids: no page errors (${page.errors.join('; ')})`)
    await context.close()
  })
  await guard('a rebound key reports its command', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript({ content: `if (window === window.top) { try { localStorage.setItem('talkweaver:presenter:shortcuts', JSON.stringify({ 'presenter.overview': { chord: 'Y', entryId: 'outline' } })) } catch {} window.open = () => null;\n${preload}\n}` })
    const page = await context.newPage()
    await page.goto(`${pathToFileURL(fixturePath).href}?presenter=1`, { waitUntil: 'load', timeout: 120000 })
    await page.waitForFunction(() => /scale\(([\d.]+)\)/.test(document.querySelector('#currentPreview iframe')?.style.transform || ''), null, { timeout: 30000 })
    await settle(page, 300)
    await page.keyboard.press('y'); await settle(page)
    const sent = await calls(page, 'guide:command-ran')
    check(sent.includes('presenter.overview') && sent.filter((id) => id === 'presenter.overview').length === 1, `a rebound O (Y) reports presenter.overview once (${sent.join(', ')})`)
    await context.close()
  })
  // A deck opened on its own (no preload): no chip, no column, C does nothing, nothing breaks.
  await guard('a deck opened on its own', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${pathToFileURL(fixturePath).href}?presenter=1`, { waitUntil: 'load', timeout: 120000 })
    await page.waitForFunction(() => /scale\(([\d.]+)\)/.test(document.querySelector('#currentPreview iframe')?.style.transform || ''), null, { timeout: 30000 })
    const heard = await page.evaluate(() => { const got = []; window.addEventListener('tw-guide-command-ran', (e) => got.push(e.detail)); window.__heard = got; return true })
    await page.keyboard.press('c'); await page.keyboard.press('ArrowRight'); await settle(page)
    const state = await page.evaluate(() => ({ chip: !!document.getElementById('twguide-chip'), col: !!document.getElementById('twguide-col'), heard: window.__heard, slide: document.querySelector('.slide.active')?.dataset.id }))
    check(heard && !state.chip && !state.col, 'no chip and no column without the preload')
    check(JSON.stringify(state.heard) === '["presenter.next"]', `the runtime still says what ran; nobody forwards it (${JSON.stringify(state.heard)})`)
    check(errors.length === 0, `no page errors (${errors.join('; ')})`)
    await context.close()
  })
} finally {
  await browser?.close()
  await rm(scratch, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`test-presenter-guide: ${failures.length} failure(s):`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`presenter Guide: the button ("Guide · Present ${VIEW.tried} of ${VIEW.total}", bottom bar, no key, with a × to hide it) shows while the Guide button is on; the button and the palette toggle a clamp(${GUIDE_COLUMN_MIN_WIDTH}px, 24vw, ${GUIDE_COLUMN_WIDTH}px) column beside Next and Notes with no overlay in four placements at 1024, 1280 and 1512 px; the window never changes size; main told open and closed once each; the Present chapter's rows, counts, practice line and live note; pushed ticks tick and flash; every route reports its command once; no Guide markup in the deck, handout, share or venue outputs`)
