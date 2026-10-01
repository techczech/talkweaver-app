// The presenter's board panel in the compiled presenter window (feedback-boards ticket 05; ADR-0032
// decision 4; drawn in the feedback-boards round 2 design, states D1-D24). Headless
// Chromium at 1440x900 with the recording preload (and through it the live bridge) bundled against a
// stub of electron, as the app injects it, and a stand-in for the live worker that runs the worker's
// own board code (scripts/fixtures/board-panel-worker.ts, bun): every operation the panel sends is
// parsed and applied by the worker's parser and reducer, and the state it answers with is what the
// panel then shows. Seams:
//  1. beside the slide (D1): over the Next and Then previews, never over the slide; the poll panel
//     never shows a board; the header, the big-screen strip, the inbox, the columns; the status-bar
//     counter; card text as text only;
//  2. drag (D2, D3, D15): a card onto a group merges, onto a column moves, a group onto a column moves
//     the group — each drop is exactly ONE board operation; the toast offers Undo and ⌘Z sends ONE
//     operation that undoes it;
//  3. menus (D4, D8, D10, D13, D14): hide and put back, split, move to a column, the big screen's
//     Show next / Show all / Groups only / limit, a column's own groups only;
//  4. the keyboard (every drag has a key): ⌥↵ picks up and drops (merge on a card, move on a column
//     name), Esc puts it down, ↵ on a card opens its menu and never moves the slide;
//  5. freeze (D17, the Poll menu's Board group, D19): Freeze sends board.freeze; a frozen board takes
//     no drags; Q closes the board to new cards (a poll operation, not a board one);
//  6. full screen (D22): the panel takes the window under the top bar, the slide shows as a monitor;
//     Esc and Exit full screen come back;
//  7. popped out (D23, D24): the board in its own window, drawn by the presenter window; operations
//     from there go through the presenter's live bridge; Put back and closing the window both bring
//     it back beside the slide; the counter says "own window" meanwhile.
// Every check is collected and all failures are reported together.
// Usage: node scripts/test-presenter-board.mjs   (SHOTS=<dir> saves the drawn states)
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const SHOTS = process.env.SHOTS ? resolve(process.env.SHOTS) : null
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }
const passes = []
const pass = (ok, message) => { check(ok, message); if (ok) passes.push(message) }

const FIXTURE = `---
title: The current state of AI agents
duration: 60min
auto_title_slide: false
auto_thanks_slide: false
---

### Before the board {id=before}

- A slide to come from

:::notes
Stand-in note. Read the Change column first: it is where the room disagrees with the plan. Merge the duplicates, then say the two biggest numbers out loud.
:::

### What should we keep, change, try? {id=kct}
{poll=board}

Add what you would keep, change or try. One idea per card.

- Keep
- Change
- Try

### Thank you {id=thanks}

- Questions
`

