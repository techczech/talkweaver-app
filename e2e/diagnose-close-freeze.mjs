// Real-Electron check of ADR-0044 §6 rule D (the editor's close, for every close), run from source with a throwaway
// vault and user-data folder. Every save waits 2.5 s (the test-only save delay, which a release never has:
// src/main/update-test-hooks.ts), so the close's own save is slow enough to type during it:
//   (T) the window's own close: FIRST_EDIT typed, then the close; while its save runs the editor says "Saving before
//       closing…" and refuses SECOND_EDIT (typing, a paste, ⌘Z); the window closes with FIRST_EDIT on disk and the
//       editor never held SECOND_EDIT. This is review round two's finding 1 (it lost SECOND_EDIT).
//   (S) A conflicting close opens merge review. “Decide later” returns to the editor and a later merge saves both edits.
//   (Q) a quit with typing waiting: the same freeze, and the text is on disk after the app has quit.
// Editor assertions read CodeMirror's own document; file assertions read the real file.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-close-freeze.mjs
import { createAppScratch, launchApp } from './lib/launch-app.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { typeAtOutlineLineEnd } from './lib/outline-typing.mjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const results = []
function record(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const outline = (title, id) => ['---', `title: ${title}`, 'outline_version: 2', '---', '', `## Opening {id=${id}0sec}`, '', `### First slide {id=${id}1}`, '', 'First slide body text.', ''].join('\n')
const TITLE = 'Freeze Talk'

await using appScratch = createAppScratch()
const tempRoot = appScratch.root
const vault = join(tempRoot, 'vault')
const userDataDir = join(tempRoot, 'userData')
const DELAY_FILE = join(tempRoot, 'save-delay-ms')
mkdirSync(join(vault, 'freeze-talk'), { recursive: true })
mkdirSync(userDataDir, { recursive: true })
const OUTLINE_PATH = join(vault, 'freeze-talk', 'freeze-talk-outline.md')
writeFileSync(OUTLINE_PATH, outline(TITLE, 'frz'))
writeFileSync(join(userDataDir, 'config.json'), JSON.stringify({ vaultRoot: vault, openInView: 'outline' }, null, 2))
const disk = () => readFileSync(OUTLINE_PATH, 'utf8')
const slowSaves = (ms) => { if (ms) writeFileSync(DELAY_FILE, String(ms)); else rmSync(DELAY_FILE, { force: true }) }

let app
let page
async function launch() {
  app = (await launchApp({ scratch: appScratch, userData: userDataDir, env: { ...process.env, TW_UPDATE_TEST_SAVE_DELAY_FILE: DELAY_FILE } })).app
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1200)
}
async function closeApp() {
  if (!app) return
  const proc = app.process()
  await Promise.race([appScratch.closeApp(app).catch(() => undefined), sleep(8000)])
  try { proc.kill('SIGKILL') } catch { /* gone */ }
  app = null
}
const editorText = () => page.evaluate(() => {
  const el = document.querySelector('.cm-content')
  const view = el && el.cmTile && el.cmTile.root && el.cmTile.root.view
  return view ? view.state.doc.toString() : null
})
async function waitFor(fn, ms, step = 50) {
  const start = Date.now()
  while (Date.now() - start < ms) { if (await fn()) return Date.now() - start; await sleep(step) }
  return null
}
async function openTalk() {
  await openTalkByTitle(page, TITLE)
  await waitFor(async () => (await editorText())?.includes('First slide body text.'), 6000)
}
async function typeAtEndOfBody(text) {
  await typeAtOutlineLineEnd(page, 'First slide body text.', text)
}
const freezeText = () => page.locator('[data-close-freeze]').first().innerText().catch(() => '')
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

