// The presenter's command palette and its key lists (ADR-0031 §6, presenter redesign ticket 07;
// drawn in the round-2 presenter redesign drawings, shot palette-open-1440x900.png).
// The compiled presenter window in headless Chromium, with the recording preload (and through it
// the live and edit bridges) bundled against a stub of electron and injected as the app injects
// it. Seams:
//  1. the palette lists commands: ⌘⇧P opens it with every entry of src/shared/presenter-palette.ts
//     in its eight groups, each row with its lucide icon, its name and its current key (the
//     shortcut registry's text); "63 commands"; typing filters by words; ↑ ↓ skip rows that do not
//     apply, ↵ runs, Esc closes; keys typed in the search field stay there;
//  2. coverage: every control in the top bar (status bar, menus, the Notes menu, the REC cluster)
//     and the bottom bar (with the More menu and the edit pencil) that runs a command is an entry's
//     control, and every presenter key in the registry is an entry's key, except the few named
//     below with their reason;
//  3. invoking an entry runs the same command as its control or key: a fresh window each side,
//     the entry pressed in the palette against the key pressed, compared on the state it changes;
//  4. the ? sheet lists only keys that work here: no N or C; ⇧F5 (refresh) and ↵ (next); the
//     recording, editor and live keys (G, Q, ⇧Q, K) while their preloads are mounted, and not in a
//     presenter window opened without them, where their palette rows are dimmed (ticket 08).
// Every check is collected and all failures are reported together.
// Usage: node scripts/test-presenter-palette.mjs
//   SHOTS=<dir> also saves, at 1440x900, the palette open (top and scrolled), filtered by "poll",
//   the ? sheet and the outline open. DECK=<compiled deck.html> uses that deck for the shots (the
//   build shots use the demo talk; SLIDE picks its slide); the checks always use the fixture.
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
const { PRESENTER_PALETTE, presenterPaletteEntries, presenterPaletteKeys } = await import(new URL('../src/shared/presenter-palette.ts', import.meta.url))
const SHOTS = process.env.SHOTS ? resolve(process.env.SHOTS) : null
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const ENTRIES = presenterPaletteEntries()

// The drawing: 56 commands in eight groups, and the two Live-menu switches the reactions design added (Allow slide questions, Allow slide reactions): 58;
// and the Poll menu's Board group (feedback-boards ticket 05, round-2 D19): close or reopen, freeze, panel, full screen, pop out: 63.
const GROUPS = ['Slides', 'Timer', 'Recording', 'Live', 'Poll and questions', 'View', 'Slide on every screen', 'Editor and help']
// Presenter keys that are not palette commands.
const KEYS_NOT_IN_PALETTE = {
  'presenter.rebind': 'records the highlighted command in the palette',
  'presenter.close': 'Esc closes whatever is open; it is not a command of its own',
  'presenter.command-palette': 'opens the palette itself',
  'presenter.save-run': '↵ acts only while the save offer shows, on that toast; Save run as… is the command',
  'presenter.board-pick': '⌥↵ acts on the board card that has focus in the board panel; it is the keyboard\'s drag, not a command of its own',
  'presenter.board-undo': '⌘Z undoes the board panel\'s last change while the panel shows (its toast\'s Undo button); there is nothing to run without one'
}
// Controls in the bars that are not palette commands.
const CONTROLS_NOT_IN_PALETTE = {
  '#presenterMenuLive': 'opens the Live menu (its items are entries)',
  '#presenterMenuPoll': 'opens the Poll menu (its items are entries)',
  '#presenterMenuView': 'opens the View menu (its items are entries)',
  '#presenterMore': 'opens the More menu (its items are entries)',
  '#viewCommands': 'opens the palette itself',
  '#notesPlacementBtn': 'opens the Notes menu (its placements and scrolling are entries)',
  '#twDurationMinus': 'a field of the talk-length popover (Talk length and reminders… is the entry)',
  '#twDurationPlus': 'a field of the talk-length popover',
  '[data-minutes]': 'a preset of the talk-length popover',
  '[data-remind]': 'a reminder chip of the talk-length popover',
  '[data-preview-size-option]': 'the Previews row sets a size; the palette steps it, as [ and ] do',
  '#presenterModeExit': 'leaves the mode on: the mode\'s own entry, or Esc',
  '#presenterPointerExit': 'leaves Pointer: Pointer, or Esc',
  '#presenterPenExit': 'leaves the Pen: Pen, or Esc',
  '#presenterHighlightExit': 'leaves highlighting: Highlight text, or Esc',
  '#twrec-keep': 'answers the short-recording question on the cluster',
  '#twrec-discard': 'answers the short-recording question on the cluster',
  '#twrec-export': 'answers the failed-save question on the cluster (beside Retry save and Discard)'
}

