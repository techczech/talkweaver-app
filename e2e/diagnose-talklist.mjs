// Real-Electron harness for the TalkList topic grouping + collapse (ADR-0009 topic subfolders).
// Isolated temp vault with talks nested in topic folders.
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

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-tl-' + String(Date.now()) + '-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
mkdirSync(ud, { recursive: true })
// talks across two topic folders + one at root
function mk(rel, title) {
  const slug = rel.split('/').pop()
  const dir = join(vault, rel)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, slug + '-outline.md'), `---\ntitle: ${title}\n---\n\n### S\n\nx\n`)
}
mk('ai-topics/alpha-talk', 'Alpha Talk')
mk('ai-topics/beta-talk', 'Beta Talk')
mk('workshops/gamma-talk', 'Gamma Talk')
mk('root-talk', 'Root Talk')
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))

const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1500)

try {
  const headers = await page.locator('[data-talk-group-header]').count()
  record('topic group headers render', headers >= 2, `headers=${headers} (expect ai-topics, workshops, root)`)

  const itemsBefore = await page.locator('.talk-item').count()
  record('all talks listed', itemsBefore === 4, `items=${itemsBefore}`)

  // Collapse the first group → its items hide.
  await page.locator('[data-talk-group-header]').first().click()
  await page.waitForTimeout(300)
  const itemsCollapsed = await page.locator('.talk-item').count()
  record('collapsing a topic group hides its talks', itemsCollapsed < itemsBefore, `before=${itemsBefore} after=${itemsCollapsed}`)

  // Expand again.
  await page.locator('[data-talk-group-header]').first().click()
  await page.waitForTimeout(300)
  const itemsExpanded = await page.locator('.talk-item').count()
  record('expanding restores talks', itemsExpanded === itemsBefore, `${itemsExpanded}`)

  // Search filters across groups.
  await page.locator('.talk-list-search-input').fill('beta')
  await page.waitForTimeout(300)
  const filtered = await page.locator('.talk-item').count()
  record('search filters across groups', filtered === 1, `filtered=${filtered}`)
} catch (e) {
  record('talklist harness completed without throwing', false, String(e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== TALKLIST SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
