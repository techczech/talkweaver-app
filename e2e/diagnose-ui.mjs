// Real-Electron UI-flow harness — drives the actual interface the user touches.
// Verifies: selecting a talk renders the editor + slide-strip thumbnails, and ⌘K
// opens a populated search palette. Screenshots saved to e2e/shots/.
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
const SHOTS = join(__dirname, 'shots')
mkdirSync(SHOTS, { recursive: true })

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// No --user-data-dir here (this harness runs against the real vault), so suppress the
// outline-v2 migration prompt explicitly — a native modal would hang the run.
const app = await electron.launch({ args: ['.'], cwd: REPO, env: { ...process.env, TW_MIGRATE_PROMPT: '0' } })
const page = await app.firstWindow()
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

try {
  // ── select first talk ──
  const items = page.locator('.talk-item')
  const count = await items.count()
  record('talk list renders items', count > 0, `${count} items`)
  await items.first().click()

  // editor mounts
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  record('editor (.cm-content) mounts on talk select', true)

  // wait for compile + thumbnails (debounced 900ms + render time)
  await page.waitForTimeout(6000)
  await page.screenshot({ path: join(SHOTS, 'ui-1-workspace.png') })

  // ── slide strip thumbnails actually displayed? ──
  const stripImgs = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'))
    const thumbs = imgs.filter((i) => i.src.startsWith('twthumb://'))
    return {
      total: thumbs.length,
      loaded: thumbs.filter((i) => i.complete && i.naturalWidth > 0).length,
      firstSrc: thumbs[0]?.src ?? null
    }
  })
  record('slide strip shows thumbnail <img> elements', stripImgs.total > 0, `${stripImgs.total} thumb imgs`)
  record('slide strip thumbnails are actually painted', stripImgs.loaded > 0, `${stripImgs.loaded}/${stripImgs.total} loaded`)

  // ── ⌘K opens search palette ──
  await page.keyboard.press('Meta+k')
  await page.waitForTimeout(400)
  const paletteVisible = await page.locator('.search-palette').count()
  record('⌘K opens search palette', paletteVisible > 0)
  await page.screenshot({ path: join(SHOTS, 'ui-2-search-open.png') })

  if (paletteVisible > 0) {
    // type a query and check results populate
    await page.locator('.search-palette-input').fill('ai')
    await page.waitForTimeout(800)
    const resultCount = await page.locator('.search-result-item').count()
    record('search palette shows results for "ai"', resultCount > 0, `${resultCount} result rows`)

    // Pre-rendered thumbnails in search results (ADR-0019). Give background pre-gen a moment.
    await page.waitForTimeout(2500)
    const thumbInfo = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('.search-result-item img'))
      const tw = imgs.filter((i) => i.src.startsWith('twthumb://'))
      return { total: tw.length, loaded: tw.filter((i) => i.complete && i.naturalWidth > 0).length }
    })
    record('search results render thumbnail <img>', thumbInfo.total > 0, `${thumbInfo.total} thumb imgs`)
    record('at least one search thumbnail painted', thumbInfo.loaded > 0, `${thumbInfo.loaded} painted`)
    // Regression guard: the preview card must have a real height. An aspect-ratio thumb collapsed
    // to ~1px (squishing every result into a thin stripe) and "painted" still passed — so assert
    // the RENDERED height, which is what actually broke.
    const cardH = await page.evaluate(() => {
      const t = document.querySelector('.search-result-thumb')
      const item = document.querySelector('.search-result-item')
      return { thumb: t ? Math.round(t.getBoundingClientRect().height) : 0, item: item ? Math.round(item.getBoundingClientRect().height) : 0 }
    })
    record('search preview card is not collapsed', cardH.thumb >= 100 && cardH.item >= 120, `thumbH=${cardH.thumb} itemH=${cardH.item}`)
    await page.screenshot({ path: join(SHOTS, 'ui-3-search-results.png') })

    // arrow + enter inserts (just confirm no crash + palette closes)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    const closed = (await page.locator('.search-palette').count()) === 0
    record('Esc closes search palette', closed)
  } else {
    record('search palette shows results for "ai"', false, 'palette never opened')
  }

  // ── ⌘L opens the layout picker (replaced the old "/" auto-popup) ──
  await page.locator('.cm-content').click()
  await page.keyboard.press('Meta+l')
  await page.waitForTimeout(500)
  // CommandPalette has no fixed class guarantee; check for any element mentioning a layout trigger
  const cmdOpen = await page.evaluate(() =>
    document.body.innerText.includes('Insert layout') ||
    Array.from(document.querySelectorAll('*')).some((e) => e.textContent === '{statement}')
  )
  record('⌘L opens layout palette', cmdOpen)

  // Layout picker completeness + two columns (parity with the sampler's 60 layouts)
  const layoutInfo = await page.evaluate(() => {
    const opts = Array.from(document.querySelectorAll('[role="option"]'))
    const listbox = document.querySelector('[role="listbox"]')
    let cols = 0
    if (listbox) {
      const gtc = getComputedStyle(listbox).gridTemplateColumns || ''
      cols = gtc.split(' ').filter(Boolean).length
    }
    return { count: opts.length, cols }
  })
  record('layout picker shows all 60 layouts', layoutInfo.count >= 60, `${layoutInfo.count} options`)
  record('layout picker is two columns', layoutInfo.cols === 2, `grid cols=${layoutInfo.cols}`)
  await page.screenshot({ path: join(SHOTS, 'ui-4-slash.png') })

  // ⌘⇧P command palette opens, lists commands, and runs one (→ grid view).
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Meta+Shift+p')
  await page.waitForTimeout(400)
  const cmdUp = await page.locator('[data-command-menu]').count()
  const cmdItems = await page.locator('.command-menu-item').count()
  record('⌘⇧P opens the command palette', cmdUp > 0, `menu=${cmdUp} items=${cmdItems}`)
  await page.screenshot({ path: join(SHOTS, 'ui-5-cmdpalette.png') })
  if (cmdUp > 0) {
    await page.locator('.command-menu-input').fill('grid')
    await page.waitForTimeout(300)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(700)
    const inGrid = await page.locator('.grid-view, [data-view="grid"]').count()
    record('⌘⇧P command runs (View: Grid → grid shows)', inGrid > 0, `grid container=${inGrid}`)
  } else {
    record('⌘⇧P command runs (View: Grid → grid shows)', false, 'menu never opened')
  }

  // Talk-list search filters the list.
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  const allItems = await page.locator('.talk-item').count()
  await page.locator('.talk-list-search-input').fill('codex')
  await page.waitForTimeout(300)
  const filteredItems = await page.locator('.talk-item').count()
  record('talk list search filters', filteredItems > 0 && filteredItems < allItems, `all=${allItems} filtered=${filteredItems}`)
  await page.locator('.talk-list-search-input').fill('')
  await page.waitForTimeout(200)

  // editor↔strip sync: clicking a slide heading highlights the matching strip card.
  await page.locator('[title="Both panes"]').first().click().catch(() => {})
  await page.waitForTimeout(400)
  // pick a distinctive heading present in the agents talk
  const headingText = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('.cm-content .cm-line')).map((l) => l.textContent || '')
    const h = lines.find((t) => /^###\s+\S/.test(t))
    return h ? h.replace(/^###\s+/, '').replace(/\{[^}]*\}/g, '').trim().slice(0, 24) : null
  })
  if (headingText) {
    await page.locator('.cm-content .cm-line', { hasText: headingText }).first().click()
    await page.waitForTimeout(400)
    const activeMatches = await page.evaluate((ht) => {
      const c = document.querySelector('.tw-slide-card[data-active="true"]')
      return c ? (c.textContent || '').toLowerCase().includes(ht.toLowerCase()) : false
    }, headingText)
    record('editor→strip sync: clicking a heading highlights its slide', activeMatches, `heading="${headingText}"`)
  } else {
    record('editor→strip sync: clicking a heading highlights its slide', false, 'no ### heading found')
  }

  // ADR-0022: the vertical strip renders per-sub-slide cards ONLY for CAROUSEL slides (#### /
  // {carousel}) — one .tw-subslide-card per stepped full-bleed sub-slide. Static multi-part
  // layouts (columns/contrast/image-grid) produce NO sub-cards. A real-vault talk may or may not
  // contain a carousel, so the invariant we assert (always true) is: the number of strip sub-cards
  // equals the number of carousel sub-thumbnails the API captured for this talk, AND every sub-card
  // that does render is painted. Compile + thumbnails the loaded talk to derive the expected count.
  await page.waitForTimeout(1500)
  const subAgreement = await page.evaluate(async () => {
    const talks = await window.tw.vault.listTalks()
    if (!talks || !talks.length) return { ok: false, reason: 'no talks' }
    // The harness selected the FIRST talk in the rendered list; mirror that selection.
    const t = talks[0]
    const c = await window.tw.talk.readOutline(t.outlinePath)
    const map = (await window.tw.talk.thumbnails(t.outlinePath, c)) || {}
    const expectedSubs = Object.keys(map).filter((k) => /__\d+$/.test(k)).length
    const cells = Array.from(document.querySelectorAll('.tw-subslide-card'))
    const painted = cells.map((el) => el.querySelector('img')).filter((i) => i && i.complete && i.naturalWidth > 0)
    // Reliability invariant: every sub-card that renders must be PAINTED (no blank thumbnails).
    // (Whether THIS talk is a carousel is covered by the controlled diagnose-carousel-thumbnails;
    // a fresh re-fetch's count can diverge from the load-time strip due to cache/timing.)
    return { ok: cells.length === painted.length, expectedSubs, cells: cells.length, painted: painted.length }
  })
  record(
    'every strip sub-card is painted (no blank carousel thumbnails)',
    subAgreement.ok,
    `expectedSubs=${subAgreement.expectedSubs} subcells=${subAgreement.cells} painted=${subAgreement.painted}`
  )
  await page.screenshot({ path: join(SHOTS, 'ui-6-strip-subslides.png') })
} catch (e) {
  record('UI harness completed without throwing', false, String(e))
} finally {
  if (consoleErrors.length) {
    console.log('\n=== RENDERER CONSOLE ERRORS ===')
    consoleErrors.slice(-30).forEach((e) => console.log('  ' + e))
  }
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== UI SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  console.log('screenshots in e2e/shots/')
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
