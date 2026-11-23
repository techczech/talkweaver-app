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
import { canonicalOutlinePath } from '../src/main/outline-identity.ts'
import { configureTalkWriter, withTalkFileLock, writeTalkOutline } from '../src/main/talk-writer.ts'
const scratch = mkdtempSync(join(tmpdir(), 'tw-merge-dom-'))
const path = join(scratch, 'outline.md')
const base = '# Talk\n\n## One\n{id=a}\n\n- alpha\n- second\n\n## Two\n{id=b}\n\n- beta\n'
const recovery = createOutlineRecovery(join(scratch, 'recovery'))
let browser, page, writes = 0, holdAccept = false, acceptWaiting = false, resumeAccept, removeAtRead=0, holdPreserve=false, preserveWaiting=false, resumePreserve, preserveCalls=0, replaceDiskOnRead=null, failRecoveryAfterWrite=false
const guard = createOutlineDiskGuard({
  canonical: canonicalOutlinePath,
  readText: async p => { try { return await readFile(p, 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e } },
  mtime: async p => { try { return statSync(p).mtimeMs } catch { return null } },
  withLock: (p, work) => withTalkFileLock(p, work),
  watch() {}, unwatch() {},
  notify: (_owner, outlinePath, change) => { void page?.evaluate(({outlinePath,change}) => window.diskEvent?.({outlinePath,change}), {outlinePath,change}).catch(() => {}) },
})
configureTalkWriter({ editorBufferFor: () => null, diskGuard: guard })
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
import SlideDiskReview from './src/renderer/src/components/SlideDiskReview.tsx'
import Inspector from './src/renderer/src/components/Inspector.tsx'
import {panelEdit} from './src/renderer/src/components/rightPanelDesigns.ts'
import {singleSlideDiskReview} from './src/renderer/src/lib/slideDiskReview.ts'
window.tw={slide:{renderPreview:async()=>null},talk:{readOutline:(p)=>window.ipcRead(p),writeOutline:(p,t,o)=>window.ipcWrite(p,t,o),outlineDiskVersion:p=>window.ipcDisk(p),acceptOutlineDiskVersion:(p,h,o)=>window.ipcAccept(p,h,o),preserveOutlineMerge:(p,s)=>window.failRecovery?Promise.resolve(null):window.ipcPreserve(p,s),outlineRecovery:p=>window.ipcRecovery(p),discardOutlineRecovery:p=>window.ipcClear(p),discardRemovedOutline:p=>window.ipcClear(p),onOutlineChangedOnDisk:fn=>{window.diskEvent=fn;return()=>{window.diskEvent=null}}},vault:{onTalkMetaUpdated:()=>()=>{}},workFiles:{list:async()=>null},icons:{svg:async()=>null}}
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
 window.compiledPicture=compiled
 const guard=useOutlineDiskChange({activeOutlinePath:window.outlinePath,readDoc:()=>read.current?.({authoredOnly:true})??null,replaceDoc:(t,o)=>replace.current?.(t,o)??null,saveBuffer:()=>cmd.current.forceSave(),flush:()=>cmd.current.flushSave(),settle:s=>cmd.current.settleSave(s),forceSave:s=>cmd.current.forceSave(s),onDiscardTalk:()=>{}})
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
   : guard.mergeReview&&<OutlineMergeSheet key={guard.mergeReview.generation} review={guard.mergeReview} initialChoices={guard.mergeChoices} busy={guard.busy} onApply={guard.applyMerge} onDismiss={()=>{window.dismissCalls=(window.dismissCalls??0)+1;guard.dismissMerge()}} onDraft={guard.keepMergeDraft}/>}</>
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
  await page.exposeFunction('ipcDisk', p => { if(replaceDiskOnRead!==null){writeFileSync(p,replaceDiskOnRead);replaceDiskOnRead=null}if(removeAtRead>0&&--removeAtRead===0)unlinkSync(p);return guard.diskVersion(p) })
  await page.exposeFunction('ipcAccept', async (p,h,o) => { const result=await guard.accept('window',p,h,o); if(holdAccept){acceptWaiting=true;await new Promise(resolve=>resumeAccept=resolve)} return result })
  await page.exposeFunction('ipcPreserve', async (p,s) => { preserveCalls++;const file=await recovery.preserveMerge(p,s);if(holdPreserve){holdPreserve=false;preserveWaiting=true;const accepted=await new Promise(resolve=>resumePreserve=resolve);if(accepted===false)return null}return file })
  await page.exposeFunction('ipcRecovery', p => recovery.read(p))
  await page.exposeFunction('ipcClear', async p => { await recovery.clear(p); return true })
  await page.exposeFunction('ipcCompilePicture', async text => {
    const model=await prepareSource(path,text,'Picture fixture',statSync(path))
    const rows=buildPerSlideProjections(model,'picture-fixture')
    const index=rows.findIndex(row=>row.slide_id==='photo')
    return {rows,index,side:model.slides.find(slide=>slide.id==='photo').frame.image}
  })
  await page.exposeFunction('ipcWrite', async (p,text,opts) => {
    const result = await writeTalkOutline(p,text,'editor',{expectedDiskHash:opts?.expectedDiskHash,authorize:()=>{assert.equal(guard.owns('window',p),true)}})
    if (!result.ok && result.changedOnDisk) { await recovery.save(p,text); return {ok:false,refused:'changed-on-disk',change:result.changedOnDisk} }
    if (!result.ok) return false
    writes++; await recovery.clear(p)
    if(failRecoveryAfterWrite)await page.evaluate(p=>{window.failRecovery=true;window.diskEvent({outlinePath:p,change:null})},p)
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
  await external(base.replace('alpha','external clean'))
  await keepReady()
  await page.waitForFunction(()=>window.read()?.text.includes('external clean')&&!window.guard.busy)
  assert.equal(writes,0)
  assert.equal(await page.evaluate(()=>document.activeElement===window.view().contentDOM),true,'clean reload retains editor focus')
  assert.equal(guard.pending(path),null)
  assert.equal(await page.evaluate(()=>window.read().text.slice(window.read().caret,window.read().caret+4)), 'beta')
  assert.equal(existsSync(join(scratch,'recovery','merges')),false,'clean reload creates no merge archive')
  await page.evaluate(()=>{window.failRecovery=false})
  // On-disk write while the actual CodeMirror editor has unsaved text.
  await edit('external clean','local edit')
  holdAccept = true
  await external(base.replace('alpha','external clean').replace('beta','external edit'))
  await keepReady()
  for(let i=0; !acceptWaiting && i<100; i++) await page.waitForTimeout(20)
  assert.equal(acceptWaiting,true)
  await page.evaluate(()=>window.view().focus())
  await page.keyboard.type('typed-during-accept ')
  assert.match(await page.evaluate(()=>window.read().text),/typed-during-accept/,'M2: keystrokes during reconciliation are retained')
  assert.equal(await page.locator('[data-close-freeze="merge"]').count(),0)
  await page.evaluate(()=>{window.concurrentFlush=window.commands.current.flushSave()})
  holdAccept=false; resumeAccept()
  await page.waitForFunction(()=>!window.guard.change&&!window.guard.busy&&window.read()?.text.includes('external edit'))
  await page.evaluate(()=>window.concurrentFlush)
  assert.match(readFileSync(path,'utf8'),/local edit/)
  assert.match(readFileSync(path,'utf8'),/external edit/)
  await page.evaluate(()=>window.commands.current.flushSave())
  assert.match(readFileSync(path,'utf8'),/typed-during-accept/)
  await page.evaluate(()=>window.commands.current.undo())
  await page.evaluate(()=>window.commands.current.flushSave())
  assert.match(readFileSync(path,'utf8'),/external edit/,'M1: undo after merging retains the agent text')
  await page.evaluate(()=>window.commands.current.undo())
  assert.match(await page.evaluate(()=>window.read().text),/external clean/,'N2: the user step before adoption is still undoable')
  await page.evaluate(()=>window.commands.current.flushSave())
  assert.match(readFileSync(path,'utf8'),/external edit/,'N2: undoing the earlier user step retains the agent text on disk')
  await page.evaluate(()=>window.commands.current.redo())
  assert.match(await page.evaluate(()=>window.read().text),/local edit/)
  await page.evaluate(()=>window.commands.current.flushSave())
  // Overlap: show complete slide versions and require an explicit choice.
  await edit('local edit','mine conflict')
  await external(readFileSync(path,'utf8').replace('local edit','disk conflict'))
  await page.getByRole('dialog',{name:'Choose the changes to keep'}).waitFor()
  assert.match(await page.getByRole('textbox',{name:'Mine 1',exact:true}).inputValue(),/mine conflict/)
  assert.match(await page.getByRole('textbox',{name:'On disk 1',exact:true}).inputValue(),/disk conflict/)
  assert.equal(await page.getByRole('button',{name:'Apply merge',exact:true}).isDisabled(),true)
  if (process.env.TW_MERGE_CAPTURE) await page.screenshot({path:process.env.TW_MERGE_CAPTURE})
  const beforeChoice=writes
  await page.waitForTimeout(1700)
  assert.equal(writes,beforeChoice,'autosave cannot write while a conflict is unresolved')
  await page.getByRole('textbox',{name:'Result 1',exact:true}).fill('## One\n{id=a}\n\n- custom result\n\n')
  const staleGeneration = await page.evaluate(()=>window.guard.mergeReview.generation)
  await page.evaluate(()=>window.replace(window.read().text.replace('- second','- programmatic Add to talk')))
  await page.getByRole('button',{name:'Apply merge',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('textarea[aria-label="Mine 1"]')?.value.includes('programmatic Add to talk') && document.querySelector('button') && !window.guard.busy)
  assert.equal(await page.getByRole('button',{name:'Apply merge',exact:true}).isDisabled(),true,'H1: a same-hash rebuilt review must reset choices')
  const currentGeneration = await page.evaluate(()=>window.guard.mergeReview.generation)
  assert.notEqual(currentGeneration,staleGeneration)
  await page.evaluate(g=>window.guard.applyMerge(g, {'id:a':'stale result'}), staleGeneration)
  assert.equal(writes,beforeChoice,'H1: an old modal generation cannot apply')
  assert.match(await page.evaluate(()=>window.read().text),/programmatic Add to talk/)
  await page.getByRole('textbox',{name:'Result 1',exact:true}).fill('## One\n{id=a}\n\n- custom result\n\n')
  // Repeated disk change invalidates that result and retains it in a recovery bundle.
  await external(readFileSync(path,'utf8').replace('disk conflict','disk newer'))
  await page.waitForFunction(()=>document.querySelector('textarea[aria-label="On disk 1"]')?.value.includes('disk newer'))
  assert.equal(await page.getByRole('button',{name:'Apply merge',exact:true}).isDisabled(),true)
  assert.equal(writes,beforeChoice)
  const bundles = readdirSync(join(scratch,'recovery','merges')).filter(x=>x.endsWith('.json')).map(x=>JSON.parse(readFileSync(join(scratch,'recovery','merges',x),'utf8')))
  assert.ok(bundles.some(x=>x.draft?.includes('custom result')))
  await page.getByRole('button',{name:'Use on disk',exact:true}).click()
  await page.getByRole('button',{name:'Apply merge',exact:true}).click()
  await page.waitForFunction(()=>!window.guard.mergeReview&&!window.guard.busy)
  assert.match(readFileSync(path,'utf8'),/disk newer/)
  // Edited result is saved, and Tab / Escape are contained in the sheet.
  await edit('disk newer','mine again')
  await external(readFileSync(path,'utf8').replace('disk newer','disk again'))
  await page.getByRole('dialog',{name:'Choose the changes to keep'}).waitFor()
  await page.getByRole('textbox',{name:'Result 1',exact:true}).fill('## One\n{id=a}\n\n- final combined result\n\n')
  await page.keyboard.press('Escape')
  await page.getByTestId('outline-merge-sheet').waitFor({state:'detached'})
  await page.getByRole('button',{name:'Review merge',exact:true}).click()
  await page.getByTestId('outline-merge-sheet').waitFor()
  assert.match(await page.getByRole('textbox',{name:'Result 1',exact:true}).inputValue(),/final combined result/)
  // A close or quit refused by an open, still-current merge keeps the edited Result (no reset).
  await page.keyboard.press('Escape')
  await page.getByTestId('outline-merge-sheet').waitFor({state:'detached'})
  await page.evaluate(()=>{window.leaveResult=null;window.guard.guardLeave().then(ok=>window.leaveResult=ok)})
  await page.waitForFunction(()=>window.leaveResult===false)
  await page.getByTestId('outline-merge-sheet').waitFor()
  assert.match(await page.getByRole('textbox',{name:'Result 1',exact:true}).inputValue(),/final combined result/,'a denied close keeps the edited Result')
  await page.getByRole('button',{name:'Apply merge',exact:true}).focus()
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Stay here')
  holdPreserve=true;preserveWaiting=false
  await page.getByRole('button',{name:'Apply merge',exact:true}).click()
  for(let i=0;!preserveWaiting&&i<100;i++)await page.waitForTimeout(20)
  assert.equal(preserveWaiting,true)
  const callsBefore=preserveCalls
  const dismissBefore=await page.evaluate(()=>window.dismissCalls??0)
  await page.keyboard.press('Escape')
  assert.equal(await page.evaluate(()=>window.dismissCalls??0),dismissBefore,'busy Escape must not invoke dismissal')
  await page.evaluate(()=>window.guard.dismissMerge())
  await page.waitForTimeout(40)
  assert.equal(preserveCalls,callsBefore,'busy dismissal must not start another preservation')
  assert.equal(await page.getByTestId('outline-merge-sheet').count(),1)
  resumePreserve()
  await page.waitForFunction(()=>!window.guard.mergeReview&&!window.guard.busy)
  assert.match(readFileSync(path,'utf8'),/final combined result/)
  await page.evaluate(()=>window.commands.current.undo())
  assert.match(await page.evaluate(()=>window.read().text),/final combined result/,'M1: undo cannot cross the adopted disk version')
  await page.evaluate(()=>window.commands.current.redo())
  assert.match(await page.evaluate(()=>window.read().text),/final combined result/)
  await page.evaluate(()=>window.commands.current.flushSave())
  const crlf = readFileSync(path,'utf8').replace('final combined result','external CRLF').replaceAll('\n','\r\n')
  const beforeCRLF = writes
  await external(crlf)
  await keepReady()
  await page.waitForFunction(()=>!window.guard.change&&!window.guard.busy&&window.read().text.includes('external CRLF'))
  await page.evaluate(()=>window.commands.current.flushSave())
  assert.equal(writes,beforeCRLF,'clean CRLF reload must not cause a save')
  assert.equal(readFileSync(path,'utf8'),crlf)
  await page.evaluate(()=>window.commands.current.undo())
  await page.evaluate(()=>window.commands.current.flushSave())
  assert.match(readFileSync(path,'utf8'),/external CRLF/,'N2: undo after clean reload retains the agent text while undoing an older user step')
  assert.match(readFileSync(path,'utf8'),/external edit/)
  await page.evaluate(()=>window.commands.current.redo())
  await page.evaluate(()=>window.commands.current.flushSave())
  assert.equal(readFileSync(path,'utf8').replaceAll('\r\n','\n'),crlf.replaceAll('\r\n','\n'),'redo restores the user step without removing either external edit')
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
  await page.getByRole('dialog',{name:'Choose the changes to keep'}).waitFor()
  assert.equal(await page.getByRole('dialog',{name:'Leave without a recovery copy?'}).count(),0,'restored recovery must clear the old failure state')
  await page.getByRole('button',{name:'Stay here',exact:true}).click()
  await page.getByTestId('outline-merge-sheet').waitFor({state:'detached'})
  await page.evaluate(()=>{window.failRecovery=true;window.guard.guardLeave().then(ok=>window.leaveResult=ok)})
  await page.getByRole('dialog',{name:'Leave without a recovery copy?'}).waitFor()
  const diskBeforeDiscard=readFileSync(path,'utf8')
  await page.getByRole('button',{name:'Discard unsaved edits and leave',exact:true}).click()
  await page.waitForFunction(()=>window.leaveResult===true)
  assert.equal(readFileSync(path,'utf8'),diskBeforeDiscard,'explicit discard leaves the canonical disk file unchanged')
  assert.match(await page.evaluate(()=>window.read().text),/disk unrecoverable/)
  // G2: discover removal through version reads alone, without a watcher removal event.
  for(const phase of ['prepare','auto-apply','manual-apply']) {
    await fresh()
    await external(base.replace('beta','clean before removal'))
    await keepReady()
    await page.waitForFunction(()=>window.read().text.includes('clean before removal')&&!window.guard.busy)
    await edit('alpha','local before removal')
    removeAtRead=phase==='prepare'?1:0
    await external(base.replace(phase==='manual-apply'?'alpha':'beta','disk before removal'))
    if(phase==='auto-apply') {
      await page.waitForFunction(()=>window.guard.mergeReview && !window.guard.busy)
      removeAtRead=1
      await keepReady()
    }
    if(phase==='manual-apply') {
      await page.getByTestId('outline-merge-sheet').waitFor()
      await page.getByRole('button',{name:'Use mine',exact:true}).click()
      removeAtRead=1
      await page.getByRole('button',{name:'Apply merge',exact:true}).click()
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
  // N-e: a cleared conflict must not suppress the same disk hash when the editor is now clean.
  await fresh();await edit('alpha','mine before recurring hash')
  const recurring=base.replace('alpha','recurring disk edit')
  await external(recurring)
  await page.getByTestId('outline-merge-sheet').waitFor()
  await external(base)
  await page.waitForFunction(()=>!window.guard.change&&!window.guard.busy&&!window.read().dirty)
  await external(recurring)
  await keepReady()
  await page.waitForFunction(()=>window.read().text.includes('recurring disk edit')&&!window.guard.busy)
  // N-b: a fresh H2 read supersedes the H1 event, even when the watcher never reports H2.
  await fresh();await edit('alpha','mine stale watcher')
  replaceDiskOnRead=base.replace('alpha','disk H2 without event')
  await external(base.replace('alpha','disk H1 event'))
  await page.waitForFunction(()=>window.guard.mergeReview?.disk.includes('disk H2 without event')&&!window.guard.busy)
  const generation=await page.evaluate(()=>window.guard.mergeReview.generation),archivesBefore=preserveCalls
  await page.waitForTimeout(1300)
  assert.equal(await page.evaluate(()=>window.guard.mergeReview.generation),generation,'N-b: no endless fresh-review loop')
  assert.equal(preserveCalls,archivesBefore)
  await page.getByRole('button',{name:'Use mine',exact:true}).click()
  await page.getByRole('button',{name:'Apply merge',exact:true}).click()
  await page.waitForFunction(()=>!window.guard.change&&!window.guard.busy)
  assert.match(readFileSync(path,'utf8'),/mine stale watcher/)
  // N-f: a disk revert archives the custom result before closing the modal.
  await fresh();await edit('alpha','mine before revert')
  await external(base.replace('alpha','disk before revert'))
  await page.getByTestId('outline-merge-sheet').waitFor()
  await page.getByRole('textbox',{name:'Result 1',exact:true}).fill('## One\n{id=a}\n- Neon reverted draft\n')
  await external(base)
  await page.waitForFunction(()=>!window.guard.change&&!window.guard.busy)
  const reverted=readdirSync(join(scratch,'recovery','merges')).map(name=>JSON.parse(readFileSync(join(scratch,'recovery','merges',name),'utf8')))
  assert.ok(reverted.some(item=>item.draft?.includes('Neon reverted draft')),'N-f: the custom result survives a change:null event')
  // A failed archive on reversion keeps the result open until preservation succeeds.
  await fresh();await edit('alpha','mine failed revert')
  await external(base.replace('alpha','disk failed revert'))
  await page.getByTestId('outline-merge-sheet').waitFor()
  await page.getByRole('textbox',{name:'Result 1',exact:true}).fill('## One\n{id=a}\n- Neon unarchived draft\n')
  await page.evaluate(()=>window.failRecovery=true)
  await external(base)
  await page.waitForTimeout(80)
  assert.equal(await page.getByTestId('outline-merge-sheet').count(),1)
  assert.match(await page.getByRole('textbox',{name:'Result 1',exact:true}).inputValue(),/Neon unarchived draft/)
  await page.evaluate(()=>window.failRecovery=false)
  await page.keyboard.press('Escape')
  await page.getByTestId('outline-merge-sheet').waitFor({state:'detached'})
  assert.ok(readdirSync(join(scratch,'recovery','merges')).some(name=>JSON.parse(readFileSync(join(scratch,'recovery','merges',name),'utf8')).draft?.includes('Neon unarchived draft')))
  // Neon re-check 2: the successful manual save owns its already-preserved review.
  await fresh();await edit('alpha','mine manual clear')
  await external(base.replace('alpha','disk manual clear'))
  await page.getByTestId('outline-merge-sheet').waitFor()
  await page.getByRole('button',{name:'Use mine',exact:true}).click()
  const archivesBeforeApply=preserveCalls
  failRecoveryAfterWrite=true
  await page.getByRole('button',{name:'Apply merge',exact:true}).click()
  await page.waitForFunction(()=>!window.guard.mergeReview&&!window.guard.busy)
  failRecoveryAfterWrite=false
  await page.waitForTimeout(40)
  assert.equal(preserveCalls,archivesBeforeApply+1,'only Apply archives the chosen result')
  assert.equal(await page.evaluate(()=>window.toasts.some(t=>t.includes('Could not keep your merge draft'))),false,'successful manual save must not report a redundant archive failure')
  assert.match(readFileSync(path,'utf8'),/mine manual clear/)
  // A preservation that started before Apply cannot report failure against a retired review.
  await fresh();await edit('alpha','mine retired review')
  await external(base.replace('alpha','disk retired review'))
  await page.getByTestId('outline-merge-sheet').waitFor()
  await page.getByRole('button',{name:'Use mine',exact:true}).click()
  holdPreserve=true;preserveWaiting=false
  await page.evaluate(p=>window.diskEvent({outlinePath:p,change:null}),path)
  for(let i=0;!preserveWaiting&&i<100;i++)await page.waitForTimeout(20)
  assert.equal(preserveWaiting,true)
  await page.getByRole('button',{name:'Apply merge',exact:true}).click()
  await page.waitForFunction(()=>!window.guard.mergeReview&&!window.guard.busy)
  resumePreserve(false)
  await page.waitForTimeout(60)
  assert.equal(await page.evaluate(()=>window.toasts.some(t=>t.includes('Could not keep your merge draft'))),false,'retired review failure must be ignored')
  assert.match(readFileSync(path,'utf8'),/mine retired review/)
  // N-h: leaving joins the accepted merge already in flight instead of cancelling immediately.
  await fresh();await edit('alpha','local before leave')
  holdAccept=true;acceptWaiting=false
  await external(base.replace('beta','external before leave'))
  await keepReady()
  for(let i=0;!acceptWaiting&&i<100;i++)await page.waitForTimeout(20)
  assert.equal(acceptWaiting,true)
  await page.evaluate(()=>{window.leaveResult=null;window.guard.guardLeave().then(ok=>window.leaveResult=ok)})
  await page.waitForTimeout(40)
  assert.equal(await page.evaluate(()=>window.leaveResult),null,'N-h: leave must wait for the active reconciliation')
  holdAccept=false;resumeAccept()
  await page.waitForFunction(()=>window.leaveResult===true)
  assert.match(readFileSync(path,'utf8'),/local before leave/)
  assert.match(readFileSync(path,'utf8'),/external before leave/)
  // CA2: review the unchanged buffer and external bytes, then reject and keep in separate runs.
  for (const decision of ['Put it back', 'Keep the change']) {
    await fresh()
    await page.evaluate(()=>{window.pictureReview=true})
    const incoming=base.replace('- alpha','- outside icon {icon=lucide:circle}')
    const beforeWrites=writes
    await external(incoming)
    const dialog=page.getByRole('dialog',{name:/One.*changed outside TalkWeaver/})
    await dialog.waitFor()
    assert.equal(await page.evaluate(()=>window.read().text),base,'the editor must hold its old bytes during review')
    assert.equal(readFileSync(path,'utf8'),incoming,'opening review cannot write the talk')
    assert.equal(writes,beforeWrites)
    assert.match(await dialog.locator('.tw-review-diff del').innerText(),/alpha/)
    assert.match(await dialog.locator('.tw-review-diff ins').innerText(),/outside icon/)
    await dialog.getByRole('button',{name:decision,exact:true}).click()
    await page.waitForFunction(()=>!window.guard.mergeReview&&!window.guard.busy)
    const expected=decision==='Put it back'?base:incoming
    assert.equal(await page.evaluate(()=>window.read().text),expected)
    assert.equal(readFileSync(path,'utf8'),expected)
  }
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
  console.log('outline merge DOM: clean cursor-preserving reload, real unsaved editor + external file write, overlap UI, repeated changes/draft recovery, explicit choices, edited result, keyboard focus passed')
} finally {
  await browser?.close()
  guard.dispose(); configureTalkWriter({editorBufferFor:()=>null})
  rmSync(scratch,{recursive:true,force:true})
}
