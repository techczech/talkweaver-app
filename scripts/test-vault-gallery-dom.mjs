import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
const root=resolve(import.meta.dirname,'..')
mkdirSync(join(root,'evidence/vault-gallery/redesign-repairs/layout-completion'),{recursive:true})
const dir=mkdtempSync(join(root,'evidence/vault-gallery/redesign-repairs/.dom-'))
let browser
try {
 await build({stdin:{resolveDir:root,loader:'tsx',contents:`
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import Gallery from './src/renderer/src/components/vault-gallery/VaultGallery';
 window.tw={vault:{galleryInventory:async request=>({...request,state:'refused',reason:'Fixture storage unavailable',entries:[],counted:0,unreadable:0,excluded:0,allocationUnknown:0}),galleryInventoryCancel:async()=>{},onGalleryInventory:()=>()=>{},galleryCatalogue:async generation=>({generation,vaults:[{id:'a',name:'First',status:'stale',talks:[{vaultId:'a',relativeOutline:'Work/twin/twin-outline.md',title:'First twin',slug:'twin'}]},{id:'b',name:'Second',status:'closed',talks:[]}]}),galleryTalk:async()=>({outlinePath:'/fixture/a/Work/twin/twin-outline.md'})}};
 function Harness(){const[open,setOpen]=useState(false);return <><textarea aria-label="Editor" defaultValue="Unsaved text"/><button onClick={()=>setOpen(true)}>Browse</button>{open&&<Gallery revision={1} onClose={()=>setOpen(false)} onOpen={async()=>false}/>}</>};createRoot(document.getElementById('root')).render(<Harness/>);
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
 await page.screenshot({path:join(root,'evidence/vault-gallery/redesign-repairs/layout-overview.png')})
 await page.setViewportSize({width:390,height:844})
 await page.waitForFunction(()=>{const g=document.querySelector('.vault-gallery');return g.clientWidth===390&&g.scrollWidth<=390})
 await page.getByRole('button',{name:'Show all talks'}).click()
 await page.getByRole('button',{name:'Folders',exact:true}).click();await page.getByRole('tree').getByRole('treeitem',{name:/Work/}).click()
 assert.match(await page.getByRole('navigation',{name:'Location'}).innerText(),/Work/)
 await page.screenshot({path:join(root,'evidence/vault-gallery/redesign-repairs/layout-folder-narrow.png')})
 await page.getByRole('row',{name:'First twin'}).click()
 await page.getByRole('button',{name:'Open talk',exact:true}).click()
 assert.equal(await page.getByRole('dialog').count(),1)
 await page.getByRole('button',{name:'Return to talk'}).click()
 assert.equal(await editor.inputValue(),'Dirty buffer preserved')
 assert.deepEqual(await editor.evaluate(el=>[el===window.savedEditor,el.selectionStart,el.selectionEnd,el.scrollTop===window.savedScroll]),[true,2,8,true])
 console.log('PASS mounted editor buffer, selection and scroll; folder destination; List; refused open retains gallery')
} finally {await browser?.close();rmSync(dir,{recursive:true,force:true})}
