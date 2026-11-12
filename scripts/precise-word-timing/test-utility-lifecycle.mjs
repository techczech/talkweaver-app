/** Real, hidden Electron utility; synthetic ONNX graph/audio only, isolated app profile. */
import assert from 'node:assert/strict'
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { tinyOnnxFixture } from './tiny-onnx-fixture.mjs'
const require=createRequire(import.meta.url),scratch=mkdtempSync(join(process.cwd(),'.tw-alignment-process-'))
try{
 const model=join(scratch,'synthetic.onnx');writeFileSync(model,tinyOnnxFixture())
 const wrapper=join(scratch,'worker.cjs')
 writeFileSync(wrapper,`
const ort=require('onnxruntime-node');
if(process.env.TW_FIXTURE_STALL==='1'){
 const create=ort.InferenceSession.create.bind(ort.InferenceSession);
 ort.InferenceSession.create=async(...args)=>{const session=await create(...args),run=session.run.bind(session);session.run=async(...feeds)=>{const result=await run(...feeds);console.log('FIXTURE_MID_CHUNK');await new Promise(()=>{});return result};return session};
}
require(${JSON.stringify(resolve('out/main/alignment-worker.js'))});
`)
 const entry=join(scratch,'entry.ts'),output=join(scratch,'main.cjs')
 writeFileSync(entry,`
import assert from 'node:assert/strict';import {app,utilityProcess} from 'electron';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {createAlignmentService} from ${JSON.stringify(resolve('src/main/alignment-service.ts'))};
import {AlignmentModels} from ${JSON.stringify(resolve('src/main/alignment-models.ts'))};
import {createAlignmentProcess} from ${JSON.stringify(resolve('src/main/alignment-process.ts'))};
const root=${JSON.stringify(scratch)},model=${JSON.stringify(model)},workerPath=${JSON.stringify(wrapper)};
app.whenReady().then(async()=>{app.dock?.hide();const timer=setTimeout(()=>{console.error('fixture timed out');app.exit(1)},30000);const children=[];
try{
 const vault=join(root,'vault'),data=join(root,'data'),folder=join(vault,'_PRESENTATIONS','fixture');mkdirSync(folder,{recursive:true});mkdirSync(join(data,'recordings'),{recursive:true});
 const body=readFileSync(model),manifest={language:'en',label:'Synthetic',name:'synthetic-constant',id:'fixture',revision:'a'.repeat(40),sha256:createHash('sha256').update(body).digest('hex'),bytes:body.length,licence:'MIT',source:'local',url:null,alphabet:{vocab:{A:1,'|':2},blank:0,delimiter:'|',uppercase:true}};
 const models=new AlignmentModels([manifest],data);await models.change('en','install',model);
 for(const mode of ['success','cancel','quit']){
  const sid='fixture-'+mode,target=join(folder,sid+'.transcript.json');writeFileSync(join(data,'recordings',sid+'.webm'),'synthetic audio stand-in; decoder supplies PCM');
  writeFileSync(join(folder,sid+'.json'),JSON.stringify({id:sid,talkSlug:'fixture',kind:'recording',recordingMs:1000,audio:{segments:[{file:sid+'.webm',startMs:0,endMs:1000}]}}));
  const original=JSON.stringify({engine:'parakeet',createdAt:'2026-11-11',locale:'en-US',timingClock:'recording-v2',segments:[{text:'A A',start:0,end:1000}],words:[{text:'A',start:20,end:40},{text:'A',start:60,end:80}]});writeFileSync(target,original);
  let death,pid,entered=false;
  const service=createAlignmentService({root:()=>vault,userData:()=>data,models:()=>models,ffmpeg:()=>'/fixture',decode:async()=>new Float32Array(1600),notify:()=>{},worker:(path,signal,identity)=>{
   const child=utilityProcess.fork(workerPath,[],{stdio:'pipe',env:{...process.env,ORT_DISABLE_TELEMETRY:'1',TW_FIXTURE_STALL:mode==='success'?'0':'1'}});children.push(child);
   child.once('spawn',()=>{pid=child.pid});death=new Promise(r=>child.once('exit',r));
   child.stdout?.on('data',chunk=>{if(chunk.toString().includes('FIXTURE_MID_CHUNK')){entered=true;if(mode==='cancel')service.cancel();else app.quit()}});
   child.stderr?.on('data',chunk=>process.stderr.write(chunk));
   return createAlignmentProcess(child,signal,{...identity,model:path},()=>{const m=app.getAppMetrics().find(m=>m.pid===child.pid);return(m?.memory.workingSetSize??0)*1024});
  }});
  const onQuit=event=>{event.preventDefault();service.quit()};if(mode==='quit')app.on('before-quit',onQuit);
  const result=await service.run('fixture',sid);await death;if(mode==='quit')app.removeListener('before-quit',onQuit);
  assert.ok(pid);assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
  if(mode==='success'){assert.equal(result.ok,true,JSON.stringify(result));assert.ok(service.read('fixture',sid)?.alignment)}
  else{assert.ok(entered,'real native inference must finish inside the held chunk before cancellation');assert.equal(result.ok,false);assert.equal(readFileSync(target,'utf8'),original);if(mode==='quit')assert.equal((await service.run('fixture',sid)).ok,false)}
  console.log('PASS real utility '+mode+': no orphan; '+(mode==='success'?'reader accepts synthetic ONNX alignment':'transcript bytes unchanged'));
 }
 clearTimeout(timer);app.exit(0);
}catch(e){for(const child of children)try{child.kill()}catch{};console.error(e);clearTimeout(timer);app.exit(1)}});
`)
 await build({entryPoints:[entry],outfile:output,bundle:true,platform:'node',format:'cjs',external:['electron','onnxruntime-node']})
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
 const child=spawn(require('electron'),[output,`--user-data-dir=${join(scratch,'profile')}`],{env,stdio:['ignore','pipe','pipe']})
 let text='';child.stdout.on('data',b=>{text+=b;process.stdout.write(b)});child.stderr.on('data',b=>process.stderr.write(b))
 const timer=setTimeout(()=>child.kill('SIGKILL'),45000)
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
 clearTimeout(timer);assert.equal(code,0);assert.equal((text.match(/PASS real utility/g)??[]).length,3)
}finally{rmSync(scratch,{recursive:true,force:true})}
