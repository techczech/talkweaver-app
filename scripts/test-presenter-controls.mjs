// Presenter icons and names on hover (ADR-0031 §6, presenter redesign ticket 01). Two seams:
//  1. the presenter-controls table against the shortcut registry, the vendored lucide set and the
//     template's generated block (src/shared/presenter-controls.ts, scripts/build-shortcut-help.mjs);
//  2. the compiled presenter window in headless Chromium at 1440x900, with the recording preload
//     (and through it the edit pencil and the live button) bundled against a stub of electron and
//     injected as the app injects it: every presenter button has an accessible name; every chrome
//     control carries a name that is not just a key; hovering shows "Name  Shortcut" with the
//     registry's key; icons are lucide SVGs of one stroke width and one size; no emoji or
//     Unicode-symbol icon is left in the chrome.
// Usage: node scripts/test-presenter-controls.mjs   SHOTS=<dir> also saves the 1440x900 build shots.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { renderTemplateWithShortcutHelp, renderIconsModule, iconsModulePath } from './build-shortcut-help.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const { SHORTCUT_REGISTRY } = await import(new URL('../src/shared/shortcut-registry.ts', import.meta.url))
const { PRESENTER_CONTROLS, presenterControlTips, presenterControlKeys, presenterIconNames } = await import(new URL('../src/shared/presenter-controls.ts', import.meta.url))

// ── 1. The table ─────────────────────────────────────────────────────────────────────────────
const lucide = JSON.parse(readFileSync(join(repo, 'compiler/assets/icons/lucide.json'), 'utf8'))
const ids = PRESENTER_CONTROLS.map((c) => c.id)
assert.equal(new Set(ids).size, ids.length, 'each control appears once')
for (const control of PRESENTER_CONTROLS) {
  assert.ok(control.name && /[a-z]{2}/.test(control.name), `${control.id}: has a name in words`)
  if (control.icon) assert.ok(lucide[control.icon]?.body, `${control.id}: ${control.icon} is a lucide icon`)
  if (control.shortcut) assert.ok(SHORTCUT_REGISTRY.some((e) => e.id === control.shortcut), `${control.id}: ${control.shortcut} is a registry id`)
  assert.ok(!('unregisteredKeys' in control), `${control.id}: its keys come from the registry only`)
}
for (const name of presenterIconNames()) assert.ok(lucide[name]?.body, `${name} is a lucide icon`)
// The keys come from the registry: change the registry and the tooltips follow.
const tips = presenterControlTips(SHORTCUT_REGISTRY)
assert.deepEqual(tips.presenterPointer, ['Pointer: show your mouse on every screen', 'I'])
assert.deepEqual(tips.presenterPointerExit, ['Turn off pointer', 'Esc'])
assert.deepEqual(tips.skipNextBtn, ['Skip next slide', 'S'])
assert.deepEqual(tips.twResetBtn, ['Reset timer', ''], 'no key: name only')
assert.deepEqual(tips['twedit-btn'], ['Edit this slide in TalkWeaver', '⌘E'])
const moved = SHORTCUT_REGISTRY.map((e) => (e.id === 'presenter.skip' ? { ...e, keys: 'X' } : e))
assert.equal(presenterControlTips(moved).skipNextBtn[1], 'X', 'the skip tooltip reads the registry, not a copy')
assert.throws(() => presenterControlKeys({ id: 'x', name: 'X', shortcut: 'presenter.nope' }, SHORTCUT_REGISTRY), /no shortcut/)
// The generated artefacts are current.
const templatePath = join(repo, 'compiler/assets/templates/presenter-popup-single-html.html')
const template = readFileSync(templatePath, 'utf8')
assert.equal(template, await renderTemplateWithShortcutHelp(template), 'template block is stale: npm run generate:shortcut-help')
assert.equal(readFileSync(iconsModulePath, 'utf8'), await renderIconsModule(), 'presenter-icons.generated.ts is stale: npm run generate:shortcut-help')

// ── 2. The rendered window ───────────────────────────────────────────────────────────────────
// Buttons that are items inside a menu, popover, composer, list or dialog (they are labelled by
// their own text in context) are not hover-tooltip controls; everything else in the chrome is.
const NOT_TIP_CONTROLS = [
  '.quick-poll-compose button:not(.quick-poll-close)', '#notesMenu [data-notes-placement-option]', '#notesMenu [data-notes-scroll-option]',
  '.tw-menu button',
  '#twDurationSetter [data-minutes]', '#twDurationSetter .tw-reminder', '#presenterOutline button', '#twResume button',
  '.presenter-poll-results button', '.twrec-picker button', '.twrec-close-modal button', '#twShortcuts button'
].join(', ')
const CHROME = '#presenterRoot button, #twrec-module button, .twrec-toast button, #twedit-btn'
// Unicode symbols used as icons: arrows-as-glyphs, technical, geometric, dingbats, emoji. Key names
// (⇧ ⌘ ⌥ ← → ↑ ↓ ↵) stay legal in key caps and tooltips.
const GLYPH = /[×↩↻⇤⇥⊞⌀-⌗⌙-⌤⌦-⏿■-◿☀-➿⤀-⥿\u{1F000}-\u{1FAFF}]/u
const registryKeys = new Set(SHORTCUT_REGISTRY.map((e) => e.keys))

