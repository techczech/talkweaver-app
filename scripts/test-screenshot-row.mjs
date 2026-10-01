#!/usr/bin/env node
/**
 * ADR-0033 §4 — two or three screenshots are always ONE row, in window frames (default) or fanned.
 *
 * Three seams:
 *   1. the arithmetic (planScreenshotRow / screenshotBand / resolveScreenshotStyle): sizes come
 *      from the band and the images' aspect ratios, not from per-slide constants;
 *   2. the registry: the option group and the deck default are registered and the tokens are in
 *      the compiler's dictionary;
 *   3. compiled HTML laid out in headless Chromium on three specimen shapes — portrait forms on an
 *      image grid (cs22), wide charts on an image grid (cs17), and three previews on a media-only
 *      slide beside a title rail (ex16) — in both treatments.
 */
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lib = (name) => import(pathToFileURL(join(root, 'compiler/scripts/lib', name)).href)
const {
  resolveScreenshotStyle, planScreenshotRow, screenshotBand, sizeScreenshotRows, SCREENSHOT_STYLES
} = await lib('screenshot-row.mjs')
const { prepareSource } = await lib('08-source-adapters.mjs')
let checks = 0
const ok = (condition, message) => { assert.ok(condition, message); checks += 1 }

// ── 1. arithmetic ────────────────────────────────────────────────────────────────────────────────
ok(SCREENSHOT_STYLES.join() === 'frames,fanned', 'two treatments, frames first')
ok(resolveScreenshotStyle({}, {}) === 'frames', 'default is window frames')
ok(resolveScreenshotStyle({ screenshots: 'fanned' }, {}) === 'fanned', 'slide token')
ok(resolveScreenshotStyle({}, { screenshot_style: 'fanned' }) === 'fanned', 'deck default')
ok(resolveScreenshotStyle({}, { 'screenshot-style': 'fanned' }) === 'fanned', 'deck default, hyphen alias')
ok(resolveScreenshotStyle({ screenshots: 'frames' }, { screenshot_style: 'fanned' }) === 'frames', 'slide beats deck')
ok(resolveScreenshotStyle({ screenshots: 'neon' }, { screenshot_style: 'fanned' }) === 'fanned', 'unknown slide token falls to the deck')
ok(resolveScreenshotStyle({}, { screenshot_style: 'neon' }) === 'frames', 'unknown deck value falls to frames')

const wide = screenshotBand({ titleMode: 'top', title: 'How fast is this changing?' })
const twoLines = screenshotBand({ titleMode: 'top', title: 'York expenses: from email chains to completed forms in one afternoon' })
const rail = screenshotBand({ titleMode: 'left', split: '35' })
ok(wide.h > twoLines.h, 'a two-line title leaves a shorter band than a one-line title')
ok(wide.w === twoLines.w && wide.w > 1100, 'a top title leaves the full content width')
ok(rail.w < 720 && rail.w > 650 && rail.h === 648, `a 35% rail leaves a narrow, full-height band (got ${JSON.stringify(rail)})`)
ok(screenshotBand({ titleMode: 'left', split: '50' }).w < rail.w, 'a wider rail narrows the band')
ok(screenshotBand({ titleMode: 'top', title: 'x', titleShown: false }).h === 648, 'no painted title, whole height')

const portrait = [0.756, 0.727, 0.707]
const charts = [2.77, 2.68, 2.12]
for (const band of [wide, twoLines, rail]) {
  for (const captions of [true, false]) {
    for (const aspects of [portrait, charts]) {
      const f = planScreenshotRow({ style: 'frames', aspects, captions, band })
      ok(f.fh <= band.h - (captions ? 52 : 0), `frame fits the band (${JSON.stringify({ f, band })})`)
      ok(f.z >= 1.25 && f.z <= 2, `zoom in range (${f.z})`)
      const p = planScreenshotRow({ style: 'fanned', aspects, captions, band })
      const width = aspects.reduce((a, b) => a + b, 0) * p.ph + 3 * 18 + 2 * p.ov
      ok(width <= band.w, `fan fits the band width (${width} > ${band.w})`)
      ok(p.ov < 0 && -p.ov <= 0.18 * (aspects.reduce((a, b) => a + b, 0) * p.ph / 3 + 18) + 0.5, `overlap within its cap (${p.ov})`)
      ok(p.ph + 18 <= band.h - (captions ? 52 : 0), `print fits the band height (${p.ph})`)
    }
  }
}
const fPortrait = planScreenshotRow({ style: 'frames', aspects: portrait, band: wide })
const fCharts = planScreenshotRow({ style: 'frames', aspects: charts, band: wide })
ok(fCharts.fh < fPortrait.fh, 'wide charts get a shorter frame than portrait pages')
ok(fCharts.z > fPortrait.z, 'wide charts are cropped at a higher zoom than portrait pages')
ok(planScreenshotRow({ style: 'frames', aspects: charts, band: wide }).fh === fCharts.fh, 'the same inputs give the same numbers')
const bigger = planScreenshotRow({ style: 'frames', aspects: portrait, band: { w: wide.w, h: wide.h + 100 } })
ok(bigger.fh >= fPortrait.fh, 'more band never shrinks the frame')
ok(planScreenshotRow({ style: 'fanned', aspects: charts, band: wide }).ph < planScreenshotRow({ style: 'fanned', aspects: portrait, band: wide }).ph,
  'a row of wide prints is shorter than a row of portrait prints (the band width is the limit)')

