import { useEffect,useState } from 'react'
import { Copy,Film,Folder,Play } from 'lucide-react'
import type { RecordingSession,VideoPackStatus } from '../../../preload/index'
import { recordingRunHome,recordingRunKey } from '../../../shared/recording-run-home'
import '../animated-video.css'
export const videoRunInput=(run:RecordingSession)=>({talkSlug:run.talkSlug,sessionId:run.id,home:recordingRunHome(run)})
export function useVideoPackageStatuses(runs:RecordingSession[]):Record<string,VideoPackStatus>{
  const [states,setStates]=useState<Record<string,VideoPackStatus>>({})
  useEffect(()=>{
    const bridge=window.tw?.videoPack
    if(!bridge||typeof bridge.onStatus!=='function'||typeof bridge.watch!=='function'||typeof bridge.unwatch!=='function'){setStates({});return}
    let active=true,updated=false
    const accept=(next:Record<string,VideoPackStatus>)=>{if(active)setStates(next)}
    const off=bridge.onStatus(next=>{updated=true;accept(next)})
    void bridge.watch(runs.map(videoRunInput)).then(next=>{if(!updated)accept(next)}).catch(()=>accept({}))
    return()=>{active=false;off();void bridge.unwatch()}
  },[runs])
  return states
}
export function AnimatedVideoChip({status}:{status:VideoPackStatus|undefined}):JSX.Element|null{
  return status&&status.state!=='none'?<span className={`av-status-chip ${status.state}`}>{status.state==='ready'?'Video ready':'Video pending'}</span>:null
}
export function AnimatedVideoStatus({run,status}:{run:RecordingSession;status:VideoPackStatus|undefined}):JSX.Element|null{
  const [notice,setNotice]=useState<string|null>(null)
  const version=status&&status.state!=='none'?status.folder:''
  useEffect(()=>setNotice(null),[version,status?.state])
  if(!status||status.state==='none')return null
  const ready=status.state==='ready'
  const copy=async()=>{try{await navigator.clipboard.writeText(status.prompt);setNotice('Prompt copied.')}catch{setNotice('The prompt could not be copied. Open the package folder and copy PROMPT.md.')}}
  const play=async()=>{try{if(!await window.tw.videoPack.play({...videoRunInput(run),packageId:status.packageId}))setNotice('The video could not be opened. Show it in Finder to open it.')}catch{setNotice('The video could not be opened. Show it in Finder to open it.')}}
  const reveal=async()=>{try{if(!await window.tw.videoPack.reveal({...videoRunInput(run),packageId:status.packageId},ready?'video':'package'))setNotice('The package could not be shown in Finder.')}catch{setNotice('The package could not be shown in Finder.')}}
  const length=ready?`${Math.floor(status.lengthMs/60000)}:${String(Math.floor(status.lengthMs/1000)%60).padStart(2,'0')}`:''
  return <section className="av-status-card" aria-label="Animated video">
    <div className="av-eyebrow"><Film aria-hidden/>Animated video</div>
    <h3>{ready?`Animated video ready · ${length}`:'Package made, waiting for the video'}</h3>
    <p>{ready?`Made from “${status.stretch}”, ${new Date(status.createdAt).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}.`:'Paste the prompt into an agent session opened on the package folder. The finished video shows up here by itself.'}</p>
    <div className="av-status-actions">{ready?<button className="pr-btn" onClick={()=>{void play()}}><Play aria-hidden/>Play</button>:<button className="pr-btn" onClick={()=>{void copy()}}><Copy aria-hidden/>Copy prompt</button>}<button className="pr-btn pr-btn-plain" onClick={()=>{void reveal()}}><Folder aria-hidden/>Show in Finder</button></div>
    {notice?<p role="status">{notice}</p>:null}
  </section>
}
