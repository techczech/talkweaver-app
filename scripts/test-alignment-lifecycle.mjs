import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,chmodSync,existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { registerTranscriptionIpc } from '../src/main/transcription.ts'
import { createAlignmentService } from '../src/main/alignment-service.ts'
import { AlignmentModels, modelPin } from '../src/main/alignment-models.ts'
const scratch=mkdtempSync(join(process.cwd(),'.tw-alignment-lifecycle-'))
let count=0
const check=async(name,f)=>{await f();console.log(`ok ${++count} ${name}`)}
try {
 const vault=join(scratch,'vault'),data=join(scratch,'data'),folder=join(vault,'_PRESENTATIONS','fixture')
 mkdirSync(folder,{recursive:true});mkdirSync(join(data,'recordings'),{recursive:true})
 const sid='fixture-run',source=join(data,'recordings',sid+'.webm'),target=join(folder,sid+'.transcript.json')
 writeFileSync(source,'public synthetic fixture stand-in')
 writeFileSync(join(folder,sid+'.json'),JSON.stringify({id:sid,talkSlug:'fixture',kind:'recording',recordingMs:1000,audio:{segments:[{file:sid+'.webm',startMs:0,endMs:1000}]}}))
 const body=Buffer.from('synthetic model stand-in'),file=join(scratch,'model.onnx');writeFileSync(file,body)
 const manifest={language:'en',label:'English',name:'synthetic',id:'fixture',revision:'a'.repeat(40),sha256:createHash('sha256').update(body).digest('hex'),bytes:body.length,licence:'MIT',source:'local',url:null,alphabet:{vocab:{A:1,'|':2},blank:0,delimiter:'|',uppercase:true}}
 const models=new AlignmentModels([manifest],data)
 await models.change('en','install',file)
 const original={engine:'parakeet',createdAt:'2026-11-10',locale:'en-US',timingClock:'recording-v2',segments:[{text:'A A',start:0,end:1000}],words:[{text:'A',start:100,end:300},{text:'A',start:500,end:800}],silence:[]}
 const reset=()=>writeFileSync(target,JSON.stringify(original)),stored=()=>readFileSync(target,'utf8')
 let root=vault,onInfer=async()=>{},notes=[],closed=0,onNotify=()=>{}
 const service=createAlignmentService({root:()=>root,userData:()=>data,ffmpeg:()=>'/fixture/ffmpeg',models:()=>models,decode:async()=>new Float32Array(16000),notify:s=>{notes.push(s);onNotify(s)},worker:(_path,signal)=>({infer:async()=>{await onInfer(signal);return[{status:'aligned',start:120,end:280,confidence:.9,normalised:'A',unsupported:[]},{status:'aligned',start:520,end:780,confidence:.9,normalised:'A',unsupported:[]}]},close:()=>closed++})})
 await check('valid local hash installs; unverified local file refused',async()=>{
  assert.ok(await models.store.usable(modelPin(manifest)))
  writeFileSync(file,Buffer.alloc(body.length));await assert.rejects(models.change('en','install',file),/checksum/)
  assert.ok(await models.store.usable(modelPin(manifest)))
 })
 await check('alignment retains text/order/count/old times and stores provenance',async()=>{
  reset();assert.equal((await service.run('fixture',sid)).ok,true)
  const t=JSON.parse(stored());assert.equal(t.words.length,2);assert.deepEqual(t.words.map(({alignment,...w})=>w),original.words);assert.deepEqual(t.alignment.midpoints,[400]);assert.equal(t.alignment.sha256,manifest.sha256);assert.ok(closed);assert.equal(notes.at(-1).state,'done')
 })
 await check('a model changed as final verification resolves cannot pass the publication barrier',async()=>{
  reset();const before=stored(),usable=models.store.usable.bind(models.store);let checks=0
  models.store.usable=async(...args)=>{const path=await usable(...args);if(++checks===2 && path)writeFileSync(path,Buffer.alloc(body.length));return path}
  try{const result=await service.run('fixture',sid);assert.equal(result.ok,false);assert.match(result.error,/model changed/);assert.equal(stored(),before)}
  finally{models.store.usable=usable;writeFileSync(file,body);await models.change('en','install',file)}
 })
 await check('atomic alignment is additive even when the reader ignores older optional fields',async()=>{
  const raw={...original,captionCorrections:[{text:'saved owner annotation',start:'check later'}],words:original.words.map(w=>({...w,returnedStart:'raw earlier value'}))}
  writeFileSync(target,JSON.stringify(raw));const result=await service.run('fixture',sid);assert.equal(result.ok,true,result.error)
  const saved=JSON.parse(stored());assert.deepEqual(saved.captionCorrections,raw.captionCorrections)
  assert.deepEqual(saved.words.map(({alignment,...w})=>w),raw.words)
 })
 await check('a closed view cannot turn an atomic successful alignment into a failure',async()=>{
  reset()
  const noView=createAlignmentService({root:()=>vault,userData:()=>data,models:()=>models,ffmpeg:()=>'/fixture/ffmpeg',decode:async()=>new Float32Array(16000),notify:s=>{if(s.state==='done')throw Error('view closed')},worker:()=>({close:()=>{},infer:async()=>original.words.map(w=>({...w,status:'aligned',confidence:.9,normalised:'A',unsupported:[]}))})})
  const result=await noView.run('fixture',sid);assert.equal(result.ok,true,result.error);assert.ok(JSON.parse(stored()).alignment)
 })
 await check('inference failure keeps transcript',async()=>{
  reset();const before=stored();onInfer=async()=>{throw Error('inference failure')};assert.equal((await service.run('fixture',sid)).ok,false);assert.equal(stored(),before)
 })
 await check('reading malformed alignment keeps words visible and does not rewrite disk',async()=>{
  reset();writeFileSync(target,JSON.stringify({...original,alignment:{version:1,sha256:'malformed'},words:original.words.map(w=>({...w,alignment:{status:'aligned',confidence:9}}))}))
  const before=stored(),read=service.read('fixture',sid)
  assert.deepEqual(read.words,original.words);assert.equal(read.alignment,undefined);assert.equal(stored(),before)
 })
 await check('cancel during inference prevents late publication',async()=>{
  reset();const before=stored();onInfer=async()=>service.cancel();assert.equal((await service.run('fixture',sid)).ok,false);assert.equal(stored(),before);assert.equal(notes.at(-1).state,'cancelled')
 })
 await check('changed source refuses late result',async()=>{
  reset();const before=stored();onInfer=async()=>writeFileSync(source,'changed audio');assert.equal((await service.run('fixture',sid)).ok,false);assert.equal(stored(),before)
 })
 await check('changed transcript refuses late result',async()=>{
  reset();onInfer=async()=>writeFileSync(target,JSON.stringify({...original,createdAt:'newer'}));assert.equal((await service.run('fixture',sid)).ok,false);assert.equal(JSON.parse(stored()).createdAt,'newer')
 })
 await check('vault revocation refuses late result',async()=>{
  reset();const before=stored();onInfer=async()=>{root=null};assert.equal((await service.run('fixture',sid)).ok,false);assert.equal(stored(),before);root=vault
 })
 await check('a newer automatic transcript replaces a cancelled queued alignment',async()=>{
  reset();let calls=0
  const done=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('queued alignment did not finish')),3000);onNotify=s=>{if(s.state==='done'){clearTimeout(timer);resolve()}}})
  onInfer=async()=>{if(calls++===0){writeFileSync(target,JSON.stringify({...original,createdAt:'newer-auto'}));service.enqueue('fixture',sid)}}
  assert.equal((await service.run('fixture',sid)).ok,false);await done;assert.equal(JSON.parse(stored()).createdAt,'newer-auto');assert.ok(JSON.parse(stored()).alignment);assert.equal(calls,2);onNotify=()=>{}
 })
 await check('explicit unregistered vault cannot be read or aligned',async()=>{
  assert.equal(service.read('fixture',sid,join(scratch,'unregistered')),null)
  assert.equal((await service.run('fixture',sid,join(scratch,'unregistered'))).ok,false)
 })
 await check('disagreeing overlap keeps join words once with their earlier times',async()=>{
  const joinSid='synthetic-join',joinTarget=join(folder,joinSid+'.transcript.json')
  const words=Array.from({length:44},(_,i)=>({text:`A${i}`,start:i*1000+100,end:i*1000+300}))
  writeFileSync(join(data,'recordings',joinSid+'.webm'),'synthetic join audio stand-in')
  writeFileSync(join(folder,joinSid+'.json'),JSON.stringify({id:joinSid,talkSlug:'fixture',kind:'recording',recordingMs:44000,audio:{segments:[{file:joinSid+'.webm',startMs:0,endMs:44000}]}}))
  writeFileSync(joinTarget,JSON.stringify({...original,segments:[{text:'Synthetic join fixture',start:0,end:44000}],words}))
  let offset=0,calls=0
  const joined=createAlignmentService({root:()=>vault,userData:()=>data,models:()=>models,ffmpeg:()=>'/fixture/ffmpeg',notify:()=>{},decode:async(_ffmpeg,_path,start)=>{offset=start;return new Float32Array(16000)},worker:()=>({close:()=>{},infer:async(_pcm,texts)=>{calls++;return texts.map(text=>{const i=Number(text.slice(1)),shift=calls>1?200:0;if(i===19)return{status:'unplaced',confidence:0,normalised:text,unsupported:['1','9'],reason:'alphabet'};return{status:'aligned',start:i*1000+100-offset+shift,end:i*1000+300-offset+shift,confidence:.9,normalised:text,unsupported:[]}})}})})
  const result=await joined.run('fixture',joinSid);assert.equal(result.ok,true,result.error)
  const t=JSON.parse(readFileSync(joinTarget,'utf8'));assert.ok(calls>=3)
  assert.deepEqual(t.words.map(({alignment,...w})=>w),words)
  for(const i of [19,20]){assert.equal(t.words[i].alignment.status,'unplaced');assert.equal(t.words[i].start,words[i].start)}
  assert.equal(t.alignment.midpoints[19],null);assert.deepEqual(t.words[19].alignment.unsupported,['1','9']);assert.equal(t.words[19].alignment.reason,'alphabet')
 })
 await check('cancelling a queued Run does not cancel the different active Run',async()=>{
  const ids=['queue-left','queue-right'];let release,started,finished,activeSignal
  const startedPromise=new Promise(r=>{started=r}),finishedPromise=new Promise(r=>{finished=r}),waiting=new Promise(r=>{release=r})
  for(const id of ids){writeFileSync(join(data,'recordings',id+'.webm'),'synthetic queue audio');writeFileSync(join(folder,id+'.json'),JSON.stringify({id,talkSlug:'fixture',kind:'recording',recordingMs:1000,audio:{segments:[{file:id+'.webm',startMs:0,endMs:1000}]}}));writeFileSync(join(folder,id+'.transcript.json'),JSON.stringify(original))}
  let inferences=0
  const queued=createAlignmentService({root:()=>vault,userData:()=>data,models:()=>models,ffmpeg:()=>'/fixture/ffmpeg',decode:async()=>new Float32Array(16000),notify:s=>{if(s.sessionId===ids[0] && s.state==='done')finished()},worker:(_path,signal)=>({close:()=>{},infer:async()=>{inferences++;activeSignal=signal;started();await waiting;return original.words.map(w=>({status:'aligned',start:w.start,end:w.end,normalised:'A',unsupported:[],confidence:.9}))}})})
  queued.enqueue('fixture',ids[0]);await startedPromise;queued.enqueue('fixture',ids[1])
  assert.equal(queued.status('fixture',ids[1]).state,'working');assert.equal(queued.cancel('fixture',ids[1]),true);assert.equal(activeSignal.aborted,false);assert.equal(queued.status('fixture',ids[1]),null)
  release();await finishedPromise;await new Promise(r=>setImmediate(r));assert.equal(inferences,1)
  assert.equal(JSON.parse(readFileSync(join(folder,ids[1]+'.transcript.json'),'utf8')).alignment,undefined)
 })
 await check('explicit transcript home reads the right Run and rejects revocation after await',async()=>{
  const other=join(scratch,'secondary'),otherFolder=join(other,'_PRESENTATIONS','fixture');mkdirSync(otherFolder,{recursive:true})
  const otherPath=join(otherFolder,sid+'.transcript.json'),otherBytes=JSON.stringify({...original,words:original.words.map(w=>({...w,text:'B'}))});writeFileSync(otherPath,otherBytes)
  let available=true;const handlers=new Map()
  registerTranscriptionIpc({handle:(name,fn)=>handlers.set(name,fn)},{userDataDir:()=>data,vaultRoot:()=>vault,vaultForHome:home=>available && home===other?other:undefined,config:()=>({python:'',script:''}),readiness:()=>{throw Error('read must not consult transcription readiness')}})
  const get=handlers.get('transcript:get');assert.deepEqual((await get({},'fixture',sid,other)).words.map(w=>w.text),['B','B'])
  assert.equal(await get({},'fixture',sid,join(scratch,'unregistered')),null)
  const late=get({},'fixture',sid,other);available=false;assert.equal(await late,null)
  assert.equal(readFileSync(otherPath,'utf8'),otherBytes)
 })
 if(process.platform!=='win32')await check('malformed PCM is a failed job, never an uncaught main-process exception',async()=>{
  reset();const before=stored(),reader=join(scratch,'odd-pcm-reader')
  writeFileSync(reader,'#!/bin/sh\nprintf x\n');chmodSync(reader,0o755)
  let inferred=false
  const broken=createAlignmentService({root:()=>vault,userData:()=>data,models:()=>models,ffmpeg:()=>reader,notify:()=>{},worker:()=>({close:()=>{},infer:async()=>{inferred=true;throw Error('must not reach inference')}})})
  const result=await broken.run('fixture',sid);assert.equal(result.ok,false);assert.match(result.error,/malformed PCM/);assert.equal(inferred,false);assert.equal(stored(),before)
 })
 await check('random placements publish reader-accepted alignment or leave bytes unchanged; overlap keeps earlier word',async()=>{
  let seed=343
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32}
  const words=Array.from({length:8},(_,i)=>({text:'A',start:i*100,end:i*100+80}))
  let placements
  const property=createAlignmentService({root:()=>vault,userData:()=>data,models:()=>models,ffmpeg:()=>'/fixture/ffmpeg',decode:async()=>new Float32Array(16000),notify:()=>{},worker:()=>({close:()=>{},infer:async()=>placements})})
  for(let trial=0;trial<300;trial++){
   const raw={...original,words};writeFileSync(target,JSON.stringify(raw));const before=stored()
   placements=words.map(()=>{const start=Math.floor(random()*900);return{status:'aligned',start,end:start+1+Math.floor(random()*100),confidence:.9,normalised:'A',unsupported:[]}})
   if(trial===0)placements=[...[[10,100],[200,400],[300,500],[50,80]],...[[600,650],[700,750],[800,850],[900,950]]].map(([start,end])=>({status:'aligned',start,end,confidence:.9,normalised:'A',unsupported:[]}))
   const result=await property.run('fixture',sid)
   if(result.ok){assert.ok(property.read('fixture',sid).alignment);if(trial===0)assert.deepEqual(JSON.parse(stored()).words.slice(0,4).map(w=>w.alignment.status),['aligned','aligned','unplaced','unplaced'])}
   else {assert.equal(stored(),before);assert.doesNotMatch(result.error,/Invalid alignment result/,'overlap repair must converge')}
  }
 })
 await check('Run startup removes only exact dead-owner transcript temps',async()=>{
  reset();onInfer=async()=>{}
  const stale=target+'.2147483647.abcdef012345.tmp',live=target+`.${process.pid}.abcdef012345.tmp`,foreign=target+'.2147483647.invalid!.tmp'
  for(const path of [stale,live,foreign])writeFileSync(path,'synthetic leftover')
  assert.equal((await service.run('fixture',sid)).ok,true)
  assert.equal(existsSync(stale),false);assert.ok(existsSync(live));assert.ok(existsSync(foreign))
 })
 await check('utility memory failure after the final reply cannot publish a transcript',async()=>{
  reset();const before=stored();let failed=false,checks=0
  const usable=models.store.usable.bind(models.store)
  models.store.usable=async(...args)=>{const path=await usable(...args);if(++checks===2)failed=true;return path}
  const guarded=createAlignmentService({root:()=>vault,userData:()=>data,models:()=>models,ffmpeg:()=>'/fixture',decode:async()=>new Float32Array(16000),notify:()=>{},worker:()=>({close:()=>{},check:()=>{if(failed)throw Error('Alignment exceeded its memory limit')},infer:async()=>original.words.map(w=>({...w,status:'aligned',confidence:.9,normalised:'A',unsupported:[]}))})})
  try{const result=await guarded.run('fixture',sid);assert.equal(result.ok,false);assert.match(result.error,/memory limit/);assert.equal(stored(),before)}finally{models.store.usable=usable}
 })
 await check('quit stops current and future alignment',async()=>{
  reset();const before=stored();onInfer=async()=>service.quit();assert.equal((await service.run('fixture',sid)).ok,false);assert.equal(stored(),before);assert.equal((await service.run('fixture',sid)).ok,false)
 })
}finally{rmSync(scratch,{recursive:true,force:true})}
console.log(`${count} alignment lifecycle checks passed`)
