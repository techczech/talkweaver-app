import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {createGalleryStorage} from '../../../src/main/vault-gallery-storage.ts'
let identity='original',child,exited=false
const storage=createGalleryStorage({vault:()=>({id:'v',root:'configured',open:true}),unavailable:()=>false,epoch:()=>1,acquire:()=>({root:'canonical',expectedIdentity:identity,executable:'bundled'}),spawn(){child=new EventEmitter();child.postMessage=()=>{};child.kill=()=>true;return child}})
const request={vaultId:'v',relativePath:'folder',generation:1,recursive:true,confirmedRoot:false}
const result=storage.start(1,request,()=>{})
child.emit('message',{...request,state:'complete',entries:[]})
identity='replacement';child.emit('exit',0)
assert.equal((await result).state,'stale')
console.log('PASS configured-root identity revalidation suppresses terminal publication when root changes before worker exit')
