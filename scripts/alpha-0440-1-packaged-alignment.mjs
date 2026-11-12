// Packaged worker/ORT/FFmpeg component proof on a development Electron utility host.
// Does not attach a debugger to, alter, or claim interactive proof of production main.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { AlignmentModelStore } from '../src/main/alignment-model-store.ts'
const require=createRequire(import.meta.url),root=process.cwd(),scratch=mkdtempSync(join(root,'.alpha-packaged-alignment-'))
const bundle=resolve('release/mac-arm64/TalkWeaver.app'),resources=join(bundle,'Contents/Resources')
try {
 const manifest=JSON.parse(readFileSync(join(resources,'alignment-models/cs.json'),'utf8'))
 const store=new AlignmentModelStore(join(scratch,'profile'))
 await store.installFile(manifest,resolve('release/alignment-models-to-install/czech-model-int8.onnx'),()=>{})
 const model=await store.usable(manifest,false);assert.ok(model)
 const corpus=resolve('docs/design/2026-11-10-record-and-edit-video/built/slice-2/continuous-speech')
 const ref=JSON.parse(readFileSync(join(corpus,'reference-czech.json'),'utf8'))[0]
 const audio=resolve(ref.audio),raw=JSON.parse(readFileSync(join(corpus,ref.id+'-native.json'),'utf8'))
 assert.equal(createHash('sha256').update(readFileSync(audio)).digest('hex'),ref.audioSha256)
 const pcm=join(scratch,'sample.f32'),result=join(scratch,'result.json')
 execFileSync(join(resources,'ffmpeg/ffmpeg'),['-v','error','-y','-i',audio,'-ac','1','-ar','16000','-f','f32le',pcm])
 const worker=join(resources,'app/out/main/alignment-worker.js'),entry=join(scratch,'main.cjs')
 writeFileSync(entry,`
const {app,utilityProcess}=require('electron'),fs=require('node:fs');let child;
app.whenReady().then(()=>{app.dock?.hide();
const timer=setTimeout(()=>{child?.kill();app.exit(1)},120000);
try{child=utilityProcess.fork(${JSON.stringify(worker)},[],{stdio:'pipe',env:{...process.env,ORT_DISABLE_TELEMETRY:'1'}});
child.on('message',m=>{clearTimeout(timer);fs.writeFileSync(${JSON.stringify(result)},JSON.stringify(m));child.kill();app.exit(m.error?1:0)});
const b=fs.readFileSync(${JSON.stringify(pcm)});child.postMessage({model:${JSON.stringify(model)},sha256:${JSON.stringify(manifest.sha256)},bytes:${manifest.bytes},threads:${manifest.threads??2},pcm:new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.length)),words:${JSON.stringify(raw.words.map(w=>w.text))},alphabet:${JSON.stringify(manifest.alphabet)}});
}catch(e){console.error(e);child?.kill();app.exit(1)}});
`)
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
 execFileSync(require('electron'),[entry,'--user-data-dir='+join(scratch,'runtime-profile'),'--use-mock-keychain'],{cwd:root,env,stdio:'inherit',timeout:150000})
 const reply=JSON.parse(readFileSync(result,'utf8'));assert.equal(reply.words.length,raw.words.length);assert.ok(reply.words.some(word=>word?.status==='aligned'))
 const record={result:'PASS',scope:'Packaged alignment worker, signed ONNX binaries and signed FFmpeg; development Electron utility host; source model-store API installs only into disposable test profile; no production-main UI proof',sample:ref.id,audioSha256:ref.audioSha256,modelSha256:manifest.sha256,words:reply.words,metrics:reply.metrics}
 writeFileSync('evidence/alpha-0440-1/packaged-alignment.json',JSON.stringify(record,null,2)+'\n')
 console.log('PASS packaged Czech alignment components on public sample; '+reply.words.filter(word=>word?.status==='aligned').length+'/'+reply.words.length+' words aligned; uncertain words retain their earlier times in the app')
} finally { rmSync(scratch,{recursive:true,force:true}) }
