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
const record=async(name,fn)=>{if(process.env.QUAL_FILTER && !name.includes(process.env.QUAL_FILTER))return;try{const detail=await fn();rows.push({name,state:'pass',detail});console.log('PASS',name)}catch(e){rows.push({name,state:'failed',error:String(e),stack:e.stack});console.error('FAIL',name,e)}}
const recovery=path=>{const dir=join(ud,'recovery'),index=JSON.parse(fs.readFileSync(join(dir,'index.json'),'utf8')),entry=Object.values(index).find(e=>e.path===path);return entry?{text:fs.readFileSync(join(dir,entry.file),'utf8'),file:entry.file}:null}
const invoke=(group,method,...args)=>page.evaluate(({group,method,args})=>window.tw[group][method](...args),{group,method,args})
try{
 const env={...process.env,HOME:home,CFFIXED_USER_HOME:home,TMPDIR:join(fixture,'tmp'),TMP:join(fixture,'tmp'),TEMP:join(fixture,'tmp'),XDG_CACHE_HOME:join(fixture,'cache'),XDG_CONFIG_HOME:join(fixture,'config'),NODE_COMPILE_CACHE:join(fixture,'compile-cache'),TW_E2E:'1',TW_REC_TEST:'1',TW_E2E_TRASH_DIR:trash};delete env.ELECTRON_RUN_AS_NODE
 app=await electron.launch({args:['.',`--user-data-dir=${ud}`,'--use-mock-keychain'],cwd:repo,env});page=await app.firstWindow();page.setDefaultTimeout(12000)
 assert.equal(await app.evaluate(({app})=>app.getPath('userData')),ud);assert(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().every(w=>!w.isVisible())))
 await app.evaluate(async ({shell},{vault,trash})=>{const fs=process.getBuiltinModule('fs');shell.trashItem=async path=>{if(globalThis.qualificationRefuseTrash)throw Error('qualification Trash transport refusal');if(!path.startsWith(vault+'/'))throw Error('Fixture Trash boundary');fs.renameSync(path,trash+'/'+Date.now()+'-'+path.split('/').pop())}},{vault,trash})
 await page.route('http://**',route=>route.abort());await page.route('https://**',route=>route.abort())
 await page.locator('[data-talk-slug="target"]').first().dblclick();await page.locator('.cm-content').waitFor()
 await page.locator('.cm-content').click();await page.keyboard.press('Meta+End');await page.keyboard.type(' FINAL LATEST TYPED TEXT');
 const from=join(vault,'target/target-outline.md');let moved

 const cat=await invoke('vault','galleryCatalogue',101),id=cat.vaults[0].id
 await record('known Talk and exact-source Run handouts through actual IPC; local source preview',async()=>{
  const file=join(vault,'target/target-outline.md');fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('outline_version: 2','outline_version: 2\nhandout_url: https://example.invalid/talk/'))
  const runs=join(vault,'_PRESENTATIONS/target');fs.mkdirSync(runs,{recursive:true});for(const [runId,sourceOutline] of [['exact','target/target-outline.md'],['other','elsewhere/target-outline.md']])fs.writeFileSync(join(runs,runId+'.json'),JSON.stringify({id:runId,talkSlug:'target',talkTitle:'Set aside fixture',status:'delivered',kind:'delivery',sourceOutline,handoutUrl:'https://example.invalid/'+runId+'/',slideSet:{kind:'full'}}))
  const handouts=await invoke('vault','galleryHandouts',id,'target/target-outline.md');assert(handouts);assert(handouts.records.some(r=>r.unpublish?.runId==='exact'));assert(!handouts.records.some(r=>r.unpublish?.runId==='other'))
  const facts=await invoke('vault','galleryFacts',id,'target/target-outline.md',true);assert(facts?.revision);assert(facts.slideCount>0);return {handouts,facts}
 })
 await record('lost retirement acknowledgement keeps protected buffer; retry preserves same latest text and refuses stale save',async()=>{
  assert(await invoke('vault','createFolder','Destination'));moved=await invoke('vault','moveTalk',from,'Destination');assert(moved?.outlinePath)
  await app.evaluate(({ipcMain})=>{const handlers=ipcMain._invokeHandlers,key='window:retire-moved-talk',original=handlers.get(key);handlers.set(key,async(...args)=>{handlers.set(key,original);await original(...args);throw Error('qualification lost acknowledgement after real retirement')})})
  const retire=()=>page.evaluate(from=>new Promise(done=>window.dispatchEvent(new CustomEvent('tw-retire-moved-editor',{detail:{from,retire:true,done}}))),from)
  assert.equal(await retire(),false);const text=await page.locator('.cm-content').innerText();await page.locator('.cm-content').click();await page.keyboard.type('MUST NOT ENTER');assert.equal(await page.locator('.cm-content').innerText(),text)
  assert(recovery(moved.outlinePath)?.text.includes('FINAL LATEST TYPED TEXT'));assert.equal(await retire(),true);const before=fs.readFileSync(moved.outlinePath,'utf8'),save=await invoke('talk','writeOutline',moved.outlinePath,before+'\nSTALE VALID OUTLINE');assert.notEqual(save?.ok,true);assert.equal(fs.readFileSync(moved.outlinePath,'utf8'),before);return {save,recovery:recovery(moved.outlinePath)}
 })
 await record('actual storage utility killed before completion returns partial coverage',async()=>{
  await app.evaluate(({utilityProcess})=>{const original=utilityProcess.fork;utilityProcess.fork=function(...args){const child=original.apply(this,args);if(String(args[0]).includes('vault-gallery-inventory-worker')){utilityProcess.fork=original;setTimeout(()=>child.kill(),0)}return child}})
  const result=await invoke('vault','galleryInventory',{vaultId:id,relativePath:'',generation:19999,recursive:true,confirmedRoot:true});assert.equal(result.state,'partial');return result
 })
 await record('Bin cancellation and transport refusal preserve actual fixture bytes',async()=>{
  await page.evaluate(()=>window.dispatchEvent(new Event('tw-vault-gallery')));await page.getByRole('button',{name:'Show all talks'}).click();await page.locator('.vg-select').first().click()
  const before=fs.readFileSync(from,'utf8');await page.getByRole('button',{name:'Move talk to Bin',exact:true}).click();await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(fs.readFileSync(from,'utf8'),before)
  const created=await invoke('vault','createTalk',{title:'Refusal',slug:'refusal'});assert(created?.outlinePath);const bytes=fs.readFileSync(created.outlinePath,'utf8');await app.evaluate(()=>{globalThis.qualificationRefuseTrash=true});try{assert.equal(await invoke('vault','deleteTalk',created.outlinePath),false);assert.equal(fs.readFileSync(created.outlinePath,'utf8'),bytes)}finally{await app.evaluate(()=>{globalThis.qualificationRefuseTrash=false})}return {cancelled:from,refused:created.outlinePath}
 })
 await record('recovery adoption through real gallery selection preserves latest typed text and destination saves',async()=>{
  assert(await invoke('vault','createFolder','Destination'));moved=await invoke('vault','moveTalk',from,'Destination');assert(moved?.outlinePath)
  await page.evaluate(()=>window.dispatchEvent(new Event('tw-vault-gallery')));await page.getByRole('button',{name:'Show all talks'}).click();await page.getByRole('button',{name:'Open talk',exact:true}).first().click();await page.locator('.cm-content').waitFor();await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent.includes('Alpha'));fs.writeFileSync(join(out,'adopted-editor.txt'),await page.locator('.cm-content').innerText());fs.writeFileSync(join(out,'adopted-disk.md'),fs.readFileSync(moved.outlinePath,'utf8'));assert((await page.locator('.cm-content').innerText()).includes('FINAL LATEST TYPED TEXT'));await page.locator('.cm-content').click();await page.keyboard.press('Meta+End');await page.keyboard.type(' ADOPTION SAVED');await page.keyboard.press('Meta+s');await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent.includes('ADOPTION SAVED'));await new Promise(r=>setTimeout(r,1200));assert(fs.readFileSync(moved.outlinePath,'utf8').includes('ADOPTION SAVED'));return {moved,recovery:recovery(moved.outlinePath)}
 })
 await record('closed root inventory refuses traversal',async()=>{
  const second=join(fixture,'second-vault');fs.mkdirSync(second);const add=await invoke('vault','add',second);assert(add?.ok);const close=await invoke('vault','setOpen',id,false);assert(close.ok);const result=await invoke('vault','galleryInventory',{vaultId:id,relativePath:'',generation:20000,recursive:true,confirmedRoot:true});assert.equal(result.state,'unavailable');return result
 })
}finally{
 // Preserve every recovery file and its hash before deleting this run's fixture.
 const snapshots=[];const walk=p=>{if(!fs.existsSync(p))return;for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=join(p,e.name);if(e.isDirectory())walk(f);else snapshots.push({path:f.slice(fixture.length+1),sha256:createHash('sha256').update(fs.readFileSync(f)).digest('hex'),content:fs.readFileSync(f,'utf8')})}};walk(join(ud,'recovery'));fs.writeFileSync(join(out,process.env.QUAL_FILTER?(process.env.QUAL_FILTER.includes('adoption')?'adoption-recovery-readback.json':'bin-recovery-readback.json'):'supplemental-recovery-readback.json'),JSON.stringify(snapshots,null,2));fs.writeFileSync(join(out,process.env.QUAL_FILTER?(process.env.QUAL_FILTER.includes('adoption')?'adoption-results.json':'bin-results.json'):'supplemental-results.json'),JSON.stringify(rows,null,2));if(app)await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app?.close().catch(()=>{});fs.rmSync(fixture,{recursive:true,force:true})
}
if(rows.some(r=>r.state==='failed'))process.exitCode=1
