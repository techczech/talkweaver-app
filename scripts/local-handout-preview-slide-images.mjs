#!/usr/bin/env node
// Exports chosen slides of a talk as PNGs (<= 1600 px wide) from the local handout preview, by following
// the stub live session slide by slide. For handing real slides to a designer.
//   node scripts/local-handout-preview-slide-images.mjs --out <dir> [--talk <outline.md>] [--slides 1,3,12,24,27,38]
// --slides are 1-based slide numbers.
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { findLayoutShowcase, startLocalHandoutPreview } from './local-handout-preview.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const outDir = resolve(opt('--out') ?? join(REPO, '.local-handout-preview/slide-images'))
const wanted = (opt('--slides') ?? '1,3,12,24,27,38').split(',').map(Number)
mkdirSync(outDir, { recursive: true })

const preview = await startLocalHandoutPreview({ talk: opt('--talk') ?? findLayoutShowcase(), port: 0, out: join(REPO, '.local-handout-preview') })
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.7 })
  const control = (action) => page.request.post(`${preview.baseUrl}/control/api/${action}`, { data: {} })
  await control('end')
  await page.goto(`${preview.baseUrl}/${preview.slug}/`)
  await control('start')
  await page.waitForFunction(() => document.getElementById('liveFollowStatus')?.textContent === 'live', null, { timeout: 15000 })
  let at = 1
  for (const n of wanted) {
    while (at < n) { await control('next'); at++ }
    await page.waitForFunction((id) => document.querySelector('#hhLive .slide.active')?.getAttribute('data-id') === id, preview.slideIds[n - 1], { timeout: 10000 })
    await page.waitForTimeout(600)
    const file = join(outDir, `slide-${String(n).padStart(2, '0')}-${preview.slideIds[n - 1]}.png`)
    await page.locator('#hhLive #stageFit').screenshot({ path: file })
    console.log(file)
  }
} finally {
  await browser.close()
  await preview.close()
}
