// Real-Electron check of the outline external-change guard (shared-talk ticket 01).
// Open a talk, change its outline file from outside the app (as another TalkWeaver on a shared cloud-synced
// folder would), and check:
//   (O) the app's own saves never raise the bar;
//   (B) an independent outside change raises the bar and waits for Keep the changes;
//   (S) conflicting editor and disk bytes are kept until the author chooses a merge result;
//   (R) choosing the disk slide adopts it, with the old editor and disk bytes retained in recovery;
//   (K) choosing the editor's slide writes it alongside independent disk edits;
//   (G) a rename-replace disk write raises the notice in Grid view;
//   (W) switching stays blocked during a conflict and succeeds after resolving it;
//   (C) closing stays blocked during a conflict and succeeds after resolving it;
//   (X) a refused save leaves a recovery copy, offered on reopen after a forced kill;
//   (N) renaming stays blocked during a conflict and succeeds after resolving it;
//   (F) renaming the folder that holds the open talk re-selects the talk at its new path: typing then
//       saves there (the old folder is not recreated), and the talk is guarded there (an outside change
//       raises the bar) — shared-talk ticket 08;
//   (D) deleting the folder that holds the open talk shows the removed-file bar; typing is refused (the
//       folder is not recreated) and kept in a recovery copy — ticket 08.
// All file assertions read the real files; editor assertions read CodeMirror's own document.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-outline-disk-guard.mjs
import { createAppScratch, launchApp } from './lib/launch-app.mjs'
import { openTalkByTitle, waitForTalkList } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'

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

await using fixture = createAppScratch()
const tempRoot = fixture.root
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
writeFileSync(join(userDataDir, 'config.json'), JSON.stringify({ vaultRoot: vault, openInView: 'outline' }, null, 2))

const disk = () => readFileSync(OUTLINE_PATH, 'utf8')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BAR = '[data-testid="outline-disk-change-bar"]'
const diskNoticeTimeout = 60_000
const review = () => page.getByTestId('outline-merge-sheet')
const testTrash = join(tempRoot, 'trash')
const recoveryCopies = () => { try { return readdirSync(recoveryDir).filter((f) => f.endsWith('-outline.md')) } catch { return [] } }

let app
let page
async function launch() {
  app = (await launchApp({ scratch: fixture, userData: userDataDir, env: { ...process.env, TW_E2E_TRASH_DIR: testTrash }, args: ['.', '--use-mock-keychain'] })).app
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1200)
}

