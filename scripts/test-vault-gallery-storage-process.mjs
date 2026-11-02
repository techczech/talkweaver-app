import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {fork} from 'node:child_process'
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {createGalleryStorage} from '../src/main/vault-gallery-storage.ts'
if(process.platform!=='darwin'){console.log('SKIP macOS helper process fixture; portable lifecycle/authority tests remain registered');process.exit(0)}
const home=resolve('evidence/vault-gallery/storage'),children=[]
await mkdir(home,{recursive:true});const dir=await mkdtemp(join(home,'.process-'))
try {
 await mkdir(join(dir,'vault','empty'),{recursive:true});await writeFile(join(dir,'vault','file'),'fixture')
 await build({entryPoints:['src/main/vault-gallery-inventory-worker.ts'],bundle:true,platform:'node',format:'cjs',outfile:join(dir,'worker.cjs'),banner:{js:"process.parentPort={on:(_event,callback)=>process.on('message',data=>callback({data})),postMessage:data=>process.send(data)};"}})
 const storage=createGalleryStorage({acquire:root=>({root,executable:resolve('native/vault-gallery'),expectedIdentity:''}),vault:()=>({id:'fixture',root:join(dir,'vault'),open:true}),unavailable:()=>false,epoch:()=>1,spawn(){const child=fork(join(dir,'worker.cjs'),[],{stdio:['ignore','ignore','ignore','ipc']});children.push(child);return {postMessage:value=>child.send(value),on:(event,callback)=>child.on(event,callback),kill:()=>child.send({cancel:true})}}})
 const request={vaultId:'fixture',relativePath:'',generation:1,recursive:true,confirmedRoot:true}
 const r=await storage.start(1,request,()=>{})
 assert.equal(r.state,'complete');assert.equal(r.logicalBytes,7);assert.ok(r.allocatedBytes>r.logicalBytes);assert.ok(children[0].exitCode!==null)
 const p=storage.start(1,{...request,generation:2},()=>{});storage.cancel(1,2)
 assert.equal((await p).state,'cancelled');assert.ok(children[1].exitCode!==null)
 console.log('PASS real isolated worker/helper round trip, bundled helper, distinct allocation, complete and cancelled exit barriers')
} finally {for(const child of children)if(child.exitCode===null)child.kill();await rm(dir,{recursive:true,force:true})}
