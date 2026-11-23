// Real-Electron harness for "Explain rendering" (ADR-0024): right-click a slide → see WHY it
// rendered that way, read from the ACTUAL compiled <section> decisions. Proves the trace
// reports the statement layout and default top title placement, and that the slide menu opens
// its Explain panel.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openFirstTalk } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'; import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'; import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url)); const REPO = join(__dirname, '..')
const results = []
const record = (n, p, d) => { results.push({ n, p }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }

const FIX = [
  '---', 'title: Explain Fixture', '---', '',
  '### Short statement', '{statement}', '', 'Brief.', '',
  '### Rich statement', '{statement}', '',
  'A longer statement with a more substantial paragraph and two supporting points gives the trace a second body shape to report.', '',
  '- one', '- two', ''
].join('\n')

const root = mkdtempSync(join(tmpdir(), 'tw-e2e-explain-')); const vault = join(root, 'v'); const ud = join(root, 'ud'); const td = join(vault, 'explain-fixture')
mkdirSync(td, { recursive: true }); mkdirSync(ud, { recursive: true })
const fxPath = join(td, 'explain-fixture-outline.md')
writeFileSync(fxPath, FIX)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }))

await ensureFreshBuild(REPO)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO, env: { ...process.env, TW_E2E: '1' } })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(1200)

try {
  await openFirstTalk(page)
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.waitForTimeout(500)

  const rows = await page.evaluate(({ p, c }) => window.tw.talk.compile(p, c), { p: fxPath, c: FIX })
  const shortIdx = (rows || []).findIndex((r) => /Short statement/.test(r.nav_title || r.title || ''))
  const richIdx = (rows || []).findIndex((r) => /Rich statement/.test(r.nav_title || r.title || ''))
  record('compiled both statement slides', shortIdx >= 0 && richIdx >= 0, `short@${shortIdx} rich@${richIdx}`)

  const shortT = await page.evaluate(({ p, c, i }) => window.tw.talk.explainSlide(p, c, i), { p: fxPath, c: FIX, i: shortIdx })
  const richT = await page.evaluate(({ p, c, i }) => window.tw.talk.explainSlide(p, c, i), { p: fxPath, c: FIX, i: richIdx })

  record('both resolve to layout=statement', shortT?.layout === 'statement' && richT?.layout === 'statement', `short=${shortT?.layout} rich=${richT?.layout}`)
  // The current statement frame places its title above the slide body for both text lengths.
  record('explicit short {statement} places its title at the top', shortT?.titleLayout === 'top', `titleLayout=${shortT?.titleLayout}`)
  record('explicit rich {statement} places its title at the top', richT?.titleLayout === 'top', `titleLayout=${richT?.titleLayout}`)
  record('trace reports the {statement} trigger the author wrote', Array.isArray(shortT?.triggers) && shortT.triggers.includes('{statement}'), `triggers=${JSON.stringify(shortT?.triggers)}`)

  // Open the Slides strip, right-click the authored slide and choose Explain rendering.
  const stripTab = page.locator('[data-rc-tab="slides"] button')
  if (await stripTab.count()) await stripTab.click()
  await page.locator(`[data-place-region="strip"] [data-slide-index="${shortIdx}"]`).first().click({ button: 'right' })
  await page.getByRole('listbox', { name: 'Actions here' }).locator('[data-actions-here-row="explain-rendering"]').click()
  const panel = page.getByRole('dialog', { name: 'Explain rendering' })
  await panel.waitFor({ state: 'visible' })
  const open = await panel.count()
  record('right-click a slide opens the Explain panel', open > 0, `panel=${open}`)
  await panel.getByText('Stacked — title on top, content below.', { exact: true }).waitFor({ state: 'visible', timeout: 8000 })
  const txt = await panel.innerText()
  record('panel explains layout + placement', /Layout/i.test(txt) && /placement/i.test(txt), `hasLayout=${/Layout/i.test(txt)} hasPlacement=${/placement/i.test(txt)}`)
} catch (e) {
  record('explain harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.p)
  console.log(`\n=== EXPLAIN SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
