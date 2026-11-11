import { lstatSync,readFileSync,readdirSync,realpathSync,watch, type FSWatcher } from 'node:fs'
import { join, resolve, relative, sep, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import type { VideoPackStatus } from '../preload/index.ts'
import { assertPathInsideVault } from './talkTextPathSafety.ts'

const regular=(path:string,kind:'file'|'directory'):boolean=>{
  try {const s=lstatSync(path);return !s.isSymbolicLink() && (kind==='file'?s.isFile():s.isDirectory())}catch{return false}
}
function text(path:string,max:number):string {
  if(!regular(path,'file') || lstatSync(path).size>max)throw new Error('invalid-package-file')
  return readFileSync(path,'utf8')
}
export type VideoStatusSource={vault:string;talkDir:string;sessionId:string}
export type VideoLength=(file:string)=>Promise<number|null>

/** Resolve only this Run's package, rejecting links at every component beneath its vault. */
export function videoPackageTarget(source:VideoStatusSource,packageId:string,videoName?:string):string {
  if (typeof packageId !== 'string' || /[\\/\0]/.test(packageId) ||
      (!packageId.startsWith(source.sessionId+'-whole-run-') && !packageId.startsWith(source.sessionId+'-sections-'))) throw new Error('invalid-package-id')
  if (videoName !== undefined && (!videoName || /[\\/\0]/.test(videoName) || !videoName.toLowerCase().endsWith('.mp4'))) throw new Error('invalid-video-name')
  const folder=join(source.talkDir,'video-packs',packageId)
  const target=videoName===undefined?folder:join(folder,'out',videoName)
  const vault=resolve(source.vault),fromVault=relative(vault,resolve(target))
  if (!fromVault || fromVault==='..' || fromVault.startsWith('..'+sep) || isAbsolute(fromVault)) throw new Error('invalid-package-path')
  let path=vault
  const parts=fromVault.split(sep)
  for (let i=0;i<parts.length;i++) {
    path=join(path,parts[i])
    if (!regular(path,videoName!==undefined&&i===parts.length-1?'file':'directory')) throw new Error('unsafe-package-path')
  }
  if (videoName!==undefined && lstatSync(target).size===0) throw new Error('empty-video')
  assertPathInsideVault(source.vault,target)
  const canonical=realpathSync(target),inside=relative(realpathSync(folder),canonical)
  if (inside==='..' || inside.startsWith('..'+sep) || isAbsolute(inside)) throw new Error('outside-package')
  return canonical
}

/** Only completed package inputs and regular local MP4s are candidates; this function never writes. */
export async function videoPackageStatus(source:VideoStatusSource,length:VideoLength,packageId?:string):Promise<VideoPackStatus>{
  const root=join(source.talkDir,'video-packs')
  if(!regular(root,'directory'))return{state:'none'}
  assertPathInsideVault(source.vault,root)
  const versions:Array<Exclude<VideoPackStatus,{state:'none'}>>=[]
  for(const name of readdirSync(root)){
    if(packageId!==undefined && name!==packageId)continue
    if(!name.startsWith(source.sessionId+'-whole-run-') && !name.startsWith(source.sessionId+'-sections-'))continue
    const folder=join(root,name)
    if(!regular(folder,'directory'))continue
    try{
      assertPathInsideVault(source.vault,folder)
      const stretch=JSON.parse(text(join(folder,'stretch.json'),65536))
      if(stretch.sessionId!==undefined && stretch.sessionId!==source.sessionId)continue
      if(!Number.isFinite(stretch.durationMs)||stretch.durationMs<=0)continue
      const prompt=text(join(folder,'PROMPT.md'),1024*1024)
      const date=Date.parse(stretch.createdAt)
      const createdAt=new Date(Number.isFinite(date)?date:lstatSync(join(folder,'stretch.json')).mtimeMs).toISOString()
      const sections=Array.isArray(stretch.sections)&&stretch.sections.every((s:unknown)=>typeof s==='string')?stretch.sections:undefined
      const base={packageId:name,folder,prompt,createdAt,durationMs:stretch.durationMs as number,stretch:sections?.length?sections.join(' · '):name.startsWith(source.sessionId+'-sections-')?'Selected sections':'Whole Run'}
      const out=join(folder,'out'),videos:Array<{path:string;mtime:number;lengthMs:number}>=[]
      if(regular(out,'directory'))for(const file of readdirSync(out)){
        if(!file.toLowerCase().endsWith('.mp4'))continue
        const path=join(out,file)
        if(!regular(path,'file')||lstatSync(path).size===0)continue
        assertPathInsideVault(source.vault,path)
        const before=lstatSync(videoPackageTarget(source,name,file))
        const lengthMs=await length(path)
        const after=lstatSync(videoPackageTarget(source,name,file))
        if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)continue
        if(lengthMs!==null && Number.isFinite(lengthMs) && lengthMs>0)videos.push({path,mtime:lstatSync(path).mtimeMs,lengthMs})
      }
      videos.sort((a,b)=>b.mtime-a.mtime||a.path.localeCompare(b.path))
      const video=videos[0]
      versions.push(video?{...base,state:'ready',videoPath:video.path,lengthMs:video.lengthMs}:{...base,state:'waiting'})
    }catch{/* Incomplete, disappearing or malformed agent output is never repaired or removed. */}
  }
  versions.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.folder.localeCompare(a.folder))
  return versions.find(v=>v.state==='ready')??versions[0]??{state:'none'}
}

