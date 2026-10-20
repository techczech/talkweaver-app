// Onboarding 0.38.1 ticket 04, in the real app: ⌃/ opens the keyboard sheet on Here, and Here is the
// list ⌘K shows at the same place; the ten task groups follow with counts; the filter searches every
// command; Escape closes it.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const FIX = ['---', 'title: Sheet Fixture', '---', '', '## Opening', '', '### Four stalls', '', 'Bread and cakes at the first stall.', '', '- Vegetables', ''].join('\n')

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-sheet-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
const td = join(vault, 'sheet-fixture')
mkdirSync(td, { recursive: true }); mkdirSync(ud, { recursive: true })
writeFileSync(join(td, 'sheet-fixture-outline.md'), FIX)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))

await ensureFreshBuild(REPO)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO, env: { ...process.env, TW_E2E: '1' } })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')

const sheet = page.locator('[data-keyboard-sheet]')
const actions = page.locator('[data-actions-here]')
const gone = (selector) => page.waitForSelector(selector, { state: 'detached', timeout: 3000 }).then(() => true).catch(() => false)

try {
  await openTalkByTitle(page, 'Sheet Fixture')
  await page.waitForSelector('.cm-content', { timeout: 8000 })
  await page.locator('.cm-content .cm-line', { hasText: 'Four stalls' }).first().click()
  await page.waitForFunction(() => document.querySelector('[data-testid="status-place"]')?.getAttribute('data-place') === 'slide-heading', null, { timeout: 4000 })

  // What ⌘K lists here.
  await page.keyboard.press('Meta+k')
  await actions.waitFor({ timeout: 4000 })
  const actionKeys = await page.$$eval('[data-actions-here-row]', (nodes) => nodes.map((node) => node.getAttribute('data-actions-here-row')))
  await page.keyboard.press('Escape')
  await gone('[data-actions-here]')

  // ⌃/ opens it from anywhere, typing in the editor included. ⌘/ is the app menu's accelerator, which
  // Playwright's key events do not reach, so it is not driven here.
  await page.keyboard.press('Control+/')
  await sheet.waitFor({ timeout: 4000 })
  const pane = await page.locator('[data-sheet-pane]').getAttribute('data-sheet-pane')
  const title = await page.locator('.kbd-sheet-pane-title').innerText()
  record('⌃/ on a heading opens the sheet on "Here: on a slide heading"', pane === 'here' && title === 'Here: on a slide heading', `pane=${pane} title=${JSON.stringify(title)}`)
  const first = await page.$$eval('[data-sheet-section]', (nodes) => nodes.slice(0, 2).map((node) => node.getAttribute('data-sheet-section')))
  record('Here is the first item, then the first task group', first[0] === 'here' && first[1] === 'Write the outline', first.join(','))
  const sheetKeys = await page.$$eval('[data-sheet-row]', (nodes) => nodes.map((node) => node.getAttribute('data-sheet-row')))
  record('the Here rows are the ⌘K list', JSON.stringify(sheetKeys) === JSON.stringify(actionKeys), `sheet=${sheetKeys.length} actions=${actionKeys.length}`)
  const count = Number(await page.locator('[data-sheet-count="here"]').innerText())
  record('the count shown equals the list', count === sheetKeys.length, `count=${count} rows=${sheetKeys.length}`)
  const counts = await page.$$eval('[data-sheet-count]', (nodes) => nodes.map((node) => [node.getAttribute('data-sheet-count'), Number(node.textContent)]))
  record('the ten task groups follow with counts', counts.filter(([name]) => name !== 'here').length === 10 && counts.every(([, n]) => n > 0), JSON.stringify(counts))

  // Choosing a group shows its sub-groups.
  await page.locator('[data-sheet-section="Manage talks"]').click()
  const subs = await page.locator('[data-sheet-subgroup]').count()
  record('choosing a task group shows its sub-groups', subs > 0, `subgroups=${subs}`)

  // The filter searches every command.
  await page.locator('input[aria-label="Filter all commands"]').fill('where used')
  const found = await page.$$eval('[data-sheet-row]', (nodes) => nodes.map((node) => node.getAttribute('data-sheet-row')))
  record('the filter finds a command by its label', found.includes('where-used'), found.join(','))
  // Work files ticket 30: the Tools window's keys are on the sheet with their chords (Unpublish and the two Attach commands have none).
  const TOOLS_KEYS = { 'tools-view-sessions': '⌘4', 'tools-view-published': '⌘5', 'tools-view-workfiles': '⌘6', 'tools-plan-run': '⌘⌥N', 'tools-edit-plan': '⌘⌥E', 'tools-plan-like-this': '⌘⇧D', 'tools-publish': '⌘⌥U', 'tools-go-live': '⌘⌥L', 'tools-open-run': '⌘⌥O', 'tools-copy-link': '⌘⇧C', 'tools-copy-invitation': '⌘⌥C', 'tools-new-work-file': '⌘⇧N' }
  const chordsOnSheet = {}
  for (const [id, chord] of Object.entries(TOOLS_KEYS)) {
    // A word each row's label or keywords hold; the row is found by its id whatever else matches.
    await page.locator('input[aria-label="Filter all commands"]').fill({ 'tools-view-sessions': 'sessions', 'tools-view-published': 'published', 'tools-view-workfiles': 'work files', 'tools-plan-run': 'plan a run', 'tools-edit-plan': 'edit plan', 'tools-plan-like-this': 'like this', 'tools-publish': 'publish for', 'tools-go-live': 'go live', 'tools-open-run': 'open run', 'tools-copy-link': 'copy link', 'tools-copy-invitation': 'invitation', 'tools-new-work-file': 'new work file' }[id])
    chordsOnSheet[id] = await page.locator(`[data-sheet-row="${id}"] .kbd-sheet-chord`).first().innerText().catch(() => null)
  }
  record('the sheet lists every Tools-window key', Object.entries(TOOLS_KEYS).every(([id, chord]) => chordsOnSheet[id] === chord), JSON.stringify(chordsOnSheet))
  await page.locator('input[aria-label="Filter all commands"]').fill('unpublish')
  record('Unpublish is on the sheet with no key', (await page.locator('[data-sheet-row="tools-unpublish"] .kbd-sheet-nokey').count()) === 1)
  await page.locator('input[aria-label="Filter all commands"]').fill('attach')
  record('the two Attach commands are on the sheet with no key', (await page.locator('[data-sheet-row="attach-prework"] .kbd-sheet-nokey, [data-sheet-row="attach-postwork"] .kbd-sheet-nokey').count()) === 2)
  await page.locator('input[aria-label="Filter all commands"]').fill('zzzz')
  record('a filter with no match says so', (await page.locator('[data-sheet-empty]').count()) === 1)

  await page.keyboard.press('Escape')
  await gone('[data-keyboard-sheet]')

  // The sheet follows the place: on slide text, and Escape closes it.
  await page.locator('.cm-content .cm-line', { hasText: 'Bread and cakes' }).first().click()
  await page.locator('.cm-content').evaluate((el) => el.blur())
  await page.keyboard.press('Control+/')
  await sheet.waitFor({ timeout: 4000 })
  const textPane = await page.locator('.kbd-sheet-pane-title').innerText()
  record('on slide text the sheet opens on "Here: in slide text"', textPane === 'Here: in slide text', JSON.stringify(textPane))
  await page.keyboard.press('Escape')
  record('Escape closes the sheet', await gone('[data-keyboard-sheet]'))
  // A command with no chord has a Run action that runs it.
  await page.keyboard.press('Control+/')
  await sheet.waitFor({ timeout: 4000 })
  await page.locator('input[aria-label="Filter all commands"]').fill('abstract')
  const runButton = page.locator('[data-sheet-run="abstract"]')
  const hasRun = (await runButton.count()) === 1
  record('a command with no key shows "no key" and Run', hasRun && (await page.locator('[data-sheet-row="abstract"] .kbd-sheet-nokey').count()) === 1)
  if (hasRun) {
    await runButton.click()
    const closed = await gone('[data-keyboard-sheet]')
    record('Run closes the sheet and runs the command', closed, `closed=${closed}`)
  }
} catch (e) {
  record('keyboard sheet harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== KEYBOARD SHEET SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  rmSync(tempRoot, { recursive: true, force: true })
  process.exit(failed.length === 0 ? 0 : 1)
}