const LONG_NOTE = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} of a long stand-in note, long enough that the notes panel has to scroll to show the rest of it to the presenter.`).join('\n\n')
const FIXTURE = `---
title: The current state of AI agents
duration: 30min
auto_title_slide: false
auto_thanks_slide: false
---

## Where agents came from

### The evolution of agents {id=two}

- AI as oracle
- AI as tool maker
- AI as tool user

:::notes
${LONG_NOTE}
:::

### Have you let an agent work on your files? {id=poll poll=single pollresults=held}

- Yes
- No

### What makes an agent useful? {id=three}

- It finds the form

### Wrap-up {id=four}

The end.
`

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-presenter-palette-'))
let browser
try {
  // ── Static: the table against the registry ──────────────────────────────────────────────────
  check(same(PRESENTER_PALETTE.map(([g]) => g), GROUPS), `palette groups are the drawn eight (${PRESENTER_PALETTE.map(([g]) => g).join(', ')})`)
  check(ENTRIES.length === 73, `the palette has the drawn 56 commands, the two phone switches, the five board commands, Pointer, Embedded page: full screen and the Pen's eight (ticket 08), 73 (${ENTRIES.length})`)
  check(new Set(ENTRIES.map((e) => e.id)).size === ENTRIES.length, 'palette ids are unique')
  const presenterKeys = SHORTCUT_REGISTRY.filter((e) => e.scope === 'presenter')
  for (const entry of presenterKeys) {
    if (KEYS_NOT_IN_PALETTE[entry.id]) continue
    check(ENTRIES.some((e) => e.shortcut === entry.id), `presenter key ${entry.keys} (${entry.id}, "${entry.label}") is listed in the palette`)
  }
  for (const entry of ENTRIES) {
    if (entry.shortcut) check(presenterKeys.some((k) => k.id === entry.shortcut), `${entry.id}: its key is a presenter key in the registry (${entry.shortcut})`)
    check(entry.controls?.length || ['previews-larger', 'previews-smaller', 'notes-forward', 'notes-back', 'pen-next-tool'].includes(entry.id), `${entry.id}: it runs through a control, its key, or the template's run map`)
  }

  const sourcePath = join(scratch, 'palette.md')
  await writeFile(sourcePath, FIXTURE)
  const model = await prepareSource(sourcePath, FIXTURE, 'The current state of AI agents', statSync(sourcePath))
  const fixturePath = join(scratch, 'palette-present.html')
  await writeFile(fixturePath, model.fullHtml)
  const stubPath = join(scratch, 'electron-stub.mjs')
  await writeFile(stubPath, `const answers = {
  'recording:context': { testMode: true, talkSlug: 'palette', talkTitle: 'Palette', discardThresholdMs: 0 }, 'live:status': 'ended', 'live:snapshot': {}, 'recording:set-kind': { ok: true },
  'live:go': { success: true, shortUrl: 'https://handouts.fyi/737u/live', qrSvg: '<svg></svg>', status: 'connecting' }
}
window.__ipcCalls = []; window.__ipcOn = {}
let sessions = 0
export const ipcRenderer = {
  invoke: async (channel, ...args) => {
    window.__ipcCalls.push(channel)
    if (channel === 'recording:save') { sessions += 1; return { ok: true, sessionId: 's' + sessions, kind: args[0]?.kind } }
    return channel in answers ? answers[channel] : {}
  },
  on(channel, fn) { (window.__ipcOn[channel] ||= []).push(fn) }, send() {}, removeListener() {}
}
window.__push = (channel, value) => { for (const fn of window.__ipcOn[channel] || []) fn(null, value) }
export const contextBridge = { exposeInMainWorld: (name, api) => { window[name] = api } }
export const clipboard = { writeText() {}, readText() { return '' }, readImage() { return { isEmpty: () => true } } }
`)
  const bundle = await build({ entryPoints: [join(repo, 'src/preload/present-recorder.ts')], bundle: true, write: false, format: 'iife', platform: 'browser', alias: { electron: stubPath }, logLevel: 'silent' })
  const preload = bundle.outputFiles[0].text
  const fixtures = `window.__opened = []; window.open = (url) => { window.__opened.push(String(url)); return null }`

  browser = await chromium.launch({ headless: true })
  const open = async ({ size = [1440, 900], slide = 'two', htmlPath = fixturePath, withPreload = true } = {}) => {
    const context = await browser.newContext({ viewport: { width: size[0], height: size[1] } })
    context.setDefaultTimeout(5000)
    if (withPreload) await context.addInitScript({ content: `if (window === window.top) {\n${preload}\n${fixtures}\n}` })
    const page = await context.newPage()
    page.errors = []
    page.on('pageerror', (error) => page.errors.push(error.message))
    page.on('dialog', (dialog) => dialog.accept())
    await page.goto(`${pathToFileURL(htmlPath).href}?presenter=1${slide ? `#${slide}` : ''}`, { waitUntil: 'load', timeout: 120000 })
    await page.waitForFunction(() => /scale\(([\d.]+)\)/.test(document.querySelector('#currentPreview iframe')?.style.transform || ''), null, { timeout: 30000 })
    if (withPreload) await page.waitForSelector('#presenterStatus #twrec-module', { timeout: 10000 }).catch(() => failures.push('the REC cluster did not mount'))
    if (await page.isVisible('#twResume')) await page.click('#twResumeNo').catch(() => {})
    await page.mouse.move(5, 500)
    return { page, context }
  }
  const settle = (page, ms = 200) => page.waitForTimeout(ms)
  const guard = async (name, fn) => { try { await fn() } catch (error) { failures.push(`${name}: stopped: ${String(error.message).split('\n')[0]}`) } }
  const openPalette = async (page) => { await page.keyboard.press('Meta+Shift+P'); await settle(page, 120) }
  const rows = (page) => page.evaluate(() => [...document.querySelectorAll('#presenterCommandResults .tw-pal-row')].map((row) => ({
    id: row.dataset.paletteId, name: row.querySelector('.tw-pal-name')?.textContent || '',
    icon: [...(row.querySelector(':scope > svg')?.classList || [])].find((c) => c.startsWith('lucide-')) || null,
    caps: [...row.querySelectorAll('.tw-pal-keys kbd')].map((k) => k.textContent), keys: row.dataset.keys, disabled: row.disabled,
    group: (() => { let n = row.previousElementSibling; while (n && !n.classList.contains('tw-pal-sec')) n = n.previousElementSibling; return n?.textContent || '' })()
  })))
  const shown = (page, selector) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && !el.hidden && el.getClientRects().length > 0 }, selector)

  // ── 1. The palette lists every command ─────────────────────────────────────────────────────
  await guard('listing', async () => {
    const { page, context } = await open()
    await openPalette(page)
    check(await shown(page, '#presenterCommandPalette'), '⌘⇧P opens the palette')
    check(await page.evaluate(() => document.activeElement?.id === 'presenterCommandSearch'), 'the search field has focus')
    check(await page.evaluate(() => document.getElementById('presenterCommandSearch').placeholder) === 'Search presenter commands', 'the search field reads "Search presenter commands"')
    const count = await page.textContent('#presenterCommandCount')
    check(count === '73 commands', `the count reads "73 commands" (${count})`)
    const list = await rows(page)
    check(list.length === ENTRIES.length, `every entry has a row (${list.length} of ${ENTRIES.length})`)
    for (const [group, entries] of PRESENTER_PALETTE) {
      for (const entry of entries) {
        const row = list.find((r) => r.id === entry.id)
        const keys = presenterPaletteKeys(entry, SHORTCUT_REGISTRY)
        check(row && row.name === entry.name, `${entry.id}: named "${entry.name}" (${row?.name})`)
        check(row && row.group === group, `${entry.id}: under "${group}" (${row?.group})`)
        check(row && row.icon === `lucide-${entry.icon}`, `${entry.id}: lucide icon ${entry.icon} (${row?.icon})`)
        check(row && row.keys === keys && row.caps.join('') === keys.replace(/\s+/g, ''), `${entry.id}: shows its current key "${keys}" as key caps (${row?.caps.join(' | ')})`)
      }
    }
    // The drawn keys, spot-checked against the drawing.
    const capsOf = (id) => list.find((r) => r.id === id)?.caps.join(' ')
    for (const [id, caps] of [['next', '→'], ['previous', '←'], ['record-start', '⇧ R'], ['record-pause', '⇧ P'], ['record-stop', '⇧ R'], ['save-run-as', 'L'], ['instant-compose', '⌥ ⌘ I'], ['previews-larger', ']'], ['previews-smaller', '['], ['notes-back', '⇧ J'], ['edit', '⌘ E'], ['refresh', '⌘ R / ⇧ F5'], ['grid-card', '1–9'], ['reset-timer', '']]) {
      check((capsOf(id) ?? null) === caps, `${id}: key caps "${caps}" as drawn (${capsOf(id)})`)
    }
    // Filtering, the keyboard, and keys that stay in the search field.
    await page.keyboard.type('poll')
    await settle(page, 80)
    const polled = await rows(page)
    check(polled.length > 0 && polled.every((r) => /poll/i.test(`${r.name} ${r.group}`)), `"poll" keeps only poll commands (${polled.map((r) => r.name).join(' | ')})`)
    check((await page.textContent('#presenterCommandCount')) === `${polled.length} commands`, 'the count follows the filter')
    await page.fill('#presenterCommandSearch', '')
    await page.keyboard.type('Rl')
    await settle(page, 120)
    const typed = await page.evaluate(() => ({ value: document.getElementById('presenterCommandSearch').value, rec: document.getElementById('twrec-module')?.dataset.rec, mode: Object.keys(localStorage).map((k) => localStorage.getItem(k)).find((v) => v?.includes('"fontSize"')) || '' }))
    check(typed.value === 'Rl' && typed.rec === 'idle' && !/"mode":\{"kind"/.test(typed.mode) && !(await shown(page, '.twrec-picker')), `keys typed in the search stay there: ⇧R and L do not record or open the picker (${JSON.stringify(typed)})`)
    await page.fill('#presenterCommandSearch', '')
    await settle(page, 80)
    const highlighted = () => page.evaluate(() => document.querySelector('#presenterCommandResults .tw-pal-row.hi')?.dataset.paletteId || null)
    const enabled = (await rows(page)).filter((r) => !r.disabled).map((r) => r.id)
    check((await highlighted()) === enabled[0], `the first row that applies is chosen (${await highlighted()})`)
    await page.keyboard.press('ArrowDown')
    check((await highlighted()) === enabled[1], `↓ moves to the next row that applies, skipping dimmed ones (${await highlighted()} · expected ${enabled[1]})`)
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp')
    check((await highlighted()) === enabled.at(-1), `↑ from the first row wraps to the last that applies (${await highlighted()})`)
    const disabledIds = (await rows(page)).filter((r) => r.disabled).map((r) => r.id)
    for (const id of ['return', 'instant-back', 'quick-poll-dismiss', 'questions', 'media', 'gallery', 'record-stop']) check(disabledIds.includes(id), `${id}: dimmed where it does not apply (fixture: no jump, no instant slide, no Quick poll, not live, no media, not recording)`)
    await page.keyboard.press('Escape')
    await settle(page, 80)
    check(!(await shown(page, '#presenterCommandPalette')) && !(await shown(page, '#presenterCommandScrim')), 'Esc closes the palette and its scrim')
    // ↵ runs the chosen row: filter to Outline and press Enter.
    await openPalette(page)
    await page.keyboard.type('outline')
    await page.keyboard.press('Enter')
    await settle(page)
    check(await page.evaluate(() => document.getElementById('presenterOutlineDrawer')?.classList.contains('open')), '↵ runs the chosen row (Outline opens)')
    check(!(await shown(page, '#presenterCommandPalette')), 'running a row closes the palette')
    check(page.errors.length === 0, `listing: no page errors (${page.errors.join('; ')})`)
    await context.close()
  })

  // ── 2. Coverage: every control in the bars is an entry's control ────────────────────────────
  await guard('coverage', async () => {
    const { page, context } = await open()
    const found = await page.evaluate(({ entries, exempt }) => {
      const selectorOf = (b) => {
        if (b.id) return `#${b.id}`
        for (const a of ['data-notes-placement-option', 'data-notes-scroll-option', 'data-preview-size-option', 'data-minutes', 'data-remind']) if (b.hasAttribute(a)) return `[${a}="${b.getAttribute(a)}"]`
        return b.outerHTML.slice(0, 80)
      }
      const out = []
      for (const b of document.querySelectorAll('#presenterTopBar button, #presenterBottomBar button')) {
        const sel = selectorOf(b)
        const claimed = entries.filter((e) => (e.controls || []).some((s) => { try { return [...document.querySelectorAll(s)].includes(b) } catch { return false } })).map((e) => e.id)
        const excused = Object.keys(exempt).find((s) => { try { return b.matches(s) } catch { return false } }) || null
        out.push({ sel, claimed, excused })
      }
      const missing = entries.flatMap((e) => (e.controls || []).filter((s) => !document.querySelector(s)).map((s) => `${e.id} → ${s}`))
      return { out, missing }
    }, { entries: ENTRIES, exempt: CONTROLS_NOT_IN_PALETTE })
    for (const { sel, claimed, excused } of found.out) {
      check(claimed.length > 0 || excused, `control ${sel} runs a command the palette does not list`)
      check(!(claimed.length > 0 && excused), `control ${sel} is both listed and excused`)
    }
    check(found.out.length > 60, `the bars were enumerated (${found.out.length} buttons)`)
    // Controls only a preload or a state adds are absent from the fixture: named, not a failure.
    const allowedAbsent = ['#presenterQuickPollDismiss', '#presenterInstantBack', '#presenterPollOpen', '#presenterPollClose', '#presenterPollReveal', '#presenterEmbedFullscreen']
    for (const m of found.missing) check(allowedAbsent.some((s) => m.endsWith(s)), `palette control not in the window: ${m}`)
    check(page.errors.length === 0, `coverage: no page errors (${page.errors.join('; ')})`)
    await context.close()
  })

  // ── 3. An entry runs the same command as its control or key ────────────────────────────────
  const probe = (page) => page.evaluate(() => {
    const byId = (id) => document.getElementById(id)
    const vis = (el) => !!el && !el.hidden && el.getClientRects().length > 0 && !el.closest('[hidden]')
    const raw = Object.keys(localStorage).map((k) => localStorage.getItem(k)).find((v) => v && v.includes('"fontSize"'))
    const shared = raw ? JSON.parse(raw) : {}
    return {
      slide: byId('presenterCount')?.textContent || '', outline: !!byId('presenterOutlineDrawer')?.classList.contains('open'),
      mode: shared.mode?.kind || null, fontSize: shared.fontSize ?? 100, highlight: byId('presenterRoot').classList.contains('highlight-armed'),
      quickCompose: vis(byId('presenterQuickPollCompose')), instantCompose: vis(byId('presenterInstantCompose')),
      placement: byId('presenterRoot').dataset.notesPlacement, previewSize: byId('presenterRoot').dataset.previewSize || 'medium',
      notesTop: Math.round(byId('presenterNotesBody')?.scrollTop || 0), timer: byId('twClock')?.dataset.status || '',
      duration: vis(byId('twDurationSetter')), rec: byId('twrec-module')?.dataset.rec || '', picker: vis(document.querySelector('.twrec-picker')),
      shortcuts: vis(byId('twShortcuts')), audience: (window.__opened || []).length
    }
  })
  const pick = (p, fields) => Object.fromEntries(fields.map((f) => [f, p[f]]))
  const compare = async (id, { key, fields, slide = 'two', setup }) => {
    const run = async (viaPalette) => {
      const { page, context } = await open({ slide })
      try {
        if (setup) await setup(page)
        await settle(page)
        const before = pick(await probe(page), fields)
        if (viaPalette) {
          await openPalette(page)
          const disabled = await page.evaluate((x) => document.getElementById(`palette-${x}`)?.disabled ?? null, id)
          if (disabled !== false) return { before, after: `row ${disabled === null ? 'missing' : 'dimmed'}`, errors: [] }
          await page.click(`#palette-${id}`)
        } else await page.keyboard.press(key)
        await settle(page, 400)
        return { before, after: pick(await probe(page), fields), errors: page.errors.slice() }
      } catch (error) {
        return { before: null, after: `stopped: ${String(error.message).split('\n')[0]}`, errors: [] }
      } finally { await context.close() }
    }
    const a = await run(true)
    const b = await run(false)
    check(!same(a.before, a.after), `${id}: the entry does something (${JSON.stringify(a.after)})`)
    check(same(a.after, b.after), `${id}: the entry runs the same command as ${key} — entry ${JSON.stringify(a.after)} · key ${JSON.stringify(b.after)}`)
    check(a.errors.length === 0 && b.errors.length === 0, `${id}: no page errors (${[...a.errors, ...b.errors].join('; ')})`)
  }
  const CASES = [
    // Through a control (bottom bar, menu item, More item, status bar, Notes menu option, REC cluster)
    ['next', { key: 'ArrowRight', fields: ['slide'] }],
    ['skip', { key: 's', fields: ['slide'] }],
    ['last', { key: 'End', fields: ['slide'] }],
    ['outline', { key: 'o', fields: ['outline'] }],
    ['timer', { key: 'p', fields: ['timer'] }],
    ['duration', { key: 't', fields: ['duration'] }],
    ['record-start', { key: 'Shift+R', fields: ['rec'] }],
    ['quick-poll', { key: 'k', fields: ['quickCompose'] }],
    ['instant-compose', { key: 'Meta+Alt+i', fields: ['instantCompose'] }],
    ['reveal', { key: 'r', fields: ['mode'] }],
    ['focus', { key: 'f', fields: ['mode'] }],
    ['highlight', { key: 'h', fields: ['highlight'] }],
    ['font-larger', { key: '+', fields: ['fontSize'] }],
    ['shortcuts', { key: '?', fields: ['shortcuts'] }],
    // By its key (save run as…) and by the template's run map (previews, notes)
    ['save-run-as', { key: 'l', fields: ['picker'] }],
    ['previews-larger', { key: ']', fields: ['previewSize'] }],
    ['previews-smaller', { key: '[', fields: ['previewSize'] }],
    ['notes-forward', { key: 'j', fields: ['notesTop'] }]
  ]
  for (const [id, spec] of CASES) await guard(`run ${id}`, () => compare(id, spec))
  // A menu item without a key: the Notes menu's Sidebar placement, entry against the option.
  await guard('run notes-sidebar', async () => {
    const results = []
    for (const viaPalette of [true, false]) {
      const { page, context } = await open()
      if (viaPalette) { await openPalette(page); await page.click('#palette-notes-sidebar') }
      else { await page.click('#presenterMenuView'); await page.click('#notesPlacementBtn'); await page.click('[data-notes-placement-option="sidebar"]') }
      await settle(page, 300)
      results.push((await probe(page)).placement)
      await page.evaluate(() => localStorage.clear())
      await context.close()
    }
    check(results[0] === 'sidebar' && results[1] === 'sidebar', `notes-sidebar: the entry sets the placement as the Notes menu option does (${results.join(' · ')})`)
  })

  // ── 4. The ? sheet lists only keys that work here ──────────────────────────────────────────
  const sheet = async (page) => {
    await page.keyboard.press('?')
    await settle(page, 120)
    const list = await page.evaluate(() => [...document.querySelectorAll('#twShortcutsBody .tw-shortcuts-row')].map((r) => [r.querySelector('kbd')?.textContent || '', r.querySelector('span')?.textContent || '']))
    return list
  }
  await guard('sheet', async () => {
    const { page, context } = await open()
    const list = await sheet(page)
    const keys = list.map(([k]) => k)
    check(!keys.includes('N') && !keys.includes('C'), `the ? sheet does not list N or C (${keys.join(' ')})`)
    for (const k of ['⇧R', '⇧P', 'L', '⌘E', '⌘R / ⇧F5', '→ Space ↓ PgDn ↵', 'J / ⇧J', 'U', 'G', 'Q', '⇧ Q', 'K', '⌘⇧P']) check(keys.includes(k), `the ? sheet lists ${k} in the presenter TalkWeaver opens`)
    const registryRows = SHORTCUT_REGISTRY.filter((e) => e.scope === 'presenter').map((e) => `${e.keys}\u0000${e.label}`)
    for (const [k, label] of list) check(registryRows.includes(`${k}\u0000${label}`), `sheet row "${k} ${label}" is a presenter key in the registry`)
    check(list.length === registryRows.length, `the sheet shows every presenter key once (${list.length} of ${registryRows.length})`)
    check(!list.some(([, label]) => /Start \/ stop recording|Refresh this deck/.test(label)), 'no rows appended by a preload')
    if (SHOTS) { await mkdir(SHOTS, { recursive: true }) }
    await context.close()
    // Without the preloads (a deck opened on its own) the recording and editor keys do nothing.
    const bare = await open({ withPreload: false })
    const bareKeys = (await sheet(bare.page)).map(([k]) => k)
    for (const k of ['⇧R', '⇧P', 'L', '↵', '⌘E', '⌘R / ⇧F5']) check(!bareKeys.includes(k), `without the recording and edit preloads the sheet does not list ${k}`)
    // Without the live preload there is no live session: G does nothing, and polls cannot reach
    // the audience (ticket 08). The keys that work without it stay.
    for (const k of ['G', 'Q', '⇧ Q', 'K']) check(!bareKeys.includes(k), `without the live preload the sheet does not list ${k}`)
    for (const k of ['F5', 'U', '⌥⌘I', '→ Space ↓ PgDn ↵']) check(bareKeys.includes(k), `without the preloads the sheet still lists ${k}`)
    await bare.page.keyboard.press('Escape')
    await openPalette(bare.page)
    const bareRows = await rows(bare.page)
    for (const id of ['record-start', 'record-pause', 'record-stop', 'save-run-as', 'edit', 'refresh', 'live', 'quick-poll', 'poll-primary', 'poll-reveal']) check(bareRows.find((r) => r.id === id)?.disabled === true, `without the preloads ${id} is listed but dimmed`)
    check(bare.page.errors.length === 0, `bare window: no page errors (${bare.page.errors.join('; ')})`)
    await bare.context.close()
  })

  // ── Shots ───────────────────────────────────────────────────────────────────────────────
  if (SHOTS) {
    await guard('shots', async () => {
      await mkdir(SHOTS, { recursive: true })
      const deck = process.env.DECK ? resolve(process.env.DECK) : fixturePath
      const slide = process.env.SLIDE || 'two'
      const { page, context } = await open({ htmlPath: deck, slide })
      await openPalette(page)
      await page.screenshot({ path: join(SHOTS, 'palette-open-1440x900.png') })
      await page.evaluate(() => { const l = document.getElementById('presenterCommandResults'); l.scrollTop = l.scrollHeight })
      await settle(page, 120)
      await page.screenshot({ path: join(SHOTS, 'palette-scrolled-1440x900.png') })
      await page.evaluate(() => { document.getElementById('presenterCommandResults').scrollTop = 0 })
      await page.keyboard.type('poll')
      await settle(page, 120)
      await page.screenshot({ path: join(SHOTS, 'palette-filter-poll-1440x900.png') })
      await page.keyboard.press('Escape')
      await page.keyboard.press('?')
      await settle(page, 150)
      await page.screenshot({ path: join(SHOTS, 'shortcuts-sheet-1440x900.png') })
      await page.keyboard.press('Escape')
      await page.keyboard.press('o')
      await settle(page, 500)
      await page.screenshot({ path: join(SHOTS, 'outline-open-1440x900.png') })
      await context.close()
    })
  }
} finally {
  await browser?.close()
  await rm(scratch, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`test-presenter-palette: ${failures.length} failure(s):`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`test-presenter-palette: ${ENTRIES.length} commands listed with icon and key, every bar control and presenter key covered, entries run the same command as their control or key, the ? sheet lists only working keys.`)
