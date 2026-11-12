import './disable-ort-telemetry.mjs'
/** Actual one-hour fixture audio from PUBLIC corpus only, through the real chunk/write service. */
import assert from 'node:assert/strict'
import { readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,copyFileSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import * as ort from 'onnxruntime-node'
import { inferAlignment } from '../../src/main/alignment-inference.ts'
import { createAlignmentService } from '../../src/main/alignment-service.ts'
import { AlignmentModels,readAlignmentManifests } from '../../src/main/alignment-models.ts'
const root=process.cwd(),scratch=mkdtempSync(join(root,'.tw-long-alignment-')),read=p=>JSON.parse(readFileSync(p,'utf8'))
try {
 const base=resolve('docs/design/2026-11-10-record-and-edit-video/built/slice-2/continuous-speech'),ref=read(join(base,'reference-english.json'))[0],raw=read(join(base,ref.id+'-native.json'))
 const source=resolve(ref.audio);assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),ref.audioSha256)
 const data=join(scratch,'data'),vault=join(scratch,'vault'),folder=join(vault,'_PRESENTATIONS','fixture');mkdirSync(join(data,'recordings'),{recursive:true});mkdirSync(folder,{recursive:true})
 const sid='sixty-minute-public',audio=join(data,'recordings',sid+'.webm'),target=join(folder,sid+'.transcript.json'),duration=3600000
 const ffmpeg=resolve('node_modules/ffmpeg-static/ffmpeg')
 execFileSync(ffmpeg,['-v','error','-y','-stream_loop','-1','-i',source,'-t','3600','-ac','1','-ar','16000','-c:a','pcm_s16le','-f','wav',audio],{timeout:120000})
 const words=[],silence=[]
 for(let offset=0;offset<duration;offset+=ref.durationMs){for(const w of raw.words)if(w.endMs+offset<=duration)words.push({text:w.text,start:w.startMs+offset,end:w.endMs+offset});for(const s of raw.silence)if(s.end+offset<=duration)silence.push({start:s.start+offset,end:s.end+offset})}
 writeFileSync(join(folder,sid+'.json'),JSON.stringify({id:sid,talkSlug:'fixture',kind:'recording',recordingMs:duration,audio:{segments:[{file:sid+'.webm',startMs:0,endMs:duration}]}}))
 const transcript={engine:'parakeet',createdAt:new Date().toISOString(),locale:'en-US',timingClock:'recording-v2',segments:[{text:'Public repeated fixture',start:0,end:duration}],words,silence}
 writeFileSync(target,JSON.stringify(transcript))
 const manifests=readAlignmentManifests(resolve('resources/alignment-models')),models=new AlignmentModels(manifests,data),en=manifests.find(m=>m.language==='en')
 await models.store.installFile({...en,url:en.url??`https://huggingface.co/local/resolve/${en.revision}/model.onnx`},resolve('scripts/precise-word-timing/local/model_int8.onnx'),()=>{})
 let session,progress=0,maxPCM=0
 const service=createAlignmentService({root:()=>vault,userData:()=>data,ffmpeg:()=>ffmpeg,models:()=>models,notify:s=>{if(s.state==='working')progress++},worker:(path,signal)=>({infer:async(pcm,words,alphabet)=>{signal.throwIfAborted();maxPCM=Math.max(maxPCM,pcm.length);session??=await ort.InferenceSession.create(path,{executionProviders:['cpu'],intraOpNumThreads:2,interOpNumThreads:1});return inferAlignment(session,pcm,words,alphabet)},close:()=>{}})})
 const started=performance.now(),result=await service.run('fixture',sid),seconds=(performance.now()-started)/1000
 await session?.release();assert.equal(result.ok,true,result.error)
 const aligned=read(target);assert.equal(aligned.words.length,words.length);assert.deepEqual(aligned.words.map(w=>w.text),words.map(w=>w.text));assert.ok(maxPCM<=480000);assert.ok(progress>1)
 const record={durationMs:duration,publicSource:ref.id,sourceSHA256:ref.audioSha256,words:words.length,aligned:aligned.words.filter(w=>w.alignment?.status==='aligned').length,maxPCMSamples:maxPCM,seconds,rtf:seconds/3600,peakRSSBytes:process.resourceUsage().maxRSS*1024,progressEvents:progress}
 writeFileSync(resolve('docs/design/2026-11-10-record-and-edit-video/built/slice-2b/sixty-minute-result.json'),JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify(record))
}finally{rmSync(scratch,{recursive:true,force:true})}
