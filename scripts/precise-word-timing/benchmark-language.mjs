import './disable-ort-telemetry.mjs'
/** Public corpus through the SAME chunk, inference, validation and atomic writer as the app. */
import assert from 'node:assert/strict'
import { readFileSync,writeFileSync,mkdirSync,mkdtempSync,copyFileSync,rmSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { createHash } from 'node:crypto'
import * as ort from 'onnxruntime-node'
import { inferAlignment } from '../../src/main/alignment-inference.ts'
import { createAlignmentService } from '../../src/main/alignment-service.ts'
import { AlignmentModels } from '../../src/main/alignment-models.ts'
import { trimWords } from '../../src/shared/transcript-contract.ts'
const language=process.argv[2];assert.ok(['en','cs'].includes(language));const threads=Number(process.argv[3]??(language==='cs'?4:2));assert.ok([2,4].includes(threads))
const precision=process.argv[4]??'int8';assert.ok(['int8','fp32'].includes(precision));const prefix=precision==='int8'?'':'fp32-'
const root=process.cwd(),local=resolve('scripts/precise-word-timing/local'),scratch=mkdtempSync(join(root,'.tw-corpus-alignment-'))
const relative='docs/design/2026-11-10-record-and-edit-video/built/slice-2/continuous-speech',base=resolve(relative),dest=join(local,prefix+'both-scores',relative),read=p=>JSON.parse(readFileSync(p,'utf8'))
mkdirSync(dest,{recursive:true});copyFileSync(join(base,'reference-sentence-exceptions.json'),join(dest,'reference-sentence-exceptions.json'))
try {
 const lang=language==='en'?'english':'czech',model=language==='en'?join(local,precision==='int8'?'model_int8.onnx':'model.onnx'):join(local,`cs/model-${precision}.onnx`),modelBytes=readFileSync(model),sha256=createHash('sha256').update(modelBytes).digest('hex')
 const vocab=read(language==='en'?join(local,'vocab.json'):join(local,'cs/vocab.json')),config=read(language==='en'?join(local,'config.json'):join(local,'cs/config.json'))
 const manifest={version:1,threads,language,label:lang,name:language==='en'?'Xenova/wav2vec2-base-960h':'comodoro/wav2vec2-xls-r-300m-cs-250',id:`${language}-benchmark`,revision:language==='en'?'a19f851b3d42865797e410752b4c570c871e4825':'73e2b9004f35d3ca79316a624e7edc3cdaa45d40',licence:'Apache-2.0',sha256,bytes:modelBytes.length,source:'local',url:null,alphabet:{vocab,blank:config.pad_token_id,delimiter:'|',uppercase:Object.hasOwn(vocab,'A')}}
 const shipping=read(resolve(`resources/alignment-models/${language}.json`));assert.deepEqual(manifest.alphabet,shipping.alphabet)
 if(precision==='int8'){assert.equal(manifest.sha256,shipping.sha256);assert.equal(manifest.bytes,shipping.bytes)}
 const data=join(scratch,'data'),vault=join(scratch,'vault'),folder=join(vault,'_PRESENTATIONS','fixture');mkdirSync(join(data,'recordings'),{recursive:true});mkdirSync(folder,{recursive:true})
 const models=new AlignmentModels([manifest],data);await models.change(language,'install',model)
 const refs=read(join(base,`reference-${lang}.json`)),clips=[],coverage=[];let released=Promise.resolve(),inferenceSeconds=0,loadSeconds=0
 copyFileSync(join(base,`reference-${lang}.json`),join(dest,`reference-${lang}.json`))
 const service=createAlignmentService({root:()=>vault,userData:()=>data,ffmpeg:()=>resolve('node_modules/ffmpeg-static/ffmpeg'),models:()=>models,notify:()=>{},worker:(path,signal,identity)=>{
  let session
  return{infer:async(pcm,words,alphabet)=>{signal.throwIfAborted();if(!session){const start=performance.now();session=await ort.InferenceSession.create(path,{executionProviders:['cpu'],intraOpNumThreads:identity.threads??2,interOpNumThreads:1});loadSeconds+=(performance.now()-start)/1000}const start=performance.now();const result=await inferAlignment(session,pcm,words,alphabet);inferenceSeconds+=(performance.now()-start)/1000;return result},close:()=>{released=session?.release()??Promise.resolve()}}
 }})
 for(const ref of refs) {
  const source=resolve(ref.audio);assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'),ref.audioSha256)
  const raw=read(join(base,ref.id+'-native.json')),sid=ref.id,filename=sid+'.webm',target=join(folder,sid+'.transcript.json')
  copyFileSync(source,join(data,'recordings',filename))
  writeFileSync(join(folder,sid+'.json'),JSON.stringify({id:sid,talkSlug:'fixture',kind:'recording',recordingMs:ref.durationMs,audio:{segments:[{file:filename,startMs:0,endMs:ref.durationMs}]}}))
  writeFileSync(target,JSON.stringify({engine:'apple-speech-transcriber',createdAt:'2026-11-10',locale:ref.locale,timingClock:'recording-v2',segments:raw.segments.map(s=>({text:s.text,start:s.startMs,end:s.endMs})),words:trimWords(raw.words.map(w=>({text:w.text,start:w.startMs,end:w.endMs})),raw.silence),silence:raw.silence}))
  const started=performance.now(),reply=await service.run('fixture',sid),seconds=(performance.now()-started)/1000;await released
  if(!reply.ok)throw Error(`${sid}: ${reply.error}`)
  // Direct CTC spans are provenance. Cuts use a confident shared point or earlier times.
  const result=read(target),words=result.words.map(w=>({text:w.text,startMs:w.start,endMs:w.end}))
  const midpoints=result.alignment.midpoints
  midpoints.forEach((t,i)=>{if(t!==null){words[i].endMs=t;words[i+1].startMs=t}})
  writeFileSync(join(dest,ref.id+'-native.json'),JSON.stringify({...raw,engine:`shipping-onnx-${precision}-service`,words}))
  const row={id:ref.id,seconds,durationSeconds:ref.durationMs/1000,words:words.length,aligned:result.words.filter(w=>w.alignment?.status==='aligned').length,midpoints:midpoints.filter(t=>t!==null).length}
  clips.push(row);coverage.push({id:ref.id,midpoints,placements:result.words.map(w=>w.alignment?.status==='aligned'?w.alignment:null)});console.log(JSON.stringify(row))
 }
 const seconds=clips.reduce((s,c)=>s+c.seconds,0),durationSeconds=clips.reduce((s,c)=>s+c.durationSeconds,0)
 const runtime={language,precision,threads,inferenceSeconds,modelLoadSeconds:loadSeconds,acousticRtf:inferenceSeconds/durationSeconds,modelBytes:modelBytes.length,sha256,seconds,durationSeconds,rtf:seconds/durationSeconds,peakRSSBytes:process.resourceUsage().maxRSS*1024,clips}
 writeFileSync(join(local,`${prefix}${language}-runtime.json`),JSON.stringify(runtime,null,2));writeFileSync(join(local,`${prefix}${language}-placements.json`),JSON.stringify(coverage))
 console.log(JSON.stringify({language,seconds,rtf:runtime.rtf,peakRSSBytes:runtime.peakRSSBytes}))
}finally{rmSync(scratch,{recursive:true,force:true})}