try {
  // (T) The window's own close, with SECOND_EDIT typed during its save.
  await launch()
  await openTalk()
  slowSaves(2500)
  await typeAtEndOfBody(' FIRST_EDIT')
  const editorWindow = await app.browserWindow(page)
  let pageClosed = false
  page.once('close', () => { pageClosed = true })
  await editorWindow.evaluate((w) => w.close())
  const frozenAfter = await waitFor(async () => (await freezeText()) === 'Saving before closing…', 2000)
  // SECOND_EDIT three ways while the close's save runs: typed, pasted, and an undo.
  await page.keyboard.type(' SECOND_EDIT').catch(() => {})
  await page.evaluate(() => navigator.clipboard?.writeText?.(' PASTED_EDIT').catch(() => {})).catch(() => {})
  await page.keyboard.press(`${MOD}+V`).catch(() => {})
  await page.keyboard.press(`${MOD}+Z`).catch(() => {})
  const heldWhileSaving = pageClosed ? null : await editorText()
  const closedAfter = await waitFor(async () => pageClosed, 9000)
  const onDisk = disk()
  record('(T) the window\'s own close: frozen at once ("Saving before closing…"); typing, paste and undo during its save are refused; it closes with FIRST_EDIT on disk and nothing it held missing',
    frozenAfter !== null && heldWhileSaving !== null && heldWhileSaving.includes('FIRST_EDIT') && !/SECOND_EDIT|PASTED_EDIT/.test(heldWhileSaving) && closedAfter !== null && onDisk.includes('FIRST_EDIT') && !/SECOND_EDIT|PASTED_EDIT/.test(onDisk),
    `frozen=${frozenAfter}ms, editor while saving holds FIRST=${heldWhileSaving?.includes('FIRST_EDIT')} SECOND=${heldWhileSaving?.includes('SECOND_EDIT')} PASTED=${heldWhileSaving?.includes('PASTED_EDIT')}, closed=${closedAfter}ms, disk FIRST=${onDisk.includes('FIRST_EDIT')} SECOND=${onDisk.includes('SECOND_EDIT')}`)
  slowSaves(0)
  await closeApp()

  // (S) Close with a same-slide conflict. Dismiss the review, type again, then save that version.
  await launch()
  await openTalk()
  const beforeStay = disk()
  await typeAtEndOfBody(' STAY_TYPED')
  const outside = beforeStay.replace('First slide body text.', 'First slide body text. OUTSIDE_STAY')
  writeFileSync(OUTLINE_PATH, outside)
  const review = page.getByTestId('outline-merge-sheet')
  const decideLater = review.getByRole('button', { name: 'Decide later', exact: true })
  const keepSlide = review.getByRole('group', { name: 'Version for First slide', exact: true })
    .getByRole('button', { name: "Keep this window's version", exact: true })
  await decideLater.click()
  await review.waitFor({ state: 'hidden' })
  const win2 = await app.browserWindow(page)
  await win2.evaluate((w) => w.close())
  await keepSlide.waitFor()
  const typedBeforeDismiss = await editorText()
  const openWithTyping = !page.isClosed() &&
    typedBeforeDismiss?.includes('STAY_TYPED') &&
    (await review.locator('.merge-cards-diff pre del').allTextContents()).join('').includes('STAY_TYPED') &&
    (await review.locator('.merge-cards-diff pre ins').allTextContents()).join('').includes('OUTSIDE_STAY') &&
    disk() === outside
  await decideLater.click()
  await review.waitFor({ state: 'hidden' })
  const thawed = await waitFor(async () => (await page.locator('[data-close-freeze]').count()) === 0, 3000)
  const preserved = await editorText() === typedBeforeDismiss && disk() === outside
  await typeAtEndOfBody(' AFTER_STAY')
  const afterStay = await editorText()
  await page.getByTestId('outline-disk-change-bar').getByRole('button', { name: 'Review merge', exact: true }).click()
  await keepSlide.click()
  await review.getByRole('button', { name: 'Apply to the file', exact: true }).click()
  const saved = await waitFor(async () => /STAY_TYPED/.test(disk()) && /AFTER_STAY/.test(disk()), 5000)
  record('(S) close opens merge review, Decide later restores editing, and applying the merge saves both typed edits',
    openWithTyping && thawed !== null && preserved && afterStay?.includes('STAY_TYPED') && afterStay?.includes('AFTER_STAY') && saved !== null,
    `review showed both versions=${openWithTyping}, unfrozen=${thawed}ms, both versions preserved after dismissal=${preserved}, saved after merge=${saved !== null}`)
  await closeApp()

  // (Q) A quit with typing waiting for its autosave.
  await launch()
  await openTalk()
  slowSaves(1500)
  await typeAtEndOfBody(' QUIT_EDIT')
  const proc = app.process()
  const exited = new Promise((resolve) => proc.once('exit', () => resolve(true)))
  await app.evaluate(({ app: a }) => { a.quit() })
  const frozenAtQuit = await waitFor(async () => (await freezeText().catch(() => '')) === 'Saving before closing…', 1500)
  const quitDone = await Promise.race([exited, sleep(10000).then(() => false)])
  app = null
  record('(Q) a quit: frozen while it saves; the app quits with the typing on disk',
    frozenAtQuit !== null && quitDone === true && disk().includes('QUIT_EDIT'),
    `frozen=${frozenAtQuit}ms, quit=${quitDone}, on disk=${disk().includes('QUIT_EDIT')}`)
  slowSaves(0)
} catch (error) {
  record('the run finished', false, String(error?.stack ?? error).slice(0, 1500))
} finally {
  await closeApp().catch(() => {})
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exitCode = failed.length ? 1 : 0
