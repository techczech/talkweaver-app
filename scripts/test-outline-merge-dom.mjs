// Hidden Chromium: real Editor + watcher hook + conflict modal against real files/guard/writer.
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, readdirSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'
import { createOutlineDiskGuard } from '../src/main/outline-disk-guard.ts'
import { createOutlineRecovery } from '../src/main/outline-recovery.ts'
import { createOutlineSlideMerge } from '../src/main/outline-slide-merge.ts'
import { canonicalOutlinePath } from '../src/main/outline-identity.ts'
import { configureTalkWriter, withTalkFileLock, writeTalkOutline } from '../src/main/talk-writer.ts'
const scratch = mkdtempSync(join(tmpdir(), 'tw-merge-dom-'))
const path = join(scratch, 'outline.md')
const base = '# Talk\n\n## One\n{id=a}\n\n- alpha\n- second\n\n## Two\n{id=b}\n\n- beta\n'
const recovery = createOutlineRecovery(join(scratch, 'recovery'))
let browser, page, writes = 0, plans = 0, replaceDiskOnPlan, removeAtPlan = false, removeAtApply = false
let holdMergeWrite = false, mergeWriteWaiting = false, resumeMergeWrite
const guard = createOutlineDiskGuard({
  canonical: canonicalOutlinePath,
  readText: async p => { try { return await readFile(p, 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e } },
  mtime: async p => { try { return statSync(p).mtimeMs } catch { return null } },
  withLock: (p, work) => withTalkFileLock(p, work),
  watch() {}, unwatch() {},
  notify: (_owner, outlinePath, change) => { void page?.evaluate(({outlinePath,change}) => window.diskEvent?.({outlinePath,change}), {outlinePath,change}).catch(() => {}) },
})
configureTalkWriter({ editorBufferFor: () => null, diskGuard: guard })
const slideMerge = createOutlineSlideMerge({
  guard, recovery: { async preserveMerge(path, sources) {
    if (await page.evaluate(() => window.failRecovery)) throw new Error('unwritable archive')
    return recovery.preserveMerge(path, sources)
  } }, vaultFor: () => scratch,
  readWindow: async () => page.evaluate(() => window.read().text),
  reservedIds: async () => [],
  stageInWindow: (_owner, request) => page.evaluate(request => window.commands.current.commitSlideMerge(request), request),
})
let writeDuringSlideMerge, loseMergeWriteReply = false
try {
  await build({ stdin: { contents: `
import React,{useEffect,useRef,useState} from 'react'
import {createRoot} from 'react-dom/client'
import Editor from './src/renderer/src/components/Editor.tsx'
import {EditorView} from '@codemirror/view'
import {useOutlineDiskChange} from './src/renderer/src/components/useOutlineDiskChange.ts'
import {outlineWritesSettled} from './src/renderer/src/lib/saveQueue.ts'
import {OutlineDiskChangeChip,OutlineDiskChangeSheet} from './src/renderer/src/components/OutlineDiskChangeBar.tsx'
import OutlineMergeSheet from './src/renderer/src/components/OutlineMergeSheet.tsx'
import SlideMergeCards from './src/renderer/src/components/SlideMergeCards.tsx'
import SlideDiskReview from './src/renderer/src/components/SlideDiskReview.tsx'
import Inspector from './src/renderer/src/components/Inspector.tsx'
import {panelEdit} from './src/renderer/src/components/rightPanelDesigns.ts'
import {singleSlideDiskReview} from './src/renderer/src/lib/slideDiskReview.ts'
window.tw={shell:{showInFolder:async path=>{window.revealed=path;return true}},slide:{renderPreview:async()=>null},talk:{planSlideMerge:p=>window.ipcPlan(p),applySlideMerge:(p,g,c)=>window.ipcApply(p,g,c),slideMergePictures:async()=>({}),readOutline:(p)=>window.ipcRead(p),writeOutline:(p,t,o)=>window.ipcWrite(p,t,o),outlineDiskVersion:p=>window.ipcDisk(p),acceptOutlineDiskVersion:(p,h,o)=>window.ipcAccept(p,h,o),preserveOutlineMerge:(p,s)=>window.failRecovery?Promise.resolve(null):window.ipcPreserve(p,s),outlineRecovery:p=>window.ipcRecovery(p),discardOutlineRecovery:p=>window.ipcClear(p),discardRemovedOutline:p=>window.ipcClear(p),onOutlineChangedOnDisk:fn=>{window.diskEvent=fn;return()=>{window.diskEvent=null}}},vault:{onTalkMetaUpdated:()=>()=>{}},workFiles:{list:async()=>null},icons:{svg:async()=>null}}
function Fixture(){
 const read=useRef(null),replace=useRef(null),cmd=useRef(null)
 const [content,setContent]=useState(window.source),[showPicture,setShowPicture]=useState(false)
 const [compiled,setCompiled]=useState(null),[panelPage,setPanelPage]=useState('home')
 useEffect(()=>{
   if(!showPicture)return
   let current=true
   void window.ipcCompilePicture(content).then(result=>{if(current)setCompiled({...result,text:content})})
   return ()=>{current=false}
 },[content,showPicture])
 const row=compiled?.rows[compiled.index]
 window.compiledPicture=compiled;window.outlineContent=content
 const guard=useOutlineDiskChange({activeOutlinePath:window.outlinePath,readDoc:()=>read.current?.({authoredOnly:true})??null,replaceDoc:(t,o)=>replace.current?.(t,o)??null,saveBuffer:()=>cmd.current.forceSave(),flush:()=>cmd.current.flushSave(),settle:s=>cmd.current.settleSave(s),forceSave:s=>cmd.current.forceSave(s),cancelDebouncedSave:p=>cmd.current.cancelDebouncedSave(p),onDiscardTalk:()=>{}})
 const preview=guard.mergeReview && singleSlideDiskReview(guard.mergeReview)
 window.guard=guard;window.replace=(t,o)=>replace.current?.(t,o);window.read=()=>read.current?.();window.commands=cmd;window.openPicture=()=>setShowPicture(true)
 return <><Editor talk={{outlinePath:window.outlinePath,path:'/',slug:'fixture',title:'Fixture'}} content={window.source} viewMode="markdown" onContentChange={text=>setContent(text)} registerReadDoc={fn=>read.current=fn} registerReplaceDoc={fn=>replace.current=fn} registerEditorCommands={c=>cmd.current=c}/>
 {row&&<Inspector talk={{outlinePath:window.outlinePath}} outlineContent={content} compiledSlides={compiled.rows}
   activeIndex={compiled.index} headingLine={row.source_line} triggerFindings={[]} centrePreview page={panelPage} onPageChange={setPanelPage}
   onTry={()=>{}} onKeep={(slide,layout,design)=>{
     const doc=read.current()
     if(doc?.text===content) replace.current?.(panelEdit(doc.text,slide,design,layout),{ownUndoStep:true})
   }}/>}
 {guard.change&&<OutlineDiskChangeChip change={guard.change} busy={guard.busy} onChoose={guard.choose}/ >}{guard.sheet&&<OutlineDiskChangeSheet change={guard.sheet} onAnswer={guard.answerSheet}/ >}{guard.mergeReview&&window.pictureReview&&preview
   ? <SlideDiskReview path={window.outlinePath} review={guard.mergeReview} change={preview} busy={guard.busy}
       keep={()=>guard.applyMerge(guard.mergeReview.generation,{})} putBack={()=>guard.applyMerge(guard.mergeReview.generation,{},'put-back')} close={guard.dismissMerge}/>
   : guard.mergeReview&&<OutlineMergeSheet key={guard.mergeReview.generation} review={guard.mergeReview} busy={guard.busy} onApply={()=>guard.applyMerge(guard.mergeReview.generation,{})} onDismiss={guard.dismissMerge}/>}
 {guard.slideReview&&<SlideMergeCards key={guard.slideReview.generation} path={window.outlinePath} title="Fixture" review={guard.slideReview}
   busy={guard.busy} saving={guard.savingMerge} stale={guard.slideReviewStale} error={guard.slideReviewError} wholeTalk={guard.slideReviewWholeTalk}
   onApply={guard.applySlideReview} onDismiss={guard.dismissMerge} onRefresh={guard.refreshSlideReview}/>}</>
}
window.toasts=[];window.addEventListener('tw-toast',event=>window.toasts.push(event.detail.message))
window.view=()=>EditorView.findFromDOM(document.querySelector('.cm-editor'))
window.settled=()=>outlineWritesSettled(window.outlinePath)
window.mount=()=>createRoot(document.getElementById('root')).render(<Fixture/>)
`, resolveDir: join(import.meta.dirname, '..'), sourcefile: 'merge-harness.tsx', loader: 'tsx' }, bundle: true, define: { __TW_SECURITY_TEST__: 'false' }, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(scratch, 'harness.js'), logLevel: 'silent' })
  writeFileSync(join(scratch, 'fixture.html'), '<meta charset="utf-8"><link rel="stylesheet" href="harness.css"><style>.cm-editor{height:350px}.disk-change-sheet__scrim{position:fixed;inset:0;background:#0004;z-index:1300}</style><div id="root"></div><script src="harness.js"></script>')
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1100, height: 850 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.exposeFunction('ipcRead', async p => { const text=readFileSync(p,'utf8'); guard.track('window',p,text); return text })
  await page.exposeFunction('ipcDisk', p => guard.diskVersion(p))
  await page.exposeFunction('ipcPlan', p => {
    plans++
    if (replaceDiskOnPlan) { writeFileSync(p, replaceDiskOnPlan); replaceDiskOnPlan = undefined }
    if (removeAtPlan) { unlinkSync(p); removeAtPlan = false }
    return slideMerge.plan('window', p)
  })
  await page.exposeFunction('ipcApply', (p,g,c) => {
    if (removeAtApply) { unlinkSync(p); removeAtApply = false }
    return slideMerge.apply('window', p, g, c)
  })
  await page.exposeFunction('ipcAccept', (p,h,o) => guard.accept('window',p,h,o))
  await page.exposeFunction('ipcPreserve', (p,s) => recovery.preserveMerge(p,s))
  await page.exposeFunction('ipcRecovery', p => recovery.read(p))
  await page.exposeFunction('ipcClear', async p => { await recovery.clear(p); return true })
  await page.exposeFunction('ipcCompilePicture', async text => {
    // The Inspector fixture consumes slide projections and picture placement, without rendering a deck.
    const model=await prepareSource(path,text,'Picture fixture',statSync(path),undefined,{projectionsOnly:true})
    const rows=buildPerSlideProjections(model,'picture-fixture')
    const index=rows.findIndex(row=>row.slide_id==='photo')
    return {rows,index,side:model.slides.find(slide=>slide.id==='photo').frame.image}
  })
  await page.exposeFunction('ipcWrite', async (p,text,opts) => {
    if (opts?.slideMergeGeneration) {
      const merge = slideMerge.takeWrite('window', p, opts.slideMergeGeneration, text)
      if (!merge) return false
      if (holdMergeWrite) {
        mergeWriteWaiting = true
        await new Promise(resolve => { resumeMergeWrite = resolve })
      }
      const result = await writeTalkOutline(p, merge.text, 'editor', {
        observedDisk: merge.disk,
        authorize: () => {
          merge.authorize()
          if (writeDuringSlideMerge) writeDuringSlideMerge()
        },
      })
      merge.finish(result)
      if (!result.ok) return false
      writes++
      if (loseMergeWriteReply) throw new Error('Merge landed, but its IPC reply was lost.')
      return { ok: true, collisions: [] }
    }
    const result = await writeTalkOutline(p,text,'editor',{expectedDiskHash:opts?.expectedDiskHash,authorize:()=>{assert.equal(guard.owns('window',p),true)}})
    if (!result.ok && result.changedOnDisk) { await recovery.save(p,text); return {ok:false,refused:'changed-on-disk',change:result.changedOnDisk} }
    if (!result.ok) return false
    writes++; await recovery.clear(p)
    return {ok:true,content:result.text}
  })
  writeFileSync(path, base)
  await page.goto(pathToFileURL(join(scratch, 'fixture.html')).href)
  await page.addStyleTag({content:readFileSync(join(import.meta.dirname,'../src/renderer/src/styles.css'),'utf8').replace(/^@import[^;]+;/gm,'')})
  await page.addStyleTag({content:'.tw-disk-chip{position:fixed;right:10px;bottom:10px}'})
  await page.evaluate(({path,base})=>{window.outlinePath=path;window.source=base;window.mount()}, {path,base})
  await page.waitForFunction(()=>window.read()?.base?.includes('alpha'))
  const external = async text => { writeFileSync(path,text); await guard.check(path) }
  const edit = async (before,after) => page.evaluate(({before,after})=>{const v=window.view(),at=v.state.doc.toString().indexOf(before);v.dispatch({changes:{from:at,to:at+before.length,insert:after}})}, {before,after})
  const keepReady = async () => {
    await page.waitForFunction(()=>window.guard.mergeReview && !window.guard.busy)
    await page.getByRole('button',{name:'Keep the changes',exact:true}).click()
  }
  const cards = page.locator('dialog.merge-cards[open]')
  const apply = () => cards.getByRole('button', { name: 'Apply to the file', exact: true })
  const refresh = () => cards.getByRole('button', { name: 'Refresh review', exact: true })
  const chooseWindow = () => cards.getByRole('button', { name: "Keep this window's version", exact: true }).click()
  const chooseDisk = () => cards.getByRole('button', { name: 'Take the disk version', exact: true }).click()
  const closed = () => page.waitForFunction(() => !window.guard.change && !window.guard.busy && !window.guard.slideReview)
  const fresh = async () => {
    // page.reload bypasses the app's guarded leave; settle a cleared change's save before reset.
    await page.evaluate(async()=>{await window.settled();if(!window.guard.change)await window.commands.current.flushSave();await window.settled()})
    writeFileSync(path,base)
    await page.reload()
    await page.addStyleTag({content:readFileSync(join(import.meta.dirname,'../src/renderer/src/styles.css'),'utf8').replace(/^@import[^;]+;/gm,'')})
    await page.addStyleTag({content:'.tw-disk-chip{position:fixed;right:10px;bottom:10px}'})
    await page.evaluate(({path,base})=>{window.outlinePath=path;window.source=base;window.mount()}, {path,base})
    await page.waitForFunction(()=>window.read()?.base?.includes('alpha'))
  }
  // Drive the review's command through the real editor, with no existing sheet involved.
  for (const lateChange of [true, false]) {
    await fresh()
    const windowText=base.replace('- alpha', '- local slide edit')
    await page.evaluate(text=>window.replace(text,{ownUndoStep:true}),windowText)
    const diskText=base.replace('- beta','- outside slide edit')
    writeFileSync(path,diskText)
    const review=await slideMerge.plan('window',path)
    assert.equal(review.ok,true,JSON.stringify(review))
    const beforeWrites=writes
    const later=base.replace('- beta','- later outside edit')
    writeDuringSlideMerge=lateChange ? ()=>writeFileSync(path,later) : undefined
    const result=await slideMerge.apply('window',path,review.generation,{'id:b':'disk'})
    writeDuringSlideMerge=undefined
    if (lateChange) {
      assert.equal(result.reason,'stale-disk')
      assert.equal(writes,beforeWrites)
      assert.equal(readFileSync(path,'utf8'),later)
      assert.equal(await page.evaluate(()=>window.read().text),windowText)
      await page.evaluate(()=>window.commands.current.undo())
      assert.equal(await page.evaluate(()=>window.read().text),base)
    } else {
      assert.equal(result.ok,true,JSON.stringify(result))
      assert.equal(writes,beforeWrites+1)
      const merged=windowText.replace('- beta','- outside slide edit')
      assert.equal(readFileSync(path,'utf8'),merged)
      assert.equal(await page.evaluate(()=>window.read().text),merged)
      await page.evaluate(()=>window.commands.current.undo())
      assert.equal(await page.evaluate(()=>window.read().text),windowText)
    }
  }
  // The file can land before invoke rejects. Keep the staged text dirty so the next save
  // goes through the guard with the merge, rather than silently putting the old window back.
  await fresh()
  const windowText = base.replace('- alpha', '- local edit with lost reply')
  await page.evaluate(text => window.replace(text, { ownUndoStep: true }), windowText)
  writeFileSync(path, base.replace('- beta', '- disk edit with lost reply'))
  const review = await slideMerge.plan('window', path)
  assert.equal(review.ok, true, JSON.stringify(review))
  const beforeLostReply = writes
  loseMergeWriteReply = true
  try {
    await slideMerge.apply('window', path, review.generation, { 'id:b': 'disk' })
  } finally {
    loseMergeWriteReply = false
  }
  const landed = windowText.replace('- beta', '- disk edit with lost reply')
  assert.equal(writes, beforeLostReply + 1)
  assert.equal(readFileSync(path, 'utf8'), landed)
  const editor = await page.evaluate(() => ({ text: window.read().text, base: window.read().base, dirty: window.read().dirty }))
  assert.deepEqual(editor, { text: landed, base, dirty: true }, 'a lost write reply keeps the merge and the last acknowledged baseline')
  await page.waitForFunction(text => window.outlineContent === text, landed)
  assert.equal(await page.evaluate(() => window.commands.current.forceSave()), true)
  assert.equal(readFileSync(path, 'utf8'), landed, 'the next guarded save must still hold the merged text')
  assert.equal(await page.evaluate(() => window.read().dirty), false)
  assert.deepEqual(errors,[])
  console.log('slide merge DOM: real editor saves once, Undo is exact, a late generation mismatch restores history, and a lost reply keeps the merge dirty')
  await fresh()
  // G1: a provisional picker must never restore a document from before disk adoption.
  for (const action of ['letter','click']) {
    await page.evaluate(()=>{const v=window.view();v.dispatch({selection:{anchor:v.state.doc.toString().indexOf('\n\n- alpha')+1}});v.focus()})
    await page.keyboard.type('{')
    assert.equal(await page.evaluate(()=>window.read().dirty),false)
    const disk=base.replace('alpha',`agent after provisional ${action}`)
    const before=writes
    await external(disk)
    await page.waitForFunction(()=>window.guard.mergeReview&&!window.guard.busy)
    // Keep the provisional picker focused until adoption, as in the original race.
    await page.evaluate(()=>window.guard.applyMerge(window.guard.mergeReview.generation,{}))
    await page.waitForFunction(()=>window.read().text.includes('agent after provisional')&&!window.guard.busy)
    if(action==='letter') await page.keyboard.type('q')
    else {
      const at=await page.evaluate(()=>{const v=window.view(),r=v.coordsAtPos(v.state.doc.toString().indexOf('beta'));return {x:r.left+4,y:r.top+4}})
      await page.mouse.click(at.x,at.y)
    }
    await page.waitForTimeout(40)
    assert.match(await page.evaluate(()=>window.read().text),/agent after provisional/,'provisional rollback must not cross an adoption')
    if(action==='letter') await page.keyboard.type('x')
    await page.evaluate(()=>window.commands.current.flushSave())
    assert.match(readFileSync(path,'utf8'),/agent after provisional/)
    if(action==='click') assert.equal(writes,before,'clicking after clean adoption must not save an old snapshot')
    await fresh()
  }
  writes=0
  // Clean reload keeps the current slide/cursor mapped without a write.
  await page.evaluate(()=>{const v=window.view();v.dispatch({selection:{anchor:v.state.doc.toString().indexOf('beta')}})})
  await page.evaluate(()=>window.view().focus())
  await page.evaluate(()=>{window.failRecovery=true})
  const bundles = () => existsSync(join(scratch, 'recovery', 'merges'))
    ? readdirSync(join(scratch, 'recovery', 'merges')).map(name => JSON.parse(readFileSync(join(scratch, 'recovery', 'merges', name), 'utf8'))) : []
  const archivesBeforeClean = bundles().length
  await external(base.replace('alpha','external clean'))
  await keepReady()
  await page.waitForFunction(()=>window.read()?.text.includes('external clean')&&!window.guard.busy)
  assert.equal(writes,0)
  assert.equal(await page.evaluate(()=>document.activeElement===window.view().contentDOM),true,'clean reload retains editor focus')
  assert.equal(guard.pending(path),null)
  assert.equal(await page.evaluate(()=>window.read().text.slice(window.read().caret,window.read().caret+4)), 'beta')
  assert.equal(bundles().length,archivesBeforeClean,'clean reload creates no merge archive')
  await page.evaluate(()=>{window.failRecovery=false})
  // Overlap, plus an independent window edit. The actual CodeMirror document and file
  // stay untouched by the review, and a watcher event only marks the shown plan stale.
  await edit('external clean','mine conflict')
  await edit('beta','window-only text')
  const preMerge = await page.evaluate(() => window.read().text)
  const incoming = readFileSync(path,'utf8').replace('external clean','disk conflict')
  await external(incoming)
  await cards.waitFor()
  await page.evaluate(() => window.commands.current.undo())
  assert.equal(await page.evaluate(() => window.read().text),preMerge,'editor Undo cannot change an open review’s input')
  assert.match((await cards.locator('article').first().locator('.merge-cards-diff pre del').allTextContents()).join(' '), /\bmine\b/)
  assert.match((await cards.locator('article').first().locator('.merge-cards-diff pre ins').allTextContents()).join(' '), /\bdisk\b/)
  assert.equal(await cards.locator('article').last().getByRole('button',{name:"Keep this window's version",exact:true}).getAttribute('aria-pressed'),'true')
  assert.equal(await apply().isDisabled(),true)
  assert.match(await cards.innerText(),/Discards your edit to this slide/)
  assert.match(await cards.innerText(),/20 copies per talk, up to 14 days/)
  await cards.getByRole('button',{name:'Show recovery copy',exact:true}).click()
  assert.equal(await page.evaluate(() => window.revealed), await page.evaluate(() => window.guard.slideReview.recovery.path))
  const planCount = plans
  const generation = await page.evaluate(() => window.guard.slideReview.generation)
  const newer = incoming.replace('disk conflict','disk newer')
  await external(newer)
  await refresh().waitFor()
  assert.equal(await page.evaluate(() => window.guard.slideReview.generation),generation)
  assert.equal(plans,planCount)
  assert.equal(readFileSync(path,'utf8'),newer)
  assert.equal(await page.evaluate(() => window.read().text),preMerge)
  assert.equal(await apply().isDisabled(),true)
  await refresh().click()
  await page.waitForFunction(g => window.guard.slideReview?.generation !== g && !window.guard.busy, generation)
  assert.equal(plans,planCount+1)
  assert.equal(await apply().isDisabled(),true)
  await cards.getByRole('button',{name:'Decide later',exact:true}).click()
  await cards.waitFor({state:'hidden'})
  assert.equal(readFileSync(path,'utf8'),newer)
  assert.equal(await page.evaluate(() => window.read().text),preMerge)
  await page.getByRole('button',{name:'Review merge',exact:true}).click()
  await cards.waitFor()
  await cards.locator('article').first().getByRole('button',{name:'Take the disk version',exact:true}).click()
  holdMergeWrite = true; mergeWriteWaiting = false
  await apply().click()
  await cards.getByRole('button',{name:'Saving the merge',exact:true}).waitFor()
  for(let remaining=100; !mergeWriteWaiting && remaining>0; remaining--) await page.waitForTimeout(20)
  assert.equal(mergeWriteWaiting,true)
  const staged = await page.evaluate(() => window.read().text)
  await page.evaluate(() => window.view().focus())
  assert.equal(await page.evaluate(() => document.activeElement === window.view().contentDOM),false,'the editor is inert during save')
  await page.keyboard.type('typing during save')
  await page.keyboard.press('Escape')
  assert.equal(await page.evaluate(() => window.read().text),staged)
  assert.equal(await cards.isVisible(),true)
  await page.evaluate(()=>{window.leaveResult=null;window.guard.guardLeave().then(ok=>window.leaveResult=ok)})
  assert.equal(await page.evaluate(()=>window.leaveResult),null)
  holdMergeWrite=false; resumeMergeWrite()
  await closed()
  await page.waitForFunction(()=>window.leaveResult===true)
  assert.equal(readFileSync(path,'utf8'),preMerge.replace('mine conflict','disk newer'))
  await page.evaluate(()=>window.view().focus())
  await page.keyboard.press('ControlOrMeta+z')
  assert.equal(await page.evaluate(() => window.read().text),preMerge)
  await page.evaluate(()=>window.commands.current.settleSave())
  assert.equal(readFileSync(path,'utf8'),preMerge)
  assert.ok(bundles().some(snapshot => snapshot.mine === preMerge && snapshot.disk === newer))

  // A subsequent clean adoption maps the existing user history without rewriting CRLF bytes.
  const crlf = preMerge.replace('mine conflict','external CRLF').replaceAll('\n','\r\n')
  const beforeCRLF = writes
  await external(crlf)
  await keepReady()
  await page.waitForFunction(()=>!window.guard.change&&!window.guard.busy&&window.read().text.includes('external CRLF'))
  await page.evaluate(()=>window.commands.current.flushSave())
  assert.equal(writes,beforeCRLF)
  assert.equal(readFileSync(path,'utf8'),crlf)
  // L2: a failed recovery write leaves a safe, explicit escape; Stay keeps every edit.
  await page.evaluate(()=>{window.failRecovery=true})
  await edit('external CRLF','local unrecoverable')
  await external(readFileSync(path,'utf8').replace('external CRLF','disk unrecoverable'))
  await page.waitForFunction(()=>!window.guard.busy&&window.guard.change)
  await page.evaluate(()=>{window.leaveResult=null;window.guard.guardLeave().then(ok=>window.leaveResult=ok)})
  await page.getByRole('dialog',{name:'Leave without a recovery copy?'}).waitFor()
  await page.getByRole('button',{name:'Stay here',exact:true}).click()
  await page.waitForFunction(()=>window.leaveResult===false)
  assert.match(await page.evaluate(()=>window.read().text),/local unrecoverable/)
  await page.evaluate(()=>{window.failRecovery=false;window.guard.guardLeave().then(ok=>window.leaveResult=ok)})
  await cards.waitFor()
  assert.equal(await page.getByRole('dialog',{name:'Leave without a recovery copy?'}).count(),0,'restored recovery must clear the old failure state')
  await cards.getByRole('button',{name:'Decide later',exact:true}).click()
  await cards.waitFor({state:'hidden'})
  await external(readFileSync(path,'utf8').replace('disk unrecoverable','disk changed once more'))
  await cards.waitFor()
  await cards.getByRole('button',{name:'Decide later',exact:true}).click()
  await page.evaluate(()=>{window.failRecovery=true})
  await external(readFileSync(path,'utf8').replace('disk changed once more','disk unrecoverable again'))
  await page.waitForFunction(()=>window.guard.change && !window.guard.busy)
  await page.evaluate(()=>{window.guard.guardLeave().then(ok=>window.leaveResult=ok)})
  await page.getByRole('dialog',{name:'Leave without a recovery copy?'}).waitFor()
  const diskBeforeDiscard=readFileSync(path,'utf8')
  await page.getByRole('button',{name:'Discard unsaved edits and leave',exact:true}).click()
  await page.waitForFunction(()=>window.leaveResult===true)
  assert.equal(readFileSync(path,'utf8'),diskBeforeDiscard,'explicit discard leaves the canonical disk file unchanged')
  assert.match(await page.evaluate(()=>window.read().text),/disk unrecoverable/)
  // G2: discover removal through version reads alone, without a watcher removal event.
  for(const phase of ['prepare','manual-apply']) {
    await fresh()
    await external(base.replace('beta','clean before removal'))
    await keepReady()
    await page.waitForFunction(()=>window.read().text.includes('clean before removal')&&!window.guard.busy)
    await edit('alpha','local before removal')
    removeAtPlan = phase === 'prepare'
    const incoming = readFileSync(path, 'utf8').replace('alpha','disk before removal')
    await external(incoming)
    if(phase==='manual-apply') {
      await cards.waitFor()
      await chooseWindow()
      removeAtApply=true
      await apply().click()
      await refresh().click()
    }
    await page.waitForFunction(()=>window.guard.change?.kind==='removed'&&!window.guard.busy)
    assert.equal(await page.getByTestId('outline-merge-sheet').count(),0)
    assert.equal(existsSync(path),false)
    await page.evaluate(()=>{window.leaveResult=null;window.leaveError=null;window.guard.guardLeave().then(ok=>window.leaveResult=ok,error=>window.leaveError=error.message)})
    await page.getByRole('dialog').waitFor()
    const removedSheet=page.getByRole('dialog')
    assert.equal(await removedSheet.getByRole('button',{name:'Save it again',exact:true}).count(),1)
    const editorText=await page.evaluate(()=>window.read().text)
    await removedSheet.getByRole('button',{name:phase==='manual-apply'?'Save it again':'Discard',exact:true}).click()
    await page.waitForFunction(()=>window.leaveResult!==null||window.leaveError!==null)
    assert.equal(await page.evaluate(()=>window.leaveError),null,`${phase}: leave must complete without an error`)
    assert.equal(await page.evaluate(()=>window.leaveResult),true)
    assert.equal(existsSync(path),phase==='manual-apply')
    if(phase==='manual-apply') {
      assert.equal(readFileSync(path,'utf8'),editorText,'Save it again writes exactly the live editor text')
      await page.evaluate(()=>{const v=window.view();v.dispatch({selection:{anchor:v.state.doc.length}});v.focus()})
      const before=writes
      await page.keyboard.type('x')
      for(let attempt=0;attempt<100&&writes===before;attempt++)await page.waitForTimeout(50)
      assert.ok(writes>before,'a following keystroke must autosave without another choice')
      assert.equal(readFileSync(path,'utf8'),await page.evaluate(()=>window.read().text))
      assert.equal(guard.pending(path),null)
    }
  }
  // Neon N-a: a blur rollback rejected by a freeze cannot suppress the next authored edit.
  await fresh()
  await page.evaluate(()=>{const v=window.view();v.dispatch({selection:{anchor:v.state.doc.toString().indexOf('\n\n- alpha')+1}});v.focus()})
  await page.keyboard.type('{')
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tw-close-freeze',{detail:{frozen:true,update:false}})))
  await page.waitForTimeout(40)
  await page.evaluate(()=>{window.dispatchEvent(new CustomEvent('tw-close-freeze',{detail:{frozen:false,update:false}}));const v=window.view();v.dispatch({selection:{anchor:v.state.doc.toString().indexOf('alpha')+5}});v.focus()})
  await page.waitForTimeout(40)
  await page.evaluate(()=>{const v=window.view();v.dispatch({selection:{anchor:v.state.doc.toString().indexOf('alpha')+5}});v.focus()})
  await page.keyboard.type('Z')
  assert.equal(await page.evaluate(()=>window.read().dirty),true,'N-a: a rejected rollback must not swallow the next edit')
  await page.evaluate(()=>window.commands.current.flushSave())
  assert.match(readFileSync(path,'utf8'),/alphaZ/)
  // The original through-adoption report is already blocked by picker cancellation/epochs.
  await fresh()
  await page.evaluate(()=>{const v=window.view();v.dispatch({selection:{anchor:v.state.doc.toString().indexOf('\n\n- alpha')+1}});v.focus()})
  await page.keyboard.type('{')
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tw-close-freeze',{detail:{frozen:true,update:false}})))
  await page.waitForTimeout(40)
  await external(base.replace('beta','agent through freeze'))
  await keepReady()
  await page.waitForFunction(()=>window.read().text.includes('agent through freeze')&&!window.guard.busy)
  await page.evaluate(()=>{window.dispatchEvent(new CustomEvent('tw-close-freeze',{detail:{frozen:false,update:false}}));const v=window.view();v.dispatch({selection:{anchor:v.state.doc.toString().indexOf('alpha')+5}});v.focus()})
  await page.keyboard.type('Q')
  await page.evaluate(()=>window.commands.current.flushSave())
  assert.match(readFileSync(path,'utf8'),/agent through freeze/)
  assert.match(readFileSync(path,'utf8'),/alphaQ/)
  // Reverting the file while review is open must leave the window and archive intact.
  await fresh(); await edit('alpha','mine before revert')
  const recurring = base.replace('alpha','recurring disk edit')
  await external(recurring)
  await cards.waitFor()
  const originalPlan = await page.evaluate(() => window.guard.slideReview.generation)
  await external(base)
  await refresh().waitFor()
  assert.equal(await page.evaluate(() => window.guard.slideReview.generation),originalPlan)
  assert.equal(readFileSync(path,'utf8'),base)
  assert.match(await page.evaluate(() => window.read().text),/mine before revert/)
  assert.ok(bundles().some(snapshot => snapshot.disk === recurring && snapshot.mine.includes('mine before revert')))
  await refresh().click()
  await cards.waitFor({state:'hidden'})
  await external(recurring)
  await cards.waitFor()
  await chooseDisk()
  await apply().click()
  await closed()

  // A stable read may see H2 before the watcher reports it. Apply the displayed H2 plan.
  await fresh(); await edit('alpha','mine stale watcher')
  replaceDiskOnPlan=base.replace('alpha','disk H2 without event')
  await external(base.replace('alpha','disk H1 event'))
  await page.waitForFunction(()=>window.guard.slideReview?.sources.disk.includes('disk H2 without event')&&!window.guard.busy)
  await chooseWindow()
  await apply().click()
  await closed()
  assert.match(readFileSync(path,'utf8'),/mine stale watcher/)
  // CA2: after putting back a clean slide, the same external bytes must open a new review.
  await fresh()
  await page.evaluate(()=>{window.pictureReview=true})
  const recurringSlideEdit=base.replace('- alpha','- outside icon {icon=lucide:circle}')
  for (const decision of ['Put it back', 'Keep the change']) {
    const beforeWrites=writes
    await external(recurringSlideEdit)
    const dialog=page.getByRole('dialog',{name:/One.*changed outside TalkWeaver/})
    await dialog.waitFor({timeout:5000})
    assert.equal(await page.evaluate(()=>window.read().text),base,'the editor must hold its old bytes during review')
    assert.equal(readFileSync(path,'utf8'),recurringSlideEdit,'opening review cannot write the talk')
    assert.equal(writes,beforeWrites)
    assert.match(await dialog.locator('.tw-review-diff del').innerText(),/alpha/)
    assert.match(await dialog.locator('.tw-review-diff ins').innerText(),/outside icon/)
    await dialog.getByRole('button',{name:decision,exact:true}).click()
    await page.waitForFunction(()=>!window.guard.change&&!window.guard.mergeReview&&!window.guard.busy)
    const expected=decision==='Put it back'?base:recurringSlideEdit
    assert.equal(await page.evaluate(()=>window.read().text),expected)
    assert.equal(readFileSync(path,'utf8'),expected)
  }

  // Applying the window's version in the cards must also let the same disk edit be reviewed again.
  await fresh()
  const windowVersion=base.replace('alpha','mine before Apply')
  await edit('alpha','mine before Apply')
  await external(recurringSlideEdit)
  await cards.waitFor()
  await chooseWindow()
  await apply().click()
  await closed()
  assert.equal(readFileSync(path,'utf8'),windowVersion)

  await edit('mine before Apply','mine after Apply')
  await external(recurringSlideEdit)
  await cards.waitFor({timeout:5000})
  assert.equal(await page.evaluate(()=>window.read().text),base.replace('alpha','mine after Apply'))
  assert.equal(readFileSync(path,'utf8'),recurringSlideEdit)
  await chooseDisk()
  await apply().click()
  await closed()
  assert.equal(await page.evaluate(()=>window.read().text),recurringSlideEdit)
  assert.equal(readFileSync(path,'utf8'),recurringSlideEdit)

  await fresh()
  copyFileSync(new URL('../demo-vault/layout-sampler/assets/sample-image.png', import.meta.url), join(scratch,'beds.png'))
  const photo = base + '\n### Garden photographs\n{id=photo}\n\n- First view\n\n![The beds](beds.png)\n'
  await page.evaluate(async text=>{window.replace(text,{ownUndoStep:true});await window.commands.current.settleSave()},photo)
  const photoIncoming = photo.replace('- alpha','- updated outside the app')
  await external(photoIncoming)
  await keepReady()
  await page.waitForFunction(()=>!window.guard.change&&!window.guard.busy)
  await page.evaluate(()=>window.openPicture())
  const panel=page.locator('.tw-inspector')
  await panel.locator('.tw-right-adjust').getByRole('button',{name:/^Picture\b/}).click()
  const left=panel.getByRole('button',{name:/On the left/})
  const right=panel.getByRole('button',{name:/On the right/})
  assert.equal(await left.getAttribute('aria-pressed'),'true')
  const checkSide=async (side,choice)=>{
    await choice.click()
    await page.evaluate(()=>window.commands.current.settleSave())
    const text=readFileSync(path,'utf8')
    assert.ok(text.includes(`{image=${side}}`))
    await page.waitForFunction(({text,side})=>window.compiledPicture?.text===text&&window.compiledPicture.side===side,{text,side})
    assert.equal(await choice.getAttribute('aria-pressed'),'true')
    return text
  }
  const pictureRight=await checkSide('right',right)
  assert.equal(await left.getAttribute('aria-pressed'),'false')
  await checkSide('left',left)
  await page.evaluate(async()=>{window.commands.current.undo();await window.commands.current.settleSave()})
  assert.equal(readFileSync(path,'utf8'),pictureRight,'one Undo after moving back restores the saved right placement')
  await page.evaluate(async()=>{window.commands.current.undo();await window.commands.current.settleSave()})
  assert.equal(readFileSync(path,'utf8'),photoIncoming,'a second Undo restores the inherited placement after external Keep')
  assert.deepEqual(errors,[])
  console.log('outline merge DOM: clean cursor-preserving reload, real unsaved editor + external file write, overlap UI, refresh, exact Undo, archived snapshots, and keyboard focus passed')
} finally {
  await browser?.close()
  guard.dispose(); configureTalkWriter({editorBufferFor:()=>null})
  rmSync(scratch,{recursive:true,force:true})
}
