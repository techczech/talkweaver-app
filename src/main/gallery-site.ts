import { lstat } from 'node:fs/promises'
import { inventoryFilesystem } from './vault-gallery-inventory-fs.ts'
import type { SiteListing } from '../shared/published-pages.ts'
/** Scoped known folders only. Native metadata pins the root and refuses descendant links/aliases. */
export async function acquireGallerySite(root:string, folders:string[], current:()=>boolean, executable:string):Promise<SiteListing> {
 const result:SiteListing={exists:false,folders:[]}
 if(!current())throw Error('Cancelled')
 let identity
 try {identity=await lstat(root)}catch {return {...result,error:'Local site unavailable'}}
 if(!current())throw Error('Cancelled')
 if(!identity.isDirectory())return {...result,error:'Local site unavailable'}
 result.exists=true
 const fs=inventoryFilesystem(root,executable,`${identity.dev}:${identity.ino}`,{deadline:Date.now()+10000})
 // Closing stops pending native metadata as well as suppressing its reply.
 const cancellation=setInterval(()=>{if(!current())void fs.close()},25)
 try {
  for(const name of [...new Set(folders)].slice(0,128)){
   if(!current())throw Error('Cancelled')
   if(!name || /[\\/:\0]/.test(name) || name==='.' || name==='..'){result.error='Some local pages could not be inspected';continue}
   try {
    const directory=await fs.metadata(name)
    if(directory.kind!=='folder'){result.error='Some local pages could not be inspected';continue}
    const index=await fs.metadata(`${name}/index.html`)
    if(index.kind==='file')result.folders.push({name})
    else result.error='Some local pages could not be inspected'
   }catch {result.error='Some local pages could not be inspected'}
  }
  if(folders.length>128)result.error='Local page inspection incomplete'
  if(!current())throw Error('Cancelled')
  return result
 }finally{clearInterval(cancellation);await fs.close()}
}

/** One bounded scope per sending gallery generation; failed/pending results die with that scope. */
export function gallerySiteScope(acquire:typeof acquireGallerySite) {
 const scopes=new Map<number,{key:string;pages:Map<string,Promise<SiteListing>>}>()
 return {
  cancel(sender:number){scopes.delete(sender)},
  async read(sender:number,key:string,root:string,folders:string[],current:()=>boolean,executable:string){
   let scope=scopes.get(sender)
   if(!scope || scope.key!==key){scope={key,pages:new Map()};scopes.set(sender,scope)}
   const values:SiteListing[]=[]
   for(const folder of [...new Set(folders)].slice(0,128)){
    if(!current())throw Error('Cancelled')
    let pending=scope.pages.get(folder)
    if(!pending){
     if(scope.pages.size>=256)return {exists:true,folders:[],error:'Local page inspection incomplete'}
     pending=acquire(root,[folder],current,executable);scope.pages.set(folder,pending)
    }
    values.push(await pending)
   }
   if(!current() || scopes.get(sender)!==scope)throw Error('Cancelled')
   return {exists:values.some(v=>v.exists),folders:values.flatMap(v=>v.folders),...(values.some(v=>v.error)?{error:'Some local pages could not be inspected'}:{})}
  }
 }
}