// Quits the app; a close still held (a failing run) is forced.
async function closeApp() {
  if (!app) return
  const proc = app.process()
  await Promise.race([fixture.closeApp(app).catch(() => undefined), sleep(8000)])
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
  await page.keyboard.insertText(text)
}
async function typeAtDocumentLineEnd(lineText, text) {
  const editor = page.locator('[data-view="outline"] .cm-content[contenteditable="true"]')
  await editor.evaluate((element, needle) => {
    const view = element.cmTile.root.view
    for (let n = 1; n <= view.state.doc.lines; n++) {
      const line = view.state.doc.line(n)
      if (!line.text.includes(needle)) continue
      view.focus()
      view.dispatch({ selection: { anchor: line.to }, scrollIntoView: true })
      return
    }
    throw new Error(`The Outline editor does not hold "${needle}"`)
  }, lineText)
  await page.keyboard.insertText(text)
}
const visible = async (selector) => (await page.locator(selector).count()) > 0 && page.locator(selector).first().isVisible()
const barVisible = () => visible(BAR)
const barText = async () => ((await page.locator(BAR).first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
const activeTitle = async () => ((await page.getByTitle('Talk menu', { exact: true }).textContent({ timeout: 1000 }).catch(() => '')) || '').trim()
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
  if (await waitFor(async () => (await activeTitle()) === title && (await editorText())?.includes('First slide body text.'), 6000) === null) {
    throw new Error(`The Outline editor did not open ${title}`)
  }
}
// Clicks a talk row without waiting for the switch (the sheet may hold it).
async function clickTalkRow(title) {
  await waitForTalkList(page)
  await page.locator(`aside.talk-list.tl-panel .tl-tree [data-talk-title="${title}"]`).first().click()
}
const SECOND_BODY = 'Second slide body text.'
async function stageConflict(mine, theirs, extra, typeMarker = typeAtEndOf) {
  const before = disk()
  await typeMarker(SECOND_BODY, ' ' + mine)
  const typed = await editorText()
  if (!typed?.split('\n').some(line => line.includes(SECOND_BODY) && line.includes(mine))) {
    throw new Error(`The editor did not add ${mine} to the conflicting line`)
  }
  if (disk() !== before) throw new Error(`The edit ${mine} reached disk before the outside change`)
  const outside = before.replace(SECOND_BODY, SECOND_BODY + ' ' + theirs) + (extra ?? '')
  writeFileSync(OUTLINE_PATH, outside)
  const bar = await waitFor(barVisible, diskNoticeTimeout)
  await review().waitFor()
  return { bar, outside }
}
async function stayHere() {
  await review().getByRole('button', { name: 'Stay here', exact: true }).click()
  await review().waitFor({ state: 'hidden' })
}
async function chooseVersion(choice) {
  await review().getByRole('button', { name: choice, exact: true }).click()
  await review().getByRole('button', { name: 'Apply merge', exact: true }).click()
  await review().waitFor({ state: 'hidden' })
}
function hasMergeSnapshot(marker) {
  const dir = join(recoveryDir, 'merges')
  return existsSync(dir) && readdirSync(dir).filter((file) => file.endsWith('.json')).some((file) => {
    const data = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    return data.mine?.includes(marker) && typeof data.disk === 'string' && typeof data.base === 'string'
  })
}

try {
  await launch()
  await openTalk(TITLE)

  // (O) Own saves never raise the bar.
  await typeAtEndOf('First slide body text.', ' OWNMARK')
  const ownSaved = await waitFor(async () => disk().includes('OWNMARK'), 5000)
  await sleep(2200)
  record('own save lands and never raises the bar', ownSaved !== null && !(await barVisible()), `saved after ${ownSaved}ms, bar=${await barVisible()}`)

  // (B) Independent disk change. The bar appears before the editor adopts it.
  const theirs = disk() + '\n### Their slide {id=grd3}\n\nWritten by the other TalkWeaver.\n'
  writeFileSync(OUTLINE_PATH, theirs)
  const barAfter = await waitFor(barVisible, diskNoticeTimeout)
  const text1 = await barText()
  if (process.env.TW_E2E_SHOT && barAfter !== null) await page.screenshot({ path: process.env.TW_E2E_SHOT })
  await review().waitFor()
  const unchangedBeforeChoice = (await editorText()) !== theirs && disk() === theirs
  await review().getByRole('button', { name: 'Keep the changes', exact: true }).click()
  const adopted = await waitFor(async () => (await editorText()) === theirs, 4000)
  record('an independent disk edit stays out of the editor until Keep the changes',
    barAfter !== null && /Disk edits are waiting to be merged.*Review merge/.test(text1) && unchangedBeforeChoice && adopted !== null && !(await review().isVisible()),
    'bar=' + barAfter + 'ms, adopted=' + (adopted !== null) + ', text=' + text1)

  // (S) Both sides edited the same slide. An unresolved merge cannot overwrite the outside bytes.
  const conflict = await stageConflict('MINEMARK', 'THEIRMARK')
  const mineInReview = await review().getByRole('textbox', { name: 'Mine 1', exact: true }).inputValue()
  const theirsInReview = await review().getByRole('textbox', { name: 'On disk 1', exact: true }).inputValue()
  await sleep(1800)
  record('an unresolved conflict keeps the typed and outside versions and writes neither over the other',
    conflict.bar !== null && disk() === conflict.outside && mineInReview.includes('MINEMARK') &&
      theirsInReview.includes('THEIRMARK') && await review().getByRole('button', { name: 'Apply merge', exact: true }).isDisabled(),
    'outside file unchanged=' + (disk() === conflict.outside))
  record('conflicting text is kept in a durable recovery bundle', hasMergeSnapshot('MINEMARK'))

  // (R) Reopen the review from the bar. Disk adoption has no undo entry; recovery retains both versions.
  const beforeReview = await editorText()
  await stayHere()
  await page.locator(BAR).getByRole('button', { name: 'Review merge', exact: true }).click()
  await chooseVersion('Use on disk')
  const reloaded = await waitFor(async () => (await editorText()) === conflict.outside && !(await barVisible()), 4000)
  record('Use on disk adopts the outside version and clears the notice', reloaded !== null)
  const snapshots = readdirSync(join(recoveryDir, 'merges')).filter(file => file.endsWith('.json'))
    .map(file => JSON.parse(readFileSync(join(recoveryDir, 'merges', file), 'utf8')))
  record('the pre-merge editor and disk bytes remain available in recovery',
    snapshots.some(snapshot => snapshot.mine === beforeReview && snapshot.disk === conflict.outside))
  await typeAtEndOf('Written by the other TalkWeaver.', ' AFTER_ACCEPT')
  const nextSave = await waitFor(async () => {
    const saved = disk()
    return saved.includes('AFTER_ACCEPT') && !saved.includes('MINEMARK') && !(await barVisible()) && saved === await editorText()
  }, 5000)
  record('after accepting the disk version, the next edit saves normally', nextSave !== null,
    `marker on disk=${disk().includes('AFTER_ACCEPT')}, editor matches disk=${disk() === await editorText()}, bar=${await barVisible()}`)

  // (K) Take the editor's slide and keep an independent new disk slide in the same merge.
  const mixed = await stageConflict('KEEPMARK', 'OVERLAPMARK',
    '\n### Independent disk slide {id=grd4}\n\nAnother outside edit.\n')
  await chooseVersion('Use mine')
  const kept = await waitFor(async () => disk().includes('KEEPMARK') && !(await barVisible()), 5000)
  record('Use mine saves the typed slide and carries forward the independent disk slide',
    mixed.bar !== null && kept !== null && disk().includes('Another outside edit.') &&
      !disk().includes('OVERLAPMARK') && disk() === await editorText())

  // (G) A temp file renamed over the outline still raises the notice in Grid view.
  await page.getByTestId('grid-toggle').click()
  const temp = join(dirname(OUTLINE_PATH), '.guard-talk-outline.md.sync-tmp')
  const renamedOver = disk() + '\n### Renamed-over slide {id=grd5}\n\nReplaced by rename.\n'
  writeFileSync(temp, renamedOver)
  renameSync(temp, OUTLINE_PATH)
  const gridBar = await waitFor(barVisible, diskNoticeTimeout)
  const inGrid = await page.getByTestId('grid-toggle').evaluate(button => button.classList.contains('pane-btn--active'))
  await review().getByRole('button', { name: 'Keep the changes', exact: true }).click()
  const gridAdopted = await waitFor(async () => !(await barVisible()), 3000)
  record('Grid view shows the bar for a rename-replace change',
    gridBar !== null && inGrid && gridAdopted !== null && disk() === renamedOver, 'after ' + gridBar + 'ms, grid=' + inGrid)
  await page.getByTestId('outline-toggle').click()

  // (W) The pending conflict stops a talk switch. After choosing a version, retry the switch.
  const switchConflict = await stageConflict('SWITCHMARK', 'DISKSWITCH')
  await stayHere()
  await clickTalkRow(OTHER)
  await review().waitFor()
  const stayed = (await activeTitle()) === TITLE && disk() === switchConflict.outside &&
    (await review().getByRole('textbox', { name: 'Mine 1', exact: true }).inputValue()).includes('SWITCHMARK')
  record('switching talks with a conflict opens review and keeps the current talk and typing',
    switchConflict.bar !== null && stayed)
  await chooseVersion('Use mine')
  await clickTalkRow(OTHER)
  const switched = await waitFor(async () => (await activeTitle()) === OTHER, 5000)
  record('after resolving the conflict the switch saves the typing', switched !== null &&
    disk().includes('SWITCHMARK') && !disk().includes('DISKSWITCH'))

  // (C) A conflict also holds the window open. Resolve it and retry the close.
  await openTalk(TITLE)
  const closeConflict = await stageConflict('CLOSEMARK', 'DISKCLOSE')
  await stayHere()
  const editorWindow = await app.browserWindow(page)
  let pageClosed = false
  page.once('close', () => { pageClosed = true })
  await editorWindow.evaluate((w) => w.close())
  await review().waitFor()
  const heldOpen = !pageClosed && disk() === closeConflict.outside
  await chooseVersion('Use mine')
  await editorWindow.evaluate((w) => w.close())
  const closed = await waitFor(async () => pageClosed, 5000)
  record('closing with a merge conflict keeps the window open; resolving it allows close with the edits saved',
    closeConflict.bar !== null && heldOpen && closed !== null && disk().includes('CLOSEMARK') && !disk().includes('DISKCLOSE'))
  await closeApp()

  // (X) A refused save, then a forced kill: the recovery copy is offered on the next open.
  await launch()
  await openTalk(TITLE)
  // Target the document line after relaunch; the editor can wrap the accumulated markers.
  await stageConflict('CRASHMARK', 'DISKCRASH', undefined, typeAtDocumentLineEnd)
  await waitFor(async () => recoveryCopies().length === 1, 5000)
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
  const renameConflict = await stageConflict('RENAMEMARK', 'DISKRENAME')
  await stayHere()
  const NEW_TITLE = 'Guard Talk Renamed'
  const NEW_PATH = join(vault, 'guard-talk-renamed', 'guard-talk-renamed-outline.md')
  async function askRename() {
    await waitForTalkList(page)
    await page.locator(`aside.talk-list.tl-panel .tl-tree [data-talk-title="${TITLE}"]`).first().click()
    await page.keyboard.press('F2')
    const input = page.locator(`[role="dialog"][aria-label^="Rename"] input`).first()
    await input.fill(NEW_TITLE)
    await input.press('Enter')
  }
  await askRename()
  await review().waitFor()
  const notRenamed = existsSync(OUTLINE_PATH) && !existsSync(NEW_PATH) && disk() === renameConflict.outside &&
    (await review().getByRole('textbox', { name: 'Mine 1', exact: true }).inputValue()).includes('RENAMEMARK')
  await chooseVersion('Use mine')
  const mergedBeforeRename = await waitFor(() => disk().includes('RENAMEMARK') &&
    !disk().includes('DISKRENAME') && recoveryCopies().length === 0, 5000)
  await askRename()
  const renamed = await waitFor(() => existsSync(NEW_PATH) && !existsSync(OUTLINE_PATH), 10_000)
  const newText = renamed !== null ? readFileSync(NEW_PATH, 'utf8') : ''
  // The moved-editor handoff deliberately preserves its last buffer at the new path before adoption.
  const savedHandoff = renamed === null ? null : await waitFor(() => recoveryCopies().some(file => {
    const path = join(recoveryDir, file)
    return existsSync(path + '.path') && readFileSync(path + '.path', 'utf8').trim() === NEW_PATH &&
      readFileSync(path, 'utf8') === newText
  }), 5000)
  record('renaming a talk with a conflict waits for review; the retry saves the typing and retains the handoff buffer',
    notRenamed && mergedBeforeRename !== null && renamed !== null &&
      newText.includes('RENAMEMARK') && !newText.includes('DISKRENAME') && savedHandoff !== null,
    `held=${notRenamed}, saved before retry=${mergedBeforeRename !== null}, moved=${renamed !== null}, mine=${newText.includes('RENAMEMARK')}, outside=${newText.includes('DISKRENAME')}, handoff=${savedHandoff !== null}`)

  // (F) Rename the folder holding the open talk: the talk is re-selected at its new path.
  const FOLDER_OLD = join(vault, 'topic-a', 'folder-talk', 'folder-talk-outline.md')
  const FOLDER_NEW = join(vault, 'topic-b', 'folder-talk', 'folder-talk-outline.md')
  const folderDisk = () => readFileSync(FOLDER_NEW, 'utf8')
  async function folderAction(folderRel, action) {
    await waitForTalkList(page)
    await page.locator('aside.talk-list.tl-panel .tl-search input[aria-label="Filter talks"]').first().fill('')
    await page.locator(`aside.talk-list.tl-panel .tl-tree [data-folder-path="${folderRel}"]`).first().click({ button: 'right' })
    await page.getByRole('dialog', { name: 'Actions here' })
      .locator(`[data-actions-here-row="folder.${action}"]`).click({ timeout: 5000 })
  }
  await openTalk(FOLDER_TITLE)
  await typeAtEndOf('First slide body text.', ' BEFOREFOLDER')
  await folderAction('topic-a', 'rename')
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
  const editedAfterMove = folderDisk() + '\n### Outside after folder rename {id=fld3}\n\nOutside at the new path.\n'
  writeFileSync(FOLDER_NEW, editedAfterMove)
  const guardedThere = await waitFor(barVisible, diskNoticeTimeout)
  let adoptedThere = null
  if (guardedThere !== null) {
    await review().getByRole('button', { name: 'Keep the changes', exact: true }).click()
    adoptedThere = await waitFor(async () => (await editorText()) === editedAfterMove && !(await barVisible()), 4000)
  }
  record('after the folder rename the talk is guarded at its new path (an outside change raises the bar)',
    guardedThere !== null && editorAfter?.includes('AFTERFOLDER') && adoptedThere !== null,
    `bar after ${guardedThere}ms, adopted=${adoptedThere !== null}`)

  // (D) Delete the folder holding the open talk: the removed-file bar; typing is refused and kept.
  await folderAction('topic-b', 'delete')
  await page.getByRole('dialog', { name: 'Delete this folder?' })
    .getByRole('button', { name: 'Delete', exact: true }).click({ timeout: 5000 })
  const removedBar = await waitFor(async () => (await barVisible()) && /removed on disk/.test(await barText()), diskNoticeTimeout)
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
  process.exitCode = failed.length === 0 ? 0 : 1
}
