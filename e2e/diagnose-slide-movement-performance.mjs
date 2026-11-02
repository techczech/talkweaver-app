// Hidden Electron, synthetic large deck only. No real vault or installed app is opened.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'

const repo = resolve('.')
const scratch = mkdtempSync(join(repo, '.test-slide-movement-performance-'))
process.once('exit', () => rmSync(scratch,{recursive:true,force:true}))
const vault = join(scratch, 'vault'), ud = join(scratch, 'userData'), deck = join(vault, 'large')
mkdirSync(deck, {recursive:true}); mkdirSync(ud)
const header = '---\noutline_version: 2\ntitle: Movement performance fixture\n---\n\n'
const blocks = Array.from({length:160}, (_,i) => `### Slide ${i}\n{id=s${i}}\n\n- Body ${i}\n- Second point\n`)
const source = header + blocks.join('\n')
const outlinePath = join(deck, 'large-outline.md')
writeFileSync(outlinePath, source)
writeFileSync(join(ud, 'config.json'), JSON.stringify({vaultRoot:vault, editorViewMode:'plain'}))
const env = {...process.env, TW_E2E:'1', TW_REC_TEST:'1'}
delete env.ELECTRON_RUN_AS_NODE
let app
try {
  await ensureFreshBuild(repo)
  app = await electron.launch({args:['.', `--user-data-dir=${ud}`, '--use-mock-keychain'], cwd:repo, env})
  const page = await app.firstWindow()
  page.setDefaultTimeout(30000)
  await page.waitForLoadState('domcontentloaded')
  const cold = await page.evaluate(async ({outlinePath,source}) => {
    const started = performance.now(), progress = []
    let completed = false
    const off = window.tw.talk.onThumbnailProgress?.(p => {
      if (p.requestId === 'cold-fixture') progress.push({ms:performance.now()-started,count:Object.keys(p.thumbnails).length,completed})
    })
    const rows = await window.tw.talk.compile(outlinePath,source)
    const map = await window.tw.talk.thumbnails(outlinePath,source,{requestId:'cold-fixture'})
    completed = true
    off?.()
    return {ms:performance.now()-started,progress,map,rows,streaming:!!off}
  }, {outlinePath,source})
  console.log('cold', JSON.stringify({ms:cold.ms,first:cold.progress[0],updates:cold.progress.length,count:Object.keys(cold.map).length}))
  assert.equal(Object.keys(cold.map).length, cold.rows.length, 'every fixture picture completes')
  assert.ok(cold.streaming, 'the thumbnail route delivers progress before the whole-deck Promise completes')
  assert.ok(cold.progress[0].ms < cold.ms && cold.progress.every(p=>!p.completed), 'pictures arrive while rendering continues')
  const edited = source.replace('Body 80','Changed body 80')
  const warm = await page.evaluate(async ({outlinePath,edited}) => {
    const progress=[], start=performance.now()
    const off=window.tw.talk.onThumbnailProgress(p=>{if(p.requestId==='warm-fixture')progress.push({ms:performance.now()-start,keys:Object.keys(p.thumbnails)})})
    const rows=await window.tw.talk.compile(outlinePath,edited)
    const map=await window.tw.talk.thumbnails(outlinePath,edited,{requestId:'warm-fixture'})
    off(); return {ms:performance.now()-start,progress,map,rows}
  }, {outlinePath,edited})
  assert.equal(warm.progress[0].keys.length, cold.rows.length-1, 'all cached pictures arrive before the one missing picture renders')
  console.log('cached-first',JSON.stringify({ms:warm.ms,firstMs:warm.progress[0].ms,cached:warm.progress[0].keys.length}))
  // Swapping ordinary slides must reuse pictures by identity, while preserving their absolute capture index.
  const moved = header + [blocks[1],blocks[0],...blocks.slice(2)].join('\n')
  const reordered=await page.evaluate(async ({outlinePath,moved})=>{
    const start=performance.now(), rows=await window.tw.talk.compile(outlinePath,moved)
    const map=await window.tw.talk.thumbnails(outlinePath,moved)
    return {ms:performance.now()-start,rows,map}
  },{outlinePath,moved})
  const before=new Map(cold.rows.map(r=>[r.slide_id,cold.map[r.render_hash]]))
  const reused=reordered.rows.filter(r=>reordered.map[r.render_hash]===before.get(r.slide_id)).length
  console.log('reorder',JSON.stringify({ms:reordered.ms,reused,total:cold.rows.length}))
  assert.ok(reused>=cold.rows.length-2,'ordinary reorder reuses every unaffected picture (first-slide heuristic may change)')
  // Real workspace, five successive moves on the large fixture, with one shared undo per move.
  // Fault injection wraps the existing IPC handler, as in diagnose-history: no production seam.
  // A failed FIRST compile still counts as opening; subsequent ordinary typing must wait 900ms.
  assert.ok(await app.evaluate(({ipcMain}, path) => {
    const handlers = ipcMain._invokeHandlers, compile = handlers?.get('talk:compile')
    if (!compile) return false
    globalThis.__compileSchedule = []
    handlers.set('talk:compile', async (event, outline, text, ...rest) => {
      if (outline !== path) return compile(event, outline, text, ...rest)
      const call = {at: Date.now(), text, failed: globalThis.__compileSchedule.length === 0}
      globalThis.__compileSchedule.push(call)
      event.sender.executeJavaScript('window.__compileCallCount = '+globalThis.__compileSchedule.length)
      return call.failed ? null : compile(event, outline, text, ...rest)
    })
    return true
  }, outlinePath), 'real compile IPC handler is available for fault injection')
  const openingAt = Date.now()
  await page.getByText('Movement performance fixture',{exact:true}).first().dblclick()
  await page.locator('.cm-content').waitFor()
  await page.getByText('Couldn’t compile this talk', {exact:false}).waitFor()
  const openingCalls = await app.evaluate(() => globalThis.__compileSchedule)
  assert.equal(openingCalls.length, 1, 'first opening attempts compilation once even when it fails')
  assert.ok(openingCalls[0].at - openingAt < 900, 'first opening does not incur the typing debounce')
  await page.locator('.cm-content').focus()
  await page.keyboard.press('Meta+End')
  const typedAt = Date.now()
  await page.keyboard.insertText(' scheduling regression')
  await page.waitForTimeout(650)
  assert.equal(await app.evaluate(() => globalThis.__compileSchedule.length), 1,
    'typing outside the grid after a failed first compile stays debounced')
  await page.waitForFunction(() => !document.body.textContent.includes('Couldn’t compile this talk'))
  const typedCalls = await app.evaluate(() => globalThis.__compileSchedule)
  assert.equal(typedCalls.length, 2, 'the pending typed revision eventually compiles once')
  assert.ok(typedCalls[1].at - typedAt >= 900, 'ordinary typing retains the full 900ms debounce')
  console.log('PASS failed first compile then ordinary typing: ' + (typedCalls[1].at - typedAt) + 'ms debounce')
  // Restore through the real shared history; allow its normal debounce/save before moving slides.
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(1900)
  await page.waitForFunction(({path,source})=>window.tw.talk.readOutline(path).then(t=>t===source), {path:outlinePath,source})
  await page.locator('.pane-btn[title="Grid"]').click()
  const card = i => page.locator('.grid-cell').filter({has:page.locator('span',{hasText:new RegExp(`^Slide ${i}$`)})}).first()
  await card(0).waitFor()
  const baseline=readFileSync(outlinePath,'utf8')
  const timings=[]
  for(let i=2;i<7;i++) {
    const start=performance.now(), mutationAt=Date.now()
    const priorCompiles=await app.evaluate(()=>globalThis.__compileSchedule.length)
    await card(0).evaluate((s,i)=>{
      const d=[...document.querySelectorAll('.grid-cell')].find(c=>[...c.querySelectorAll('span')].some(x=>x.textContent===`Slide ${i}`))
      const dt=new DataTransfer()
      for(const [el,type] of [[s,'dragstart'],[d,'dragover'],[d,'drop'],[s,'dragend']])el.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt}))
    },i)
    await page.waitForFunction(i=>{
      const titles=[...document.querySelectorAll('.grid-cell img')].map(x=>x.alt)
      return titles.indexOf('Slide 0')===titles.indexOf(`Slide ${i}`)+1 && titles.includes('Slide 0')
    },i)
    await page.waitForFunction(prior => window.__compileCallCount > prior, priorCompiles)
    const calls=await app.evaluate(()=>globalThis.__compileSchedule)
    assert.ok(calls.length>priorCompiles && calls[priorCompiles].at-mutationAt<900,
      'deliberate grid movement compiles without the typing debounce')
    timings.push(performance.now()-start)
  }
  console.log('five-moves-ms',JSON.stringify(timings))
  for(let i=0;i<5;i++) { await page.locator('.grid-view').focus();await page.keyboard.press('Meta+z') }
  // Undo autosaves after 1500ms. An immediate read can still see an earlier disk revision.
  await page.waitForTimeout(1800)
  await page.waitForFunction(({path,baseline})=>window.tw.talk.readOutline(path).then(t=>t===baseline),{path:outlinePath,baseline})
  assert.ok(readFileSync(outlinePath,'utf8')===baseline,'five shared Undos restore the fixture byte for byte')
  // Several selected slides, repeatedly moved as a group; identity, order and the shared history remain intact.
  for (const i of [0,1,2]) await card(i).locator('[data-grid-tick]').click()
  const multiTimings=[]
  for (let i=7;i<10;i++) {
    const start=performance.now()
    await card(0).evaluate((s,i)=>{
      const d=[...document.querySelectorAll('.grid-cell')].find(c=>[...c.querySelectorAll('span')].some(x=>x.textContent===`Slide ${i}`))
      const dt=new DataTransfer()
      for(const [el,type] of [[s,'dragstart'],[d,'dragover'],[d,'drop'],[s,'dragend']])el.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt}))
    },i)
    await page.waitForFunction(i=>{
      const t=[...document.querySelectorAll('.grid-cell img')].map(x=>x.alt), at=t.indexOf(`Slide ${i}`)
      return t.slice(at+1,at+4).join('|')==='Slide 0|Slide 1|Slide 2'
    },i)
    assert.equal(await page.locator('[data-batch-count]').textContent(),'3 selected')
    multiTimings.push(performance.now()-start)
  }
  for(let i=0;i<3;i++){await page.locator('.grid-view').focus();await page.keyboard.press('Meta+z')}
  await page.waitForTimeout(1800)
  await page.waitForFunction(({path,baseline})=>window.tw.talk.readOutline(path).then(t=>t===baseline),{path:outlinePath,baseline})
  assert.ok(readFileSync(outlinePath,'utf8')===baseline,'three multi-slide moves undo byte for byte')
  console.log('three-multi-moves-ms',JSON.stringify(multiTimings))
  // Manual rebuilding uses the same progressive route. Reject a late event from another request.
  await page.locator('[data-batch-action="clear"]').click()
  await page.evaluate(() => { window.__refreshUpdates=[]; window.__stopRefreshProbe=window.tw.talk.onThumbnailProgress(p=>window.__refreshUpdates.push({id:p.requestId,count:Object.keys(p.thumbnails).length})) })
  await page.locator('.toolbar-btn').filter({hasText:'Deck'}).click()
  const refreshAt=Date.now(), beforeRefresh=await app.evaluate(()=>globalThis.__compileSchedule.length)
  await page.getByText('Rebuild preview',{exact:true}).click()
  await page.waitForFunction(()=>document.querySelectorAll('.grid-cell img').length>0 && document.querySelectorAll('.grid-cell img').length<162)
  const rebuildCalls=await app.evaluate(()=>globalThis.__compileSchedule)
  assert.ok(rebuildCalls.length>beforeRefresh && rebuildCalls[beforeRefresh].at-refreshAt<900,
    'deliberate rebuild compiles without the typing debounce')
  const refreshProgress=await page.evaluate(()=>window.__refreshUpdates)
  assert.ok(refreshProgress.some(p=>p.count>0&&p.count<162),'manual refresh displays partial pictures while the remaining deck renders')
  await page.waitForFunction(()=>document.querySelectorAll('.grid-cell img').length===162)
  const imageBefore=await card(0).locator('img').getAttribute('src')
  const rowZero=cold.rows.find(r=>r.slide_id==='s0')
  await app.evaluate(({BrowserWindow},payload)=>BrowserWindow.getAllWindows().find(w=>!w.isDestroyed()&&w.webContents.getURL().includes('index.html')).webContents.send('talk:thumbnail-progress',payload),{outlinePath,requestId:'expired-request',thumbnails:{[rowZero.render_hash]:'twthumb://wrong/expired.png'}})
  await page.waitForTimeout(100)
  assert.equal(await card(0).locator('img').getAttribute('src'),imageBefore,'expired thumbnail events cannot replace the current slide image')
  await page.evaluate(()=>window.__stopRefreshProbe())
  console.log('PASS manual refresh displays progressively and ignores an expired request')
  assert.ok(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible())),'all app and render windows remain hidden')
  console.log('PASS progressive thumbnails, cache-first delivery, reorder reuse and five large-deck moves/Undo')
} finally {
  try { await app?.close() } finally { rmSync(scratch,{recursive:true,force:true}) }
}
