// Presenter pane flicker probe: steps a compiled deck in the presenter view (headless Chromium) and
// samples the Current, Next and Then panes on EVERY animation frame of the presenter window. A frame
// counts as a flicker frame for a pane when the picture on show is missing (no visible picture),
// blank (its document has no slide yet), unstyled (the deck stylesheet is not applied) or not yet
// loaded. Also times, per step, the audience window's next frame after the key press.
//
// Usage: node scripts/perf/presenter-pane-flicker.mjs [--root=<checkout>] [--json=<out>]
//   --root: the checkout whose compiler builds the deck (default: this one), to compare releases.
// Runs a synthetic talk only (no owner content).
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const root = resolve(args.root || join(dirname(fileURLToPath(import.meta.url)), '..', '..'))
const { prepareSource } = await import(pathToFileURL(join(root, 'compiler/scripts/lib/08-source-adapters.mjs')).href)

import { flickerFixture } from '../lib/presenter-step-fixture.mjs'

// Injected into the presenter window: one record per animation frame.
function installSampler() {
  const panes = ['currentPreview', 'nextPreview', 'followingPreview']
  const log = []
  window.__flicker = { log, step: 0 }
  const paneState = (id) => {
    const t = document.getElementById(id)
    if (!t) return 'nopane'
    if (t.classList.contains('preview-end')) return 'end'
    if (t.classList.contains('preview-live-sim') || t.classList.contains('preview-live-page')) return 'live'
    const shown = [...t.querySelectorAll(':scope > iframe:not(.live-sim-frame)')].filter((f) => getComputedStyle(f).visibility !== 'hidden' && getComputedStyle(f).display !== 'none')
    if (!shown.length) return 'missing'
    const f = shown[shown.length - 1]
    let doc
    try { doc = f.contentDocument } catch { return 'ok' }
    if (!doc || !doc.querySelector('.stage .slide')) return 'blank'
    const stage = doc.querySelector('.stage')
    if (doc.defaultView.getComputedStyle(stage).containerType !== 'size') return 'unstyled'
    if (doc.readyState !== 'complete') return 'loading'
    return 'ok'
  }
  const tick = () => {
    log.push({ t: performance.now(), step: window.__flicker.step, panes: panes.map(paneState), frames: panes.map((id) => document.querySelectorAll(`#${id} > iframe`).length) })
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

// A pane is blank in a screencast frame when almost every pixel in it has the same colour.
async function analyseShots(context, shots, rects) {
  const page = await context.newPage()
  await page.evaluate(() => { window.__vw = 1440 })
  const out = { frames: shots.length, blankFrames: 0, perPane: [0, 0, 0], steps: new Set() }
  for (const shot of shots) {
    const blank = await page.evaluate(async ({ data, rects }) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode()
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
      const g = c.getContext('2d'); g.drawImage(img, 0, 0)
      const sx = img.width / window.__vw
      return rects.map((r) => {
        if (!r || r.w < 10) return false
        const d = g.getImageData(Math.round(r.x * sx) + 4, Math.round(r.y * sx) + 4, Math.round(r.w * sx) - 8, Math.round(r.h * sx) - 8).data
        const counts = new Map(); let n = 0
        for (let i = 0; i < d.length; i += 16) { const k = (d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3); counts.set(k, (counts.get(k) || 0) + 1); n++ }
        return Math.max(...counts.values()) / n > 0.995
      })
    }, { data: shot.data, rects }).catch(() => [false, false, false])
    if (blank.some(Boolean)) { out.blankFrames++; out.steps.add(shot.step) }
    blank.forEach((b, i) => { if (b) out.perPane[i]++ })
  }
  await page.close()
  out.stepsWithBlank = out.steps.size; delete out.steps
  return out
}

const scratch = await mkdtemp(join(tmpdir(), 'tw-pane-flicker-'))
let browser
try {
  const sourcePath = join(scratch, 'flicker.md')
  await writeFile(sourcePath, flickerFixture)
  const model = await prepareSource(sourcePath, flickerFixture, null, statSync(sourcePath), {}, {})
  const htmlPath = join(scratch, 'flicker.html')
  await writeFile(htmlPath, model.fullHtml)
  browser = await chromium.launch({ headless: true })
  const results = {}
  const runs = [
    { name: 'slow', gap: 600, steps: 30 },
    { name: 'rapid', gap: 120, steps: 40 },
    { name: 'held', gap: 50, steps: 40, repeat: true },
  ]
  for (const run of runs) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const presenter = await context.newPage()
    const errors = []
    presenter.on('pageerror', (e) => errors.push(e.message))
    await presenter.goto(`${pathToFileURL(htmlPath).href}?presenter=1#rev1`)
    await presenter.waitForSelector('#currentPreview iframe')
    await presenter.waitForTimeout(1500)
    await presenter.evaluate(installSampler)
    // The screencast: every frame the compositor produces, with the panes' places for the pixel check.
    const rects = await presenter.evaluate(() => ['currentPreview', 'nextPreview', 'followingPreview'].map((id) => { const r = document.getElementById(id)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null }))
    const cdp = await context.newCDPSession(presenter)
    const shots = []
    let stepNow = 0
    cdp.on('Page.screencastFrame', (f) => { shots.push({ step: stepNow, data: f.data }); cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}) })
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
    await presenter.waitForTimeout(300)
    for (let i = 0; i < run.steps; i++) {
      await presenter.evaluate((n) => { window.__flicker.step = n }, i + 1)
      stepNow = i + 1
      if (run.repeat && i > 0) await presenter.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', repeat: true, bubbles: true })))
      else await presenter.keyboard.press('ArrowRight')
      await presenter.waitForTimeout(run.gap)
    }
    await presenter.waitForTimeout(1500)
    await cdp.send('Page.stopScreencast')
    const pixels = await analyseShots(context, shots.filter((s) => s.step > 0), rects)
    const log = await presenter.evaluate(() => window.__flicker.log)
    const during = log.filter((r) => r.step > 0)
    const bad = during.filter((r) => r.panes.some((p) => !['ok', 'end', 'live', 'nopane'].includes(p)))
    const byKind = {}
    for (const r of bad) for (const p of r.panes) if (!['ok', 'end', 'live', 'nopane'].includes(p)) byKind[p] = (byKind[p] || 0) + 1
    const perPane = [0, 1, 2].map((i) => during.filter((r) => !['ok', 'end', 'live', 'nopane'].includes(r.panes[i])).length)
    const maxFrames = Math.max(...during.map((r) => Math.max(...r.frames)))
    const stepsWithFlicker = new Set(bad.map((r) => r.step)).size
    results[run.name] = { frames: during.length, flickerFrames: bad.length, stepsWithFlicker, steps: run.steps, byKind, perPane: { current: perPane[0], next: perPane[1], then: perPane[2] }, maxIframesInAPane: maxFrames, errors, screencast: pixels }
    await context.close()
  }
  console.log(JSON.stringify({ root, results }, null, 2))
  if (args.json) await writeFile(args.json, JSON.stringify({ results }, null, 2))
} finally {
  await browser?.close()
  await rm(scratch, { recursive: true, force: true })
}
