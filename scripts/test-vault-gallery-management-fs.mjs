import { tmpdir as fixtureTmpdir } from 'node:os'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import vm from 'node:vm'
import {transformSync} from 'esbuild'
const source=fs.readFileSync('src/main/index.ts','utf8')
const root=fs.mkdtempSync(path.join(fixtureTmpdir(),'tw-gallery-fs-'))
try{
 const handlers=new Map();let held=false
 const outline=path.join(root,'old/old-outline.md');fs.mkdirSync(path.dirname(outline));fs.writeFileSync(outline,'---\ntitle: Old\nhandout_url: https://fixture.invalid/old\n---\nDirty text\n')
 const context={...fs,...path,console,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},writableRootFor:()=>root,vaultRootFor:()=>root,otherEditorUnder:()=>held,otherEditorHolding:()=>held?{}:null,editorWindows:new Map(),pathSep:path.sep,resolvePath:path.resolve,canonicalOutlinePath:p=>p,outlineDiskGuard:{forget(){}},outlineRecovery:{rekey:async()=>{}},invalidateVaultCaches(){},mkdirInVault:(_,p)=>fs.mkdirSync(p,{recursive:true}),shell:{trashItem:async p=>fs.renameSync(p,path.join(root,'fixture-bin'))},talkFolderOfOutline:(_,p)=>({ok:true,path:path.dirname(p)}),siblingTalkFolder:(_,p,slug)=>({ok:true,path:path.join(path.dirname(p),slug)}),folderSlugFor:s=>s,talkPlace:p=>{const a=fs.lstatSync(path.dirname(p)),b=fs.lstatSync(p);return `${a.dev}:${a.ino}/${b.dev}:${b.ino}`},slugifyTalk:s=>s.toLowerCase().replaceAll(' ','-'),renameSlugFiles:(dir,old,slug)=>fs.renameSync(path.join(dir,old+'-outline.md'),path.join(dir,slug+'-outline.md')),findOutlineIn:dir=>path.join(dir,fs.readdirSync(dir).find(n=>n.endsWith('-outline.md'))),retitleOutline:async(p,t)=>fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('title: Old','title: '+t)),writeTalkOutline:async(p,transform)=>{fs.writeFileSync(p,transform(fs.readFileSync(p,'utf8')));return {ok:true}},talkInfoFor:dir=>({path:dir,outlinePath:path.join(dir,fs.readdirSync(dir).find(n=>n.endsWith('-outline.md')))}) ,moveTalkTargets:(_,p,topic)=>({ok:true,srcDir:path.dirname(p),destParent:path.join(root,topic),dest:path.join(root,topic,path.basename(path.dirname(p)))})}
 context.galleryReservations=new Map();context.openRequests={claimed(){}};context.noteAppOpen=()=>{};context.bringToFront=()=>{};context.outlineDiskGuard.release=()=>{};context.outlineDiskGuard.openUnder=()=>[];context.outlineDiskGuard.check=async()=>{};
 vm.createContext(context)
 vm.runInContext(transformSync(source.slice(source.indexOf("const movedEditorReceipts ="),source.indexOf("const galleryReservations =")),{loader:"ts"}).code,context)
 const claimStart=source.indexOf("function claimTalkForWindow(");vm.runInContext(transformSync(source.slice(claimStart,source.indexOf("\nipcMain.handle('window:claim-talk'",claimStart)),{loader:"ts"}).code,context)
 const transferStart=source.indexOf("function transferMovedEditor(");vm.runInContext(transformSync(source.slice(transferStart,source.indexOf("// Vault-relative path",transferStart)),{loader:"ts"}).code,context);context.establishedGalleryClaims=new Map();context.galleryClaimEpochs=new Map();
 const strip=source.slice(source.indexOf('async function stripPublishedFields('),source.indexOf('\nfunction findOutlineIn('));vm.runInContext(transformSync(strip,{loader:'ts'}).code,context)
 for(const name of ['clone-talk','rename-talk','move-talk','delete-talk']){const start=source.indexOf("ipcMain.handle('vault:"+name+"'");const end=source.indexOf('\n})',start)+3;vm.runInContext(transformSync(source.slice(start,end),{loader:'ts'}).code,context)}
 const event={sender:{id:1}}
 held=true;assert.equal((await handlers.get('vault:rename-talk')(event,outline,'Renamed')).error,'open-elsewhere');assert.equal(await handlers.get('vault:clone-talk')(event,outline,'Copy'),null);assert.equal(await handlers.get('vault:move-talk')(event,outline,'nested'),null);assert.equal(await handlers.get('vault:delete-talk')(event,outline),false);assert.equal(fs.existsSync(outline),true)
 held=false;fs.mkdirSync(path.join(root,'taken'));assert.equal((await handlers.get('vault:rename-talk')(event,outline,'Taken')).error,'target-exists');assert.equal(fs.existsSync(outline),true);const copy=await handlers.get('vault:clone-talk')(event,outline,'Copy');assert.ok(copy);assert.notEqual(copy.outlinePath,outline);assert.doesNotMatch(fs.readFileSync(copy.outlinePath,'utf8'),/handout_url/);assert.match(fs.readFileSync(outline,'utf8'),/handout_url/)
 fs.mkdirSync(path.join(root,'nested/old'),{recursive:true});assert.equal(await handlers.get('vault:move-talk')(event,outline,'nested'),null);assert.equal(fs.existsSync(outline),true);fs.rmSync(path.join(root,'nested/old'),{recursive:true})
 const renamed=await handlers.get('vault:rename-talk')(event,copy.outlinePath,'Renamed');assert.ok(renamed);assert.equal(fs.existsSync(copy.outlinePath),false);assert.match(fs.readFileSync(renamed.outlinePath,'utf8'),/Dirty text/);
 const moved=await handlers.get('vault:move-talk')(event,outline,'nested');assert.equal(fs.existsSync(outline),false);assert.match(fs.readFileSync(moved.outlinePath,'utf8'),/Dirty text/)
 assert.equal(await handlers.get('vault:delete-talk')(event,moved.outlinePath),true);assert.equal(fs.existsSync(moved.outlinePath),false);assert.match(fs.readFileSync(path.join(root,'fixture-bin/old-outline.md'),'utf8'),/Dirty text/)
 console.log('PASS actual extracted main handlers on owned filesystem fixtures: owner refusal before copy/move/Bin, distinct unpublished duplicate, collision preserves source, move preserves bytes, recoverable Bin fixture')
}finally{fs.rmSync(root,{recursive:true,force:true})}
