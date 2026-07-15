// Real-Electron harness for SURFACE COMPILER WARNINGS PER-SLIDE.
// Feature: the engine now emits `iconlist-no-icons:<slide-id>` when an author forces
// {iconlist}/{iconrow} but NOT ONE item resolves to a glyph (the list silently dropped to
// plain). talk:compile threads model.warnings into each ProjectionRow.warnings, and the
// SlideStrip + GridView render a small amber ⚠ badge on the affected slide with the reason
// on hover. This harness compiles an outline with an all-fail {iconlist}, a control list that
// fully resolves, and a plain list with no {iconlist}, then asserts:
//   1. the all-fail row carries a warning matching /^iconlist-no-icons:/
//   2. the all-resolve and no-iconlist rows carry NO iconlist warning
//   3. the SlideStrip renders the ⚠ badge on the failing slide (and only it)
//   4. the GridView renders the same badge on the failing slide
//   5. fixing the outline (drop {iconlist}) makes the warning + badge disappear
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

// Three content slides:
//   "All fail"     — {iconlist} over items that resolve to no concept → should warn.
//   "All resolve"  — {iconlist} over brand items that all resolve → no warning (control).
//   "No iconlist"  — plain list, no forced style → no warning (control).
const FAIL_OUTLINE = [
  '---', 'title: W', '---', '',
  '## S', '',
  '### All fail', '{iconlist}', '',
  '- one', '- two', '- three', '',
  '### All resolve', '{iconlist}', '',
  '- GitHub', '- Python', '- Docker', '',
  '### No iconlist', '',
  '- plain a', '- plain b', ''
].join('\n')

// Fixed version of the failing slide: drop the {iconlist} trigger so it renders plain on
// purpose. The warning must vanish from that slide's row and the badge from the UI.
const FIXED_OUTLINE = FAIL_OUTLINE.replace('### All fail\n{iconlist}\n', '### All fail\n')

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-warn-' + String(Date.now()) + '-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
const td = join(vault, 'warn')
const other = join(vault, 'other')
mkdirSync(td, { recursive: true }); mkdirSync(other, { recursive: true }); mkdirSync(ud, { recursive: true })
writeFileSync(join(other, 'other-outline.md'), '---\ntitle: Other\n---\n\n### Y\n\nz\n')
const outlinePath = join(td, 'warn-fixture-outline.md')
writeFileSync(outlinePath, FAIL_OUTLINE)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))

const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

// Compile via IPC and return the rows keyed enough to inspect warnings per slide.
async function rowsFor(content) {
  return page.evaluate(async ({ p, c }) => {
    const rows = await window.tw.talk.compile(p, c)
    if (!rows) return null
    return rows.map((r) => ({ title: r.title || r.nav_title || '', warnings: r.warnings || [] }))
  }, { p: outlinePath, c: content })
}
const iconWarn = (r) => (r.warnings || []).filter((w) => /^iconlist-no-icons:/.test(w))

async function selectTalk(name) {
  await page.locator('.sidebar-mode-btn', { hasText: 'Talks' }).click().catch(() => {})
  await page.locator('.talk-item', { hasText: name }).first().click()
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.waitForTimeout(900)
}

try {
  // --- IPC layer: warnings produced and threaded into ProjectionRow.warnings ---
  const rows = await rowsFor(FAIL_OUTLINE)
  const failRow = (rows || []).find((r) => /All fail/.test(r.title))
  const resolveRow = (rows || []).find((r) => /All resolve/.test(r.title))
  const plainRow = (rows || []).find((r) => /No iconlist/.test(r.title))

  record(
    'all-fail {iconlist} row carries an iconlist-no-icons warning',
    !!(failRow && iconWarn(failRow).length === 1),
    `warnings=${JSON.stringify(failRow ? failRow.warnings : 'ROW MISSING')}`
  )
  record(
    'all-resolve {iconlist} row has NO iconlist warning (control)',
    !!(resolveRow && iconWarn(resolveRow).length === 0),
    `warnings=${JSON.stringify(resolveRow ? resolveRow.warnings : 'ROW MISSING')}`
  )
  record(
    'plain (no {iconlist}) row has NO iconlist warning (control)',
    !!(plainRow && iconWarn(plainRow).length === 0),
    `warnings=${JSON.stringify(plainRow ? plainRow.warnings : 'ROW MISSING')}`
  )

  // (A `##` section with body content no longer warns — the content now RENDERS on the divider
  // instead of being dropped. See diagnose-section-content for that behaviour.)

  // --- UI layer: the SlideStrip renders the badge on the failing slide ---
  await selectTalk('Warn Fixture')
  // The strip lives in the default pane; its cards are .tw-slide-card and the badge
  // is [data-slide-warning]. The strip first renders a client-side parse (no compiler
  // warnings), then re-renders from compiled rows once talk:compile resolves — wait for
  // the badge to appear. Exactly one slide (the all-fail one) should carry it.
  await page.waitForSelector('.tw-slide-card [data-slide-warning]', { timeout: 8000 }).catch(() => {})
  const stripBadges = await page.locator('.tw-slide-card [data-slide-warning]').count()
  record('SlideStrip shows exactly one ⚠ warning badge', stripBadges === 1, `badges=${stripBadges}`)

  // The badge's title (hover tooltip) names the {iconlist} problem.
  const stripTitle = stripBadges
    ? await page.locator('.tw-slide-card [data-slide-warning]').first().getAttribute('title')
    : ''
  record(
    'SlideStrip badge tooltip explains the {iconlist} warning',
    /iconlist/i.test(stripTitle || ''),
    `title="${(stripTitle || '').slice(0, 48)}"`
  )

  // The badge sits on the All-fail card, not a control card.
  const badgeOnFailCard = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.tw-slide-card'))
    const withBadge = cards.filter((c) => c.querySelector('[data-slide-warning]'))
    return withBadge.length === 1 && /All fail/.test(withBadge[0].textContent || '')
  })
  record('SlideStrip badge is on the All-fail card only', badgeOnFailCard, `onFailCard=${badgeOnFailCard}`)

  // --- UI layer: the GridView renders the same badge ---
  await page.locator('[data-testid="grid-toggle"]').click()
  await page.waitForSelector('.grid-view', { timeout: 5000 })
  await page.waitForTimeout(600)
  const gridBadges = await page.locator('.grid-cell [data-slide-warning]').count()
  record('GridView shows exactly one ⚠ warning badge', gridBadges === 1, `badges=${gridBadges}`)
  const gridBadgeOnFail = await page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll('.grid-cell'))
    const withBadge = cells.filter((c) => c.querySelector('[data-slide-warning]'))
    return withBadge.length === 1 && /All fail/.test(withBadge[0].textContent || '')
  })
  record('GridView badge is on the All-fail cell only', gridBadgeOnFail, `onFailCell=${gridBadgeOnFail}`)

  // --- Fix path: dropping {iconlist} clears the warning at the IPC layer ---
  const fixedRows = await rowsFor(FIXED_OUTLINE)
  const fixedFail = (fixedRows || []).find((r) => /All fail/.test(r.title))
  record(
    'fixing the outline (drop {iconlist}) removes the warning from the row',
    !!(fixedFail && iconWarn(fixedFail).length === 0),
    `warnings=${JSON.stringify(fixedFail ? fixedFail.warnings : 'ROW MISSING')}`
  )
} catch (e) {
  record('warnings harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== WARNINGS SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