const SHOTS = process.env.SHOTS ? resolve(process.env.SHOTS) : null
const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-presenter-controls-'))
let browser
const errors = []
try {
  const source = `---
title: The current state of AI agents
auto_title_slide: false
auto_thanks_slide: false
---

### What makes an agent useful? {id=one}

- A chat can tell me how to fill in an expenses form.
- An agent can find the form and fill it in.

:::notes
Start with the expenses form: everyone has filled one in.
:::

### The evolution of agents {id=two}

- AI as oracle
- AI as tool maker
- AI as tool user

### Wrap-up {id=three}

The end.
`
  const sourcePath = join(scratch, 'controls.md')
  await writeFile(sourcePath, source)
  const model = await prepareSource(sourcePath, source, 'controls', statSync(sourcePath))
  const htmlPath = join(scratch, 'controls-present.html')
  await writeFile(htmlPath, model.fullHtml)
  // The recording preload as the app ships it, with electron stubbed (no main process here).
  const stubPath = join(scratch, 'electron-stub.mjs')
  await writeFile(stubPath, `export const ipcRenderer = { invoke: async () => ({}), on() {}, send() {}, removeListener() {} }
export const contextBridge = { exposeInMainWorld: (name, api) => { window[name] = api } }
export const clipboard = { writeText() {} }
`)
  const bundle = await build({ entryPoints: [join(repo, 'src/preload/present-recorder.ts')], bundle: true, write: false, format: 'iife', platform: 'browser', alias: { electron: stubPath }, logLevel: 'silent' })
  const preload = bundle.outputFiles[0].text

  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  // Electron runs preloads in the top frame only (the slide previews are iframes).
  await context.addInitScript({ content: `if (window === window.top) {\n${preload}\n}` })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${pathToFileURL(htmlPath).href}?presenter=1#one`, { waitUntil: 'load' })
  await page.waitForFunction(() => /scale\(([\d.]+)\)/.test(document.querySelector('#currentPreview iframe')?.style.transform || ''), null, { timeout: 15000 })
  await page.waitForSelector('#twrec-module #twrec-primary')
  await page.waitForSelector('#twedit-btn')
  if (await page.isVisible('#twResume')) await page.click('#twResumeNo')
  await page.mouse.move(700, 450)
  await page.waitForTimeout(300)

  const controls = await page.evaluate(({ CHROME, NOT_TIP_CONTROLS }) => [...document.querySelectorAll(CHROME)].map((b) => {
    const r = b.getBoundingClientRect()
    const text = (b.textContent || '').replace(/\s+/g, ' ').trim()
    const labelledBy = (b.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim()
    const svg = b.querySelector(':scope > svg.tw-ico')
    const cs = svg ? getComputedStyle(svg) : null
    const glyphText = [...b.childNodes].filter((n) => !(n.nodeType === 1 && (n.matches('.kbd, kbd') || n.querySelector?.('.kbd')))).map((n) => n.textContent).join('')
    return {
      id: b.id || b.className || b.outerHTML.slice(0, 60),
      accessibleName: (b.getAttribute('aria-label') || labelledBy || text || b.getAttribute('title') || '').trim(),
      tipControl: !b.matches(NOT_TIP_CONTROLS),
      tip: b.dataset.tip || '', key: b.dataset.key ?? null,
      // Hoverable where a person would hover: on screen and the topmost element at its centre
      // (a faded-out toast or a closed drawer's button is in the DOM but not under the pointer).
      visible: r.width > 0 && r.height > 0 && b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)),
      x: r.left + r.width / 2, y: r.top + r.height / 2,
      icon: svg ? [...svg.classList].find((c) => c.startsWith('lucide-') ) : null,
      iconSize: cs ? [cs.width, cs.height] : null, strokeWidth: svg?.getAttribute('stroke-width') ?? null,
      glyphText
    }
  }), { CHROME, NOT_TIP_CONTROLS })

  const failures = []
  const byId = new Map(controls.map((c) => [c.id, c]))
  for (const c of controls) {
    if (!c.accessibleName) failures.push(`${c.id}: no accessible name`)
    if (GLYPH.test(c.glyphText)) failures.push(`${c.id}: Unicode or emoji icon in "${c.glyphText.trim()}"`)
    if (!c.tipControl) continue
    if (!c.tip) failures.push(`${c.id}: no name on hover`)
    else if (c.tip === c.key || registryKeys.has(c.tip) || !/[a-z]{2}/.test(c.tip)) failures.push(`${c.id}: hover shows only a key ("${c.tip}")`)
  }
  // Every table control that is on the page carries its table name (or a state name), its
  // registry key and its lucide icon.
  const stateNames = { twClockBtn: ['Start timer', 'Pause timer', 'Resume timer'], twStartTimerBtn: ['Start timer', 'Resume timer'], liveGoButton: ['Go live', 'End live session', 'Connecting to the live session', 'Start a new live session', 'Retry starting a live session', 'Retry after updating the live service', 'Waiting for the live session to end'] }
  let tableSeen = 0
  for (const control of PRESENTER_CONTROLS) {
    const c = byId.get(control.id)
    if (!c) continue
    tableSeen += 1
    const names = stateNames[control.id] || [control.name]
    if (!names.includes(c.tip)) failures.push(`${control.id}: name "${c.tip}", expected ${names.join(' | ')}`)
    const keys = presenterControlKeys(control, SHORTCUT_REGISTRY)
    if ((c.key ?? '') !== keys) failures.push(`${control.id}: key "${c.key}", registry says "${keys}"`)
    if (control.icon && !c.icon) failures.push(`${control.id}: no lucide icon`)
  }
  // One stroke width, one size step.
  const iconSizes = new Set(controls.filter((c) => c.visible && c.icon).map((c) => c.iconSize.join(' ')))
  const strokes = new Set(controls.filter((c) => c.icon).map((c) => c.strokeWidth))
  if (iconSizes.size !== 1 || !iconSizes.has('16px 16px')) failures.push(`icon sizes ${[...iconSizes].join(', ')}; expected one size, 16px`)
  if (strokes.size !== 1 || !strokes.has('2')) failures.push(`icon stroke widths ${[...strokes].join(', ')}; expected 2`)
  // Status marks (not controls) carry lucide icons too, not "●".
  const marks = await page.evaluate(() => [...document.querySelectorAll('#presenterRoot > header, .presenter-controls, #liveGoPanel, #presenterPollPanel .presenter-poll-head, #presenterInstantStrip, #presenterOutlineDrawer h2, #twrec-module')]
    .map((el) => [...el.querySelectorAll('*')].filter((n) => !n.matches('.kbd, kbd, .tw-tip-key') && [...n.childNodes].some((t) => t.nodeType === 3)).map((n) => [...n.childNodes].filter((t) => t.nodeType === 3).map((t) => t.textContent).join('')).join(' ')).join(' '))
  if (GLYPH.test(marks)) failures.push(`Unicode or emoji icon in chrome text: "${marks.match(GLYPH)[0]}"`)

  // Hover: "Name  Shortcut", from the registry, for every visible chrome control.
  const hovered = []
  for (const c of controls.filter((x) => x.visible && x.tipControl)) {
    await page.mouse.move(c.x, c.y)
    const tip = await page.evaluate(() => {
      const t = document.querySelector('.tw-tip')
      if (!t || t.hidden) return null
      const key = t.querySelector('.tw-tip-key')
      return { name: t.querySelector('.tw-tip-name')?.textContent ?? t.textContent, key: key && !key.hidden ? key.textContent : '' }
    })
    if (!tip) { failures.push(`${c.id}: hovering shows no tooltip`); continue }
    if (tip.name !== c.tip) failures.push(`${c.id}: tooltip name "${tip.name}", expected "${c.tip}"`)
    if (tip.key !== (c.key ?? '')) failures.push(`${c.id}: tooltip key "${tip.key}", expected "${c.key}"`)
    hovered.push(c.id)
    await page.mouse.move(700, 450)
  }
  // Reset timer sits in the clock popover since ticket 02 (closed here); Start timer is beside the clock.
  // Go live is an item of the Live menu since ticket 04; the menu buttons are hovered instead.
  // First slide is an item of the bottom bar's More menu since ticket 05; "…" is hovered instead.
  // "Not live" in the status bar is the Go live button before a session (preview.8 feedback).
  for (const id of ['skipNextBtn', 'twClockBtn', 'twStartTimerBtn', 'twDurationBtn', 'presenterMore', 'twrec-primary', 'twedit-btn', 'presenterMenuLive', 'presenterMenuPoll', 'presenterMenuView', 'presenterGoLive']) {
    if (!hovered.includes(id)) failures.push(`${id}: not hovered (not visible?)`)
  }
  assert.deepEqual(failures, [], `presenter controls:\n  ${failures.join('\n  ')}`)

  if (SHOTS) {
    await mkdir(SHOTS, { recursive: true })
    await page.mouse.move(700, 450)
    await page.screenshot({ path: join(SHOTS, 'icons-1440x900.png') })
    for (const [id, file] of [['skipNextBtn', 'tooltip-skip-1440x900.png'], ['twClockBtn', 'tooltip-clock-1440x900.png'], ['twrec-primary', 'tooltip-record-1440x900.png']]) {
      const c = byId.get(id)
      await page.mouse.move(c.x, c.y)
      await page.waitForTimeout(100)
      await page.screenshot({ path: join(SHOTS, file) })
      await page.mouse.move(700, 450)
    }
  }
  assert.deepEqual(errors, [], 'no page errors')
  console.log(`presenter controls: ${controls.length} buttons named; ${controls.filter((c) => c.tipControl).length} chrome controls name their action; ${hovered.length} hovered with "Name  Shortcut" from the registry; ${tableSeen} table controls on the page, lucide icons at one size and stroke`)
} finally {
  await browser?.close()
  await rm(scratch, { recursive: true, force: true })
}
