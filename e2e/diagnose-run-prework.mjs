// Feedback-boards ticket 11: the Run page for a planned Run's pre-work, in the real app.
// Hidden-window Electron run against an isolated temp Vault/userData on a seeded Run; no network.
//   (a) the status bar's Pre-work chip -> "Review pre-work" opens History on the Run page (R1);
//   (b) the overview counts people, finishers, tasks, questions and the per-step table (R2);
//   (c) an open question lists every answer as text (markup shown, never interpreted); stars pick
//       answers, in order, and the Run file on disk keeps them; "Every answer" switches the mode (R3);
//   (d) the quick check shows the spread with the right answer marked, for the author only (R4);
//   (e) questions about steps: Put in the talk's questions and Mark answered (and Undo) reach the Run (R5);
//   (f) the planned row's Review button opens the same page; Back returns to the ledger;
//   (g) a Run's own numbers survive: nothing of the Run page is written to the outline.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OUTLINE, RUN_ID, SLUG, plannedRun } from '../scripts/lib/prework-run-fixture.mjs'

const repo = process.cwd()
const shots = join(tmpdir(), 'tw-b11-shots')
mkdirSync(shots, { recursive: true })
const tempRoot = mkdtempSync(join(tmpdir(), 'talkweaver-run-prework-'))
const vault = join(tempRoot, 'vault')
const userData = join(tempRoot, 'userData')
mkdirSync(userData, { recursive: true })
const plusDays = (n) => { const d = new Date(Date.now() + n * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

const talkDir = join(vault, SLUG)
mkdirSync(talkDir, { recursive: true })
mkdirSync(join(vault, '_PRESENTATIONS', SLUG), { recursive: true })
const outlinePath = join(talkDir, `${SLUG}-outline.md`)
writeFileSync(outlinePath, OUTLINE, 'utf8')
const runPath = join(vault, '_PRESENTATIONS', SLUG, `${RUN_ID}.json`)
writeFileSync(runPath, JSON.stringify(plannedRun({ plannedDate: plusDays(10), preworkOpens: `${plusDays(-8)}T09:00`, preworkCloses: `${plusDays(10)}T10:00` }), null, 2), 'utf8')
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2), 'utf8')
const readRun = () => JSON.parse(readFileSync(runPath, 'utf8'))

