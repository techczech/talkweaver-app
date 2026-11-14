import { registerVideoPackageStatusIpc } from './video-package-status-ipc'
import { ipcMain, type BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import type { VideoPackRequest, RecordingSession } from '../preload/index'
import { createVideoPackage } from './video-package'
import { videoPackageWords } from './video-package-words'
import { resolveTalkTextPaths, assertPathInsideVault } from './talkTextPathSafety'
import { audibleSegmentPaths, readRecordingSource, recordedSegmentPaths } from './recording-paths'
import { createTranscription, type TranscriptionDeps } from './transcription'
import { deckPicturesOf, rowImageRefs, resolveImagePaths } from './slide-image-refs'
import { renderThumbnails, cancelThumbnailRender } from './thumbnails'
import { isToolsWindowSender } from './talkTextSender'

export type VideoPackHost = {
  vaultRoot: () => string | null
  vaultForHome: (home: string) => string | null
  toolsWindow: () => BrowserWindow | null
  userDataDir: () => string
  listTalks: (root: string) => Promise<Array<{slug:string;outlinePath:string}>>
  prepare: (outlinePath:string, text:string, options?: {run:RecordingSession}) => Promise<{ rows: Array<Record<string,unknown>> | null; model: Record<string,unknown> } | null>
  tokensCss: () => string
  openVideo: (path:string) => Promise<boolean>
  revealVideo: (path:string) => void
  transcription: TranscriptionDeps
}

export function registerVideoPackageIpc(host: VideoPackHost) {
  let owner: number | null = null
  const rootsFor = (input: VideoPackRequest) => {
    if (!input || typeof input !== 'object' || (input.home !== undefined && input.home !== null && typeof input.home !== 'string')) throw new Error('Choose a recorded Run.')
    const vault = typeof input.home === 'string' ? host.vaultForHome(input.home) : host.vaultRoot()
    if (!vault) throw new Error('Open this Run’s vault first.')
    resolveTalkTextPaths(vault,input.talkSlug,input.sessionId)
    return {vault,recordingRoot:input.home===null?null:vault}
  }
  ipcMain.handle('video-pack:slides',async(event,input:VideoPackRequest)=>{
    if(!isToolsWindowSender(event.sender,host.toolsWindow()))return null
    try{
      const {vault,recordingRoot}=rootsFor(input)
      const talk=(await host.listTalks(vault)).find(t=>t.slug===input.talkSlug)
      const recording=readRecordingSource(recordingRoot,host.userDataDir(),input.talkSlug,input.sessionId)
      if(!talk||recording?.kind!=='run')return null
      const outline=assertPathInsideVault(vault,talk.outlinePath)
      return(await host.prepare(outline,readFileSync(outline,'utf8'),{run:recording.record as unknown as RecordingSession}))?.rows??null
    }catch{return null}
  })
  const packageWritten=registerVideoPackageStatusIpc(host,rootsFor)
  ipcMain.handle('video-pack:word-status',async(event,input:VideoPackRequest)=>{
    if (!isToolsWindowSender(event.sender,host.toolsWindow())) return {ok:false,error:'Open the Run in Studio first.'}
    try {
      const {recordingRoot}=rootsFor(input)
      const transcript=await createTranscription({...host.transcription,vaultRoot:()=>recordingRoot}).get(input.talkSlug,input.sessionId)
      const ready=host.transcription.readiness()
      return {ok:true,hasWords:transcript?.hasWords===true,canTranscribe:ready.row.state==='ready',ffmpegFound:ready.ffmpeg.found}
    } catch(e) { return {ok:false,error:e instanceof Error?e.message:String(e)} }
  })
  const service = createVideoPackage({ source: async (input) => {
    const {vault,recordingRoot}=rootsFor(input)
    const talk = (await host.listTalks(vault)).find(t=>t.slug === input.talkSlug)
    if (!talk) throw new Error('The talk could not be found in this vault.')
    const outline = assertPathInsideVault(vault,talk.outlinePath)
    const recording = readRecordingSource(recordingRoot,host.userDataDir(),input.talkSlug,input.sessionId)
    if (!recording || recording.kind !== 'run') throw new Error('The recorded Run could not be found.')
    const run = recording.record as unknown as RecordingSession
    const listed = recordedSegmentPaths(host.userDataDir(),input.sessionId,recording)
    if (!listed.length || (Array.isArray(run.audio?.segments) && listed.length !== run.audio.segments.length)) throw new Error('Part of the local recording is missing.')
    // Empty segments (a 0-byte file, no recorded span) hold no audio and are left out.
    const ready = host.transcription.readiness()
    if (!ready.ffmpeg.found) throw new Error('ffmpeg could not be found. Check Settings → Get started → Transcription.')
    const segments = await audibleSegmentPaths(host.userDataDir(),input.sessionId,recording,ready.ffmpeg.path)
    if (!segments.length) throw new Error('The local recording has no audio segments.')
    run.recordingMs = Math.max(run.recordingMs || 0, ...segments.map(s => s.endMs))
    const text = readFileSync(outline,'utf8')
    const prepared = await host.prepare(outline,text,{run})
    if (!prepared?.rows || typeof prepared.model.fullHtml !== 'string') throw new Error('The talk could not be compiled.')
    const deck = deckPicturesOf(text)
    const slides = prepared.rows.map(row=>{
      const refs=rowImageRefs(row,deck)
      const imageRefs=Object.fromEntries(refs.flatMap(ref=>{const path=resolveImagePaths([ref],dirname(outline),vault)[0];return path?[[ref.ref,path]]:[]}))
      return {
        id:String(row.slide_id),title:String(row.nav_title || row.title || row.slide_id),section:String(row.section || 'Opening'),
        layout:String(row.layout || ''),markdown:String(row.source_markdown || ''),
        images:resolveImagePaths(refs,dirname(outline),vault),imageRefs,
        missingImages:refs.some(ref=>ref.kind==='picture' && !imageRefs[ref.ref])
      }
    })
    const key = `video-package:${owner}:${input.sessionId}`
    const fullHtml = prepared.model.fullHtml
    return {
      vault,talkDir:dirname(outline),run,slides,segments,ffmpeg:ready.ffmpeg.path,tokensCss:host.tokensCss(),
      look:{palette:prepared.model.palette ?? '', deckFont:prepared.model.deckFont ?? '',
        sections:(Array.isArray(prepared.model.slides)?prepared.model.slides:[]).filter((s:Record<string,unknown>)=>slides.some(row=>row.id===s.id)).map((s:Record<string,unknown>)=>({slideId:s.id,section:s.section,accent:s.sectionAccent}))},
      words: (signal) => videoPackageWords(createTranscription({...host.transcription,vaultRoot:()=>recordingRoot}),input,signal),
      render: async (selected,directory,signal,beforeWrite) => {
        const cancel=()=>cancelThumbnailRender(key)
        signal.addEventListener('abort',cancel,{once:true})
        try {
          if (signal.aborted) throw new Error('Package cancelled.')
          return await renderThumbnails({fullHtml,beforeWrite,cacheDir:directory,requestKey:key,shouldYield:()=>signal.aborted,slides:selected.map(s=>({key:s.id,cacheKey:createHash('sha256').update(s.id).digest('hex'),index:slides.findIndex(row=>row.id===s.id),layout:s.layout}))})
        } finally {signal.removeEventListener('abort',cancel)}
      }
    }
  }})
  ipcMain.handle('video-pack:make',async(event,input:VideoPackRequest)=>{
    if (!isToolsWindowSender(event.sender,host.toolsWindow())) return {ok:false,error:'Open the Run in Studio first.'}
    if (owner !== null) return {ok:false,error:'Another video package is being made.'}
    owner=event.sender.id
    const stopped=()=>service.cancel()
    event.sender.once('destroyed',stopped)
    try {
      const result=await service.make(input,p=>{if (!event.sender.isDestroyed()) event.sender.send('video-pack:progress',p)})
      if(result.ok)await packageWritten()
      return result
    }
    finally {event.sender.removeListener('destroyed',stopped);owner=null}
  })
  ipcMain.handle('video-pack:cancel',event=>{if(event.sender.id === owner) service.cancel()})
  return { cancel:()=>service.cancel() }
}
