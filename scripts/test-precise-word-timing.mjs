import { verifiedModelBytes } from '../src/main/alignment-model-bytes.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { alignCtc, normaliseAlignmentWord, sharedMidpoints } from '../src/shared/word-alignment.ts'
import { alignmentChunks } from '../src/main/alignment-chunks.ts'
import { normaliseTranscript } from '../src/main/transcript-validation.ts'
import { withAlignment, withoutAlignment } from '../src/main/alignment-result.ts'
import { alignedCutEdge,cutEdge,cutRangeQuality } from '../src/shared/transcript-contract.ts'
import { AlignmentModelStore, ModelHostRefused } from '../src/main/alignment-model-store.ts'
import { readAlignmentManifests,AlignmentModels } from '../src/main/alignment-models.ts'
import { assertAlignmentPackageInputs } from './alignment-package-inputs.cjs'
let count = 0
const check = async (name, fn) => { await fn(); console.log(`ok ${++count} ${name}`) }
const alphabet = { vocab:{ '[PAD]':0, A:1, B:2, "'":3, '|':4 }, blank:0, delimiter:'|', uppercase:true }
await check('actual builder matchers exclude source/models even after file-set normalisation',()=>{
 const config=JSON.parse(readFileSync(join(process.cwd(),'package.json'),'utf8')).build
 for(const platform of ['mac','win'])for(const normalised of [false,true]){
  const c=structuredClone(config);if(normalised)c.files=[{from:'.',filter:c.files}]
  const packager={info:{appDir:process.cwd(),projectDir:process.cwd(),buildResourcesDir:'build',config:c,debugLogger:{isEnabled:false}},platformSpecificBuildOptions:c[platform]}
  assertAlignmentPackageInputs({packager})
 }
 const broken=structuredClone(config);broken.files=[{from:'.',filter:broken.files}];broken.mac.files=broken.mac.files.filter(p=>p.startsWith('!'))
 assert.throws(()=>assertAlignmentPackageInputs({packager:{info:{appDir:process.cwd(),projectDir:process.cwd(),buildResourcesDir:'build',config:broken,debugLogger:{isEnabled:false}},platformSpecificBuildOptions:broken.mac}}),/Package source boundary refused/)
})
await check('normalisation retains original and records unsupported digits', () => {
 const m = normaliseAlignmentWord('A’B, 12!', alphabet)
 assert.equal(m.original,'A’B, 12!');assert.equal(m.normalised,"A'B12"); assert.deepEqual(m.tokens,[1,3,2]); assert.deepEqual(m.unsupported,['1','2'])
 assert.deepEqual(normaliseAlignmentWord('ž', alphabet).unsupported,['Ž'])
 const czech=normaliseAlignmentWord('Z\u030c.',{vocab:{ž:1,'|':2},blank:0,delimiter:'|',uppercase:false})
 assert.equal(czech.normalised,'ž');assert.deepEqual(czech.tokens,[1]);assert.deepEqual(czech.unsupported,[])
})
function logits(path, vocab=3) { return Float32Array.from(path.flatMap(t => Array.from({length:vocab},(_,i)=>i===t?8:-8))) }
await check('shipping alphabets use each checkpoint pad token, distinct from the word separator',()=>{
 const manifests=readAlignmentManifests(join(process.cwd(),'resources/alignment-models'));assert.equal(manifests.length,2)
 for(const m of manifests){const a=m.alphabet;assert.equal(a.blank,a.vocab['[PAD]']??a.vocab['<pad>']);assert.notEqual(a.blank,a.vocab[a.delimiter])}
 const cs=manifests.find(m=>m.language==='cs').alphabet;assert.equal(cs.blank,43);assert.equal(cs.vocab['|'],0)
 assert.deepEqual(alignCtc(logits([43,1,0,2,43],44),5,44,[1,0,2],43).map(s=>[s.firstFrame,s.endFrame]),[[1,2],[2,3],[3,4]])
})
await check('CTC repeated labels require a blank', () => {
 assert.deepEqual(alignCtc(logits([0,1,0,1,0]),5,3,[1,1],0).map(s=>[s.firstFrame,s.endFrame]),[[1,2],[3,4]])
 assert.throws(()=>alignCtc(logits([1,1]),2,3,[1,1],0),/cannot be aligned/)
})
await check('CTC transitions, endpoints and confidence', () => {
 const spans=alignCtc(logits([1,1,2,2]),4,3,[1,2],0)
 assert.deepEqual(spans.map(s=>[s.firstFrame,s.endFrame]),[[0,2],[2,4]])
 assert.ok(spans.every(s=>s.confidence>.99))
 assert.throws(()=>alignCtc(new Float32Array([NaN,0,0]),1,3,[1],0))
 assert.throws(()=>alignCtc(logits([1]),1,3,[0],0))
})
const placed=[{start:0,end:100,confidence:.9},{start:140,end:240,confidence:.9}]
await check('midpoints require both confident neighbours', () => {
 assert.deepEqual(sharedMidpoints(placed),[120]); assert.deepEqual(sharedMidpoints([placed[0],null]),[null])
 assert.deepEqual(sharedMidpoints([placed[0],{...placed[1],confidence:.1}]),[null])
})
await check('60-minute plan bounded, complete and unique across pauses', () => {
 const words=Array.from({length:3600},(_,i)=>({text:'A',start:i*1000+200,end:i*1000+600}))
 const silence=words.map(w=>({start:w.end,end:w.end+500}))
 const chunks=alignmentChunks(words,silence,[{start:0,end:3600000}])
 assert.ok(chunks.every(c=>c.end-c.start<=30000))
 assert.deepEqual(chunks.flatMap(c=>Array.from({length:c.lastWord-c.firstWord+1},(_,i)=>i+c.firstWord)),words.map((_,i)=>i))
})
await check('segment gaps and words crossing gaps', () => {
 const words=[{text:'A',start:100,end:200},{text:'B',start:50100,end:50200}]
 assert.equal(alignmentChunks(words,[],[{start:0,end:1000},{start:50000,end:51000}]).length,2)
 assert.throws(()=>alignmentChunks(words,[],[{start:0,end:1000}]),/outside/)
 assert.throws(()=>alignmentChunks([{text:'A',start:900,end:1100}],[],[{start:0,end:1000}]),/gap/)
})
await check('continuous speech gets bounded provisional joins for revalidation', () => {
 const c=alignmentChunks(Array.from({length:40},(_,i)=>({text:'A',start:i*1000,end:i*1000+900})),[],[{start:0,end:40000}]);assert.equal(c.length,2);assert.equal(c[0].lastWord+1,c[1].firstWord)
})
const base={engine:'parakeet',createdAt:'2026-11-10',segments:[{text:'A B',start:0,end:300}],words:[{text:'A',start:0,end:110},{text:'B',start:130,end:240}]}
const provenance={version:1,model:'fixture',revision:'a'.repeat(40),sha256:'b'.repeat(64),alignedAt:'2026-11-10T00:00:00Z',normalisation:'ctc-nfc-v1',midpoints:[120]}
const placements=placed.map(p=>({...p,status:'aligned',normalised:'A',unsupported:[]}))
const candidate=withAlignment(base,provenance,placements)
await check('additive contract leaves legacy data and original times unchanged', () => {
 assert.deepEqual(normaliseTranscript(base),base)
 assert.deepEqual(withoutAlignment(candidate),base)
 assert.equal(candidate.words[0].end,110)
 assert.throws(()=>withAlignment(base,provenance,placements.slice(1)),/count/)
})
await check('malformed alignment drops optional fields only', () => {
 for(const corrupt of [{...provenance,sha256:'oops'},{...provenance,midpoints:[999]},{...provenance,version:2}]) {
  assert.deepEqual(normaliseTranscript({...candidate,alignment:corrupt}),base)
 }
 assert.deepEqual(normaliseTranscript({...candidate,words:candidate.words.map(w=>({...w,alignment:{...w.alignment,confidence:NaN}}))}),base)
})
await check('alignment validates without deleting earlier optional metadata',()=>{
 const raw={...base,captionCorrections:[{text:'owner annotation',start:'check this later'}],words:base.words.map(w=>({...w,returnedStart:'earlier raw value'}))}
 const aligned=withAlignment(raw,provenance,placements)
 assert.deepEqual(withoutAlignment(aligned),raw)
 assert.ok(normaliseTranscript(aligned).alignment)
})
await check('aligned cuts clean only at exact valid shared midpoint inside bounds', () => {
 assert.equal(alignedCutEdge(120,'end',[],candidate.words,provenance,{segments:base.segments}).quality,'clean')
 assert.equal(alignedCutEdge(121,'end',[],candidate.words,provenance).quality,'tight')
 assert.equal(alignedCutEdge(120,'end',[],candidate.words,undefined).quality,'tight')
 assert.equal(alignedCutEdge(120,'end',[],candidate.words,provenance,{lower:130}).quality,'tight')
 assert.equal(alignedCutEdge(500,'end',[{start:0,end:1000}],[],undefined).quality,'clean')
 const context={words:candidate.words,alignment:provenance,segments:base.segments}
 assert.equal(cutEdge(120,'end',[],context).quality,'clean')
 assert.equal(cutEdge(121,'end',[],context).quality,'tight')
 const range=cutRangeQuality({start:120,end:200},[],{start:context,end:context})
 assert.equal(range.start.quality,'clean');assert.equal(range.end.quality,'tight')
})
await check('reader refuses out-of-recording and far-from-returned alignment ranges',()=>{
 const raw={...base,segments:[{text:'A B',start:0,end:10000}]}
 for(const offset of [10000,4000]){
  const shifted=placements.map(p=>({...p,start:p.start+offset,end:p.end+offset}))
  const t=normaliseTranscript({...raw,alignment:{...provenance,midpoints:[120+offset]},words:raw.words.map((w,i)=>({...w,alignment:shifted[i]}))})
  assert.equal(t.alignment,undefined);assert.deepEqual(t.words,raw.words)
 }
})
await check('a midpoint across two segments is unmeasured; silence still applies',()=>{
 const segments=[{start:0,end:115},{start:125,end:300}]
 assert.equal(alignedCutEdge(120,'end',[],candidate.words,provenance,{segments}).quality,'tight')
 assert.equal(cutEdge(120,'end',[],{words:candidate.words,alignment:provenance,segments}).quality,'tight')
 assert.equal(alignedCutEdge(120,'end',[{start:0,end:1000}],candidate.words,provenance,{segments}).quality,'clean')
 const touching=[{text:'A',start:0,end:130},{text:'B',start:130,end:300}]
 const validated=normaliseTranscript({...candidate,segments:touching,words:candidate.words.map((w,i)=>i?{...w,start:130,end:130}:w)})
 assert.ok(validated.alignment)
 assert.equal(alignedCutEdge(120,'end',[],validated.words,validated.alignment,{segments:touching}).quality,'tight','a zero-duration word at a segment end belongs to the next segment')
})
await check('alignment events have explicit receiving windows and Windows is disabled',()=>{
 const source=readFileSync('src/main/index.ts','utf8')
 const block=source.slice(source.indexOf('let preciseModels:'),source.indexOf('async function alignAfterTranscription'))
 assert.doesNotMatch(block,/getAllWindows/)
 assert.match(block,/host.settingsWindow\(\)/);assert.match(block,/const w=toolsWindow/)
 assert.match(block,/process.platform!=='win32'/);assert.match(block,/not available on Windows yet/)
})
const scratch=mkdtempSync(join(process.cwd(),'.tw-alignment-test-'))
try {
 const body=Buffer.from('fixture model only'),sha256=createHash('sha256').update(body).digest('hex')
 const pin={id:'fixture',revision:'a'.repeat(40),sha256,bytes:body.length,url:`https://huggingface.co/resolve/${'a'.repeat(40)}/model.onnx`,licence:'MIT'}
 await check('missing or unqualified manifests mean unavailable, never an arbitrary model',async()=>{
  assert.deepEqual(readAlignmentManifests(scratch),[])
  const m={...pin,version:1,language:'en',label:'English',name:'fixture',source:'download',alphabet,url:'https://models.example.org/pinned/model.onnx'}
  const path=join(scratch,'en.json');writeFileSync(path,JSON.stringify(m));assert.equal(readAlignmentManifests(scratch).length,1)
  for(const change of [{licence:'CC-BY-NC-4.0'},{sha256:'wrong'},{url:'http://models.example.org/model.onnx'},{version:2},{alphabet:{...alphabet,blank:alphabet.vocab['|']}}]){writeFileSync(path,JSON.stringify({...m,...change}));assert.deepEqual(readAlignmentManifests(scratch),[])}
  assert.ok((await new AlignmentModels(readAlignmentManifests(scratch),scratch).status()).every(r=>r.state==='unavailable'))
 })
 await check('ORT receives pinned bytes despite a later pathname replacement',()=>{
  const source=join(scratch,'verified-buffer.onnx');writeFileSync(source,body)
  const buffer=verifiedModelBytes(source,sha256,body.length);writeFileSync(source,Buffer.alloc(body.length))
  assert.equal(createHash('sha256').update(buffer).digest('hex'),sha256)
  assert.throws(()=>verifiedModelBytes(source,sha256,body.length),/checksum/)
  assert.throws(()=>verifiedModelBytes(source,sha256,body.length+1),/size/)
  if(process.platform!=='win32'){const link=join(scratch,'linked-model.onnx');symlinkSync(source,link);assert.throws(()=>verifiedModelBytes(link,sha256,body.length),/regular/)}
 })
 await check('verified atomic download and removal', async()=>{
  const store=new AlignmentModelStore(scratch,async()=>new Response(body));const progress=[]
  const path=await store.download(pin,(n,total)=>progress.push([n,total]))
  assert.equal(await store.usable(pin),path);assert.equal(readdirSync(join(scratch,'alignment-models')).some(n=>n.endsWith('.partial')),false)
  assert.deepEqual(progress.at(-1),[body.length,body.length]);await store.remove(pin);assert.equal(await store.usable(pin),null)
 })
 await check('redirect refuses an unreviewed host before fetching it',async()=>{
  let calls=0;const store=new AlignmentModelStore(scratch,async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://attacker.example/model'}})})
  await assert.rejects(store.download(pin,()=>{}),/host refused/);assert.equal(calls,1);assert.equal(await store.usable(pin),null)
 })
 await check('source URL and approved redirect hosts are manifest data',async()=>{
  const custom={...pin,url:'https://models.example.org/czech/versioned-model.onnx',redirectHosts:['cdn.example.org']};let calls=0
  const store=new AlignmentModelStore(scratch,async(url,options)=>{assert.equal(options.credentials,'omit');calls++;return calls===1?new Response(null,{status:302,headers:{location:'https://cdn.example.org/czech.onnx'}}):new Response(body)})
  const path=await store.download(custom,()=>{});assert.equal(calls,2);assert.equal(await store.usable(custom),path);await store.remove(custom)
 })
 await check('dead-owner crash partials are swept; live and foreign files stay',async()=>{
  const folder=join(scratch,'alignment-models'),stale=join(folder,`fixture-${sha256}.onnx.2147483647.00000000-0000-4000-8000-000000000000.partial`),live=join(folder,`fixture-${sha256}.onnx.${process.pid}.00000000-0000-4000-8000-000000000001.partial`),foreign=join(folder,'foreign.partial')
  writeFileSync(stale,'interrupted');writeFileSync(live,'other live operation');writeFileSync(foreign,'not ours')
  const store=new AlignmentModelStore(scratch,async()=>new Response(body));await store.cleanupStale(pin)
  assert.equal(existsSync(stale),false);assert.equal(readFileSync(live,'utf8'),'other live operation');assert.equal(readFileSync(foreign,'utf8'),'not ours')
 })
 await check('second redirect hop refuses HTTP or unlisted host before fetching; oversized body refused',async()=>{
  for(const destination of ['http://cdn.example.org/model','https://attacker.example/model']){
   let calls=0
   const store=new AlignmentModelStore(scratch,async()=>new Response(null,{status:302,headers:{location:++calls===1?'https://cdn.example.org/model':destination}}))
   await assert.rejects(store.download({...pin,redirectHosts:['cdn.example.org']},()=>{}),/refused.*(cdn.example.org|attacker.example)/)
   assert.equal(calls,2);assert.equal(await store.usable(pin),null)
  }
  const store=new AlignmentModelStore(scratch,async()=>new Response(Buffer.alloc(pin.bytes+1)))
  await assert.rejects(store.download(pin,()=>{}),/exceeds pinned size/)
  assert.equal(await store.usable(pin),null)
 })
 await check('successful replacement and Remove clear superseded SHA files only for this model',async()=>{
  const store=new AlignmentModelStore(scratch,async()=>new Response(body)),old={...pin,sha256:'c'.repeat(64)}
  const folder=join(scratch,'alignment-models'),stale=join(folder,`${old.id}-${old.sha256}.onnx`),foreign=join(folder,`other-${old.sha256}.onnx`)
  writeFileSync(stale,'superseded synthetic model');writeFileSync(foreign,'other language')
  await store.download(pin,()=>{});assert.equal(existsSync(stale),false);assert.ok(existsSync(foreign))
  writeFileSync(stale,'superseded synthetic model');await store.remove(pin);assert.equal(existsSync(stale),false);assert.ok(existsSync(foreign))
 })
 await check('main verifies each unchanged file once; changed metadata invalidates the cache',async()=>{
  let hashes=0
  const store=new AlignmentModelStore(scratch,async()=>new Response(body),async path=>{hashes++;return createHash('sha256').update(readFileSync(path)).digest('hex')})
  const path=await store.download(pin,()=>{})
  for(let i=0;i<3;i++)assert.equal(await store.usable(pin),path)
  assert.equal(hashes,1)
  writeFileSync(path,Buffer.alloc(body.length));assert.equal(await store.usable(pin),null);assert.equal(hashes,2)
  await store.remove(pin)
 })
 await check('host refusal reaches Settings distinctly with the refused hostname',async()=>{
  const m={...pin,language:'en',label:'English',name:'fixture',source:'download',alphabet}
  const models=new AlignmentModels([m],scratch)
  models.store.download=async()=>{throw new ModelHostRefused('region.example.org')}
  await assert.rejects(models.change('en','download'),/region.example.org/)
  assert.match((await models.status())[0].note,/Model host refused: region.example.org/)
 })
 await check('checksum mismatch never usable and partial removed',async()=>{
  const store=new AlignmentModelStore(scratch,async()=>new Response(Buffer.alloc(body.length)))
  await assert.rejects(store.download(pin,()=>{}),/checksum/);assert.equal(await store.usable(pin),null)
  assert.equal(existsSync(join(scratch,'alignment-models',`fixture-${sha256}.onnx.partial`)),false)
 })
 await check('cancellation at progress leaves no usable model',async()=>{
  const store=new AlignmentModelStore(scratch,async()=>new Response(body))
  await assert.rejects(store.download(pin,()=>store.cancel(pin)))
  assert.equal(await store.usable(pin),null)
 })
 await check('restart ignores unusable stale partial without deleting another process file',async()=>{
  const path=join(scratch,'alignment-models',`fixture-${sha256}.onnx.partial`);writeFileSync(path,'other')
  const store=new AlignmentModelStore(scratch,async()=>new Response(body))
  const complete=await store.download(pin,()=>{});assert.equal(readFileSync(path,'utf8'),'other');await store.remove(pin)
 })
} finally { rmSync(scratch,{recursive:true,force:true}) }
console.log(`${count} precise word timing checks passed`)
