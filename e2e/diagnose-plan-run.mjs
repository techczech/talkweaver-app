// Work-files ticket 11: the Plan a run sheet picks the slides, the pre-work and the post-work; Save writes
// the Run and opens its page in Sessions. Hidden-window Electron run against an isolated temp Vault/userData
// (TW_REC_TEST=1); no network.
//   (a) the sheet is 900px wide and its defaults come from the talk's `prework:` / `postwork:` metadata.
//   (b) the source choices: the talk's file "(from the talk)", another work file, None.
//   (c) Post-work Opens: "When the session ends" (default) or "At a set time…"; Closes is required.
//   (d) both validation states show the drawn message and a fix button that corrects the value.
//   (e) one Save writes the planned Run (work files and windows) and opens its page in Sessions.
//   (f) None leaves a phase off the Run; event text renders as text only; a pathway is chosen and made.
//   (g) History's Edit opens the same sheet; a plain talk starts with None.
//   (h) an attachment marked zone-mismatch shows the mark and is not planned over.
//   (i) ticket 26: New pathway… opens the Pathway view and the sheet keeps its draft and selects the new pathway;
//       the Run page's "Plan the next run like this" opens a sheet with the Run's plan, no date, and saves a new planned Run.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
function makeTalk(slug, title, body, meta = []) {
  const dir = join(vault, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${slug}-outline.md`), ['---', `title: ${title}`, 'outline_version: 2', ...meta, '---', '', body].join('\n'), 'utf8')
  mkdirSync(join(vault, '_PRESENTATIONS', slug), { recursive: true })
}
const workFile = (id, title, steps) => ['---', `id: ${id}`, `title: ${title}`, 'revision: 1', '---', '', 'Intro.', '', ...steps.flatMap(([sid, text, tokens]) => [`### ${text}`, `{id=${sid}}${tokens}`, 'x', ''])].join('\n')
mkdirSync(join(vault, 'Work files'), { recursive: true })
writeFileSync(join(vault, 'Work files', 'intake.md'), workFile('intake', 'Research teams intake', [['a', 'Watch', '{video}'], ['b', 'Say hello', '{poll=open}'], ['c', 'Try a prompt', '{task}']]))
writeFileSync(join(vault, 'Work files', 'feedback.md'), workFile('feedback', 'Session feedback', [['r', 'Useful?', '{poll=rating}'], ['u', 'Unclear?', '{poll=open}']]))
writeFileSync(join(vault, 'Work files', 'journal.md'), workFile('journal', 'Journal club prompts', [['j', 'Prompt', '{poll=open}']]))
makeTalk('prework-talk', 'Prework probe', [slide('s1', 'One'), slide('s2', 'Two'), slide('s3', 'Three')].join('\n'), ['prework: intake', 'postwork: feedback'])
makeTalk('plain-talk', 'Plain probe', [slide('p1', 'One'), slide('p2', 'Two')].join('\n'))
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2), 'utf8')

let failures = 0
const record = (label, pass, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures += 1
}
const runsOf = (slug) => readdirSync(join(vault, '_PRESENTATIONS', slug)).filter((n) => n.endsWith('.json') && n !== 'manifest.json')
  .map((n) => JSON.parse(readFileSync(join(vault, '_PRESENTATIONS', slug, n), 'utf8')))
