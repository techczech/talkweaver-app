import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { scratchVault } from './lib/scratch-vault.mjs'
import { join } from 'node:path'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
using fixture = scratchVault('tw-large-edit-')
const root = fixture.root
const ud = join(root, 'userData'), vault = join(root, 'vault'), dir = join(vault, 'large')
mkdirSync(ud, {recursive:true}); mkdirSync(dir, {recursive:true})
const path = join(dir, 'large-outline.md')
const source = '---\noutline_version: 2\ntitle: Large deck\n---\n\n' + Array.from({length:160},(_,i)=>`### Slide ${i} {#slide-${i}}\n\nBody ${i}\n`).join('\n')
writeFileSync(path, source)
writeFileSync(join(ud, 'config.json'), JSON.stringify({vaultRoot:vault,openInView:'outline'}))
await ensureFreshBuild(process.cwd())
await using app = await electron.launch({args:['.', '--user-data-dir='+ud, '--use-mock-keychain'], cwd:process.cwd(), env:{...process.env,TW_E2E:'1'}})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
const round = async text => page.evaluate(async ({path,text})=> {
  const start=performance.now()
  const slides=await window.tw.talk.compile(path,text)
  const compileMs=performance.now()-start
  const map=await window.tw.talk.thumbnails(path,text)
  return {compileMs,totalMs:performance.now()-start,slides:slides?.length,map}
},{path,text})
const first=await round(source)
const after=await round(source.replace('Body 80\n','Edited body 80\n'))
assert.equal(first.slides,162)
assert.equal(Object.keys(first.map).length,162)
assert.equal(Object.keys(after.map).length,162)
const oldUrls=new Set(Object.values(first.map))
const reused=Object.values(after.map).filter(url=>oldUrls.has(url)).length
assert.equal(reused,161,'a real edit reuses all 161 unchanged PNGs')
const rapid = await page.evaluate(async({path,source})=> {
  const a=window.tw.talk.thumbnails(path,source.replace('Body 80\n','Earlier revision\n'))
  const b=window.tw.talk.thumbnails(path,source.replace('Body 80\n','Latest revision\n'))
  return Promise.all([a,b])
},{path,source})
assert.equal(Object.keys(rapid[0]).length,0,'obsolete request is cancelled')
assert.equal(Object.keys(rapid[1]).length,162,'latest request completes')
// Exercise the real editor and autosave after the direct IPC timing comparison.
await openTalkByTitle(page, 'Large deck')
const editorSelector = '[data-view="outline"] .cm-content[contenteditable="true"]'
const editor = page.locator(editorSelector)
const edit = 'Editing remains responsive after 160 slides.'
await editor.focus()
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
await page.keyboard.insertText(`\n${edit}\n`)
// CodeMirror only renders the visible lines. Read the actual document, including its tail.
await page.waitForFunction(({ selector, edit }) => {
  const doc = document.querySelector(selector)?.cmTile?.root?.view?.state.doc
  return doc?.toString().trimEnd().endsWith(edit)
}, { selector: editorSelector, edit }, { polling: 50, timeout: 30_000 })
const saveDeadline = Date.now() + 15_000
while (!readFileSync(path, 'utf8').includes(edit) && Date.now() < saveDeadline) {
  await new Promise(resolve => setTimeout(resolve, 100))
}
assert.ok(readFileSync(path, 'utf8').includes(edit), 'autosave reaches the actual outline file before shutdown')
const windows=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({visible:w.isVisible(),destroyed:w.isDestroyed()})))
assert.ok(windows.every(w=>!w.visible),'all test windows stay hidden')
console.log(JSON.stringify({first:{compileMs:first.compileMs,totalMs:first.totalMs},edit:{compileMs:after.compileMs,totalMs:after.totalMs},reused,rapidCounts:rapid.map(m=>Object.keys(m).length),windows,root},null,2))
console.log('PASS real Electron: 160-slide edit, cache reuse, rapid revisions, hidden windows')
