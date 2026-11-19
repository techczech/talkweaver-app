// Step speed probe: a presenter window and an audience window of one compiled deck (headless
// Chromium, one browser context, paired as the app pairs them), stepped with the arrow key. Per step:
//   audienceFrame  key press in the presenter → the audience window's frame after its last change;
//   panesReady     key press → every presenter pane shows its new picture (no successor waiting).
// Usage: node scripts/perf/presenter-step-speed.mjs [--root=<checkout>] [--steps=40] [--gap=400]
// Runs the synthetic talk of presenter-pane-flicker.mjs only (no owner content).
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const root = resolve(args.root || join(dirname(fileURLToPath(import.meta.url)), '..', '..'))
const steps = Number(args.steps || 40)
const gap = Number(args.gap || 400)
const { prepareSource } = await import(pathToFileURL(join(root, 'compiler/scripts/lib/08-source-adapters.mjs')).href)
const { flickerFixture: fixture } = await import('../lib/presenter-step-fixture.mjs')

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }
const p90 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length * 0.9)] : null }

const scratch = await mkdtemp(join(tmpdir(), 'tw-step-speed-'))
let browser
try {
  const sourcePath = join(scratch, 'speed.md')
  await writeFile(sourcePath, fixture)
  const model = await prepareSource(sourcePath, fixture, null, statSync(sourcePath), {}, {})
  const htmlPath = join(scratch, 'speed.html')
  await writeFile(htmlPath, model.fullHtml)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const audience = await context.newPage()
  await audience.goto(`${pathToFileURL(htmlPath).href}?audience=1&session=speed#rev1`)
  const presenter = await context.newPage()
  await presenter.goto(`${pathToFileURL(htmlPath).href}?presenter=1&session=speed#rev1`)
  await presenter.waitForSelector('#currentPreview iframe')
  await presenter.waitForTimeout(2000)
  await audience.evaluate(() => {
    window.__changes = []
    const now = () => performance.timeOrigin + performance.now()
    new MutationObserver(() => {
      const t = now()
      requestAnimationFrame(() => window.__changes.push({ t, frame: now() }))
    }).observe(document.querySelector('.deck') || document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'data-mode-state', 'style'], childList: true })
  })
  await presenter.evaluate(() => {
    window.__keys = []
    window.__ready = []
    const now = () => performance.timeOrigin + performance.now()
    window.addEventListener('keydown', () => window.__keys.push(now()), true)
    const ids = ['currentPreview', 'nextPreview', 'followingPreview']
    let waiting = false
    const check = () => {
      const pending = ids.some((id) => { const t = document.getElementById(id); return t && (t.querySelector(':scope > iframe.preview-incoming') || [...t.querySelectorAll(':scope > iframe')].some((f) => f.contentDocument?.readyState !== 'complete')) })
      if (pending) waiting = true
      else if (waiting) { waiting = false; window.__ready.push(now()) }
      requestAnimationFrame(check)
    }
    requestAnimationFrame(check)
  })
  for (let i = 0; i < steps; i++) {
    await presenter.keyboard.press('ArrowRight')
    await presenter.waitForTimeout(gap)
  }
  await presenter.waitForTimeout(800)
  const keys = await presenter.evaluate(() => window.__keys)
  const ready = await presenter.evaluate(() => window.__ready)
  const changes = await audience.evaluate(() => window.__changes)
  const audienceFrame = [], panesReady = []
  keys.forEach((k, i) => {
    const end = keys[i + 1] ?? Infinity
    const mine = changes.filter((c) => c.t >= k && c.t < end)
    if (mine.length) audienceFrame.push(Math.max(...mine.map((c) => c.frame)) - k)
    const r = ready.filter((t) => t >= k && t < end)
    if (r.length) panesReady.push(Math.max(...r) - k)
  })
  const out = { root, steps: keys.length, audienceFrame: { n: audienceFrame.length, median: median(audienceFrame), p90: p90(audienceFrame) }, panesReady: { n: panesReady.length, median: median(panesReady), p90: p90(panesReady) } }
  console.log(JSON.stringify(out))
  await context.close()
} finally {
  await browser?.close()
  await rm(scratch, { recursive: true, force: true })
}