const marked = '<div class="image-grid ig-shot-row" data-shot-row="frames" data-shot-aspects="0.7,0.7,0.7" data-shot-captions="1" style="--ig-cols:3"></div>'
const sized = sizeScreenshotRows(marked, wide)
ok(/--sr-fh:[\d.]+px;--sr-z:[\d.]+/.test(sized) && sized.includes('--ig-cols:3;'), 'sizeScreenshotRows stamps the frame numbers onto the row')
ok(sizeScreenshotRows('<div class="image-grid" style="--ig-cols:2"></div>', wide) === '<div class="image-grid" style="--ig-cols:2"></div>', 'an unmarked row is untouched')

// ── 2. registry ──────────────────────────────────────────────────────────────────────────────────
const registrySource = readFileSync(join(root, 'src/shared/layout-registry/entries.ts'), 'utf8')
ok(registrySource.includes("key: 'screenshot-row'") && registrySource.includes('screenshots=fanned') && registrySource.includes('screenshots=frames'),
  'the option group is registered with both tokens')
const metadataSource = readFileSync(join(root, 'src/shared/metadata-registry.ts'), 'utf8')
ok(metadataSource.includes("key: 'screenshot_style'") && metadataSource.includes("aliases: ['screenshot-style']"), 'the deck default is registered')
const dictionary = (await lib('trigger-dictionary.generated.mjs'))
ok(JSON.stringify(dictionary).includes('"screenshots"'), 'the generated trigger dictionary knows {screenshots=…}')

// ── 3. layout ────────────────────────────────────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'screenshot-row-'))
mkdirSync(join(work, 'assets'))
const png = async (name, width, height, colour) => {
  const file = join(work, 'assets', name)
  await sharp({ create: { width, height, channels: 3, background: colour } }).png().toFile(file)
  return `assets/${name}`
}
const forms = [await png('f1.png', 840, 1111, '#f4f4f4'), await png('f2.png', 789, 1085, '#efefef'), await png('f3.png', 707, 1000, '#fafafa')]
const chartImgs = [await png('c1.png', 1168, 421, '#e8f0ff'), await png('c2.png', 1168, 436, '#ffeee8'), await png('c3.png', 1168, 551, '#e8ffee')]
const previews = [await png('p1.png', 1004, 891, '#e6ecf2'), await png('p2.png', 536, 451, '#f2ece6'), await png('p3.png', 524, 711, '#ecf2e6')]

const outline = (screenshots) => `---
title: Screenshot rows
auto_title_slide: false
auto_thanks_slide: false
---

## Rows

### York expenses: from email to completed forms
{image-grid} {id=forms}${screenshots}

![Original form](${forms[0]})
- Blank form

![Completed claim](${forms[1]})
- Completed form
![Completed bank form](${forms[2]})
- Completed word form

### How fast is this changing?
{image-grid} {id=charts}${screenshots}

![Timeline one](${chartImgs[0]})
- GPT and Claude release cadence

![Timeline two](${chartImgs[1]})
- Muse and Gemini release cadence

![Index](${chartImgs[2]})
- Model improvements

### What I know about participants
{id=previews} {sidebar}${screenshots}

![](${previews[0]})

![](${previews[1]})

![](${previews[2]})
`

