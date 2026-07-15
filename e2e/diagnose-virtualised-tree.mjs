// Host verification for the virtualised Talks tree: 900-talk vault, real Electron.
// HOST-RUN ONLY (launches Electron): node e2e/diagnose-virtualised-tree.mjs
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-vtree-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
mkdirSync(ud, { recursive: true })
function mk(rel, title) {
  const slug = rel.split('/').pop()
  const dir = join(vault, rel)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, slug + '-outline.md'), `---\ntitle: ${title}\n---\n\n### S\n\nx\n`)
}
for (let f = 0; f < 3; f++) {
  for (let t = 0; t < 300; t++) {
    mk(`topic-${f}/talk-${f}-${String(t).padStart(3, '0')}`, `Talk ${f}-${String(t).padStart(3, '0')}`)
  }
}
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))

const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(3000)

try {
  const headers = await page.locator('.tl-fhead').count()
  record('3 sticky depth-0 headers mounted', headers === 3, `headers=${headers}`)

  const mountedRows = await page.locator('.tl-row').count()
  record('windowing: mounted rows << 900', mountedRows > 5 && mountedRows < 120, `mounted=${mountedRows}`)

  const total = await page.locator('.tl-tree').evaluate((el) => el.scrollHeight)
  record('scroll height covers full vault', total > 900 * 20, `scrollHeight=${total}`)

  // Scroll to the middle → different rows mount.
  const firstLabel = await page.locator('.tl-row .tl-row-name').first().textContent()
  await page.locator('.tl-tree').evaluate((el) => { el.scrollTop = el.scrollHeight / 2 })
  await page.waitForTimeout(300)
  const midLabel = await page.locator('.tl-row .tl-row-name').first().textContent()
  record('scrolling swaps the mounted window', firstLabel !== midLabel, `${firstLabel} → ${midLabel}`)

  // Keyboard: focus panel, ArrowDown 60 times from the top — focused row must be mounted and visible.
  await page.locator('.tl-tree').evaluate((el) => { el.scrollTop = 0 })
  await page.waitForTimeout(200)
  // Focus the panel via a folder header toggle (click+click restores expansion) — a blind
  // panel-centre click lands on a talk row in a 900-row vault and opening a talk correctly
  // moves focus to the editor (this harness passed pre-0.16.9 only because the render-loop
  // bug broke that focus grab).
  await page.locator('.tl-fhead').first().click()
  await page.locator('.tl-fhead').first().click()
  for (let i = 0; i < 60; i++) await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(300)
  const focusInfo = await page.evaluate(() => {
    const el = document.querySelector('.tl-row--kfocus, .tl-fhead--kfocus')
    if (!el) return null
    const container = document.querySelector('.tl-tree')
    const r = el.getBoundingClientRect()
    const c = container.getBoundingClientRect()
    return { visible: r.top >= c.top - 1 && r.bottom <= c.bottom + 1, label: el.textContent.slice(0, 30) }
  })
  record('focused row after 60×ArrowDown is mounted + visible', !!focusInfo && focusInfo.visible, JSON.stringify(focusInfo))

  // Collapse first header → its talks unmount; totals shrink.
  const before = await page.locator('.tl-tree').evaluate((el) => el.scrollHeight)
  await page.locator('.tl-fhead').first().click()
  await page.waitForTimeout(300)
  const after = await page.locator('.tl-tree').evaluate((el) => el.scrollHeight)
  record('collapsing a group shrinks scroll height', after < before, `${before} → ${after}`)
  await page.locator('.tl-fhead').first().click()
  await page.waitForTimeout(300)

  // Search: flat filtered window.
  await page.locator('input[placeholder*="earch"], input[type="search"], .tl-search input').first().fill('Talk 2-29')
  await page.waitForTimeout(400)
  const filtered = await page.locator('.tl-row').count()
  record('search narrows to matching flat rows', filtered >= 1 && filtered <= 15, `filtered=${filtered}`)
} catch (e) {
  record('harness completed without throwing', false, String(e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== VTREE SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
