import assert from 'node:assert/strict'
import { mkdtempSync,writeFileSync,rmSync,readFileSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
const require=createRequire(import.meta.url),root=process.cwd(),scratch=mkdtempSync(join(root,'.tw-alignment-utility-'))
const language=process.argv[2]??'en';assert.ok(['en','cs'].includes(language))
const manifest=JSON.parse(readFileSync(resolve(`resources/alignment-models/${language}.json`),'utf8'))
const worker=resolve('out/main/alignment-worker.js'),model=resolve(language==='en'?'scripts/precise-word-timing/local/model_int8.onnx':'scripts/precise-word-timing/local/cs/model-int8.onnx'),alphabet=manifest.alphabet
assert.equal(createHash('sha256').update(readFileSync(model)).digest('hex'),manifest.sha256)
try {
 const entry=join(scratch,'main.cjs')
 writeFileSync(entry,`const {app,utilityProcess}=require('electron');app.whenReady().then(()=>{app.dock?.hide();const c=utilityProcess.fork(${JSON.stringify(worker)},[],{stdio:'pipe',env:{...process.env,ORT_DISABLE_TELEMETRY:'1'}});const timer=setTimeout(()=>{c.kill();app.exit(1)},30000);c.on('message',m=>{clearTimeout(timer);if(!Array.isArray(m.words)){console.error(m.error);c.kill();app.exit(1);return}console.log('PASS utility-process ORT loads and infers with no RunAsNode or extra entitlements');c.kill();app.exit(0)});c.postMessage({model:${JSON.stringify(model)},sha256:${JSON.stringify(manifest.sha256)},bytes:${manifest.bytes},threads:${manifest.threads??2},pcm:new Float32Array(16000),words:['HELLO'],alphabet:${JSON.stringify(alphabet)}})})`)
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
 const child=spawn(require('electron'),[entry,`--user-data-dir=${join(scratch,'profile')}`],{env,stdio:['ignore','pipe','pipe']})
 const output=[];child.stdout.on('data',b=>{output.push(b);process.stdout.write(b)});child.stderr.on('data',b=>process.stderr.write(b))
 const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
 assert.equal(result,0);assert.match(Buffer.concat(output).toString(),/PASS utility-process/)
}finally{rmSync(scratch,{recursive:true,force:true})}
