import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, statSync, writeFileSync, renameSync, rmSync, readdirSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { spawn } from 'node:child_process'
import { transcriptPath, readRecordingSource, recordedSegmentPaths } from './recording-paths.ts'
import { normaliseTranscript } from './transcript-validation.ts'
import { withAlignment } from './alignment-result.ts'
import { modelPin, type AlignmentModels } from './alignment-models.ts'
import { alignmentChunks } from './alignment-chunks.ts'
import { sharedMidpoints, type Alphabet } from '../shared/word-alignment.ts'
import type { TranscriptRead } from './transcription.ts'
import type { WordAlignment } from '../shared/transcript-contract.ts'
import type { AlignmentRunState, AlignmentReply } from '../shared/alignment-status.ts'
export type AlignmentInference = {infer(pcm:Float32Array,words:string[],alphabet:Alphabet):Promise<WordAlignment[]>;check?():void;close():void}
export type AlignmentServiceDeps = {root:()=>string|null;isRootAvailable?:(root:string|null)=>boolean;userData:()=>string;ffmpeg:()=>string|null;models:()=>AlignmentModels;worker:(model:string,signal:AbortSignal,identity:{sha256:string;bytes:number;threads?:number})=>AlignmentInference;notify:(state:AlignmentRunState)=>void;decode?:typeof pcmChunk}
function pcmChunk(ffmpeg:string,path:string,offset:number,duration:number,signal:AbortSignal):Promise<Float32Array>{
  return new Promise((resolve,reject)=>{
    const child=spawn(ffmpeg,['-v','error','-ss',String(offset/1000),'-t',String(duration/1000),'-i',path,'-f','f32le','-ac','1','-ar','16000','-'],{stdio:['ignore','pipe','ignore'],windowsHide:true})
    const chunks:Buffer[]=[];let size=0
    const stop=():void=>{child.kill('SIGKILL')};signal.addEventListener('abort',stop,{once:true})
    const timer=setTimeout(stop,120000)
    child.stdout.on('data',(b:Buffer)=>{size+=b.length;if(size>2_000_000)stop();else chunks.push(b)})
    child.on('error',()=>{})
    child.once('close',code=>{clearTimeout(timer);signal.removeEventListener('abort',stop);if(code!==0 || size>2_000_000 || signal.aborted){reject(Error(signal.aborted?'cancelled':'Audio chunk could not be read'));return}const b=Buffer.concat(chunks);if(!b.length || b.length%4){reject(Error('Audio reader returned malformed PCM'));return}resolve(new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.length)))})
    if(signal.aborted)stop()
  })
}
export function createAlignmentService(deps:AlignmentServiceDeps){
  let active:AbortController|undefined,activeRun='',quitting=false,currentState:AlignmentRunState|undefined
  // A disappearing view is not a storage failure, especially after the atomic commit.
  const publish=(state:AlignmentRunState):void=>{try{deps.notify(state)}catch{}}
  const pending=new Map<string,{slug:string;sid:string;root:string|null;data:string}>()
  function drain():void{
    if(active || quitting)return
    for(const [key,next] of pending){pending.delete(key);if((deps.isRootAvailable?.(next.root)??deps.root()===next.root) && deps.userData()===next.data){void service.run(next.slug,next.sid,next.root);return}}
  }
  const service = {
    status(slug:unknown,sid:unknown,home?:string|null):AlignmentRunState|null {
      const root=home===undefined?deps.root():home
      if(!(deps.isRootAvailable?.(root)??deps.root()===root) || !transcriptPath(root,deps.userData(),slug,sid).ok)return null
      const key=JSON.stringify([root,slug,sid])
      if(activeRun===key && currentState)return currentState
      if(pending.has(key))return{sessionId:String(sid),home:root,state:'working',note:'Waiting to align words',progress:0}
      const t=service.read(slug,sid,home)
      return t?.alignment?{sessionId:String(sid),home:root,state:'done',note:`Words aligned; ${t.words?.filter(w=>w.alignment?.status==='unplaced').length??0} words kept their earlier times.`,progress:1}:null
    },
    read(slug:unknown,sid:unknown,home?:string|null):TranscriptRead|null {
      const root=home===undefined?deps.root():home
      if(!(deps.isRootAvailable?.(root)??deps.root()===root))return null
      const target=transcriptPath(root,deps.userData(),slug,sid);if(!target.ok)return null
      try{const t=normaliseTranscript(JSON.parse(readFileSync(target.path,'utf8')));return t?{...t,hasWords:!!t.words?.length}:null}catch{return null}
    },
    cancel(slug?:unknown,sid?:unknown,home?:string|null):boolean{
      if(slug===undefined && sid===undefined){pending.delete(activeRun);active?.abort();return true}
      const root=home===undefined?deps.root():home
      if(!(deps.isRootAvailable?.(root)??deps.root()===root) || !transcriptPath(root,deps.userData(),slug,sid).ok)return false
      const key=JSON.stringify([root,slug,sid]),queued=pending.delete(key)
      if(activeRun===key)active?.abort()
      else if(queued)publish({sessionId:String(sid),home:root,state:'cancelled',note:'cancelled'})
      return true
    },
    quit():void{quitting=true;pending.clear();active?.abort()},
    enqueue(slug:string,sid:string,home?:string|null):void{
      if(quitting)return
      const root=home===undefined?deps.root():home
      const key=JSON.stringify([root,slug,sid]);pending.set(key,{slug,sid,root,data:deps.userData()})
      if(activeRun===key)active?.abort()
      drain()
    },
    async run(slug:unknown,sid:unknown,home?:string|null):Promise<AlignmentReply>{
      if(active || quitting)return{ok:false,error:quitting?'The app is closing.':'Another alignment is running.'}
      const root=home===undefined?deps.root():home,data=deps.userData()
      if(!(deps.isRootAvailable?.(root)??deps.root()===root))return{ok:false,error:'The Run’s vault is unavailable.'}
      const target=transcriptPath(root,data,slug,sid)
      if(!target.ok)return{ok:false,error:target.error}
      const controller=new AbortController();active=controller;activeRun=JSON.stringify([root,slug,sid])
      const notify=(state:AlignmentRunState['state'],note:string,progress?:number):void=>{currentState={sessionId:String(sid),home:root,state,note,progress};publish(currentState)}
      let worker:AlignmentInference|undefined,temp:string|undefined
      try {
        // Recover only this Run's exact crash-temp names, and only after ESRCH proves a dead owner.
        const prefix=basename(target.path)+'.'
        for(const name of readdirSync(dirname(target.path))){
          if(!name.startsWith(prefix))continue
          const match=/^([1-9][0-9]*)\.([a-z0-9]+[a-f0-9]{8})\.tmp$/.exec(name.slice(prefix.length))
          if(!match)continue
          const pid=Number(match[1]);if(!Number.isSafeInteger(pid) || pid===process.pid)continue
          try{process.kill(pid,0)}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')try{rmSync(join(dirname(target.path),name))}catch{}}
        }
        const originalBytes=readFileSync(target.path,'utf8'),rawOriginal=JSON.parse(originalBytes),original=normaliseTranscript(rawOriginal)
        if(!original?.words?.length || original.timingClock!=='recording-v2')throw Error('Write out this Run again before aligning its words.')
        const manifest=deps.models().manifest(original.locale??'')
        if(!manifest)throw Error('Precise word timing is not available yet for this language. Open Settings › Recording.')
        const stamp=():string=>{
          const source=readRecordingSource(root,data,String(slug),String(sid)),segments=recordedSegmentPaths(data,sid,source)
          return createHash('sha256').update(JSON.stringify([source?.kind,(source?.record as {audio?:unknown})?.audio,segments.map(s=>{const st=statSync(s.path);return[s,st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs]})])).digest('hex')
        }
        const initialStamp=stamp()
        let modelUnchanged:(()=>boolean)|undefined
        const guard=():void=>{worker?.check?.();if(modelUnchanged && !modelUnchanged())throw Error('The model changed; earlier timings were kept.');const currentTarget=transcriptPath(root,data,slug,sid);if(!currentTarget.ok || currentTarget.path!==target.path)throw Error('Transcript location changed');if(controller.signal.aborted || quitting)throw Error('cancelled');if(!(deps.isRootAvailable?.(root)??deps.root()===root) || deps.userData()!==data || stamp()!==initialStamp || readFileSync(target.path,'utf8')!==originalBytes)throw Error('The Run or transcript changed; earlier timings were kept.')}
        notify('working','Checking precise word timing model',0)
        const model=await deps.models().store.usable(modelPin(manifest));guard()
        if(!model)throw Error('Download or install Precise word timing in Settings › Recording first.')
        const modelStamp=():string=>{const s=statSync(model);return JSON.stringify([s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs])}
        const modelStat=modelStamp(),ffmpeg=deps.ffmpeg()
        modelUnchanged=()=>modelStamp()===modelStat
        if(!ffmpeg)throw Error('The audio reader is unavailable.')
        const segments=recordedSegmentPaths(data,sid,readRecordingSource(root,data,String(slug),String(sid)))
        const chunks=alignmentChunks(original.words,original.silence??[],segments.map(s=>({start:s.startMs,end:s.endMs})),20000)
        worker=deps.worker(model,controller.signal,{sha256:manifest.sha256,bytes:manifest.bytes,threads:manifest.threads??2})
        const placements:WordAlignment[]=original.words.map(()=>({status:'unplaced',confidence:0,normalised:'',unsupported:[],reason:'path'}))
        let previousContext:Map<number,WordAlignment>|undefined, previousSegment:string|undefined
        for(let n=0;n<chunks.length;n++){
          guard();const chunk=chunks[n],segment=segments.find(s=>s.startMs<=chunk.start && s.endMs>=chunk.end)
          if(!segment)throw Error('Chunk crosses a Run segment gap')
          let first=Math.max(chunk.firstWord-2,original.words.findIndex(w=>w.start>=segment.startMs));const last=Math.min(original.words.length-1,chunk.lastWord+2)
          while(first<chunk.firstWord && original.words[first].end<chunk.start-1000)first++
          let stop=last;while(stop>chunk.lastWord && (original.words[stop].end>segment.endMs || original.words[stop].start>chunk.end+1000))stop--
          const start=Math.max(segment.startMs,Math.min(chunk.start,original.words[first].start)-1000),end=Math.min(segment.endMs,Math.max(chunk.end,original.words[stop].end)+1000)
          if(end-start>30000)throw Error('Word context exceeds the bounded chunk size')
          const pcm=await (deps.decode??pcmChunk)(ffmpeg,segment.path,start-segment.startMs,end-start,controller.signal);guard()
          const aligned=await worker.infer(pcm,original.words.slice(first,stop+1).map(w=>w.text),manifest.alphabet);guard()
          if(aligned.length!==stop-first+1)throw Error('Alignment word count changed')
          const context=new Map<number,WordAlignment>()
          aligned.forEach((w,i)=>context.set(first+i,w.status==='aligned'?{...w,start:w.start!+start,end:w.end!+start}:w))
          for(let i=chunk.firstWord;i<=chunk.lastWord;i++)placements[i]=context.get(i)!
          if(previousContext && previousSegment===segment.path && !(original.silence??[]).some(s=>s.start<=chunk.start && s.end>=chunk.start && s.end-s.start>=500)){
            const overlap=[...context.keys()].filter(i=>previousContext!.has(i))
            const consistent=overlap.length>=2 && overlap.every(i=>{const a=context.get(i)!,b=previousContext!.get(i)!;return a.status==='aligned' && b.status==='aligned' && Math.abs(a.start!-b.start!)<=80 && Math.abs(a.end!-b.end!)<=80})
            if(!consistent)for(const i of [chunk.firstWord-1,chunk.firstWord])if(i>=0)placements[i]={status:'unplaced',confidence:0,normalised:context.get(i)?.normalised??placements[i].normalised,unsupported:placements[i].unsupported,reason:placements[i].unsupported.length?'alphabet':'path'}
          }
          previousContext=context;previousSegment=segment.path
          notify('working',`Aligning words: ${n+1} of ${chunks.length} sections`,(n+1)/chunks.length)
        }
        // Removing only the later overlap preserves the last kept edge. A forward pass is
        // already a fixed point: removing a later word cannot invalidate an earlier pair.
        let lastKeptEnd=0
        for(let i=0;i<placements.length;i++)if(placements[i].status==='aligned'){
          if(placements[i].start!<lastKeptEnd)placements[i]={status:'unplaced',confidence:placements[i].confidence,normalised:placements[i].normalised,unsupported:[],reason:'path'}
          else lastKeptEnd=placements[i].end!
        }
        if(modelStamp()!==modelStat || !await deps.models().store.usable(modelPin(manifest)))throw Error('The model changed; earlier timings were kept.')
        guard()
        const candidate=withAlignment(rawOriginal,{version:1,model:manifest.name,revision:manifest.revision,sha256:manifest.sha256,alignedAt:new Date().toISOString(),normalisation:'ctc-nfc-v1',midpoints:sharedMidpoints(placements.map(w=>w.status==='aligned'?{start:w.start!,end:w.end!,confidence:w.confidence}:null))},placements)
        temp=`${target.path}.${process.pid}.${Date.now().toString(36)}${randomBytes(4).toString('hex')}.tmp`
        writeFileSync(temp,JSON.stringify(candidate,null,2),{encoding:'utf8',flag:'wx',flush:true})
        guard();renameSync(temp,target.path);temp=undefined
        notify('done',`Words aligned; ${placements.filter(w=>w.status==='unplaced').length} words kept their earlier times.`,1)
        return{ok:true}
      }catch(e){const error=controller.signal.aborted?'cancelled':e instanceof Error?e.message:'Alignment failed; earlier timings were kept.';notify(controller.signal.aborted?'cancelled':'failed',error);return{ok:false,error}}
      finally{worker?.close();if(temp)try{rmSync(temp,{force:true})}catch{};if(active===controller){active=undefined;activeRun='';currentState=undefined;queueMicrotask(drain)}}
    }
  }
  return service
}
