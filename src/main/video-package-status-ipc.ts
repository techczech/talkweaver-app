import { ipcMain } from 'electron'
import { dirname, basename } from 'node:path'
import type { VideoPackRequest, VideoPackStatus } from '../preload/index'
import type { VideoPackHost } from './video-package-ipc'
import { videoPackageStatus, videoPackageTarget, videoLengthReader,watchVideoPackages,type VideoStatusSource,type VideoLength } from './video-package-status'
import { recordingRunKey } from '../shared/recording-run-home'
import { isToolsWindowSender } from './talkTextSender'

export function registerVideoPackageStatusIpc(host:VideoPackHost,rootsFor:(input:VideoPackRequest)=>{vault:string}, testDeps?:{ipc?:Pick<typeof ipcMain,'handle'>;length?:VideoLength;watch?:typeof watchVideoPackages}){
  const ipc=testDeps?.ipc??ipcMain, watch=testDeps?.watch??watchVideoPackages
  const length=testDeps?.length??videoLengthReader(()=>{const f=host.transcription.readiness().ffmpeg;return f.found?f.path:null})
  const source=async(input:VideoPackRequest):Promise<VideoStatusSource>=>{
    const {vault}=rootsFor(input)
    const talk=(await host.listTalks(vault)).find(t=>t.slug===input.talkSlug)
    if(!talk)throw new Error('Talk not found')
    return{vault,talkDir:dirname(talk.outlinePath),sessionId:input.sessionId}
  }
  let stop:(()=>void)|undefined,generation=0
  let refreshCurrent:(()=>Promise<void>)|undefined
  ipc.handle('video-pack:watch',async(event,inputs:VideoPackRequest[])=>{
    if(!isToolsWindowSender(event.sender,host.toolsWindow())||!Array.isArray(inputs))return{}
    stop?.();const current=++generation
    let disposed=false
    const closers:Array<()=>void>=[]
    const close=()=>{if(disposed)return;disposed=true;closers.forEach(fn=>fn());event.sender.removeListener('destroyed',close);if(stop===close){stop=undefined;refreshCurrent=undefined}}
    stop=close;event.sender.once('destroyed',close)
    const alive=()=>!disposed&&current===generation&&!event.sender.isDestroyed()&&isToolsWindowSender(event.sender,host.toolsWindow())
    if(!alive()){close();return{}}
    const picked=await Promise.all(inputs.map(async input=>{try{return{input,source:await source(input)}}catch{return null}}))
    if(!alive()){close();return{}}
    let updating=false,again=false
    const read=async()=>{
      const pairs=await Promise.all(picked.filter(p=>p!==null).map(async p=>{
        let state:VideoPackStatus={state:'none'}
        try{if(rootsFor(p.input).vault===p.source.vault)state=await videoPackageStatus(p.source,length)}catch{/* unavailable vault */}
        return[recordingRunKey({id:p.input.sessionId,talkSlug:p.input.talkSlug,home:p.input.home}),state] as const
      }))
      return Object.fromEntries(pairs)
    }
    const refresh=async()=>{
      if(updating){again=true;return}
      updating=true
      try{do{again=false;const states=await read();if(!disposed&&!event.sender.isDestroyed())event.sender.send('video-pack:status',states)}while(again&&!disposed)}finally{updating=false}
    }
    const unique=new Map(picked.filter(p=>p!==null).map(p=>[p.source.talkDir,p.source]))
    try{for(const s of unique.values())closers.push(watch(s,()=>{void refresh()},0))}
    catch{close();return{}}
    refreshCurrent=async()=>{if(alive())await refresh()}
    const states=await read()
    if(!alive())return{}
    if(unique.size){
      // One timer for this live subscription, rather than one per recorded talk.
      const reconcile=setInterval(()=>{void refresh()},2000);reconcile.unref()
      closers.push(()=>clearInterval(reconcile))
    }
    return states
  })
  ipc.handle('video-pack:unwatch',event=>{if(isToolsWindowSender(event.sender,host.toolsWindow())){generation++;stop?.();stop=undefined}})
  const act=async(event:{sender:Electron.WebContents},input:VideoPackRequest&{packageId:string},action:'play'|'video'|'package'):Promise<boolean>=>{
    if(!isToolsWindowSender(event.sender,host.toolsWindow()))return false
    try{
      if(typeof input?.packageId!=='string')return false
      const selected=await source(input)
      if(event.sender.isDestroyed()||!isToolsWindowSender(event.sender,host.toolsWindow()))return false
      if(action==='package'){
        const path=videoPackageTarget(selected,input.packageId)
        host.revealVideo(path)
        return true
      }
      const state=await videoPackageStatus(selected,length,input.packageId)
      if(state.state!=='ready'||event.sender.isDestroyed()||!isToolsWindowSender(event.sender,host.toolsWindow()))return false
      // No await between this final resolution and the OS operation.
      const path=videoPackageTarget(selected,input.packageId,basename(state.videoPath))
      if(action==='play')return await host.openVideo(path)
      host.revealVideo(path)
      return true
    }catch{return false}
  }
  ipc.handle('video-pack:play',(event,input:VideoPackRequest&{packageId:string})=>act(event,input,'play'))
  ipc.handle('video-pack:reveal',(event,input:VideoPackRequest&{packageId:string},target:unknown)=>target==='video'||target==='package'?act(event,input,target):false)
  // App-owned package writes need no native filesystem event to acknowledge completion.
  // Keep the watcher for agent-owned output; a disposed subscription is never revived here.
  return async():Promise<void>=>{try{await refreshCurrent?.()}catch{/* Status failure cannot invalidate a completed package. */}}
}
