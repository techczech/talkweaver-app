// Onboarding 0.38.1 ticket 02, in the real app: the status-bar place chip changes when the caret
// moves from a slide heading to slide text, and a click on it does what ⌘K does there.
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

const FIX = ['---', 'title: Place Fixture', '---', '', '## Opening', '', '### Four stalls', '', 'Bread and cakes at the first stall.', '', '- Vegetables', '- Plants', ''].join('\n')

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-place-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
const td = join(vault, 'place-fixture')
mkdirSync(td, { recursive: true }); mkdirSync(ud, { recursive: true })
writeFileSync(join(td, 'place-fixture-outline.md'), FIX)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))

await ensureFreshBuild(REPO)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO, env: { ...process.env, TW_E2E: '1' } })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')

const chip = page.locator('[data-testid="status-place"]')
async function chipReads(place, timeout = 4000) {
  try {
    await page.waitForFunction((want) => document.querySelector('[data-testid="status-place"]')?.getAttribute('data-place') === want, place, { timeout })
    return true
  } catch { return false }
}

try {
  await openTalkByTitle(page, 'Place Fixture')
  await page.waitForSelector('.cm-content', { timeout: 8000 })

  await page.locator('.cm-content .cm-line', { hasText: 'Four stalls' }).first().click()
  const onHeading = await chipReads('slide-heading')
  const headingText = onHeading ? (await chip.innerText()).replace(/\s+/g, ' ').trim() : ''
  // The count is the list Actions here shows (ticket 03 carries the old context menu's rows too).
  record('caret on a slide heading: the chip reads "On a slide heading · N actions ⌘K"', onHeading && /^On a slide heading · \d+ actions ⌘K$/.test(headingText), `text=${JSON.stringify(headingText)}`)

  await page.locator('.cm-content .cm-line', { hasText: 'Bread and cakes at the first stall.' }).first().click()
  const inText = await chipReads('slide-text')
  const textText = inText ? (await chip.innerText()).replace(/\s+/g, ' ').trim() : ''
  record('caret moves to body text: the chip changes to "In slide text"', inText && textText.startsWith('In slide text · '), `text=${JSON.stringify(textText)}`)

  await page.locator('.cm-content .cm-line', { hasText: 'Vegetables' }).first().click()
  record('caret in a list: the chip reads "In a list"', await chipReads('list'))

  // A click on the chip does what ⌘K does: from the editor, Actions here at the caret.
  await page.locator('.cm-content .cm-line', { hasText: 'Four stalls' }).first().click()
  await chipReads('slide-heading')
  await chip.click()
  let menuOpened = false
  try { await page.waitForSelector('[data-actions-here]', { timeout: 3000 }); menuOpened = true } catch { /* not opened */ }
  // The panel takes the keyboard for its filter; Escape gives it back to the caret.
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-actions-here]', { state: 'detached', timeout: 3000 }).catch(() => {})
  const focusKept = await page.evaluate(() => Boolean(document.activeElement?.closest('.cm-content')))
  record('clicking the chip opens what ⌘K opens (Actions here); Escape returns the caret', menuOpened && focusKept, `menu=${menuOpened} focusInEditor=${focusKept}`)
} catch (e) {
  record('place chip harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== PLACE CHIP SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  rmSync(tempRoot, { recursive: true, force: true })
  process.exit(failed.length === 0 ? 0 : 1)
}
