import type { InventoryRequest, InventoryResult, InventoryKind } from '../shared/vault-gallery-storage'
export interface InventoryFS {
 identity():Promise<string>;
 metadata(path:string):Promise<{kind:InventoryKind;logical?:number|null;allocated?:number|null;reason?:string}>;
 children(path:string):AsyncIterable<string>|Promise<string[]>;
 close():Promise<void>;
}
/** One metadata operation at a time. Retention, visited work, depth and publications are bounded. */
export async function scanInventory(request:InventoryRequest, fs:InventoryFS, current:()=>boolean, publish:(r:InventoryResult)=>void) {
 const r:InventoryResult={...request,rootIdentity:null,checkedAt:new Date().toISOString(),state:'running',entries:[],counted:0,unreadable:0,excluded:0,truncated:false,logicalBytes:null,allocatedBytes:null,allocationUnknown:0}
 let logical=0,allocated=0, files=0, steps=0
 const check=async()=>{if(!current())throw Error('cancelled'); const id=await fs.identity();if(!current())throw Error('cancelled');if(r.rootIdentity && id!==r.rootIdentity)throw Error('stale');return id}
 const emit=()=>{r.checkedAt=new Date().toISOString();r.logicalBytes=files ? (r.unreadable && logical===0 ? null : logical) : (r.state==='complete' && request.recursive ? 0 : null);r.allocatedBytes=files && !r.allocationUnknown ? allocated : r.state==='complete' && request.recursive && !files ? 0 : null;publish({...r,entries:[...r.entries]})}
 const visit=async(path:string,depth:number):Promise<void>=>{
  if(++steps>20000 || depth>64){r.truncated=true;return}
  await check()
  let m:Awaited<ReturnType<InventoryFS['metadata']>>
  try {m=await fs.metadata(path)}catch(e) {r.unreadable++;if(r.entries.length<2000)r.entries.push({relativePath:path,kind:'other',logical:null,allocated:null,reason:`Metadata unavailable: ${(e as Error).message}`});return}
  await check()
  r.counted++
  const entry={relativePath:path,kind:m.kind,logical:m.logical??null,allocated:m.allocated??null,reason:m.reason}
  if(path!==request.relativePath || m.kind==='file') {if(r.entries.length<2000)r.entries.push(entry);else r.truncated=true}
  if(['link','alias','other'].includes(m.kind)){r.excluded++;r.allocationUnknown++;return}
  if(m.kind==='file'){files++;if(m.logical==null)r.unreadable++;else logical+=m.logical;if(m.allocated==null)r.allocationUnknown++;else allocated+=m.allocated;return}
  if(depth && !request.recursive)return
  try {
   await check()
   const children=await fs.children(path)
   for await(const child of children){
    await check()
    const name=child.slice(path ? path.length+1:0)
    if(!name || name.includes('/') || name==='.' || name==='..')throw Error('Invalid directory entry')
    await visit(child,depth+1)
    if(steps>=20000){r.truncated=true;break}
    if(r.counted%64===0)emit()
   }
  } catch(e){if(['cancelled','stale'].includes(String((e as Error).message)))throw e;r.unreadable++;r.reason=`Directory coverage incomplete at ${path || 'root'}: ${(e as Error).message}`}
 }
 try {r.rootIdentity=await check();await visit(request.relativePath,0);await check();r.state=r.unreadable || r.excluded || r.truncated ? 'partial':'complete'}
 catch(e){const reason=(e as Error).message;r.state=reason==='cancelled'?'cancelled':reason==='stale'?'stale':'refused';r.reason=reason}
 finally{await fs.close();emit()}
}
