import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync,statSync, rmSync,renameSync,lstatSync, symlinkSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'
import { createVideoPackage, encodeVideoVoice } from '../src/main/video-package.ts'
import { recordingClock,recordingTranscodeArgs } from '../src/main/transcode-args.ts'
import { createPackageStage } from '../src/main/video-package-stage.ts'
import { videoPackageWords } from '../src/main/video-package-words.ts'
import { createTranscription } from '../src/main/transcription.ts'
import { videoWindows, selectedVideoRanges, videoWords, videoMarks, videoGaps } from '../src/shared/video-package-timeline.ts'
const root=mkdtempSync(join(tmpdir(),'tw-video-package-'))
let count=0
const pass=name=>console.log(`ok ${++count}. ${name}`)
try {
  const vault=join(root,'vault'); const talkDir=join(vault,'talk');mkdirSync(talkDir,{recursive:true})
  const image=join(vault,'picture.png');writeFileSync(image,'picture')
  const slides=[
    {id:'a',section:'one',title:'A',layout:'process',markdown:'# A {process}\n![](picture.png)',images:[image]},
    {id:'b',section:'two',title:'B',layout:'code',markdown:'# B {code}',images:[]},
    {id:'c',section:'one',title:'C',layout:'image-grid',markdown:'# C {image-grid}',images:[]}
  ]
  const run={id:'sess-video',talkSlug:'talk',talkTitle:'Fixture',recordingMs:1500,slideTimeIndex:[
    {event:'enter',slideId:'a',tMs:0},{event:'reveal',slideId:'a',tMs:250,hidden:1},
    {event:'enter',slideId:'b',tMs:500},{event:'enter',slideId:'c',tMs:1000}
  ]}
  assert.deepEqual(videoWords([{text:'once',start:0,end:1000}],[{start:0,end:400},{start:600,end:1000}]),[{text:'once',start:0,end:800}])
  const windows=videoWindows(run,slides)
  const ranges=selectedVideoRanges(windows,1500,['one'])
  assert.deepEqual(ranges,[{start:0,end:500},{start:1000,end:1500}])
  assert.throws(()=>selectedVideoRanges(windows,1500,[]))
  const words=[{text:'first',start:0,end:400},{text:'omit',start:600,end:900},{text:'last',start:1100,end:1450}]
  assert.deepEqual(videoWords(words,ranges),[{text:'first',start:0,end:400},{text:'last',start:600,end:950}])
  assert.deepEqual(videoMarks(run.slideTimeIndex,windows,ranges).map(m=>[m.event,m.t]),[['enter',0],['reveal',0.25],['enter',0.5]])
  assert.deepEqual(videoGaps([{start:0,end:400},{start:1200,end:1500}],ranges),[{start:400,end:500},{start:1000,end:1200}])
  pass('disjoint sections compact marks and words onto one clock; gaps and invalid selections are explicit')
  const wav=join(root,'original.wav')
  const pcm=Buffer.alloc(48000*2/2);const header=Buffer.alloc(44)
  header.write('RIFF');header.writeUInt32LE(pcm.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(48000,24);header.writeUInt32LE(96000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40)
  for(let i=0;i<pcm.length/2;i++) pcm.writeInt16LE(Math.round(6000*Math.sin(2*Math.PI*440*i/48000)),i*2)
  const original=Buffer.concat([header,pcm]);writeFileSync(wav,original)
  const ffmpeg=createRequire(import.meta.url)('ffmpeg-static')
  let rendering=async(selected,directory)=>Object.fromEntries(selected.map(s=>{const path=join(directory,`${s.id}.png`);writeFileSync(path,'png');return[s.id,path]}))
  let wordCalls=0
  const source={vault,talkDir,run,slides,tokensCss:':root{--paper:white}',segments:[{path:wav,startMs:0,endMs:500},{path:wav,startMs:1000,endMs:1500}],ffmpeg,
    words:async()=>{wordCalls++;return{engine:'parakeet',createdAt:'now',words}},render:(...args)=>rendering(...args)}
  const service=createVideoPackage({source:async()=>source})
  const progress=[]
  const first=await service.make({talkSlug:'talk',sessionId:run.id,sections:['one']},p=>progress.push(p.step))
  assert.equal(first.ok,true,first.error); assert.equal(first.durationMs,1000)
  assert.deepEqual(progress,['audio','words','slides','images'])
  for(const file of ['PROMPT.md','AGENTS.md','CLAUDE.md','outline.md','marks.json','audio/voice.m4a','words.json','transcript.md','look/tokens.css','animate.json']) assert.ok(existsSync(join(first.folder,file)),file)
  assert.deepEqual(readdirSync(join(first.folder,'out')),[])
  assert.deepEqual(JSON.parse(readFileSync(join(first.folder,'animate.json'))),{a:'animate',c:'keep'})
  assert.ok(!readFileSync(join(first.folder,'outline.md'),'utf8').includes('# B'))
  const decode=spawnSync(ffmpeg,['-v','error','-i',join(first.folder,'audio/voice.m4a'),'-f','s16le','-ar','48000','-ac','1','pipe:1'],{maxBuffer:1000000})
  assert.equal(decode.status,0,decode.stderr.toString());assert.ok(Math.abs(decode.stdout.length/96000-1)<0.1)
  assert.ok(decode.stdout.some(byte=>byte!==0),'the recorded sound survives encoding')
  assert.deepEqual(readFileSync(wav),original)
  assert.match(readFileSync(join(first.folder,'PROMPT.md'),'utf8'),/Never use a synthetic or cloned voice/)
  const whole=join(root,'whole.m4a');await encodeVideoVoice(source,[{start:0,end:1500}],whole,new AbortController().signal)
  const wholeDecoded=spawnSync(ffmpeg,['-v','error','-i',whole,'-f','s16le','-ar','48000','-ac','1','pipe:1'],{maxBuffer:1000000})
  assert.equal(wholeDecoded.status,0)
  const middle=wholeDecoded.stdout.subarray(Math.round(0.65*96000),Math.round(0.85*96000))
  assert.ok(middle.every(byte=>byte===0),'a recording gap stays silent on the Run clock')
  pass('real ffmpeg exports exactly the chosen audio duration, complete package, recorded voice unchanged')
  const prior=readFileSync(join(first.folder,'marks.json'),'utf8')
  const second=await service.make({talkSlug:'talk',sessionId:run.id,sections:['one']},()=>{})
  assert.equal(second.ok,true,second.error);assert.notEqual(second.folder,first.folder)
  assert.equal(readFileSync(join(first.folder,'marks.json'),'utf8'),prior)
  pass('repeating a package reserves a new folder and preserves the earlier package')
  let release
  rendering=async(_selected,_directory,signal)=>{ await new Promise(resolve=>{release=resolve;signal.addEventListener('abort',resolve,{once:true})});return{} }
  const before=readdirSync(join(talkDir,'video-packs')).sort()
  const cancelled=service.make({talkSlug:'talk',sessionId:run.id},p=>{if(p.step==='slides')setImmediate(()=>service.cancel())})
  const result=await cancelled;assert.equal(result.ok,false);assert.match(result.error,/cancelled/)
  assert.deepEqual(readdirSync(join(talkDir,'video-packs')).sort(),before);assert.equal(wordCalls,3)
  pass('cancelling removes only the unfinished version and retains completed word timings')
  const failed=await createVideoPackage({source:async()=>source,encode:async()=>{throw new Error('disk full')}}).make({talkSlug:'talk',sessionId:run.id},()=>{})
  assert.deepEqual(failed,{ok:false,error:'disk full'});assert.deepEqual(readdirSync(join(talkDir,'video-packs')).sort(),before)
  pass('a forced write failure removes the unfinished package and names the cause')
  const outside=join(root,'outside');mkdirSync(outside)
  const hostile=join(vault,'linked-talk');mkdirSync(hostile);symlinkSync(outside,join(hostile,'video-packs'))
  const refused=await createVideoPackage({source:async()=>({...source,talkDir:hostile})}).make({talkSlug:'talk',sessionId:run.id},()=>{})
  assert.equal(refused.ok,false);assert.deepEqual(readdirSync(outside),[])
  assert.deepEqual(readFileSync(wav),original)
  const unsafe=await service.make({talkSlug:'../outside',sessionId:'../../escape'},()=>{})
  assert.equal(unsafe.ok,false);assert.deepEqual(readdirSync(outside),[])
  pass('a symlink out of the vault is refused before any package writes; originals remain intact')
  const ledger=join(vault,'_PRESENTATIONS','talk');mkdirSync(ledger,{recursive:true})
  const canonical=join(ledger,`${run.id}.transcript.json`)
  const inline={engine:'parakeet',createdAt:'new',segments:[{text:'current',start:0,end:1500}],words}
  writeFileSync(canonical,JSON.stringify(inline))
  const sidecar=join(ledger,`${run.id}.words.json`);writeFileSync(sidecar,JSON.stringify({engine:'parakeet',createdAt:'new',words:[{text:'WRONG',start:0,end:1}]}))
  const tx=createTranscription({vaultRoot:()=>vault,userDataDir:()=>root,config:()=>({python:'',script:''}),readiness:()=>{throw new Error('inline words need no engine')},testMode:()=>true})
  const read=await videoPackageWords(tx,{talkSlug:'talk',sessionId:run.id},new AbortController().signal)
  assert.deepEqual(read.words,words);assert.equal(read.createdAt,'new')
  assert.equal(JSON.parse(readFileSync(sidecar)).words[0].text,'WRONG','stale sidecar is ignored and left intact')
  pass('the package adapter reads current inline words and ignores a stale matching-date sidecar')
  writeFileSync(canonical,JSON.stringify({engine:'parakeet',createdAt:'old',segments:[]}))
  const made=await videoPackageWords(tx,{talkSlug:'talk',sessionId:run.id},new AbortController().signal)
  assert.ok(made.words.length>0);assert.deepEqual(JSON.parse(readFileSync(canonical)).words,made.words)
  pass('a legacy Run without inline timings is transcribed before the package consumes its new words')
  // A folder name is never ownership: replace staging across an awaited word-timing operation.
  for(const replacement of ['symlink','directory']){
    const external=join(root,'stage-'+replacement);mkdirSync(external);writeFileSync(join(external,'sentinel'),'author data')
    let staged,displaced
    const attacked=await createVideoPackage({source:async()=>({...source,words:async()=>{
      const name=readdirSync(join(talkDir,'video-packs')).find(n=>n.startsWith('.video-stage-'))
      assert.ok(name);staged=join(talkDir,'video-packs',name);displaced=staged+'.displaced'
      renameSync(staged,displaced)
      if(replacement==='symlink')symlinkSync(external,staged)
      else{mkdirSync(staged);writeFileSync(join(staged,'sentinel'),'replacement author data')}
      return{engine:'parakeet',createdAt:'now',words}
    }})}).make({talkSlug:'talk',sessionId:run.id},()=>{})
    assert.equal(attacked.ok,false);assert.match(attacked.error,/staging folder changed/)
    assert.deepEqual(readdirSync(external),['sentinel']);assert.equal(readFileSync(join(external,'sentinel'),'utf8'),'author data')
    if(replacement==='directory')assert.equal(readFileSync(join(staged,'sentinel'),'utf8'),'replacement author data')
    else assert.equal(lstatSync(staged).isSymbolicLink(),true)
    assert.ok(existsSync(displaced),'a moved original stage is never removed by guessing its new name')
    // Both replacement paths are this fixture's own files; leave production cleanup out of it.
    rmSync(staged,{recursive:replacement==='directory'});rmSync(displaced,{recursive:true})
    pass(`staging swapped for ${replacement}: no external writes and replacement author data survives`)
  }
  const reserved=join(talkDir,'video-packs','existing-target');mkdirSync(reserved);writeFileSync(join(reserved,'sentinel'),'keep')
  const publication=createPackageStage(join(talkDir,'video-packs'));publication.folder('out')
  assert.throws(()=>publication.publish(reserved),/already exists/);publication.cleanup()
  assert.equal(readFileSync(join(reserved,'sentinel'),'utf8'),'keep');pass('publication refuses an existing final path and never cleans it up')
  rendering=async(selected,directory,signal,beforeWrite)=>Object.fromEntries(selected.map(s=>{beforeWrite();const path=join(directory,`${s.id}.png`);writeFileSync(path,'png');return[s.id,path]}))
  const legacyPack=await createVideoPackage({source:async()=>({...source,segments:[{path:wav,startMs:0,endMs:0}]})}).make({talkSlug:'talk',sessionId:run.id},()=>{})
  assert.equal(legacyPack.ok,true,legacyPack.error);assert.deepEqual(legacyPack.gaps,[]);pass('legacy 0–0 timing is unknown coverage and never a whole-stretch gap')
  const driftId='sess-leading-delay',userRecordings=join(root,'recordings');mkdirSync(userRecordings,{recursive:true})
  writeFileSync(join(userRecordings,driftId+'.webm'),original)
  const measured=[{file:driftId+'.webm',startMs:1000,endMs:1500}]
  writeFileSync(join(ledger,driftId+'.json'),JSON.stringify({...run,id:driftId,recordingMs:2000,audio:{segments:measured}}))
  const oldClock={engine:'parakeet',createdAt:'old',segments:[{text:'real voice',start:0,end:400}],words:[{text:'real',start:0,end:200},{text:'voice',start:200,end:400}]}
  const driftTranscript=join(ledger,driftId+'.transcript.json');writeFileSync(driftTranscript,JSON.stringify(oldClock));const originalTranscript=readFileSync(driftTranscript,'utf8')
  const adapted=await videoPackageWords(tx,{talkSlug:'talk',sessionId:driftId},new AbortController().signal)
  assert.deepEqual(adapted.words.map(w=>w.start),[1000,1200]);assert.equal(readFileSync(driftTranscript,'utf8'),originalTranscript,'legacy clock adaptation never rewrites author data')
  const segments=[{path:wav,startMs:1000,endMs:1500}]
  assert.equal(recordingClock(segments).leadingMs,1000)
  const transcribedAudio=join(root,'leading-delay.wav')
  const converted=spawnSync(ffmpeg,['-v','error',...recordingTranscodeArgs(segments,2000,transcribedAudio)],{encoding:'utf8'})
  assert.equal(converted.status,0,converted.stderr)
  const delayedRun={...run,id:driftId,recordingMs:2000}
  const delayed=await createVideoPackage({source:async()=>({...source,run:delayedRun,segments,words:async()=>adapted})}).make({talkSlug:'talk',sessionId:driftId},()=>{})
  assert.equal(delayed.ok,true,delayed.error)
  assert.deepEqual(JSON.parse(readFileSync(join(delayed.folder,'words.json'))).map(w=>w.start),[1,1.2])
  for(const audio of [transcribedAudio,join(delayed.folder,'audio','voice.m4a')]){
    const decoded=spawnSync(ffmpeg,['-v','error','-i',audio,'-f','s16le','-ar','48000','-ac','1','pipe:1'],{maxBuffer:1000000})
    assert.equal(decoded.status,0);assert.ok(decoded.stdout.subarray(0,Math.floor(0.8*96000)).every(byte=>byte===0),'leading silence is identical for transcription and video')
    assert.ok(decoded.stdout.subarray(Math.floor(1.1*96000),Math.floor(1.3*96000)).some(byte=>byte!==0),'words at 1s coincide with real recorded audio')
  }
  writeFileSync(driftTranscript,JSON.stringify({...oldClock,timingClock:'recording',segments:oldClock.segments.map(s=>({...s,start:s.start+1000,end:s.end+1000})),words:adapted.words}))
  assert.deepEqual((await tx.get('talk',driftId)).words,adapted.words,'new clock-marked transcripts are never shifted twice')
  writeFileSync(driftTranscript,JSON.stringify({...oldClock,words:[{text:'truncated',start:600,end:800}]}))
  const truncated = await tx.get('talk',driftId)
  assert.equal(truncated.needsTranscription,true)
  assert.deepEqual(truncated.words,[])
  pass('1000ms first-segment delay aligns transcription audio, legacy/new words and package audio on the Run clock')
  const mismatchId='sess-media-mismatch',tone2=Buffer.from(original)
  for(let i=0;i<(tone2.length-44)/2;i++)tone2.writeInt16LE(Math.round(6000*Math.sin(2*Math.PI*880*i/48000)),44+i*2)
  const secondTone=join(root,'880.wav');writeFileSync(secondTone,tone2)
  const mismatchSegments=[{path:wav,startMs:0,endMs:1000},{path:secondTone,startMs:1000,endMs:1250}]
  const mismatchWave=join(root,'mismatch.wav')
  const joined=spawnSync(ffmpeg,['-v','error',...recordingTranscodeArgs(mismatchSegments,1500,mismatchWave)],{encoding:'utf8'});assert.equal(joined.status,0,joined.stderr)
  const mismatch=await createVideoPackage({source:async()=>({...source,run:{...run,id:mismatchId},segments:mismatchSegments,words:async()=>({engine:'parakeet',createdAt:'now',words:[{text:'second-tone',start:1050,end:1200}]})})}).make({talkSlug:'talk',sessionId:mismatchId},()=>{})
  assert.equal(mismatch.ok,true,mismatch.error)
  const frequency=bytes=>{let crossings=0;for(let i=2;i<bytes.length;i+=2)if(bytes.readInt16LE(i-2)<=0&&bytes.readInt16LE(i)>0)crossings++;return crossings/(bytes.length/96000)}
  for(const audio of [mismatchWave,join(mismatch.folder,'audio','voice.m4a')]){
    const decoded=spawnSync(ffmpeg,['-v','error','-i',audio,'-f','s16le','-ar','48000','-ac','1','pipe:1'],{maxBuffer:1000000});assert.equal(decoded.status,0)
    assert.ok(Math.abs(frequency(decoded.stdout.subarray(9600,28800))-440)<25,'first tone remains on its declared span')
    assert.ok(decoded.stdout.subarray(Math.floor(.65*96000),Math.floor(.85*96000)).every(b=>b===0),'short media is padded to its metadata span')
    assert.ok(Math.abs(frequency(decoded.stdout.subarray(Math.floor(1.05*96000),Math.floor(1.2*96000)))-880)<30,'second tone begins at1000ms on both clocks')
    assert.ok(decoded.stdout.subarray(Math.floor(1.35*96000),Math.floor(1.45*96000)).every(b=>b===0),'long media is trimmed to its metadata span')
  }
  assert.equal(JSON.parse(readFileSync(join(mismatch.folder,'words.json')))[0].start,1.05)
  writeFileSync(join(userRecordings,mismatchId+'.webm'),original);writeFileSync(join(userRecordings,mismatchId+'.seg-2.webm'),tone2)
  writeFileSync(join(ledger,mismatchId+'.json'),JSON.stringify({id:mismatchId,talkSlug:'talk',recordingMs:1500,audio:{segments:[{file:mismatchId+'.webm',startMs:0,endMs:1000},{file:mismatchId+'.seg-2.webm',startMs:1000,endMs:1250}]}}))
  const oldMismatch=join(ledger,mismatchId+'.transcript.json');writeFileSync(oldMismatch,JSON.stringify({...oldClock,words:[{text:'second-tone',start:550,end:700}]}));const oldBytes=readFileSync(oldMismatch,'utf8')
  const flagged=await tx.get('talk',mismatchId);assert.equal(flagged.needsTranscription,true);assert.equal(flagged.hasWords,false);assert.deepEqual(flagged.words,[]);assert.equal(readFileSync(oldMismatch,'utf8'),oldBytes,'an unsafe old concatenation clock is flagged without rewriting the original')
  writeFileSync(oldMismatch,JSON.stringify({...oldClock,timingClock:'recording-v2',words:[{text:'second-tone',start:1050,end:1200}]}));assert.equal((await tx.get('talk',mismatchId)).hasWords,true)
  assert.deepEqual(readFileSync(wav),original);assert.deepEqual(readFileSync(secondTone),tone2)
  pass('two-tone500ms drift repro: one trim/pad timeline aligns both outputs; old concatenation clocks require fresh timings without changing author data')
  const trims=[{start:250,end:900},{start:750,end:1250}]
  assert.deepEqual(selectedVideoRanges(windows,1500,undefined,trims),[{start:0,end:250},{start:1250,end:1500}])
  assert.deepEqual(selectedVideoRanges(windows,1500,['one'],trims),[{start:0,end:250},{start:1250,end:1500}])
  assert.deepEqual(selectedVideoRanges(windows,1500,undefined,[{start:0,end:1500}]),[])
  const trimmedRun={...run,trims},trimmedBytes=JSON.stringify(trimmedRun)
  const trimmed=await createVideoPackage({source:async()=>({...source,run:trimmedRun})}).make({talkSlug:'talk',sessionId:run.id},()=>{})
  assert.equal(trimmed.ok,true,trimmed.error);assert.equal(trimmed.durationMs,500)
  assert.deepEqual(JSON.parse(readFileSync(join(trimmed.folder,'stretch.json'))).ranges,[{start:0,end:250},{start:1250,end:1500}])
  assert.deepEqual(JSON.parse(readFileSync(join(trimmed.folder,'words.json'))),[{text:'first',start:0,end:.25},{text:'last',start:.25,end:.45}])
  assert.deepEqual(JSON.parse(readFileSync(join(trimmed.folder,'marks.json'))).map(m=>[m.event,m.slideId,m.t]),[['enter','a',0],['enter','c',.25]])
  const trimmedAudio=spawnSync(ffmpeg,['-v','error','-i',join(trimmed.folder,'audio/voice.m4a'),'-f','s16le','-ar','48000','-ac','1','pipe:1'],{maxBuffer:1000000})
  assert.equal(trimmedAudio.status,0);assert.ok(Math.abs(trimmedAudio.stdout.length/96000-.5)<.07,'real ffmpeg removes the saved cut from audio')
  assert.equal(JSON.stringify(trimmedRun),trimmedBytes);assert.deepEqual(readFileSync(wav),original);assert.equal(readFileSync(join(first.folder,'marks.json'),'utf8'),prior)
  pass('saved overlapping trims cut audio, words, marks and duration once; original Run, recording and earlier package survive')
  const quiet=await createVideoPackage({source:async()=>({...source,segments:[{path:wav,startMs:0,endMs:1500}],words:async()=>({engine:'parakeet',createdAt:'now',words:words.filter(w=>w.text!=='omit')})})}).make({talkSlug:'talk',sessionId:run.id,sections:['two']},()=>{})
  assert.equal(quiet.ok,true,quiet.error);assert.equal(quiet.durationMs,500)
  assert.deepEqual(JSON.parse(readFileSync(join(quiet.folder,'words.json'))),[])
  assert.deepEqual(quiet.gaps,[]);assert.deepEqual(JSON.parse(readFileSync(join(quiet.folder,'stretch.json'))).gaps,[])
  assert.match(quiet.prompt,/no transcribed words.*Keep its recorded audio/)
  assert.deepEqual(JSON.parse(readFileSync(join(quiet.folder,'marks.json'))).map(m=>[m.event,m.slideId,m.t]),[['enter','b',0]])
  assert.deepEqual(readFileSync(wav),original)
  pass('silent selection with valid words elsewhere exports empty word timings, retains audio/marks without a false audio gap')
  // Exercise the production IPC's compile call, with only Electron/window capture replaced.
  const handlers=new Map(),sender={id:41,isDestroyed:()=>false,once:()=>{},removeListener:()=>{},send:()=>{}}
  globalThis.__videoPackageTestIpc={handle:(name,fn)=>handlers.set(name,fn)}
  const ipcBundle=join(root,'video-ipc.cjs')
  await build({entryPoints:[fileURLToPath(new URL('../src/main/video-package-ipc.ts',import.meta.url))],bundle:true,platform:'node',format:'cjs',outfile:ipcBundle,logLevel:'silent',plugins:[{name:'video-fixture',setup(b){
    b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'video-fixture'}))
    b.onResolve({filter:/^\.\/thumbnails$/},()=>({path:'thumbnails',namespace:'video-fixture'}))
    b.onLoad({filter:/.*/,namespace:'video-fixture'},args=>({contents:args.path==='electron'?'export const ipcMain=globalThis.__videoPackageTestIpc;':`import{writeFileSync}from'node:fs';import{join}from'node:path';export const cancelThumbnailRender=()=>{};export async function renderThumbnails(o){return Object.fromEntries(o.slides.map(s=>{o.beforeWrite?.();const p=join(o.cacheDir,s.cacheKey+'.png');writeFileSync(p,'picture');return[s.key,p]}))}`,loader:'js'}))
  }}]})
  try{
    const {registerVideoPackageIpc}=createRequire(import.meta.url)(ipcBundle)
    const extraId='extra-fixture',extraRunId='sess-extra-fixture',extraOutline=join(talkDir,'extra-outline.md')
    const extraText='---\ntitle: Extra fixture\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n## Opening {id=opening}\n\n### Base {id=base}\n\n- Base point\n'
    writeFileSync(extraOutline,extraText);writeFileSync(join(userRecordings,extraRunId+'.webm'),original)
    const extraRun={...run,id:extraRunId,recordingMs:1000,slideTimeIndex:[{event:'enter',slideId:'base',tMs:0},{event:'enter',slideId:extraId,tMs:500}],audio:{segments:[{file:extraRunId+'.webm',startMs:0,endMs:1000}]},extraSlides:[{id:extraId,title:'Only on this Run',text:'Run-specific detail',after:'base'}]}
    const extraRunPath=join(ledger,extraRunId+'.json');writeFileSync(extraRunPath,JSON.stringify(extraRun));const extraRunBytes=readFileSync(extraRunPath,'utf8')
    writeFileSync(join(ledger,extraRunId+'.transcript.json'),JSON.stringify({engine:'parakeet',createdAt:'now',timingClock:'recording-v2',segments:[{text:'Extra detail',start:0,end:900}],words:[{text:'Extra',start:550,end:900}]}))
    let prepared=false
    registerVideoPackageIpc({vaultRoot:()=>vault,toolsWindow:()=>({isDestroyed:()=>false,webContents:sender}),userDataDir:()=>root,listTalks:async()=>[{slug:'talk',outlinePath:extraOutline}],tokensCss:()=>'',
      prepare:async(path,text,options)=>{assert.equal(options?.run?.id,extraRunId,'the actual recorded Run must reach the compiler');const model=await prepareSource(path,text,'talk',statSync(path),undefined,options);const rows=buildPerSlideProjections(model,'talk');assert.ok(rows.some(row=>row.slide_id===extraId),'real Run compile includes its extra slide');assert.ok(model.fullHtml.includes('Run-specific detail'),'the PNG source includes the extra slide content');prepared=true;return{model,rows}},
      transcription:{userDataDir:()=>root,vaultRoot:()=>vault,config:()=>({python:'',script:''}),readiness:()=>({ffmpeg:{found:true,path:ffmpeg},row:{state:'ready'}})}})
    const extraPack=await handlers.get('video-pack:make')({sender},{talkSlug:'talk',sessionId:extraRunId})
    assert.equal(extraPack.ok,true,extraPack.error);assert.equal(prepared,true)
    assert.ok(JSON.parse(readFileSync(join(extraPack.folder,'slides/index.json')))[extraId]);assert.ok(readFileSync(join(extraPack.folder,'outline.md'),'utf8').includes('Only on this Run'))
    assert.equal(readFileSync(extraOutline,'utf8'),extraText);assert.equal(readFileSync(extraRunPath,'utf8'),extraRunBytes);assert.deepEqual(readFileSync(join(userRecordings,extraRunId+'.webm')),original)
    pass('IPC compiles with the actual Run; an extra-slide enter mark produces a picture/package without changing the outline or Run')
  }finally{delete globalThis.__videoPackageTestIpc}
  console.log(`video package: ${count} checks passed`)
} finally {rmSync(root,{recursive:true,force:true})}
