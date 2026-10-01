// Boards ticket 07: a Run is planned from the talk, and the talk shows its next Run.
// Hidden-window Electron run against an isolated temp Vault/userData; no network.
//   (a) a talk with pre-work and no Run says "No run planned · Plan a run…" in the status bar.
//   (b) Present › Plan a run… opens the plan sheet; pre-work is on for a talk that has it.
//   (c) saving writes the planned Run (start time, expected people, pre-work opens, closes = talk start).
//   (d) the status bar shows "Next run: <event>, <date>" and the pre-work chip; a planned Run does not
//       make the status bar say "Delivered <date>".
//   (e) the chip's popover edits the plan; changing the count and setting a closing time land on disk.
//   (f) event text renders as text only.
//   (g) History shows the planned row's pre-work cell and opens the same sheet from its Edit and Plan a Run.
//   (h) a talk without pre-work: no nudge, no pre-work toggle.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const repo = process.cwd()
const shots = join(tmpdir(), 'tw-b07-shots')
mkdirSync(shots, { recursive: true })
const tempRoot = mkdtempSync(join(tmpdir(), 'talkweaver-plan-run-'))
const vault = join(tempRoot, 'vault')
const userData = join(tempRoot, 'userData')
mkdirSync(userData, { recursive: true })

const slide = (id, title) => `### ${title}\n{id=${id}}\n\n${title} body.\n`
function makeTalk(slug, title, body) {
  const dir = join(vault, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${slug}-outline.md`), ['---', `title: ${title}`, 'outline_version: 2', '---', '', body].join('\n'), 'utf8')
  mkdirSync(join(vault, '_PRESENTATIONS', slug), { recursive: true })
}
makeTalk('prework-talk', 'Prework probe', [
  slide('s1', 'One'), '## Before the session\n{prework}\n', slide('w1', 'Welcome things'), slide('w2', 'Answer this'), '## After\n{id=after}\n', slide('s2', 'Two')
].join('\n'))
makeTalk('plain-talk', 'Plain probe', [slide('p1', 'One'), slide('p2', 'Two')].join('\n'))
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2), 'utf8')

let failures = 0
const record = (label, pass, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures += 1
}
const runsOf = (slug) => readdirSync(join(vault, '_PRESENTATIONS', slug)).filter((n) => n.endsWith('.json') && n !== 'manifest.json')
  .map((n) => JSON.parse(readFileSync(join(vault, '_PRESENTATIONS', slug, n), 'utf8')))
const plusDays = (n) => { const d = new Date(Date.now() + n * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

await ensureFreshBuild(repo)
let app
for (let attempt = 1; attempt <= 3 && !app; attempt += 1) {
  try {
    app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: repo, env: { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }, timeout: 60000 })
  } catch (error) {
    if (attempt === 3) throw error
    console.log(`launch attempt ${attempt} failed (${error.message}); retrying`)
  }
}
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {})
  await page.waitForLoadState('domcontentloaded')
  await page.getByText('Prework probe', { exact: true }).first().click()
  await page.waitForSelector('.workspace')

  // (a)
  await page.waitForSelector('[data-testid="status-run-nudge"]')
  record('a talk with pre-work and no Run shows the nudge', (await page.locator('[data-testid="status-run-nudge"]').textContent()) === 'No run planned · Plan a run…')
  record('the status bar says Delivered never', (await page.locator('body').innerText()).includes('Delivered never'))

  // (b)
  await page.locator('.toolbar-btn--primary').click()
  const item = page.getByRole('menuitem', { name: /Plan a run…/ })
  record('Present menu carries Plan a run…', await item.count() === 1)
  await page.screenshot({ path: join(shots, '01-present-menu.png') })
  await item.click()
  const sheet = page.locator('[data-testid="plan-run-sheet"]')
  await sheet.waitFor()
  await sheet.locator('[data-testid="plan-run-prework"]').waitFor()
  record('the sheet opens with pre-work on for a talk that has it', await sheet.locator('[data-field="prework-toggle"]').getAttribute('aria-checked') === 'true')
  record('the sheet says how many steps the pre-work has', (await sheet.locator('.pr-prework-head').innerText()).includes('2 steps'))
  record('closing defaults to when the talk starts', (await sheet.locator('[data-field="closes-mode"] option:checked').textContent()).startsWith("When the talk starts"))

  // (f) text only + (c)
  const evil = 'ITSS <img src=x onerror="window.__pwned=1"> Briefing'
  const future = plusDays(8)
  await sheet.locator('[data-field="event"]').fill(evil)
  await sheet.locator('[data-field="date"]').fill(future)
  await sheet.locator('[data-field="expected"]').fill('22')
  await sheet.locator('[data-field="audience"]').fill('IT Services staff')
  await page.screenshot({ path: join(shots, '02-plan-sheet.png') })
  await sheet.locator('[data-testid="plan-run-save"]').click()
  await sheet.waitFor({ state: 'detached' })
  const planned = runsOf('prework-talk')
  record('saving writes one planned Run', planned.length === 1 && planned[0].status === 'planned', JSON.stringify(planned.map((r) => r.status)))
  const run = planned[0]
  record('the Run carries the plan fields', run?.startTime === '10:00' && run?.expectedPeople === 22 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(run?.preworkOpens ?? '') && !('preworkCloses' in run), JSON.stringify({ s: run?.startTime, e: run?.expectedPeople, o: run?.preworkOpens }))

  // (d)
  await page.waitForSelector('[data-testid="status-run"]')
  const runChip = await page.locator('[data-testid="status-run"]').textContent()
  record('the status bar shows the next Run', runChip.startsWith('Next run: ITSS <img src=x onerror="window.__pwned=1"> Briefing, '), runChip)
  record('the pre-work chip is shown', /^Pre-work(?: opens \d+ \w{3}|: 0 (?:of \d+ )?started)$/.test(await page.locator('[data-testid="status-prework"]').textContent()))
  record('the nudge is gone once a Run is planned', await page.locator('[data-testid="status-run-nudge"]').count() === 0)
  record('a planned Run does not count as delivered', (await page.locator('body').innerText()).includes('Delivered never'))
  record('event text renders as text only', await page.evaluate(() => !window.__pwned && document.querySelectorAll('[data-testid="status-run"] img').length === 0))

  // (e)
  await page.locator('[data-testid="status-run"]').click()
  const popover = page.locator('[data-testid="run-popover"]')
  await popover.waitFor()
  record('the popover states the audience and head count', (await popover.innerText()).includes('IT Services staff · 22 expected'))
  await page.screenshot({ path: join(shots, '03-run-popover.png') })
  await page.locator('[data-testid="run-popover-edit"]').click()
  await sheet.waitFor()
  record('Edit plan… opens the sheet with the Run in it', (await sheet.locator('[data-field="expected"]').inputValue()) === '22' && (await sheet.locator('[data-field="event"]').inputValue()) === evil)
  await sheet.locator('[data-field="expected"]').fill('30')
  await sheet.locator('[data-field="closes-mode"]').selectOption('set')
  await sheet.locator('[data-field="closes"]').fill(`${plusDays(7)}T18:00`)
  await sheet.locator('[data-testid="plan-run-save"]').click()
  await sheet.waitFor({ state: 'detached' })
  const edited = runsOf('prework-talk')
  record('editing updates the same Run', edited.length === 1 && edited[0].id === run.id && edited[0].expectedPeople === 30 && edited[0].preworkCloses === `${plusDays(7)}T18:00`)

  // validation
  await page.locator('.toolbar-btn--primary').click()
  await page.getByRole('menuitem', { name: /Plan a run…/ }).click()
  await sheet.waitFor()
  await sheet.locator('[data-testid="plan-run-save"]').click()
  record('an empty event is refused with a message', (await sheet.locator('[data-testid="plan-run-message"]').textContent()) === 'Give the event a name.' && runsOf('prework-talk').length === 1)
  await sheet.locator('[data-testid="plan-run-cancel"]').click()
  await sheet.waitFor({ state: 'detached' })

  // (g) History
  const historyPromise = app.waitForEvent('window')
  await page.evaluate(() => window.dispatchEvent(new Event('tw-open-history')))
  const history = await historyPromise
  await history.waitForSelector('.twhistory')
  await history.waitForSelector('[data-planned-run]')
  const cell = await history.locator('[data-plan-prework]').first().innerText()
  record('History shows the pre-work cell of the planned row', cell.startsWith('Opens '), cell.replace(/\n/g, ' | '))
  record('History has no inline plan form any more', await history.locator('[data-plan-run-form]').count() === 0)
  await history.locator('[data-planned-run] summary').first().click()
  await history.locator('[data-plan-edit]').first().click()
  const hSheet = history.locator('[data-testid="plan-run-sheet"]')
  await hSheet.waitFor()
  record('History Edit opens the same sheet with the Run in it', (await hSheet.locator('[data-field="expected"]').inputValue()) === '30')
  await history.screenshot({ path: join(shots, '04-history-edit-sheet.png') })
  await hSheet.locator('[data-testid="plan-run-cancel"]').click()
  await history.locator('.twh-plan-button').click()
  await hSheet.waitFor()
  record('History Plan a Run opens a blank sheet', (await hSheet.locator('[data-field="event"]').inputValue()) === '')
  await hSheet.locator('[data-field="talk"]').selectOption('plain-talk')
  await hSheet.locator('[data-field="event"]').fill('Plain event')
  await hSheet.locator('[data-field="date"]').fill(plusDays(20))
  await hSheet.locator('[data-testid="plan-run-prework"]').waitFor({ state: 'detached' }).catch(() => {})
  record('a talk without pre-work has no pre-work toggle', await hSheet.locator('[data-testid="plan-run-prework"]').count() === 0)
  await history.screenshot({ path: join(shots, '05-history-plain-talk-sheet.png') })
  await hSheet.locator('[data-testid="plan-run-save"]').click()
  await hSheet.waitFor({ state: 'detached' })
  const plain = runsOf('plain-talk')
  record('History saved a Run for the chosen talk without pre-work', plain.length === 1 && plain[0].startTime === '10:00' && !('preworkOpens' in plain[0]))
  await history.screenshot({ path: join(shots, '06-history-planned-rows.png') })
  await history.close().catch(() => {})

  // (h) plain talk in the editor
  await page.bringToFront()
  await page.getByText('Plain probe', { exact: true }).first().click()
  await page.locator('[data-testid="status-run"]', { hasText: 'Plain event' }).waitFor()
  record('a talk without pre-work shows its Run but no pre-work chip and no nudge', await page.locator('[data-testid="status-prework"]').count() === 0 && await page.locator('[data-testid="status-run-nudge"]').count() === 0)
  await page.screenshot({ path: join(shots, '07-plain-talk-status-bar.png') })

  // (i) Plan a run… with no talk open goes to History's sheet with the talk picker (the call the
  // command makes when no talk is open); the History window is new here.
  const later = app.waitForEvent('window')
  await page.evaluate(() => window.tw.tools.open('history', 'plan-run'))
  const history2 = await later
  await history2.waitForSelector('[data-testid="plan-run-sheet"]')
  record('Plan a run… with no talk open opens History with the sheet and a talk picker', await history2.locator('[data-field="talk"]').count() === 1)
  await history2.screenshot({ path: join(shots, '08-no-talk-plan-sheet.png') })
} finally {
  await app.close().catch(() => {})
}
console.log(failures ? `plan-run e2e: ${failures} FAILED` : 'plan-run e2e: all passed')
process.exit(failures ? 1 : 0)