/** Header-only duration probe, cached until the file changes. No ffprobe binary is added. */
export function videoLengthReader(ffmpeg:()=>string|null):VideoLength{
  const cache=new Map<string,{stamp:string;value:number|null}>()
  return async file=>{
    const stat=lstatSync(file),stamp=`${stat.size}:${stat.mtimeMs}`,known=cache.get(file)
    if(known?.stamp===stamp)return known.value
    const executable=ffmpeg();if(!executable)return null
    const value=await new Promise<number|null>(resolve=>{
      const child=spawn(executable,['-nostdin','-hide_banner','-i',file,'-t','0','-f','null','-'],{stdio:['ignore','ignore','pipe']})
      let output='',done=false
      const finish=(value:number|null)=>{if(done)return;done=true;clearTimeout(timer);resolve(value)}
      const timer=setTimeout(()=>{child.kill('SIGKILL');finish(null)},5000);timer.unref()
      child.stderr.on('data',b=>{output=(output+String(b)).slice(-16000)})
      child.once('error',()=>finish(null))
      child.once('close',code=>{
        const match=/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(output)
        finish(code===0&&match?Math.round((Number(match[1])*3600+Number(match[2])*60+Number(match[3]))*1000):null)
      })
    })
    cache.set(file,{stamp,value});return value
  }
}

/** Native notifications plus reconciliation while subscribed: some macOS streams miss output writes.
 * IPC owns one reconciliation for all its Runs and passes zero to avoid one timer per talk. */
export function watchVideoPackages(source:VideoStatusSource,changed:()=>void,reconcileMs=2000):()=>void{
  let watcher:FSWatcher|undefined,timer:ReturnType<typeof setTimeout>|undefined,closed=false
  const talkDir=realpathSync(source.talkDir)
  const notify=()=>{if(timer)clearTimeout(timer);timer=setTimeout(()=>{if(!closed)changed()},300);timer.unref()}
  try{
    watcher=watch(talkDir,{recursive:true},(_event,name)=>{
      const file=String(name??'').replaceAll('\\','/')
      if(!file||file==='video-packs'||file.startsWith('video-packs/'))notify()
    })
    watcher.on('error',notify)
  }catch{/* closed or missing talk */}
  // A folder can be created in the same turn, before the native event stream is attached.
  notify()
  const reconcile=reconcileMs>0?setInterval(()=>{if(!closed)changed()},reconcileMs):undefined
  reconcile?.unref()
  return()=>{closed=true;if(timer)clearTimeout(timer);if(reconcile)clearInterval(reconcile);watcher?.close()}
}
