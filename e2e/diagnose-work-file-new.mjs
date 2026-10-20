// Work-files ticket 07: make a new work file in the real app (hidden window, temp vault, isolated userData).
//   (a) New file asks for a title; nothing is on disk or in the list until Save;
//   (b) the Add row offers Video, Slide, Quick check, Task, Question; Question offers every poll type;
//   (c) a blank file gets no steps; adding an open question writes `Work files/<slug>.md` that reads back as that question;
//   (d) the file shows in the list and opens; a preset fills steps only when chosen;
//   (e) a title that collides with an existing file is refused with a reason, and nothing is overwritten;
//   (f) adding a step to the open file bumps its revision on disk.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readWorkFile } from '../src/shared/work-file.ts'

const shotsDir = process.env.TW_SHOTS_DIR || ''
if (shotsDir) mkdirSync(shotsDir, { recursive: true })
let failures = 0
const rec = (name, ok, detail) => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`) }
await ensureFreshBuild(process.cwd())

const root = mkdtempSync(join(tmpdir(), 'tw-work-file-new-e2e-'))
const vault = join(root, 'vault'); const ud = join(root, 'userData')
mkdirSync(join(vault, 'Work files'), { recursive: true }); mkdirSync(ud, { recursive: true })
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))
const EXISTING = '---\nid: existing-one\ntitle: Existing one\nrevision: 1\n---\n\n### Hello\n{id=hello}\nHi\n'
writeFileSync(join(vault, 'Work files', 'existing-one.md'), EXISTING)
const dir = join(vault, 'Work files')

const env = { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }
let app
for (let attempt = 1; attempt <= 3; attempt += 1) {
  try { app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: process.cwd(), env, timeout: 60_000 }); break }
  catch (error) { if (attempt === 3) throw error; await new Promise((r) => setTimeout(r, 15_000)) }
}
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  const pending = app.waitForEvent('window')
  await page.evaluate(() => window.tw.tools.open('workfiles'))
  const tools = await pending
  await tools.waitForLoadState('domcontentloaded')
  await tools.waitForSelector('[data-tools-view="workfiles"]', { timeout: 10_000 })
  tools.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 150)))
  await tools.waitForSelector('[data-wf-row]', { timeout: 10_000 })

  await tools.locator('[data-wf-new-file]').click()
  await tools.waitForSelector('[data-wf-new]')
  rec('New file shows a title box, Cancel and Save file', await tools.locator('[data-wf-title]').count() === 1 && await tools.locator('[data-wf-cancel]').count() === 1 && await tools.locator('[data-wf-save]').count() === 1)
  rec('Save is off until there is a title', await tools.locator('[data-wf-save]').isDisabled())
  rec('nothing is written or listed before Save', readdirSync(dir).length === 1 && await tools.locator('[data-wf-row]').count() === 1)
  rec('the draft says Not saved with 0 steps', ((await tools.locator('[data-wf-new]').textContent()) ?? '').includes('No steps yet') && ((await tools.locator('[data-wf-draft-row]').textContent()) ?? '').includes('Not saved'))
  const addLabels = (await tools.locator('[data-wf-addrow] > button').allTextContents()).map((t) => t.trim())
  rec('the Add row offers Video, Slide, Quick check, Task, Question', ['Video', 'Slide', 'Quick check', 'Task', 'Question'].every((l) => addLabels.includes(l)) && addLabels.length === 5 && !addLabels.some((l) => /rating/i.test(l)), addLabels.join(', '))
  await tools.locator('[data-wf-add="question"]').click()
  const types = await tools.locator('[data-wf-add-poll]').evaluateAll((els) => els.map((e) => e.getAttribute('data-wf-add-poll')))
  rec('Question offers every poll type', ['single', 'multiple', 'open', 'ranking', 'rating', 'categorisation', 'board'].every((t) => types.includes(t)) && types.length === 7, types.join(','))
  rec('no preset is chosen by default', await tools.locator('[data-wf-preset="blank"]').isChecked())
  if (shotsDir) await tools.screenshot({ path: join(shotsDir, 'wf-new.png') }).catch(() => {})

  await tools.locator('[data-wf-title]').fill('Pre-session check')
  await tools.locator('[data-wf-add-poll="open"]').click()
  rec('the added step shows in the draft', ((await tools.locator('[data-wf-step]').allTextContents())[0] ?? '').includes('Open question'))
  rec('still nothing on disk before Save', !existsSync(join(dir, 'pre-session-check.md')))
  await tools.locator('[data-wf-save]').click()
  await tools.waitForSelector('[data-wf-detail="pre-session-check.md"]', { timeout: 8000 })
  const text = readFileSync(join(dir, 'pre-session-check.md'), 'utf8')
  const reading = readWorkFile(text)
  rec('file is on disk with id, title and revision 1', reading.definition.id === 'pre-session-check' && reading.definition.title === 'Pre-session check' && reading.revision === 1, text.slice(0, 80))
  rec('its one step reads back as an open question', reading.definition.steps.length === 1 && reading.definition.steps[0].kind === 'question' && reading.definition.steps[0].pollType === 'open')
  rec('it shows in the list and is open', await tools.locator('[data-wf-row="pre-session-check.md"]').count() === 1 && await tools.locator('[data-wf-step]').count() === 1)

  // A blank file: no questions it did not get.
  await tools.locator('[data-wf-new-file]').click()
  await tools.locator('[data-wf-title]').fill('Empty one')
  await tools.locator('[data-wf-save]').click()
  await tools.waitForSelector('[data-wf-detail="empty-one.md"]', { timeout: 8000 })
  rec('a blank file opens empty and has no questions', ((await tools.locator('[data-wf-detail="empty-one.md"]').textContent()) ?? '').includes('No steps yet') && readWorkFile(readFileSync(join(dir, 'empty-one.md'), 'utf8')).definition.steps.length === 0)

  // A preset fills steps only when chosen.
  await tools.locator('[data-wf-new-file]').click()
  await tools.locator('[data-wf-title]').fill('After the session')
  await tools.locator('[data-wf-preset="survey-learnt"]').check()
  rec('choosing the preset shows its two steps in the draft', await tools.locator('[data-wf-new] [data-wf-step]').count() === 2)
  await tools.locator('[data-wf-save]').click()
  await tools.waitForSelector('[data-wf-detail="after-the-session.md"]', { timeout: 8000 })
  const survey = readWorkFile(readFileSync(join(dir, 'after-the-session.md'), 'utf8'))
  rec('the preset file has two open questions on disk', survey.definition.steps.length === 2 && survey.definition.steps.every((s) => s.pollType === 'open'))

  // Add a step to the open file.
  await tools.locator('[data-wf-add="task"]').click()
  await tools.waitForFunction(() => document.querySelectorAll('[data-wf-detail] [data-wf-step]').length === 3, null, { timeout: 8000 })
  const grown = readWorkFile(readFileSync(join(dir, 'after-the-session.md'), 'utf8'))
  rec('Add on an open file appends the step and raises the revision', grown.definition.steps.length === 3 && grown.definition.steps[2].kind === 'task' && grown.revision === 2)

  // Collision.
  await tools.locator('[data-wf-new-file]').click()
  await tools.locator('[data-wf-title]').fill('Existing One')
  await tools.locator('[data-wf-save]').click()
  await tools.waitForSelector('[data-wf-error]', { timeout: 5000 })
  rec('a colliding title is refused with the reason', ((await tools.locator('[data-wf-error]').textContent()) ?? '').includes('already exists'))
  rec('the existing file is untouched', readFileSync(join(dir, 'existing-one.md'), 'utf8') === EXISTING)
  rec('a title that is a path stays inside Work files', await (async () => {
    await tools.locator('[data-wf-title]').fill('../../outside')
    await tools.locator('[data-wf-save]').click()
    await tools.waitForTimeout(800)
    return !existsSync(join(root, 'outside.md')) && !existsSync(join(vault, 'outside.md'))
  })())
} finally { await app.close().catch(() => {}) }

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)
