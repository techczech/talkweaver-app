// Real-Electron check of the outline external-change guard (shared-talk ticket 01).
// Open a talk, change its outline file from outside the app (as another TalkWeaver on a shared cloud-synced
// folder would), and check:
//   (O) the app's own saves never raise the bar;
//   (B) an outside change raises the quiet bar within 2 s (the watcher), with no dialog;
//   (S) a save after the change is refused (the file stays the outside version; the typing stays);
//   (R) Reload puts the disk text into the editor, and one undo brings the pre-reload text back;
//   (K) Keep mine writes the editor's text over a newer outside version, and the bar goes away;
//   (G) the bar shows in Grid view too, and a rename-replace change (temp file renamed over) raises it;
//   (W) switching talks with the bar up opens the sheet: Stay here keeps the talk, Keep mine completes
//       and then the switch goes ahead;
//   (C) closing the window with the bar up opens the same sheet; Keep mine completes, then it closes;
//   (X) a refused save leaves a recovery copy; after a forced kill, reopening the talk offers
//       "Restore my unsaved text", which puts the text back and saves it (the copy is deleted);
//   (N) renaming the open talk from the talk list with the bar up opens the sheet first: Stay here
//       cancels the rename; Keep mine completes, then the rename goes ahead with the text in the file;
//   (F) renaming the FOLDER that holds the open talk re-selects the talk at its new path: typing then
//       saves there (the old folder is not recreated), and the talk is guarded there (an outside change
//       raises the bar) — shared-talk ticket 08;
//   (D) deleting the folder that holds the open talk shows the removed-file bar; typing is refused (the
//       folder is not recreated) and kept in a recovery copy — ticket 08.
// All file assertions read the real files; editor assertions read CodeMirror's own document.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-outline-disk-guard.mjs
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle, waitForTalkList } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const outline = (title, id) => [
  '---', `title: ${title}`, 'outline_version: 2', '---', '',
  `## Opening {id=${id}0sec}`, '',
  `### First slide {id=${id}1}`, '', 'First slide body text.', '',
  `### Second slide {id=${id}2}`, '', 'Second slide body text.', '',
].join('\n')
const TITLE = 'Guard Talk'
const OTHER = 'Other Talk'
const FOLDER_TITLE = 'Folder Talk'

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-disk-guard-'))
const vault = join(tempRoot, 'vault')
const userDataDir = join(tempRoot, 'userData')
const recoveryDir = join(userDataDir, 'recovery')
mkdirSync(join(vault, 'guard-talk'), { recursive: true })
mkdirSync(join(vault, 'other-talk'), { recursive: true })
mkdirSync(join(vault, 'topic-a', 'folder-talk'), { recursive: true })
writeFileSync(join(vault, 'topic-a', 'folder-talk', 'folder-talk-outline.md'), outline(FOLDER_TITLE, 'fld'))
mkdirSync(userDataDir, { recursive: true })
const OUTLINE_PATH = join(vault, 'guard-talk', 'guard-talk-outline.md')
const OTHER_PATH = join(vault, 'other-talk', 'other-talk-outline.md')
writeFileSync(OUTLINE_PATH, outline(TITLE, 'grd'))
writeFileSync(OTHER_PATH, outline(OTHER, 'oth'))
writeFileSync(join(userDataDir, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))

const disk = () => readFileSync(OUTLINE_PATH, 'utf8')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BAR = '[data-testid="outline-disk-change-bar"]'
const SHEET = '[data-testid="outline-disk-change-sheet"]'
const recoveryCopies = () => { try { return readdirSync(recoveryDir).filter((f) => f.endsWith('-outline.md')) } catch { return [] } }

await ensureFreshBuild(REPO)
let app
let page
async function launch() {
  app = await electron.launch({ args: ['.', '--user-data-dir=' + userDataDir], cwd: REPO, env: { ...process.env, TW_E2E: '1' } })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1200)
}

