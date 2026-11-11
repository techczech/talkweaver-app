import assert from 'node:assert/strict'
import {normaliseRun,attachDeliveryToPlanned} from '../../../src/main/runs.ts'
for(const sourceOutline of ['/outside','../x','a/../x','a//x','a\\x','a/./x','x\0x',42])assert.equal(normaliseRun({sourceOutline}).sourceOutline,undefined)
const planned=normaliseRun({id:'p',talkSlug:'same',status:'planned',sourceOutline:'a/same-outline.md'})
const delivery=normaliseRun({talkSlug:'same',sourceOutline:'b/same-outline.md'})
assert.throws(()=>attachDeliveryToPlanned(planned,delivery),/source/)
assert.equal(attachDeliveryToPlanned(planned,normaliseRun({talkSlug:'same'})).sourceOutline,planned.sourceOutline)
console.log('provenance boundary and delivery preservation passed')
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {createPlannedRun,persistRun,readRun,setRunHandoutUrl} from '../../../src/main/runs.ts'
import {galleryHandouts} from '../../../src/shared/gallery-handouts.ts'
import {gallerySiteScope} from '../../../src/main/gallery-site.ts'
const fixture=mkdtempSync(join(import.meta.dirname,'fixture-'))
try {
 const plan=createPlannedRun(fixture,{talkSlug:'same',talkTitle:'Same',sourceOutline:'a/same-outline.md',plannedDate:'2026-10-29',eventTitle:'Event',slideSet:{kind:'all'}},()=> 'p')
 persistRun(fixture,attachDeliveryToPlanned(plan,normaliseRun({talkSlug:'same'})))
 for(let i=0;i<2;i++)persistRun(fixture,setRunHandoutUrl(readRun(fixture,'same','p'),'https://example.org/run/','run'))
 assert.equal(readRun(fixture,'same','p').sourceOutline,plan.sourceOutline)
 assert.throws(()=>persistRun(fixture,{...plan,sourceOutline:'b/same-outline.md'}),/source-conflict/)
 persistRun(fixture,normaliseRun({id:'invalid',talkSlug:'same',sourceOutline:'../escape'}))
 assert.equal(readRun(fixture,'same','invalid').sourceOutline,undefined)
 const talk={vaultId:'a',relativeOutline:plan.sourceOutline,slug:'same',title:'Same'}
 const run={vaultId:'a',sourceOutline:plan.sourceOutline,talkSlug:'same',runId:'p',talkTitle:'Same',kind:'delivery',status:'delivered',handoutUrl:'https://example.org/run/',folder:{kind:'unclear'},sent:['pre','post']}
 const input={site:{exists:false,folders:[]},talks:[],runs:[run,{...run,runId:'second'},{...run,vaultId:'b'},{...run,runId:'legacy',sourceOutline:undefined}]}
 assert.equal(galleryHandouts(talk,input).records.length,2)
 assert.ok(galleryHandouts(talk,input).records.every(row=>row.links.length===1))
 for(const relativeOutline of ['duplicate/same-outline.md','renamed/same-outline.md'])assert.equal(galleryHandouts({...talk,relativeOutline},input).records.length,0)
 let calls=0,current=true
 const scope=gallerySiteScope(async(root,folders,active)=>{calls++;await new Promise(resolve=>setImmediate(resolve));assert.ok(active());return {exists:true,folders:folders.map(name=>({name}))}})
 await Promise.all([scope.read(1,'epoch','root',['same'],()=>current,''),scope.read(1,'epoch','root',['same'],()=>current,'')])
 assert.equal(calls,1)
 await scope.read(1,'next','root',['same'],()=>current,'');assert.equal(calls,2)
 scope.cancel(1);await scope.read(1,'next','root',['same'],()=>current,'');assert.equal(calls,3)
 const pending=scope.read(1,'cancel','root',['same'],()=>current,'');current=false;await assert.rejects(pending)
 console.log('persistence, repeated publication, conflicting source, exact counts, rename and shared asynchronous scope passed')
}finally{rmSync(fixture,{recursive:true,force:true})}
import {acquireGallerySite} from '../../../src/main/gallery-site.ts'
import {mkdirSync,writeFileSync} from 'node:fs'
const siteFixture=mkdtempSync(join(import.meta.dirname,'site-'))
try {
 for(let i=0;i<150;i++){mkdirSync(join(siteFixture,`page-${i}`));writeFileSync(join(siteFixture,`page-${i}`,'index.html'),'fixture')}
 let heartbeat=false;setImmediate(()=>{heartbeat=true})
 const site=await acquireGallerySite(siteFixture,['page-1','page-2'],()=>true,join(process.cwd(),'native/vault-gallery'))
 assert.equal(site.folders.length,2);assert.equal(site.error,undefined);assert.ok(heartbeat)
 assert.ok(site.folders.every(f=>!f.modifiedAt),'No manufactured date')
 console.log('native scoped metadata reads two known pages out of 150; event loop heartbeat passed')
}finally{rmSync(siteFixture,{recursive:true,force:true})}