const browser = await chromium.launch({ headless: true })
try {
  for (const treatment of ['frames', 'fanned']) {
    const path = join(work, `${treatment}-outline.md`)
    const text = outline(treatment === 'fanned' ? ' {screenshots=fanned}' : '')
    writeFileSync(path, text)
    const model = await prepareSource(path, text, `rows-${treatment}`, statSync(path), { warnAtMinutes: 5, urgentAtMinutes: 1 }, {})
    const deck = join(work, `${treatment}.html`)
    writeFileSync(deck, model.fullHtml)
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
    await page.goto(pathToFileURL(deck).href + '?audience=1', { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    for (const id of ['forms', 'charts', 'previews']) {
      const label = `${treatment} ${id}`
      await page.evaluate((target) => { location.hash = target }, id)
      await page.waitForTimeout(700)
      const m = await page.evaluate(() => {
        const box = (el) => { const b = el.getBoundingClientRect(); return { x: b.x / 1.5, y: b.y / 1.5, w: b.width / 1.5, h: b.height / 1.5 } }
        const slide = document.querySelector('.stage > .slide.active')
        const content = slide.querySelector(':scope > .slide-content')
        const row = slide.querySelector('[data-shot-row]')
        const units = [...row.querySelectorAll(':scope > .ig-cell .ig-media, :scope > figure:not(.ig-cell)')]
        return {
          style: row.dataset.shotRow, vars: row.getAttribute('style'),
          zoom: content.style.zoom || '', overflow: content.scrollHeight - content.clientHeight,
          slideH: box(slide).h, contentBox: box(content), row: box(row),
          units: units.map((u) => ({ ...box(u), transform: getComputedStyle(u).transform })),
          images: units.map((u) => { const i = u.querySelector('img'); return { ...box(i), offsetH: i.offsetHeight, fit: getComputedStyle(i).objectFit, pos: getComputedStyle(i).objectPosition, nw: i.naturalWidth } }),
          barBefore: units.map((u) => getComputedStyle(u, '::before').height),
          lightboxImages: document.querySelectorAll('.slide.active figure.slide-figure img, .slide.active .ig-media img').length
        }
      })
      ok(m.style === treatment, `${label}: treatment stamped`)
      ok(m.units.length === 3, `${label}: three units ${JSON.stringify(m).slice(0, 700)}`)
      ok(m.images.every((i) => i.nw > 0), `${label}: images loaded`)
      // ONE row: no unit starts a new line; the units run left to right.
      const tops = m.units.map((u) => Math.round(u.y))
      if (treatment === 'frames') {
        ok(Math.max(...tops) - Math.min(...tops) <= 1, `${label}: frames share one top edge (${tops})`)
        ok(m.units.every((u, k) => k === 0 || u.x > m.units[k - 1].x + m.units[k - 1].w - 1), `${label}: frames run left to right, none wrapped or overlapping`)
      } else {
        ok(Math.max(...tops) - Math.min(...tops) < 30, `${label}: prints share one line, turned (${tops})`)
        ok(m.units.every((u, k) => k === 0 || u.x > m.units[k - 1].x), `${label}: prints run left to right`)
        ok(m.units[0].transform !== 'none' && m.units[1].transform !== 'none' && m.units[2].transform !== 'none', `${label}: every print is turned`)
      }
      ok(m.units.every((u) => u.x >= m.row.x - 30 && u.x + u.w <= m.row.x + m.row.w + 30), `${label}: the row stays inside its band`)
      ok(m.overflow <= 0 && m.zoom === '', `${label}: the slide does not overflow, so the fit pass does not shrink it (overflow ${m.overflow}, zoom '${m.zoom}')`)
      ok(m.row.y >= 0 && m.row.y + m.row.h <= 720, `${label}: inside the stage`)
      if (treatment === 'frames') {
        const fh = Number(/--sr-fh:([\d.]+)px/.exec(m.vars)[1]), z = Number(/--sr-z:([\d.]+)/.exec(m.vars)[1])
        ok(m.units.every((u) => Math.abs(u.h - fh) < 1.5), `${label}: frame height is the compiler's number (${fh})`)
        ok(m.barBefore.every((h) => h === '26px'), `${label}: 26px title bar`)
        ok(m.images.every((i, k) => i.w > m.units[k].w * (z - 0.02)), `${label}: pictures are drawn at ${z}x the frame width, cropped rather than shrunk`)
        ok(m.images.every((i) => i.fit === 'cover' && i.pos.startsWith('0%')), `${label}: cropped from the top-left`)
      } else {
        const ph = Number(/--sr-ph:([\d.]+)px/.exec(m.vars)[1]), ov = Number(/--sr-ov:(-[\d.]+)px/.exec(m.vars)[1])
        ok(m.images.every((i) => Math.abs(i.offsetH - ph) < 1.5), `${label}: prints are the compiler's height (${ph})`)
        ok(ov < 0, `${label}: prints overlap (${ov})`)
      }
      ok(m.lightboxImages === 3, `${label}: the gallery still has the three images`)
    }
    // The gallery opens each image (Z) and steps through all three.
    await page.evaluate(() => { location.hash = 'forms' })
    await page.waitForTimeout(500)
    await page.keyboard.press('z')
    await page.waitForTimeout(200)
    const gallery = await page.evaluate(() => ({ open: document.getElementById('lightbox').classList.contains('open'), counter: document.getElementById('lightboxCounter')?.textContent || '' }))
    ok(gallery.open && /1\s*\/\s*3/.test(gallery.counter), `${treatment}: the gallery opens with all three images (${gallery.counter})`)
    await page.close()
  }
  // Sizes differ by aspect ratio in the compiled decks too (not one constant for every slide).
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  await page.goto(pathToFileURL(join(work, 'frames.html')).href + '?audience=1', { waitUntil: 'load' })
  const vars = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.slide')].map((s) => [s.dataset.id, s.querySelector('[data-shot-row]')?.getAttribute('style')])))
  ok(vars.forms !== vars.charts && vars.charts !== vars.previews, 'each row carries its own numbers')
  await page.close()
} finally {
  await browser.close()
  rmSync(work, { recursive: true, force: true })
}
console.log(`PASS screenshot rows: ${checks} checks (arithmetic, registry, one row in frames and fanned on portrait forms, wide charts and a title rail)`)
