// =============================================================================
// test:presenter-pane-swap-dom — no presenter pane ever shows a blank or unstyled picture between steps
//
// Each presenter pane (Current, Next, Then) shows a picture of a slide: an iframe with its own document
// (previewSlide). On every step the panes get new pictures. Up to 0.45.1 a pane was emptied first and
// the new picture drawn in its place, so the pane was blank for one or more frames on every step and
// slide change; stepping quickly looked as if the whole view were redrawn (owner report, 16 Nov 2026).
// Now the picture on show stays until its successor is drawn, styled and fitted.
//
// The presenter window is stepped (slowly, quickly, and as a held key repeats) through a talk with
// reveal and focus steps, a focus loop, a stepping carousel and plain slides, and every pane is sampled
// on EVERY animation frame: the picture on show must have its slide and the deck stylesheet applied.
// Afterwards each pane must show the picture of where the talk is (a successor is never lost), with at
// most one successor waiting in a pane at any time.
// Browser: Playwright's bundled Chromium (never the installed Chrome).
// Usage: node scripts/presenter-pane-swap-dom.test.mjs [--root=<checkout>] (root: compile with another checkout)
// =============================================================================
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { flickerFixture } from './lib/presenter-step-fixture.mjs'

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const root = resolve(args.root || join(dirname(fileURLToPath(import.meta.url)), '..'))
const { prepareSource } = await import(pathToFileURL(join(root, 'compiler/scripts/lib/08-source-adapters.mjs')).href)

const PANES = ['currentPreview', 'nextPreview', 'followingPreview']

// Where each pane must be after n steps forward from the start of the talk: [Current, Next, Then],
// each as slide|card|state of each stepped element (h hidden, c current, s soft, f full, z fuzzy;
// "-" no card). Written from the talk in presenter-step-fixture.mjs: a reveal list starts hidden,
// shows each point in turn as current with the earlier ones soft, then all full; a focus list
// starts fuzzy; a stepping carousel steps its first card's points, then its second card's; Next
// shows the next beat (a carousel card as such) and Then the one after, fully revealed.
const EXPECTED = [
  ['rev1|-|hhhh', 'foc1|-|', 'loop|-|'], ['rev1|-|chhh', 'foc1|-|', 'loop|-|'], ['rev1|-|schh', 'foc1|-|', 'loop|-|'],
  ['rev1|-|ssch', 'foc1|-|', 'loop|-|'], ['rev1|-|sssc', 'foc1|-|', 'loop|-|'], ['rev1|-|ffff', 'foc1|-|', 'loop|-|'],
  ['foc1|-|zzzz', 'loop|-|', 'plain1|-|'], ['foc1|-|czzz', 'loop|-|', 'plain1|-|'], ['foc1|-|sczz', 'loop|-|', 'plain1|-|'],
  ['foc1|-|sscz', 'loop|-|', 'plain1|-|'], ['foc1|-|sssc', 'loop|-|', 'plain1|-|'], ['foc1|-|ffff', 'loop|-|', 'plain1|-|'],
  ['loop|-|zzzzz', 'plain1|-|', 'cards|0|'], ['loop|-|czzzz', 'plain1|-|', 'cards|0|'], ['loop|-|sczzz', 'plain1|-|', 'cards|0|'],
  ['loop|-|ssczz', 'plain1|-|', 'cards|0|'], ['loop|-|ssscz', 'plain1|-|', 'cards|0|'], ['loop|-|ssssc', 'plain1|-|', 'cards|0|'],
  ['loop|-|fffff', 'plain1|-|', 'cards|0|'],
  ['plain1|-|', 'cards|0|', 'cards|1|'],
  ['cards|0|hh', 'cards|1|', 'cols|-|'], ['cards|0|ch', 'cards|1|', 'cols|-|'], ['cards|0|sc', 'cards|1|', 'cols|-|'], ['cards|0|ff', 'cards|1|', 'cols|-|'],
  ['cards|1|hh', 'cols|-|', 'quote|-|'], ['cards|1|ch', 'cols|-|', 'quote|-|'], ['cards|1|sc', 'cols|-|', 'quote|-|'], ['cards|1|ff', 'cols|-|', 'quote|-|'],
  ['cols|-|', 'quote|-|', 'rev2|-|'],
  ['quote|-|', 'rev2|-|', 'foc2|-|'],
  ['rev2|-|hhhhh', 'foc2|-|', 'plain2|-|'], ['rev2|-|chhhh', 'foc2|-|', 'plain2|-|'], ['rev2|-|schhh', 'foc2|-|', 'plain2|-|'],
]
// In the presenter window: what the picture on show in each pane holds, in EXPECTED's terms.
function paneSignatures(panes) {
  return panes.map((id) => {
    const t = document.getElementById(id)
    if (!t || t.classList.contains('preview-end')) return 'end'
    const f = t.querySelector(':scope > iframe:not(.preview-incoming):not(.live-sim-frame)')
    const s = f?.contentDocument?.querySelector('.stage .slide')
    if (!s) return 'none'
    const cards = [...s.querySelectorAll('.card.carousel-subslide')]
    const card = cards.length ? String(cards.findIndex((c) => c.classList.contains('active-card'))) : '-'
    const code = { hidden: 'h', current: 'c', soft: 's', full: 'f', fuzzy: 'z' }
    const states = [...s.querySelectorAll('.mode-el')].map((el) => code[el.getAttribute('data-mode-state')] || '?').join('')
    return `${s.dataset.id}|${card}|${states}`
  })
}

