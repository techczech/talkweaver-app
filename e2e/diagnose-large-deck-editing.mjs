import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = mkdtempSync(join(tmpdir(), 'tw-large-edit-'))
const ud = join(root, 'userData'), vault = join(root, 'vault'), dir = join(vault, 'large')
mkdirSync(ud, {recursive:true}); mkdirSync(dir, {recursive:true})
const path = join(dir, 'large-outline.md')
const source = '---\noutline_version: 2\ntitle: Large deck\n---\n\n' + Array.from({length:160},(_,i)=>`### Slide ${i} {#slide-${i}}\n\nBody ${i}\n`).join('\n')
writeFileSync(path, source)
writeFileSync(join(ud, 'config.json'), JSON.stringify({vaultRoot:vault}))
const app = await electron.launch({args:['.', '--user-data-dir='+ud], cwd:process.cwd(), env:{...process.env,TW_E2E:'1'}})
try {
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
  await page.locator('.tl-row').first().dblclick()
  await page.locator('.cm-content').waitFor()
  await page.locator('.cm-content').click()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
  await page.keyboard.insertText('\nEditing remains responsive after 160 slides.\n')
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('Editing remains responsive'))
  const saveDeadline = Date.now() + 15_000
  while (!readFileSync(path, 'utf8').includes('Editing remains responsive') && Date.now() < saveDeadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(readFileSync(path, 'utf8').includes('Editing remains responsive'), 'autosave reaches the actual outline file before shutdown')
  const windows=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>({visible:w.isVisible(),destroyed:w.isDestroyed()})))
  assert.ok(windows.every(w=>!w.visible),'all test windows stay hidden')
  console.log(JSON.stringify({first:{compileMs:first.compileMs,totalMs:first.totalMs},edit:{compileMs:after.compileMs,totalMs:after.totalMs},reused,rapidCounts:rapid.map(m=>Object.keys(m).length),windows,root},null,2))
  console.log('PASS real Electron: 160-slide edit, cache reuse, rapid revisions, hidden windows')
} finally {await app.close()}
