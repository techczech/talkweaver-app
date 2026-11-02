import assert from 'node:assert/strict'
import {createGalleryStorage} from '../src/main/vault-gallery-storage.ts'
import {validateInventoryRequest} from '../src/shared/vault-gallery-storage.ts'
const request={vaultId:'v',relativePath:'folder',generation:1,recursive:true,confirmedRoot:false}
for(const patch of [{relativePath:'../outside'},{relativePath:'/outside'},{root:'/outside'},{relativePath:'x//y'},{generation:-1},{relativePath:'',confirmedRoot:false}])assert.throws(()=>validateInventoryRequest({...request,...patch}))
let root='/fixture',open=true,epoch=0,spawned=0,killed=0
const children=[]
const service=createGalleryStorage({vault:()=>({id:'v',root,open}),unavailable:()=>false,epoch:()=>epoch,spawn:()=>{spawned++;const listeners={};const child={postMessage(){},kill(){killed++;queueMicrotask(()=>listeners.exit?.());return true},on(e,f){listeners[e]=f},listeners};children.push(child);return child}})
open=false
assert.equal((await service.start(1,request,()=>{})).state,'unavailable');assert.equal(spawned,0)
open=true
const p=service.start(1,{...request,generation:2},()=>{throw Error('old reply published')})
const q=service.start(1,{...request,generation:3},()=>{})
assert.equal((await p).state,'cancelled');assert.equal(killed,1)
children[0].listeners.message({...request,state:'running'})
root='/changed';epoch++
children[1].listeners.message({...request,generation:3,state:'complete'})
assert.equal((await q).state,'stale');assert.equal(killed,2)
await assert.rejects(service.start(1,{...request,generation:2},()=>{}),/Superseded/)
const pending=[]
for(let sender=2;sender<6;sender++)pending.push(service.start(sender,request,()=>{}))
assert.equal((await service.start(6,request,()=>{})).state,'refused')
service.invalidate();assert.equal((await Promise.all(pending)).every(r=>r.state==='stale'),true)
service.forget(1)
console.log('PASS validated path/root authority, closed root no spawn, per-sender supersession, root replacement stale discard, persistent worker cap, cancellation and cleanup')
const {registerGalleryStorageIPC}=await import('../src/main/vault-gallery-storage-ipc.ts')
const handlers={},frame={},sent=[];let destroyed,started=0
const sender={id:12,mainFrame:frame,isDestroyed:()=>false,once:(_event,fn)=>{destroyed=fn},send:(...args)=>sent.push(args)}
registerGalleryStorageIPC({handle:(name,callback)=>handlers[name]=callback},{...service,start:async(id,value,publish)=>{started++;assert.equal(id,12);validateInventoryRequest(value);publish({generation:value.generation});return {}},forget:id=>assert.equal(id,12)})
assert.throws(()=>handlers['vault:gallery-inventory']({senderFrame:{},sender},request),/Main frame/)
assert.equal(started,0)
await handlers['vault:gallery-inventory']({senderFrame:frame,sender},request)
assert.equal(sent.length,1);destroyed()
assert.throws(()=>handlers['vault:gallery-inventory-cancel']({senderFrame:frame,sender},'1'),/generation/)
assert.throws(()=>handlers['vault:gallery-inventory-cancel']({senderFrame:{},sender},1),/Main frame/)
console.log('PASS real IPC registration main-frame authority, sender-scoped progress/cancel, destruction cleanup and invalid cancellation rejection')
const retiring=[],waiting=[]
const held=createGalleryStorage({vault:()=>({id:'v',root:'/fixture',open:true}),unavailable:()=>false,epoch:()=>0,spawn:()=>{const listeners={};retiring.push(listeners);return {postMessage(){},kill(){return true},on:(event,callback)=>{listeners[event]=callback}}}})
for(let generation=1;generation<=4;generation++){waiting.push(held.start(99,{...request,generation},()=>{}));held.cancel(99,generation)}
assert.equal((await held.start(99,{...request,generation:5},()=>{})).state,'refused')
assert.equal(retiring.length,4)
retiring.forEach(listener=>listener.exit())
assert.equal((await Promise.all(waiting)).every(r=>r.state==='cancelled'),true)
console.log('PASS superseded workers retain global permits until actual exit; unresolved retirement cannot accumulate beyond four')