// ── The worker stand-in ────────────────────────────────────────────────────────────────────
function startWorker() {
  const child = spawn('bun', [join(repo, 'scripts/fixtures/board-panel-worker.ts')], { stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = createInterface({ input: child.stdout })
  const waiting = []
  lines.on('line', (line) => { const next = waiting.shift(); if (next) next(JSON.parse(line)) })
  return {
    ask: (command) => new Promise((resolveReply) => { waiting.push(resolveReply); child.stdin.write(`${JSON.stringify(command)}\n`) }),
    stop: () => { try { child.stdin.end(); child.kill() } catch { /* gone */ } },
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-presenter-board-'))
let browser
const worker = startWorker()
try {
  const sourcePath = join(scratch, 'board.md')
  await writeFile(sourcePath, FIXTURE)
  const model = await prepareSource(sourcePath, FIXTURE, 'The current state of AI agents', statSync(sourcePath))
  const definition = model.slides.find((slide) => slide.poll)?.poll
  const htmlPath = join(scratch, 'board-present.html')
  await writeFile(htmlPath, model.fullHtml)
  pass(definition?.type === 'board', 'the fixture compiles a board slide')
  const columnIds = definition.options.map((option) => option.optionId)

  const stubPath = join(scratch, 'electron-stub.mjs')
  await writeFile(stubPath, `const ok = { success: true, status: 'confirmed' }
const answers = { 'recording:context': { testMode: true, talkSlug: 'board', discardThresholdMs: 0 }, 'live:status': 'ended', 'live:snapshot': {},
  'live:end': { success: true, status: 'ended' }, 'live:poll-open': ok, 'live:poll-close': ok, 'live:poll-reveal': ok, 'live:poll-hide': ok, 'live:instant-action': ok, 'live:open-boards': [] }
window.__ipcCalls = []; window.__ipcOn = {}; window.__boardCalls = []
let operations = 0
export const ipcRenderer = {
  invoke: async (channel, ...args) => {
    window.__ipcCalls.push(channel)
    if (channel === 'live:board-action') {
      window.__boardCalls.push(args[0])
      const reply = await window.__boardAction(args[0])
      setTimeout(() => { if (window.__holdStates) (window.__held ||= []).push(reply.state); else window.__push('live:poll-state', reply.state) }, 0)
      return reply.ok ? { success: true, status: 'pending', operationId: 'op-' + (++operations) } : { success: false, status: 'rejected', error: reply.error }
    }
    return channel in answers ? answers[channel] : {}
  },
  on(channel, fn) { (window.__ipcOn[channel] ||= []).push(fn) }, send() {}, removeListener() {}
}
window.__push = (channel, value) => { for (const fn of window.__ipcOn[channel] || []) fn(null, value) }
export const contextBridge = { exposeInMainWorld: (name, api) => { window[name] = api } }
export const clipboard = { writeText(value) { window.__copied = value }, readText: () => '', readImage: () => null }
`)
  const bundle = await build({ entryPoints: [join(repo, 'src/preload/present-recorder.ts')], bundle: true, write: false, format: 'iife', platform: 'browser', alias: { electron: stubPath }, logLevel: 'silent' })
  const preload = bundle.outputFiles[0].text

  browser = await chromium.launch({ headless: true })
  const settle = (page, ms = 250) => page.waitForTimeout(ms)
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  // Only the presenter window gets the preload (the board's own window is drawn by it).
  await context.addInitScript({ content: `if (window === window.top && !window.opener && location.protocol === 'file:') {\n${preload}\n}` })
  await context.exposeFunction('__boardAction', (message) => worker.ask({ cmd: 'op', message }))
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('dialog', (dialog) => dialog.accept())
  await page.goto(`${pathToFileURL(htmlPath).href}?presenter=1#kct`, { waitUntil: 'load', timeout: 120000 })
  await page.waitForFunction(() => /scale\(([\d.]+)\)/.test(document.querySelector('#currentPreview iframe')?.style.transform || ''), null, { timeout: 30000 })
  await page.waitForSelector('#presenterStatus #twrec-module', { timeout: 10000 }).catch(() => {})
  if (await page.isVisible('#twResume')) await page.click('#twResumeNo')
  await page.mouse.move(5, 500)
  const shot = async (target, name) => { if (SHOTS) { await settle(target, 250); await target.screenshot({ path: join(SHOTS, name) }) } }
  if (SHOTS) await mkdir(SHOTS, { recursive: true })

  const push = async (state) => { await page.evaluate((value) => window.__push('live:poll-state', value), state); await settle(page, 200) }
  const calls = () => page.evaluate(() => window.__boardCalls.slice())
  const callsSince = async (count) => (await calls()).slice(count)
  const ipcSince = async (count) => (await page.evaluate(() => window.__ipcCalls.slice())).slice(count)
  const ipcCount = async () => (await page.evaluate(() => window.__ipcCalls.length))
  const waitCalls = async (count, timeout = 3000) => { try { await page.waitForFunction((n) => window.__boardCalls.length >= n, count, { timeout }) } catch { /* reported by the check */ } await settle(page, 250) }
  const panel = () => page.evaluate(() => {
    const root = document.getElementById('presenterBoardPanel')
    const shown = (el) => !!el && el.getClientRects().length > 0 && !el.closest('[hidden]')
    if (!shown(root)) return { shown: false }
    const box = root.getBoundingClientRect()
    const current = document.getElementById('currentPreview').getBoundingClientRect()
    const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim()
    return {
      shown: true, mode: root.dataset.mode, box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height },
      overSlide: box.left < current.right - 1 && box.right > current.left + 1 && box.top < current.bottom - 1 && box.bottom > current.top + 1,
      head: text(root.querySelector('.bp-head')), strip: text(root.querySelector('.bp-strip')), inbox: text(root.querySelector('.bp-inbox-head')),
      inboxCards: [...root.querySelectorAll('.bp-inbox .bp-card .bp-text')].map(text),
      columns: [...root.querySelectorAll('.bp-col')].map((col) => ({ head: text(col.querySelector('.bp-col-name')), cards: [...col.querySelectorAll('.bp-card')].map((card) => [card.querySelector('.bp-n'), card.querySelector('.bp-text'), card.querySelector('.bp-x')].filter(Boolean).map(text).join(' ')) })),
      toast: text(root.querySelector('.bp-toast')), menu: text(root.querySelector('.bp-menu')),
      pollPanel: shown(document.getElementById('presenterPollPanel')),
      chip: shown(document.getElementById('presenterBoardCount')) ? text(document.getElementById('presenterBoardCount')) : null,
      images: root.querySelectorAll('img').length,
      overflow: [...root.querySelectorAll('.bp-head button, .bp-strip button')].filter((b) => { const r = b.getBoundingClientRect(); return r.right > box.right + 0.5 || r.left < box.left - 0.5 }).map((b) => b.id || b.textContent),
    }
  })
  const center = async (selector, target = page) => {
    const box = await target.locator(selector).first().boundingBox()
    return box ? { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 14) } : null
  }
  const dragTo = async (from, to, target = page, { hold = false } = {}) => {
    const a = await center(from, target), b = await center(to, target)
    if (!a || !b) { failures.push(`drag: no element for ${!a ? from : to}`); return }
    await target.mouse.move(a.x, a.y); await target.mouse.down()
    await target.mouse.move(a.x + 12, a.y + 8, { steps: 3 })
    await target.mouse.move(b.x, b.y, { steps: 10 })
    if (hold) return
    await target.mouse.up()
  }
  const cardSel = (text) => `.bp-card:has(.bp-text:text-is("${text}"))`
  const groupSel = (n) => `.bp-card.is-group[data-key="g:${n}"]`

  // ── 1. Beside the slide (D1) ─────────────────────────────────────────────────────────────
  await page.evaluate(() => window.__push('live:status', 'live'))
  let reply = await worker.ask({ cmd: 'init', definition, scene: 'd1' })
  await push(reply.state)
  let p = await panel()
  pass(p.shown && p.mode === 'beside', 'D1: the board panel opens beside the slide on a live board')
  pass(!p.pollPanel, 'D1: the poll panel does not show a board')
  pass(!p.overSlide, `D1: the panel lies beside the slide, never over it (${JSON.stringify(p.box)})`)
  pass(p.box.width >= 500 && p.box.height >= 600, `D1: the panel takes the Next and Then column at 1440x900 (${Math.round(p.box.width)}x${Math.round(p.box.height)})`)
  pass(/Board\s*23 cards · 5 new\s*Open/.test(p.head) && /Close to new cards/.test(p.head), `D1: the header reads "Board 23 cards · 5 new Open" with Close to new cards (${p.head})`)
  pass(/Big screen every card · 16 · limit 24/.test(p.strip), `D1: the strip reads "Big screen every card · 16 · limit 24" (${p.strip})`)
  pass(/New\s*5 · not sorted, already on screen/.test(p.inbox) && /Mark all sorted/.test(p.inbox), `D1: the inbox head (${p.inbox})`)
  pass(p.inboxCards[0] === 'More hands-on, less talk' && p.inboxCards.length === 5, `D1: the inbox lists the new cards, newest first (${p.inboxCards.join(' | ')})`)
  pass(p.columns.map((c) => c.head).join(' | ') === 'Keep7 | Change5 | Try6', `D1: the column heads count their sorted cards (${p.columns.map((c) => c.head).join(' | ')})`)
  pass(p.columns[0].cards[0] === '1 More time for hands-on ×3', `D1: groups first, numbered with their count (${p.columns[0].cards.join(' | ')})`)
  pass(p.chip === '235 new', `D1: the status bar counts the board's cards and new ones (${p.chip})`)
  pass(p.overflow.length === 0, `D1: no header or strip control runs outside the panel (${p.overflow.join(', ')})`)
  await shot(page, 'D1-board-panel-1440x900.png')
  // ── 2. Drag: merge, move; the toast; ⌘Z ─────────────────────────────────────────────────
  let before = (await calls()).length
  await dragTo(cardSel('More hands-on, less talk'), groupSel(1), page, { hold: true })
  await settle(page, 150)
  const pill = await page.evaluate(() => document.querySelector('.bp-drop-pill')?.textContent?.trim() || '')
  pass(pill === 'Merge · ×4', `D2: while dragging onto group 1 the pill says "Merge · ×4" (${pill})`)
  await shot(page, 'D2-drag-merge-1440x900.png')
  await page.mouse.up()
  await waitCalls(before + 1)
  let sent = await callsSince(before)
  pass(sent.length === 1 && sent[0].type === 'board.merge' && sent[0].target.group === 1 && typeof sent[0].source.cardId === 'string', `D2: a drop on a group is ONE board.merge into that group (${JSON.stringify(sent)})`)
  p = await panel()
  pass(p.columns[0].cards[0] === '1 More time for hands-on ×4', `D5: the worker's answer shows group 1 at ×4 (${p.columns[0].cards[0]})`)
  pass(/Merged into 1 · More time for hands-on now ×4/.test(p.toast) && /Undo/.test(p.toast), `D5: the toast says what happened and offers Undo (${p.toast})`)
  const toastBox = await page.evaluate(() => { const t = document.querySelector('.bp-toast')?.getBoundingClientRect(); const c = document.getElementById('currentPreview').getBoundingClientRect(); return t && { inSlideColumn: t.left >= c.left - 1 && t.left < c.right } })
  pass(toastBox?.inSlideColumn, 'D5: the toast sits over the slide, as drawn')
  await shot(page, 'D5-merged-toast-1440x900.png')
  before = (await calls()).length
  await page.keyboard.press('Meta+z')
  await waitCalls(before + 1)
  sent = await callsSince(before)
  pass(sent.length === 1 && sent[0].type === 'board.move' && sent[0].column === columnIds[0], `⌘Z: ONE operation undoes the merge (the card back to its column) (${JSON.stringify(sent)})`)
  p = await panel()
  pass(p.columns[0].cards[0] === '1 More time for hands-on ×3', `⌘Z: group 1 is back to ×3 (${p.columns[0].cards[0]})`)

  before = (await calls()).length
  await dragTo(cardSel('Breaks were too long'), `.bp-col[data-key="k:${columnIds[2]}"] .bp-col-head`, page, { hold: true })
  await settle(page, 150)
  const lit = await page.evaluate((id) => document.querySelector(`.bp-col[data-key="k:${id}"]`)?.classList.contains('is-drop-column'), columnIds[2])
  pass(lit, 'D3: dragging onto a column lights the column')
  await shot(page, 'D3-drag-to-column-1440x900.png')
  await page.mouse.up()
  await waitCalls(before + 1)
  sent = await callsSince(before)
  pass(sent.length === 1 && sent[0].type === 'board.move' && sent[0].column === columnIds[2] && sent[0].target.cardId, `D3: a drop on a column is ONE board.move (${JSON.stringify(sent)})`)

  before = (await calls()).length
  await dragTo(groupSel(4), `.bp-col[data-key="k:${columnIds[1]}"] .bp-col-head`)
  await waitCalls(before + 1)
  sent = await callsSince(before)
  pass(sent.length === 1 && sent[0].type === 'board.move' && sent[0].target.group === 4 && sent[0].column === columnIds[1], `D15: a group dropped on a column is ONE board.move of the group (${JSON.stringify(sent)})`)
  p = await panel()
  pass(p.columns[1].cards.some((card) => card.startsWith('4 The live demo')), 'D15: the group keeps its number in its new column')

  // ── 3. Menus: hide, put back, split, the big screen, a column ──────────────────────────
  before = (await calls()).length
  await page.click(cardSel('Does anyone know the wifi password?'), { button: 'right' })
  await settle(page)
  p = await panel()
  pass(/Merge into…/.test(p.menu) && /Move to column/.test(p.menu) && /Hide from the board\s*kept in the Run/.test(p.menu), `D4: a card's menu: merge into, move to column, hide (${p.menu})`)
  await shot(page, 'D4-card-menu-hide-1440x900.png')
  await page.click('.bp-menu .bp-mi:has-text("Hide from the board")')
  await waitCalls(before + 1)
  sent = await callsSince(before)
  pass(sent.length === 1 && sent[0].type === 'board.hide' && sent[0].hidden === true, `D4: Hide is ONE board.hide (${JSON.stringify(sent)})`)
  p = await panel()
  pass(/Hidden from the board\s*kept in the Run/.test(p.toast), `D4: the toast says it is kept in the Run (${p.toast})`)
  const hiddenCard = page.locator('.bp-card.is-hidden:has(.bp-text:text-is("Does anyone know the wifi password?"))')
  pass(await hiddenCard.count() === 1, 'a hidden card stays in the panel, marked hidden, at the foot of its column')
  await shot(page, 'D4-hidden-toast-1440x900.png')
  before = (await calls()).length
  await hiddenCard.click({ button: 'right' })
  await page.click('.bp-menu .bp-mi:has-text("Put back on the board")')
  await waitCalls(before + 1)
  sent = await callsSince(before)
  pass(sent.length === 1 && sent[0].type === 'board.hide' && sent[0].hidden === false, `Put back is ONE board.hide with hidden false (${JSON.stringify(sent)})`)

  before = (await calls()).length
  await page.click(groupSel(5))
  await settle(page)
  p = await panel()
  pass(/Group 5 · 2 cards/.test(p.menu) && /Split into its 2 cards\s*number retires/.test(p.menu) && /Move the whole group to/.test(p.menu) && /Hide the group/.test(p.menu), `D13: a group's menu (${p.menu})`)
  await shot(page, 'D13-group-menu-1440x900.png')
  await page.click('.bp-menu .bp-mi:has-text("Split into its 2 cards")')
  await waitCalls(before + 1)
  sent = await callsSince(before)
  pass(sent.length === 1 && sent[0].type === 'board.split' && sent[0].group === 5, `D14: Split is ONE board.split (${JSON.stringify(sent)})`)
  p = await panel()
  pass(/Group 5 split into its 2 cards\.\s*Number 5 retires/.test(p.toast), `D14: the toast (${p.toast})`)
  pass(await page.locator('.bp-card.is-from-group:has-text("From group 5")').count() === 2, 'D14: the cards come back as singles marked "From group 5"')
  await shot(page, 'D14-after-split-1440x900.png')

  // Past the limit (D7-D12).
  reply = await worker.ask({ cmd: 'init', definition, scene: 'limit' })
  await push(reply.state)
  p = await panel()
  pass(/Big screen 12 of 20 · 8 waiting/.test(p.strip) && /Show next 8/.test(p.strip) && /Show all/.test(p.strip), `D7: past the limit the strip offers Show next and Show all (${p.strip})`)
  pass(await page.locator('.bp-card.is-waiting').count() === 8, 'D7: waiting cards are marked (dashed, "Waiting")')
  await shot(page, 'D7-limit-reached-1440x900.png')
  before = (await calls()).length
  await page.click('#boardShowNext')
  await waitCalls(before + 1)
  sent = await callsSince(before)
  pass(sent.length === 1 && sent[0].type === 'board.release' && sent[0].mode === 'next', `D9: Show next is ONE board.release next (${JSON.stringify(sent)})`)
  p = await panel()
  pass(/Big screen every card · 20, past the limit of 12/.test(p.strip) && /Back to 12/.test(p.strip), `D9: the worker released them all and the strip says so (${p.strip})`)
  before = (await calls()).length
  await page.click('#boardBackToLimit')
  await waitCalls(before + 1)
  sent = await callsSince(before)
  pass(sent.length === 1 && sent[0].type === 'board.release' && sent[0].mode === 'limit', `D12: Back to the limit is ONE board.release limit (${JSON.stringify(sent)})`)
  await page.click('#boardScreenMenu')
  await settle(page)
  p = await panel()
  pass(/Show next 8/.test(p.menu) && /Show all 8 waiting/.test(p.menu) && /Groups only/.test(p.menu) && /Back to the limit/.test(p.menu) && /Limit: 12 cards/.test(p.menu), `D8: the big-screen menu (${p.menu})`)
  await shot(page, 'D8-screen-menu-1440x900.png')
  before = (await calls()).length
  await page.click('.bp-menu .bp-mi:has-text("Groups only")')
  await waitCalls(before + 1)
  sent = await callsSince(before)
  pass(sent.length === 1 && sent[0].type === 'board.release' && sent[0].mode === 'groupsOnly' && !sent[0].column, `D11: Groups only is ONE board.release groupsOnly (${JSON.stringify(sent)})`)
  await page.click('#boardScreenMenu')
  before = (await calls()).length
  await page.click('.bp-menu .bp-chip-btn:has-text("36")')
  await waitCalls(before + 1)
  sent = await callsSince(before)
  pass(sent.length === 1 && sent[0].type === 'board.limit' && sent[0].limit === 36, `the limit: ONE board.limit (${JSON.stringify(sent)})`)
  await page.click(`[data-column-menu="${columnIds[0]}"]`)
  await settle(page)
  p = await panel()
  pass(/Keep on the big screen/.test(p.menu) && /Keep: groups only\s*hide its overflow/.test(p.menu), `D10: a column's own menu (${p.menu})`)
  await shot(page, 'D10-lane-menu-1440x900.png')
  before = (await calls()).length
  await page.click('.bp-menu .bp-mi:has-text("Keep: groups only")')
  await waitCalls(before + 1)
  sent = await callsSince(before)
  pass(sent.length === 1 && sent[0].type === 'board.release' && sent[0].column === columnIds[0] && sent[0].mode === 'groupsOnly', `D10: a column's groups only is ONE board.release for that column (${JSON.stringify(sent)})`)

  // ── 4. The keyboard ─────────────────────────────────────────────────────────────────────
  reply = await worker.ask({ cmd: 'init', definition, scene: 'd1' })
  await push(reply.state)
  const slideNow = () => page.evaluate(() => document.querySelector('.slide.active')?.dataset.id)
  await page.focus(cardSel('Pairs worked really well'))
  await page.keyboard.press('Enter')
  await settle(page)
  p = await panel()
  pass(/Merge into…/.test(p.menu) && await slideNow() === 'kct', `↵ on a card opens its menu and does not move the slide (${await slideNow()})`)
  await page.keyboard.press('Escape')
  await settle(page)
  pass(!(await panel()).menu, 'Esc closes the card menu')
  before = (await calls()).length
  await page.focus(cardSel('Pairs worked really well'))
  await page.keyboard.press('Alt+Enter')
  await settle(page)
  pass(await page.locator('.bp-pickbar').count() === 1 && await page.locator('.bp-card.is-picked').count() === 1, '⌥↵ picks up the focused card (the held bar shows)')
  await page.focus(groupSel(3))
  await page.keyboard.press('Alt+Enter')
  await waitCalls(before + 1)
  sent = await callsSince(before)
  pass(sent.length === 1 && sent[0].type === 'board.merge' && sent[0].target.group === 3, `⌥↵ on a group drops it there: ONE board.merge (${JSON.stringify(sent)})`)
  before = (await calls()).length
  await page.focus(cardSel('Breaks were too long'))
  await page.keyboard.press('Alt+Enter')
  await page.focus(`.bp-col[data-key="k:${columnIds[0]}"] .bp-col-name`)
  await page.keyboard.press('Alt+Enter')
  await waitCalls(before + 1)
  sent = await callsSince(before)
  pass(sent.length === 1 && sent[0].type === 'board.move' && sent[0].column === columnIds[0], `⌥↵ on a column name moves it there: ONE board.move (${JSON.stringify(sent)})`)
  before = (await calls()).length
  await page.focus(cardSel('A follow-up in a month would help'))
  await page.keyboard.press('Alt+Enter')
  await page.keyboard.press('Escape')
  await settle(page)
  pass(await page.locator('.bp-pickbar').count() === 0 && (await calls()).length === before, 'Esc puts a picked card down and sends nothing')
  await page.evaluate(() => document.activeElement?.blur())

  // ── 5. Freeze, Q, the Poll menu's Board group ───────────────────────────────────────────
  await page.click('#presenterMenuPoll')
  await settle(page)
  const menuItems = await page.evaluate(() => [...document.querySelectorAll('#presenterPollMenu .tw-mi')].filter((b) => b.getClientRects().length && !b.closest('[hidden]')).map((b) => b.id + (b.disabled ? ':off' : '')))
  pass(['pollMenuBoardClose', 'pollMenuBoardFreeze', 'pollMenuBoardFull', 'pollMenuBoardPopout'].every((id) => menuItems.includes(id)), `D19: the Poll menu has the Board group (${menuItems.join(', ')})`)
  pass(/Board · What should we keep, change, try\?/.test(await page.textContent('#pollMenuBoardSec')), 'D19: the group is named by the board\'s question')
  await shot(page, 'D19-poll-menu-board-1440x900.png')
  before = (await calls()).length
  await page.click('#pollMenuBoardFreeze')
  await waitCalls(before + 1)
  sent = await callsSince(before)
  pass(sent.length === 1 && sent[0].type === 'board.freeze' && sent[0].frozen === true, `D17: Freeze board is ONE board.freeze (${JSON.stringify(sent)})`)
  p = await panel()
  pass(/Frozen/.test(p.head) && /Unfreeze/.test(p.head), `D17: the header says Frozen and offers Unfreeze (${p.head})`)
  await shot(page, 'D17-frozen-1440x900.png')
  before = (await calls()).length
  await dragTo(cardSel('A follow-up in a month would help'), groupSel(1))
  await settle(page, 400)
  pass((await calls()).length === before, 'D17: a frozen board takes no drags')
  await page.click('#boardUnfreeze')
  await waitCalls(before + 1)
  sent = await callsSince(before)
  pass(sent.length === 1 && sent[0].type === 'board.freeze' && sent[0].frozen === false, 'Unfreeze is ONE board.freeze false')
  let ipcBefore = await ipcCount()
  before = (await calls()).length
  await page.keyboard.press('q')
  await settle(page)
  pass((await ipcSince(ipcBefore)).includes('live:poll-close') && (await calls()).length === before, 'Q closes the board to new cards (the poll\'s own close, no board operation)')
  reply = await worker.ask({ cmd: 'close' })
  await push(reply.state)
  p = await panel()
  pass(/Closed/.test(p.head) && /Reopen/.test(p.head), `D16: closed, the header offers Reopen (${p.head})`)
  await shot(page, 'D16-closed-1440x900.png')
  ipcBefore = await ipcCount()
  await page.click('#boardPrimary')
  await settle(page)
  pass((await ipcSince(ipcBefore)).includes('live:poll-open'), 'Reopen opens the board again (poll.open)')
  reply = await worker.ask({ cmd: 'open' })
  await push(reply.state)

  // ── 6. Full screen (D22) ─────────────────────────────────────────────────────────────────
  await page.click('#boardFullScreen')
  await settle(page, 600)
  p = await panel()
  const monitor = await page.evaluate(() => { const m = document.querySelector('.bp-monitor'); const f = m?.querySelector('iframe'); return { frame: !!f, width: Math.round(m?.getBoundingClientRect().width || 0) } })
  pass(p.mode === 'full' && p.box.width > 1300 && p.box.height > 700, `D22: full screen takes the window under the top bar (${Math.round(p.box.width)}x${Math.round(p.box.height)})`)
  pass(monitor.frame && monitor.width >= 360 && monitor.width <= 420, `D22: the slide shows as a monitor in the rail (${monitor.width}px)`)
  pass(/On the big screen now/.test(await page.textContent('.bp-rail')) && /Exit full screen/.test(p.head), 'D22: the rail holds the big screen and the inbox; the header offers Exit full screen')
  await shot(page, 'D22-full-screen-1440x900.png')
  await page.focus(cardSel('A follow-up in a month would help'))
  await page.keyboard.press('Escape')
  await settle(page)
  pass((await panel()).mode === 'beside', 'Esc in full screen comes back beside the slide')
  await page.evaluate(() => document.activeElement?.blur())

  // ── 7. Popped out (D23, D24) ─────────────────────────────────────────────────────────────
  const popupPromise = context.waitForEvent('page')
  await page.click('#boardPopOut')
  const popup = await popupPromise
  await popup.setViewportSize({ width: 1440, height: 900 }).catch(() => {})
  await settle(page, 600)
  const popped = await popup.evaluate(() => ({ panel: !!document.querySelector('#boardWindowPanel.bp:not([hidden])'), mode: document.querySelector('#boardWindowPanel')?.dataset.mode, title: document.title,
    head: (document.querySelector('.bp-head')?.textContent || '').replace(/\s+/g, ' ') }))
  pass(popped.panel && popped.mode === 'window', 'D23: the board opens in its own window')
  pass(popped.title === 'Board · What should we keep, change, try? · TalkWeaver', `D23: the window is named by the board (${popped.title})`)
  pass(/Put back in the presenter window/.test(popped.head), 'D23: the board window offers Put back in the presenter window')
  p = await panel()
  pass(!p.shown, 'D23: the presenter window is back to its own layout (panel closed; Next, Then and notes back)')
  pass(/own window/.test(p.chip || await page.textContent('#presenterBoardCount')), `D23: the status bar counter says "own window" (${await page.textContent('#presenterBoardCount')})`)
  if (SHOTS) { await popup.screenshot({ path: join(SHOTS, 'D23-board-window-1440x900.png') }); await shot(page, 'D23-presenter-window-1440x900.png') }
  before = (await calls()).length
  await dragTo(cardSel('A follow-up in a month would help'), groupSel(3), popup)
  try { await page.waitForFunction((n) => window.__boardCalls.length >= n, before + 1, { timeout: 3000 }) } catch {}
  await settle(page, 300)
  sent = await callsSince(before)
  pass(sent.length === 1 && sent[0].type === 'board.merge' && sent[0].target.group === 3, `D23: a drag in the board window is ONE operation through the presenter's live bridge (${JSON.stringify(sent)})`)
  await settle(popup, 200)
  pass((await popup.textContent('.bp-card.is-group[data-key="g:3"] .bp-x')) === '×5', 'D23: the board window shows the worker\'s answer (group 3 now ×5)')
  const closed = popup.waitForEvent('close', { timeout: 5000 }).catch(() => null)
  await popup.click('#boardPutBack')
  await closed
  await settle(page, 300)
  p = await panel()
  pass(popup.isClosed() && p.shown && p.mode === 'beside', 'D24: Put back closes the board window and the board returns beside the slide')
  const popup2Promise = context.waitForEvent('page')
  await page.click('#boardPopOut')
  const popup2 = await popup2Promise
  await settle(page, 400)
  await popup2.close({ runBeforeUnload: true })
  await settle(page, 500)
  p = await panel()
  pass(p.shown && p.mode === 'beside' && !/own window/.test(p.chip || ''), 'D24: closing the board window puts it back beside the slide')
  const popup3Promise = context.waitForEvent('page')
  await page.click('#presenterMenuPoll')
  await page.click('#pollMenuBoardPopout')
  const popup3 = await popup3Promise
  await settle(page, 400)
  await page.click('#presenterBoardCount')
  await settle(page, 500)
  pass(popup3.isClosed() && (await panel()).shown, 'D24: the status bar counter brings it back from its own window')

  // ── 8. Text only; Mark all sorted is the panel's own ─────────────────────────────────────
  before = (await calls()).length
  // Card text is text: a card that looks like markup stays words.
  reply = await worker.ask({ cmd: 'add', column: columnIds[0], text: '<img src=x onerror="document.title=\'pwned\'"> as text' })
  await push(reply.state)
  p = await panel()
  pass(p.images === 0 && p.inboxCards.includes('<img src=x onerror="document.title=\'pwned\'"> as text'), 'card text is written as text, never as markup')
  await page.evaluate(() => document.querySelector('#boardMarkSorted')?.click())
  await settle(page)
  p = await panel()
  pass(p.inboxCards.length === 0 && /Nothing new/.test(await page.textContent('.bp-inbox')), 'Mark all sorted empties the inbox here')
  pass((await calls()).length === before, 'Mark all sorted sends nothing to the worker (the inbox is the panel\'s own)')

  // ── 9. Review fixes: fast undo (S1), no drop on a hidden card (S3), ⌘Z is never the gallery (S4) ──
  reply = await worker.ask({ cmd: 'init', definition, scene: 'd1' })
  await page.evaluate(() => { for (const key of Object.keys(sessionStorage)) if (key.startsWith('tw-board-sorted:')) sessionStorage.removeItem(key) })
  await push(reply.state)
  await page.evaluate(() => { window.__holdStates = true })
  before = (await calls()).length
  await dragTo(cardSel('Pairs worked really well'), cardSel('Breaks were too long'))
  await waitCalls(before + 1)
  await page.keyboard.press('Meta+z')
  await settle(page)
  pass((await calls()).length === before + 1 && /Undoing…/.test((await panel()).toast), `S1: ⌘Z before the worker answers a merge of two singles waits, sending nothing yet (${(await panel()).toast})`)
  await page.evaluate(() => { window.__holdStates = false; for (const state of window.__held.splice(0)) window.__push('live:poll-state', state) })
  await waitCalls(before + 2)
  sent = await callsSince(before)
  pass(sent.length === 2 && sent[0].type === 'board.merge' && sent[1].type === 'board.split', `S1: once the answer comes, the undo is ONE board.split of the new group (${JSON.stringify(sent)})`)
  p = await panel()
  pass(p.columns.flatMap((c) => c.cards).filter((card) => /^\d+ (Pairs|Breaks)/.test(card)).length === 0, 'S1: the two cards are singles again')
  // S3: a hidden card is no keyboard drop target.
  reply = await worker.ask({ cmd: 'op', message: { type: 'board.hide', pollId: definition.pollId, target: { group: 4 }, hidden: true } })
  await push(reply.state)
  before = (await calls()).length
  await page.focus(cardSel('A follow-up in a month would help'))
  await page.keyboard.press('Alt+Enter')
  await page.focus(groupSel(4))
  await page.keyboard.press('Alt+Enter')
  await settle(page)
  pass((await calls()).length === before && await page.locator('.bp-pickbar').count() === 1, 'S3: ⌥↵ on a hidden group drops nothing; the card stays held')
  await page.keyboard.press('Escape')
  await page.evaluate(() => document.activeElement?.blur())
  // S4: ⌘Z with nothing to undo is consumed by the panel; beside no panel, ⌘Z is not the gallery's Z.
  await page.evaluate(() => { const fig = document.createElement('figure'); fig.className = 'slide-figure'; const img = document.createElement('img'); img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='; fig.append(img); for (const id of ['kct', 'before']) document.querySelector(`.slide[data-id="${id}"] .slide-content, .slide[data-id="${id}"]`).append(fig.cloneNode(true)) })
  await page.keyboard.press('Meta+z'); await settle(page)
  await page.keyboard.press('Meta+z'); await settle(page)
  const lightbox = () => page.evaluate(() => document.getElementById('lightbox')?.classList.contains('open'))
  pass(!(await lightbox()), 'S4: ⌘Z with the panel showing and nothing to undo never opens the gallery')
  await page.keyboard.press('ArrowLeft'); await settle(page, 400)
  pass(await page.evaluate(() => document.querySelector('.slide.active')?.dataset.id) === 'before' && !(await panel()).shown, 'S4: on a slide without the board the panel is gone')
  await page.keyboard.press('Meta+z'); await settle(page)
  pass(!(await lightbox()), 'S4: ⌘Z is not Z: the gallery stays shut')
  await page.keyboard.press('z'); await settle(page)
  pass(await lightbox(), 'S4: Z itself still opens the gallery')
  await page.keyboard.press('Escape'); await settle(page)
  await page.keyboard.press('ArrowRight'); await settle(page, 400)
  // S2 (D13): Edit the group's wording.
  reply = await worker.ask({ cmd: 'op', message: { type: 'board.hide', pollId: definition.pollId, target: { group: 4 }, hidden: false } })
  await push(reply.state)
  await page.click(groupSel(1))
  await settle(page)
  pass(/Edit the group’s wording\s*cards keep theirs/.test((await panel()).menu), `D13: the group menu offers Edit the group's wording (${(await panel()).menu})`)
  await page.click('#boardRelabel')
  await settle(page)
  const field = await page.evaluate(() => ({ focused: document.activeElement?.id === 'boardRelabelInput', value: document.getElementById('boardRelabelInput')?.value }))
  pass(field.focused && field.value === 'More time for hands-on', `D13: the wording field opens focused, holding the group's words (${JSON.stringify(field)})`)
  await shot(page, 'D13-edit-group-wording-1440x900.png')
  before = (await calls()).length
  await page.fill('#boardRelabelInput', 'Hands-on time <b>please</b>')
  await page.keyboard.press('Enter')
  await waitCalls(before + 1)
  sent = await callsSince(before)
  pass(sent.length === 1 && sent[0].type === 'board.relabel' && sent[0].group === 1 && sent[0].text === 'Hands-on time <b>please</b>', `D13: Save is ONE board.relabel (${JSON.stringify(sent)})`)
  p = await panel()
  pass(p.columns[0].cards[0] === '1 Hands-on time <b>please</b> ×3' && p.images === 0, `D13: the group reads its wording, as text (${p.columns[0].cards[0]})`)
  const screenText = await page.evaluate(() => [...document.querySelectorAll('.slide[data-id="kct"] .poll-frame, #currentPreview iframe')].map((node) => node.tagName === 'IFRAME' ? node.contentDocument?.querySelector('.poll-frame')?.textContent : node.textContent).join(' | '))
  pass(/Hands-on time <b>please<\/b>/.test(screenText), `D13: the room's view of the board (the presenter's current slide) shows the group's wording, as text (${screenText.slice(0, 160)})`)
  await shot(page, 'D13-group-wording-1440x900.png')
  before = (await calls()).length
  await page.click(groupSel(1)); await page.click('#boardRelabel'); await page.click('#boardRelabelClear')
  await waitCalls(before + 1)
  sent = await callsSince(before)
  pass(sent.length === 1 && sent[0].type === 'board.relabel' && sent[0].text === '', 'D13: "Use the first card\'s words" is ONE board.relabel with no text')
  pass((await panel()).columns[0].cards[0] === '1 More time for hands-on ×3', 'D13: the group reads its first card again')

  // At 1280x800 (D1 at 1280): the panel is 520 wide and nothing in its header or strip overflows.
  await page.setViewportSize({ width: 1280, height: 800 })
  await settle(page, 600)
  p = await panel()
  pass(p.shown && Math.abs(p.box.width - 520) <= 16 && !p.overSlide, `D1 at 1280x800: the panel is about 520 wide, beside the slide (${Math.round(p.box.width)})`)
  pass(p.overflow.length === 0, `D1 at 1280x800: no header or strip control runs outside the panel (${p.overflow.join(', ')})`)
  await shot(page, 'D1-board-panel-1280x800.png')
  pass(errors.length === 0, `no page errors (${errors.join(' | ')})`)
} catch (error) {
  failures.push(`harness: ${error?.stack || error}`)
} finally {
  await browser?.close()
  worker.stop()
  await rm(scratch, { recursive: true, force: true })
}

for (const line of passes) console.log(`  ok  ${line}`)
if (failures.length) {
  console.error(`\n${failures.length} board panel check(s) failed:`)
  for (const failure of failures) console.error(`  FAIL ${failure}`)
  process.exit(1)
}
console.log(`\nboard panel: ${passes.length} checks passed`)
