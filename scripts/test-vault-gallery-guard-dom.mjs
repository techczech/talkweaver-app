import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {chromium} from 'playwright'
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs'
import {join,resolve} from 'node:path'
const root=resolve(import.meta.dirname,'..'),base=join(root,'evidence/vault-gallery/dom-timeout-repairs')
mkdirSync(base,{recursive:true});const dir=mkdtempSync(join(base,'.guard-'));let browser
try{
 await build({stdin:{resolveDir:root,loader:'tsx',contents:`
 import React,{useState,useRef} from 'react';import {createRoot} from 'react-dom/client';import Gallery from './src/renderer/src/components/vault-gallery/VaultGallery';import {useOutlineDiskChange} from './src/renderer/src/components/useOutlineDiskChange';import {OutlineDiskChangeSheet} from './src/renderer/src/components/OutlineDiskChangeBar';import {outlineDiskChanges} from './src/renderer/src/lib/outlineDiskChange';import OutlineMergeSheet from './src/renderer/src/components/OutlineMergeSheet';
 const change={outlinePath:'/fixture/current',kind:'changed',hash:'h',changedAt:1};let close;
 window.recoveryChecks=[];window.tw={windows:{recoverMovedTalk:async from=>{window.recoveryChecks.push(from);return {kind:'no-receipt'}}},vault:{galleryInventory:async request=>({...request,state:'refused',reason:'Fixture storage unavailable',entries:[],counted:0,unreadable:0,excluded:0,allocationUnknown:0}),galleryInventoryCancel:async()=>{},onGalleryInventory:()=>()=>{},galleryCatalogue:async generation=>({generation,rootGeneration:0,vaults:[{id:'a',name:'First',status:'stale',talks:[{vaultId:'a',relativeOutline:'t/t-outline.md',title:'Target',slug:'t'}]}]}),galleryFacts:async()=>null,galleryTalk:async()=>({outlinePath:'/fixture/target'})},talk:{preserveOutlineMerge:async()=>'/fixture/recovery.json',outlineRecovery:async()=>null,outlineDiskVersion:async()=>({text:'Disk text',hash:'h'}),acceptOutlineDiskVersion:async()=>({ok:true}),onCloseRequested:cb=>{close=cb;return ()=>{}},ackCloseRequest:async()=>{},discardOutlineRecovery:async()=>true,confirmClose:async()=>{window.closedOK=true}}};
 window.report=()=>outlineDiskChanges.report(change);window.closeRequest=()=>close({quit:false});
 function Harness(){const[open,setOpen]=useState(true),[text,setText]=useState('Dirty text');const live=useRef({text:'Dirty text',base:'Base text'});const save=async()=>{if(window.failSave)return false;live.current.base=live.current.text;return true};const guard=useOutlineDiskChange({activeOutlinePath:'/fixture/current',readDoc:()=>({path:'/fixture/current',...live.current}),replaceDoc:(t,o)=>{live.current={text:t,base:o?.diskBase??live.current.base};setText(t);return t},saveBuffer:save,flush:async()=>{},settle:async()=>{},forceSave:save,onDiscardTalk:()=>{}});return <><div><textarea aria-label="Editor" value={text} onChange={e=>{live.current.text=e.target.value;setText(e.target.value)}}/>{guard.mergeReview&&<OutlineMergeSheet key={guard.mergeReview.generation} review={guard.mergeReview} initialChoices={guard.mergeChoices} busy={guard.busy} onApply={guard.applyMerge} onDismiss={guard.dismissMerge} onDraft={guard.keepMergeDraft}/ >}{guard.sheet&&<OutlineDiskChangeSheet change={guard.sheet} onAnswer={guard.answerSheet}/>}</div>{open&&<Gallery revision={1} onClose={()=>setOpen(false)} onOpen={async()=>{const ok=await guard.guardLeave();window.left=ok;return ok}}/>}</>};createRoot(document.getElementById('root')).render(<Harness/>);
 `},bundle:true,outfile:join(dir,'bundle.js'),platform:'browser',jsx:'automatic'})
 browser=await chromium.launch({headless:true,...(process.env.TW_HEADLESS_SHELL?{executablePath:process.env.TW_HEADLESS_SHELL}:{})})
 const page=await browser.newPage();page.on('pageerror',error=>console.error('PAGE ERROR',error));await page.setContent('<div id="root"></div>');await page.addScriptTag({path:join(dir,'bundle.js')});await page.addStyleTag({path:join(dir,'bundle.css')});await page.addStyleTag({path:join(root,'src/renderer/src/styles.css')})
 await page.getByRole('row',{name:'First'}).dblclick();await page.getByRole('row',{name:'Target'}).click();await page.getByRole('button',{name:'Open talk',exact:true}).waitFor()
 await page.evaluate(()=>{window.failSave=true;window.report()})
 const sheet=page.getByTestId('outline-merge-sheet');await sheet.waitFor()
 assert.equal(await sheet.evaluate(el=>!!el.closest('[inert]')),false)
 await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Result 1')
 await page.keyboard.press('Escape');await sheet.waitFor({state:'detached'})
 assert.equal(await page.getByRole('textbox',{name:'Editor',exact:true}).inputValue(),'Dirty text')
 await page.getByRole('button',{name:'Open talk',exact:true}).click();await sheet.waitFor()
 assert.equal(await page.evaluate(()=>window.left),false,'unresolved merge holds the gallery switch')
 await page.getByRole('button',{name:'Use mine',exact:true}).click()
 await page.getByRole('button',{name:'Apply merge',exact:true}).click()
 await page.getByRole('button',{name:'Apply merge',exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>!!window.closedOK),false)
 assert.equal(await page.getByRole('textbox',{name:'Editor',exact:true}).inputValue(),'Dirty text')
 await page.getByRole('button',{name:'Stay here',exact:true}).click();await sheet.waitFor({state:'detached'})
 await page.evaluate(()=>{window.failSave=false;window.closeRequest()})
 await page.waitForFunction(()=>window.closedOK===true)
 assert.deepEqual(await page.evaluate(()=>window.recoveryChecks),['/fixture/current'])
 console.log('PASS actual gallery switch holds unresolved merge, modal escapes inert gallery, Stay preserves editor, failed merge save stays open, successful retry permits close')
}finally{await browser?.close();rmSync(dir,{recursive:true,force:true})}
