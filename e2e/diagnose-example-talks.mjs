// Onboarding 0.38.1 ticket 09, in the real app: the five example talks.
//   (A) Open example vault, then open each of the five talks in the editor and wait past the autosave
//       delay: no file in the example vault changes by a byte (outlines, the version store, the
//       pathway, the kept delivery). The Talks panel lists each talk's slide count as built.
//   (B) A walk through chapter 01, Write the outline, in The Saturday market, doing what its practice
//       slides say, by the routes they name (keys and All commands). Every row ticks except Protect
//       slide identity, which ticket 08 records as passive (it never reports, so it never ticks).
// Screenshots only when asked for (TW_E2E_SHOTS=<folder>).
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-example-talks.mjs
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { ensureTalksMode, openTalkByTitle } from './lib/talklist.mjs'
import { deriveChapters } from '../src/shared/guide-chapters.ts'
import { guideLearnFrom } from '../src/shared/guide-learn.ts'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = process.env.TW_E2E_SHOTS || ''
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const shot = (page, name) => (SHOTS ? page.screenshot({ path: join(SHOTS, name) }) : Promise.resolve())

const results = []
function record(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const TALKS = [['The Saturday market', 25], ['Garden notes', 14], ['Walking the old town', 30], ['Lightning round', 9], ['Harvest supper (draft)', 10]]
const PASSIVE = 'editor.protect-heading-delete'
const write = deriveChapters().find((c) => c.task === 'Write the outline')

const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tw-e2e-example-talks-')))
const home = join(tempRoot, 'home')
const userData = join(tempRoot, 'userData')
mkdirSync(join(home, 'Documents'), { recursive: true })
mkdirSync(userData, { recursive: true })
const configPath = join(userData, 'config.json')
writeFileSync(configPath, JSON.stringify({}, null, 2))
const exampleRoot = join(home, 'Documents', 'TalkWeaver', 'Example vault')
const learnOnDisk = () => guideLearnFrom(JSON.parse(readFileSync(configPath, 'utf8')).guideLearn)

// Every file under the vault, by content (mtimes are not compared: reading is allowed to touch them).
function contents(dir) {
  const out = {}
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      const r = rel ? `${rel}/${name}` : name
      if (statSync(p).isDirectory()) walk(p, r)
      else out[r] = readFileSync(p).toString('base64')
    }
  }
  walk(dir, '')
  return out
}

const waitFor = async (fn, timeout = 6000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)) }
  return false
}