const plusDays = (n) => { const t = new Date(); const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

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

  // (a) the sheet and its defaults
  await page.locator('.toolbar-btn--primary').click()
  const item = page.getByRole('menuitem', { name: /Plan a run…/ })
  record('Present menu carries Plan a run…', await item.count() === 1)
  await item.click()
  const sheet = page.locator('[data-testid="plan-run-sheet"]')
  await sheet.waitFor()
  await sheet.locator('[data-field="pre-file"]').waitFor()
  await page.waitForFunction(() => document.querySelector('[data-field="pre-file"]')?.value === 'intake')
  const box = await sheet.boundingBox()
  record('the sheet is 900px wide', Math.round(box.width) === 900, String(box.width))
  record('pre-work starts from the file the talk names', await sheet.locator('[data-field="pre-file"]').inputValue() === 'intake')
  record('post-work starts from the file the talk names', await sheet.locator('[data-field="post-file"]').inputValue() === 'feedback')
  record('the talk’s file is marked (from the talk)', (await sheet.locator('[data-field="pre-file"] option:checked').textContent()).includes('(from the talk)'))
  record('the steps of the file are listed', await sheet.locator('[data-field="pre-steps"] li').count() === 3 && await sheet.locator('[data-field="post-steps"] li').count() === 2)
  record('post-work opens when the session ends by default', await sheet.locator('[data-field="post-opens-mode"]').inputValue() === 'end')
  record('date and time start empty, as drawn', await sheet.locator('[data-field="date"]').inputValue() === '' && await sheet.locator('[data-field="start"]').inputValue() === '')
  await page.waitForFunction(() => /slides$/.test(document.querySelector('[data-field="slide-set"] option:checked')?.textContent ?? ''), null, { timeout: 10000 }).catch(() => {})
  record('the slides choice is Full talk with its slide count', /^Full talk · \d+ slides$/.test(await sheet.locator('[data-field="slide-set"] option:checked').textContent()))
  await page.screenshot({ path: join(shots, '01-new-empty.png') })

  // (b) source choices
  const preOptions = await sheet.locator('[data-field="pre-file"] option').allTextContents()
  record('the source offers the talk’s file, the other work files and None', preOptions.some((t) => t.startsWith('Research teams intake (from the talk) · 3 steps')) && preOptions.some((t) => t.startsWith('Journal club prompts · 1 step')) && preOptions.at(-1) === 'None', JSON.stringify(preOptions))
  await sheet.locator('[data-field="pre-file"]').selectOption('journal')
  record('another work file replaces the step list', await sheet.locator('[data-field="pre-steps"] li').count() === 1)
  await page.screenshot({ path: join(shots, '02-pre-work-source.png') })
  await sheet.locator('[data-field="pre-file"]').selectOption('intake')

  // (c) post-work Opens and Closes
  await sheet.locator('[data-field="post-opens-mode"]').selectOption('set')
  record('At a set time… shows a time field', await sheet.locator('[data-field="post-opens"]').count() === 1)
  await sheet.locator('[data-field="post-opens-mode"]').selectOption('end')
  record('back to When the session ends', await sheet.locator('[data-field="post-opens"]').count() === 0)
  record('post-work Closes says it is required', (await sheet.locator('[data-phase="post"] .pr-label').allTextContents()).some((t) => t.includes('required')))

  // empty plan is refused with a message and greyed Save
  record('Save looks unavailable while the plan is incomplete', await sheet.locator('[data-testid="plan-run-save"].is-pending').count() === 1)
  await sheet.locator('[data-testid="plan-run-save"]').click()
  record('an empty event is refused with a message', (await sheet.locator('[data-testid="plan-run-message"]').textContent()) === 'Give the event a name.' && runsOf('prework-talk').length === 0)

  // (f) text only
  const evil = 'ITSS <img src=x onerror="window.__pwned=1"> Briefing'
  const future = plusDays(8)
  await sheet.locator('[data-field="event"]').fill(evil)
  await sheet.locator('[data-field="date"]').fill(future)
  await sheet.locator('[data-field="start"]').fill('14:00')
  await sheet.locator('[data-field="expected"]').fill('22')
  await sheet.locator('[data-field="audience"]').fill('IT Services staff')
  await sheet.locator('[data-testid="plan-run-save"]').click()
  record('pre-work needs its opening time', (await sheet.locator('[data-testid="plan-run-message"]').textContent()) === 'Choose when pre-work opens.')
  await sheet.locator('[data-field="pre-opens"]').fill(`${plusDays(1)}T09:00`)
  await sheet.locator('[data-testid="plan-run-save"]').click()
  record('post-work needs its closing time', (await sheet.locator('[data-testid="plan-run-message"]').textContent()) === 'Choose when post-work closes.')

  // (d) validation states and fixes
  await sheet.locator('[data-field="pre-closes"]').fill(`${future}T14:30`)
  await sheet.locator('[data-field="post-closes"]').fill(`${plusDays(7)}T17:00`)
  const preIssue = sheet.locator('[data-issue="pre"]')
  const postIssue = sheet.locator('[data-issue="post"]')
  record('pre-work closing after the start shows the drawn message', (await preIssue.innerText()).includes('Pre-work must close before the session starts'))
  record('post-work closing before the session shows the drawn message', (await postIssue.innerText()).includes('Post-work must close after the session ends'))
  record('the pre-work fix reads Close at 13:00', (await sheet.locator('[data-fix="pre"]').innerText()).trim() === 'Close at 13:00')
  record('the post-work fix names a date and 17:00', /^Close \w{3} \d{1,2} \w{3} 17:00$/.test((await sheet.locator('[data-fix="post"]').innerText()).trim()), await sheet.locator('[data-fix="post"]').innerText())
  await page.screenshot({ path: join(shots, '03-validation-errors.png') })
  await sheet.locator('[data-testid="plan-run-save"]').click()
  record('Save is refused while a message stands', (await sheet.locator('[data-testid="plan-run-message"]').textContent()) === 'Pre-work must close before the session starts' && runsOf('prework-talk').length === 0)
  await sheet.locator('[data-fix="pre"]').click()
  await sheet.locator('[data-fix="post"]').click()
  record('the pre-work fix corrects the value', await sheet.locator('[data-field="pre-closes"]').inputValue() === `${future}T13:00`)
  record('the post-work fix corrects the value', (await sheet.locator('[data-field="post-closes"]').inputValue()) === `${plusDays(8 + 14)}T17:00`, await sheet.locator('[data-field="post-closes"]').inputValue())
  record('the messages are gone', await sheet.locator('[data-issue]').count() === 0)

  // pathway: New pathway… (slides choice)
  const pathwayWindowOpened = app.waitForEvent('window')
  await sheet.locator('[data-field="slide-set"]').selectOption({ label: 'New pathway…' })
  const pathwayWindow = await pathwayWindowOpened
  record('New pathway… opens the Pathway view', true)
  record('the sheet keeps its draft while the Pathway view is open', await sheet.count() === 1 && await sheet.locator('[data-field="event"]').inputValue() === evil && await sheet.locator('[data-field="expected"]').inputValue() === '22')
  // The pathway is made in the Pathway view (its own window); here the same call it makes, then the sheet's window is back in front.
  const preOutline = join(vault, 'prework-talk', 'prework-talk-outline.md')
  const made = await page.evaluate(([path, content]) => window.tw.pathways.create(path, content, 'Short 45 min'), [preOutline, readFileSync(preOutline, 'utf8')])
  record('the pathway was made', !('error' in made), JSON.stringify(made).slice(0, 200))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForFunction(() => /Short 45 min/.test(document.querySelector('[data-field="slide-set"] option:checked')?.textContent ?? ''))
  record('back in the sheet the new pathway is chosen', (await sheet.locator('[data-field="slide-set"] option:checked').textContent()).startsWith('Short 45 min'))
  record('the draft survived the round trip', await sheet.locator('[data-field="pre-closes"]').inputValue() === `${future}T13:00` && await sheet.locator('[data-field="audience"]').inputValue() === 'IT Services staff')
  await pathwayWindow.close().catch(() => {})
  await page.bringToFront()
  await page.screenshot({ path: join(shots, '04-filled.png') })

  // (e) one Save writes the Run and opens its page in Sessions
  const toolsOpened = app.waitForEvent('window')
  await sheet.locator('[data-testid="plan-run-save"]').click()
  await sheet.waitFor({ state: 'detached' })
  const planned = runsOf('prework-talk')
  record('saving writes one planned Run', planned.length === 1 && planned[0].status === 'planned', JSON.stringify(planned.map((r) => r.status)))
  const run = planned[0]
  record('the Run carries the plan fields', run?.startTime === '14:00' && run?.expectedPeople === 22 && run?.eventTitle === evil)
  record('the Run carries the pathway', run?.slideSet?.kind === 'pathway', JSON.stringify(run?.slideSet))
  record('the Run carries the pre-work file and window', run?.work?.pre?.fileId === 'intake' && run.work.pre.opens === `${plusDays(1)}T09:00` && run.work.pre.closes === `${future}T13:00`, JSON.stringify(run?.work?.pre))
  record('the Run carries the post-work file, opening at the session end', run?.work?.post?.fileId === 'feedback' && run.work.post.opens === 'session-end' && run.work.post.closes === `${plusDays(22)}T17:00`, JSON.stringify(run?.work?.post))
  record('the Run has the zone the times were read in', typeof run?.timeZone === 'string' && run.work.pre.timeZone === run.timeZone)
  const tools = await toolsOpened
  await tools.waitForSelector('[data-run-checklist]', { timeout: 15000 })
  record('the Run’s page opens in Sessions', await tools.locator('[data-run-checklist]').count() === 1)
  record('the page shows the pre-work and post-work steps of the checklist', await tools.locator('[data-run-step="pre-ready"]').count() === 1 && await tools.locator('[data-run-step="post-open"]').count() === 1)
  await tools.screenshot({ path: join(shots, '05-run-page.png') })
  record('event text renders as text only', await page.evaluate(() => !window.__pwned) && await tools.evaluate(() => !window.__pwned))
  record('a planned Run does not count as delivered', (await page.locator('body').innerText()).includes('Delivered never'))

  // (i) Plan the next run like this, from the Run page
  await tools.locator('[data-run-plan-like-this]').click()
  const cSheet = tools.locator('[data-testid="plan-run-sheet"]')
  await cSheet.waitFor()
  await cSheet.locator('[data-field="pre-file"]').waitFor()
  await tools.waitForFunction(() => document.querySelector('[data-field="pre-file"]')?.value === 'intake')
  await tools.waitForFunction(() => /^Short 45 min/.test(document.querySelector('[data-field="slide-set"] option:checked')?.textContent ?? ''))
  record('the copy sheet opens with the event, time, audience and expected people', await cSheet.locator('[data-field="event"]').inputValue() === evil && await cSheet.locator('[data-field="start"]').inputValue() === '14:00' && await cSheet.locator('[data-field="audience"]').inputValue() === 'IT Services staff' && await cSheet.locator('[data-field="expected"]').inputValue() === '22')
  record('the copy has no date', await cSheet.locator('[data-field="date"]').inputValue() === '')
  record('the copy keeps the files and the pathway', await cSheet.locator('[data-field="pre-file"]').inputValue() === 'intake' && await cSheet.locator('[data-field="post-file"]').inputValue() === 'feedback' && (await cSheet.locator('[data-field="slide-set"] option:checked').textContent()).startsWith('Short 45 min'))
  record('Save is refused until a date is chosen', (await (async () => { await cSheet.locator('[data-testid="plan-run-save"]').click(); return cSheet.locator('[data-testid="plan-run-message"]').textContent() })()) === 'Choose a date.')
  const nextDate = plusDays(15)
  await cSheet.locator('[data-field="date"]').fill(nextDate)
  record('choosing the date moves the windows with it', await cSheet.locator('[data-field="pre-opens"]').inputValue() === `${plusDays(8)}T09:00` && await cSheet.locator('[data-field="pre-closes"]').inputValue() === `${nextDate}T13:00` && await cSheet.locator('[data-field="post-closes"]').inputValue() === `${plusDays(29)}T17:00`, `${await cSheet.locator('[data-field="pre-opens"]').inputValue()} / ${await cSheet.locator('[data-field="pre-closes"]').inputValue()}`)
  await cSheet.locator('[data-field="event"]').fill('Copied run')
  await tools.screenshot({ path: join(shots, '07-copy-sheet.png') })
  await cSheet.locator('[data-testid="plan-run-save"]').click()
  await cSheet.waitFor({ state: 'detached' })
  const copied = runsOf('prework-talk').find((r) => r.eventTitle === 'Copied run')
  record('copying gives a new planned Run', Boolean(copied) && copied.status === 'planned' && copied.id !== run.id && runsOf('prework-talk').length === 2)
  record('the copy has the same slides and files, shifted windows', copied?.slideSet?.kind === 'pathway' && copied.slideSet.pathwayId === run.slideSet.pathwayId && copied.work?.pre?.fileId === 'intake' && copied.work.pre.opens === `${plusDays(8)}T09:00` && copied.work.post?.closes === `${plusDays(29)}T17:00`, JSON.stringify(copied?.work))
  record('the copy has no answers, pin, handout or published stamps', copied && !copied.handoutUrl && !copied.handoutFolder && !copied.publishedAt && !copied.unpublishedAt && !copied.answers && !copied.work.pre.publishedAt && !copied.work.post.publishedAt && !copied.pin)
  record('the first Run is untouched', runsOf('prework-talk').find((r) => r.id === run.id)?.plannedDate === future)
  await tools.close().catch(() => {})
  await page.bringToFront()

  // (f) None leaves the phase off the Run
  await page.locator('.toolbar-btn--primary').click()
  await page.getByRole('menuitem', { name: /Plan a run…/ }).click()
  await sheet.waitFor()
  await page.waitForFunction(() => document.querySelector('[data-field="pre-file"]')?.value === 'intake')
  await sheet.locator('[data-field="pre-file"]').selectOption('')
  record('None hides the step list, opens and closes', await sheet.locator('[data-field="pre-steps"]').count() === 0 && await sheet.locator('[data-field="pre-opens"]').count() === 0 && await sheet.locator('[data-field="pre-none"]').count() === 1)
  await sheet.locator('[data-field="event"]').fill('No pre-work run')
  await sheet.locator('[data-field="date"]').fill(plusDays(12))
  await sheet.locator('[data-field="start"]').fill('10:00')
  await sheet.locator('[data-field="post-closes"]').fill(`${plusDays(30)}T17:00`)
  const toolsAgain = app.waitForEvent('window')
  await sheet.locator('[data-testid="plan-run-save"]').click()
  await sheet.waitFor({ state: 'detached' })
  const second = runsOf('prework-talk').find((r) => r.eventTitle === 'No pre-work run')
  record('a Run planned with None has no pre-work file', second && !second.work?.pre && second.work?.post?.fileId === 'feedback', JSON.stringify(second?.work))
  const toolsTwo = await toolsAgain
  await toolsTwo.waitForSelector('[data-run-checklist]', { timeout: 15000 })
  record('its checklist has no pre-work steps', await toolsTwo.locator('[data-run-step="pre-ready"], [data-run-step="pre-closes"]').count() === 0, await toolsTwo.locator('[data-run-step]').evaluateAll((els) => els.map((el) => el.getAttribute('data-run-step')).join(',')))
  await toolsTwo.close().catch(() => {})
  await page.bringToFront()

  // (g) History
  const historyPromise = app.waitForEvent('window')
  await page.evaluate(() => window.dispatchEvent(new Event('tw-open-history')))
  const history = await historyPromise
  await history.waitForSelector('.twhistory')
  await history.waitForSelector('[data-planned-run]')
  await history.locator('[data-planned-run] summary').first().click()
  await history.locator('[data-plan-edit]').first().click()
  const hSheet = history.locator('[data-testid="plan-run-sheet"]')
  await hSheet.waitFor()
  const editing = (await hSheet.locator('[data-field="event"]').inputValue())
  record('History Edit opens the same sheet with the Run in it', editing === evil || editing === 'No pre-work run', editing)
  await hSheet.locator('[data-field="expected"]').fill('30')
  await hSheet.locator('[data-testid="plan-run-save"]').click()
  await hSheet.waitFor({ state: 'detached' })
  record('editing updates the same Run', runsOf('prework-talk').length === 3 && runsOf('prework-talk').some((r) => r.expectedPeople === 30))
  await history.locator('.twh-plan-button').click()
  await hSheet.waitFor()
  record('History Plan a Run opens a blank sheet', (await hSheet.locator('[data-field="event"]').inputValue()) === '')
  await hSheet.locator('[data-field="talk"]').selectOption('plain-talk')
  await history.waitForFunction(() => document.querySelector('[data-field="pre-file"]')?.value === '')
  record('a talk that names no work files starts with None for both', await hSheet.locator('[data-field="pre-file"]').inputValue() === '' && await hSheet.locator('[data-field="post-file"]').inputValue() === '')
  await hSheet.locator('[data-field="event"]').fill('Plain event')
  await hSheet.locator('[data-field="date"]').fill(plusDays(20))
  await hSheet.locator('[data-field="start"]').fill('11:00')
  const toolsThree = app.waitForEvent('window', { timeout: 15000 }).catch(() => null)
  await hSheet.locator('[data-testid="plan-run-save"]').click()
  await hSheet.waitFor({ state: 'detached' })
  const plain = runsOf('plain-talk')
  record('History saved a Run for the chosen talk with no work files', plain.length === 1 && plain[0].startTime === '11:00' && !plain[0].work)
  await toolsThree
  await history.close().catch(() => {})

  // (h) zone-mismatch: the mark is shown and the attachment is not planned over
  const target = readdirSync(join(vault, '_PRESENTATIONS', 'prework-talk')).filter((n) => n.endsWith('.json') && n !== 'manifest.json').find((n) => JSON.parse(readFileSync(join(vault, '_PRESENTATIONS', 'prework-talk', n), 'utf8')).eventTitle === evil)
  const file = join(vault, '_PRESENTATIONS', 'prework-talk', target)
  const marked = JSON.parse(readFileSync(file, 'utf8'))
  marked.work.pre.timeZone = marked.timeZone === 'Asia/Tokyo' ? 'Europe/London' : 'Asia/Tokyo'
  writeFileSync(file, `${JSON.stringify(marked, null, 2)}\n`, 'utf8')
  const history3Promise = app.waitForEvent('window')
  await page.evaluate(() => window.dispatchEvent(new Event('tw-open-history')))
  const history3 = await history3Promise
  await history3.waitForSelector('[data-planned-run]')
  const rows = history3.locator('[data-planned-run]')
  const count = await rows.count()
  let opened = false
  for (let i = 0; i < count && !opened; i += 1) {
    await rows.nth(i).locator('summary').click()
    await history3.locator('[data-plan-edit]').nth(i).click().catch(() => {})
    const candidate = history3.locator('[data-testid="plan-run-sheet"]')
    await candidate.waitFor({ timeout: 4000 }).catch(() => {})
    if (await candidate.count() && (await candidate.locator('[data-field="event"]').inputValue()) === evil) opened = true
    else if (await candidate.count()) { await candidate.locator('[data-testid="plan-run-cancel"]').click(); await candidate.waitFor({ state: 'detached' }) }
  }
  const mSheet = history3.locator('[data-testid="plan-run-sheet"]')
  record('the marked Run’s sheet opens', opened)
  record('the pre-work block shows the zone mark', await mSheet.locator('[data-testid="plan-run-pre-mark"]').count() === 1)
  record('the marked block cannot be changed', await mSheet.locator('[data-field="pre-file"]').isDisabled() && await mSheet.locator('[data-field="pre-opens"]').count() === 0)
  record('the other phase is still planned normally', await mSheet.locator('[data-field="post-closes"]').isEnabled())
  await history3.screenshot({ path: join(shots, '06-zone-mismatch.png') })
  await mSheet.locator('[data-field="expected"]').fill('31')
  await mSheet.locator('[data-testid="plan-run-save"]').click()
  await mSheet.waitFor({ state: 'detached' })
  const after = JSON.parse(readFileSync(file, 'utf8'))
  record('saving leaves the marked attachment as it was found', after.expectedPeople === 31 && after.work.pre.timeZone === marked.work.pre.timeZone && after.work.pre.fileId === 'intake', JSON.stringify(after.work?.pre))
  await history3.close().catch(() => {})
} finally {
  await app.close().catch(() => {})
}
console.log(failures ? `plan-run e2e: ${failures} FAILED` : 'plan-run e2e: all passed')
process.exit(failures ? 1 : 0)
