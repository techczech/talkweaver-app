// Real-Electron check of ADR-0044 §6 rule D (the editor's close, for every close), run from source with a throwaway
// vault and user-data folder. Every save waits 2.5 s (the test-only save delay, which a release never has:
// src/main/update-test-hooks.ts), so the close's own save is slow enough to type during it:
//   (T) the window's own close: FIRST_EDIT typed, then the close; while its save runs the editor says "Saving before
//       closing…" and refuses SECOND_EDIT (typing, a paste, ⌘Z); the window closes with FIRST_EDIT on disk and the
//       editor never held SECOND_EDIT. This is review round two's finding 1 (it lost SECOND_EDIT).
//   (S) "Stay here" on the changed-on-disk sheet unfreezes the editor: typing works again, nothing was lost.
//   (Q) a quit with typing waiting: the same freeze, and the text is on disk after the app has quit.
// Editor assertions read CodeMirror's own document; file assertions read the real file.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-close-freeze.mjs
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const results = []
function record(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const outline = (title, id) => ['---', `title: ${title}`, 'outline_version: 2', '---', '', `## Opening {id=${id}0sec}`, '', `### First slide {id=${id}1}`, '', 'First slide body text.', ''].join('\n')
const TITLE = 'Freeze Talk'

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-close-freeze-'))
const vault = join(tempRoot, 'vault')
const userDataDir = join(tempRoot, 'userData')
const DELAY_FILE = join(tempRoot, 'save-delay-ms')
mkdirSync(join(vault, 'freeze-talk'), { recursive: true })
mkdirSync(userDataDir, { recursive: true })
const OUTLINE_PATH = join(vault, 'freeze-talk', 'freeze-talk-outline.md')
writeFileSync(OUTLINE_PATH, outline(TITLE, 'frz'))
writeFileSync(join(userDataDir, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))
const disk = () => readFileSync(OUTLINE_PATH, 'utf8')
const slowSaves = (ms) => { if (ms) writeFileSync(DELAY_FILE, String(ms)); else rmSync(DELAY_FILE, { force: true }) }

await ensureFreshBuild(REPO)
let app
let page
async function launch() {
  app = await electron.launch({ args: ['.', '--user-data-dir=' + userDataDir], cwd: REPO, env: { ...process.env, TW_E2E: '1', TW_UPDATE_TEST_SAVE_DELAY_FILE: DELAY_FILE } })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1200)
}
async function closeApp() {
  if (!app) return
  const proc = app.process()
  await Promise.race([app.close().catch(() => undefined), sleep(8000)])
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
  await page.locator('.cm-content .cm-line', { hasText: 'First slide body text.' }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(text)
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

  // (S) "Stay here" unfreezes.
  await launch()
  await openTalk()
  writeFileSync(OUTLINE_PATH, disk() + '\n### Outside {id=frz7}\n\nChanged outside.\n')
  await waitFor(async () => (await page.locator('[data-testid="outline-disk-change-bar"], [data-testid="outline-disk-change-chip"]').count()) > 0, 4000)
  await typeAtEndOfBody(' STAY_TYPED')
  const win2 = await app.browserWindow(page)
  await win2.evaluate((w) => w.close())
  const sheet = await waitFor(async () => (await page.locator('[data-testid="outline-disk-change-sheet"]').count()) > 0, 4000)
  const frozenUnderSheet = (await freezeText()) === 'Saving before closing…'
  if (sheet !== null) await page.locator('[data-testid="outline-disk-change-sheet"]').getByRole('button', { name: 'Stay here' }).click()
  const thawed = await waitFor(async () => (await page.locator('[data-close-freeze]').count()) === 0, 3000)
  await typeAtEndOfBody(' AFTER_STAY')
  const afterStay = await editorText()
  record('(S) "Stay here" on the close\'s sheet: the editor was frozen under the sheet, and is unfrozen after it; typing works; nothing was lost',
    sheet !== null && frozenUnderSheet && thawed !== null && !!afterStay?.includes('STAY_TYPED') && !!afterStay?.includes('AFTER_STAY'),
    `sheet=${sheet}ms, frozen under it=${frozenUnderSheet}, unfrozen=${thawed}ms, editor has STAY_TYPED=${afterStay?.includes('STAY_TYPED')} AFTER_STAY=${afterStay?.includes('AFTER_STAY')}`)
  // Keep mine, so the next case starts from the person's text.
  await win2.evaluate((w) => w.close())
  await waitFor(async () => (await page.locator('[data-testid="outline-disk-change-sheet"]').count()) > 0, 4000)
  await page.locator('[data-testid="outline-disk-change-sheet"]').getByRole('button', { name: 'Keep mine' }).click().catch(() => {})
  await sleep(1500)
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
  rmSync(tempRoot, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
