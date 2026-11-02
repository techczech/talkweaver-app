// Fixture for the vault browser's final DOM tests. It began as the independent review fixture and now belongs to these tests.
// Main behaviour it models: admission cancellation resolving held replies to null (vault-gallery-admission.ts); running-state inventory
// progress carrying only the entries visited so far (vault-gallery-inventory.ts emit()); one inventory job per window, where a new start
// cancels the running job, a stale generation is refused and a cancelled job really resolves (vault-gallery-storage.ts); native directory
// kinds (native/vault-gallery.swift); held handouts; and folder renames that reach the catalogue.
const folders = ['Work', 'Work/sub', 'Work/sub/level-3/level-4/level-5', 'Teaching seminars 2026', 'Long running research methods reading group and associated workshop material', 'handout-data', 'Archive', 'Public lectures', 'Staff development', 'Student skills', 'Conference keynotes', 'Library sessions', 'Departmental away days', 'Summer schools', 'Winter schools', 'Pilot projects', 'Evaluation', 'Old imports']
const titles = ['Alpha talk', 'Beta talk', 'Gamma talk with a very long title about how a department redesigns assessment after generative AI arrived in every seminar room', 'Delta']
const talks = []
const add = (folder, slug, title) => talks.push([folder, slug, title])
add('', 'welcome', 'Welcome to the review vault'); add('', 'scratch', 'Scratch space')
add('Work', 'alpha', titles[0]); add('Work', 'beta', titles[1]); add('Work', 'gamma', titles[2]); add('Work', 'delta', titles[3])
add('Work/sub', 'nested', 'Nested talk'); add('Work/sub/level-3/level-4/level-5', 'deep-one', 'Same leaf'); add('Archive', 'deep-one', 'Same leaf')
folders.slice(3).forEach((f, i) => { for (let n = 0; n < 2 + (i % 4); n++) add(f, `t${i}-${n}`, `${f} session ${n + 1}`) })
export const SPEC = { folders, talks }
export const fixtureSource = `
const SPEC=${JSON.stringify(SPEC)};
const rootOf={a:'/fixture/review-library',b:'/fixture/other-vault',c:'/fixture/past',d:'/Volumes/Offline/Talks'};
const mk=v=>SPEC.talks.map(([f,s,t])=>({vaultId:v,relativeOutline:(f?f+'/':'')+s+'/'+s+'-outline.md',title:t,slug:s}));
const calls=window.calls={catalogue:0,facts:[],inv:[],handouts:[],listTalks:0,refresh:0,talk:[],open:[],claim:[],recover:[],cancelInv:[],cancelFacts:0,writes:[],maxActive:0,settled:0};
const ctl=window.ctl={rootGen:7,tree:{},holdRecursive:false,holdPreview:false,held:[],heldFacts:new Map(),factsNull:new Set(),bypassCancel:false,hash:s=>[...s].reduce((a,c)=>a+c.charCodeAt(0),0)};
let epoch=0,active=0;
const admit=load=>{const e=epoch;active++;calls.maxActive=Math.max(calls.maxActive,active);return Promise.resolve().then(load).then(v=>{active--;return (e===epoch||ctl.bypassCancel)?v:null})};
const invResult=r=>{const base={...r,rootIdentity:'fx',checkedAt:'2026-10-30T12:00:00Z',state:'complete',counted:0,unreadable:0,excluded:0,truncated:false,logicalBytes:null,allocatedBytes:null,allocationUnknown:0,entries:[]};
 const out=ctl.inv?ctl.inv(r,base):null;if(out)return out;
 const prefix=r.relativePath?r.relativePath+'/':'';
 base.entries=Object.entries(ctl.tree).filter(([p])=>p.startsWith(prefix)&&(r.recursive||!p.slice(prefix.length).includes('/'))).map(([relativePath,e])=>({relativePath,logical:null,allocated:null,...e}));
 return base};
window.tw={windows:{recoverMovedTalk:async f=>{calls.recover.push(f);return {kind:'no-receipt'}},claimTalk:async p=>{calls.claim.push(p);return {ok:true}}},shell:{openExternal:async()=>true},
 vault:{
  galleryCatalogue:async generation=>{calls.catalogue++;epoch++;return {generation,rootGeneration:ctl.rootGen,vaults:[
   {id:'a',name:'Review Library',status:'stale',talks:mk('a')},{id:'b',name:'Other vault',status:'stale',talks:mk('b').slice(0,3)},
   {id:'c',name:'Past workshops',status:'closed',talks:[]},{id:'d',name:'Offline drive',status:'unavailable',talks:[]}]}},
  galleryTalk:async(v,p,g)=>{calls.talk.push(p);if(ctl.holdTalk)await new Promise(r=>ctl.held.push(r));return {outlinePath:rootOf[v]+'/'+p,path:rootOf[v]+'/'+p.split('/').slice(0,-1).join('/'),title:'t',slug:'s',vaultId:v}},
  gallerySettle:async()=>{calls.settled++},galleryClaim:async()=>({ok:true}),
  galleryCancelFacts:async()=>{calls.cancelFacts++;epoch++},
  galleryFacts:(v,p,preview)=>admit(async()=>{calls.facts.push([v,p,preview,ctl.rootGen]);const gen=ctl.rootGen;
   if(ctl.factsNull.has(p))return null;
   if(ctl.heldFacts.has(p))await new Promise(r=>ctl.heldFacts.get(p).push(r));
   if(preview&&ctl.holdPreview)await new Promise(r=>ctl.held.push(r));
   const h=ctl.hash(p);const unknown=h%7===3;
   if(unknown)return {revision:null,slideCount:null,imageCount:null,editedMs:null,coverUrl:null,preview:'unavailable'};
   return {revision:'r'+gen+':'+h,slideCount:gen*100+(h%50),imageCount:h%5===0?null:h%20,editedMs:Date.UTC(2026,9,1+(h%27)),coverUrl:preview?('data:image/svg+xml;utf8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="'+['#0f3557','#fbf0e2','#e9eedd','#f4efe4'][h%4]+'"/><text x="8" y="46" font-size="8" fill="'+(h%4===0?'#fff':'#154a72')+'">gen '+gen+'</text></svg>')):null,preview:preview?'ready':'pending'}}),
  galleryHandouts:(v,p)=>admit(async()=>{calls.handouts.push(p);const h=ctl.hash(p);return h%6===0?{status:'published',partial:false,note:null,records:[{key:'k',kind:'talk',title:'H',link:'https://example.invalid/h',site:'linked',publishedAt:null,dateSource:'record'}]}:h%6===1?{status:'unknown',records:[],partial:true,note:null}:{status:'unpublished',records:[],partial:false,note:null}}),
  galleryInventory:r=>{calls.inv.push(r);const result=invResult(r);return r.recursive&&ctl.holdRecursive?new Promise(res=>{ctl.release=()=>res(result)}):Promise.resolve(result)},
  galleryInventoryCancel:async id=>{calls.cancelInv.push(id)},onGalleryInventory:cb=>{ctl.progress=cb;return ()=>{}},
  moveTalk:async(p,dest)=>{calls.writes.push(['move',p,dest]);if(ctl.holdMove)await new Promise(r=>ctl.held.push(r));const rel=p.replace(rootOf.a+'/','').split('/').slice(-2).join('/');const np=rootOf.a+'/'+(dest?dest+'/':'')+rel;return {outlinePath:np,path:np.split('/').slice(0,-1).join('/'),title:'moved',slug:'s',vaultId:'a'}},
  deleteFolder:async(t,v)=>{calls.writes.push(['deleteFolder',t,v]);return true},renameFolder:async(t,n,v)=>{calls.writes.push(['renameFolder',t,n,v]);return n},createFolder:async(n,p,v)=>{calls.writes.push(['createFolder',n,p,v]);return n},
  renameTalk:async()=>{throw Error('unused')},listTalks:async()=>{calls.listTalks++;return []}
 }};
const info=(p,v='a')=>({title:'t',slug:p.split('/').at(-2),path:rootOf[v]+'/'+p.split('/').slice(0,-1).join('/'),outlinePath:rootOf[v]+'/'+p,vaultId:v});
window.managementFixture=()=>({talks:mk('a').map(t=>info(t.relativeOutline)),vaults:[{id:'a',name:'Review Library',root:rootOf.a,open:true},{id:'b',name:'Other vault',root:rootOf.b,open:true},{id:'c',name:'Past workshops',root:rootOf.c,open:false},{id:'d',name:'Offline drive',root:rootOf.d,open:true,unavailable:true}],activeTalk:null,foldersByVault:{a:[...SPEC.folders],b:[]},leaveActive:async()=>true,onRefresh:async()=>{calls.refresh++;ctl.rootGen+=ctl.bumpOnRefresh?1:0},onSelectTalk:async()=>true,onDeletedTalk:()=>{},onNewTalk:(...a)=>{calls.newTalk=a},onAddVault:()=>{},onEditVault:()=>{},onSetVaultOpen:async()=>{}});
`
export const overlay = `
const slot={job:null,gen:-1};
const kindOf=n=>n==='research'?'research':(n==='assets'||n==='_assets')?'assets':n.startsWith('.')?'system':'folder';
const describe=([relativePath,e])=>e.dir?{relativePath,kind:kindOf(relativePath.split('/').at(-1)),logical:null,allocated:null}:{relativePath,logical:null,allocated:null,kind:'file',...e};
const compute=r=>{const prefix=r.relativePath?r.relativePath+'/':'';
 const entries=Object.entries(ctl.tree).filter(([p])=>p.startsWith(prefix)&&(r.recursive||!p.slice(prefix.length).includes('/'))).map(describe);
 const files=entries.filter(e=>e.kind==='file'),excluded=entries.filter(e=>['link','alias','other'].includes(e.kind)).length;
 const unknown=files.filter(e=>e.allocated==null).length+excluded;
 const hasFiles=files.length>0,state=excluded?'partial':'complete';
 const base={...r,rootIdentity:'fx',checkedAt:'2026-10-30T12:00:00Z',state,counted:entries.length,unreadable:0,excluded,truncated:false,entries,allocationUnknown:unknown,
  logicalBytes:hasFiles?files.reduce((s,e)=>s+(e.logical??0),0):(state==='complete'&&r.recursive?0:null),
  allocatedBytes:hasFiles&&!unknown?files.reduce((s,e)=>s+(e.allocated??0),0):(state==='complete'&&r.recursive&&!hasFiles?0:null)};
 return ctl.inv?{...base,...ctl.inv(r,base)}:base};
window.tw.vault.galleryInventory=r=>{calls.inv.push(r);
 if(r.generation<=slot.gen){calls.superseded=(calls.superseded||0)+1;return Promise.reject(Error('Superseded inventory generation'))}
 slot.job?.stop();slot.gen=r.generation;
 const result=compute(r);
 const held=r.recursive?ctl.holdRecursive:ctl.holdListing;
 if(!held)return Promise.resolve(result);
 return new Promise(done=>{let ended=false;
  const job={generation:r.generation,last:{...result,state:'running',entries:[]},stop(){if(ended)return;ended=true;if(slot.job===job)slot.job=null;done({...job.last,state:'cancelled',reason:'Stopped; coverage incomplete'})},finish(){if(ended)return;ended=true;if(slot.job===job)slot.job=null;done(result)}};
  slot.job=job;ctl.job=job;ctl.release=()=>job.finish()})};
window.tw.vault.galleryInventoryCancel=async id=>{calls.cancelInv.push(id);if(slot.job?.generation===id)slot.job.stop()};
const realEmit=()=>ctl.progress;
ctl.emit=over=>{const j=slot.job;if(!j)return false;const r={...j.last,...over};j.last=r;realEmit()(r);return true};
ctl.handoutHold=false;ctl.heldHandouts=[];
const handouts=window.tw.vault.galleryHandouts;
window.tw.vault.galleryHandouts=(v,p)=>{if(ctl.handoutHold){calls.handouts.push(p);return new Promise(res=>ctl.heldHandouts.push(()=>res({status:'published',partial:false,note:null,records:[{key:'stale',kind:'talk',title:'STALE',link:'https://example.invalid/s',site:'linked',publishedAt:null,dateSource:'record'},{key:'stale2',kind:'talk',title:'STALE',link:'https://example.invalid/t',site:'linked',publishedAt:null,dateSource:'record'}]})))}return Promise.resolve({status:'unpublished',records:[],partial:false,note:null})};
window.tw.vault.renameFolder=async(t,n,v)=>{calls.writes.push(['renameFolder',t,n,v]);const to=t.split('/').slice(0,-1).concat(n).join('/');if(window.__mgmt)window.__mgmt.foldersByVault={...window.__mgmt.foldersByVault,a:window.__mgmt.foldersByVault.a.map(f=>f===t?to:f)};return to};

ctl.renames=[];
const realCatalogue=window.tw.vault.galleryCatalogue;
window.tw.vault.galleryCatalogue=async g=>{const r=await realCatalogue(g);if(!ctl.renames.length)return r;
 return {...r,vaults:r.vaults.map(v=>v.id!=='a'?v:{...v,talks:v.talks.map(t=>{let p=t.relativeOutline;for(const [from,to] of ctl.renames)if(p.startsWith(from+'/'))p=to+p.slice(from.length);return {...t,relativeOutline:p}})})}};
const realRename=window.tw.vault.renameFolder;
window.tw.vault.renameFolder=async(t,n,v)=>{const to=await realRename(t,n,v);ctl.renames.push([t,to]);
 window.__mgmt.foldersByVault={...window.__mgmt.foldersByVault,a:window.__mgmt.foldersByVault.a.map(f=>f.startsWith(t+'/')?to+f.slice(t.length):f)};
 ctl.tree=Object.fromEntries(Object.entries(ctl.tree).map(([p,e])=>[p===t||p.startsWith(t+'/')?to+p.slice(t.length):p,e]));return to};
`

