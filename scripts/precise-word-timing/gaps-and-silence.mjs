import './disable-ort-telemetry.mjs'
/** Public corpus PCM, real long silence and two Run audio files separated by a clock gap. */
import assert from 'node:assert/strict'
import { readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import * as ort from 'onnxruntime-node'
import { AlignmentModels,readAlignmentManifests,modelPin } from '../../src/main/alignment-models.ts'
import { createAlignmentService } from '../../src/main/alignment-service.ts'
import { inferAlignment } from '../../src/main/alignment-inference.ts'
const root=process.cwd(),scratch=mkdtempSync(join(root,'.tw-alignment-gaps-')),read=p=>JSON.parse(readFileSync(p,'utf8'))
function wave(bytes){const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(bytes.length+36,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(16000,24);h.writeUInt32LE(32000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(bytes.length,40);return Buffer.concat([h,bytes])}
try{
 const base=resolve('docs/design/2026-11-10-record-and-edit-video/built/slice-2/continuous-speech'),ref=read(join(base,'reference-english.json'))[0],raw=read(join(base,ref.id+'-native.json')),source=resolve(ref.audio)
 assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),ref.audioSha256)
 const ffmpeg=resolve('node_modules/ffmpeg-static/ffmpeg'),pcm=execFileSync(ffmpeg,['-v','error','-i',source,'-f','s16le','-ac','1','-ar','16000','-'])
 const clipMs=pcm.length/32,data=join(scratch,'data'),vault=join(scratch,'vault'),folder=join(vault,'_PRESENTATIONS','fixture'),sid='public-gap-fixture';mkdirSync(join(data,'recordings'),{recursive:true});mkdirSync(folder,{recursive:true})
 const words=[],silence=[],segments=[];let clock=0
 for(const [i,pauseMs] of [60000,3000].entries()){
  const file=i===0?sid+'.webm':sid+'.seg-2.webm',duration=clipMs*2+pauseMs
  writeFileSync(join(data,'recordings',file),wave(Buffer.concat([pcm,Buffer.alloc(pauseMs*32),pcm])))
  segments.push({file,startMs:clock,endMs:clock+duration})
  for(const offset of [clock,clock+clipMs+pauseMs]){words.push(...raw.words.map(w=>({text:w.text,start:w.startMs+offset,end:w.endMs+offset})));silence.push(...raw.silence.map(s=>({start:s.start+offset,end:s.end+offset})))}
  silence.push({start:clock+clipMs,end:clock+clipMs+pauseMs});clock+=duration+5000
 }
 silence.sort((a,b)=>a.start-b.start)
 // Merge adjacent measured silence; repeated source leading/trailing silence can touch the pad.
 const merged=[];for(const s of silence){const last=merged.at(-1);if(last && s.start<=last.end)last.end=Math.max(last.end,s.end);else merged.push({...s})}
 const target=join(folder,sid+'.transcript.json');writeFileSync(join(folder,sid+'.json'),JSON.stringify({id:sid,talkSlug:'fixture',kind:'recording',recordingMs:clock-5000,audio:{segments}}))
 writeFileSync(target,JSON.stringify({engine:'parakeet',createdAt:'2026-11-10',locale:'en-US',timingClock:'recording-v2',segments:[],words,silence:merged}))
 const manifests=readAlignmentManifests(resolve('resources/alignment-models')),models=new AlignmentModels(manifests,data),en=manifests.find(m=>m.language==='en');await models.store.installFile(modelPin(en),resolve('scripts/precise-word-timing/local/model_int8.onnx'),()=>{})
 let session,maxSamples=0
 const service=createAlignmentService({root:()=>vault,userData:()=>data,models:()=>models,ffmpeg:()=>ffmpeg,notify:()=>{},worker:(path,signal)=>({infer:async(pcm,words,alphabet)=>{signal.throwIfAborted();maxSamples=Math.max(maxSamples,pcm.length);session??=await ort.InferenceSession.create(path,{executionProviders:['cpu'],intraOpNumThreads:2,interOpNumThreads:1});return inferAlignment(session,pcm,words,alphabet)},close:()=>{}})})
 const started=performance.now(),result=await service.run('fixture',sid);await session?.release();assert.equal(result.ok,true,result.error)
 const t=read(target);assert.deepEqual(t.words.map(w=>w.text),words.map(w=>w.text));assert.equal(t.words.length,words.length)
 for(const w of t.words)if(w.alignment.status==='aligned')assert.ok(segments.some(s=>w.alignment.start>=s.startMs && w.alignment.end<=s.endMs),'No timing falls in the Run gap')
 const report={publicSource:ref.id,sourceSHA256:ref.audioSha256,seconds:(performance.now()-started)/1000,wordCount:words.length,aligned:t.words.filter(w=>w.alignment.status==='aligned').length,longSilenceMs:60000,runGapMs:5000,segments:segments.length,maxPCMSamples:maxSamples,peakRSSBytes:process.resourceUsage().maxRSS*1024}
 writeFileSync(resolve('docs/design/2026-11-10-record-and-edit-video/built/slice-2b/gaps-and-silence-result.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
}finally{rmSync(scratch,{recursive:true,force:true})}
