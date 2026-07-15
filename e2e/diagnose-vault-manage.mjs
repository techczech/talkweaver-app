// Real-Electron harness for vault management: clone a talk, create a folder, move a talk between
// folders. Drives the IPC layer (the sidebar UI calls exactly these), then checks the on-disk vault.
import { _electron as electron } from 'playwright'
import { fileURLToPath } from 'url'; import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs'; import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url)); const REPO = join(__dirname, '..')
const results = []
const record = (n, p, d) => { results.push({ n, p }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`) }

const root = mkdtempSync(join(tmpdir(), 'tw-e2e-vault-')); const vault = join(root, 'v'); const ud = join(root, 'ud')
const topicA = join(vault, 'topic-a'); const td = join(topicA, 'demo-talk')
mkdirSync(td, { recursive: true }); mkdirSync(ud, { recursive: true })
const fxPath = join(td, 'demo-talk-outline.md')
writeFileSync(fxPath, ['---', 'title: Demo Talk', 'handout_url: https://handouts.fyi/abcd', '---', '', '### A slide', '', 'Body.'].join('\n'))
// a sidecar asset-like file sharing the slug, to prove slug files are renamed on clone
writeFileSync(join(td, 'demo-talk-notes.txt'), 'notes')
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }))

const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded'); await page.waitForTimeout(1200)

try {
  // CLONE
  const cloned = await page.evaluate(({ p }) => window.tw.vault.cloneTalk(p, 'Demo Talk Copy'), { p: fxPath })
  record('clone returns a new talk', !!(cloned && cloned.outlinePath && cloned.outlinePath !== fxPath), `clone=${JSON.stringify(cloned && { slug: cloned.slug, title: cloned.title })}`)
  const cloneDir = cloned ? dirname(cloned.outlinePath) : ''
  record('clone lands as a sibling (same parent folder)', cloneDir && dirname(cloneDir) === topicA, `parent=${cloneDir && dirname(cloneDir)}`)
  record('clone renamed the slug files (outline + sidecar)', !!cloned && existsSync(cloned.outlinePath) && readdirSync(cloneDir).some((f) => f.endsWith('-notes.txt') && f.startsWith(cloned.slug)), `files=${cloned ? readdirSync(cloneDir).join(',') : ''}`)
  record('clone retitled the outline', !!cloned && /title:\s*"?Demo Talk Copy"?/.test(readFileSync(cloned.outlinePath, 'utf8')), '')
  record('clone stripped the published handout_url', !!cloned && !/handout_url/.test(readFileSync(cloned.outlinePath, 'utf8')), '')

  // CREATE FOLDER
  const folderRel = await page.evaluate(() => window.tw.vault.createFolder('topic-b'))
  record('create folder returns its vault-rel path', folderRel === 'topic-b', `rel=${folderRel}`)
  record('folder exists on disk', existsSync(join(vault, 'topic-b')), '')

  // MOVE the original talk into topic-b
  const moved = await page.evaluate(({ p }) => window.tw.vault.moveTalk(p, 'topic-b'), { p: fxPath })
  record('move returns the relocated talk', !!(moved && dirname(moved.outlinePath) === join(vault, 'topic-b', 'demo-talk')), `moved=${moved && moved.outlinePath}`)
  record('the talk folder is gone from its old location', !existsSync(td), '')
  record('the talk folder is in topic-b now', existsSync(join(vault, 'topic-b', 'demo-talk', 'demo-talk-outline.md')), '')

  // LIST FOLDERS includes an EMPTY folder (the "creating a folder does nothing" bug — empty folders
  // were invisible because the sidebar only renders groups that contain talks).
  await page.evaluate(() => window.tw.vault.createFolder('empty-cat'))
  const folders = await page.evaluate(() => window.tw.vault.listFolders())
  record('list-folders includes a brand-new EMPTY folder', Array.isArray(folders) && folders.includes('empty-cat'), `folders=${JSON.stringify(folders)}`)

  // RENAME FOLDER
  const renamed = await page.evaluate(() => window.tw.vault.renameFolder('topic-b', 'topic-b-renamed'))
  record('rename folder returns the new rel path', renamed === 'topic-b-renamed', `rel=${renamed}`)
  record('renamed folder exists; old gone', existsSync(join(vault, 'topic-b-renamed')) && !existsSync(join(vault, 'topic-b')), '')

  // DELETE a talk → OS Trash (the talk folder leaves the vault). We assert it's gone from the vault
  // (trashItem moves it out); recoverable from Finder.
  const movedTalkDir = join(vault, 'topic-b-renamed', 'demo-talk')
  const delOk = await page.evaluate(({ p }) => window.tw.vault.deleteTalk(p), { p: join(movedTalkDir, 'demo-talk-outline.md') })
  record('delete-talk succeeds', delOk === true, `ok=${delOk}`)
  record('deleted talk folder is gone from the vault', !existsSync(movedTalkDir), '')

  // DELETE an empty folder → Trash.
  const delFolderOk = await page.evaluate(() => window.tw.vault.deleteFolder('empty-cat'))
  record('delete-folder succeeds', delFolderOk === true, `ok=${delFolderOk}`)
  record('deleted folder is gone from the vault', !existsSync(join(vault, 'empty-cat')), '')
} catch (e) {
  record('vault-manage harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.p)
  console.log(`\n=== VAULT-MANAGE SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