await ensureFreshBuild(REPO)
let exitCode = 0
const app = await electron.launch({ args: ['.', '--user-data-dir=' + userData], cwd: REPO, env: { ...process.env, TW_E2E: '1', TW_E2E_HOME: home } })
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.setSize(1440, 900) })

  // ── (A) opening changes no byte ──
  await page.locator('[data-example-card]').waitFor({ state: 'visible', timeout: 10000 })
  await page.locator('[data-open-example]').click()
  await page.locator('[data-vault-header][data-vault-example="true"]').waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForFunction(() => document.title.includes('The Saturday market'), null, { timeout: 15000 }).catch(() => {})
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  const before = contents(exampleRoot)
  record('the example vault holds the five talks, the version store, the pathway and the kept delivery',
    ['the-saturday-market/the-saturday-market-outline.md', '_SLIDE-VERSIONS/s4/20260912-090000--garden-notes.md', '_PRESENTATIONS/walking-the-old-town/manifest.json', '_PRESENTATIONS/lightning-round/delivery-2026-09-26.json'].every((f) => f in before),
    `${Object.keys(before).length} files`)
  for (const [title] of TALKS) {
    await ensureTalksMode(page)
    await openTalkByTitle(page, title)
    const shown = await waitFor(async () => (await page.locator('.workspace-title').first().innerText().catch(() => '')) === title, 15000)
    await page.waitForTimeout(2500) // past the 1.5 s autosave delay
    record(`${title} opens in the editor`, shown)
  }
  await page.waitForTimeout(1000)
  const after = contents(exampleRoot)
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => before[f] !== after[f])
  record('opening the five talks changes no byte in the example vault', changed.length === 0, changed.join(', '))
  await ensureTalksMode(page)
  const counts = await page.$$eval('[data-talk-title]', (els) => els.map((e) => [e.getAttribute('data-talk-title'), e.innerText.replace(/\s+/g, ' ').trim()]))
  for (const [title, n] of TALKS) {
    const row = counts.find(([t]) => t === title)
    record(`the Talks panel shows ${title} with ${n} slides`, Boolean(row) && new RegExp(`(^|\\D)${n}(\\D|$)`).test(row[1]), row ? row[1] : 'no row')
  }
  await shot(page, '09-talks-panel.png')

  // ── (B) the walk through chapter 01 ──
  await openTalkByTitle(page, 'The Saturday market')
  await waitFor(async () => (await page.locator('.workspace-title').first().innerText().catch(() => '')) === 'The Saturday market', 15000)
  if (!(await page.locator('[data-guide]').isVisible().catch(() => false))) await page.locator('[data-guide-button]').click()
  await page.waitForSelector('[data-guide]', { timeout: 6000 })
  await page.locator('[data-chapter-row="Write the outline"]').click()
  await page.waitForSelector('[data-chapter-detail="Write the outline"]', { timeout: 4000 })
  const practice = (await page.locator('[data-chapter-practice]').innerText()).replace(/\s+/g, ' ').trim()
  record('the chapter names the open talk and its practice section', practice === 'Practice talk: The Saturday market (open now), section “01 Write the outline”.', practice)

  const line = (text) => page.locator('.cm-content .cm-line', { hasText: text }).first()
  const caretOn = async (text, where = 'End') => { await line(text).click(); await page.keyboard.press(where) }
  const key = async (combo, wait = 350) => { await page.keyboard.press(combo); await page.waitForTimeout(wait) }
  const palette = async (label) => {
    await page.keyboard.press('Meta+Shift+P')
    await page.waitForTimeout(250)
    await page.keyboard.type(label)
    await page.waitForTimeout(300)
    // The palette filters by substring, in registry order: choose the row titled exactly so, as a person would.
    const row = page.locator('[data-command-menu] .command-menu-item').filter({ has: page.locator('.command-menu-title', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first()
    if (await row.count()) await row.click()
    else await page.keyboard.press('Enter')
    await page.waitForTimeout(450)
  }

  // Fresh every week: Format text.
  await line('Bread and honey arrive').dblclick()
  await key('Meta+b')
  for (const name of ['Italic', 'Inline code', 'Highlight', 'Strikethrough', 'Underline']) { await line('Bread and honey arrive').dblclick(); await palette(name) }
  await caretOn('Bread and honey arrive')
  await key('Meta+Shift+l', 700)
  // Rain or shine: Fold, then New slide and its heading up a level and back.
  await caretOn('Rain or shine')
  await palette('Fold all sections')
  await palette('Unfold all sections')
  await caretOn('Rain or shine')
  await palette('New slide')
  await key('Meta+Shift+ArrowLeft')
  await key('Meta+Shift+ArrowRight')
  await key('Meta+z'); await key('Meta+z'); await key('Meta+z')
  // Who runs it: the line becomes a heading (undone each time), then the heading and its subtree.
  await caretOn('A rota of six'); await key('Meta+Alt+ArrowUp'); await key('Meta+z')
  await caretOn('A rota of six'); await key('Meta+Alt+ArrowDown'); await key('Meta+z')
  await caretOn('Who runs it'); await key('Meta+Alt+Shift+ArrowRight'); await key('Meta+Alt+Shift+ArrowLeft')
  // A stall of your own: Enter from the title, the protected delete, then the list commands.
  await caretOn('A stall of your own'); await key('Enter')
  await caretOn('A stall of your own'); await key('Meta+Backspace'); await key('Meta+z')
  await caretOn('Ten pounds a morning'); await palette('Bulleted list')
  await caretOn('Ten pounds a morning'); await palette('Numbered list')
  // What to bring: continue, indent, outdent.
  await caretOn('Small change'); await key('Enter'); await page.keyboard.type('Water'); await key('Tab'); await key('Shift+Tab')
  // Four stalls: move down and back, delete, undo, redo, undo.
  await caretOn('Four stalls'); await key('Meta+Shift+ArrowDown', 600)
  await shot(page, '09-four-stalls-moved.png')
  await key('Meta+Shift+ArrowUp', 600)
  await caretOn('Four stalls'); await key('Meta+Shift+Backspace', 600)
  await key('Meta+z', 500); await key('Meta+Shift+z', 500); await key('Meta+z', 500)
  await page.waitForTimeout(800)

  // The quotation paragraph command and the grid commands added since the original practice walk.
  await caretOn('Try it: move a slide')
  await key('Shift+Enter'); await key('Meta+z')
  await key('Meta+4', 600)
  await page.locator('.grid-cell').filter({ hasText: 'Four stalls' }).first().click()
  await palette('Select section')
  await page.locator('[data-batch-bar]').waitFor()
  await palette('Move selected slides to…')
  await page.locator('[data-batch-menu]').waitFor()
  await page.keyboard.press('Escape')
  await palette('Clear slide selection')
  await page.waitForSelector('[data-batch-bar]', { state: 'detached' })
  await page.locator('.grid-cell').filter({ hasText: 'Four stalls' }).first().click()
  await palette('Set aside in Scratchpad')
  await page.waitForSelector('.sp-card')
  await page.waitForFunction(() => ![...document.querySelectorAll('.grid-cell')].some((node) => node.innerText.includes('Four stalls')))
  await page.locator('.grid-view').focus()
  await key('Meta+z', 600)
  await page.locator('.grid-cell').filter({ hasText: 'Four stalls' }).first().waitFor()
  await key('Meta+2', 500)
  await page.evaluate(() => window.dispatchEvent(new Event('tw-guide-open')))
  await page.locator('[data-chapter-detail="Write the outline"]').waitFor()

  const learn = learnOnDisk()
  const untouched = write.rows.filter((row) => !row.ids.some((id) => learn.ran.includes(id)))
  record(`every row of Write the outline ticks except the passive Protect slide identity (${write.rows.length - untouched.length} of ${write.rows.length})`,
    untouched.length === 1 && untouched[0].ids.includes(PASSIVE), untouched.map((r) => r.label).join(', '))
  const shownCount = (await page.locator('[data-chapter-rows-count]').innerText().catch(() => '')).trim()
  record('the chapter shows the same count', shownCount === `${write.rows.length - untouched.length} of ${write.rows.length}`, shownCount)
  await shot(page, '09-chapter-01-walked.png')
} catch (error) {
  console.error(error)
  exitCode = 1
} finally {
  await app.close().catch(() => {})
  rmSync(tempRoot, { recursive: true, force: true })
}
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(exitCode || (failed.length ? 1 : 0))