export const harnessSource = srcDir => `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import Gallery from '${srcDir}/renderer/src/components/vault-gallery/VaultGallery';
${fixtureSource}
${overlay}
const management=window.managementFixture();window.__mgmt=management;
function H(){const[rev,setRev]=useState(1),[open,setOpen]=useState(true);window.ctl.setRev=setRev;return <><textarea aria-label="Editor" defaultValue="Unsaved"/>{open&&<Gallery revision={rev} onClose={()=>setOpen(false)} onOpen={async t=>{window.calls.open.push(t.outlinePath);return false}} management={management}/>}</>}
createRoot(document.getElementById('root')).render(<H/>)`

/** The same gallery on the real selectGuardedTalk. Main refuses a stale root at galleryTalk, galleryClaim and the commit at gallerySettle (ctl.refuseCommit), as src/main/index.ts does: a refused commit or a rollback puts the reserved claim back (window.__owner). calls.order records the open's steps. */
export const guardedHarnessSource = srcDir => `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import Gallery from '${srcDir}/renderer/src/components/vault-gallery/VaultGallery';import {selectGuardedTalk} from '${srcDir}/renderer/src/lib/talkSelection';
${fixtureSource}
${overlay}
const order=calls.order=[];
const resolveTalk=window.tw.vault.galleryTalk;
window.tw.vault.galleryTalk=async(v,p,g)=>{order.push('resolve');const found=await resolveTalk(v,p,g);if(g!==undefined&&g!==ctl.rootGen)return null;return ctl.foreignTalk?{...found,vaultId:'b'}:found};
let reserved;window.__owner='/fixture/review-library/previous/previous-outline.md';
window.tw.vault.galleryClaim=async(v,p,g)=>{order.push('claim');calls.claim.push(p);if(ctl.holdClaim)await new Promise(r=>ctl.held.push(r));if(g!==ctl.rootGen)return {ok:false,reason:'stale'};reserved=window.__owner;window.__owner=rootOf[v]+'/'+p;return {ok:true}};
window.tw.vault.gallerySettle=async c=>{order.push('settle:'+c);const refused=c&&ctl.refuseCommit;if((!c||refused)&&reserved)window.__owner=reserved;reserved=undefined;return {ok:!refused}};
window.__active={outlinePath:'/fixture/review-library/previous/previous-outline.md',title:'Previous'};
const management=window.managementFixture();window.__mgmt=management;
function H(){const[rev,setRev]=useState(1),[open,setOpen]=useState(true);window.ctl.setRev=setRev;window.ctl.closeGallery=()=>setOpen(false);
 const onOpen=(t,guard)=>{calls.open.push(t.outlinePath);return selectGuardedTalk(t,{isCurrent:guard?.isCurrent,revalidate:guard?.revalidate,current:()=>window.__active,leave:async()=>{order.push('leave');calls.leave=(calls.leave||0)+1;if(ctl.holdLeave)await new Promise(r=>ctl.held.push(r));return !ctl.declineLeave},settle:guard?.settle,claim:p=>guard.claim(p),adopt:x=>{order.push('adopt');(calls.adopted=calls.adopted||[]).push(x?.outlinePath);window.__active=x},refused:()=>{}})};
 return <><textarea aria-label="Editor" defaultValue="Unsaved"/>{open&&<Gallery revision={rev} onClose={()=>setOpen(false)} onOpen={onOpen} management={management}/>}</>}
createRoot(document.getElementById('root')).render(<H/>)`
