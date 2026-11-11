import assert from 'node:assert/strict'
import { galleryHandouts } from '../../../src/shared/gallery-handouts.ts'
const talk={vaultId:'a',relativeOutline:'one/t-outline.md',slug:'t',title:'T'}
const input={site:{exists:false,folders:[]},talks:[{vaultId:'a',outline:talk.relativeOutline,slug:'t',title:'T',outlinePath:'/a/one/t-outline.md',handoutUrl:'https://example.org/t/',folder:{kind:'unclear'}}],runs:[]}
assert.equal(galleryHandouts(talk,input).records.length,1)
assert.equal(galleryHandouts({...talk,vaultId:'b'},input).records.length,0)
assert.equal(galleryHandouts({...talk,relativeOutline:'two/t-outline.md'},input).records.length,0)
assert.equal(galleryHandouts(talk,null).status,'unknown')
assert.equal(galleryHandouts(talk,{...input,talks:[],unreadable:1}).status,'unknown')
assert.equal(galleryHandouts(talk,{...input,talks:[]}).status,'unpublished')
assert.equal(galleryHandouts(talk,input).records[0].site,'site-missing')
console.log('handout qualified join and unknown states passed')
const run={vaultId:'a',talkSlug:'t',runId:'r',talkTitle:'T',status:'delivered',handoutUrl:'https://example.org/r/',folder:{kind:'unclear'},sent:['pre','post']}
const ambiguous=galleryHandouts(talk,{...input,runs:[run,{...run,runId:'r2'}]})
assert.equal(ambiguous.records.length,1,'Only outline-qualified handouts counted')
assert.equal(ambiguous.unattributed.length,2,'Shared index Run provenance retained; pre/post not counted')
assert.equal(ambiguous.partial,true)
const unreadSite=galleryHandouts(talk,{...input,site:{exists:true,folders:[],error:'Unreadable'}})
assert.equal(unreadSite.records.length,1,'Unreadable site does not erase recorded address')
assert.equal(unreadSite.records[0].site,'unclear')
import { collectGalleryHandouts } from '../../../src/main/gallery-handouts.ts'
const site={siteDir:()=>'/nonexistent-fixture-site',readRegistry:()=>({})}
const io={current:()=>true,read:async()=>({text:'---\nhandout_url: https://example.org/t/\n---\n# T'}),list:async()=>[]}
assert.equal((await collectGalleryHandouts(talk,'/fixture',io,site)).records.length,1)
assert.equal((await collectGalleryHandouts(talk,'/fixture',{...io,read:async()=>{throw Error('unreadable')}},site)).status,'unknown')
let current=true
assert.equal(await collectGalleryHandouts(talk,'/fixture',{...io,current:()=>current,read:async()=>{current=false;return {text:''}}},site),null,'Closed or superseded root drops late result')
import { handOutLink } from '../../../src/main/hand-out.ts'
for(const url of ['javascript:alert(1)','file:///etc/passwd'])assert.equal(handOutLink(url),null)
assert.equal(handOutLink('https://example.org/t/').kind,'web')
console.log('scoped collector, partial provenance, late suppression and existing opener policy passed')

assert.equal(handOutLink('https://user:password@example.org/').href,'https://example.org/','Existing opener strips credentials')
const runFiles={
 '':['_PRESENTATIONS'],
 '_PRESENTATIONS':['_PRESENTATIONS/t'],
 '_PRESENTATIONS/t':['_PRESENTATIONS/t/r.json','_PRESENTATIONS/t/r2.json']
}
const collected=await collectGalleryHandouts(talk,'/fixture',{
 current:()=>true,
 list:async p=>runFiles[p]??[],
 read:async p=>p.endsWith('.json')?{text:JSON.stringify({id:p,talkSlug:'t',talkTitle:'T',kind:'delivery',status:'delivered',handoutUrl:'https://example.org/run/'})}:await io.read()
},site)
assert.equal(collected.records.length,1)
assert.equal(collected.unattributed.length,2)
assert.equal(collected.partial,true)
const duplicate=await collectGalleryHandouts({...talk,relativeOutline:'duplicate/t-outline.md'},'/fixture',{
 current:()=>true,list:async p=>runFiles[p]??[],read:async p=>p.endsWith('.json')?{text:JSON.stringify({id:p,talkSlug:'t',status:'delivered',handoutUrl:'https://example.org/source/'})}:{text:'# Duplicate'}
},site)
assert.equal(duplicate.records.length,0,'Duplicate never inherits a confirmed URL through shared slug')
console.log('PASS real combined collector Run adapter and duplicate unknown provenance')
