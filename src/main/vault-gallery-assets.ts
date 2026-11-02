import {existsSync,mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs'
import {dirname,join,relative,isAbsolute,basename,extname} from 'node:path'
import {readGallerySource} from './vault-gallery-read.ts'
import {inventoryFilesystem} from './vault-gallery-inventory-fs.ts'
/** Demand-only private compiler snapshots. No source writes; bounded to one configured root. */
export function galleryAcquiredAssets(authority:{root:string;identity:{dev:number;ino:number};executable:string;cache:string;marker?:string}) {
 const cache=authority.marker ? dirname(authority.marker) : authority.cache
 mkdirSync(cache,{recursive:true})
 const dir=mkdtempSync(join(cache,'gallery-'))
 const held=new Map<string,string>();let bytes=0,closed=false
 const active=new Set<ReturnType<typeof inventoryFilesystem>>()
 const operations=new Set<Promise<unknown>>()
 const track=<T>(operation:Promise<T>)=>{operations.add(operation);operation.then(()=>operations.delete(operation),()=>operations.delete(operation));return operation}
 const started=Date.now()
 const inside=(file:string)=>{if(Date.now()-started>10000 || (authority.marker && !existsSync(authority.marker)))throw Error('Read request expired');const path=relative(authority.root,file);if(closed || !path || path==='..' || path.startsWith('../') || isAbsolute(path))throw Error('Asset outside approved root');return path}
 return {
  file(candidate:string){return track((async()=>{
   if(closed || Date.now()-started>10000 || (authority.marker && !existsSync(authority.marker)))throw Error('Gallery request expired')
   if(held.size>=128 && !held.has(candidate))throw Error('Asset count limit')
   try {
    inside(candidate)
    const hit=held.get(candidate);if(hit)return {ok:true,path:hit}
    if(held.size>=128)throw Error('Asset count limit')
    const acquired=await readGallerySource(authority.root,candidate,()=>!closed && Date.now()-started<=10000,authority.identity,authority.executable,authority.marker)
    bytes+=acquired.data.length;if(bytes>64*1024*1024)throw Error('Asset byte limit')
    const target=join(dir,String(held.size)+extname(candidate));writeFileSync(target,acquired.data,{flag:'wx'});held.set(candidate,target)
    return {ok:true,path:target}
   }catch{return {ok:false,reason:'outside'}}
  })())},
  list(candidate:string){return track((async()=>{
   const path=inside(candidate)
   const fs=inventoryFilesystem(authority.root,authority.executable,`${authority.identity.dev}:${authority.identity.ino}`,{marker:authority.marker,deadline:started+10000})
   active.add(fs)
   const names:string[]=[]
   try{await fs.identity();for await(const file of await fs.children(path)){inside(candidate);if(names.length>=128)throw Error('Capture listing limit');names.push(basename(file))}}finally{await fs.close();active.delete(fs)}
   inside(candidate)
   return names
  })())},
  async close(){closed=true;await Promise.allSettled([...active].map(fs=>fs.close()));await Promise.allSettled([...operations]);rmSync(dir,{recursive:true,force:true})}
 }
}