// Quits the app; a close still held (a failing run) is forced.
async function closeApp() {
  if (!app) return
  const proc = app.process()
  await Promise.race([app.close().catch(() => undefined), sleep(8000)])
  try { proc.kill('SIGKILL') } catch { /* already gone */ }
  app = null
}
async function editorText() {
  return page.evaluate(() => {
    const el = document.querySelector('.cm-content')
    const tile = el && el.cmTile
    const view = tile && tile.root && tile.root.view
    return view ? view.state.doc.toString() : null
  })
}
async function typeAtEndOf(lineText, text) {
  await page.locator('.cm-content .cm-line', { hasText: lineText }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(text)
}
const visible = async (selector) => (await page.locator(selector).count()) > 0 && page.locator(selector).first().isVisible()
const barVisible = () => visible(BAR)
const barText = async () => ((await page.locator(BAR).first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
const activeTitle = async () => ((await page.locator('.workspace-title').first().textContent().catch(() => '')) || '').trim()
async function waitFor(fn, ms, step = 50) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await fn()) return Date.now() - start
    await sleep(step)
  }
  return null
}
async function openTalk(title) {
  await openTalkByTitle(page, title)
  await waitFor(async () => (await activeTitle()) === title && (await editorText())?.includes('First slide body text.'), 6000)
}
// Clicks a talk row without waiting for the switch (the sheet may hold it).
async function clickTalkRow(title) {
  await waitForTalkList(page)
  await page.locator(`aside.talk-list.tl-panel .tl-tree [data-talk-title="${title}"]`).first().click()
}
// An outside change the watcher sees, then a refused autosave of new typing.
async function outsideChangeThenType(outsideText, mark) {
  writeFileSync(OUTLINE_PATH, outsideText)
  const bar = await waitFor(barVisible, 2000)
  await typeAtEndOf('Second slide body text.', mark)
  await sleep(2600) // past the 1.5 s autosave: refused
  return bar
}

