import { existsSync } from 'node:fs'
import { galleryChildLifetime } from './vault-gallery-child.ts'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { InventoryFS } from './vault-gallery-inventory'
/** The worker supplies the bundled helper; tests read exactly that source from this checkout. */
export function inventoryFilesystem(configuredRoot:string,executable:string,expectedIdentity = '', request?:{marker?:string;deadline:number}):InventoryFS {
 const child=spawn(executable,[configuredRoot,expectedIdentity,...(request?.marker ? ['--inventory',request.marker] : [])],{stdio:['pipe','pipe','pipe']})
 const lifetime=galleryChildLifetime(child,()=>!request?.marker || existsSync(request.marker),request?.deadline ?? Date.now()+60000)
 let sequence=0,closed=false
 const pending=new Map<number,{resolve(value:any):void;reject(error:Error):void}>()
 const fail=(reason:string)=>{closed=true;for(const p of pending.values())p.reject(Error(reason));pending.clear()}
 child.stdin.on('error',()=>{fail('Metadata request pipe closed');lifetime.stop()})
 child.on('error',()=>fail('Descriptor metadata runtime unavailable; inspection refused'))
 const exited=new Promise<void>(resolve=>child.on('close',()=>{fail('Metadata helper stopped');resolve()}))
 child.stderr.resume()
 const lines=createInterface({input:child.stdout})
 lines.on('line',line=>{
  if(lifetime.stopped){fail('Metadata request cancelled');return}
  if(line.length>65536){lifetime.stop();fail('Metadata reply exceeded bound');return}
  try {const r=JSON.parse(line),p=pending.get(r.id);if(!p)return;pending.delete(r.id);if(r.error)p.reject(Error(r.error));else p.resolve(r.value)}catch{lifetime.stop();fail('Invalid metadata reply')}
 })
 const call=(op:string,args:Record<string,unknown>={}):Promise<any>=>new Promise((resolve,reject)=>{
  if(closed){reject(Error('Metadata adapter closed'));return}
  const id=++sequence;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,op,...args})+'\n',error=>{if(error){pending.delete(id);reject(error)}})
 })
 return {
  identity:()=>call('identity'),metadata:path=>call('metadata',{path}),
  async *children(path){const key=await call('list',{path});try{let done=false;while(!done){const r=await call('next',{key});done=r.done;for(const name of r.batch)yield name}}finally{if(!closed)await call('end',{key})}},
  async close(){if(!closed){fail('Metadata adapter closed');child.stdin.end()}lifetime.stop();await exited;await lifetime.done;lines.close()}
 }
}
