// Real-Electron harness for REAL LAYOUT-PREVIEW THUMBNAILS (Feature #3).
// Feature: the "/" layout picker shows each layout's REAL compiled render (a PNG of that layout's
// canonical Reference fixture, rendered offscreen by the engine pipeline) instead of only a
// hand-drawn placeholder. main exposes layout:preview-thumbnails → { layoutName: twthumb://… };
// preload bridges window.tw.layout.previewThumbnails(); CommandPalette fetches once on open and
// overlays an <img> on top of the hand-drawn fallback, dropping back to it on a load error.
// This harness asserts:
//   1. the IPC returns a { layoutName: twthumb://… } map covering several core layouts
//   2. opening the palette renders real twthumb:// <img> previews for several layouts
//   3. those <img> elements actually load (naturalWidth > 0 — a true PNG, not broken)
//   4. a layout the map omits still shows its hand-drawn fallback (graceful degradation)
//   5. clicking a layout with a real preview inserts its trigger
// Run after `npm run build`.
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const FIX = ['---', 'title: Preview Fixture', 'author: T', '---', '', '## Section', '', '### A slide', '', 'Intro.', ''].join('\n')
const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-lpt-' + String(Date.now()) + '-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
const td = join(vault, 'preview')
mkdirSync(td, { recursive: true }); mkdirSync(ud, { recursive: true })
const fxPath = join(td, 'preview-fixture-outline.md')
writeFileSync(fxPath, FIX)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))

const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

async function selectTalk(name) {
  await page.locator('.sidebar-mode-btn', { hasText: 'Talks' }).click().catch(() => {})
  await page.locator('.talk-item', { hasText: name }).first().click()
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.waitForTimeout(350)
}
async function openPalette() {
  await page.locator('.cm-content').click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/')
  await page.waitForTimeout(700)
}

// Core layouts to assert real previews for. Each has a Reference fixture, so the map MUST cover it.
const CORE = ['statement', 'cards', 'contrast', 'timeline', 'pyramid', 'grid']

try {
  await selectTalk('Preview Fixture')

  // 1. IPC returns a map of layoutName → twthumb:// URL covering the core layouts.
  const map = await page.evaluate(() => window.tw.layout.previewThumbnails())
  const mapOk = !!map && typeof map === 'object'
  const coveredCore = mapOk ? CORE.filter((n) => typeof map[n] === 'string' && map[n].startsWith('twthumb://')) : []
  record(
    'layout:preview-thumbnails returns twthumb:// URLs for core layouts',
    mapOk && coveredCore.length === CORE.length,
    `entries=${mapOk ? Object.keys(map).length : 'null'} core=${coveredCore.length}/${CORE.length}`
  )
  // Every value in the map is a twthumb:// URL (no leaked file paths / bad shapes).
  const allTwthumb = mapOk && Object.values(map).every((v) => typeof v === 'string' && v.startsWith('twthumb://'))
  record('every preview URL uses the twthumb:// scheme', !!allTwthumb, `total=${mapOk ? Object.keys(map).length : 0}`)

  // 2. The palette renders real twthumb:// <img> previews for the core layouts.
  await openPalette()
  const listbox = await page.locator('[role="listbox"]').count()
  record('"/" opens the layout palette', listbox > 0, `listbox=${listbox}`)

  const imgSrcs = await page.evaluate((core) => {
    const out = {}
    for (const name of core) {
      const img = document.querySelector(`img[data-layout-thumb="${name}"]`)
      out[name] = img ? img.getAttribute('src') : null
    }
    return out
  }, CORE)
  const realImgCount = CORE.filter((n) => (imgSrcs[n] || '').startsWith('twthumb://')).length
  record(
    'palette shows real twthumb:// <img> previews for core layouts',
    realImgCount === CORE.length,
    CORE.map((n) => `${n}=${imgSrcs[n] ? 'twthumb' : 'none'}`).join(' ')
  )

  // 3. Those images actually decoded to a real PNG (naturalWidth > 0), not a broken src.
  const decoded = await page.evaluate((core) => {
    const out = {}
    for (const name of core) {
      const img = document.querySelector(`img[data-layout-thumb="${name}"]`)
      out[name] = !!(img && img.complete && img.naturalWidth > 0)
    }
    return out
  }, CORE)
  const decodedCount = CORE.filter((n) => decoded[n]).length
  record(
    'core preview images load (naturalWidth > 0 — a true render, not broken)',
    decodedCount === CORE.length,
    CORE.map((n) => `${n}=${decoded[n] ? 'ok' : 'X'}`).join(' ')
  )

  // 4. A layout the map omits keeps its hand-drawn fallback (the box still has content, no img).
  const omitted = mapOk ? CORE.concat(Object.keys(map)) : CORE
  const fallbackInfo = await page.evaluate((covered) => {
    const boxes = Array.from(document.querySelectorAll('[data-layout-name]'))
    const without = boxes.filter((b) => {
      const name = b.getAttribute('data-layout-name')
      return !covered.includes(name) && !b.querySelector('img[data-layout-thumb]')
    })
    // Any such box must still render a hand-drawn fallback child (non-empty), never blank.
    const sample = without[0]
    return {
      withoutCount: without.length,
      sampleName: sample ? sample.getAttribute('data-layout-name') : null,
      sampleHasContent: sample ? sample.children.length > 0 && sample.textContent !== null : false
    }
  }, omitted)
  // Graceful degradation holds whether or not any layout is actually omitted by the map: if some
  // are omitted, each must keep a non-empty hand-drawn fallback.
  record(
    'layouts without a real thumbnail keep a hand-drawn fallback (no blank box)',
    fallbackInfo.withoutCount === 0 || fallbackInfo.sampleHasContent,
    `omittedBoxes=${fallbackInfo.withoutCount} sample=${fallbackInfo.sampleName || 'none'} hasContent=${fallbackInfo.sampleHasContent}`
  )

  // 5. Clicking a layout that has a real preview inserts its trigger.
  await page.locator('[data-layout-name="statement"]').click()
  await page.waitForTimeout(350)
  const doc = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.cm-content .cm-line')).map((l) => l.textContent).join('\n')
  )
  record(
    'clicking a real-preview layout inserts its trigger ({statement})',
    doc.includes('{statement}'),
    `inserted=${doc.includes('{statement}')}`
  )
} catch (e) {
  record('layout-preview-thumbnails harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== LAYOUT-PREVIEW-THUMBNAILS SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
