// Real-Electron harness: a `##` section divider RENDERS body content (big title + content below)
// instead of dropping it. Confirms the section row keeps role/layout section-title AND carries the
// image (the "## not ###, my image vanished" case now renders on the divider). Empty sections stay
// bare dividers.
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'url'; import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'; import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url)); const REPO = join(__dirname, '..')
const results = []
const record = (n, p, d) => { results.push({ n, p }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }

const FIX = [
  '---', 'title: Section Content Fixture', '---', '',
  '## More at ICTF', '', '![](img-abc1234)', '',
  '### A real slide', '', 'Body text.', '',
  '## Bare Section', '', '### Another', '', 'More body.'
].join('\n')

const root = mkdtempSync(join(tmpdir(), 'tw-e2e-sec-')); const vault = join(root, 'v'); const ud = join(root, 'ud'); const td = join(vault, 'section-content-fixture')
mkdirSync(td, { recursive: true }); mkdirSync(ud, { recursive: true })
const fxPath = join(td, 'section-content-fixture-outline.md')
writeFileSync(fxPath, FIX)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }))

const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(1200)

try {
  await page.locator('.talk-item').first().click()
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.waitForTimeout(300)

  const rows = await page.evaluate(({ p, c }) => window.tw.talk.compile(p, c), { p: fxPath, c: FIX })
  const ictf = (rows || []).find((r) => /More at ICTF/.test(r.nav_title || r.title || ''))
  const bare = (rows || []).find((r) => /Bare Section/.test(r.nav_title || r.title || ''))

  record('the section divider compiles', !!ictf, `found=${!!ictf}`)
  record('it stays a section-title divider', ictf?.layout === 'section-title' && ictf?.role === 'section-title', `layout=${ictf?.layout} role=${ictf?.role}`)
  record('the section divider now carries its image (not dropped)', (ictf?.image_count || 0) >= 1, `image_count=${ictf?.image_count}`)
  record('an empty section stays a bare divider (no image)', (bare?.image_count || 0) === 0, `image_count=${bare?.image_count}`)
  record('no section-drops-content warning is emitted', !(ictf?.warnings || []).some((w) => /section-drops-content/.test(w)), `warnings=${JSON.stringify(ictf?.warnings)}`)
} catch (e) {
  record('section-content harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.p)
  console.log(`\n=== SECTION-CONTENT SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
