// Onboarding 0.38.1 ticket 08, in the real app: Learn the commands. A profile with a vault of its own and six
// ticks already made (the drawing's state 04: "6 of N tried") opens the example vault and its start talk.
//   - the ten chapters list with their history; Write the outline reads 6 of N tried;
//   - opened as This chapter: the practice line says the talk is open now, and there is no Open this talk;
//   - ⌘⇧↓ in the start talk ticks Move slide or item down: its row flashes, a toast says "Ticked · …", the
//     count rises from 6 to 7 (state 06), and the record is in app config, not in either vault;
//   - Delete current slide does NOT tick in a vault of one's own and DOES in the example (decision 12);
//   - a command run from the palette ticks too (one notifier, every route);
//   - Reuse slides: Open this talk opens Garden notes in its own window and leaves the start talk where it is;
//   - the record survives a restart.
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-guide-chapters.mjs
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { ensureTalksMode, openTalkByTitle } from './lib/talklist.mjs'
import { deriveChapters } from '../src/shared/guide-chapters.ts'
import { chapterHistory, chapterHistoryText, guideLearnFrom } from '../src/shared/guide-learn.ts'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
// Screenshots only when asked for (TW_E2E_SHOTS=<folder>), for the screenshot pass.
const SHOTS = process.env.TW_E2E_SHOTS || ''
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const shot = (page, name) => (SHOTS ? page.screenshot({ path: join(SHOTS, name) }) : Promise.resolve())

const results = []
function record(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const chapters = deriveChapters()
const write = chapters.find((c) => c.task === 'Write the outline')
const N = write.rows.length
const SIX = ['format-bold', 'format-italic', 'format-highlight', 'fold-all', 'new-slide', 'promote-heading']

const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tw-e2e-guide-chapters-')))
const home = join(tempRoot, 'home')
const userData = join(tempRoot, 'userData')
const personal = join(tempRoot, 'Personal')
mkdirSync(join(home, 'Documents'), { recursive: true })
mkdirSync(join(personal, 'alpha-talk'), { recursive: true })
mkdirSync(userData, { recursive: true })
writeFileSync(join(personal, 'alpha-talk', 'alpha-talk-outline.md'), '---\ntitle: Alpha Talk\noutline_version: 2\n---\n\n## Section\n\n### First slide {id=a1}\n\nBody one.\n\n### Second slide {id=a2}\n\nBody two.\n')
const configPath = join(userData, 'config.json')
writeFileSync(configPath, JSON.stringify({ vaultRoot: personal, guideLearn: { version: 1, ran: SIX, opened: [], finished: {}, read: [] } }, null, 2))
const exampleRoot = join(home, 'Documents', 'TalkWeaver', 'Example vault')
const learnOnDisk = () => guideLearnFrom(JSON.parse(readFileSync(configPath, 'utf8')).guideLearn)

async function launch() {
  const app = await electron.launch({ args: ['.', '--user-data-dir=' + userData], cwd: REPO, env: { ...process.env, TW_E2E: '1', TW_E2E_HOME: home } })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.setSize(1440, 900) })
  return { app, page }
}
const waitFor = async (fn, timeout = 8000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)) }
  return false
}
const files = (dir, out = []) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) files(p, out); else out.push(p) } return out }

