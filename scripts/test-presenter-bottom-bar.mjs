// Presenter bottom bar, edit pencil and mode chip (ADR-0031 §4, presenter redesign ticket 05). The
// compiled presenter window in headless Chromium, with the recording preload (and through it the
// edit bridge and the live bridge) bundled against a stub of electron and injected as the app
// injects it. Seams:
//  1. the presenter's navigation and mode functions: every bottom-bar button, every More item and
//     the mode chip's × run the same function as their key, compared per control on the state it
//     changes (slide, beat, mode, highlight, text size, outline, composers) — a fresh window each
//     side, the same set-up, then the button or the key;
//  2. the edit bridge's open-for-editing call: the pencil is a button at the right end of the bar
//     (not floating) and asks main for the slide on screen exactly as ⌘E does; More's Refresh with
//     latest edits asks main to run ⌘R's refresh;
//  3. the mode chip: one for each of Reveal, Focus and Highlight, with its words and the pressed
//     button (or Reveal checked in More); × leaves the mode; Highlight's chip clears;
//  4. fit, headless at three sizes in the L1 state (timer, recording, live, reactions): the bar
//     holds the drawn controls in the drawn order; no control overlaps another, wraps or leaves the
//     window; at 1280x800 step n1 applies and every label stays, at 1440x900 and 1728x1117 nothing
//     collapses; the More menu opens upward inside the window; a narrow window reaches n2 / n3 and
//     the top bar's c10 (the chip drops its words, keeps × ).
// Every check is collected and all failures are reported together.
// Usage: node scripts/test-presenter-bottom-bar.mjs
//   SHOTS=<dir> also saves L1 at 1280x800, 1440x900 and 1728x1117, the More menu open, and Focus,
//   Highlight and Reveal on at 1440x900. DECK=<compiled deck.html> uses that deck for the shots
//   (SLIDE_L1 picks its slide); the checks always use the fixture.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const { SHORTCUT_REGISTRY } = await import(new URL('../src/shared/shortcut-registry.ts', import.meta.url))
const { PRESENTER_CONTROLS, presenterControlKeys } = await import(new URL('../src/shared/presenter-controls.ts', import.meta.url))
const SHOTS = process.env.SHOTS ? resolve(process.env.SHOTS) : null
const keysOf = (id) => presenterControlKeys(PRESENTER_CONTROLS.find((c) => c.id === id), SHORTCUT_REGISTRY)
const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// The drawn bar (surfaces-drawn.md, "Bottom bar"; shots L1-*): group by group, in order.
const BAR = {
  left: ['outlineBtn'],
  mid: ['presenterPrev', 'presenterNext', 'skipNextBtn'],
  right: ['navQuickPoll', 'navInstant', 'presenterFocus', 'presenterPointer', 'presenterPen', 'presenterHighlight', 'presenterMore', 'twedit-btn']
}
const LABELS = { outlineBtn: 'Outline', presenterPrev: 'Previous', presenterNext: 'Next', navQuickPoll: 'Quick poll', navInstant: 'Instant slide', presenterFocus: 'Focus', presenterPointer: 'Pointer', presenterPen: 'Pen', presenterHighlight: 'Highlight' }
const ICON_ONLY = ['skipNextBtn', 'presenterMore', 'twedit-btn']
// The drawn More menu (shot menu-more-open-1440x900.png), with Reveal mode, which the ticket puts
// in More, first under "This slide".
const MORE = {
  sections: ['Go to', 'This slide', 'Mark the slide'],
  items: [['presenterFirst', 'First slide'], ['presenterLast', 'Last slide'], ['moreReturn', 'Return to where you jumped from'], ['moreGridCard', 'Card on a grid slide'],
    ['presenterReveal', 'Reveal mode'], ['moreEmbed', 'Interact with embedded page'], ['fontDown', 'Slide text smaller'], ['fontUp', 'Slide text larger'],
    ['morePointer', 'Pointer'], ['morePen', 'Pen'], ['moreInkClear', 'Clear drawing on this slide'], ['moreInkClearAll', 'Clear all drawings'],
    ['presenterHighlightClear', 'Clear highlights'], ['moreRefresh', 'Refresh with latest edits']]
}

const FIXTURE = `---
title: The current state of AI agents
duration: 30min
auto_title_slide: false
auto_thanks_slide: false
---

## Where agents came from
{timer=10min}

### What makes an agent useful? {id=one}

- A chat can tell me how to fill in an expenses form.
- An agent can find the form and fill it in.

### The evolution of agents {id=two}

- AI as oracle
- AI as tool maker
- AI as tool user

:::notes
Three stages, and the room will know the first two.
:::

### Not all agents are agents {id=three}

- Some are workflows
- Some are chat

### Where next {id=four}

- Files
- Software

### A picture {id=pic}

![A small chart](pic.png)

### Wrap-up {id=five}

The end.
`