try {
  await launch()
  await openTalk(TITLE)

  // (O) Own saves never raise the bar.
  await typeAtEndOf('First slide body text.', ' OWNMARK')
  const ownSaved = await waitFor(async () => disk().includes('OWNMARK'), 5000)
  await sleep(2200)
  record('own save lands and never raises the bar', ownSaved !== null && !(await barVisible()), `saved after ${ownSaved}ms, bar=${await barVisible()}`)

  // (B) An outside change raises the bar within 2 s.
  const theirs = disk() + '\n### Their slide {id=grd3}\n\nWritten by the other TalkWeaver.\n'
  writeFileSync(OUTLINE_PATH, theirs)
  const barAfter = await waitFor(barVisible, 2000)
  const text1 = await barText()
  if (process.env.TW_E2E_SHOT && barAfter !== null) await page.screenshot({ path: process.env.TW_E2E_SHOT })
  record('outside change shows the bar within 2 s', barAfter !== null && /This talk changed on disk at \d\d:\d\d/.test(text1) && /Reload/.test(text1) && /Keep mine/.test(text1) && !(await visible(SHEET)),
    `after ${barAfter}ms: "${text1}"`)

  // (S) Saving after the change is refused.
  await typeAtEndOf('Second slide body text.', ' MINEMARK')
  await sleep(2600)
  const afterRefusal = await editorText()
  record('save after an outside change is refused until the person chooses', disk() === theirs && afterRefusal?.includes('MINEMARK') && await barVisible(),
    `disk unchanged=${disk() === theirs}, typing kept=${afterRefusal?.includes('MINEMARK')}, bar=${await barVisible()}`)
  record('a refused save keeps the editor text in a recovery copy', recoveryCopies().length === 1 && readFileSync(join(recoveryDir, recoveryCopies()[0]), 'utf8').includes('MINEMARK'),
    `copies=${JSON.stringify(recoveryCopies())}`)

  // (R) Reload shows the disk text; one undo brings the pre-reload text back.
  await page.locator(BAR).getByRole('button', { name: 'Reload' }).click()
  const reloaded = await waitFor(async () => (await editorText()) === theirs, 3000)
  const barGone = await waitFor(async () => !(await barVisible()), 2000)
  record('Reload replaces the editor text with the version on disk', reloaded !== null && barGone !== null, `reloaded=${reloaded !== null}, bar gone=${barGone !== null}`)
  await page.locator('.cm-content').first().click()
  await page.keyboard.press('Meta+z')
  const undone = await waitFor(async () => {
    const text = await editorText()
    return !!text && text.includes('MINEMARK') && !text.includes('Their slide')
  }, 3000)
  record('an undo step restores the pre-reload text', undone !== null, `undone=${undone !== null}`)
  await page.keyboard.press('Meta+Shift+z')
  const redone = await waitFor(async () => (await editorText()) === theirs, 3000)
  await sleep(2600)
  const afterRedo = await editorText()
  record('after Reload the next save lands and raises no bar',
    redone !== null && disk() === afterRedo && disk().includes('Written by the other TalkWeaver.') && !disk().includes('MINEMARK') && !(await barVisible()) && recoveryCopies().length === 0,
    `redone=${redone !== null}, disk=editor ${disk() === afterRedo}, bar=${await barVisible()}, copies=${recoveryCopies().length}`)

  // (K) Keep mine writes the editor's text over a newer outside version.
  writeFileSync(OUTLINE_PATH, disk() + '\n### Second outside slide {id=grd4}\n\nAnother outside edit.\n')
  const barAgain = await waitFor(barVisible, 2000)
  await typeAtEndOf('Written by the other TalkWeaver.', ' KEEPMARK')
  const mine = await editorText()
  await page.locator(BAR).getByRole('button', { name: 'Keep mine' }).click()
  const kept = await waitFor(async () => disk().includes('KEEPMARK') && !disk().includes('Second outside slide'), 4000)
  const keptBarGone = await waitFor(async () => !(await barVisible()), 2000)
  await sleep(2200)
  record('Keep mine writes the editor’s text over the newer file, and the bar goes away',
    barAgain !== null && kept !== null && keptBarGone !== null && disk() === mine && !(await barVisible()),
    `bar=${barAgain}ms, kept=${kept !== null}, disk=editor ${disk() === mine}`)

  // (G) Grid view: a rename-replace change (another program writes a temp file and renames it over the
  //     outline) raises the bar there too.
  await page.locator('[data-testid="grid-toggle"]').click()
  await page.waitForTimeout(500)
  const temp = join(dirname(OUTLINE_PATH), '.guard-talk-outline.md.sync-tmp')
  writeFileSync(temp, disk() + '\n### Renamed-over slide {id=grd5}\n\nReplaced by rename.\n')
  renameSync(temp, OUTLINE_PATH)
  const gridBar = await waitFor(barVisible, 2000)
  const inGrid = (await page.locator('[data-testid="grid-toggle"].pane-btn--active').count()) === 1
  record('Grid view shows the bar for a rename-replace change within 2 s', gridBar !== null && inGrid, `after ${gridBar}ms, grid=${inGrid}, "${await barText()}"`)
  await page.locator(BAR).getByRole('button', { name: 'Reload' }).click()
  await waitFor(async () => !(await barVisible()), 3000)
  await page.locator('.pane-toggle .pane-btn').nth(1).click()
  await page.waitForTimeout(600)

  // (W) Switching talks with the bar up: the sheet holds the switch.
  const bar3 = await outsideChangeThenType(disk() + '\n### Before switch {id=grd6}\n\nOutside before the switch.\n', ' SWITCHMARK')
  await clickTalkRow(OTHER)
  const sheet = await waitFor(() => visible(SHEET), 3000)
  const sheetText = ((await page.locator(SHEET).first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
  await page.locator(SHEET).getByRole('button', { name: 'Stay here' }).click()
  await sleep(500)
  const stayed = (await activeTitle()) === TITLE && (await editorText())?.includes('SWITCHMARK') && !(await visible(SHEET))
  record('switching talks with the bar up opens the sheet; Stay here keeps the talk and the typing',
    bar3 !== null && sheet !== null && /This talk changed on disk while you were typing/.test(sheetText) && /Reload/.test(sheetText) && /Keep mine/.test(sheetText) && stayed,
    `sheet=${sheet}ms "${sheetText}", stayed=${stayed}`)
  await clickTalkRow(OTHER)
  await waitFor(() => visible(SHEET), 3000)
  await page.locator(SHEET).getByRole('button', { name: 'Keep mine' }).click()
  const switched = await waitFor(async () => (await activeTitle()) === OTHER, 5000)
  record('Keep mine on the sheet completes, then the switch goes ahead',
    switched !== null && disk().includes('SWITCHMARK') && !disk().includes('Outside before the switch.'),
    `switched=${switched !== null}, mine on disk=${disk().includes('SWITCHMARK')}`)

  // (C) Closing the window with the bar up: the same sheet, then the close.
  await openTalk(TITLE)
  const bar4 = await outsideChangeThenType(disk() + '\n### Before close {id=grd7}\n\nOutside before the close.\n', ' CLOSEMARK')
  // The editor window itself (the app may hold other, hidden windows).
  const editorWindow = await app.browserWindow(page)
  let pageClosed = false
  page.once('close', () => { pageClosed = true })
  await editorWindow.evaluate((w) => w.close())
  const closeSheet = await waitFor(() => visible(SHEET), 3000)
  const heldOpen = !pageClosed
  if (closeSheet !== null) await page.locator(SHEET).getByRole('button', { name: 'Keep mine' }).click()
  const closed = await waitFor(async () => pageClosed, 5000)
  record('closing the window with the bar up opens the sheet; after Keep mine it closes with the text saved',
    bar4 !== null && closeSheet !== null && heldOpen && closed !== null && disk().includes('CLOSEMARK') && !disk().includes('Outside before the close.'),
    `bar=${bar4}ms, sheet=${closeSheet}ms, held open=${heldOpen}, closed=${closed !== null}, mine on disk=${disk().includes('CLOSEMARK')}`)
  await closeApp()

  // (X) A refused save, then a forced kill: the recovery copy is offered on the next open.
  await launch()
  await openTalk(TITLE)
  const outsideText = disk() + '\n### Before crash {id=grd8}\n\nOutside before the crash.\n'
  await outsideChangeThenType(outsideText, ' CRASHMARK')
  const copies = recoveryCopies()
  const copyOk = copies.length === 1 && /^guard-talk-[0-9a-f]{12}-\d{4}-\d\d-\d\dT[\d-]+Z-outline\.md$/.test(copies[0]) && readFileSync(join(recoveryDir, copies[0]), 'utf8').includes('CRASHMARK')
  app.process().kill('SIGKILL')
  app = null
  await sleep(800)
  await launch()
  await openTalk(TITLE)
  const offer = await waitFor(async () => (await barVisible()) && /Restore my unsaved text/.test(await barText()), 4000)
  const offerText = await barText()
  await page.locator(BAR).getByRole('button', { name: 'Restore my unsaved text' }).click()
  const restored = await waitFor(async () => (await editorText())?.includes('CRASHMARK'), 3000)
  const saved = await waitFor(async () => disk().includes('CRASHMARK') && recoveryCopies().length === 0, 5000)
  record('after a forced kill, reopening offers "Restore my unsaved text"; it restores and saves, and the copy is deleted',
    copyOk && offer !== null && restored !== null && saved !== null && !(await barVisible()),
    `copy=${JSON.stringify(copies)} ok=${copyOk}, offer=${offer}ms "${offerText}", restored=${restored !== null}, saved=${saved !== null}, copies after=${recoveryCopies().length}`)

  // (N) Rename the open talk with the bar up: the leave check runs before the folder moves.
  const bar5 = await outsideChangeThenType(disk() + '\n### Before rename {id=grd9}\n\nOutside before the rename.\n', ' RENAMEMARK')
  const NEW_TITLE = 'Guard Talk Renamed'
  const NEW_PATH = join(vault, 'guard-talk-renamed', 'guard-talk-renamed-outline.md')
  async function askRename() {
    await waitForTalkList(page)
    await page.locator(`aside.talk-list.tl-panel .tl-tree [data-talk-title="${TITLE}"]`).first().click({ button: 'right' })
    await page.locator('[role="menu"][aria-label="Talk actions"] [role="menuitem"]', { hasText: 'Rename' }).first().click({ timeout: 5000 })
    const input = page.locator(`[role="dialog"][aria-label^="Rename"] input`).first()
    await input.fill(NEW_TITLE)
    await input.press('Enter')
  }
  await askRename()
  const renameSheet = await waitFor(() => visible(SHEET), 3000)
  await page.locator(SHEET).getByRole('button', { name: 'Stay here' }).click()
  await sleep(800)
  const notRenamed = existsSync(OUTLINE_PATH) && !existsSync(NEW_PATH) && (await editorText())?.includes('RENAMEMARK')
  await askRename()
  await waitFor(() => visible(SHEET), 3000)
  await page.locator(SHEET).getByRole('button', { name: 'Keep mine' }).click()
  const renamed = await waitFor(async () => existsSync(NEW_PATH) && !existsSync(OUTLINE_PATH), 5000)
  const newText = renamed !== null ? readFileSync(NEW_PATH, 'utf8') : ''
  record('renaming the open talk with the bar up: the sheet first (Stay here cancels); after Keep mine the rename goes ahead with the text saved',
    bar5 !== null && renameSheet !== null && notRenamed && renamed !== null && newText.includes('RENAMEMARK') && !newText.includes('Outside before the rename.') && recoveryCopies().length === 0,
    `sheet=${renameSheet}ms, stay kept it=${notRenamed}, renamed=${renamed !== null}, mine in renamed file=${newText.includes('RENAMEMARK')}, copies=${recoveryCopies().length}`)

  // (F) Rename the folder holding the open talk: the talk is re-selected at its new path.
  const FOLDER_OLD = join(vault, 'topic-a', 'folder-talk', 'folder-talk-outline.md')
  const FOLDER_NEW = join(vault, 'topic-b', 'folder-talk', 'folder-talk-outline.md')
  const folderDisk = () => readFileSync(FOLDER_NEW, 'utf8')
  async function folderMenu(folderRel, item) {
    await waitForTalkList(page)
    await page.locator('aside.talk-list.tl-panel .tl-search input[aria-label="Filter talks"]').first().fill('')
    await page.locator(`aside.talk-list.tl-panel .tl-tree [data-folder-path="${folderRel}"]`).first().click({ button: 'right' })
    await page.locator('[role="menu"][aria-label="Folder actions"] [role="menuitem"]', { hasText: item }).first().click({ timeout: 5000 })
  }
  await openTalk(FOLDER_TITLE)
  await typeAtEndOf('First slide body text.', ' BEFOREFOLDER')
  await folderMenu('topic-a', 'Rename folder')
  const folderInput = page.locator('[role="dialog"][aria-label^="Rename folder"] input').first()
  await folderInput.fill('topic-b')
  await folderInput.press('Enter')
  const folderMoved = await waitFor(async () => existsSync(FOLDER_NEW) && !existsSync(join(vault, 'topic-a')), 5000)
  await sleep(1200) // the re-select reloads the editor from the new path
  await typeAtEndOf('Second slide body text.', ' AFTERFOLDER')
  const savedThere = await waitFor(async () => existsSync(FOLDER_NEW) && folderDisk().includes('AFTERFOLDER'), 5000)
  const editorAfter = await editorText()
  record('renaming the folder that holds the open talk re-selects it: the next save lands at the new path, the old folder is not recreated',
    folderMoved !== null && savedThere !== null && folderDisk().includes('BEFOREFOLDER') && !existsSync(FOLDER_OLD) && !existsSync(join(vault, 'topic-a')) && (await activeTitle()) === FOLDER_TITLE && !(await barVisible()),
    `moved=${folderMoved !== null}, saved at new path=${savedThere !== null}, before-typing kept=${existsSync(FOLDER_NEW) && folderDisk().includes('BEFOREFOLDER')}, old recreated=${existsSync(join(vault, 'topic-a'))}, title="${await activeTitle()}", bar=${await barVisible()}`)
  writeFileSync(FOLDER_NEW, folderDisk() + '\n### Outside after folder rename {id=fld3}\n\nOutside at the new path.\n')
  const guardedThere = await waitFor(barVisible, 2000)
  record('after the folder rename the talk is guarded at its new path (an outside change raises the bar)',
    guardedThere !== null && editorAfter?.includes('AFTERFOLDER'), `bar after ${guardedThere}ms`)
  if (guardedThere !== null) {
    await page.locator(BAR).getByRole('button', { name: 'Reload' }).click()
    await waitFor(async () => !(await barVisible()), 3000)
  }

  // (D) Delete the folder holding the open talk: the removed-file bar; typing is refused and kept.
  await folderMenu('topic-b', 'Delete folder')
  await page.locator('[role="dialog"][aria-label^="Move folder"]').getByRole('button', { name: 'Delete' }).click({ timeout: 5000 })
  const removedBar = await waitFor(async () => (await barVisible()) && /removed on disk/.test(await barText()), 4000)
  const removedText = await barText()
  await typeAtEndOf('Second slide body text.', ' AFTERDELETE')
  await sleep(2600) // past the 1.5 s autosave: refused
  const deleteCopies = recoveryCopies()
  const keptInCopy = deleteCopies.some((f) => readFileSync(join(recoveryDir, f), 'utf8').includes('AFTERDELETE'))
  record('deleting the folder that holds the open talk shows the removed-file bar; typing is refused (nothing recreated) and kept in a recovery copy',
    removedBar !== null && !existsSync(join(vault, 'topic-b')) && keptInCopy && (await editorText())?.includes('AFTERDELETE') && (await activeTitle()) === FOLDER_TITLE,
    `bar=${removedBar}ms "${removedText}", folder recreated=${existsSync(join(vault, 'topic-b'))}, copies=${JSON.stringify(deleteCopies)} kept=${keptInCopy}`)
} catch (e) {
  record('disk-guard harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== OUTLINE DISK GUARD SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await closeApp()
  if (!existsSync(tempRoot)) process.exit(1)
  rmSync(tempRoot, { recursive: true, force: true })
  process.exit(failed.length === 0 ? 0 : 1)
}
