import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'
const src=fs.readFileSync('src/main/index.ts','utf8')
const renew=src.slice(src.indexOf('function renewEstablishedGalleryClaims()'),src.indexOf('function renewEstablishedGalleryClaims()')+src.slice(src.indexOf('function renewEstablishedGalleryClaims()')).indexOf('\n}\n')+2)
const pre=src.split("ipcMain.handle('talk:write-outline', async (_event, outlinePath: string, content: string) => {")[1].split('  // An outline outside')[0]
const code=ts.transpileModule(renew+'\n'+pre+'\nreturn {ok:true,authorize,advance:n=>galleryEpoch=n};',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
const claims=new Map([[1,{vaultId:'A',root:'root-A',path:'talk-A',dev:1,ino:2,revoked:false}]]),epochs=new Map([[1,0]]),reservations=new Map(),windows=new Map([[1,{win:{isDestroyed:()=>false},outlinePath:'talk-A'}]])
let open=true,ino=2,destroyed=false,competing=false,canonical='root-A'
const retiredMovePaths=new Map(),movedEditorReceipts=new Map()
const env={retiredMovePaths,movedEditorReceipts,establishedGalleryClaims:claims,galleryClaimEpochs:epochs,galleryReservations:reservations,editorWindows:windows,vaultRegistry:{get:()=>({open,root:'root-A'})},vaultAvailability:{isUnavailable:()=>false},realpathSync:()=>canonical,statSync:()=>({dev:1,ino}),otherEditorHolding:()=>competing?{}:null,outlineIdentity:p=>({key:p})}
const check=epoch=>Function('_event','outlinePath','galleryEpoch',...Object.keys(env),code)({sender:{id:1,isDestroyed:()=>destroyed}},'talk-A',epoch,...Object.values(env))
assert.equal(check(0).ok,true)
for(let i=1;i<4;i++){const save=check(i);assert.equal(save.ok,true);save.authorize();assert.equal(epochs.get(1),i)}
let save=check(4);save.advance(5);save.authorize();open=false;assert.throws(save.authorize);assert.equal(check(5).ok,false);open=true;assert.equal(check(6).ok,false,'Revoked claim must not renew')
const reset=()=>{claims.get(1).revoked=false;epochs.set(1,6);open=true;ino=2;canonical='root-A';destroyed=false;competing=false;reservations.clear()}
reset();save=check(6);ino=3;assert.throws(save.authorize)
reset();save=check(6);canonical='elsewhere';assert.throws(save.authorize)
reset();save=check(6);destroyed=true;assert.throws(save.authorize)
reset();save=check(6);competing=true;assert.throws(save.authorize)
reset();save=check(6);reservations.set(1,'outgoing');assert.throws(save.authorize)
reservations.clear();assert.equal(check(6).ok,true,'A pending reservation refusal does not revoke unchanged outgoing authority')
console.log('PASS repeated saves after unrelated registry epochs; final-boundary closure/replacement/destruction/competitor/reservation; revoked authority cannot renew')

reset();save=check(6);retiredMovePaths.set(1,new Set(['talk-A']));assert.throws(save.authorize,/Retired/)
retiredMovePaths.clear();save=check(6);movedEditorReceipts.set(1,{settled:false,to:'talk-A'});assert.throws(save.authorize,/recovered/)
movedEditorReceipts.set(1,{settled:true,to:'other'});assert.throws(save.authorize,/recovered/)
movedEditorReceipts.set(1,{settled:true,to:'talk-A'});save.authorize()
console.log('PASS retired paths and pending/wrong-destination receipts cannot save; settled exact destination can save')
