const fs=require('node:fs'),p=require('node:path'),ts=require('typescript'),assert=require('node:assert/strict');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,f);
const {galleryAcquiredAssets}=require('../../../src/main/vault-gallery-assets.ts');
const base=fs.mkdtempSync(p.resolve('scripts/vault-gallery/management-repairs/native-final-'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{try{for(const count of [0,1])for(const mode of ['cancel','deadline','close','success']){
 const dir=p.join(base,`${count}-${mode}`);fs.mkdirSync(dir);const marker=p.join(dir,'marker'),helper=p.join(dir,'helper.cjs'),pidfile=p.join(dir,'pid'),ended=p.join(dir,'ended');fs.writeFileSync(marker,'');
 fs.writeFileSync(helper,`#!/usr/bin/env node
const fs=require('fs');fs.writeFileSync(${JSON.stringify(pidfile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);let sent=false;require('readline').createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);if(r.op==='end'){fs.writeFileSync(${JSON.stringify(ended)},'');${mode==='cancel'?`setTimeout(()=>fs.unlinkSync(${JSON.stringify(marker)}),40);`:''}}const batch=!sent&&${count}?['captures/capture.html']:[];if(r.op==='next')sent=true;console.log(JSON.stringify({id:r.id,value:r.op==='list'?'key':r.op==='next'?{done:!batch.length,batch}: {}}));});`);fs.chmodSync(helper,0o755);
 const assets=galleryAcquiredAssets({root:dir,identity:fs.statSync(dir),executable:helper,marker,cache:dir});const now=Date.now;let closing;
 const resultPromise=assets.list(p.join(dir,'captures')).then(value=>({value}),error=>({error}));
 try{if(mode==='deadline'||mode==='close'){while(!fs.existsSync(ended))await delay(5);await delay(40);if(mode==='deadline')Date.now=()=>now()+10001;else closing=assets.close();}
 const result=await resultPromise;if(mode==='success')assert.deepEqual(result.value,count?['capture.html']:[]);else assert.ok(result.error,`${count}/${mode} must refuse after cleanup`);
 const pid=Number(fs.readFileSync(pidfile));assert.throws(()=>process.kill(pid,0),'child must be closed before settlement');console.log('PASS',count,mode,'actual PID closed');
 }finally{Date.now=now;await closing;await assets.close();}
 }}finally{fs.rmSync(base,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1});
