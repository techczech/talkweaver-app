// Real-Electron check of the slide menu's icon picker (``` → Insert icon…, IconPicker.tsx): catalogue
// brand marks that are an embedded PNG (METR; Developer Student Club, through <use>) are drawn as their
// picture, not as initials, and an SVG brand
// (Python) is drawn as its paths. Both go through sanitiseIconSvg at the point of injection.
// Run after `npm run build`: node e2e/diagnose-icon-picker-raster.mjs
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const FIX = ['---', 'title: Raster Icon Fixture', '---', '', '## Section', '', '### Labs', '', 'Some text.', ''].join('\n')
const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-icon-raster-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
mkdirSync(join(vault, 'raster'), { recursive: true }); mkdirSync(ud, { recursive: true })
writeFileSync(join(vault, 'raster', 'raster-icon-fixture-outline.md'), FIX)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault, editorViewMode: 'markdown' }, null, 2))

await ensureFreshBuild(REPO)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO, env: { ...process.env, TW_E2E: '1' } })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

async function glyphOf(key) {
  const card = page.locator(`[data-icon-key="${key}"]`).first()
  await card.waitFor({ timeout: 5000 })
  await page.waitForFunction((k) => {
    const node = document.querySelector(`[data-icon-key="${k}"]`)
    return !!node && (!!node.querySelector('svg') || node.textContent.trim().length > 0)
  }, key, { timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(400)
  return card.evaluate(async (node) => {
    const svg = node.querySelector('svg')
    const image = svg?.querySelector('image')
    const img = image?.getAttribute('href') ?? image?.getAttribute('xlink:href') ?? ''
    const uses = svg ? Array.from(svg.querySelectorAll('use')).map((use) => use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '') : []
    // What the injected markup actually paints: draw it to a canvas and count the pixels it covers.
    // (A picture reached through <use> in a pattern has no box of its own, so its box says nothing.)
    let painted = 0
    if (svg) {
      const copy = svg.cloneNode(true)
      copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      copy.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')
      copy.setAttribute('width', '64'); copy.setAttribute('height', '64')
      const picture = new Image()
      picture.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(copy))
      try { await picture.decode() } catch { /* painted stays 0 */ }
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64
      const context = canvas.getContext('2d')
      context.drawImage(picture, 0, 0, 64, 64)
      const data = context.getImageData(0, 0, 64, 64).data
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++
    }
    return { svg: !!svg, image: !!image, imageHref: img.slice(0, 22), uses, painted, paths: svg ? svg.querySelectorAll('path').length : 0, text: svg ? '' : node.innerText.trim().split('\n')[0] }
  })
}

try {
  await openTalkByTitle(page, 'Raster Icon Fixture')
  await page.waitForTimeout(1200)
  const keys = await page.evaluate(async () => {
    const find = async (query, test) => ((await window.tw.icons.search(query)) || []).find((hit) => test.test(hit.key))?.key ?? null
    return { metr: await find('metr', /(^|:)metr$/), dsc: await find('developer student club', /(^|:)developer-student-club$/), python: await find('python', /^svgl:python$/) }
  })
  record('the catalogue has the METR and Developer Student Club raster marks and the Python SVG brand', !!keys.metr && !!keys.dsc && !!keys.python, JSON.stringify(keys))

  // The slide menu: ``` on a new line opens Insert object; its Insert icon… row opens the picker.
  await page.locator('.cm-content .cm-line', { hasText: 'Some text.' }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('```')
  const menu = page.locator('[data-slide-menu]')
  await menu.waitFor({ state: 'visible', timeout: 3000 })
  await menu.locator('[data-slide-action="icon"]').click()
  const search = page.locator('[data-icon-search]')
  await search.waitFor({ timeout: 3000 })
  record('``` → Insert icon… opens the icon picker', await search.count() === 1)

  await search.fill('metr')
  await page.waitForTimeout(500)
  const metr = await glyphOf(keys.metr)
  record('METR (embedded PNG) is drawn as its picture, not initials',
    metr.svg && metr.image && metr.painted > 500 && /^data:image\/png;base64,/.test(metr.imageHref), JSON.stringify(metr))

  await search.fill('developer student club')
  await page.waitForTimeout(500)
  const dsc = await glyphOf(keys.dsc)
  record('Developer Student Club (PNG through <use> in a pattern) is drawn as its picture, not initials',
    dsc.svg && dsc.image && dsc.uses.length === 1 && /^#/.test(dsc.uses[0]) && dsc.painted > 500 && /^data:image\/png;base64,/.test(dsc.imageHref), JSON.stringify(dsc))

  await search.fill('python')
  await page.waitForTimeout(500)
  const python = await glyphOf(keys.python)
  record('Python (SVG) is drawn as its paths', python.svg && python.paths > 0 && python.painted > 100 && !python.image, JSON.stringify(python))
  await page.keyboard.press('Escape')
} catch (e) {
  record('icon picker raster harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== ICON PICKER RASTER SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close().catch(() => {})
  rmSync(tempRoot, { recursive: true, force: true })
  process.exit(failed.length === 0 ? 0 : 1)
}
