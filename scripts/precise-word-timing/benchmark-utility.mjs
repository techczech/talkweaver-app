/** Actual Electron utility inference on PUBLIC corpus; no BrowserWindow or owner profile. */
import assert from 'node:assert/strict'
import { readFileSync,writeFileSync,mkdtempSync,rmSync } from 'node:fs'
import { resolve,join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require=createRequire(import.meta.url),root=process.cwd(),scratch=mkdtempSync(join(root,'.tw-utility-benchmark-'))
const language=process.argv[2]??'en';assert.ok(['en','cs'].includes(language))
try{
 const read=p=>JSON.parse(readFileSync(p,'utf8')),manifest=read(resolve(`resources/alignment-models/${language}.json`))
 const base=resolve('docs/design/2026-11-10-record-and-edit-video/built/slice-2/continuous-speech'),refs=read(join(base,`reference-${language==='en'?'english':'czech'}.json`)),inputs=[]
 for(const ref of refs){
  const audio=resolve(ref.audio);assert.equal(createHash('sha256').update(readFileSync(audio)).digest('hex'),ref.audioSha256)
  const pcm=join(scratch,ref.id+'.f32'),raw=read(join(base,ref.id+'-native.json'))
  execFileSync(resolve('node_modules/ffmpeg-static/ffmpeg'),['-v','error','-y','-i',audio,'-ac','1','-ar','16000','-f','f32le',pcm])
  assert.ok(readFileSync(pcm).length<=480000*4)
  inputs.push({id:ref.id,pcm,words:raw.words.map(w=>w.text),durationSeconds:ref.durationMs/1000})
 }
 const output=resolve(`docs/design/2026-11-10-record-and-edit-video/built/slice-2b/utility-runtime-${language}.json`),entry=join(scratch,'main.cjs'),model=resolve(language==='en'?'scripts/precise-word-timing/local/model_int8.onnx':'scripts/precise-word-timing/local/cs/model-int8.onnx')
 writeFileSync(entry,`
const {app,utilityProcess}=require('electron');const fs=require('node:fs');
app.whenReady().then(async()=>{app.dock?.hide();let child;try{
child=utilityProcess.fork(${JSON.stringify(resolve('out/main/alignment-worker.js'))},[],{stdio:'pipe',env:{...process.env,ORT_DISABLE_TELEMETRY:'1'}});
const inputs=${JSON.stringify(inputs)},manifest=${JSON.stringify(manifest)},rows=[];
for(const input of inputs){const b=fs.readFileSync(input.pcm),pcm=new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.length)),start=performance.now();
const reply=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Timed out'))},120000);const onExit=()=>{clearTimeout(timer);reject(Error('Utility stopped'))};child.once('exit',onExit);child.once('message',m=>{clearTimeout(timer);child.removeListener('exit',onExit);m.error?reject(Error(m.error)):resolve(m)});child.postMessage({model:${JSON.stringify(model)},sha256:manifest.sha256,bytes:manifest.bytes,threads:manifest.threads,pcm,words:input.words,alphabet:manifest.alphabet})});
if(reply.words.length!==input.words.length || !reply.metrics)throw Error('Invalid utility result');rows.push({id:input.id,durationSeconds:input.durationSeconds,wallSeconds:(performance.now()-start)/1000,...reply.metrics});}
const durationSeconds=rows.reduce((n,r)=>n+r.durationSeconds,0),inferenceSeconds=rows.reduce((n,r)=>n+r.inferenceSeconds,0),wallSeconds=rows.reduce((n,r)=>n+r.wallSeconds,0);
fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({language:manifest.language,model:manifest.name,sha256:manifest.sha256,threads:manifest.threads,electron:process.versions.electron,node:process.versions.node,scope:'Actual development Electron utility, exact verified model buffer; decode excluded; signed package execution checked separately',clips:rows.length,durationSeconds,inferenceSeconds,acousticRtf:inferenceSeconds/durationSeconds,modelLoadSeconds:rows.reduce((n,r)=>n+r.modelLoadSeconds,0),wallSeconds,wallRtf:wallSeconds/durationSeconds,peakRSSBytes:Math.max(...rows.map(r=>r.peakRSSBytes)),rows},null,2)+'\\n');
child.kill();console.log('PASS actual Electron utility corpus throughput and RSS');app.exit(0);
}catch(e){console.error(e.message);child?.kill();app.exit(1)}});
`)
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
 execFileSync(require('electron'),[entry,`--user-data-dir=${join(scratch,'profile')}`],{env,stdio:'inherit',timeout:600000})
 const record=read(output);console.log(JSON.stringify({language,acousticRtf:record.acousticRtf,peakRSSBytes:record.peakRSSBytes}))
}finally{rmSync(scratch,{recursive:true,force:true})}
