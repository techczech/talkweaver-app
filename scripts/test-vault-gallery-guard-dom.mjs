import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {chromium} from 'playwright'
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs'
import {join,resolve} from 'node:path'
const root=resolve(import.meta.dirname,'..'),base=join(root,'evidence/vault-gallery/dom-timeout-repairs')
mkdirSync(base,{recursive:true});const dir=mkdtempSync(join(base,'.guard-'));let browser
try{
 await build({stdin:{resolveDir:root,loader:'tsx',contents:`
 import React,{useState,useRef} from 'react';import {createRoot} from 'react-dom/client';import Gallery from './src/renderer/src/components/vault-gallery/VaultGallery';import {useOutlineDiskChange} from './src/renderer/src/components/useOutlineDiskChange';import {OutlineDiskChangeSheet} from './src/renderer/src/components/OutlineDiskChangeBar';import {outlineDiskChanges} from './src/renderer/src/lib/outlineDiskChange';import SlideMergeCards from './src/renderer/src/components/SlideMergeCards';
 import {planSlideMerge} from './src/shared/outline-merge';
 import {summarizeSlideMerge} from './src/shared/outline-slide-merge';
 const change={outlinePath:'/fixture/current',kind:'changed',hash:'h',changedAt:1};let close;
 window.recoveryChecks=[];window.tw={windows:{recoverMovedTalk:async from=>{window.recoveryChecks.push(from);return {kind:'no-receipt'}}},vault:{galleryInventory:async request=>({...request,state:'refused',reason:'Fixture storage unavailable',entries:[],counted:0,unreadable:0,excluded:0,allocationUnknown:0}),galleryInventoryCancel:async()=>{},onGalleryInventory:()=>()=>{},galleryCatalogue:async generation=>({generation,rootGeneration:0,vaults:[{id:'a',name:'First',status:'stale',talks:[{vaultId:'a',relativeOutline:'t/t-outline.md',title:'Target',slug:'t'}]}]}),galleryFacts:async()=>null,galleryTalk:async()=>({outlinePath:'/fixture/target'})},talk:{slideMergePictures:async()=>({}),outlineRecovery:async()=>null,outlineDiskVersion:async()=>({text:'Disk text',hash:'h'}),acceptOutlineDiskVersion:async()=>({ok:true}),onCloseRequested:cb=>{close=cb;return ()=>{}},ackCloseRequest:async()=>{},discardOutlineRecovery:async()=>true,closeKept:async()=>{window.closeWasHeld=true},confirmClose:async()=>{window.closedOK=true;return true}}};
 window.report=()=>outlineDiskChanges.report(change);window.closeRequest=()=>close({quit:false});
 let generation = 0
 function Harness(){
  const [open,setOpen]=useState(true), [text,setText]=useState('Dirty text')
  const live=useRef({text:'Dirty text',base:'Base text'})
  const entered=useRef(null)
  const save=async()=>{if(window.failSave)return false;live.current.base=live.current.text;return true}
  window.tw.talk.planSlideMerge=async()=>{
    const sources={base:live.current.base,mine:live.current.text,disk:'Disk text'}
    const {rows,details,order,orders,duplicateIds}=planSlideMerge(sources.base,sources.mine,sources.disk)
    const plan={ok:true,generation:String(++generation),fileName:'Fixture',diskHash:'h',sources,rows,details,order,orders,duplicateIds,
      lastSavedAt:1,diskChangedAt:1,unchanged:0,slideCounts:{mine:0,disk:0},recovery:{path:'/fixture/recovery.json',savedAt:1}}
    entered.current=plan
    return plan
  }
  window.tw.talk.applySlideMerge=async(_path,generation,choices)=>{
    if(entered.current.generation!==generation || !await save())return {ok:false,reason:'save-failed',error:'Fixture save refused'}
    return {ok:true,savedAt:1,summary:summarizeSlideMerge(entered.current,choices)}
  }
  const guard=useOutlineDiskChange({activeOutlinePath:'/fixture/current',readDoc:()=>({path:'/fixture/current',...live.current}),
    replaceDoc:(t,o)=>{live.current={text:t,base:o?.diskBase??live.current.base};setText(t);return t},
    saveBuffer:save,flush:async()=>{},settle:async()=>{},forceSave:save,onDiscardTalk:()=>{}})
  return <><div><textarea aria-label="Editor" value={text} onChange={e=>{live.current.text=e.target.value;setText(e.target.value)}}/>
    {guard.slideReview&&<SlideMergeCards key={guard.slideReview.generation} path="/fixture/current" title="Fixture" review={guard.slideReview}
      busy={guard.busy} saving={guard.savingMerge} stale={guard.slideReviewStale} error={guard.slideReviewError} wholeTalk={guard.slideReviewWholeTalk}
      onApply={guard.applySlideReview} onDismiss={guard.dismissMerge} onRefresh={guard.refreshSlideReview}/>}
    {guard.sheet&&<OutlineDiskChangeSheet change={guard.sheet} onAnswer={guard.answerSheet}/>}</div>
    {open&&<Gallery revision={1} onClose={()=>setOpen(false)} onOpen={async()=>{const ok=await guard.guardLeave();window.left=ok;return ok}}/>}</>
 }
 createRoot(document.getElementById('root')).render(<Harness/>);
 `},bundle:true,outfile:join(dir,'bundle.js'),platform:'browser',jsx:'automatic'})
 browser=await chromium.launch({headless:true,...(process.env.TW_HEADLESS_SHELL?{executablePath:process.env.TW_HEADLESS_SHELL}:{})})
 const page=await browser.newPage();page.on('pageerror',error=>console.error('PAGE ERROR',error));await page.setContent('<div id="root"></div>');await page.addScriptTag({path:join(dir,'bundle.js')});await page.addStyleTag({path:join(dir,'bundle.css')});await page.addStyleTag({path:join(root,'src/renderer/src/styles.css')})
 await page.getByRole('row',{name:'First'}).dblclick();await page.getByRole('row',{name:'Target'}).click();await page.getByRole('button',{name:'Open talk',exact:true}).waitFor()
 await page.evaluate(()=>{window.failSave=true;window.report()})
 const sheet=page.getByTestId('outline-merge-sheet');await sheet.waitFor()
 assert.equal(await sheet.evaluate(el=>el.matches(':modal')),true,'the native modal escapes the inert gallery background')
 await page.keyboard.press('Tab')
 assert.equal(await sheet.evaluate(el=>el.contains(document.activeElement)),true,'the merge modal owns keyboard focus')
 await page.keyboard.press('Escape');await sheet.waitFor({state:'detached'})
 assert.equal(await page.locator('textarea[aria-label="Editor"]').inputValue(),'Dirty text')
 await page.getByRole('button',{name:'Open talk',exact:true}).click();await sheet.waitFor()
 assert.equal(await page.evaluate(()=>window.left),false,'unresolved merge holds the gallery switch')
 const apply=()=>sheet.getByRole('button',{name:'Apply to the file',exact:true})
 const keep=()=>sheet.getByRole('button',{name:"Keep this window's talk details",exact:true}).click()
 await keep()
 await apply().click()
 await sheet.getByText('Fixture save refused',{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>!!window.closedOK),false)
 assert.equal(await page.locator('textarea[aria-label="Editor"]').inputValue(),'Dirty text')
 await sheet.getByRole('button',{name:'Decide later',exact:true}).click();await sheet.waitFor({state:'detached'})
 await page.evaluate(()=>{window.failSave=false;window.closeRequest()})
 await apply().waitFor()
 await page.waitForFunction(()=>window.closeWasHeld===true)
 assert.equal(await page.evaluate(()=>!!window.closedOK),false,'close waits for an explicit disk review decision')
 await keep()
 await apply().click()
 await sheet.waitFor({state:'detached'})
 await page.evaluate(()=>window.closeRequest())
 await page.waitForFunction(()=>window.closedOK===true)
 assert.deepEqual(await page.evaluate(()=>window.recoveryChecks),['/fixture/current','/fixture/current'])
 console.log('PASS actual gallery switch holds unresolved merge, modal keeps focus, Decide later preserves editor, failed merge save stays open, successful retry permits close')
}finally{await browser?.close();rmSync(dir,{recursive:true,force:true})}
