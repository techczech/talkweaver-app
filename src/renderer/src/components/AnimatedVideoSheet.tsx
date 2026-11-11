import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Film, Folder, AlertTriangle } from 'lucide-react'
import type { RecordingSession, VideoPackProgress, VideoPackResult } from '../../../preload/index'
import { recordingClock } from '../../../shared/recording-clock'
import { recordingRunHome, recordingRunKey } from '../../../shared/recording-run-home'
import { videoWindows, selectedVideoRanges, videoGaps } from '../../../shared/video-package-timeline'
import { LAYOUTS } from '../../../shared/layout-registry/entries'
import { useToolsActions, type VideoRequestTarget } from '../lib/toolsActions'
import { commandRan } from '../commands/command-ran'
import '../plan-run.css'
import '../animated-video.css'

export type VideoSheetSlide = { title: string; section: string; thumbUrl: string | null; tag: string }
type Props = { run: RecordingSession; slides: Record<string,VideoSheetSlide>; onClose: () => void; onShowTalkFolder: () => Promise<void>; hasPackage?:boolean }
const duration = (ms:number):string => `${Math.floor(ms/60000)}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}`
const stepNames = ['Cutting the audio','Word timings','Slides','Images'] as const
const steps: VideoPackProgress['step'][] = ['audio','words','slides','images']
const layoutLabel = (tag:string):string => LAYOUTS.find(layout=>layout.name===tag)?.label ?? tag
const defaultChoice = (layout?:string):'animate'|'keep' => ['code','image-grid'].includes(layout??'')?'keep':'animate'

export function AnimatedVideoAction({run,slides,onShowTalkFolder,hasPackage,videoRequest,onVideoRequestHandled}:Omit<Props,'onClose'>&{videoRequest?:VideoRequestTarget|null;onVideoRequestHandled?:()=>void}):JSX.Element {
  const [open,setOpen]=useState(false)
  const ready=Boolean(run.audio) && Object.keys(slides).length>0
  useEffect(()=>{
    if(ready&&videoRequest&&videoRequest.talk===run.talkSlug&&videoRequest.home===recordingRunHome(run)&&videoRequest.recordingRunKey===recordingRunKey(run)){
      setOpen(true)
      onVideoRequestHandled?.()
    }
  },[ready,videoRequest,run.talkSlug,run.home,run.id,run.kept,onVideoRequestHandled])
  const show=():void=>{ if(ready) {commandRan('tools-animated-video');setOpen(true)} }
  useToolsActions({'tools-animated-video':{enabled:ready && !open,run:()=>setOpen(true)}})
  return <>
    <button className="tws-ts-retry" disabled={!ready} title={!run.audio?'This Run has no audio.':!ready?'The slides are still loading.':'Make a package an agent can turn into an animated video.'} onClick={show}><Film className="lt-icon"/>Animated video…</button>
    {hasPackage?<button className="tws-ts-retry" disabled={!ready} onClick={show}>New version…</button>:null}
    {open?<AnimatedVideoSheet run={run} slides={slides} onClose={()=>setOpen(false)} onShowTalkFolder={onShowTalkFolder}/>:null}
  </>
}

