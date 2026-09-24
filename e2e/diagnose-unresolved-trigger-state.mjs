// Authored Milestone C regression harness. Run only through the hidden Electron e2e lane:
//   npm run test:unresolved-trigger-state:e2e
//
// This parcel deliberately does not execute the harness. The node-level regression suites cover
// the join and every main handler; this file exercises the rendered strip, Grid, Inspector and
// block modal when the driver next runs Electron.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const repo = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'talkweaver-unresolved-trigger-'))
const vault = join(root, 'vault')
const userData = join(root, 'userData')
const talkDir = join(vault, 'unresolved-probe')
const outlinePath = join(talkDir, 'unresolved-probe-outline.md')
const outline = [
  '---',
  'title: Unresolved probe',
  '---',
  '',
  '### First',
  '{id=first}{statement}',
  '',
  'Safe first slide.',
  '',
  '### Broken',
  '{id=broken}{nonsense}',
  '',
  'The middle slide owns the error.',
  '',
  '### Last',
  '{id=last}{quote}',
  '',
  '> Safe last slide.'
].join('\n')

mkdirSync(talkDir, { recursive: true })
mkdirSync(userData, { recursive: true })
writeFileSync(outlinePath, outline, 'utf8')
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2), 'utf8')

let failures = 0
function record(label, pass, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures += 1
}

await ensureFreshBuild(repo)
const app = await electron.launch({
  args: ['.', `--user-data-dir=${userData}`],
  cwd: repo,
  env: { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }
})

try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.getByText('Unresolved probe', { exact: true }).first().click()
  await page.waitForSelector('.workspace')

  const stripCards = page.locator('.tw-slide-card')
  const firstCard = stripCards.filter({ hasText: 'First' })
  const brokenCard = stripCards.filter({ hasText: 'Broken' })
  const lastCard = stripCards.filter({ hasText: 'Last' })
  await brokenCard.locator('[data-slide-warning]').waitFor({ timeout: 12_000 })
  record('strip puts the error chip on the broken slide', await brokenCard.locator('[data-slide-warning]').count() === 1)
  record('strip keeps the preceding slide clear', await firstCard.locator('[data-slide-warning]').count() === 0)
  record('strip keeps the following slide clear', await lastCard.locator('[data-slide-warning]').count() === 0)

  await brokenCard.click()
  await page.keyboard.press('Meta+p')
  await page.waitForSelector('.tw-inspector-unresolved')
  record('Inspector opens the unresolved state for the addressed slide', await page.locator('.tw-inspector-unresolved code', { hasText: 'nonsense' }).count() === 1)
  record('Inspector hides option groups on the broken slide', await page.locator('.tw-inspector-group').count() === 0)

  await page.keyboard.press('Meta+p')
  await page.getByTestId('grid-toggle').click()
  const gridCells = page.locator('.grid-cell')
  const brokenGrid = gridCells.filter({ hasText: 'Broken' })
  record('Grid puts the error chip on the broken slide', await brokenGrid.locator('[data-slide-warning]').count() === 1)
  record('Grid keeps both neighbours clear', await gridCells.filter({ hasText: /First|Last/ }).locator('[data-slide-warning]').count() === 0)

  const mainBackstop = await page.evaluate(
    async ({ path, content }) => window.tw.talk.present(path, content, 'presenter'),
    { path: outlinePath, content: outline }
  )
  record(
    'main present backstop returns the human refusal',
    mainBackstop.success === false
      && mainBackstop.error === 'This talk has 1 unresolved trigger. Publishing, exporting and presenting live are blocked until it is fixed.',
    JSON.stringify(mainBackstop)
  )

  await page.keyboard.press('F5')
  await page.waitForSelector('.tw-unresolved-block')
  const modalText = await page.locator('.tw-unresolved-block').innerText()
  record('block modal names the first offending slide and line', modalText.includes('“Broken” at line 10'), modalText)
  await page.getByRole('button', { name: 'Open Layout Doctor' }).click()
  record('block modal opens the Layout Doctor fix path', await page.getByRole('dialog', { name: 'Layout Doctor — Unresolved probe' }).count() === 1)
} finally {
  await app.close()
}

if (failures) {
  console.error(`Unresolved-trigger state gate failed: ${failures} assertion${failures === 1 ? '' : 's'}`)
  process.exitCode = 1
} else {
  console.log('Unresolved-trigger state gate passed')
}
