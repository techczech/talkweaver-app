import assert from 'node:assert/strict'
import {selectGuardedTalk} from '../src/renderer/src/lib/talkSelection.ts'
let valid=true,release,claims=0,adoptions=0,resolves=0
const old={outlinePath:'/fixture/old'},target={outlinePath:'/fixture/new'}
const deps={current:()=>old,leave:()=>new Promise(r=>release=r),isCurrent:()=>valid,revalidate:async()=>{resolves++;return valid?target:null},claim:async()=>{claims++;return {ok:true}},adopt:()=>adoptions++,refused:()=>{}}
const pending=selectGuardedTalk(target,deps)
valid=false;release(true)
assert.equal(await pending,false);assert.equal(claims,0);assert.equal(adoptions,0)
valid=true
const closed=selectGuardedTalk(target,{...deps,leave:async()=>true,revalidate:async()=>null})
assert.equal(await closed,false);assert.equal(claims,0)
assert.equal(await selectGuardedTalk(target,{...deps,leave:async()=>false}),false);assert.equal(resolves,0)
assert.equal(await selectGuardedTalk(target,{...deps,leave:async()=>true}),true);assert.equal(claims,1);assert.equal(adoptions,1)
console.log('PASS stale-after-leave, closed revalidation, Stay, awaited revalidation then claim/adoption')

const {createGalleryClaim}=await import('../src/main/vault-gallery-open.ts')
let epoch=1,resolveTarget,claimed=[]
const claim=createGalleryClaim({epoch:()=>epoch,resolve:()=>new Promise(r=>resolveTarget=r),claim:(sender,path)=>{claimed.push([sender,path]);return {ok:true}}})
const racing=claim(7,'vault','relative',1);epoch=2;resolveTarget(target)
assert.deepEqual(await racing,{ok:false,reason:'stale'});assert.deepEqual(claimed,[])
assert.deepEqual(await claim(7,'vault','relative',1),{ok:false,reason:'stale'})
const success=claim(7,'vault','relative',2);resolveTarget(target);assert.equal((await success).ok,true);assert.deepEqual(claimed,[[7,target.outlinePath]])
console.log('PASS main epoch changes during resolve refuse before synchronous ownership claim')

let validations=0,restore=[]
assert.equal(await selectGuardedTalk(target,{...deps,leave:async()=>true,revalidate:async()=>++validations===1?target:null,claim:async path=>{restore.push(path);return {ok:true}}}),false)
assert.deepEqual(restore,[target.outlinePath,old.outlinePath])
console.log('PASS registry invalidation during claim delivery refuses adoption and restores previous claim')
