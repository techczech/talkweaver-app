import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {chromium} from 'playwright'
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs'
import {resolve,join} from 'node:path'
const base=resolve('evidence/vault-gallery/dom-timeout-repairs');mkdirSync(base,{recursive:true});const dir=mkdtempSync(join(base,'.management-dom-'));let browser
try{
 await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
 import React,{useState} from 'react';import{createRoot}from'react-dom/client';import Management from './src/renderer/src/components/vault-gallery/GalleryManagement';
 window.events=[];window.writes=[];window.tw={windows:{recoverMovedTalk:async from=>{window.events.push(['recover',from]);return {kind:'no-receipt'}}},vault:{renameTalk:async(p,t)=>{window.writes.push([p,t]);window.events.push(['rename',p,t]);return {...talk,title:t,path:'/fixture/new',slug:'new',outlinePath:'/fixture/new/new-outline.md'}}}};
 const talk={title:'Original',slug:'old',path:'/fixture/old',outlinePath:'/fixture/old/old-outline.md',vaultId:'v'};
 const m={talks:[talk],vaults:[{id:'v',name:'Fixture',root:'/fixture',open:true}],activeTalk:talk,foldersByVault:{v:['nested']},leaveActive:async()=>{window.events.push(['leave',!window.refuse]);return !window.refuse},onRefresh:async()=>{window.events.push(['refresh'])},onSelectTalk:async(t,from)=>{window.events.push(['adopt',t,from]);return true},onDeletedTalk:()=>{},onNewTalk:(...a)=>window.created=a,onAddVault:()=>{},onEditVault:()=>{},onSetVaultOpen:async()=>{}};
 const ref={vaultId:'v',relativeOutline:'old/old-outline.md',title:'Original',slug:'old'};
 function H(){const[sel,setSel]=useState(null);window.setSel=setSel;return <><textarea aria-label="Editor" defaultValue="Dirty text"/><Management management={m} vaultId="v" folder="nested" selection={sel&&{kind:'talk',talk:ref}} openTalk={()=>{}} openFolder={()=>{}} showHandouts={()=>{}} canPreview={false} preview={()=>{}} copyLocation={()=>{}} resolve={async()=>talk} reconcile={r=>{window.events.push(['reconcile']);window.result=r}} run={fn=>fn().catch(e=>window.error=String(e))}/></>}
 createRoot(document.getElementById('root')).render(<H/>);
 `},outfile:join(dir,'bundle.js'),bundle:true,platform:'browser',jsx:'automatic'})
 browser=await chromium.launch({headless:true,...(process.env.TW_HEADLESS_SHELL?{executablePath:process.env.TW_HEADLESS_SHELL}:{})});const page=await browser.newPage();page.on('pageerror',error=>console.error('PAGE ERROR',error));await page.setContent('<div id="root"></div>');await page.addScriptTag({path:join(dir,'bundle.js')})
 await page.getByRole('button',{name:'New talk',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.created),['nested','v']);assert.equal(await page.getByRole('button',{name:'Rename',exact:true}).count(),0,'no talk action without a selection');await page.evaluate(()=>window.setSel(true))
 await page.getByRole('button',{name:'Rename',exact:true}).click();let dialog=page.getByRole('dialog');await dialog.waitFor();assert.equal(await dialog.evaluate(el=>!!el.closest('[inert]')),false);assert.equal(await page.locator('#root').getAttribute('inert'),'')
 await dialog.getByRole('button',{name:'Cancel',exact:true}).focus();await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});assert.equal(await page.evaluate(()=>window.writes.length),0);assert.equal(await page.locator('#root').getAttribute('inert'),null)
 await page.getByRole('button',{name:'Rename',exact:true}).click();await dialog.getByRole('textbox').fill('New');await page.evaluate(()=>window.refuse=true);await dialog.getByRole('button',{name:'Rename',exact:true}).click();await page.waitForFunction(()=>window.events.some(e=>e[0]==='leave'&&e[1]===false));assert.equal(await page.evaluate(()=>window.writes.length),0);assert.equal(await page.evaluate(()=>window.error),undefined)
 await page.getByRole('button',{name:'Rename',exact:true}).click();await page.evaluate(()=>window.refuse=false);await dialog.getByRole('textbox').fill('New');await dialog.getByRole('button',{name:'Rename',exact:true}).click();await page.waitForFunction(()=>window.result?.talk?.title==='New');assert.equal(await page.evaluate(()=>window.error),undefined);
 assert.deepEqual(await page.evaluate(()=>window.events.map(e=>e[0])),['recover','leave','recover','leave','rename','adopt','refresh','reconcile']);
 const returned={title:'New',slug:'new',path:'/fixture/new',outlinePath:'/fixture/new/new-outline.md',vaultId:'v'};assert.deepEqual(await page.evaluate(()=>window.result.talk),returned);assert.deepEqual(await page.evaluate(()=>window.events.find(e=>e[0]==='adopt')),['adopt',returned,'/fixture/old/old-outline.md']);
 assert.equal(await page.getByRole('textbox',{name:'Editor'}).inputValue(),'Dirty text')
 await page.getByRole('button',{name:'Move',exact:true}).click();await page.getByRole('dialog',{name:'Move talk within this vault'}).waitFor();assert.deepEqual(await page.getByRole('listbox',{name:'Destination folder'}).getByRole('option').allInnerTexts(),['Vault rootCurrently here','nested']);await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>window.writes.length),1)
 console.log('PASS real management controls: explicit current-folder create with no talk action before selection, interactive portal above inert gallery, Escape cancellation, save refusal, returned identity, mounted dirty editor, same-vault destinations')
}finally{await browser?.close();rmSync(dir,{recursive:true,force:true})}
