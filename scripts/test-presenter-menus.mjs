// Presenter top-bar menus: Live, Poll and View (ADR-0031 §2, presenter redesign ticket 04). The
// compiled presenter window in headless Chromium, with the recording preload (and through it the
// live bridge) bundled against a stub of electron and injected as the app injects it. Seams:
//  1. the menus themselves: three menu buttons (icon, label, chevron, tooltip naming the menu)
//     replace the old top-bar buttons; each menu opens by click and by keyboard, holds the drawn
//     sections and items (icon, label, the registry's shortcut right-aligned), shows items that do
//     not apply as disabled, and closes on Esc and on a press outside;
//  2. the presenter command registry the items call (PRESENTER_MENU_COMMANDS, and the old
//     buttons' own listeners): opening each menu and invoking each item runs the same command its
//     old button or key ran, compared per item on the state it changes (ipc calls, panels,
//     composers, the shared state, clipboard writes);
//  3. fit: at 1280x800 and 1440x900 in the L1 state each menu opens inside the window with no item
//     clipped; the bar reports that it fits with no label wrapping; at collapse step c8 the menu
//     buttons show icon and chevron only and still open their menus.
// Every check is collected and all failures are reported together.
// Usage: node scripts/test-presenter-menus.mjs
//   SHOTS=<dir> also saves L1 at 1280x800 and 1440x900 and each menu open (Live, Poll, View, the
//   Notes menu) at 1440x900. DECK=<compiled deck.html> uses that deck for the shots (the build
//   shots use the demo talk; SLIDE_L1 / SLIDE_POLL pick its slides); the checks always use the
//   fixture.
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
const { SHORTCUT_REGISTRY } = await import(new URL('../src/shared/shortcut-registry.ts', import.meta.url))
const { PRESENTER_CONTROLS, presenterControlKeys } = await import(new URL('../src/shared/presenter-controls.ts', import.meta.url))
const { OPEN_AUDIENCE_SCRIPT } = await import(new URL('../src/main/deck-window-keys.ts', import.meta.url))
const SHOTS = process.env.SHOTS ? resolve(process.env.SHOTS) : null
const keysOf = (id) => presenterControlKeys(PRESENTER_CONTROLS.find((c) => c.id === id), SHORTCUT_REGISTRY)
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// The drawn menus (surfaces-drawn.md, "Top bar menus"; shots menu-*-open-1440x900.png).
const MENUS = {
  presenterMenuLive: {
    name: 'Live menu', label: 'Live', sections: ['Session', 'On every screen'],
    items: [['liveGoButton', 'Go live'], ['presenterAudienceApp', 'Open audience window'], ['liveShowJoin', 'Show join link and venue screen'], ['liveCopyVenueLink', 'Copy venue-screen link'],
      ['liveTalkQr', 'Show talk QR code'], ['presenterInstantButton', 'Compose instant slide…'], ['liveInstantPaste', 'Instant slide from clipboard'], ['liveInstantBack', 'Back to slide']]
  },
  presenterMenuPoll: {
    name: 'Poll menu', label: 'Poll', sections: ['Quick poll', 'Current poll', 'Questions'],
    items: [['presenterQuickPollButton', 'Compose Quick poll…'], ['presenterQuickPollRestore', 'Show Quick poll on screens'], ['pollMenuPrimary', 'Open or close current poll'],
      ['pollMenuReveal', 'Reveal results'], ['presenterPollPanelToggle', 'Show poll panel'], ['pollMenuQuestions', 'Open questions']]
  },
  presenterMenuView: {
    name: 'View menu', label: 'View', sections: ['Layout', 'Slide on every screen'],
    items: [['notesPlacementBtn', 'Notes placement and scrolling…'], ['viewOutline', 'Outline'], ['viewFontDown', 'Smaller'], ['viewFontUp', 'Larger'], ['viewReveal', 'Reveal mode'], ['viewFocus', 'Focus mode'],
      ['viewHighlight', 'Highlight text'], ['viewHighlightClear', 'Clear highlights'], ['viewShortcuts', 'Keyboard shortcuts'], ['viewCommands', 'All commands…']]
  }
}
// Every action that had a top-bar button before this ticket, and where it is now.
const OLD_TOP_BAR = ['liveGoButton', 'presenterQuickPollButton', 'presenterInstantButton', 'presenterQuickPollRestore', 'presenterPollPanelToggle', 'notesPlacementBtn', 'presenterAudienceApp']

