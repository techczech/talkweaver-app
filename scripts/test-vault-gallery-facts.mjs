import assert from 'node:assert/strict'
import {createGalleryFacts} from '../src/main/vault-gallery-facts.ts'
import {createVisibleDemand} from '../src/renderer/src/components/vault-gallery/galleryModel.ts'
let revision='one', renders=0, valid=true
const service=createGalleryFacts({
 resolve:async(id,path)=>valid?{vaultId:id,relativeOutline:path,root:'/fixture/'+id,slug:'twin',outlinePath:'/fixture/'+id+'/twin.md'}:null,
 current:()=>valid,
 read:async t=>({text:'![](same.png)\n![](same.png)\n![](other.png)\n[Video: missing.mp4]',revision,slideCount:t.vaultId==='a'?3:7,coverUrl:null}),
 render:async t=>{renders++;return {slideCount:t.vaultId==='a'?3:7,coverUrl:'twthumb://thumb/twin/'+revision+'?vault='+t.vaultId}},
})
const interim=await service('a','twin.md',false);assert.equal(interim.slideCount,3);assert.equal(interim.preview,'pending');assert.equal(renders,0)
const a=await service('a','twin.md'), b=await service('b','twin.md')
assert.equal(a.slideCount,3);assert.equal(b.slideCount,7);assert.notEqual(a.coverUrl,b.coverUrl);assert.equal(a.imageCount,2)
await service('a','twin.md');assert.equal(renders,2)
revision='two';assert.match((await service('a','twin.md')).coverUrl,/two/);assert.equal(renders,3)
valid=false;assert.equal(await service('a','twin.md'),null)
let release;valid=true
const race=createGalleryFacts({resolve:async()=>({vaultId:'a',relativeOutline:'x',root:'old',outlinePath:'/fixture/x',slug:'x'}),current:()=>valid,read:()=>new Promise(r=>release=r),render:async()=>{throw Error('closed result rendered')}})
const pending=race('a','x');await new Promise(r=>setImmediate(r));valid=false;release({text:'',revision:'x',slideCount:null,coverUrl:null});assert.equal(await pending,null)
const missing=createGalleryFacts({resolve:async()=>({vaultId:'a',relativeOutline:'x',root:'r',outlinePath:'/x',slug:'x'}),current:()=>true,read:async()=>{throw Error('missing')},render:async()=>null})
assert.equal((await missing('a','x')).slideCount,null);assert.equal((await missing('a','x')).preview,'unavailable')
let active=0,max=0,calls=[],done=[]
const demand=createVisibleDemand(async key=>{calls.push(key);active++;max=Math.max(max,active);await new Promise(r=>done.push(r));active--;return key},()=>{},2)
demand.show('a');demand.show('b');demand.show('offscreen');demand.hide('offscreen');await new Promise(r=>setImmediate(r));assert.equal(max,2);done.splice(0).forEach(r=>r());await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['a','b']);demand.dispose()
console.log('PASS qualified covers/counts, distinct refs, revision invalidation, closed-root discard, unavailable unknown and bounded visible demand')

let late, published=0
const cancelled=createVisibleDemand(()=>new Promise(r=>late=r),()=>published++)
cancelled.show('old-root');cancelled.dispose();late('stale');await new Promise(r=>setImmediate(r));assert.equal(published,0)
console.log('PASS disposed/superseded visible demand cannot publish late facts')