// In the presenter window: one record per animation frame, the state of each pane's picture on show.
function installSampler(panes) {
  const log = []
  window.__panes = { log, step: 0 }
  const state = (id) => {
    const t = document.getElementById(id)
    if (!t) return 'ok'
    if (t.classList.contains('preview-end') || t.classList.contains('preview-live-sim')) return 'ok'
    const shown = [...t.querySelectorAll(':scope > iframe:not(.live-sim-frame)')]
      .filter((f) => getComputedStyle(f).visibility !== 'hidden' && getComputedStyle(f).display !== 'none')
    if (!shown.length) return 'missing'
    const f = shown[shown.length - 1]
    const doc = f.contentDocument
    if (!doc || !doc.querySelector('.stage .slide')) return 'blank'
    if (doc.defaultView.getComputedStyle(doc.querySelector('.stage')).containerType !== 'size') return 'unstyled'
    if (doc.readyState !== 'complete') return 'loading'
    return 'ok'
  }
  const tick = () => {
    log.push({ step: window.__panes.step, panes: panes.map(state), frames: Math.max(...panes.map((id) => document.querySelectorAll(`#${id} > iframe:not(.live-sim-frame)`).length)) })
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

const scratch = await mkdtemp(join(tmpdir(), 'tw-pane-swap-'))
let browser
let failures = 0
try {
  const sourcePath = join(scratch, 'pane-swap.md')
  await writeFile(sourcePath, flickerFixture)
  const model = await prepareSource(sourcePath, flickerFixture, null, statSync(sourcePath), {}, {})
  const htmlPath = join(scratch, 'pane-swap.html')
  await writeFile(htmlPath, model.fullHtml)
  browser = await chromium.launch({ headless: true })

  const runs = [
    { name: 'slow (a step every 500 ms)', gap: 500, steps: 16, back: 4 },
    { name: 'quick (a step every 120 ms)', gap: 120, steps: 30, back: 8 },
    { name: 'held key (repeats every 50 ms)', gap: 50, steps: 30, back: 0, repeat: true },
  ]
  for (const run of runs) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${pathToFileURL(htmlPath).href}?presenter=1#rev1`)
    await page.waitForSelector('#currentPreview iframe')
    await page.waitForFunction(() => document.querySelector('#currentPreview > iframe')?.contentDocument?.readyState === 'complete')
    await page.waitForTimeout(400)
    await page.evaluate(installSampler, PANES)
    const press = async (i, key) => {
      await page.evaluate((n) => { window.__panes.step = n }, i)
      if (run.repeat && i > 1) await page.evaluate((k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, repeat: true, bubbles: true })), key)
      else await page.keyboard.press(key)
      await page.waitForTimeout(run.gap)
    }
    for (let i = 1; i <= run.steps; i++) await press(i, 'ArrowRight')
    for (let i = 1; i <= run.back; i++) await press(run.steps + i, 'ArrowLeft')
    // Settled: no successor waiting, every picture loaded.
    await page.waitForFunction((ids) => ids.every((id) => {
      const t = document.getElementById(id)
      if (!t || t.classList.contains('preview-end')) return true
      return !t.querySelector(':scope > iframe.preview-incoming') && [...t.querySelectorAll(':scope > iframe')].every((f) => f.contentDocument?.readyState === 'complete')
    }), PANES, { timeout: 10000 })
    await page.waitForTimeout(300)
    const log = await page.evaluate(() => window.__panes.log)
    const during = log.filter((r) => r.step > 0)
    const bad = during.filter((r) => r.panes.some((p) => p !== 'ok'))
    const kinds = {}
    for (const r of bad) r.panes.forEach((p, i) => { if (p !== 'ok') kinds[`${PANES[i]}:${p}`] = (kinds[`${PANES[i]}:${p}`] || 0) + 1 })
    const most = Math.max(...during.map((r) => r.frames))
    // Where the talk is now, and what each pane shows.
    const where = await page.evaluate(() => {
      const shown = (id) => {
        const t = document.getElementById(id)
        if (!t || t.classList.contains('preview-end')) return 'end'
        const f = t.querySelector(':scope > iframe:not(.preview-incoming):not(.live-sim-frame)')
        return f?.contentDocument?.querySelector('.stage .slide')?.dataset.id || 'none'
      }
      return { current: shown('currentPreview'), frames: document.querySelectorAll('#currentPreview > iframe').length, key: document.getElementById('currentPreview').dataset.previewKey || '' }
    })
    const check = (ok, message) => { if (ok) console.log(`PASS ${run.name}: ${message}`); else { failures++; console.error(`FAIL ${run.name}: ${message}`) } }
    // Every pane ends on the picture of where the talk is: slide, card and step.
    const position = run.repeat ? null : run.steps - run.back
    if (position !== null) {
      const panes = await page.evaluate(paneSignatures, PANES)
      check(JSON.stringify(panes) === JSON.stringify(EXPECTED[position]), `after ${position} steps every pane shows where the talk is (${panes.join(' ; ')}; expected ${EXPECTED[position].join(' ; ')})`)
    }
    check(during.length > run.steps * 2, `sampled ${during.length} frames over ${run.steps + run.back} steps`)
    check(bad.length === 0, `no frame with a blank, unstyled or missing pane picture (${bad.length} such frames, steps ${[...new Set(bad.map((r) => r.step))].join(',') || 'none'}; ${JSON.stringify(kinds)})`)
    check(most <= 2, `at most the picture on show and one successor in a pane (most: ${most})`)
    check(where.frames === 1 && where.key.startsWith(`${where.current}:`), `the Current pane ends on the picture of where the talk is (${where.current}, key ${where.key.split(':').slice(0, 2).join(':')}, ${where.frames} picture)`)
    check(errors.length === 0, `no page errors (${errors.join(' | ')})`)
    await context.close()
  }

  // Step by step: after each step (and once the panes have settled) all three panes hold exactly the
  // picture of where the talk is, and again on the way back.
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${pathToFileURL(htmlPath).href}?presenter=1#rev1`)
    await page.waitForSelector('#currentPreview iframe')
    const settledPanes = () => page.waitForFunction((ids) => ids.every((id) => {
      const t = document.getElementById(id)
      return !t || t.classList.contains('preview-end') || !t.querySelector(':scope > iframe.preview-incoming, :scope > iframe.preview-outgoing')
    }), PANES, { timeout: 5000 })
    const wrong = []
    const compare = async (position) => {
      await settledPanes()
      const panes = await page.evaluate(paneSignatures, PANES)
      if (JSON.stringify(panes) !== JSON.stringify(EXPECTED[position])) wrong.push(`${position}: ${panes.join(' ; ')} (expected ${EXPECTED[position].join(' ; ')})`)
    }
    await page.waitForTimeout(400)
    await compare(0)
    for (let i = 1; i < EXPECTED.length; i++) { await page.keyboard.press('ArrowRight'); await compare(i) }
    for (let i = EXPECTED.length - 2; i >= 0; i--) { await page.keyboard.press('ArrowLeft'); await compare(i) }
    if (wrong.length) { failures++; console.error(`FAIL step by step: ${wrong.length} positions with a pane not where the talk is:\n  ${wrong.slice(0, 6).join('\n  ')}`) }
    else console.log(`PASS step by step: at all ${EXPECTED.length * 2 - 1} positions, forward and back, Current, Next and Then show where the talk is (slide, card, step)`)
    if (errors.length) { failures++; console.error(`FAIL step by step: page errors (${errors.join(' | ')})`) }
    await context.close()
  }
} finally {
  await browser?.close()
  await rm(scratch, { recursive: true, force: true })
}
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1) }
console.log('PASS presenter panes keep their picture until the next one is ready, at any stepping speed')
