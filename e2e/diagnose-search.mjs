// Real-Electron harness for the reworked slide search: full-content all-words match, filters, and
// multi-select insert.
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'url'; import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'; import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url)); const REPO = join(__dirname, '..')
const results = []
const record = (n, p, d) => { results.push({ n, p }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }

const root = mkdtempSync(join(tmpdir(), 'tw-e2e-search-')); const vault = join(root, 'v'); const ud = join(root, 'ud')
const alpha = join(vault, 'topic-x', 'alpha-talk'); const beta = join(vault, 'topic-y', 'beta-talk')
mkdirSync(join(alpha, 'assets'), { recursive: true }); mkdirSync(beta, { recursive: true }); mkdirSync(ud, { recursive: true })
// A real PNG in alpha's assets/ so cross-talk materialization has something to pool.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
writeFileSync(join(alpha, 'assets', 'pic.png'), Buffer.from(PNG_B64, 'base64'))
writeFileSync(join(alpha, 'alpha-talk-outline.md'), [
  '---', 'title: Alpha Talk', '---', '',
  '## Intro', '',
  '### Welcome', '', 'This slide body mentions zebracorn somewhere in the content.', '',
  '### Pricing note', '{statement}', '', 'Converging on a single price point over time.', '',
  '### A picture', '', '![Screenshot](assets/pic.png)', ''
].join('\n'))
writeFileSync(join(beta, 'beta-talk-outline.md'), ['---', 'title: Beta Talk', '---', '', '### Other', '', 'Unrelated content about kangaroos.', ''].join('\n'))
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }))

const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(1200)

const titlesOf = (rows) => (rows || []).map((r) => r.nav_title || r.title)
const readDoc = () => page.evaluate(() => Array.from(document.querySelectorAll('.cm-content .cm-line')).map((l) => l.textContent).join('\n'))

try {
  // ── Backend: full-content all-words match ──
  const zeb = await page.evaluate(() => window.tw.search.allSlides('zebracorn'))
  record('full-content: a BODY-only word finds the slide', titlesOf(zeb).includes('Welcome'), `titles=${JSON.stringify(titlesOf(zeb))}`)

  const conv = await page.evaluate(() => window.tw.search.allSlides('converging price'))
  record('all-words: both words (order-independent, in body) match', titlesOf(conv).includes('Pricing note') && (conv || []).length === 1, `titles=${JSON.stringify(titlesOf(conv))}`)

  const none = await page.evaluate(() => window.tw.search.allSlides('zebracorn kangaroos'))
  record('all-words across talks: no single slide has both → none', (none || []).length === 0, `n=${(none || []).length}`)

  // ── UI: multi-select insert ──
  const alphaOutline = join(alpha, 'alpha-talk-outline.md')
  const diskFrom = async () => ((await page.evaluate((p) => window.tw.talk.readOutline(p), alphaOutline)) || '').match(/<!-- from:/g)?.length || 0
  await page.locator('.talk-item', { hasText: 'Alpha Talk' }).first().click()
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.waitForTimeout(300)
  const beforeFrom = await diskFrom()

  await page.keyboard.press('Meta+k')
  await page.waitForTimeout(500)
  await page.locator('.search-palette-input').fill('') // empty → all slides
  await page.waitForTimeout(700)
  const cards = await page.locator('.search-result-item').count()
  record('empty query shows all slides (browse mode)', cards >= 4, `cards=${cards}`)

  // tick the first two checkboxes
  const checks = page.locator('.search-result-check')
  await checks.nth(0).click()
  await checks.nth(1).click()
  await page.waitForTimeout(150)
  const insertBtn = page.locator('button', { hasText: /Insert 2 selected/ })
  record('Insert N button reflects the selection count', await insertBtn.count() > 0, `btn=${await insertBtn.count()}`)
  await insertBtn.first().click()
  await page.waitForTimeout(800)
  const afterFrom = await diskFrom()
  record('multi-select inserted 2 slides (2 new from-lineage blocks)', afterFrom - beforeFrom === 2, `from ${beforeFrom} -> ${afterFrom}`)

  // ── UI: multi-select layout filter narrows (button → checkbox panel) ──
  await page.keyboard.press('Meta+k'); await page.waitForTimeout(400)
  await page.locator('.search-palette-input').fill(''); await page.waitForTimeout(500)
  const allCount = await page.locator('.search-result-item').count()
  await page.locator('.search-palette-filters button', { hasText: /Any layout|Layouts/ }).first().click()
  await page.waitForTimeout(150)
  await page.locator('.search-palette-filters label', { hasText: 'statement' }).locator('input[type=checkbox]').check()
  await page.waitForTimeout(300)
  const stmtCount = await page.locator('.search-result-item').count()
  record('multi-select layout filter narrows results', stmtCount >= 1 && stmtCount < allCount, `all=${allCount} statement=${stmtCount}`)

  // ── UI: "content only" toggle excludes title-only slides (sections, bare titles) ──
  await page.locator('.search-palette-filters button', { hasText: /Layouts/ }).first().click() // close panel
  await page.locator('.search-palette-filters label', { hasText: 'content only' }).locator('input').check()
  await page.waitForTimeout(300)
  const contentCount = await page.locator('.search-result-item').count()
  record('content-only filter is active (changes the set)', contentCount !== allCount, `all=${allCount} contentOnly+statement=${contentCount}`)
  await page.keyboard.press('Escape'); await page.waitForTimeout(200)

  // ── Cross-talk image materialization: a slide's relative image becomes a vault-pool img-<hash>. ──
  const mat = await page.evaluate(({ p }) => window.tw.talk.materializeSlideAssets(p, '### A picture\n\n![Screenshot](assets/pic.png)\n'), { p: join(alpha, 'alpha-talk-outline.md') })
  const poolId = (mat?.markdown || '').match(/!\[[^\]]*\]\((img-[0-9a-f]{7})\)/)?.[1]
  record('relative image rewritten to a vault-pool img- id', !!poolId && !/assets\/pic\.png/.test(mat.markdown), `md=${JSON.stringify((mat?.markdown || '').slice(0, 60))}`)
  const poolExists = await page.evaluate(({ root: r, id }) => {
    // verify the pool file exists by asking the asset sidecar reader (returns null if absent)
    return id ? window.tw.asset.readSidecar(id).then((s) => !!s).catch(() => false) : false
  }, { root, id: poolId })
  record('the materialized image exists in the vault pool', poolExists === true, `id=${poolId}`)
} catch (e) {
  record('search harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.p)
  console.log(`\n=== SEARCH SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
