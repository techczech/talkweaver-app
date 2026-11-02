// Fixture for the vault browser repair tests: main-shaped behaviour with deferred scan IO.
// - inventory answers from a tree like main does (non-recursive lists direct children, recursive lists everything below),
//   can be held (ctl.holdRecursive) and then released, and emits running progress carrying only entries visited so far;
// - facts and handouts go through an admission that resolves held work to null once cancelled, like main;
// - writes (move, folder rename/delete/create) are recorded and can be held; windows.recoverMovedTalk answers no-receipt.
const folders = ['Work', 'Work/sub', 'Archive', 'Teaching seminars 2026', 'handout-data', 'assets']
const talks = [['', 'welcome', 'Welcome'], ['Work', 'alpha', 'Alpha talk'], ['Work', 'beta', 'Beta talk'], ['Work', 'gamma', 'Gamma talk'], ['Work/sub', 'nested', 'Nested talk'], ['Archive', 'old', 'Old talk'], ['Teaching seminars 2026', 'seminar', 'Seminar one']]
export const SPEC = { folders, talks }
export const fixtureSource = `
const SPEC=${JSON.stringify(SPEC)};
const rootOf={a:'/fixture/library',b:'/fixture/other',c:'/fixture/past',d:'/Volumes/Offline/Talks'};
const mk=v=>SPEC.talks.map(([f,s,t])=>({vaultId:v,relativeOutline:(f?f+'/':'')+s+'/'+s+'-outline.md',title:t,slug:s}));
const calls=window.calls={catalogue:0,facts:[],inv:[],handouts:[],listTalks:0,refresh:0,recheck:0,talk:[],open:[],claim:[],recover:[],cancelInv:[],cancelFacts:0,writes:[],setOpen:null,editVault:null,newTalk:null};
const ctl=window.ctl={rootGen:7,tree:{},holdRecursive:false,held:[],release:null,progress:null,holdTalk:false,holdMove:false,factsNull:new Set(),inv:null,epoch:0};
const admit=load=>{const e=ctl.epoch;return Promise.resolve().then(load).then(v=>e===ctl.epoch?v:null)};
const result=(r,over)=>{const prefix=r.relativePath?r.relativePath+'/':'';
 const entries=Object.entries(ctl.tree).filter(([p])=>p.startsWith(prefix)&&(r.recursive||!p.slice(prefix.length).includes('/'))).map(([relativePath,e])=>({relativePath,logical:null,allocated:null,kind:'file',...e}));
 return {...r,rootIdentity:'fx',checkedAt:'2026-10-30T12:00:00Z',state:'complete',counted:entries.length,unreadable:0,excluded:0,truncated:false,logicalBytes:null,allocatedBytes:null,allocationUnknown:0,entries,...(ctl.inv?ctl.inv(r,entries):{}),...over}};
window.tw={windows:{recoverMovedTalk:async f=>{calls.recover.push(f);return {kind:'no-receipt'}},claimTalk:async p=>{calls.claim.push(p);return {ok:true}}},shell:{openExternal:async()=>true},
 vault:{
  galleryCatalogue:async generation=>{calls.catalogue++;return {generation,rootGeneration:ctl.rootGen,vaults:[
   {id:'a',name:'Library',status:'stale',talks:mk('a')},{id:'b',name:'Other vault',status:'stale',talks:mk('b').slice(0,2)},
   {id:'c',name:'Past workshops',status:'closed',talks:[]},{id:'d',name:'Offline drive',status:'unavailable',talks:[]}]}},
  galleryTalk:async(v,p)=>{calls.talk.push(p);if(ctl.holdTalk)await new Promise(r=>ctl.held.push(r));return {outlinePath:rootOf[v]+'/'+p,path:rootOf[v]+'/'+p.split('/').slice(0,-1).join('/'),title:'t',slug:'s',vaultId:v}},
  gallerySettle:async()=>{},galleryClaim:async()=>({ok:true}),galleryCancelFacts:async()=>{calls.cancelFacts++;ctl.epoch++},
  galleryFacts:(v,p,preview)=>admit(async()=>{calls.facts.push([v,p,preview]);if(ctl.factsNull.has(p))return null;
   const i=SPEC.talks.findIndex(t=>p.includes('/'+t[1]+'/')||p.startsWith(t[1]+'/'));
   return {revision:'r'+i,slideCount:20+i,imageCount:i,editedMs:Date.UTC(2026,9,1+i),coverUrl:preview?('data:image/svg+xml;utf8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#0f3557"/></svg>')):null,preview:preview?'ready':'pending'}}),
  galleryHandouts:(v,p)=>admit(async()=>{calls.handouts.push(p);return {status:'unpublished',records:[],partial:false,note:null}}),
  galleryInventory:r=>{calls.inv.push(r);const res=result(r);if(r.recursive&&ctl.holdRecursive)return new Promise(done=>{ctl.release=()=>done(res)});return Promise.resolve(res)},
  galleryInventoryCancel:async id=>{calls.cancelInv.push(id)},onGalleryInventory:cb=>{ctl.progress=cb;return ()=>{}},
  moveTalk:async(p,dest)=>{calls.writes.push(['move',p,dest]);if(ctl.holdMove)await new Promise(r=>ctl.held.push(r));const rel=p.replace(rootOf.a+'/','').split('/').slice(-2).join('/');const np=rootOf.a+'/'+(dest?dest+'/':'')+rel;return {outlinePath:np,path:np.split('/').slice(0,-1).join('/'),title:'moved',slug:'s',vaultId:'a'}},
  deleteFolder:async(t,v)=>{calls.writes.push(['deleteFolder',t,v]);return true},renameFolder:async(t,n,v)=>{calls.writes.push(['renameFolder',t,n,v]);return t.split('/').slice(0,-1).concat(n).join('/')},createFolder:async(n,p,v)=>{calls.writes.push(['createFolder',n,p,v]);return n},
  renameTalk:async(p,n)=>{calls.writes.push(['renameTalk',p,n]);throw Error('unused')},listTalks:async()=>{calls.listTalks++;return []}
 }};
const info=(p,v='a')=>({title:'t',slug:p.split('/').at(-2),path:rootOf[v]+'/'+p.split('/').slice(0,-1).join('/'),outlinePath:rootOf[v]+'/'+p,vaultId:v});
window.managementFixture=()=>({talks:mk('a').map(t=>info(t.relativeOutline)),vaults:[{id:'a',name:'Library',root:rootOf.a,open:true},{id:'b',name:'Other vault',root:rootOf.b,open:true},{id:'c',name:'Past workshops',root:rootOf.c,open:false},{id:'d',name:'Offline drive',root:rootOf.d,open:true,unavailable:true}],activeTalk:null,
 foldersByVault:{a:[...SPEC.folders],b:[]},leaveActive:async()=>true,onRefresh:async()=>{calls.refresh++},onRecheck:async()=>{calls.recheck++},onSelectTalk:async()=>true,onDeletedTalk:()=>{},onNewTalk:(...a)=>{calls.newTalk=a},onAddVault:()=>{},onEditVault:id=>{calls.editVault=id},onSetVaultOpen:async(id,o)=>{calls.setOpen=[id,o]}});
`
export const harnessSource = src => `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import Gallery from '${src}/renderer/src/components/vault-gallery/VaultGallery';
${fixtureSource}
const management=window.managementFixture();
function H(){const[rev,setRev]=useState(1),[open,setOpen]=useState(true);window.ctl.setRev=setRev;return <><textarea aria-label="Editor" defaultValue="Unsaved"/>{open&&<Gallery revision={rev} onClose={()=>setOpen(false)} onOpen={async t=>{window.calls.open.push(t.outlinePath);return false}} management={management}/>}</>}
createRoot(document.getElementById('root')).render(<H/>)`
