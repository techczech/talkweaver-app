// Qualification only: real hidden Electron, production IPC, disposable checkout fixtures.
import assert from 'node:assert/strict'
import {_electron as electron} from 'playwright'
import * as fs from 'node:fs'
import {resolve,join} from 'node:path'
import {createHash} from 'node:crypto'
const repo=resolve('.'),out=join(repo,'evidence/vault-gallery/final-electron-qualification'),fixture=fs.mkdtempSync(join(out,'fixture-')),vault=join(fixture,'vault'),home=join(fixture,'home'),ud=join(fixture,'userData'),trash=join(fixture,'trash');let app,page;const rows=[]
for(const p of [vault,home,ud,trash,join(fixture,'tmp')])fs.mkdirSync(p,{recursive:true})
fs.cpSync(join(repo,'e2e/fixtures/slide-set-aside'),join(vault,'target'),{recursive:true})
fs.writeFileSync(join(ud,'config.json'),JSON.stringify({vaultRoot:vault,editorViewMode:'markdown'}))
const record=async(name,fn)=>{try{const detail=await fn();rows.push({name,state:'pass',detail});console.log('PASS',name)}catch(e){rows.push({name,state:'failed',error:String(e),stack:e.stack});console.error('FAIL',name,e)}}
const recovery=path=>{const dir=join(ud,'recovery'),index=JSON.parse(fs.readFileSync(join(dir,'index.json'),'utf8')),entry=Object.values(index).find(e=>e.path===path);return entry?{text:fs.readFileSync(join(dir,entry.file),'utf8'),file:entry.file}:null}
const invoke=(group,method,...args)=>page.evaluate(({group,method,args})=>window.tw[group][method](...args),{group,method,args})
try{
 const env={...process.env,HOME:home,CFFIXED_USER_HOME:home,TMPDIR:join(fixture,'tmp'),TMP:join(fixture,'tmp'),TEMP:join(fixture,'tmp'),XDG_CACHE_HOME:join(fixture,'cache'),XDG_CONFIG_HOME:join(fixture,'config'),NODE_COMPILE_CACHE:join(fixture,'compile-cache'),TW_E2E:'1',TW_REC_TEST:'1',TW_E2E_TRASH_DIR:trash};delete env.ELECTRON_RUN_AS_NODE
 app=await electron.launch({args:['.',`--user-data-dir=${ud}`,'--use-mock-keychain'],cwd:repo,env});page=await app.firstWindow();page.setDefaultTimeout(12000)
 assert.equal(await app.evaluate(({app})=>app.getPath('userData')),ud);assert(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible())))
 await app.evaluate(async ({shell},{vault,trash})=>{const fs=process.getBuiltinModule('fs');shell.trashItem=async path=>{if(!path.startsWith(vault+'/'))throw Error('Fixture Trash boundary');fs.renameSync(path,trash+'/'+Date.now()+'-'+path.split('/').pop())}},{vault,trash})
 await page.route('http://**',route=>route.abort());await page.route('https://**',route=>route.abort())
 await page.locator('[data-talk-slug="target"]').first().dblclick();await page.locator('.cm-content').waitFor()
 await page.locator('.cm-content').click();await page.keyboard.press('Meta+End');await page.keyboard.type(' FINAL LATEST TYPED TEXT');
 const from=join(vault,'target/target-outline.md');let moved
 await record('actual active move produces recoverable receipt and preserves current editor via production recovery event',async()=>{
  assert(await invoke('vault','createFolder','Destination'));moved=await invoke('vault','moveTalk',from,'Destination');assert(moved?.outlinePath)
  const receipt=await invoke('windows','recoverMovedTalk',from);assert.equal(receipt.kind,'recoverable')
  const answer=await page.evaluate(from=>new Promise(done=>window.dispatchEvent(new CustomEvent('tw-preserve-moved-editor',{detail:{from,done}}))),from);assert.equal(answer,true)
  const copy=recovery(moved.outlinePath);assert(copy?.text.includes('FINAL LATEST TYPED TEXT'));fs.writeFileSync(join(out,'preserved-recovery.json'),JSON.stringify(copy,null,2));return {from,to:moved.outlinePath,receipt}
 })
 await record('real retirement copies latest protected buffer, retires receipt and refuses destination save',async()=>{
  assert(moved?.outlinePath);const answer=await page.evaluate(from=>new Promise(done=>window.dispatchEvent(new CustomEvent('tw-retire-moved-editor',{detail:{from,retire:true,done}}))),from);assert.equal(answer,true)
  const copy=recovery(moved.outlinePath);assert(copy?.text.includes('FINAL LATEST TYPED TEXT'));fs.writeFileSync(join(out,'retired-recovery.json'),JSON.stringify(copy,null,2))
  const before=fs.readFileSync(moved.outlinePath,'utf8'),save=await invoke('talk','writeOutline',moved.outlinePath,'UNAUTHORISED OVERWRITE');assert.notEqual(save?.ok,true);assert.equal(fs.readFileSync(moved.outlinePath,'utf8'),before);return {receipt:await invoke('windows','recoverMovedTalk',from),save}
 })
 await record('real create rename duplicate Bin plus collision refusal under fixture Trash',async()=>{
  const t=await invoke('vault','createTalk',{title:'Qualification',slug:'qualification'});assert(t?.outlinePath)
  const renamed=await invoke('vault','renameTalk',t.outlinePath,'Renamed qualification');assert(renamed?.outlinePath);assert(!fs.existsSync(t.outlinePath))
  const clone=await invoke('vault','cloneTalk',renamed.outlinePath,'Qualification copy');assert(clone?.outlinePath)
  const refusal=await invoke('vault','renameTalk',clone.outlinePath,'Renamed qualification');assert(!refusal || refusal.error);assert(fs.existsSync(clone.outlinePath))
  const before=fs.readdirSync(trash);assert.equal(await invoke('vault','deleteTalk',clone.outlinePath),true);assert(!fs.existsSync(clone.outlinePath));assert(fs.readdirSync(trash).length>before.length);return {renamed,clone,refusal,trash:fs.readdirSync(trash)}
 })
 const catalogue=await invoke('vault','galleryCatalogue',100);const id=catalogue.vaults[0].id;let gen=10000
 await record('native inventory cancellation with actual utility process',async()=>{
  for(let i=0;i<400;i++){const d=join(vault,'bulk',String(i));fs.mkdirSync(d,{recursive:true});fs.writeFileSync(join(d,'data.txt'),'fixture')}
  const result=await page.evaluate(async({id,generation})=>{const pending=window.tw.vault.galleryInventory({vaultId:id,relativePath:'',generation,recursive:true,confirmedRoot:true});await window.tw.vault.galleryInventoryCancel(generation);return pending},{id,generation:gen++});assert.equal(result.state,'cancelled');return result
 })
 await record('unavailable root inventory and revoked receipt reject access',async()=>{
  fs.renameSync(vault,vault+'-offline');try{await invoke('vault','recheck');const result=await invoke('vault','galleryInventory',{vaultId:id,relativePath:'',generation:gen++,recursive:true,confirmedRoot:true});assert(['unavailable','refused'].includes(result.state));const receipt=await invoke('windows','recoverMovedTalk',from);assert(['revoked','no-receipt'].includes(receipt.kind));return {result,receipt}}finally{fs.renameSync(vault+'-offline',vault);await invoke('vault','recheck')}
 })
 await record('empty folder and narrow keyboard gallery focus',async()=>{
  assert(await invoke('vault','createFolder','Empty qualification'));assert((await invoke('vault','listFolders')).includes('Empty qualification'))
  await page.evaluate(()=>window.dispatchEvent(new Event('tw-vault-gallery')));await page.getByRole('dialog',{name:'Vault Gallery',exact:true}).waitFor();await page.setViewportSize({width:390,height:844});await page.keyboard.press('Tab');const focus=await page.evaluate(()=>({tag:document.activeElement.tagName,text:document.activeElement.textContent?.slice(0,120),inside:!!document.activeElement.closest('.vault-gallery')}));assert(focus.inside);assert(await page.locator('.vault-gallery').evaluate(e=>e.scrollWidth<=e.clientWidth));return focus
 })
}finally{
 // Preserve every recovery file and its hash before deleting this run's fixture.
 const snapshots=[];const walk=p=>{if(!fs.existsSync(p))return;for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=join(p,e.name);if(e.isDirectory())walk(f);else snapshots.push({path:f.slice(fixture.length+1),sha256:createHash('sha256').update(fs.readFileSync(f)).digest('hex'),content:fs.readFileSync(f,'utf8')})}};walk(join(ud,'recovery'));fs.writeFileSync(join(out,'all-recovery-readback.json'),JSON.stringify(snapshots,null,2));fs.writeFileSync(join(out,'electron-results.json'),JSON.stringify(rows,null,2));if(app)await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app?.close().catch(()=>{});fs.rmSync(fixture,{recursive:true,force:true})
}
if(rows.some(r=>r.state==='failed'))process.exitCode=1
