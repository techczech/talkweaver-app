// Real-Electron harness: editor→strip sync for every heading level.
// Clicking an h1 line → title slide; h2 → section-title; h3 → that slide; h4/body → containing slide.
// Isolated temp vault with a known fixture.
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
  'title: Sync Fixture',
  '---',
  '',
  '# Deck Title Heading',
  '',
  '## Section One',
  '',
  '### Slide A',
  '',
  'Body of slide A.',
  '',
  '#### Sub heading of A',
  '',
  'More body under the sub heading.',
  '',
  '### Slide B',
  '',
  'Body of slide B.',
  '',
  '## Section Two',
  '',
  '### Slide C',
  '',
  'Body of slide C.',
  ''
].join('\n')

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-sync-' + String(Date.now()) + '-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
const td = join(vault, 'sync-fixture')
mkdirSync(td, { recursive: true })
mkdirSync(ud, { recursive: true })
writeFileSync(join(td, 'sync-fixture-outline.md'), FIX)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))

const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

async function activeCardText() {
  return page.evaluate(() => {
    const c = document.querySelector('.tw-slide-card[data-active="true"]')
    return c ? (c.textContent || '').trim() : null
  })
}
async function clickLine(text) {
  await page.locator('.cm-content .cm-line', { hasText: text }).first().click()
  await page.waitForTimeout(350)
}

try {
  await page.locator('.talk-item', { hasText: 'Sync Fixture' }).first().click()
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.waitForTimeout(1500)

  // h3 (baseline)
  await clickLine('### Slide B')
  let t = await activeCardText()
  record('h3 → that slide (Slide B)', !!t && /slide b/i.test(t), `active="${t}"`)

  // h2 → section-title
  await clickLine('## Section Two')
  t = await activeCardText()
  record('h2 → section title (Section Two)', !!t && /section two/i.test(t), `active="${t}"`)

  // h4 → containing slide (Slide A)
  await clickLine('#### Sub heading of A')
  t = await activeCardText()
  record('h4 → containing slide (Slide A)', !!t && /slide a/i.test(t), `active="${t}"`)

  // body under a slide → that slide
  await clickLine('Body of slide C.')
  t = await activeCardText()
  record('body → its slide (Slide C)', !!t && /slide c/i.test(t), `active="${t}"`)

  // h2 → section one
  await clickLine('## Section One')
  t = await activeCardText()
  record('h2 → section title (Section One)', !!t && /section one/i.test(t), `active="${t}"`)

  // h1 → title/cover slide (first card)
  await clickLine('# Deck Title Heading')
  t = await activeCardText()
  const firstCard = await page.evaluate(
    () => (document.querySelector('.tw-slide-card')?.textContent || '').trim()
  )
  record('h1 → title slide (first card)', !!t && t === firstCard, `active="${t}" first="${firstCard}"`)
} catch (e) {
  record('sync harness completed without throwing', false, String(e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== SYNC SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