export function AnimatedVideoSheet({run,slides,onClose,onShowTalkFolder}:Props):JSX.Element {
  const [whole,setWhole]=useState(true)
  const [sections,setSections]=useState<string[]>([])
  const [choices,setChoices]=useState<Record<string,'animate'|'keep'>>({})
  const [wordState,setWordState]=useState<'loading'|'ready'|'make'|'missing'|'encoder'|'failed'>('loading')
  const [checkAgain,setCheckAgain]=useState(0)
  const [stage,setStage]=useState<'choose'|'progress'|'done'|'error'>('choose')
  const [step,setStep]=useState(0)
  const [error,setError]=useState<string|null>(null)
  const [result,setResult]=useState<Extract<VideoPackResult,{ok:true}>|null>(null)
  const [notice,setNotice]=useState<string|null>(null)
  const [cancelling,setCancelling]=useState(false)
  const dialog=useRef<HTMLDivElement>(null)
  const mounted=useRef(true), busy=useRef(false), cancelled=useRef(false)
  const derived=useMemo(()=>{
    try {
      const rows=Object.entries(slides).map(([id,s])=>({id,title:s.title,section:s.section||'Opening',layout:s.tag,markdown:'',images:[]}))
      const windows=videoWindows(run,rows)
      const allSections=[...new Set(windows.map(w=>w.section))]
      const ranges=whole?selectedVideoRanges(windows,run.recordingMs,undefined,run.trims):sections.length?selectedVideoRanges(windows,run.recordingMs,sections,run.trims):[]
      const selected=[...new Set(windows.filter(w=>ranges.some(r=>w.start<r.end && w.end>r.start)).map(w=>w.slideId))]
      const gaps=run.audio?.segments&&!recordingClock(run.audio.segments).legacy?videoGaps(run.audio.segments.map(s=>({start:s.startMs,end:s.endMs})),ranges):[]
      const wholeTotal=selectedVideoRanges(windows,run.recordingMs,undefined,run.trims).reduce((n,r)=>n+r.end-r.start,0)
      const sectionTotals=Object.fromEntries(allSections.map(section=>[section,selectedVideoRanges(windows,run.recordingMs,[section],run.trims).reduce((n,r)=>n+r.end-r.start,0)]))
      return {windows,allSections,ranges,selected,gaps,wholeTotal,sectionTotals,total:ranges.reduce((n,r)=>n+r.end-r.start,0),error:null}
    } catch(e) {return {windows:[],allSections:[],ranges:[],selected:[],gaps:[],wholeTotal:0,sectionTotals:{} as Record<string,number>,total:0,error:e instanceof Error?e.message:'The recorded slides could not be read.'}}
  },[run,slides,whole,sections])
  const animated=derived.selected.filter(id=>(choices[id]??defaultChoice(slides[id]?.tag))==='animate').length

  useEffect(()=>{
    let live=true
    setWordState('loading')
    void window.tw.videoPack.wordStatus({talkSlug:run.talkSlug,sessionId:run.id,home:recordingRunHome(run)}).then(status=>{
      if(!live)return
      if(!status.ok){setWordState('failed');return}
      setWordState(!status.ffmpegFound?'encoder':status.hasWords?'ready':status.canTranscribe?'make':'missing')
    }).catch(()=>{if(live)setWordState('failed')})
    return()=>{live=false}
  },[run.talkSlug,run.id,run.home,run.kept,checkAgain])
  useEffect(()=>{
    mounted.current=true
    const previous=document.activeElement as HTMLElement|null
    dialog.current?.focus()
    const off=window.tw.videoPack.onProgress(p=>{if(busy.current)setStep(steps.indexOf(p.step))})
    return()=>{mounted.current=false;off();if(busy.current)void window.tw.videoPack.cancel();previous?.focus()}
  },[])

  useEffect(()=>{dialog.current?.focus()},[stage])

  const make=async():Promise<void>=>{
    if(busy.current)return
    busy.current=true;cancelled.current=false;setCancelling(false);setError(null);setStep(0);setStage('progress')
    try {
      const made=await window.tw.videoPack.make({talkSlug:run.talkSlug,sessionId:run.id,home:recordingRunHome(run),sections:whole?undefined:sections,animate:Object.fromEntries(derived.selected.map(id=>[id,choices[id]??defaultChoice(slides[id].tag)]))})
      if(!mounted.current)return
      if(cancelled.current){busy.current=false;onClose();return}
      if(made.ok){setResult(made);setStage('done')}
      else{setError(made.error);setStage('error')}
    } catch(e){if(mounted.current){if(cancelled.current){busy.current=false;onClose();}else{setError(e instanceof Error?e.message:'The package could not be made.');setStage('error')}}}
    finally{busy.current=false}
  }
  const cancel=():void=>{
    if(!busy.current){onClose();return}
    if(cancelled.current)return
    cancelled.current=true;setCancelling(true)
    void window.tw.videoPack.cancel().catch(()=>{cancelled.current=false;setCancelling(false);setError('The package could not be cancelled. Try again.')})
  }
  const copy=async():Promise<void>=>{
    try{await navigator.clipboard.writeText(result!.prompt);setNotice('Prompt copied.')}
    catch{setNotice('The prompt could not be copied. Select and copy the text above.')}
  }
  const keyDown=(event:React.KeyboardEvent):void=>{
    event.stopPropagation()
    // SCAN_IGNORE: local modal dismissal and focus containment; these are not content commands.
    if(event.key==='Escape'){event.preventDefault();cancel()}
    if(event.key==='Tab'){
      const nodes=dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea,a[href]')
      if(!nodes?.length)return
      const first=nodes[0],last=nodes[nodes.length-1]
      if(event.shiftKey && (document.activeElement===first || document.activeElement===dialog.current)){event.preventDefault();last.focus()}
      else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first.focus()}
    }
  }
  const canMake=Boolean(run.audio) && derived.selected.length>0 && (wordState==='ready'||wordState==='make') && !derived.error
  const label=whole?'Whole Run':sections.join(' · ')
  return <div className="plan-run-backdrop animated-video-backdrop" onKeyDown={keyDown}>
    <div ref={dialog} tabIndex={-1} className={`plan-run animated-video-sheet ${stage==='choose'?'':'narrow'}`} role="dialog" aria-modal="true" aria-labelledby="animated-video-title">
      <header className="pr-head"><div className="av-eyebrow">Animated video</div><h2 id="animated-video-title">{stage==='choose'?run.talkTitle:stage==='progress'?'Making the package':stage==='done'?'The package is ready':'The package could not be made'}</h2>
        <p>{stage==='choose'?'Makes a folder an agent can turn into a video, using your own voice from this Run. The package stays in the talk folder until you hand it to an agent.':`${label} · ${duration(result?.durationMs??derived.total)}`}</p>
      </header>
      <div className="pr-body">
        {stage==='choose'?<>
          <fieldset className="av-field"><legend>Stretch</legend><div className="av-segment"><button aria-pressed={whole} onClick={()=>setWhole(true)}>Whole Run · {duration(derived.wholeTotal)}</button><button aria-pressed={!whole} onClick={()=>setWhole(false)}>Choose sections</button></div>
            <div className="av-sections">{derived.allSections.map(section=><label key={section}><input type="checkbox" disabled={whole} checked={whole||sections.includes(section)} onChange={e=>setSections(old=>e.target.checked?[...old,section]:old.filter(s=>s!==section))}/><span>{section}</span><time>{duration(derived.sectionTotals[section])}</time></label>)}</div>
          </fieldset>
          <section className="av-field"><h3>Slides in this stretch <small>{derived.selected.length}</small></h3><div className="av-slides">{derived.selected.map(id=>{
            const s=slides[id],choice=choices[id]??defaultChoice(s.tag)
            return <div className="av-slide" key={id}>{s.thumbUrl?<img src={s.thumbUrl} alt=""/>:<span className="av-thumb"><Film aria-hidden/></span>}<div className="av-slide-title"><b>{s.title}</b><small>{layoutLabel(s.tag)} · {duration(derived.windows.filter(w=>w.slideId===id).reduce((n,w)=>n+derived.ranges.reduce((sum,r)=>sum+Math.max(0,Math.min(w.end,r.end)-Math.max(w.start,r.start)),0),0))}</small></div><div className="av-segment" role="group" aria-label={`Treatment for ${s.title}`}>{(['animate','keep'] as const).map(value=><button key={value} aria-pressed={choice===value} onClick={()=>setChoices(old=>({...old,[id]:value}))}>{value==='animate'?'Animate':'Keep as slide'}</button>)}</div></div>
          })}</div>{!derived.selected.length?<p className="av-muted">Choose one or more sections.</p>:null}</section>
          <section className="av-field"><h3>Word timings</h3><div className={`av-words ${wordState==='missing'||wordState==='encoder'?'warning':''}`}>
            {wordState==='ready'?<><Check aria-hidden/><span>Ready</span></>:wordState==='make'?<span>Will be made now, on this computer</span>:wordState==='encoder'?<><AlertTriangle aria-hidden/><div>ffmpeg could not be found.<small><button className="av-link" onClick={()=>{void window.tw.settingsWindow.open('transcription')}}>Check Settings → Transcription</button>, then come back.</small><button className="av-link" onClick={()=>setCheckAgain(n=>n+1)}>Check again</button></div></>:wordState==='missing'?<><AlertTriangle aria-hidden/><div>No transcription set up<small>Word timings need a transcription engine. <button className="av-link" onClick={()=>{void window.tw.settingsWindow.open('transcription')}}>Set one up in Settings → Transcription</button>, then come back.</small><button className="av-link" onClick={()=>setCheckAgain(n=>n+1)}>Check again</button></div></>:wordState==='failed'?<><span>Word timings could not be checked.</span><button className="av-link" onClick={()=>setCheckAgain(n=>n+1)}>Try again</button></>:<span>Checking word timings…</span>}
          </div></section>
          {derived.gaps.length?<div className="av-gap" role="status"><AlertTriangle aria-hidden/><div><b>The recording has a gap in this stretch</b>{derived.gaps.map((g,i)=><p key={i}>Missing audio from {duration(g.start)} to {duration(g.end)} ({duration(g.end-g.start)}). The video will be silent there, and the words in that time are missing.</p>)}<p>You can make the package anyway.</p></div></div>:null}
          {derived.error?<p className="av-error" role="alert">{derived.error}</p>:null}
        </>:stage==='progress'?<>
          <ol className="av-steps" aria-live="polite">{stepNames.map((name,i)=><li key={name} className={i===step?'current':i<step?'complete':''}><span>{i<step?<Check aria-label="Done"/>:i+1}</span><b>{name}</b><small>{i<step?'Done':i===step?'Working…':''}</small></li>)}</ol>
          <p className="av-muted">You can leave this window open and carry on elsewhere in TalkWeaver. Cancelling removes the folder it was making.</p>{error?<p role="alert" className="av-error">{error}</p>:null}
        </>:stage==='done' && result?<>
          <section className="av-field"><h3>Folder</h3><div className="av-folder"><Folder aria-hidden/><div>{run.talkTitle} › video-packs<small>{new Date().toLocaleDateString('en-GB')} · {label}</small><ul><li>Your voice for this stretch, {duration(result.durationMs)}</li><li>Word timings and a readable transcript</li><li>{derived.selected.length} slides, {animated} to animate</li><li>The look of the talk and the pictures these slides use</li></ul></div></div></section>
          <section className="av-field"><h3>Prompt for your agent</h3><textarea aria-label="Prompt for your agent" readOnly value={result.prompt} rows={6}/></section>
          <p>Next: paste the prompt into an agent session opened on this folder. When the video is finished it appears on the Run here.</p>
          {notice?<p role="status">{notice}</p>:null}
        </>:<><p className="av-error" role="alert">{error}</p><p>Your recording and earlier packages are still there.</p></>}
      </div>
      <footer className="pr-foot">
        {stage==='choose'?<><span className="pr-foot-note">{duration(derived.total)} · {derived.selected.length} slides · {animated} animated, {derived.selected.length-animated} kept</span><button className="pr-btn pr-btn-plain" onClick={onClose}>Cancel</button><button className="pr-btn" disabled={!canMake} onClick={()=>{void make()}}>Make package</button></>:stage==='progress'?<><span className="pr-foot-note">Step {step+1} of 4</span><button className="pr-btn pr-btn-plain" disabled={cancelling} onClick={cancel}>{cancelling?'Cancelling…':'Cancel'}</button></>:stage==='done'?<><button className="pr-btn pr-btn-plain" onClick={()=>{void window.tw.shell.showInFolder(result!.folder)}}>Show in Finder</button><span className="pr-foot-note"/><button className="pr-btn pr-btn-plain" onClick={onClose}>Close</button><button className="pr-btn" onClick={()=>{void copy()}}><Copy aria-hidden/>Copy prompt for your agent</button></>:<><button className="pr-btn pr-btn-plain" onClick={()=>{void onShowTalkFolder()}}>Show talk folder</button><span className="pr-foot-note"/><button className="pr-btn pr-btn-plain" onClick={onClose}>Close</button><button className="pr-btn" onClick={()=>{void make()}}>Try again</button></>}
      </footer>
    </div>
  </div>
}
