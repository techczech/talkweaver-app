import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
const root=resolve(import.meta.dirname,'..')
mkdirSync(join(root,'evidence/vault-gallery/redesign-implementation/title-facts'),{recursive:true})
const dir=mkdtempSync(join(root,'evidence/vault-gallery/redesign-implementation/title-facts/.dom-'))
let browser
try {
 await build({stdin:{resolveDir:root,loader:'tsx',contents:`
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import Gallery from './src/renderer/src/components/vault-gallery/VaultGallery';
 window.tw={vault:{galleryInventory:async request=>({...request,state:'refused',reason:'Fixture storage unavailable',entries:[],counted:0,unreadable:0,excluded:0,allocationUnknown:0}),galleryInventoryCancel:async()=>{},onGalleryInventory:()=>()=>{},galleryCatalogue:async generation=>(window.catalogueGeneration=generation,{generation,rootGeneration:window.rootGeneration??1,vaults:[{id:'a',name:'First',status:'stale',talks:[{vaultId:'a',relativeOutline:'Work/twin/twin-outline.md',title:'First twin',slug:'twin'},{vaultId:'a',relativeOutline:'Work/missing/missing-outline.md',title:'Missing preview',slug:'missing'}]},{id:'b',name:'Second',status:'closed',talks:[]}]}),galleryFacts:async(id,path)=>({revision:'fixture',slideCount:3,imageCount:2,coverUrl:path.includes('missing')?null:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="navy"/><text x="30" y="100" fill="white">Real fixture title</text></svg>'),preview:path.includes('missing')?'unavailable':'ready'}),galleryTalk:async()=>window.deferTalk?await new Promise(r=>window.releaseTalk=r):({outlinePath:'/fixture/a/Work/twin/twin-outline.md'})}};
 function Harness(){const[open,setOpen]=useState(false),[revision,setRevision]=useState(1);window.changeRevision=()=>setRevision(v=>v+1);return <><textarea aria-label="Editor" defaultValue="Unsaved text"/><button onClick={()=>setOpen(true)}>Browse</button>{open&&<Gallery revision={revision} onClose={()=>setOpen(false)} onOpen={async()=>{window.openCalls=(window.openCalls||0)+1;return false}}/>}</>};createRoot(document.getElementById('root')).render(<Harness/>);
 `},bundle:true,outfile:join(dir,'bundle.js'),platform:'browser',jsx:'automatic'})
 browser=await chromium.launch({headless:true, ...(process.env.TW_HEADLESS_SHELL ? {executablePath:process.env.TW_HEADLESS_SHELL} : {})})
 const page=await browser.newPage()
 await page.setContent('<div id="root"></div>')
 await page.addScriptTag({path:join(dir,'bundle.js')})
 await page.addStyleTag({path:join(dir,'bundle.css')})
 const editor=page.getByRole('textbox',{name:'Editor',exact:true})
 await editor.fill('Dirty buffer preserved')
 await editor.evaluate(el=>{window.savedEditor=el;el.setSelectionRange(2,8);el.scrollTop=12;window.savedScroll=el.scrollTop})
 await page.getByRole('button',{name:'Browse',exact:true}).click()
 // overview strip: real title slide where the facts have one, honest placeholder where they do not
 await page.getByRole('img',{name:'Title slide of First twin',exact:true}).waitFor()
 await page.getByRole('option',{name:'Missing preview',exact:true}).getByText('Title preview unavailable').waitFor()
 await page.screenshot({path:join(root,'evidence/vault-gallery/redesign-implementation/title-facts-overview.png')})
 await page.setViewportSize({width:390,height:844})
 await page.waitForFunction(()=>{const g=document.querySelector('.vault-gallery');return g.clientWidth===390&&g.scrollWidth<=390})
 await page.getByRole('button',{name:'Show all talks'}).click()
 await page.getByRole('button',{name:'Folders',exact:true}).click();await page.getByRole('tree').getByRole('treeitem',{name:/Work/}).click()
 assert.match(await page.getByRole('navigation',{name:'Location'}).innerText(),/Work/)
 const grid=page.getByRole('grid',{name:'Talks and folders'})
 await grid.getByRole('row',{name:'First twin'}).click()
 await page.getByRole('button',{name:'Gallery',exact:true}).click()
 await page.getByRole('img',{name:'Title slide of First twin',exact:true}).waitFor()
 assert.equal(await page.getByRole('option',{name:'First twin',exact:true}).getAttribute('aria-selected'),'true','selection survives the view switch')
 await page.getByRole('option',{name:'First twin',exact:true}).focus();await page.keyboard.press('Space')
 await page.getByRole('region',{name:'Title preview: First twin'}).waitFor()
 await page.keyboard.press('Escape');await page.getByRole('region',{name:'Title preview: First twin'}).waitFor({state:'detached'})
 assert.equal(await page.getByRole('dialog',{name:'Vault Gallery'}).count(),1,'Escape closed only the preview')
 await page.getByRole('button',{name:'List',exact:true}).click()
 await page.getByRole('textbox',{name:/^Search this/}).fill('First')
 assert.equal(await page.getByRole('row',{name:/First twin/}).count(),1)
 await page.getByRole('button',{name:'Gallery',exact:true}).click()
 assert.equal(await page.getByRole('option').count(),1)
 await page.getByRole('button',{name:'List',exact:true}).click()
 await page.getByRole('row',{name:'First twin'}).click()
 await page.getByRole('button',{name:'Open talk',exact:true}).click()
 assert.equal(await page.getByRole('dialog',{name:'Vault Gallery'}).count(),1)
 const calls=await page.evaluate(()=>window.openCalls||0)
 await page.evaluate(()=>window.deferTalk=true)
 await page.getByRole('button',{name:'Open talk',exact:true}).click()
 await page.waitForFunction(()=>!!window.releaseTalk)
 const oldGeneration=await page.evaluate(()=>window.catalogueGeneration)
 await page.evaluate(()=>{window.rootGeneration=2;window.changeRevision()})
 await page.waitForFunction(old=>window.catalogueGeneration>old,oldGeneration)
 await page.evaluate(()=>window.releaseTalk({outlinePath:'/fixture/stale-root'}))
 await page.waitForFunction(()=>!document.querySelector('button:disabled')?.textContent?.includes('Return'))
 assert.equal(await page.evaluate(()=>window.openCalls||0),calls)
 assert.match(await page.getByRole('alert').innerText(),/The vault changed while opening this talk/)
 console.log('PASS a real root change discards deferred galleryTalk before onOpen and says so')
 await page.getByRole('button',{name:/^Back( to .+)?$/}).click()
 assert.equal(await editor.inputValue(),'Dirty buffer preserved')
 assert.deepEqual(await editor.evaluate(el=>[el===window.savedEditor,el.selectionStart,el.selectionEnd,el.scrollTop===window.savedScroll]),[true,2,8,true])
 console.log('PASS mounted editor buffer, selection and scroll; folder destination; List; refused open retains gallery')
} finally {await browser?.close();rmSync(dir,{recursive:true,force:true})}
