#!/usr/bin/env node
/**
 * Desktop slide-rendering regression net (ADR-0018).
 *
 * The phone work converts the deck's viewport-relative sizing to canvas-relative sizing and removes
 * the max-width rules that reflow slide internals. None of that is allowed to change what a slide
 * looks like on a desktop — that is the whole safety property of the migration.
 *
 * Storing 126 full screenshots in git is not worth 13MB, so this stores a compact perceptual
 * signature per slide: a 64x36 greyscale downsample (2304 bytes, base64). That is coarse enough to
 * ignore antialiasing noise and sensitive enough to catch a column collapsing, a block moving, or
 * type changing size — which is exactly the failure class being guarded.
 *
 *   node scripts/test-slide-canvas-regression.mjs            # compare against the baseline
 *   node scripts/test-slide-canvas-regression.mjs --update   # re-record the baseline (deliberate)
 *
 * Re-record ONLY when a slide's desktop appearance is meant to change, and say so in the commit.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { buildLayoutSampler } from './build-layout-sampler.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = join(root, 'docs/slide-canvas-baseline.json')
const UPDATE = process.argv.includes('--update')
const UPDATE_INDEX = process.argv.indexOf('--update')
const UPDATE_IDS = UPDATE
  ? process.argv.slice(UPDATE_INDEX + 1).filter((argument) => !argument.startsWith('--'))
  : []

const W = 64, H = 36            // 16:9 signature grid (each cell ~22x25 real px at 1440x900)
const TOLERANCE = 2             // mean abs difference per pixel (0-255) treated as noise
const VIEWPORT = { width: 1440, height: 900 }

const { outPath } = await buildLayoutSampler()

const browser = await chromium.launch({ headless: true })
const signatures = {}
try {
  const page = await browser.newPage({ viewport: VIEWPORT })
  await page.goto('file://' + outPath)
  await page.waitForTimeout(700)

  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('.slide')].map((s, i) => s.dataset.id || `slide-${i}`))

  for (let i = 0; i < ids.length; i++) {
    // Show exactly one slide, then call the runtime's normal lazy Mermaid path for that slide.
    await page.evaluate((n) => {
      const all = document.querySelectorAll('.slide')
      all.forEach((slide, index) => slide.classList.toggle('active', index === n))
      window.__initMermaidsForCanvasTest?.(all[n])
    }, i)
    const mermaidHosts = page.locator('.slide.active .mermaid-mm')
    if (await mermaidHosts.count()) {
      await page.locator('.slide.active .mermaid-mm[data-mmd-done="1"]').first().waitFor({ timeout: 5000 })
      await page.waitForFunction(
        () => [...document.querySelectorAll('.slide.active .mermaid-mm[data-mmd-done="1"]')]
          .every((host) => host.querySelector('svg, .mmd-error')),
        undefined,
        { timeout: 5000 }
      )
    }
    await page.waitForTimeout(45)
    const shot = await page.locator('.slide.active').first().screenshot()
    const raw = await sharp(shot).resize(W, H, { fit: 'fill' }).greyscale().raw().toBuffer()
    signatures[ids[i]] = raw.toString('base64')
  }
  console.log(`captured ${ids.length} slide signatures at ${VIEWPORT.width}x${VIEWPORT.height}`)
} finally {
  await browser.close()
}

if (UPDATE || !existsSync(BASELINE)) {
  const existed = existsSync(BASELINE)
  const previous = existed
    ? JSON.parse(readFileSync(BASELINE, 'utf8'))
    : { viewport: VIEWPORT, grid: [W, H], signatures: {} }
  const beforeCount = Object.keys(previous.signatures).length
  const nextSignatures = UPDATE_IDS.length ? { ...previous.signatures } : signatures
  for (const id of UPDATE_IDS) {
    if (!(id in signatures)) throw new Error(`Cannot update missing slide signature: ${id}`)
    nextSignatures[id] = signatures[id]
  }
  const afterCount = Object.keys(nextSignatures).length
  writeFileSync(
    BASELINE,
    JSON.stringify({ ...previous, viewport: VIEWPORT, grid: [W, H], signatures: nextSignatures }, null, 1) + '\n'
  )
  console.log(`${existed && UPDATE ? 'Re-recorded' : 'Recorded'} baseline: ${BASELINE}`)
  console.log(`baseline entries: ${beforeCount} -> ${afterCount}; updated ${UPDATE_IDS.length ? UPDATE_IDS.join(', ') : 'all signatures'}`)
  console.log('If this was not a deliberate visual change, revert it.')
  process.exit(0)
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
const drift = []
let compared = 0

for (const [id, sig] of Object.entries(signatures)) {
  const was = baseline.signatures[id]
  if (!was) { drift.push({ id, reason: 'new slide, no baseline' }); continue }
  compared++
  const a = Buffer.from(was, 'base64')
  const b = Buffer.from(sig, 'base64')
  if (a.length !== b.length) { drift.push({ id, reason: 'signature size changed' }); continue }
  let total = 0
  let peak = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i])
    total += d
    if (d > peak) peak = d
  }
  const mean = total / a.length
  if (mean > TOLERANCE) drift.push({ id, reason: `mean pixel drift ${mean.toFixed(1)} (peak ${peak})` })
}

for (const id of Object.keys(baseline.signatures)) {
  if (!(id in signatures)) drift.push({ id, reason: 'slide disappeared from the sampler' })
}

if (drift.length) {
  console.error(`\nFAIL: ${drift.length} slide(s) changed on the DESKTOP.`)
  for (const d of drift.slice(0, 20)) console.error(`  ${d.id}: ${d.reason}`)
  if (drift.length > 20) console.error(`  … and ${drift.length - 20} more`)
  console.error('\nADR-0018: the phone work must not alter desktop rendering. Either fix the')
  console.error('regression, or — if the change is deliberate — re-record with --update and say so.')
  process.exit(1)
}

console.log(`slide canvas regression: ${compared} slides identical on desktop (tolerance ${TOLERANCE})`)
