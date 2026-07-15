// Real-Electron harness: HTML handout export (Phase 1). The "Handout" action builds the
// audience-facing share-no-notes reading HTML to dist/{slug}-handout.html and opens it.
import { _electron as electron } from 'playwright'
import { fileURLToPath, pathToFileURL } from 'url'; import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'fs'; import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url)); const REPO = join(__dirname, '..')
const results = []
const record = (n, p, d) => { results.push({ n, p }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }

// The overview assertions need a query ("method") that matches a TITLE slide AND a body-only slide,
// so we can prove title-ranked ordering: "Method notes" (title) must outrank "Results" (which
// mentions "method" only in its body).
const FIX = [
  '---', 'title: Handout Fixture', '---', '',
  '### Opening slide', '', 'A unique reading body line about agents.', '',
  ':::notes', 'SECRET_SPEAKER_NOTE_should_not_appear_in_handout', ':::', '',
  '### Second slide', '', 'Another body paragraph.', '',
  '### Method notes', '', '- how we ran the study', '',
  '### Results', '', '- the method produced a clear signal', ''
].join('\n')

const root = mkdtempSync(join(tmpdir(), 'tw-e2e-handout-')); const vault = join(root, 'v'); const ud = join(root, 'ud')
const td = join(vault, 'handout-fixture')
mkdirSync(td, { recursive: true }); mkdirSync(ud, { recursive: true })
const fxPath = join(td, 'handout-fixture-outline.md')
writeFileSync(fxPath, FIX)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }))
const expectedHandout = join(td, 'dist', 'handout-fixture-handout.html')

const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(1200)

try {
  await page.locator('.talk-item').first().click()
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.waitForTimeout(300)

  // The Handout action is available in the toolbar.
  record('toolbar has a Handout button', await page.locator('.toolbar-btn', { hasText: 'Handout' }).count() > 0)

  // Export via the IPC directly (avoids opening a real browser in the test). Same path the button uses.
  const res = await page.evaluate(
    ({ p, c }) => window.tw.talk.exportHandout(p, c),
    { p: fxPath, c: FIX }
  )
  record('exportHandout returns success + path', !!(res && res.success && res.path), `res=${JSON.stringify(res)}`)
  record('handout file written to dist/{slug}-handout.html', existsSync(expectedHandout), expectedHandout)

  const html = existsSync(expectedHandout) ? readFileSync(expectedHandout, 'utf8') : ''
  record('handout is an HTML document', /<!doctype html|<html/i.test(html), `len=${html.length}`)
  record('handout contains the slide body', html.includes('A unique reading body line about agents.'))
  record('handout EXCLUDES speaker notes (share-no-notes)', !html.includes('SECRET_SPEAKER_NOTE_should_not_appear_in_handout') && !/class="notes"/.test(html), `hasNote=${html.includes('SECRET_SPEAKER_NOTE_should_not_appear_in_handout')} hasAside=${/class="notes"/.test(html)}`)

  // Task 6: the handout now uses the SHARED createOverview factory (no bespoke renderShareOverview).
  record('handout runtime uses the shared createOverview factory', html.includes('createOverview') && !html.includes('renderShareOverview'), `hasFactory=${html.includes('createOverview')} hasBespoke=${html.includes('renderShareOverview')}`)

  // Drive the built handout in a real page: open the overview, search, and assert ranking + that no
  // shown/skipped (.tw-status) markers appear (the handout is isPresenter:false).
  if (existsSync(expectedHandout)) {
    await page.goto(pathToFileURL(expectedHandout).href)
    await page.waitForSelector('#overviewBtn', { timeout: 8000 })
    await page.waitForTimeout(200)

    // (o1) The Overview button opens the shared drawer (#navPanel gets .open).
    await page.locator('#overviewBtn').click()
    await page.waitForTimeout(150)
    const navOpen = await page.locator('#navPanel.open').count()
    record('handout: Overview button opens #navPanel (.open)', navOpen === 1, `openCount=${navOpen}`)

    // (o2) Type a query matching a TITLE slide and a body-only slide; the title slide ranks first.
    await page.locator('#navSearch').fill('method')
    await page.waitForTimeout(150)
    const firstRow = (await page.locator('#navList .slide-link').first().innerText()).trim()
    record('handout: title match ranks first in #navList ("Method notes" before body-only "Results")',
      /method notes/i.test(firstRow), `firstRow=${JSON.stringify(firstRow)}`)

    // (o3) No shown/skipped markers anywhere in the overview (isPresenter:false → no .tw-status).
    const statusCount = await page.locator('#navList .tw-status').count()
    record('handout: NO .tw-status markers in the overview (isPresenter:false)', statusCount === 0, `statusCount=${statusCount}`)

    // (o4) Enter jumps to the top result and closes the drawer (current slide changes).
    const idxBefore = await page.evaluate(() => {
      const on = document.querySelector('.slide.active')
      return on ? Array.prototype.indexOf.call(document.querySelectorAll('.slide'), on) : -1
    })
    await page.locator('#navSearch').press('Enter')
    await page.waitForTimeout(200)
    const closedAfterEnter = await page.locator('#navPanel.open').count()
    const idxAfter = await page.evaluate(() => {
      const on = document.querySelector('.slide.active')
      return on ? Array.prototype.indexOf.call(document.querySelectorAll('.slide'), on) : -1
    })
    record('handout: Enter closes #navPanel (.open removed)', closedAfterEnter === 0, `openCount=${closedAfterEnter}`)
    record('handout: Enter jumps — current slide changed', idxAfter !== idxBefore && idxAfter >= 0, `before=${idxBefore} after=${idxAfter}`)

    // (o5) Re-open and click #navExpand → the thumbnail grid (.tw-overview-grid) with .tw-thumb.
    await page.locator('#overviewBtn').click()
    await page.waitForTimeout(150)
    await page.locator('#navExpand').click()
    await page.waitForTimeout(150)
    const gridPresent = await page.locator('#navList.tw-overview-grid').count()
    const thumbCount = await page.locator('#navList .tw-thumb').count()
    record('handout: #navExpand shows the thumbnail grid (.tw-overview-grid)', gridPresent === 1, `gridCount=${gridPresent}`)
    record('handout: expanded grid holds .tw-thumb children', thumbCount > 0, `thumbs=${thumbCount}`)
  }
} catch (e) {
  record('handout harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.p)
  console.log(`\n=== HANDOUT SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
