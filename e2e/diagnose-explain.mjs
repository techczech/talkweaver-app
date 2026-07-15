// Real-Electron harness for "Explain rendering" (ADR-0024): right-click a slide → see WHY it
// rendered that way, read from the ACTUAL compiled <section> decisions. Proves the trace
// reports correct layout + title placement for explicit {statement} triggers (deterministic
// side-by-side), and that the panel opens on right-click.
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'url'; import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'; import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url)); const REPO = join(__dirname, '..')
const results = []
const record = (n, p, d) => { results.push({ n, p }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }

const FIX = [
  '---', 'title: Explain Fixture', '---', '',
  '### Short statement', '{statement}', '', 'Brief.', '',
  '### Rich statement', '{statement}', '',
  'A much longer statement with many more words so it is well beyond the sixty character sparse threshold and therefore keeps the normal side-by-side rail.', '',
  '- one', '- two', ''
].join('\n')

const root = mkdtempSync(join(tmpdir(), 'tw-e2e-explain-')); const vault = join(root, 'v'); const ud = join(root, 'ud'); const td = join(vault, 'explain-fixture')
mkdirSync(td, { recursive: true }); mkdirSync(ud, { recursive: true })
const fxPath = join(td, 'explain-fixture-outline.md')
writeFileSync(fxPath, FIX)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }))

const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(1200)

try {
  await page.locator('.talk-item').first().click()
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.waitForTimeout(500)

  const rows = await page.evaluate(({ p, c }) => window.tw.talk.compile(p, c), { p: fxPath, c: FIX })
  const shortIdx = (rows || []).findIndex((r) => /Short statement/.test(r.nav_title || r.title || ''))
  const richIdx = (rows || []).findIndex((r) => /Rich statement/.test(r.nav_title || r.title || ''))
  record('compiled both statement slides', shortIdx >= 0 && richIdx >= 0, `short@${shortIdx} rich@${richIdx}`)

  const shortT = await page.evaluate(({ p, c, i }) => window.tw.talk.explainSlide(p, c, i), { p: fxPath, c: FIX, i: shortIdx })
  const richT = await page.evaluate(({ p, c, i }) => window.tw.talk.explainSlide(p, c, i), { p: fxPath, c: FIX, i: richIdx })

  record('both resolve to layout=statement', shortT?.layout === 'statement' && richT?.layout === 'statement', `short=${shortT?.layout} rich=${richT?.layout}`)
  // Explicit {statement} is DETERMINISTIC now: both short and long stay side-by-side (left rail).
  // title-density scaling was removed (SD-7); titleLayout alone confirms placement.
  record('explicit short {statement} stays side-by-side (left rail)', shortT?.titleLayout === 'left', `titleLayout=${shortT?.titleLayout}`)
  record('explicit rich {statement} stays side-by-side (left rail)', richT?.titleLayout === 'left', `titleLayout=${richT?.titleLayout}`)
  record('trace reports the {statement} trigger the author wrote', Array.isArray(shortT?.triggers) && shortT.triggers.includes('{statement}'), `triggers=${JSON.stringify(shortT?.triggers)}`)

  // Right-click a slide card → the Explain panel opens.
  await page.locator('.tw-slide-card').first().click({ button: 'right' })
  await page.waitForTimeout(400)
  const open = await page.locator('[aria-label="Explain rendering"]').count()
  record('right-click a slide opens the Explain panel', open > 0, `panel=${open}`)
  const txt = open ? await page.locator('[aria-label="Explain rendering"]').first().innerText() : ''
  record('panel explains layout + placement', /Layout/i.test(txt) && /placement/i.test(txt), `hasLayout=${/Layout/i.test(txt)} hasPlacement=${/placement/i.test(txt)}`)
} catch (e) {
  record('explain harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.p)
  console.log(`\n=== EXPLAIN SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
