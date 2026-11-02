import assert from 'node:assert/strict'
import { createGalleryCatalogue } from '../src/main/vault-gallery.ts'
import { galleryRows, galleryIdentity, acceptsGalleryReply } from '../src/shared/vault-gallery.ts'
let reads=0, release
const vaults=[{id:'a',root:'/fixture/a',open:true},{id:'b',root:'/fixture/b',open:true},{id:'c',root:'/fixture/c',open:false}]
const catalogue=createGalleryCatalogue({vaults:()=>vaults, unavailable:()=>false, cached:async v=>{reads++;return {hit:true,talks:[{outlinePath:v.root+'/Folder/twin/twin-outline.md',title:v.id,slug:'twin'}]}}})
const reply=await catalogue(1)
assert.equal(reads,2)
assert.equal(reply.vaults[2].status,'closed')
assert.notEqual(galleryIdentity(reply.vaults[0].talks[0]),galleryIdentity(reply.vaults[1].talks[0]))
assert.equal(galleryRows(reply.vaults[0],'','').folders[0].count,1)
assert.equal(galleryRows(reply.vaults[0],'Folder','b').talks.length,0)
assert.equal(acceptsGalleryReply(reply,2),false)
const racing=createGalleryCatalogue({vaults:()=>vaults,unavailable:()=>false,cached:()=>new Promise(r=>release=r)})
const pending=racing(3);vaults[0]={...vaults[0],open:false};release({hit:true,talks:[]})
// The next root is also read asynchronously.
await new Promise(r=>setImmediate(r));release({hit:true,talks:[]})
const closed=await pending
assert.equal(closed.vaults[0].status,'closed')
console.log('PASS vault identity, scoped recursive membership, cache-only closed roots, generation and close-race discard')
const { selectGuardedTalk } = await import('../src/renderer/src/lib/talkSelection.ts')
const events=[];let leaveResolve
const old={outlinePath:'/fixture/old'}, next={outlinePath:'/fixture/next'}
const deps={current:()=>old,leave:()=>new Promise(r=>leaveResolve=r),claim:async()=>{events.push('claim');return {ok:true}},adopt:()=>events.push('adopt'),refused:()=>events.push('refused')}
const switching=selectGuardedTalk(next,deps)
assert.deepEqual(events,[]);leaveResolve(true);assert.equal(await switching,true);assert.deepEqual(events,['claim','adopt'])
events.length=0
assert.equal(await selectGuardedTalk(next,{...deps,leave:async()=>false}),false);assert.deepEqual(events,[])
assert.equal(await selectGuardedTalk(next,{...deps,leave:async()=>true,claim:async()=>({ok:false})}),false);assert.deepEqual(events,['refused'])
console.log('PASS awaited leave, refused leave, another-window claim prevents adoption')
const {createVaultListHandler}=await import('../src/main/vault-list-handler.mjs')
const {mkdir,mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises')
const {join}=await import('node:path')
await mkdir(new URL('../evidence/vault-gallery/',import.meta.url),{recursive:true})
const fixture=await mkdtemp(new URL('../evidence/vault-gallery/.cache-',import.meta.url))
try {
 const index=createVaultListHandler({dir:fixture,scanConflicts:()=>{throw Error('must not scan')}})
 const v={id:'fixture',root:join(fixture,'nonexistent-vault'),open:true}
 const snapshot=JSON.stringify({id:v.id,root:v.root,entries:[{name:'twin',slug:'twin',title:'Cached title',path:join(v.root,'twin'),outlinePath:join(v.root,'twin/twin-outline.md')}]})
 await writeFile(join(fixture,'fixture.json'),snapshot)
 const read=createGalleryCatalogue({vaults:()=>[v],unavailable:()=>false,cached:index.cachedState})
 assert.equal((await read(8)).vaults[0].talks[0].title,'Cached title')
 assert.equal(await readFile(join(fixture,'fixture.json'),'utf8'),snapshot)
 const missing=await createGalleryCatalogue({vaults:()=>[{...v,id:'missing'}],unavailable:()=>false,cached:index.cachedState})(9)
 assert.equal(missing.vaults[0].status,'unknown')
 assert.equal(missing.vaults[0].talks.length,0)
 console.log('PASS actual persisted snapshot read with nonexistent vault, no refresh/writes; missing catalogue unknown')
} finally {await rm(fixture,{recursive:true,force:true})}
let epoch=0, calls=0
const mutable=[{id:'x',root:'/fixture/x',open:true},{id:'y',root:'/fixture/y',open:true}]
const stale=await createGalleryCatalogue({epoch:()=>epoch,vaults:()=>mutable,unavailable:()=>false,cached:async v=>{
 calls++
 if(calls===2){mutable[0]={...mutable[0],root:'/fixture/replaced'};epoch++}
 return {hit:true,talks:[{outlinePath:v.root+'/t/t-outline.md',title:'t',slug:'t'}]}
}})(12)
assert.equal(stale.vaults[0].talks.length,0)
assert.equal(stale.vaults[1].talks.length,0)
const offline=await createGalleryCatalogue({vaults:()=>[mutable[0]],unavailable:()=>true,cached:async()=>{throw Error('offline cache must not be touched')}})(13)
assert.equal(offline.vaults[0].status,'unavailable')
assert.equal(galleryRows({id:'empty',name:'Empty',status:'stale',talks:[]},'','').talks.length,0)
console.log('PASS registry epoch replacement invalidates earlier roots; unavailable roots bypass cache; known zero membership')
