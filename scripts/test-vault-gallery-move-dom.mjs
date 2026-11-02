// Real gallery + real talk actions: a refused move keeps scope and row; accepted moves land on the moved, selected row.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const home = join(root, 'evidence/vault-gallery/redesign-implementation'); mkdirSync(home, { recursive: true })
const dir = mkdtempSync(join(home, '.move-')); let browser
try {
  await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Gallery from './src/renderer/src/components/vault-gallery/VaultGallery';
    let rel='A/talk/talk-outline.md';const info=()=>({vaultId:'v',title:'Moving talk',slug:'talk',path:'/fixture/'+rel.split('/').slice(0,-1).join('/'),outlinePath:'/fixture/'+rel});
    window.events=[];
    window.tw={windows:{recoverMovedTalk:async from=>{window.events.push(['recover',from]);return {kind:'no-receipt'}},claimTalk:async()=>({ok:true})},shell:{openExternal:async()=>true},vault:{galleryInventory:async r=>({...r,state:'refused',reason:'Fixture storage unavailable',entries:[],counted:0,unreadable:0,excluded:0,allocationUnknown:0}),galleryInventoryCancel:async()=>{},onGalleryInventory:()=>()=>{},galleryCancelFacts:async()=>{},galleryFacts:async()=>null,galleryHandouts:async()=>null,galleryCatalogue:async generation=>({generation,rootGeneration:1,vaults:[{id:'v',name:'Fixture',status:'stale',talks:[{vaultId:'v',relativeOutline:rel,title:'Moving talk',slug:'talk'}]}]}),galleryTalk:async()=>info(),moveTalk:async(_,dest)=>{window.events.push(['move',dest]);if(window.refuse)return null;rel=(dest?dest+'/':'')+'talk/talk-outline.md';return info()}}};
    const m={talks:[info()],vaults:[{id:'v',root:'/fixture',name:'Fixture',open:true}],activeTalk:null,foldersByVault:{v:['A','B']},leaveActive:async()=>true,onRefresh:async()=>{},onSelectTalk:async()=>true,onDeletedTalk(){},onNewTalk(){},onAddVault(){},onEditVault(){},onSetVaultOpen:async()=>{}};
    createRoot(document.getElementById('root')).render(<Gallery revision={1} onClose={()=>{}} onOpen={async()=>false} management={m}/>)` }, outfile: join(dir, 'bundle.js'), bundle: true, platform: 'browser', jsx: 'automatic' })
  browser = await chromium.launch({ headless: true, ...(process.env.TW_HEADLESS_SHELL ? { executablePath: process.env.TW_HEADLESS_SHELL } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); const errors = []; page.on('pageerror', e => errors.push(String(e)))
  await page.setContent('<div id="root"></div>'); await page.addScriptTag({ path: join(dir, 'bundle.js') }); await page.addStyleTag({ path: join(dir, 'bundle.css') })
  const g = page.getByRole('dialog', { name: 'Vault Gallery' }), grid = g.getByRole('grid', { name: 'Talks and folders' })
  await g.getByRole('grid', { name: 'Vaults' }).getByRole('row', { name: 'Fixture' }).dblclick()
  await g.getByRole('tree').getByRole('treeitem', { name: /^A \d/ }).click()
  const row = () => grid.getByRole('row', { name: 'Moving talk' })
  await row().click()
  const move = async dest => {
    await g.getByRole('toolbar').getByRole('button', { name: 'Move', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Move talk within this vault' })
    await dialog.getByRole('option', { name: new RegExp('^' + dest) }).click()
    await dialog.getByRole('button', { name: 'Move here' }).click()
  }
  await page.evaluate(() => { window.refuse = true }); await move('B')
  await page.waitForFunction(() => window.events.some(e => e[0] === 'move'))
  assert.equal(await row().count(), 1, 'refused move keeps the row'); assert.match(await g.getByRole('navigation', { name: 'Location' }).innerText(), /A$/)
  await page.evaluate(() => { window.refuse = false }); await move('B')
  await page.waitForFunction(() => /B$/.test(document.querySelector('nav[aria-label="Location"]').innerText))
  await row().waitFor(); assert.equal(await row().getAttribute('aria-selected'), 'true')
  await move('Vault root')
  await page.waitForFunction(() => !/B$/.test(document.querySelector('nav[aria-label="Location"]').innerText))
  await row().waitFor(); assert.equal(await row().getAttribute('aria-selected'), 'true')
  assert.deepEqual(await page.evaluate(() => window.events.filter(e => e[0] === 'move').map(e => e[1])), ['B', 'B', ''])
  assert.ok(await page.evaluate(() => window.events.some(e => e[0] === 'recover')), 'the recovery check ran before the write')
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log('PASS actual gallery and talk actions: refused move preserves scope and row; sibling and root moves land on the selected moved row')
} finally { await browser?.close(); rmSync(dir, { recursive: true, force: true }) }
