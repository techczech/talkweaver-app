import { validateInventoryRequest, type InventoryResult } from '../shared/vault-gallery-storage.ts'
export interface InventoryChild { postMessage(value:unknown):void; kill():boolean; on(event:string,listener:(value:any)=>void):unknown }
interface Vault { id:string; root:string; open:boolean }
export function createGalleryStorage(deps:{vault(id:string):Vault|undefined;unavailable(id:string):boolean;epoch():number;spawn():InventoryChild;acquire?(root:string):{root:string;expectedIdentity:string;executable:string}}) {
 const jobs=new Map<number,{generation:number;stop(state?:'cancelled'|'stale'):void}>()
 const generations=new Map<number,number>()
 const workers=new Set<InventoryChild>()
 function cancel(sender:number,generation?:number){const job=jobs.get(sender);if(job && (generation===undefined || generation===job.generation))job.stop()}
 function forget(sender:number){cancel(sender);generations.delete(sender)}
 async function start(sender:number,value:unknown,publish:(r:InventoryResult)=>void):Promise<InventoryResult> {
  const r=validateInventoryRequest(value)
  if(r.generation<=(generations.get(sender)??-1))throw Error('Superseded inventory generation')
  cancel(sender);generations.set(sender,r.generation)
  const vault=deps.vault(r.vaultId), epoch=deps.epoch()
  const base:InventoryResult={...r,rootIdentity:null,checkedAt:new Date().toISOString(),entries:[],counted:0,unreadable:0,excluded:0,truncated:false,logicalBytes:null,allocatedBytes:null,allocationUnknown:0,state:'unavailable'}
  if(!vault?.open || deps.unavailable(r.vaultId))return {...base,reason:'Vault closed or unavailable; no traversal'}
  if(workers.size>=4)return {...base,state:'refused',reason:'Storage worker limit reached'}
  const root=vault.root
  let authority:{root:string;expectedIdentity:string;executable:string}|undefined
  try {authority=deps.acquire?.(root)}catch{return {...base,state:'refused',reason:'Configured root acquisition refused'}}
  const child=deps.spawn()
  workers.add(child)
  return new Promise(resolve=>{
   let ended=false,last=base
   let terminal:InventoryResult|null=null
   const finish=(result:InventoryResult)=>{if(ended)return;ended=true;clearTimeout(deadline);jobs.delete(sender);terminal=result;child.kill()}
   const deadline=setTimeout(()=>finish({...last,state:'partial',reason:'Storage inspection deadline reached'}),60000)
   const current=()=>{try{const v=deps.vault(r.vaultId);if(deps.epoch()!==epoch || !v?.open || v.root!==root || deps.unavailable(r.vaultId))return false;const now=deps.acquire?.(root);return !authority || (now?.root===authority.root && now?.expectedIdentity===authority.expectedIdentity)}catch{return false}}
   jobs.set(sender,{generation:r.generation,stop:(state='cancelled')=>finish({...last,state,reason:state==='stale'?'Vault configuration changed; coverage stale':'Stopped; coverage incomplete'})})
   child.on('message',(result:InventoryResult)=>{
    if(ended)return
    if(!current()){finish({...last,state:'stale',reason:'Vault identity or availability changed'});return}
    if(result.generation!==r.generation || result.vaultId!==r.vaultId)return
    last=result
    if(result.state==='running')publish(result);else finish(result)
   })
   child.on('exit',()=>{workers.delete(child);if(!ended){ended=true;clearTimeout(deadline);jobs.delete(sender)}resolve(!current() ? {...last,state:'stale',reason:'Vault identity or availability changed before worker exit'} : terminal??{...last,state:'partial',reason:'Storage worker exited before completion'})})
   try{child.postMessage({root,request:r,...authority})}catch{finish({...last,state:'refused',reason:'Storage worker could not start'})}
  })
 }
 function invalidate(){for(const j of [...jobs.values()])j.stop('stale')}
 return {start,cancel,forget,invalidate}
}