const scratch = await mkdtemp(join(tmpdir(), 'talkweaver-presenter-bottom-bar-'))
let browser
try {
  const sourcePath = join(scratch, 'bottom-bar.md')
  await writeFile(sourcePath, FIXTURE)
  // A 2x2 PNG for the picture slide (its Gallery button joins the bar's centre group).
  await writeFile(join(scratch, 'pic.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64'))
  const model = await prepareSource(sourcePath, FIXTURE, 'The current state of AI agents', statSync(sourcePath))
  const fixturePath = join(scratch, 'bottom-bar-present.html')
  await writeFile(fixturePath, model.fullHtml)
  // The recording preload as the app ships it (it mounts the edit bridge and the live bridge);
  // electron stubbed. invoke() logs [channel, first argument] and answers what the preloads ask.
  const stubPath = join(scratch, 'electron-stub.mjs')
  await writeFile(stubPath, `const answers = {
  'recording:context': { testMode: true, talkSlug: 'bottom-bar', discardThresholdMs: 0 }, 'live:status': 'ended', 'live:snapshot': {},
  'live:go': { success: true, shortUrl: 'https://handouts.fyi/737u/live', qrSvg: '<svg data-test="join-qr"></svg>', status: 'connecting' },
  'live:end': { success: true, status: 'ended' }
}
window.__ipcCalls = []; window.__ipcOn = {}
export const ipcRenderer = {
  invoke: async (channel, ...args) => { window.__ipcCalls.push([channel, args[0] ?? null]); return channel in answers ? answers[channel] : {} },
  on(channel, fn) { (window.__ipcOn[channel] ||= []).push(fn) }, send(channel, value) { window.__ipcCalls.push([channel, value, Date.now()]) }, removeListener() {}
}
window.__push = (channel, value) => { for (const fn of window.__ipcOn[channel] || []) fn(null, value) }
export const contextBridge = { exposeInMainWorld: (name, api) => { window[name] = api } }
export const clipboard = { writeText() {}, readText() { return '' }, readImage() { return { isEmpty: () => true } } }
`)
  const bundle = await build({ entryPoints: [join(repo, 'src/preload/present-recorder.ts')], bundle: true, write: false, format: 'iife', platform: 'browser', alias: { electron: stubPath }, logLevel: 'silent' })
  const preload = bundle.outputFiles[0].text
  const fixtures = `window.open = () => null
if (window === window.top && window.twLivePollBridge) window.twLivePollBridge.onAudience = (cb) => { window.__audience = cb }`

  browser = await chromium.launch({ headless: true })
  const open = async ([width, height], slide, htmlPath = fixturePath) => {
    const context = await browser.newContext({ viewport: { width, height } })
    context.setDefaultTimeout(5000)
    await context.addInitScript({ content: `if (window === window.top) {\n${preload}\n${fixtures}\n}` })
    const page = await context.newPage()
    page.errors = []
    page.on('pageerror', (error) => page.errors.push(error.message))
    page.on('dialog', (dialog) => dialog.accept())
    await page.goto(`${pathToFileURL(htmlPath).href}?presenter=1${slide ? `#${slide}` : ''}`, { waitUntil: 'load', timeout: 120000 })
    await page.waitForFunction(() => /scale\(([\d.]+)\)/.test(document.querySelector('#currentPreview iframe')?.style.transform || ''), null, { timeout: 30000 })
    await page.waitForSelector('#presenterStatus #twrec-module', { timeout: 10000 }).catch(() => {})
    await page.waitForSelector('#twedit-btn', { timeout: 10000 }).catch(() => {})
    if (await page.isVisible('#twResume')) await page.click('#twResumeNo').catch(() => {})
    await page.mouse.move(5, 500)
    return { page, context }
  }
  const settle = (page, ms = 200) => page.waitForTimeout(ms)
  const tap = async (page, selector) => { try { await page.click(selector, { timeout: 2000 }) } catch { failures.push(`no control to click: ${selector}`) } }
  const guard = async (name, fn) => { try { await fn() } catch (error) { failures.push(`${name}: stopped: ${String(error.message).split('\n')[0]}`) } }
  // What the commands change, read from the page.
  const probe = (page) => page.evaluate(() => {
    const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]')
    const byId = (id) => document.getElementById(id)
    const raw = Object.keys(localStorage).map((k) => localStorage.getItem(k)).find((v) => v && v.includes('"fontSize"'))
    const shared = raw ? JSON.parse(raw) : {}
    return {
      slide: document.querySelector('.slide.active')?.dataset.id || null, beat: shared.beat ?? null,
      counter: byId('presenterCount')?.textContent || '',
      mode: shared.mode?.kind || shared.mode?.sticky || null, fontSize: shared.fontSize ?? 100,
      highlightArmed: byId('presenterRoot').classList.contains('highlight-armed'),
      highlights: document.querySelector('#currentPreview iframe')?.contentDocument?.querySelectorAll('mark.hl-mark').length ?? 0,
      outline: byId('presenterOutlineDrawer')?.classList.contains('open'),
      quickCompose: shown(byId('presenterQuickPollCompose')), instantCompose: shown(byId('presenterInstantCompose')),
      edit: window.__ipcCalls.filter(([c]) => c === 'present:edit-slide').map(([, a]) => a),
      refresh: window.__ipcCalls.filter(([c]) => c === 'present:refresh-deck').length,
      openMenu: [...document.querySelectorAll('.tw-menu')].filter(shown).map((m) => m.id).join(',')
    }
  })
  const pick = (p, fields) => Object.fromEntries(fields.map((f) => [f, p[f]]))
  // Press a More item the way a person does: open More, press the item.
  const moreItem = async (page, item) => { await tap(page, '#presenterMore'); await settle(page, 120); await tap(page, `#${item}`); await settle(page) }
  const jumpFar = async (page) => {
    // An outline jump of more than one slide arms Return (B).
    await page.keyboard.press('o'); await settle(page)
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#presenterOutline .slide-link:not(.slide-sublink)')]
      rows.at(-1)?.click()
    })
    await settle(page, 300)
  }
  const highlightSomething = async (page) => {
    await page.keyboard.press('h'); await settle(page)
    await page.evaluate(() => {
      const frame = document.querySelector('#currentPreview iframe')
      const doc = frame.contentDocument
      const li = doc.querySelector('.slide li')
      const range = doc.createRange(); range.selectNodeContents(li)
      const sel = frame.contentWindow.getSelection(); sel.removeAllRanges(); sel.addRange(range)
      doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await settle(page, 300)
  }
  // One control against its key: a fresh window each side, the same set-up, then the button (or
  // the More item) or the key. The fields named must end up the same, and differ from where they
  // started.
  const compare = async (name, { slide = 'two', setup, button, more, key, keyRun, fields }) => {
    const run = async (viaButton) => {
      const { page, context } = await open([1440, 900], slide)
      try {
        if (setup) await setup(page)
        await page.mouse.move(5, 500)
        await settle(page)
        const before = pick(await probe(page), fields)
        let enabled = true
        if (viaButton) {
          if (more) {
            await tap(page, '#presenterMore'); await settle(page, 120)
            enabled = await page.evaluate((id) => !document.getElementById(id)?.disabled, more)
            await tap(page, `#${more}`)
          } else {
            enabled = await page.evaluate((id) => { const b = document.getElementById(id); return !!b && !b.disabled && b.getClientRects().length > 0 }, button)
            await tap(page, `#${button}`)
          }
        } else if (keyRun) await keyRun(page)
        else await page.keyboard.press(key)
        await settle(page, 350)
        const after = pick(await probe(page), fields)
        return { before, after, enabled, errors: page.errors.slice() }
      } catch (error) {
        return { before: null, after: `stopped: ${String(error.message).split('\n')[0]}`, enabled: false, errors: [] }
      } finally { await context.close() }
    }
    const a = await run(true)
    const b = await run(false)
    check(a.enabled, `${name}: the control is on the bar and enabled where its command applies`)
    check(!same(a.before, a.after), `${name}: the control does something (${JSON.stringify(a.before)} → ${JSON.stringify(a.after)})`)
    check(same(a.after, b.after), `${name}: the control runs the same function as its key — control ${JSON.stringify(a.after)} · key ${JSON.stringify(b.after)}`)
    check(a.errors.length === 0 && b.errors.length === 0, `${name}: no page errors (${[...a.errors, ...b.errors].join('; ')})`)
  }

  // ── 1. Every button runs the same function as its key ─────────────────────────────────────
  const onSlide = (id) => async (page) => { await page.evaluate((x) => { location.hash = x }, id); await settle(page, 300) }
  await compare('Outline', { button: 'outlineBtn', key: 'o', fields: ['outline'] })
  await compare('Previous', { button: 'presenterPrev', key: 'ArrowLeft', fields: ['slide', 'beat', 'counter'] })
  await compare('Next', { button: 'presenterNext', key: 'ArrowRight', fields: ['slide', 'beat', 'counter'] })
  await compare('Skip next slide', { button: 'skipNextBtn', key: 's', fields: ['slide', 'beat', 'counter'] })
  await compare('Return', { setup: jumpFar, button: 'returnBtn', key: 'b', fields: ['slide', 'beat', 'counter'] })
  await compare('Quick poll', { button: 'navQuickPoll', key: 'k', fields: ['quickCompose'] })
  await compare('Instant slide', { button: 'navInstant', key: 'Meta+Alt+i', fields: ['instantCompose'] })
  await compare('Focus', { button: 'presenterFocus', key: 'f', fields: ['mode'] })
  await compare('Highlight', { button: 'presenterHighlight', key: 'h', fields: ['highlightArmed'] })
  // More
  await compare('More: First slide', { setup: onSlide('four'), more: 'presenterFirst', key: 'Home', fields: ['slide', 'beat', 'counter'] })
  await compare('More: Last slide', { more: 'presenterLast', key: 'End', fields: ['slide', 'beat', 'counter'] })
  await compare('More: Return', { setup: jumpFar, more: 'moreReturn', key: 'b', fields: ['slide', 'beat', 'counter'] })
  await compare('More: Reveal mode', { more: 'presenterReveal', key: 'r', fields: ['mode'] })
  await compare('More: Slide text smaller', { more: 'fontDown', key: '-', fields: ['fontSize'] })
  await compare('More: Slide text larger', { more: 'fontUp', key: '+', fields: ['fontSize'] })
  // Clear highlights has no key; it runs what View's Clear highlights runs.
  await compare('More: Clear highlights', { setup: highlightSomething, more: 'presenterHighlightClear', keyRun: async (p) => { await tap(p, '#presenterMenuView'); await tap(p, '#viewHighlightClear') }, fields: ['highlights'] })
  // The mode chip's × runs what Esc runs, for each mode.
  await compare('Mode chip ×, Focus', { setup: async (p) => { await p.keyboard.press('f'); await settle(p) }, button: 'presenterModeExit', key: 'Escape', fields: ['mode'] })
  await compare('Mode chip ×, Reveal', { setup: async (p) => { await p.keyboard.press('r'); await settle(p) }, button: 'presenterModeExit', key: 'Escape', fields: ['mode'] })
  await compare('Mode chip ×, Highlight', { setup: async (p) => { await p.keyboard.press('h'); await settle(p) }, button: 'presenterHighlightExit', key: 'Escape', fields: ['highlightArmed'] })
  await compare('Mode chip Clear', { setup: highlightSomething, button: 'presenterHighlightChipClear', keyRun: async (p) => { await tap(p, '#presenterMenuView'); await tap(p, '#viewHighlightClear') }, fields: ['highlights'] })

  // ── 2. The pencil and the refresh item go through the edit bridge ─────────────────────────
  await compare('Edit pencil', { setup: onSlide('three'), button: 'twedit-btn', key: 'Meta+e', fields: ['edit'] })
  await guard('pencil', async () => {
    const { page, context } = await open([1440, 900], 'three')
    const p = await page.evaluate(() => {
      const btn = document.getElementById('twedit-btn')
      const r = btn?.getBoundingClientRect()
      return {
        inBar: !!btn?.closest('#presenterBottomBar .tw-nav-right'), last: btn?.parentElement?.id === 'presenterEditSlot' && !btn.parentElement.nextElementSibling,
        position: btn ? getComputedStyle(btn).position : null, tip: btn?.dataset.tip, key: btn?.dataset.key, title: btn?.getAttribute('title'),
        rect: r ? [r.width, r.height] : null, icon: [...(btn?.querySelector('svg')?.classList || [])].find((c) => c.startsWith('lucide-')) || null
      }
    })
    check(p.inBar && p.last, `pencil: a button at the right end of the bottom bar (${JSON.stringify(p)})`)
    check(p.position === 'static' || p.position === 'relative', `pencil: not floating over the window (position ${p.position})`)
    check(p.tip === 'Edit this slide in TalkWeaver' && p.key === keysOf('twedit-btn') && !p.title && p.icon === 'lucide-pencil', `pencil: lucide pencil, the presenter tooltip "Edit this slide in TalkWeaver  ⌘E", no native title (${JSON.stringify(p)})`)
    check(same(p.rect, [26, 32]), `pencil: 26px wide and 32px high, as drawn (${p.rect})`)
    // Refresh with latest edits: shown by the bridge, asks main to run ⌘R's refresh.
    await moreItem(page, 'moreRefresh')
    const after = await probe(page)
    check(after.refresh === 1, `More: Refresh with latest edits asks main for the refresh (${after.refresh} calls)`)
    check(page.errors.length === 0, `pencil: no page errors (${page.errors.join('; ')})`)
    await context.close()
  })
  // ⌘R's own path in main and the item's handler call the same function.
  const main = readFileSync(join(repo, 'src/main/index.ts'), 'utf8')
  const handler = main.match(/ipcMain\.handle\('present:refresh-deck'[\s\S]*?\n\}\)/)?.[0] || ''
  check(/refreshDeckFromEditor\(win\)/.test(handler), 'main: present:refresh-deck runs refreshDeckFromEditor, the function ⌘R runs')

  // ── 3. The mode chip ──────────────────────────────────────────────────────────────────────
  await guard('mode chip', async () => {
    const { page, context } = await open([1440, 900], 'two')
    const chip = () => page.evaluate(() => {
      const shown = (el) => !!el && el.getClientRects().length > 0 && !el.closest('[hidden]')
      const read = (id) => {
        const el = document.getElementById(id)
        if (!shown(el)) return null
        return {
          words: el.querySelector('.tw-mode-word')?.textContent || '', icon: [...(el.querySelector('.tw-mode-mark svg')?.classList || [])].find((c) => c.startsWith('lucide-')) || null,
          buttons: [...el.querySelectorAll('button')].filter(shown).map((b) => [b.id, b.dataset.tip, b.dataset.key, b.disabled]),
          inStatus: !!el.closest('#presenterStatus'), color: getComputedStyle(el).color
        }
      }
      return {
        mode: read('presenterModeChip'), highlight: read('presenterHighlightChip'),
        focusPressed: document.getElementById('presenterFocus').getAttribute('aria-pressed'), highlightPressed: document.getElementById('presenterHighlight').getAttribute('aria-pressed'),
        revealChecked: document.getElementById('presenterReveal').getAttribute('aria-checked'), banner: document.getElementById('modeBanner')?.classList.contains('show'),
        topFits: document.getElementById('presenterTopBar').dataset.fits
      }
    })
    let c = await chip()
    check(!c.mode && !c.highlight && c.focusPressed === 'false' && c.highlightPressed === 'false', `chip: none while no mode is on (${JSON.stringify(c)})`)
    for (const [key, word, icon, exitName] of [['f', 'Focus mode', 'lucide-focus', 'Turn off focus mode'], ['r', 'Reveal mode', 'lucide-layers', 'Turn off reveal mode']]) {
      await page.keyboard.press(key); await settle(page, 300)
      c = await chip()
      check(c.mode?.words === word && c.mode?.icon === icon && c.mode?.inStatus, `chip: "${word}" with its icon in the status bar (${JSON.stringify(c.mode)})`)
      check(same(c.mode?.buttons, [['presenterModeExit', exitName, 'Esc', false]]), `chip: × named "${exitName}  Esc" (${JSON.stringify(c.mode?.buttons)})`)
      check(c.mode?.color === 'rgb(255, 224, 138)', `chip: amber (${c.mode?.color})`)
      check(key === 'f' ? c.focusPressed === 'true' : c.revealChecked === 'true', `chip: ${word} shows ${key === 'f' ? 'Focus pressed in the bar' : 'Reveal checked in More'} (${c.focusPressed} / ${c.revealChecked})`)
      check(!c.banner, `chip: the old mode banner does not also show (${c.banner})`)
      check(c.topFits === 'true', `chip: the top bar still fits with "${word}" (${c.topFits})`)
      await tap(page, '#presenterModeExit'); await settle(page, 300)
      c = await chip()
      check(!c.mode && c.focusPressed === 'false' && c.revealChecked === 'false' && (await probe(page)).mode === null, `chip: × leaves ${word} (${JSON.stringify(c)})`)
    }
    await page.keyboard.press('h'); await settle(page, 300)
    c = await chip()
    check(c.highlight?.words === 'Highlight on' && c.highlight?.icon === 'lucide-highlighter' && c.highlightPressed === 'true', `chip: "Highlight on" with its icon, Highlight pressed (${JSON.stringify(c)})`)
    check(same(c.highlight?.buttons, [['presenterHighlightChipClear', 'Clear highlights on this slide', '', true], ['presenterHighlightExit', 'Turn off highlighting', 'Esc', false]]), `chip: Highlight has Clear (disabled with nothing to clear) and × (${JSON.stringify(c.highlight?.buttons)})`)
    await tap(page, '#presenterHighlightExit'); await settle(page, 300)
    c = await chip()
    check(!c.highlight && c.highlightPressed === 'false' && !(await probe(page)).highlightArmed, `chip: × leaves Highlight (${JSON.stringify(c)})`)
    check(page.errors.length === 0, `chip: no page errors (${page.errors.join('; ')})`)
    await context.close()
  })

  // ── 4. Fit at three sizes, the More menu, and the collapse steps ──────────────────────────
  const goLive = async (page) => {
    await tap(page, '#presenterMenuLive'); await tap(page, '#liveGoButton'); await settle(page)
    await page.evaluate(() => window.__push('live:status', 'live'))
    await settle(page)
  }
  const L1 = async (page) => {
    await page.evaluate(() => {
      const deck = (Object.keys(sessionStorage).find((x) => x.endsWith(':session')) || '').replace(/:session$/, '')
      sessionStorage.setItem(`${deck}:timer`, JSON.stringify({ targetSeconds: 1800, elapsedMs: 942000, runningSince: Date.now(), reminders: [5, 1] }))
    })
    await page.reload({ waitUntil: 'load' })
    await page.waitForFunction(() => /scale\(([\d.]+)\)/.test(document.querySelector('#currentPreview iframe')?.style.transform || ''), null, { timeout: 30000 })
    await page.waitForSelector('#presenterStatus #twrec-module', { timeout: 10000 }).catch(() => {})
    await page.waitForSelector('#twedit-btn', { timeout: 10000 }).catch(() => {})
    await page.click('#twrec-primary').catch(() => {})
    await page.waitForFunction(() => document.getElementById('twrec-module')?.dataset.rec === 'recording', null, { timeout: 5000 }).catch(() => {})
    await goLive(page)
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.__audience?.({ reactions: { puzzled: 2, helped: 5, bookmark: 1 }, questions: 3 }))
    await page.mouse.move(5, 500)
    await settle(page, 500)
  }
  const measure = (page) => page.evaluate(() => {
    // (The older control bar, before this ticket, is measured the same way, group by group.)
    const bar = document.getElementById('presenterBottomBar') || document.querySelector('.presenter-controls')
    const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[hidden]')
    const groupEls = bar.querySelector('.tw-nav-left') ? ['.tw-nav-left', '.tw-nav-mid', '.tw-nav-right'].map((sel) => bar.querySelector(sel)) : [...bar.children]
    const groups = groupEls.map((g) => [...g.querySelectorAll(':scope > button, :scope > * > button:not(.tw-mi)')].filter(shown))
    if (!document.getElementById('presenterBottomBar')) groups.at(-1).push(...[document.getElementById('twedit-btn')].filter(shown))
    const buttons = groups.flat()
    const rects = buttons.map((b) => ({ id: b.id, r: b.getBoundingClientRect() }))
    const overlaps = []
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i].r; const b = rects[j].r
      if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) overlaps.push(`${rects[i].id}/${rects[j].id}`)
    }
    const label = (b) => b.querySelector(':scope > .tw-btn-label')
    const box = bar.getBoundingClientRect()
    const next = document.getElementById('presenterNext').getBoundingClientRect()
    return {
      groups: groups.map((g) => g.map((b) => b.id)), overlaps,
      wrapped: buttons.filter((b) => { const l = label(b); return b.getBoundingClientRect().height > 33 || (l && shown(l) && l.getClientRects().length > 1) }).map((b) => b.id),
      clipped: buttons.filter((b) => { const l = label(b); const r = b.getBoundingClientRect(); return b.scrollWidth > b.clientWidth + 1 || (l && shown(l) && l.scrollWidth > l.clientWidth + 1) || r.left < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5 }).map((b) => b.id),
      labels: Object.fromEntries(buttons.map((b) => [b.id, label(b) && shown(label(b)) ? label(b).textContent.trim() : ''])),
      heights: [...new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().height)))],
      icons: Object.fromEntries(buttons.map((b) => [b.id, [...(b.querySelector(':scope > svg')?.classList || [])].find((c) => c.startsWith('lucide-')) || null])),
      fontSizes: [...new Set(buttons.map((b) => label(b)).filter((l) => l && shown(l)).map((l) => getComputedStyle(l).fontSize))],
      collapse: bar.dataset.collapse ?? null, fits: bar.dataset.fits ?? null, barHeight: Math.round(box.height), inWindow: box.bottom <= innerHeight + 0.5,
      nextCentre: Math.round(next.left + next.width / 2), scrollX: document.documentElement.scrollWidth > innerWidth,
      topFits: document.getElementById('presenterTopBar').dataset.fits, topCollapse: document.getElementById('presenterTopBar').dataset.collapse,
      floating: [...document.querySelectorAll('body > button, body > #twedit-btn')].filter(shown).map((b) => b.id)
    }
  })
  await guard('Pointer suspension and event-driven live delivery', async () => {
    const { page, context } = await open([1280, 800], 'two')
    try {
      const pointerCalls = () => page.evaluate(() => window.__ipcCalls.filter(([channel]) => channel === 'live:pointer'))
      const move = async () => {
        const box = await page.locator('#currentPreview iframe').boundingBox()
        await page.mouse.move(box.x + box.width * .3, box.y + box.height * .8)
      }
      await page.evaluate(() => { window.__ipcCalls = [] })
      await page.waitForTimeout(1200)
      assert.equal((await pointerCalls()).length, 0, 'Pointer off emits no polling traffic')
      await page.keyboard.press('i')
      await move()
      await page.waitForTimeout(150)
      await page.evaluate(() => { window.__ipcCalls = [] })
      await page.waitForTimeout(6000)
      const resting = await pointerCalls()
      assert.ok(resting.length >= 5, 'resting Pointer sends keep-alives')
      assert.ok(resting.length <= 7, `resting Pointer sends at most one a second: ${resting.length}`)
      for (const [, message] of resting) assert.equal(message.type, 'pointer.live')
      const surfaces = [
        ['#presenterMenuView', '#presenterMenuView', null],
        ['#presenterMore', '#presenterMore', null],
        ['#twDurationBtn', '#twDurationBtn', null],
        ['#navQuickPoll', '#quickPollClose', '#quickPollQuestion'],
        ['#navInstant', '#instantClose', '#instantText'],
        ['#presenterGoLive', '#liveGoPanelClose', null],
      ]
      for (const [open, close, field] of surfaces) {
        await page.click(open)
        await page.waitForTimeout(80)
        await move()
        await page.waitForTimeout(80)
        assert.equal(await page.locator('.tw-live-overlay').evaluate(el => getComputedStyle(el).pointerEvents), 'none', open)
        assert.equal(await page.locator('.tw-live-overlay').evaluate(el => getComputedStyle(el).cursor), 'auto', open)
        assert.equal(await page.locator('.tw-pointer-ring').isVisible(), false, open)
        assert.equal((await pointerCalls()).at(-1)[1].pointer, 'gone', open)
        assert.equal(await page.locator('#presenterPointer').getAttribute('aria-pressed'), 'true', open)
        if (field) await page.locator(field).fill('Reachable with Pointer armed')
        await page.click(close)
        await move()
        await page.waitForTimeout(100)
        assert.equal(await page.locator('.tw-pointer-ring').isVisible(), true, close)
      }
      // The questions tray follows the live preload's existing availability and A key path.
      await page.evaluate(() => window.__push('live:status', 'live'))
      await page.keyboard.press('a')
      await page.locator('#presenterQuestionsTray').waitFor({ state: 'visible' })
      await move()
      await page.waitForTimeout(100)
      assert.equal(await page.locator('.tw-pointer-ring').isVisible(), false)
      assert.equal((await pointerCalls()).at(-1)[1].pointer, 'gone')
      await page.keyboard.press('Escape')
      await move()
      await page.waitForTimeout(100)
      assert.equal(await page.locator('.tw-pointer-ring').isVisible(), true)
      // Refresh sends gone before asking main to replace the page.
      await page.click('#presenterMore')
      await page.click('#moreRefresh')
      assert.equal((await pointerCalls()).at(-1)[1].pointer, 'gone')
      await page.keyboard.press('i')
      await page.evaluate(() => { window.__ipcCalls = [] })
      await page.waitForTimeout(1200)
      assert.equal((await pointerCalls()).length, 0)
    } finally { await context.close() }
  })
  for (const size of [[1280, 800], [1440, 900], [1728, 1117]]) {
    await guard(`fit ${size.join('x')}`, async () => {
      const { page, context } = await open(size, 'two')
      await L1(page)
      const m = await measure(page)
      const at = `${size[0]}x${size[1]}`
      check(same(m.groups, [BAR.left, BAR.mid, BAR.right]), `${at}: the drawn controls in the drawn order (${JSON.stringify(m.groups)})`)
      check(m.overlaps.length === 0, `${at}: no control overlaps another (${m.overlaps.join(', ')})`)
      check(m.wrapped.length === 0 && m.clipped.length === 0, `${at}: no label wraps or clips, nothing leaves the window (wrapped ${m.wrapped.join(', ')}; clipped ${m.clipped.join(', ')})`)
      check(!m.scrollX && m.inWindow && m.barHeight === 40, `${at}: the bar is one 40px row inside the window, no sideways scroll (${m.barHeight}px)`)
      check(same(m.heights, [32]) && same(m.fontSizes, ['14px']), `${at}: controls 32px high, labels 14px (${m.heights} / ${m.fontSizes})`)
      for (const [id, text] of Object.entries(LABELS)) check(m.labels[id] === text, `${at}: ${id} keeps its label "${text}" (${m.labels[id]})`)
      for (const id of ICON_ONLY) check(m.labels[id] === '' && !!m.icons[id], `${at}: ${id} is icon-only (${m.labels[id]} / ${m.icons[id]})`)
      for (const id of [...BAR.left, ...BAR.mid, ...BAR.right]) {
        const control = PRESENTER_CONTROLS.find((c) => c.id === id)
        check(m.icons[id] === `lucide-${control?.icon}`, `${at}: ${id} has its lucide icon ${control?.icon} (${m.icons[id]})`)
      }
      check(m.floating.length === 0, `${at}: nothing floats over the window (${m.floating.join(', ')})`)
      check(m.fits === 'true', `${at}: the bar reports that it fits (${m.fits})`)
      check(m.topFits === 'true', `${at}: the top bar still fits (${m.topFits}, ${m.topCollapse})`)
      // With the Pen in the mark group (0.38 ticket 08) n1 is the normal step at every drawn size.
      check(m.collapse === 'n1', `${at}: tools stay labelled and the layout uses its normal fit step (${m.collapse})`)
      if (size[0] >= 1600) check(Math.abs(m.nextCentre - (size[0] / 2 + 60)) <= 70, `${at}: the centre group is centred on the window (${m.nextCentre})`)
      // The More menu: opens upward from "…", inside the window, items unclipped, drawn order.
      await tap(page, '#presenterMore'); await settle(page, 200)
      const menu = await page.evaluate(() => {
        const shown = (el) => !!el && el.getClientRects().length > 0 && !el.closest('[hidden]')
        const menu = document.getElementById('presenterMoreMenu')
        const box = menu.getBoundingClientRect()
        const more = document.getElementById('presenterMore').getBoundingClientRect()
        return {
          open: shown(menu), expanded: document.getElementById('presenterMore').getAttribute('aria-expanded'), up: box.bottom <= more.top, inside: box.top >= 0 && box.left >= 0 && box.right <= innerWidth,
          sections: [...menu.querySelectorAll('.tw-menu-sec')].map((s) => s.textContent.trim()),
          items: [...menu.querySelectorAll('.tw-mi')].filter(shown).map((i) => ({ id: i.id, label: i.querySelector('.tw-btn-label')?.firstChild?.textContent.trim() || '', key: i.querySelector('.tw-mi-key')?.textContent ?? null, disabled: i.disabled, icon: [...(i.querySelector(':scope > svg')?.classList || [])].find((c) => c.startsWith('lucide-')) || null })),
          clipped: [...menu.querySelectorAll('.tw-mi, .tw-btn-label, .tw-mi-key')].filter(shown).filter((el) => { const r = el.getBoundingClientRect(); return el.scrollWidth > el.clientWidth + 1 || r.right > box.right + 0.5 || r.left < box.left - 0.5 }).map((el) => el.id || el.textContent.trim().slice(0, 20))
        }
      })
      check(menu.open && menu.expanded === 'true' && menu.up && menu.inside, `${at}: More opens upward inside the window (${JSON.stringify({ open: menu.open, up: menu.up, inside: menu.inside })})`)
      check(menu.clipped.length === 0, `${at}: no More item clipped (${menu.clipped.join(', ')})`)
      if (size[0] === 1440) {
        check(same(menu.sections, MORE.sections), `More: sections ${menu.sections.join(' / ')}`)
        check(same(menu.items.map((i) => [i.id, i.label]), MORE.items), `More: items in order (${menu.items.map((i) => i.label).join(' · ')})`)
        for (const item of menu.items) {
          const control = PRESENTER_CONTROLS.find((c) => c.id === item.id)
          check(!!control && item.icon === `lucide-${control.icon}` && item.key === keysOf(item.id), `More: ${item.id} has icon ${control?.icon} and key "${control && keysOf(item.id)}" (${item.icon} / ${item.key})`)
        }
        const dis = Object.fromEntries(menu.items.map((i) => [i.id, i.disabled]))
        check(dis.moreReturn && dis.moreGridCard && dis.presenterHighlightClear && dis.moreEmbed && !dis.presenterFirst && !dis.fontUp, `More: items that do not apply here are disabled (${JSON.stringify(dis)})`)
      }
      await page.keyboard.press('Escape'); await settle(page, 150)
      check((await probe(page)).openMenu === '', `${at}: Esc closes More`)
      check(page.errors.length === 0, `${at}: no page errors (${page.errors.join('; ')})`)
      await context.close()
    })
  }
  // A slide with images: the Gallery button sits in the centre group, after Skip next, in the same
  // style, and the bar still fits at 1280 (media controls take the same place on a media slide).
  await guard('gallery', async () => {
    const { page, context } = await open([1280, 800], 'pic')
    const m = await measure(page)
    const g = await page.evaluate(() => {
      const b = document.getElementById('presenterGalleryBtn')
      return { inMid: !!b?.closest('#presenterBottomBar .tw-nav-mid'), shown: !!b && b.getClientRects().length > 0, height: b ? Math.round(b.getBoundingClientRect().height) : 0, font: b ? getComputedStyle(b).fontSize : '' }
    })
    check(g.inMid && g.shown && g.height === 32 && g.font === '14px', `gallery: the Gallery button shows in the centre group in the bar's style (${JSON.stringify(g)})`)
    check(m.groups[1].at(-1) === 'presenterGalleryBtn', `gallery: after Skip next (${m.groups[1].join(', ')})`)
    check(m.fits === 'true' && m.overlaps.length === 0 && m.clipped.length === 0, `gallery: the bar fits at 1280 with it (${m.collapse}; overlaps ${m.overlaps.join(', ')}; clipped ${m.clipped.join(', ')})`)
    await context.close()
  })
  // Narrow windows: the bar's later steps and the top bar's c10 (mode chip without words).
  await guard('collapse n2 n3 c10', async () => {
    const { page, context } = await open([960, 700], 'two')
    await L1(page)
    let m = await measure(page)
    check(m.collapse.split(' ').includes('n2') && m.fits === 'true' && m.overlaps.length === 0, `960x700: the bar reaches n2 and fits (${m.collapse}; overlaps ${m.overlaps.join(', ')})`)
    check(m.labels.presenterFocus === '' && m.labels.presenterHighlight === '', `n2: Focus and Highlight are icon-only (${m.labels.presenterFocus} / ${m.labels.presenterHighlight})`)
    await page.setViewportSize({ width: 840, height: 700 }); await settle(page, 400)
    m = await measure(page)
    check(m.collapse === 'n1 n2 n3' && m.labels.navQuickPoll === '' && m.labels.navInstant === '', `840x700: n3 makes Quick poll and Instant slide icon-only (${m.collapse}; ${m.labels.navQuickPoll} / ${m.labels.navInstant})`)
    await page.keyboard.press('h'); await settle(page, 400)
    const c = await page.evaluate(() => {
      const bar = document.getElementById('presenterTopBar')
      const word = document.getElementById('presenterHighlightWord')
      const chip = document.getElementById('presenterHighlightChip')
      return { collapse: bar.dataset.collapse, word: word.getClientRects().length > 0, chip: chip.getClientRects().length > 0, exit: document.getElementById('presenterHighlightExit').getClientRects().length > 0 }
    })
    check(c.collapse.split(' ').includes('c10') ? (!c.word && c.chip && c.exit) : c.word, `c10: the chip keeps its icon and × and drops its words once c10 applies (${JSON.stringify(c)})`)
    check(c.collapse.split(' ').includes('c10'), `840x700 with Highlight on: the top bar reaches c10 (${c.collapse})`)
    check(page.errors.length === 0, `narrow: no page errors (${page.errors.join('; ')})`)
    await context.close()
  })

  // ── Build shots ───────────────────────────────────────────────────────────────────────────
  if (SHOTS) {
    await mkdir(SHOTS, { recursive: true })
    const deck = process.env.DECK ? resolve(process.env.DECK) : fixturePath
    const slideL1 = process.env.SLIDE_L1 || 'two'
    for (const size of [[1280, 800], [1440, 900], [1728, 1117]]) {
      const { page, context } = await open(size, slideL1, deck)
      await L1(page)
      await page.screenshot({ path: join(SHOTS, `L1-${size[0]}x${size[1]}.png`) })
      if (size[0] === 1440) {
        await tap(page, '#presenterMore'); await page.mouse.move(5, 500); await settle(page, 300)
        await page.screenshot({ path: join(SHOTS, 'menu-more-open-1440x900.png') })
        await page.keyboard.press('Escape'); await settle(page, 150)
        for (const [key, file] of [['f', 'mode-focus'], ['h', 'mode-highlight'], ['r', 'mode-reveal']]) {
          await page.keyboard.press(key); await page.mouse.move(5, 500); await settle(page, 500)
          await page.screenshot({ path: join(SHOTS, `${file}-1440x900.png`) })
          await page.keyboard.press('Escape'); await settle(page, 300)
        }
      }
      await context.close()
    }
  }

  assert.deepEqual(failures, [], `presenter bottom bar:\n  ${failures.join('\n  ')}`)
  console.log('presenter bottom bar: Outline · Previous, Next, Skip next · Quick poll, Instant slide, Focus, Pointer, Pen, Highlight, More, pencil; every button, More item and chip × runs the same function as its key; the pencil opens editing through the edit bridge; a mode chip for Reveal, Focus and Highlight, × leaves it; no overlap at 1280/1440/1728, n1 at 1280, 1440 and 1728 with labels kept; n2, n3 and c10 in narrow windows')
} finally {
  await browser?.close()
  await rm(scratch, { recursive: true, force: true })
}