await ensureFreshBuild(REPO)
let exitCode = 0
try {
  let { app, page } = await launch()
  try {
    await ensureTalksMode(page)
    await openTalkByTitle(page, 'Alpha Talk')
    await page.waitForSelector('.cm-content', { timeout: 8000 })
    await page.locator('[data-guide-button]').click()
    await page.waitForSelector('[data-guide]', { timeout: 4000 })

    // The list, with its history.
    const rows = await page.locator('[data-chapter-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-chapter-row')))
    record('Learn the commands lists the ten chapters in order', rows.join('|') === chapters.map((c) => c.task).join('|'), rows.join(', '))
    const status = async (task) => (await page.locator(`[data-chapter-row="${task}"] [data-chapter-status]`).innerText()).replace(/\s+/g, ' ').trim()
    record(`Write the outline reads "6 of ${N} tried" from the stored record, the others Not opened`, (await status('Write the outline')) === `6 of ${N} tried` && (await status('Share')) === 'Not opened')
    record('no Start here once there is progress', (await page.locator('.guide-pill').count()) === 0)
    await shot(page, '08-chapters-list.png')

    // Decision 12: Delete current slide in a vault of one's own does not tick.
    await page.locator('.cm-content').click()
    await page.keyboard.press('Meta+Shift+Backspace')
    await page.waitForTimeout(900)
    record('Delete current slide in a vault of one’s own ticks nothing (decision 12)', !learnOnDisk().ran.includes('delete-slide'))

    // The example vault, from Add vault… (editing switched the sidebar to the slide outline: back to Talks).
    await ensureTalksMode(page)
    await page.locator('[data-add-vault]').click()
    const sheet = page.locator('[data-vault-sheet="add"]')
    await sheet.waitFor({ state: 'visible', timeout: 8000 })
    await sheet.locator('[data-open-example]').click()
    await page.locator('[data-vault-header][data-vault-example="true"]').waitFor({ state: 'visible', timeout: 15000 })
    const startTalk = await waitFor(async () => (await page.locator('.workspace-title').first().innerText().catch(() => '')) === 'The Saturday market', 15000)
    record('Open example vault opens the start talk, The Saturday market', startTalk)
    await page.waitForSelector('.cm-content', { timeout: 8000 })
    await page.waitForSelector('[data-guide]', { timeout: 6000 })

    // A chapter opens as This chapter.
    await page.locator('[data-chapter-row="Write the outline"]').click()
    await page.waitForSelector('[data-chapter-detail="Write the outline"]', { timeout: 4000 })
    const count = async () => (await page.locator('[data-chapter-count]').innerText()).replace(/\s+/g, ' ').trim()
    record(`the chapter reads "6 of ${N} tried" with This chapter ${6} of ${N}`, (await count()) === `6 of ${N} tried` && (await page.locator('[data-chapter-rows-count]').innerText()).trim() === `6 of ${N}`)
    const practice = (await page.locator('[data-chapter-practice]').innerText()).replace(/\s+/g, ' ').trim()
    record('the practice line names the talk, open now, and its section; there is no Open this talk', practice === 'Practice talk: The Saturday market (open now), section “01 Write the outline”.' && (await page.locator('[data-chapter-open-practice]').count()) === 0, practice)
    // Owner check 10 Oct: "impossible to navigate to top of guide after one chapter selected".
    await page.locator('.guide-body').evaluate((node) => { node.scrollTop = node.scrollHeight })
    const backBox = await page.evaluate(() => { const b = document.querySelector('[data-chapter-back]').getBoundingClientRect(); const body = document.querySelector('.guide-body').getBoundingClientRect(); return { top: b.top, bodyTop: body.top, bodyBottom: body.bottom, scrolled: document.querySelector('.guide-body').scrollTop, overflow: document.querySelector('.guide-body').scrollHeight > document.querySelector('.guide-body').clientHeight, sticky: getComputedStyle(document.querySelector('.guide-cd-top')).position } })
    record('All chapters stays in view at the top of an open chapter, even scrolled to the bottom', backBox.sticky === 'sticky' && (!backBox.overflow || backBox.scrolled > 0) && backBox.top >= backBox.bodyTop - 1 && backBox.top < backBox.bodyBottom, JSON.stringify(backBox))
    await page.locator('.guide-body').evaluate((node) => { node.scrollTop = 0 })
    record('the chapter was recorded as opened', await waitFor(() => learnOnDisk().opened.includes('Write the outline'), 3000))

    // The tick: ⌘⇧↓ in the start talk.
    await page.locator('[data-chapter-subgroup="Reorder slides and items"] button').click()
    const row = page.locator('[data-command-row="editor.move-down"]')
    await row.waitFor({ timeout: 3000 })
    record('before: Move slide or item down is unticked, with its key', (await row.getAttribute('data-ticked')) === 'false' && (await row.locator('kbd').innerText()).includes('⌘⇧↓'))
    await page.locator('.cm-content').click()
    await page.keyboard.press('Meta+Shift+ArrowDown')
    const ticked = await waitFor(async () => (await row.getAttribute('data-ticked')) === 'true', 4000)
    record('⌘⇧↓ ticks its row', ticked)
    record(`the count rises from 6 to 7 of ${N}`, (await count()) === `7 of ${N} tried`, await count())
    record('the ticked row flashes', (await row.getAttribute('class')).includes('guide-vrow--flash'))
    const toast = await page.waitForFunction(() => document.body.innerText.includes('Ticked · Move slide or item down'), null, { timeout: 4000 }).then(() => true).catch(() => false)
    record('a toast reads "Ticked · Move slide or item down ⌘⇧↓"', toast && (await page.evaluate(() => document.body.innerText)).includes('Ticked · Move slide or item down ⌘⇧↓'))
    await shot(page, '08-tick.png')
    const learn = learnOnDisk()
    record('the record is in app config with its version, and in neither vault', learn.ran.includes('editor.move-down') && JSON.parse(readFileSync(configPath, 'utf8')).guideLearn.version === 1
      && !files(exampleRoot).some((f) => readFileSync(f, 'utf8').includes('editor.move-down')) && !files(personal).some((f) => readFileSync(f, 'utf8').includes('editor.move-down')))

    // Decision 12, inside the example.
    await page.keyboard.press('Meta+Shift+Backspace')
    record('Delete current slide inside the example vault ticks', await waitFor(() => learnOnDisk().ran.includes('delete-slide'), 4000))

    // The palette is a route too.
    await page.locator('.cm-content').click()
    await page.keyboard.press('Meta+Shift+P')
    await page.keyboard.type('Underline')
    await page.waitForTimeout(300)
    await page.keyboard.press('Enter')
    record('a command run from the palette ticks (Underline)', await waitFor(() => learnOnDisk().ran.includes('format-underline'), 4000))

    // Open this talk: its own window; the person's talk stays.
    await page.locator('[data-chapter-back]').click()
    await page.locator('[data-chapter-row="Reuse slides"]').click()
    await page.waitForSelector('[data-chapter-detail="Reuse slides"]', { timeout: 4000 })
    const away = (await page.locator('[data-chapter-practice]').innerText()).replace(/\s+/g, ' ').trim()
    record('Reuse slides names Garden notes, not open, and offers Open this talk', away === 'Practice talk: Garden notes, section “03 Reuse slides”.' && (await page.locator('[data-chapter-open-practice]').count()) === 1, away)
    const newWindow = app.waitForEvent('window', { timeout: 15000 })
    await page.locator('[data-chapter-open-practice]').click()
    const second = await newWindow.catch(() => null)
    record('Open this talk opens a new window, not this one', second !== null && second !== page)
    if (second) {
      await second.waitForLoadState('domcontentloaded')
      const title = await waitFor(async () => (await second.locator('.workspace-title').first().innerText().catch(() => '')) === 'Garden notes', 15000)
      record('the new window holds Garden notes', title)
      record('the start talk stays in the first window', (await page.locator('.workspace-title').first().innerText()) === 'The Saturday market')
    }
    await shot(page, '08-open-this-talk.png')
  } finally {
    await app.close()
  }

  // The record survives a restart.
  ;({ app, page } = await launch())
  try {
    await page.waitForSelector('[data-guide-button]', { timeout: 10000 })
    await page.locator('[data-guide-button]').click()
    await page.waitForSelector('[data-chapter-row]', { timeout: 6000 })
    const saved = learnOnDisk()
    const expected = chapterHistoryText(chapterHistory(saved, write))
    const shown = (await page.locator('[data-chapter-row="Write the outline"] [data-chapter-status]').innerText()).replace(/\s+/g, ' ').trim()
    record('after a restart the chapter list shows the same history', shown === expected && saved.ran.includes('editor.move-down'), `${shown} / ${expected}`)
    const reuse = (await page.locator('[data-chapter-row="Reuse slides"] [data-chapter-status]').innerText()).trim()
    record('and the chapter that was opened reads Opened', reuse === 'Opened', reuse)
  } finally {
    await app.close()
  }
} catch (error) {
  console.error(error)
  exitCode = 1
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(exitCode || (failed.length ? 1 : 0))
