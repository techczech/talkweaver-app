// Real-Electron harness for the frontmatter table editor (raw ↔ table, typed controls, write-back).
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

const FIX = [
  '---',
  'title: FM Fixture',
  'author: Test Author',
  'auto_title_slide: true',
  '---',
  '',
  '## Section',
  '',
  '### Slide',
  '',
  'body',
  ''
].join('\n')

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-fm-' + String(Date.now()) + '-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
const td = join(vault, 'fm-fixture')
mkdirSync(td, { recursive: true }); mkdirSync(ud, { recursive: true })
writeFileSync(join(td, 'fm-fixture-outline.md'), FIX)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))

const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

const rawLines = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.cm-content .cm-line')).map((l) => l.textContent).join('\n')
  )

try {
  await page.locator('.sidebar-mode-btn', { hasText: 'Talks' }).click().catch(() => {})
  await page.locator('.talk-item', { hasText: 'FM Fixture' }).first().click()
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.waitForTimeout(800)

  // 1. Frontmatter renders as a table by default
  const tableUp = await page.locator('[data-frontmatter-table]').count()
  record('frontmatter renders as a table by default', tableUp > 0, `tables=${tableUp}`)

  // 2. Rows for the present keys + raw YAML hidden from the line text
  const rows = await page.locator('.cm-fm-row').count()
  const linesNoYaml = !(await rawLines()).includes('title: FM Fixture')
  record('table shows typed rows (title/author/flag)', rows >= 3, `rows=${rows}`)
  record('raw YAML hidden while in table mode', linesNoYaml, `yamlHidden=${linesNoYaml}`)

  // 3. Editing a text field writes back to the YAML
  const titleInput = page.locator('.cm-fm-row[data-fm-key="title"] input').first()
  await titleInput.fill('Edited Title')
  await page.locator('.cm-fm-row[data-fm-key="author"] input').first().click() // blur → change
  await page.waitForTimeout(250)
  // 4. Toggle to RAW and confirm the change landed in the YAML
  await page.locator('.cm-fm-raw-btn').first().click()
  await page.waitForTimeout(300)
  const raw = await rawLines()
  record('editing a field writes back to YAML', /title:\s*"?Edited Title/.test(raw), `raw has edited title=${/title:\s*"?Edited Title/.test(raw)}`)
  record('raw toggle shows the YAML lines', raw.includes('author: Test Author') && (await page.locator('[data-frontmatter-table]').count()) === 0, 'raw mode')

  // 5. Toggle back to table
  await page.locator('.cm-fm-table-btn').first().click()
  await page.waitForTimeout(300)
  record('table toggle restores the table', (await page.locator('[data-frontmatter-table]').count()) > 0)

  // 6. Add a field (palette) via the + add control, then verify in raw
  const add = page.locator('.cm-fm-add').first()
  if (await add.count()) {
    await add.selectOption('palette').catch(() => {})
    await page.waitForTimeout(250)
    await page.locator('.cm-fm-raw-btn').first().click()
    await page.waitForTimeout(250)
    const raw2 = await rawLines()
    record('“+ add field” adds a key to the YAML', /(^|\n)palette:/.test(raw2), `has palette=${/(^|\n)palette:/.test(raw2)}`)
  } else {
    record('“+ add field” adds a key to the YAML', false, 'no add control')
  }
} catch (e) {
  record('frontmatter harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== FRONTMATTER SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