let failures = 0
const record = (label, pass, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures += 1
}

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
  await page.getByText('The current state of AI agents', { exact: true }).first().click()
  await page.waitForSelector('.workspace')

  // (a) the way in
  await page.waitForSelector('[data-testid="status-prework"]')
  record('the status bar counts who started, against the expected people', (await page.locator('[data-testid="status-prework"]').textContent()) === 'Pre-work: 9 of 12 started', await page.locator('[data-testid="status-prework"]').textContent())
  await page.locator('[data-testid="status-prework"]').click()
  await page.locator('[data-testid="run-popover"]').waitFor()
  record('the popover says how many started and finished', (await page.locator('[data-testid="run-popover-progress"]').textContent()) === '9 started · 4 finished')
  record('the chip popover offers Review pre-work', await page.locator('[data-testid="run-popover-review"]').count() === 1)
  await page.screenshot({ path: join(shots, 'R1-way-in-editor.png') })
  const historyPromise = app.waitForEvent('window')
  await page.locator('[data-testid="run-popover-review"]').click()
  const history = await historyPromise
  await history.waitForSelector('[data-prework-page]', { timeout: 20_000 })
  record('History opens on the Run page', true)
  await history.setViewportSize({ width: 1440, height: 900 }).catch(() => {})
  const pageRoot = history.locator('[data-prework-page]')

  // (b) overview
  await pageRoot.locator('[data-pwr-overview]').waitFor()
  const started = await pageRoot.locator('[data-pwr-started]').innerText()
  const finished = await pageRoot.locator('[data-pwr-finished]').innerText()
  record('the overview counts nine started, of twelve expected', started === '9' && (await pageRoot.locator('.pwr-stat').first().innerText()).includes('of 12 expected'), started)
  record('the overview counts the four who did every step', finished === '4', finished)
  record('the overview lists four steps and three questions', await pageRoot.locator('[data-pwr-step]').count() === 4 && (await pageRoot.locator('[data-pwr-questions]').innerText()) === '3')
  record('the header says the pre-work is not on a handout yet (no service in this run)', (await pageRoot.locator('[data-pwr-state]').innerText()).length > 0)
  await history.screenshot({ path: join(shots, 'R2-overview.png') })

  // (c) open answers and stars
  await pageRoot.locator('[data-pwr-rail="pwhope"]').click()
  await pageRoot.locator('[data-pwr-answers]').waitFor()
  const answers = pageRoot.locator('[data-pwr-answer]')
  record('every answer is listed', await answers.count() === 6)
  record('the slide that takes the answers is named, with its place in the compiled deck', /What do you hope for today\?”\s*\(slide \d+\)/.test(await pageRoot.locator('[data-pwr-in-talk]').innerText()), (await pageRoot.locator('[data-pwr-in-talk]').innerText()).slice(0, 90))
  record('markup in an answer is shown as text, never interpreted', await history.evaluate(() => {
    const p = [...document.querySelectorAll('[data-pwr-answer] p')].find((node) => node.textContent.includes('Bold hopes'))
    return Boolean(p) && p.textContent === '<b>Bold hopes</b> & more' && p.querySelector('b') === null && !window.__pwned
  }))
  record('with nothing starred, every answer is the mode', await pageRoot.locator('[data-pwr-mode="all"]').isChecked())
  await answers.nth(2).locator('[data-pwr-star]').click()
  await answers.nth(0).locator('[data-pwr-star]').click()
  await history.waitForFunction(() => document.querySelectorAll('[data-pwr-answer].picked').length === 2)
  const run1 = readRun()
  const ids = run1.prework.entries.filter((entry) => entry.kind === 'answer' && entry.stepId === 'pwhope').sort((a, b) => a.at - b.at).map((entry) => entry.id)
  record('starring switches to "only the answers I pick" and the Run keeps the picks in order', await pageRoot.locator('[data-pwr-mode="picked"]').isChecked() && JSON.stringify(run1.prework.picks?.pwhope) === JSON.stringify({ mode: 'picked', ids: [ids[2], ids[0]] }), JSON.stringify(run1.prework.picks))
  record('the Picked tab counts two and the aside lists them in order', (await pageRoot.locator('[data-pwr-picked-tab]').innerText()).includes('2')
    && (await pageRoot.locator('[data-pwr-pick]').allInnerTexts()).map((text) => text.replace(/\s+/g, ' ')).join('|').startsWith('1 Whether it is allowed with student data'))
  await pageRoot.locator('[data-pwr-pick]').nth(1).locator('button').first().click()
  await history.waitForFunction(() => document.querySelector('[data-pwr-pick] span')?.textContent?.startsWith('Use an agent'))
  record('a pick moves earlier and the Run keeps the new order', JSON.stringify(readRun().prework.picks.pwhope.ids) === JSON.stringify([ids[0], ids[2]]))
  await history.screenshot({ path: join(shots, 'R3-answers-and-stars.png') })
  await pageRoot.locator('[data-pwr-mode="all"]').click()
  await history.waitForFunction(() => document.querySelector('[data-pwr-mode="all"]')?.checked)
  record('Every answer is kept as the mode, with the stars remembered', readRun().prework.picks.pwhope.mode === 'all' && readRun().prework.picks.pwhope.ids.length === 2)
  await pageRoot.locator('[data-pwr-group]').click()
  record('Group similar merges identical answers into one row', await answers.count() === 5 && (await pageRoot.locator('.pwr-times').first().innerText()) === '×2')
  await pageRoot.locator('[data-pwr-group]').click()

  // (d) the quick check
  await pageRoot.locator('[data-pwr-rail="pwquiz"]').click()
  await pageRoot.locator('[data-pwr-check]').waitFor()
  const options = await pageRoot.locator('[data-pwr-option]').allInnerTexts()
  record('the quick check lists its four options with counts and shares', options.length === 4 && options[1].includes('5') && options[1].includes('63%'), options.join(' / ').replace(/\n/g, ' '))
  record('the right answer is marked, for the author only', await pageRoot.locator('[data-pwr-option="1"].right').count() === 1 && (await pageRoot.locator('.pwr-only').innerText()).toLowerCase().includes('only you see the marks'))
  record('the note names the most common wrong answer', (await pageRoot.locator('[data-pwr-check-note]').innerText()).includes('Answers questions in full sentences'))
  await history.screenshot({ path: join(shots, 'R4-quick-check.png') })

  // (e) questions about steps
  await pageRoot.locator('[data-pwr-rail="questions"]').click()
  await pageRoot.locator('[data-pwr-questions-pane]').waitFor()
  record('questions are grouped by step', await pageRoot.locator('[data-pwr-qgroup]').count() === 2 && await pageRoot.locator('[data-pwr-question]').count() === 3)
  record('a name shows only where one was typed', (await pageRoot.locator('[data-pwr-questions-pane]').innerText()).includes('Sam') && (await pageRoot.locator('[data-pwr-questions-pane]').innerText()).includes('no name'))
  await history.screenshot({ path: join(shots, 'R5-questions.png') })
  const first = pageRoot.locator('[data-pwr-question]').first()
  await first.locator('[data-pwr-answer-mark]').click()
  await first.locator('[data-pwr-undo]').waitFor()
  const marked = readRun().prework.entries.filter((entry) => entry.kind === 'question' && entry.answered)
  record('Mark answered reaches the Run', marked.length === 1)
  await first.locator('[data-pwr-undo]').click()
  await first.locator('[data-pwr-answer-mark]').waitFor()
  record('Undo takes the mark off again', readRun().prework.entries.every((entry) => !entry.answered))
  const target = pageRoot.locator('[data-pwr-qgroup="pwtask1"] [data-pwr-question]').first()
  await target.locator('[data-pwr-intalk]').click()
  await history.waitForFunction(() => document.querySelectorAll('[data-pwr-question] [data-pwr-intalk]').length === 2)
  const inTalk = readRun().prework.entries.filter((entry) => entry.inTalk)
  record('Put in the talk’s questions records the slide the step feeds (none here: the slide it is on)', inTalk.length === 1 && inTalk[0].inTalk.slideId === null, JSON.stringify(inTalk.map((entry) => entry.inTalk)))
  await pageRoot.locator('[data-pwr-qfilter="in-talk"]').click()
  record('the In the talk filter lists it', await pageRoot.locator('[data-pwr-question]').count() === 1)

  // (f) the planned row's Review button
  await pageRoot.locator('[data-pwr-back]').click()
  await history.waitForSelector('[data-planned-run]')
  record('Back returns to the ledger', await history.locator('[data-prework-page]').count() === 0)
  record('the planned row counts who started', (await history.locator('[data-plan-prework-count]').innerText()).includes('9 started'))
  await history.locator('[data-review-prework]').click()
  await history.waitForSelector('[data-prework-page]')
  record('the planned row\'s Review opens the same page', true)
  record('nothing of the Run page reached the outline', readFileSync(outlinePath, 'utf8') === OUTLINE)
  record('no script ran from any answer or question', await history.evaluate(() => !window.__pwned))
} finally {
  await app.close().catch(() => {})
}
console.log(failures ? `run-prework e2e: ${failures} FAILED` : 'run-prework e2e: all passed')
process.exit(failures ? 1 : 0)