const FIXTURE = `---
title: The current state of AI agents
duration: 30min
auto_title_slide: false
auto_thanks_slide: false
---

## Where agents came from
{timer=10min}

### The evolution of agents {id=two}

- AI as oracle
- AI as tool maker
- AI as tool user

:::notes
Three stages, and the room will know the first two.
:::

### Have you let an agent work on your files? {id=poll poll=single pollresults=held}

- Yes
- No

### Wrap-up {id=three}

The end.
`

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-presenter-menus-'))
let browser
try {
  const sourcePath = join(scratch, 'menus.md')
  await writeFile(sourcePath, FIXTURE)
  const model = await prepareSource(sourcePath, FIXTURE, 'The current state of AI agents', statSync(sourcePath))
  const fixturePath = join(scratch, 'menus-present.html')
  await writeFile(fixturePath, model.fullHtml)
  // The recording preload as the app ships it (it mounts the live bridge); electron stubbed.
  // invoke() answers the channels the preloads call and logs [channel, first argument]; on() keeps
  // the handlers so the test can push live status and poll state; the clipboard is a fixture.
  const stubPath = join(scratch, 'electron-stub.mjs')
  await writeFile(stubPath, `const answers = {
  'recording:context': { testMode: true, talkSlug: 'menus', discardThresholdMs: 0 }, 'live:status': 'ended', 'live:snapshot': {},
  'live:go': { success: true, shortUrl: 'https://handouts.fyi/737u/live', qrSvg: '<svg data-test="join-qr"></svg>', status: 'connecting' },
  'live:end': { success: true, status: 'ended' },
  'live:poll-open': { success: true, status: 'confirmed' }, 'live:poll-close': { success: true, status: 'confirmed' }, 'live:poll-reveal': { success: true, status: 'confirmed' },
  'live:instant-action': { success: false, error: 'No live session.' }
}
window.__ipcCalls = []; window.__ipcArgs = []; window.__ipcOn = {}; window.__clipboardWrites = []; window.__clipboardText = ''
export const ipcRenderer = {
  invoke: async (channel, ...args) => { window.__ipcArgs.push([channel, args[0]]); window.__ipcCalls.push([channel, args[0] && typeof args[0] === 'object' ? (args[0].pollId || args[0].type || 'object') : args[0] ?? null]); return channel in answers ? answers[channel] : {} },
  on(channel, fn) { (window.__ipcOn[channel] ||= []).push(fn) }, send() {}, removeListener() {}
}
window.__push = (channel, value) => { for (const fn of window.__ipcOn[channel] || []) fn(null, value) }
export const contextBridge = { exposeInMainWorld: (name, api) => { window[name] = api } }
export const clipboard = { writeText(text) { window.__clipboardWrites.push(text) }, readText() { return window.__clipboardText }, readImage() { return { isEmpty: () => true } } }
`)
  const bundle = await build({ entryPoints: [join(repo, 'src/preload/present-recorder.ts')], bundle: true, write: false, format: 'iife', platform: 'browser', alias: { electron: stubPath }, logLevel: 'silent' })
  const preload = bundle.outputFiles[0].text
  const fixtures = `window.__opened = []; window.open = (url) => { window.__opened.push(String(url)); return null }
if (window === window.top && window.twLivePollBridge) window.twLivePollBridge.onAudience = (cb) => { window.__audience = cb }`

  browser = await chromium.launch({ headless: true })
  const open = async ([width, height], slide, htmlPath = fixturePath) => {
    const context = await browser.newContext({ viewport: { width, height } })
    // A missing control fails fast and is reported with the rest, rather than stalling the run.
    context.setDefaultTimeout(5000)
    await context.addInitScript({ content: `if (window === window.top) {\n${preload}\n${fixtures}\n}` })
    const page = await context.newPage()
    page.errors = []
    page.on('pageerror', (error) => page.errors.push(error.message))
    page.on('dialog', (dialog) => dialog.accept())
    await page.goto(`${pathToFileURL(htmlPath).href}?presenter=1${slide ? `#${slide}` : ''}`, { waitUntil: 'load', timeout: 120000 })
    await page.waitForFunction(() => /scale\(([\d.]+)\)/.test(document.querySelector('#currentPreview iframe')?.style.transform || ''), null, { timeout: 30000 })
    await page.waitForSelector('#presenterStatus #twrec-module', { timeout: 10000 }).catch(() => {})
    if (await page.isVisible('#twResume')) await page.click('#twResumeNo').catch(() => {})
    await page.mouse.move(5, 500)
    return { page, context }
  }
  const settle = (page, ms = 200) => page.waitForTimeout(ms)
  const tap = async (page, selector) => { try { await page.click(selector, { timeout: 2000 }) } catch { failures.push(`no control to click: ${selector}`) } }
  const hover = async (page, selector) => { try { await page.hover(selector, { timeout: 2000 }) } catch { failures.push(`no control to hover: ${selector}`) } }
  // A block that throws (a control the page does not have) is reported, and the run goes on.
  const guard = async (name, fn) => { try { await fn() } catch (error) { failures.push(`${name}: stopped: ${String(error.message).split('\n')[0]}`) } }
  // Open a menu by its button and press one of its items, the way a person does.
  const menuItem = async (page, menu, item) => {
    await tap(page, `#${menu}`)
    await tap(page, `#${item}`)
    await settle(page)
  }
  const goLive = async (page) => {
    await menuItem(page, 'presenterMenuLive', 'liveGoButton')
    await page.evaluate(() => window.__push('live:status', 'live'))
    await settle(page)
  }
  // What the commands change, read from the page.
  const probe = (page) => page.evaluate(() => {
    const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]')
    const byId = (id) => document.getElementById(id)
    const raw = Object.keys(localStorage).map((k) => localStorage.getItem(k)).find((v) => v && v.includes('"fontSize"'))
    const shared = raw ? JSON.parse(raw) : {}
    return {
      calls: window.__ipcCalls.filter(([c]) => c.startsWith('live:') && !['live:status', 'live:snapshot'].includes(c)).map((c) => c.join(' ')),
      joinPanel: shown(byId('liveGoPanel')), joinUrl: byId('liveShortUrl')?.textContent || '',
      opened: window.__opened.map((u) => (u.includes('audience=1') ? 'audience' : u)), clipboard: window.__clipboardWrites.slice(),
      talkQr: !!document.querySelector('.qr-fullscreen.talk-qr'),
      instantCompose: shown(byId('presenterInstantCompose')), instantPaste: shown(byId('presenterInstantPaste')), pasteValue: byId('instantPasteValue')?.textContent || '',
      instantStrip: shown(byId('presenterInstantStrip')),
      quickCompose: shown(byId('presenterQuickPollCompose')), pollPanel: shown(byId('presenterPollPanel')), quickDismiss: shown(byId('presenterQuickPollDismiss')),
      previewSize: byId('presenterRoot').dataset.previewSize || 'medium', outline: byId('presenterOutlineDrawer')?.classList.contains('open'),
      fontSize: shared.fontSize ?? 100, mode: shared.mode?.kind || null,
      highlightArmed: byId('presenterRoot').classList.contains('highlight-armed'), highlightClear: !byId('presenterHighlightClear')?.disabled,
      shortcuts: shown(byId('twShortcuts')), palette: shown(byId('presenterCommandPalette')),
      notesMenu: shown(byId('notesMenu')), placement: byId('presenterRoot').dataset.notesPlacement,
      openMenu: [...document.querySelectorAll('.tw-menu')].filter(shown).map((m) => m.id).join(',')
    }
  })
  const pick = (p, fields) => Object.fromEntries(fields.map((f) => [f, p[f]]))
  // One item against its old path: a fresh window each side, the same set-up, then the item (menu
  // open, item pressed) or the old key / button; the fields named must end up the same, and differ
  // from where they started.
  const compare = async (name, { slide = 'two', setup, oldSetup = setup, menu, item, old, fields }) => {
    const run = async (viaMenu) => {
      const { page, context } = await open([1440, 900], slide)
      try {
      const prepare = viaMenu ? setup : oldSetup
      if (prepare) await prepare(page)
      await settle(page)
      const before = pick(await probe(page), fields)
      let enabled = true
      if (viaMenu) {
        await tap(page, `#${menu}`); await settle(page, 120)
        enabled = await page.evaluate((id) => !document.getElementById(id)?.disabled, item)
        await tap(page, `#${item}`); await settle(page)
      } else { await old(page); await settle(page) }
      await settle(page, 250)
      const after = pick(await probe(page), fields)
      const errors = page.errors.slice()
      return { before, after, enabled, errors }
      } catch (error) {
        return { before: null, after: `stopped: ${String(error.message).split('\n')[0]}`, enabled: false, errors: [] }
      } finally { await context.close() }
    }
    const a = await run(true)
    const b = await run(false)
    check(a.enabled, `${name}: the item is enabled where its command applies`)
    check(!same(a.before, a.after), `${name}: the item does something (${JSON.stringify(a.after)})`)
    check(same(a.after, b.after), `${name}: the item runs the same command as before — item ${JSON.stringify(a.after)} · old ${JSON.stringify(b.after)}`)
    check(a.errors.length === 0 && b.errors.length === 0, `${name}: no page errors (${[...a.errors, ...b.errors].join('; ')})`)
  }

  // ── 1. The menus ──────────────────────────────────────────────────────────────────────────
  await guard('menus', async () => {
    const { page, context } = await open([1440, 900], 'two')
    const bar = await page.evaluate(() => {
      const shown = (el) => !!el && el.getClientRects().length > 0 && !el.closest('[hidden]')
      const right = document.querySelector('#presenterTopBar .presenter-header-actions')
      return {
        buttons: right ? [...right.querySelectorAll('button')].filter(shown).map((b) => b.id) : [],
        detail: [...document.querySelectorAll('.tw-menu-btn')].map((b) => ({
          id: b.id, label: b.querySelector('.tw-btn-label')?.textContent.trim(), tip: b.dataset.tip, popup: b.getAttribute('aria-haspopup'),
          icons: [...b.querySelectorAll(':scope > svg')].map((s) => [...s.classList].find((c) => c.startsWith('lucide-')))
        }))
      }
    })
    check(same(bar.buttons, Object.keys(MENUS)), `menus: the top bar's right side is the Live, Poll and View menu buttons only (${bar.buttons.join(', ')})`)
    for (const [id, spec] of Object.entries(MENUS)) {
      const b = bar.detail.find((d) => d.id === id)
      check(b && b.label === spec.label && b.tip === spec.name && b.popup === 'menu', `${id}: labelled "${spec.label}", named "${spec.name}" (${JSON.stringify(b)})`)
      check(b && b.icons.length === 2 && b.icons[1] === 'lucide-chevron-down', `${id}: icon and chevron (${b?.icons.join(' ')})`)
      await hover(page, `#${id}`); await settle(page, 120)
      const tip = await page.evaluate(() => document.querySelector('.tw-tip:not([hidden]) .tw-tip-name')?.textContent || null)
      check(tip === spec.name, `${id}: hovering names the menu (${tip})`)
      await page.mouse.move(5, 500)
    }
    for (const id of OLD_TOP_BAR) {
      const where = await page.evaluate((x) => document.getElementById(x)?.closest('.tw-menu, .notes-menu')?.id || null, id)
      check(!!where, `${id}: the old top-bar action is reachable from a menu (${where})`)
    }
    // Each menu: open by click, the drawn sections and items, icons, the registry's keys.
    for (const [id, spec] of Object.entries(MENUS)) {
      await tap(page, `#${id}`); await settle(page)
      const m = await page.evaluate((btn) => {
        const button = document.getElementById(btn)
        const menu = document.getElementById(button.getAttribute('aria-controls'))
        const shown = (el) => !!el && el.getClientRects().length > 0 && !el.closest('[hidden]')
        return {
          open: shown(menu), expanded: button.getAttribute('aria-expanded'), role: menu?.getAttribute('role'),
          others: [...document.querySelectorAll('.tw-menu')].filter((x) => x !== menu && shown(x)).map((x) => x.id),
          sections: [...menu.querySelectorAll('.tw-menu-sec')].map((s) => s.textContent.trim()),
          items: [...menu.querySelectorAll('.tw-mi, .tw-seg-btn')].map((item) => ({
            id: item.id, label: item.querySelector('.tw-btn-label')?.firstChild?.textContent.trim() || '',
            key: item.querySelector('.tw-mi-key')?.textContent ?? null, disabled: item.disabled,
            icon: [...(item.querySelector(':scope > svg')?.classList || [])].find((c) => c.startsWith('lucide-')) || null
          })),
          previews: [...menu.querySelectorAll('[data-preview-size-option]')].map((b) => `${b.textContent.trim()}${b.getAttribute('aria-pressed') === 'true' ? '*' : ''}`).join(' ')
        }
      }, id)
      check(m.open && m.expanded === 'true' && m.role === 'menu' && m.others.length === 0, `${id}: a click opens its menu, and only that one (${JSON.stringify({ open: m.open, expanded: m.expanded, others: m.others })})`)
      check(same(m.sections, spec.sections), `${id}: sections ${m.sections.join(' / ')}; drawn ${spec.sections.join(' / ')}`)
      check(same(m.items.map((i) => [i.id, i.label]), spec.items), `${id}: items in the drawn order (${m.items.map((i) => i.label).join(' · ')})`)
      for (const item of m.items) {
        const control = PRESENTER_CONTROLS.find((c) => c.id === item.id)
        check(!!control, `${item.id}: in the presenter control table`)
        if (!control) continue
        check(item.icon === `lucide-${control.icon}`, `${item.id}: lucide icon ${control.icon} (${item.icon})`)
        check(item.key === keysOf(item.id), `${item.id}: shows the registry's key "${keysOf(item.id)}" (${item.key})`)
      }
      if (id === 'presenterMenuView') check(m.previews === 'Large Medium* Small Off', `View: Previews row Large / Medium / Small / Off, the current one pressed (${m.previews})`)
      if (id === 'presenterMenuLive') {
        const dis = Object.fromEntries(m.items.map((i) => [i.id, i.disabled]))
        check(dis.liveShowJoin && dis.liveCopyVenueLink && dis.liveInstantBack && !dis.liveGoButton, `Live: before a session, join link, venue link and Back to slide are disabled (${JSON.stringify(dis)})`)
      }
      if (id === 'presenterMenuPoll') {
        const dis = Object.fromEntries(m.items.map((i) => [i.id, i.disabled]))
        check(dis.pollMenuPrimary && dis.pollMenuReveal && dis.presenterPollPanelToggle && dis.presenterQuickPollRestore && !dis.presenterQuickPollButton, `Poll: off a poll slide, only Compose Quick poll is enabled (${JSON.stringify(dis)})`)
        const sub = await page.textContent('#pollMenuQuestionsSub')
        check(sub === 'While live', `Poll: Open questions says "While live" before a session (${sub})`)
      }
      // Esc closes it; so does a press outside; a second click on the button closes it too.
      await page.keyboard.press('Escape'); await settle(page, 120)
      check((await probe(page)).openMenu === '', `${id}: Esc closes the menu`)
      await tap(page, `#${id}`); await page.mouse.click(700, 500); await settle(page, 120)
      check((await probe(page)).openMenu === '', `${id}: a press outside closes the menu`)
      await tap(page, `#${id}`); await tap(page, `#${id}`); await settle(page, 120)
      check((await probe(page)).openMenu === '', `${id}: a second click on the button closes the menu`)
    }
    // Keyboard: focus a menu button, Enter opens on the first item; ↓ moves; ← → switch menus;
    // Esc closes and gives focus back; arrows never move the slide while a menu is open.
    const count = () => page.textContent('#presenterCount')
    const before = await count()
    await page.focus('#presenterMenuPoll')
    await page.keyboard.press('Enter'); await settle(page, 120)
    let k = await page.evaluate(() => ({ open: document.getElementById('presenterPollMenu').hidden === false, focus: document.activeElement?.id }))
    check(k.open && k.focus === 'presenterQuickPollButton', `keyboard: Enter on Poll opens it on its first enabled item (${JSON.stringify(k)})`)
    await page.keyboard.press('ArrowDown'); await settle(page, 60)
    k = await page.evaluate(() => ({ focus: document.activeElement?.id }))
    check(k.focus === 'presenterQuickPollButton', `keyboard: ↓ wraps over disabled items (${k.focus})`)
    await page.keyboard.press('ArrowRight'); await settle(page, 120)
    k = await page.evaluate(() => ({ view: document.getElementById('presenterViewMenu').hidden === false, poll: document.getElementById('presenterPollMenu').hidden === false, focus: document.activeElement?.id }))
    check(k.view && !k.poll, `keyboard: → moves to the View menu (${JSON.stringify(k)})`)
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await settle(page, 60)
    k = await page.evaluate(() => ({ focus: document.activeElement?.id }))
    check(k.focus === 'viewOutline' || k.focus === 'notesPlacementBtn' || k.focus === 'viewFontDown', `keyboard: ↓ moves through View's items (${k.focus})`)
    await page.keyboard.press('Escape'); await settle(page, 120)
    k = await page.evaluate(() => ({ open: [...document.querySelectorAll('.tw-menu')].some((m) => !m.hidden), focus: document.activeElement?.id }))
    check(!k.open && k.focus === 'presenterMenuView', `keyboard: Esc closes and focus returns to the menu button (${JSON.stringify(k)})`)
    check(await count() === before, `keyboard: arrows in a menu do not move the slide (${before} → ${await count()})`)
    await page.keyboard.press('ArrowDown'); await settle(page, 120)
    k = await page.evaluate(() => ({ focus: document.activeElement?.dataset.previewSizeOption || document.activeElement?.id }))
    check(k.focus === 'medium', `keyboard: View opens on its Previews row, the current size focused (${k.focus})`)
    await page.keyboard.press('ArrowRight'); await settle(page, 60)
    k = await page.evaluate(() => ({ focus: document.activeElement?.dataset.previewSizeOption || document.activeElement?.id }))
    check(k.focus === 'small', `keyboard: → moves within the Previews row (${k.focus})`)
    await page.keyboard.press('ArrowDown'); await settle(page, 60)
    await page.keyboard.press('Enter'); await settle(page, 200)
    k = await page.evaluate(() => ({ notes: document.getElementById('notesMenu').hidden === false, view: document.getElementById('presenterViewMenu').hidden === false }))
    check(k.notes && !k.view, `keyboard: Enter on an item runs it (Notes placement opens the Notes menu) (${JSON.stringify(k)})`)
    await page.keyboard.press('Escape'); await settle(page, 120)
    // A mouse press never leaves focus on a menu button (Space would then open it, not advance).
    await tap(page, '#presenterMenuLive'); await page.keyboard.press('Escape'); await settle(page, 100)
    const focusAfterMouse = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName)
    check(focusAfterMouse !== 'presenterMenuLive', `mouse: a click does not leave focus on the menu button (${focusAfterMouse})`)
    // The Notes menu opens from View, under it, with View pressed; its item says what is set.
    await menuItem(page, 'presenterMenuView', 'notesPlacementBtn')
    let n = await page.evaluate(() => ({ open: document.getElementById('notesMenu').hidden === false, view: document.getElementById('presenterMenuView').getAttribute('aria-expanded'), inView: !!document.getElementById('notesMenu').closest('.tw-menu-anchor')?.querySelector('#presenterMenuView') }))
    check(n.open && n.view === 'true' && n.inView, `notes: "Notes placement and scrolling…" opens the Notes menu under View (${JSON.stringify(n)})`)
    await tap(page, '[data-notes-placement-option="sidebar"]'); await settle(page)
    await tap(page, '#presenterMenuView'); await settle(page, 120)
    n = await page.evaluate(() => ({ notes: document.getElementById('notesMenu').hidden === false, view: document.getElementById('presenterViewMenu').hidden === false }))
    check(!n.notes && !n.view, `notes: View closes the Notes menu while it is open (${JSON.stringify(n)})`)
    await tap(page, '#presenterMenuView'); await settle(page, 120)
    const now = await page.textContent('#notesPlacementNow')
    check(now === 'Now: sidebar, by hand', `notes: the View item says where the notes are ("${now}")`)
    await page.keyboard.press('Escape')
    // Previews: the row sets the size and keeps the menu open; [ still cycles it.
    await tap(page, '#presenterMenuView'); await tap(page, '[data-preview-size-option="small"]'); await settle(page)
    let p = await probe(page)
    check(p.previewSize === 'small' && p.openMenu === 'presenterViewMenu', `previews: Small sets the size and the menu stays open (${p.previewSize}, ${p.openMenu})`)
    await page.keyboard.press('Escape'); await page.keyboard.press('['); await settle(page)
    p = await probe(page)
    check(p.previewSize === 'off', `previews: [ still cycles the size (${p.previewSize})`)
    check(page.errors.length === 0, `menus: no page errors (${page.errors.join('; ')})`)
    await context.close()
  })

  // ── 2. Each item runs the same command as before ──────────────────────────────────────────
  // Live menu
  await compare('Go live', { menu: 'presenterMenuLive', item: 'liveGoButton', old: (p) => p.keyboard.press('g'), fields: ['calls', 'joinPanel', 'joinUrl'] })
  await compare('End live session', {
    setup: async (p) => { await goLive(p); await p.keyboard.press('Escape') },
    menu: 'presenterMenuLive', item: 'liveGoButton', old: (p) => p.keyboard.press('g'), fields: ['calls']
  })
  await guard('End live session item', async () => {
    const { page, context } = await open([1440, 900], 'two')
    await goLive(page)
    const item = await page.evaluate(() => { const b = document.getElementById('liveGoButton'); return { label: b.querySelector('.tw-btn-label')?.textContent, tip: b.dataset.tip, icon: [...b.querySelector('svg').classList].find((c) => c.startsWith('lucide-')), danger: b.classList.contains('is-danger'), hidden: b.hidden } })
    check(item.label === 'End live session' && item.tip === 'End live session' && item.icon === 'lucide-radio-off' && item.danger && !item.hidden, `Live: while live the session item is End live session, radio-off, in red (${JSON.stringify(item)})`)
    await context.close()
  })
  await compare('Open audience window', { menu: 'presenterMenuLive', item: 'presenterAudienceApp', old: (p) => p.keyboard.press('F5'), fields: ['opened'] })
  await compare('Open audience window (the main process F5 script)', { menu: 'presenterMenuLive', item: 'presenterAudienceApp', old: (p) => p.evaluate(OPEN_AUDIENCE_SCRIPT), fields: ['opened'] })
  await compare('Show join link and venue screen', {
    setup: async (p) => { await goLive(p); await p.keyboard.press('Escape') },
    // Before this ticket the join link showed only when going live: compare with that.
    oldSetup: null, menu: 'presenterMenuLive', item: 'liveShowJoin', old: (p) => goLive(p), fields: ['joinPanel', 'joinUrl']
  })
  await compare('Copy venue-screen link', {
    setup: async (p) => { await goLive(p); await p.keyboard.press('Escape') },
    menu: 'presenterMenuLive', item: 'liveCopyVenueLink', old: async (p) => { await p.evaluate(() => { document.getElementById('liveGoPanel').hidden = false }); await p.click('#liveVenueCopy') }, fields: ['clipboard']
  })
  await compare('Show talk QR code', { setup: (p) => goLive(p).then(() => p.keyboard.press('Escape')), menu: 'presenterMenuLive', item: 'liveTalkQr', old: (p) => p.keyboard.press('u'), fields: ['talkQr'] })
  await compare('Compose instant slide', { menu: 'presenterMenuLive', item: 'presenterInstantButton', old: (p) => p.keyboard.press('Meta+Alt+KeyI'), fields: ['instantCompose'] })
  await compare('Instant slide from clipboard', {
    setup: (p) => p.evaluate(() => { window.__clipboardText = 'https://example.org/agents' }),
    menu: 'presenterMenuLive', item: 'liveInstantPaste',
    old: (p) => p.evaluate(() => { const data = new DataTransfer(); data.setData('text/plain', window.__clipboardText); window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data })) }),
    fields: ['instantPaste', 'pasteValue']
  })
  const showInstant = async (p) => {
    await menuItem(p, 'presenterMenuLive', 'presenterInstantButton')
    await p.fill('#instantText', 'Back in five minutes')
    await p.click('#instantShow'); await settle(p, 300)
  }
  await compare('Back to slide', { setup: showInstant, menu: 'presenterMenuLive', item: 'liveInstantBack', old: (p) => p.keyboard.press('ArrowRight'), fields: ['instantStrip'] })
  // Poll menu
  await compare('Compose Quick poll', { menu: 'presenterMenuPoll', item: 'presenterQuickPollButton', old: (p) => p.keyboard.press('k'), fields: ['quickCompose'] })
  await compare('Open or close current poll', { slide: 'poll', menu: 'presenterMenuPoll', item: 'pollMenuPrimary', old: (p) => p.keyboard.press('q'), fields: ['calls'] })
  const heldCollecting = (p) => p.evaluate(() => {
    const def = JSON.parse(document.querySelector('.slide[data-id="poll"]').dataset.poll)
    window.__push('live:poll-state', { ...def, type: 'poll.state', pollType: def.type, visibility: 'held', open: true, revealed: false, tallies: {} })
  })
  await compare('Reveal results', { slide: 'poll', setup: heldCollecting, menu: 'presenterMenuPoll', item: 'pollMenuReveal', old: (p) => p.keyboard.press('Shift+Q'), fields: ['calls'] })
  await compare('Show poll panel', { slide: 'poll', setup: (p) => p.click('#presenterPollDismiss'), menu: 'presenterMenuPoll', item: 'presenterPollPanelToggle', old: (p) => p.evaluate(() => document.getElementById('presenterPollPanelToggle').click()), fields: ['pollPanel'] })
  const quickPollDismissed = async (p) => {
    await menuItem(p, 'presenterMenuPoll', 'presenterQuickPollButton')
    await p.click('[data-quick-poll-preset="Yes|No"]')
    await p.fill('#quickPollQuestion', 'Should we try this together?')
    await p.click('#quickPollOpen'); await settle(p)
    // The live service reports the Quick poll the presenter opened (the definition it sent); then
    // the presenter dismisses it from the screens.
    await p.evaluate(() => {
      const def = window.__ipcArgs.filter(([c]) => c === 'live:poll-open').at(-1)?.[1]
      if (def) window.__push('live:poll-state', { ...def, type: 'poll.state', pollType: def.type, open: true, revealed: true, tallies: {} })
    })
    await settle(p)
    await tap(p, '#presenterQuickPollDismiss')
    await settle(p)
  }
  await compare('Show Quick poll on screens', { setup: quickPollDismissed, menu: 'presenterMenuPoll', item: 'presenterQuickPollRestore', old: (p) => p.evaluate(() => document.getElementById('presenterQuickPollRestore').click()), fields: ['pollPanel', 'quickDismiss'] })
  await guard('Open questions', async () => {
    const { page, context } = await open([1440, 900], 'two')
    await goLive(page)
    await page.evaluate(() => window.__audience?.({ reactions: null, questions: 3 }))
    await tap(page, '#presenterMenuPoll'); await settle(page)
    const q = await page.evaluate(() => ({ sub: document.getElementById('pollMenuQuestionsSub').textContent, disabled: document.getElementById('pollMenuQuestions').disabled }))
    check(q.sub === '3 waiting' && q.disabled, `Poll: while live Open questions shows "3 waiting" (disabled: no questions tray yet) (${JSON.stringify(q)})`)
    await context.close()
  })
  // View menu
  await compare('Outline', { menu: 'presenterMenuView', item: 'viewOutline', old: (p) => p.keyboard.press('o'), fields: ['outline'] })
  await compare('Slide text smaller', { menu: 'presenterMenuView', item: 'viewFontDown', old: (p) => p.keyboard.press('-'), fields: ['fontSize'] })
  await compare('Slide text larger', { menu: 'presenterMenuView', item: 'viewFontUp', old: (p) => p.keyboard.press('+'), fields: ['fontSize'] })
  await compare('Reveal mode', { menu: 'presenterMenuView', item: 'viewReveal', old: (p) => p.keyboard.press('r'), fields: ['mode'] })
  await compare('Focus mode', { menu: 'presenterMenuView', item: 'viewFocus', old: (p) => p.keyboard.press('f'), fields: ['mode'] })
  await compare('Highlight text', { menu: 'presenterMenuView', item: 'viewHighlight', old: (p) => p.keyboard.press('h'), fields: ['highlightArmed'] })
  const highlightSomething = async (p) => {
    await p.keyboard.press('h'); await settle(p)
    await p.evaluate(() => {
      const frame = document.querySelector('#currentPreview iframe')
      const doc = frame.contentDocument
      const li = doc.querySelector('.slide li')
      const range = doc.createRange(); range.selectNodeContents(li)
      const sel = frame.contentWindow.getSelection(); sel.removeAllRanges(); sel.addRange(range)
      doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await settle(p, 300)
    await p.keyboard.press('h')
  }
  await compare('Clear highlights', { setup: highlightSomething, menu: 'presenterMenuView', item: 'viewHighlightClear', old: async (p) => { await p.click('#presenterMore'); await p.click('#presenterHighlightClear') }, fields: ['highlightClear'] })
  await compare('Keyboard shortcuts', { menu: 'presenterMenuView', item: 'viewShortcuts', old: (p) => p.keyboard.press('?'), fields: ['shortcuts'] })
  await compare('All commands', { menu: 'presenterMenuView', item: 'viewCommands', old: (p) => p.keyboard.press('Meta+Shift+P'), fields: ['palette'] })
  await compare('Notes placement and scrolling', { menu: 'presenterMenuView', item: 'notesPlacementBtn', old: (p) => p.evaluate(() => document.getElementById('notesPlacementBtn').click()), fields: ['notesMenu'] })

  // ── 3. Fit at 1280x800 and 1440x900, and c8 ───────────────────────────────────────────────
  const L1 = async (page) => {
    await page.evaluate(() => {
      const deck = (Object.keys(sessionStorage).find((x) => x.endsWith(':session')) || '').replace(/:session$/, '')
      sessionStorage.setItem(`${deck}:timer`, JSON.stringify({ targetSeconds: 1800, elapsedMs: 942000, runningSince: Date.now(), reminders: [5, 1] }))
    })
    await page.reload({ waitUntil: 'load' })
    await page.waitForFunction(() => /scale\(([\d.]+)\)/.test(document.querySelector('#currentPreview iframe')?.style.transform || ''), null, { timeout: 30000 })
    await page.waitForSelector('#presenterStatus #twrec-module', { timeout: 10000 }).catch(() => {})
    await page.click('#twrec-primary').catch(() => {})
    await page.waitForFunction(() => document.getElementById('twrec-module')?.dataset.rec === 'recording', null, { timeout: 5000 }).catch(() => {})
    await goLive(page)
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.__audience?.({ reactions: { puzzled: 2, helped: 5, bookmark: 1 }, questions: 3 }))
    await page.mouse.move(5, 500)
    await settle(page, 500)
  }
  const fit = () => {
    const bar = document.getElementById('presenterTopBar')
    const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]')
    const openMenu = [...document.querySelectorAll('.tw-menu, .notes-menu')].find(shown)
    const box = openMenu?.getBoundingClientRect()
    const clipped = openMenu ? [...openMenu.querySelectorAll('button, .tw-btn-label, .tw-mi-key, .tw-menu-sec, b, i')].filter(shown).filter((el) => {
      const r = el.getBoundingClientRect()
      return el.scrollWidth > el.clientWidth + 1 || r.right > box.right + 0.5 || r.left < box.left - 0.5
    }).map((el) => el.id || el.textContent.trim().slice(0, 24)) : []
    const barText = [...bar.querySelectorAll('.tw-menu-btn .tw-btn-label')].filter(shown)
    const wrapped = barText.filter((el) => { const r = document.createRange(); r.selectNodeContents(el); return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size > 1 }).map((el) => el.textContent)
    return {
      menu: openMenu?.id || null, inWindow: !!box && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
      rect: box ? [Math.round(box.left), Math.round(box.top), Math.round(box.right), Math.round(box.bottom)] : null, clipped, wrapped,
      fits: bar.dataset.fits, collapse: bar.dataset.collapse || '',
      labels: [...bar.querySelectorAll('.tw-menu-btn')].map((b) => shown(b.querySelector('.tw-btn-label')))
    }
  }
  for (const size of [[1280, 800], [1440, 900]]) await guard(`fit ${size.join('x')}`, async () => {
    const { page, context } = await open(size, 'two')
    await L1(page)
    const name = `L1 ${size.join('x')}`
    for (const [menu, item] of [['presenterMenuLive'], ['presenterMenuPoll'], ['presenterMenuView'], ['presenterMenuView', 'notesPlacementBtn']]) {
      await tap(page, `#${menu}`)
      if (item) await tap(page, `#${item}`)
      await settle(page, 200)
      const f = await page.evaluate(fit)
      check(f.inWindow, `${name} ${item || menu}: the menu opens inside the window (${JSON.stringify(f.rect)})`)
      check(f.clipped.length === 0, `${name} ${item || menu}: nothing in the menu clips (${f.clipped.join(', ')})`)
      check(f.fits === 'true' && f.wrapped.length === 0, `${name}: the bar fits with no menu label wrapping (${f.fits}, ${f.collapse}; ${f.wrapped.join(', ')})`)
      await page.keyboard.press('Escape'); await settle(page, 100)
    }
    check(page.errors.length === 0, `${name}: no page errors (${page.errors.join('; ')})`)
    await context.close()
  })
  await guard('c8', async () => {
    // c8: narrow until the menu buttons go icon-only; they keep their names and still open.
    const { page, context } = await open([1280, 800], 'two')
    await L1(page)
    let f = null
    for (const width of [1200, 1140, 1100, 1060]) {
      await page.setViewportSize({ width, height: 800 }); await settle(page, 300)
      f = await page.evaluate(fit)
      if (f.collapse.split(' ').includes('c8')) break
    }
    check(f.collapse.split(' ').includes('c8'), `c8: narrowing reaches c8 (${f.collapse})`)
    check(f.labels.every((x) => !x), `c8: Live, Poll and View show icon and chevron only (${JSON.stringify(f.labels)})`)
    check(f.fits === 'true', `c8: the bar fits (${f.fits}; ${f.collapse})`)
    await tap(page, '#presenterMenuView'); await settle(page, 200)
    const g = await page.evaluate(fit)
    check(g.menu === 'presenterViewMenu' && g.inWindow && g.clipped.length === 0, `c8: View still opens inside the window (${JSON.stringify(g.rect)}; ${g.clipped.join(', ')})`)
    await page.keyboard.press('Escape')
    await hover(page, '#presenterMenuPoll'); await settle(page, 120)
    const tip = await page.evaluate(() => document.querySelector('.tw-tip:not([hidden]) .tw-tip-name')?.textContent || null)
    check(tip === 'Poll menu', `c8: the tooltip names the menu (${tip})`)
    await context.close()
  })

  // ── Build shots ───────────────────────────────────────────────────────────────────────────
  if (SHOTS) {
    await mkdir(SHOTS, { recursive: true })
    const deck = process.env.DECK ? resolve(process.env.DECK) : fixturePath
    const slideL1 = process.env.SLIDE_L1 || 'two'
    const slidePoll = process.env.SLIDE_POLL || 'poll'
    for (const size of [[1280, 800], [1440, 900]]) {
      const { page, context } = await open(size, slideL1, deck)
      await L1(page)
      await page.screenshot({ path: join(SHOTS, `L1-${size[0]}x${size[1]}.png`) })
      if (size[0] === 1440) {
        for (const [menu, file, item] of [['presenterMenuLive', 'menu-live-open'], ['presenterMenuView', 'menu-view-open'], ['presenterMenuView', 'notes-menu', 'notesPlacementBtn']]) {
          await tap(page, `#${menu}`)
          if (item) await tap(page, `#${item}`)
          // The Notes menu as drawn: camera column, automatic scroll (Scroll and Speed show).
          if (item === 'notesPlacementBtn') { await tap(page, '[data-notes-placement-option="camera-column"]'); await tap(page, '[data-notes-scroll-option="auto"]') }
          await page.mouse.move(5, 500); await settle(page, 400)
          await page.screenshot({ path: join(SHOTS, `${file}-1440x900.png`) })
          await page.keyboard.press('Escape'); await settle(page, 100)
          if (item === 'notesPlacementBtn') { await tap(page, '#presenterMenuView'); await tap(page, '#notesPlacementBtn'); await tap(page, '[data-notes-scroll-option="hand"]'); await tap(page, '[data-notes-placement-option="bottom"]'); await page.keyboard.press('Escape'); await settle(page, 300) }
        }
        // A deck without an authored poll gets a stand-in on SLIDE_POLL (as the round-2 drawing
        // staged it): the runtime reads the slide's data-poll attribute.
        await page.evaluate((id) => {
          const slide = document.querySelector(`.slide[data-id="${id}"]`)
          if (slide && !slide.dataset.poll) slide.dataset.poll = JSON.stringify({ pollId: `${id}-poll`, type: 'single', question: 'Have you let an AI agent work on your files this month?', options: [{ optionId: 'a', label: 'Yes' }, { optionId: 'b', label: 'No' }, { optionId: 'c', label: 'Not sure' }], visibility: 'held' })
          location.hash = id
        }, slidePoll)
        await settle(page, 800)
        await tap(page, '#presenterPollDismiss')
        await tap(page, '#presenterMenuPoll'); await page.mouse.move(5, 500); await settle(page, 250)
        await page.screenshot({ path: join(SHOTS, 'menu-poll-open-1440x900.png') })
      }
      await context.close()
    }
  }

  assert.deepEqual(failures, [], `presenter menus:\n  ${failures.join('\n  ')}`)
  console.log(`presenter menus: Live / Poll / View replace the top-bar buttons; ${Object.values(MENUS).reduce((n, m) => n + m.items.length, 0)} items with icon, label and registry key; open by click and keyboard, close on Esc / outside; each item runs the same command as its old button or key; menus fit at 1280x800 and 1440x900 in L1; c8 icon-only`)
} finally {
  await browser?.close()
  await rm(scratch, { recursive: true, force: true })
}
