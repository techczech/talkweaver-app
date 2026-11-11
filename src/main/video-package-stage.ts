import { lstatSync,mkdtempSync,mkdirSync,writeFileSync,renameSync,rmSync } from 'node:fs'
import {join,dirname} from 'node:path'

/** A package is private staging until one final rename. A replaced path is never cleaned up. */
export function createPackageStage(root:string){
  const parent=lstatSync(root)
  if(!parent.isDirectory()||parent.isSymbolicLink())throw new Error('The video package folder is not a local directory.')
  const path=mkdtempSync(join(root,'.video-stage-')),identity=lstatSync(path)
  const owned=new Map([[root,parent],[path,identity]])
  const guard=()=>{
    for(const [directory,before] of owned){
      const now=lstatSync(directory)
      if(now.isSymbolicLink()||!now.isDirectory()||now.dev!==before.dev||now.ino!==before.ino)throw new Error('The package staging folder changed. Nothing was published.')
    }
  }
  const folder=(name:string)=>{guard();const directory=join(path,name);mkdirSync(directory);owned.set(directory,lstatSync(directory))}
  const write=(name:string,body:string|Buffer)=>{guard();const target=join(path,name);if(!owned.has(dirname(target)))throw new Error('Unknown package staging directory.');writeFileSync(target,body,{flag:'wx'})}
  return{path,guard,folder,write,
    publish(final:string){
      guard()
      try{lstatSync(final);throw new Error('The new package folder already exists. Try again.')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
      renameSync(path,final)
    },
    cleanup(){try{guard();rmSync(path,{recursive:true})}catch{/* A changed path belongs to whoever replaced it. */}}
  }
}
