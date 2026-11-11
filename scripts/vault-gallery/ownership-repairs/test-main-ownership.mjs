import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import {createGalleryClaim} from '../../../src/main/vault-gallery-open.ts'
const src=readFileSync('src/main/index.ts','utf8');const handlers=new Map();let epoch=0;
const windows=new Map([1,2].map(id=>[id,{win:{id,isDestroyed:()=>false},outlinePath:id===1?'A':null}]));const reservations=new Map(),epochs=new Map();
const claims=src.slice(src.indexOf('function claimTalkForWindow('),src.indexOf('// Refresh-in-place (⌘R)'));
const gallery=src.slice(src.indexOf('const claimGalleryTalk ='),src.indexOf('// Search rows certify'));
const holding=(path,except)=>{for(const [id,p] of reservations)if(p===path&&windows.get(id)?.win!==except)return windows.get(id).win;for(const e of windows.values())if(e.outlinePath===path&&e.win!==except)return e.win;return null};
const established=new Map();
const receipts=new Map();
let commitFault=null;
const env={slidePreviewRequests:new Map(),cancelThumbnailRender(){},cancelEditorThumbnails(){},latestThumbnailRequest:{cancel(){}},movedEditorReceipts:receipts,managementMutations:new Map(),mutationBlocks:()=>false,validMoveReceipt:()=>null,retiredMovePaths:new Map(),outlineRecovery:{save:async()=>{}},talkInfoFor:()=>null,dirname:p=>p,establishedGalleryClaims:established,vaultRegistry:{resolve:()=>commitFault==='unregistered'?null:({vault:{id:'fixture',root:'fixture',open:commitFault!=='closed'}})},vaultAvailability:{isUnavailable:()=>commitFault==='unavailable'},statSync:()=>{if(commitFault==='stat')throw Object.assign(new Error('Root disappeared'),{code:'ENOENT'});return {dev:1,ino:2}},editorWindows:windows,galleryReservations:reservations,galleryClaimEpochs:epochs,openRequests:{claimed(){}},noteAppOpen(){},otherEditorHolding:holding,bringToFront(){},outlineDiskGuard:{release(){}},ipcMain:{handle:(k,v)=>handlers.set(k,v)},createGalleryClaim,resolveGalleryTalk:async(_id,p)=>({outlinePath:p}),watchGallerySender(){}};
const js=ts.transpileModule(claims+'\n'+gallery,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const run=Function(...Object.keys(env),'getEpoch', 'let galleryEpoch=getEpoch();'+js+'; return {setEpoch:e=>galleryEpoch=e}')(...Object.values(env),()=>epoch);
const event=id=>{const mainFrame={};return {sender:{id,mainFrame},senderFrame:mainFrame}};
const claim=(id,p)=>handlers.get('vault:gallery-claim')(event(id),'v',p,epoch);const settle=(id,c)=>handlers.get('vault:gallery-settle')(event(id),c);const ordinary=(id,p)=>handlers.get('window:claim-talk')(event(id),p);
assert.equal((await claim(1,'B')).ok,true);assert.equal(reservations.get(1),'A');assert.equal(ordinary(2,'A').ok,false);assert.equal(ordinary(1,'C').ok,false,'generic claim must not discard pending reservation');
assert.equal(settle(1,false).ok,true);assert.equal(windows.get(1).outlinePath,'A');assert.equal(reservations.size,0);
await claim(1,'B');epoch++;run.setEpoch(epoch);assert.equal(settle(1,true).ok,false);assert.equal(windows.get(1).outlinePath,'A');
await claim(1,'B');assert.equal(settle(1,true).ok,true);assert.equal(ordinary(2,'A').ok,true);assert.equal(epochs.get(1),epoch,'committed authority remains epoch bound');
ordinary(2,null);ordinary(1,'A');await claim(1,'B');
windows.get(2).outlinePath='A';assert.throws(()=>settle(1,false),/could not be restored/);assert.equal(reservations.get(1),'A','refused recovery retains reservation and blocks saves');windows.get(2).outlinePath=null;assert.equal(settle(1,false).ok,true);
receipts.set(1,{settled:false});assert.equal(ordinary(1,null).ok,false,'pending exact move receipt holds outgoing editor');assert.equal(ordinary(1,'C').ok,false,'pending receipt refuses another selection');receipts.get(1).settled=true;assert.equal(ordinary(1,'C').ok,true,'settled receipt permits normal ownership');receipts.delete(1);
for (const fault of ['unavailable','closed','unregistered','stat']) {
  ordinary(1,'A'); await claim(1,'B'); commitFault=fault;
  assert.equal(settle(1,true).ok,false,`${fault}: final commit refuses`);
  assert.equal(windows.get(1).outlinePath,'A',`${fault}: outgoing talk restored`);
  assert.equal(reservations.has(1),false,`${fault}: no pending reservation blocks saving`);
  assert.equal(epochs.has(1),false,`${fault}: no stale claim epoch`);
  commitFault=null;
  assert.equal(ordinary(1,'A').ok,true,`${fault}: ordinary claims work after refusal`);
  await claim(1,'B'); assert.equal(settle(1,true).ok,true,`${fault}: retry commits once`);
}
console.log('PASS final settlement failures restore outgoing ownership and clear reservation/epoch for unavailable, closed, unregistered and vanished roots');
windows.delete(1);assert.equal((await claim(1,'C')).ok,false,'destroyed sender must not create a reservation');assert.equal(reservations.size,0);
console.log('PASS actual main claim/settlement glue: two windows, outgoing reservation, generic refusal, abandon, stale commit rollback, commit and destroyed sender');

// A normal close must use the existing awaited renderer flush, even without an external-change sheet.
const closeSource=src.slice(src.indexOf("  win.on('close', (event) => {"),src.indexOf("  win.on('closed', () => {"));
const closeEvents=new Map(),sent=[],confirmed=new Set(),closeWindows=new Map([[7,{outlinePath:'A'}]]);
Function('win','outlineDiskGuard','editorWindows','wcId','closeConfirmed','movedEditorReceipts','quitting','quittingTimer','closeHolds','clearTimeout','setTimeout','canonicalOutlinePath','lastUnsavedText','outlineRecovery','app',ts.transpileModule(closeSource,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText)(
 {on:(name,fn)=>closeEvents.set(name,fn),webContents:{send:(...args)=>sent.push(args)}},
 {pendingFor:()=>null},closeWindows,7,confirmed,new Map(),false,null,new Map(),()=>{},()=>1,p=>p,new Map(),{},{}
);
let prevented=0;closeEvents.get('close')({preventDefault:()=>prevented++});
assert.equal(prevented,1,'ordinary active editor close waits for its pending text to flush');
assert.equal(sent[0]?.[0],'outline:close-requested');
confirmed.add(7);closeEvents.get('close')({preventDefault:()=>prevented++});assert.equal(prevented,1,'confirmed close proceeds');
confirmed.clear();closeWindows.get(7).outlinePath=null;closeEvents.get('close')({preventDefault:()=>prevented++});assert.equal(prevented,1,'empty editor closes without waiting');
console.log('PASS actual close listener: active editor waits for renderer flush, confirmed/empty windows close normally');

const lifecycle=src.slice(src.indexOf('const gallerySenders ='),src.indexOf('let galleryEpoch ='));
const listeners=new Map();const sender={id:9,once:(name,cb)=>listeners.set(name,cb)};let cancelled=0;
const lifecycleJS=ts.transpileModule(lifecycle,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const watch=Function('establishedGalleryClaims','revokeGalleryReads','galleryAdmission','galleryReservations','galleryClaimEpochs',lifecycleJS+';return watchGallerySender')(established,()=>{},{cancel:id=>{assert.equal(id,9);cancelled++}},reservations,epochs);
reservations.set(9,'A');epochs.set(9,0);watch(sender);watch(sender);listeners.get('destroyed')();assert.equal(cancelled,1);assert.equal(reservations.has(9),false);assert.equal(epochs.has(9),false);console.log('PASS actual sender destruction hook clears reservations, epochs and queued admission once');
// The actual save-handler closure feeds the real writer while a disk lock is held.
const {mkdirSync,writeFileSync,rmSync}=await import('node:fs');const {resolve}=await import('node:path');
const {configureTalkWriter,writeTalkOutline,withTalkFileLock}=await import('../../../src/main/talk-writer.ts');
const root=resolve('scripts/vault-gallery/ownership-repairs/main-write-fixture');mkdirSync(root,{recursive:true});const path=resolve(root,'outline.md');
try {
writeFileSync(path,'# Original');windows.set(1,{win:{id:1,isDestroyed:()=>false},outlinePath:path});epochs.set(1,epoch);
const save=src.split("ipcMain.handle('talk:write-outline', async (_event, outlinePath: string, content: string) => {")[1].split('  const claimEpoch =')[0];
const saveJS=ts.transpileModule(save,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const authority=Function('movedEditorReceipts','retiredMovePaths','renewEstablishedGalleryClaims','establishedGalleryClaims','_event','outlinePath','galleryEpoch','editorWindows','galleryReservations','galleryClaimEpochs','outlineIdentity','otherEditorHolding',saveJS+';return authorize')(receipts,new Map(),()=>{},new Map(),{sender:{id:1,isDestroyed:()=>false}},path,epoch,windows,reservations,epochs,p=>({key:p}),holding);
configureTalkWriter({editorBufferFor:()=>null});let release,entered;const ready=new Promise(r=>entered=r);const lock=withTalkFileLock(path,async()=>{entered();await new Promise(r=>release=r)});await ready;
const pending=writeTalkOutline(path,'# Unsafe','editor',{authorize:authority});epochs.set(1,epoch-1);release();await lock;assert.equal((await pending).ok,false);assert.equal(readFileSync(path,'utf8'),'# Original');
console.log('PASS actual main save authority plus actual writer: delayed renderer notification cannot save under revoked main epoch; bytes unchanged');
epochs.set(1,epoch);let releaseMove,enteredMove;const moveReady=new Promise(r=>enteredMove=r);const moveLock=withTalkFileLock(path,async()=>{enteredMove();await new Promise(r=>releaseMove=r)});await moveReady;const staleMove=writeTalkOutline(path,'# Stale old buffer','editor',{authorize:authority});receipts.set(1,{from:path,to:path+'.moved',settled:false});releaseMove();await moveLock;assert.equal((await staleMove).ok,false);assert.equal(readFileSync(path,'utf8'),'# Original');receipts.delete(1);console.log('PASS actual final writer lock refuses a receipt acquired after the old save queued; original bytes unchanged');
} finally {rmSync(root,{recursive:true,force:true})}
