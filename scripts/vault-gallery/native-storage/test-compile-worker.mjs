import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {fork} from 'node:child_process'
import {build} from 'esbuild'
if(process.platform!=='darwin'){console.log('SKIP native macOS compile worker fixture');process.exit(0)}
const home=path.resolve('scripts/vault-gallery/native-storage/worker-fixture');fs.mkdirSync(home,{recursive:true});let child
try {
 const root=path.join(home,'root'),cache=path.join(home,'cache');fs.mkdirSync(root);fs.mkdirSync(cache)
 const marker=path.join(cache,'active');fs.writeFileSync(marker,'active')
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>ACQUIRED_WORKER</text></svg>';fs.writeFileSync(path.join(root,'image.svg'),svg)
 const outfile=path.join(home,'worker.cjs')
 await build({entryPoints:['src/main/prepare-talk-worker.ts'],bundle:true,platform:'node',format:'cjs',outfile,banner:{js:"process.parentPort={on:(_event,callback)=>process.on('message',data=>callback({data})),postMessage:data=>process.send(data)};"}})
 child=fork(outfile,[],{stdio:['ignore','ignore','inherit','ipc']})
 const reply=new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',()=>reject(Error('Worker exited before response')))})
 child.send({id:1,compilerDir:path.resolve('compiler/scripts'),outlinePath:path.join(root,'outline.md'),text:'---\ntitle: Talk\n---\n\n### Slide\n\n![Picture](image.svg)',slug:'fixture',options:{allowedAssetRoots:[root],galleryReadAuthority:{root,identity:fs.statSync(root),executable:path.resolve('native/vault-gallery'),cache,marker}}})
 const result=await reply;assert.equal(result.ok,true,JSON.stringify(result));assert.ok(result.model.fullHtml.includes(Buffer.from(svg).toString('base64')))
 assert.deepEqual(fs.readdirSync(cache),['active'],'Worker snapshots are removed before response')
 console.log('PASS bundled compile-worker source, private authority handoff, actual native/compiler image bytes, cleanup before reply; Node IPC harness')
}finally{if(child){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited}fs.rmSync(home,{recursive:true,force:true})}
