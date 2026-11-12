import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AlignmentModelRow } from '../../../shared/alignment-status'
/** The shared Settings package has no section-footer slot. Attach to the Recording page,
 * including its custom device page, without replacing device controls or ordinary rows. */
export default function PreciseWordTimingSettings({language}: {language?:string}): React.JSX.Element | null {
  const [target,setTarget]=useState<Element|null>(null),[rows,setRows]=useState<AlignmentModelRow[]>([]),[error,setError]=useState('')
  useEffect(()=>{
    const find=():void=>setTarget(document.querySelector('.bsw-root[data-section="recording"] #bsw-scroll, .bsw-root[data-section="recording"] .recording-settings-page'))
    const observer=new MutationObserver(find);observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['data-section']});find()
    return()=>observer.disconnect()
  },[])
  useEffect(()=>{let alive=true,changed=false;const off=window.tw.alignment.onModels(r=>{changed=true;setRows(r)});void window.tw.alignment.models().then(r=>{if(alive&&!changed)setRows(r)}).catch(()=>{if(alive)setError('Precise word timing could not be checked. Reopen Settings to Retry.')});return()=>{alive=false;off()}},[])
  const act=async(language:string,action:'download'|'install'|'remove'|'cancelDownload'):Promise<void>=>{
    setError('');try{const reply=await window.tw.alignment[action](language);if(!reply.ok)setError(reply.error);setRows(await window.tw.alignment.models())}catch{setError('The model operation failed. Retry when ready.')}
  }
  const displayRows:AlignmentModelRow[]=[...rows]
  if(language && !rows.some(r=>r.language===language.split(/[-_]/)[0].toLowerCase()))displayRows.push({language:language.split(/[-_]/)[0].toLowerCase(),label:language,state:'unavailable'})
  if(!target)return null
  return createPortal(<section className="bsw-card" aria-label="Precise word timing" data-precise-word-timing>
    <div className="bsw-ch">Precise word timing</div>
    {displayRows.map(row=><div className="bsw-row" key={row.language}>
      <div className="bsw-lab"><strong>{row.label}</strong><p aria-live="polite">{row.state==='unavailable'?row.note??'Precise word timing is not available yet for this language':row.state==='installed'?row.note??'Precise word timing: installed on this Mac':row.state==='downloading'?`Precise word timing: ${Math.round(100*(row.received??0)/(row.bytes??1))}%`:row.state==='failed'?row.note:`Precise word timing: not downloaded (about ${Math.round((row.bytes??0)/1e6)} MB)`}</p>
      {row.state!=='unavailable'?<small>{row.local?'Install the verified model file once on this Mac.':`One-time download from ${row.host}.`} Recordings never leave the Mac.</small>:null}</div>
      <div className="bsw-ctl">{row.state==='installed'?<button className="bsw-btn" onClick={()=>void act(row.language,'remove')}>Remove</button>:row.state==='downloading'?<><progress value={row.received??0} max={row.bytes??1}/><button className="bsw-btn" onClick={()=>void act(row.language,'cancelDownload')}>Cancel</button></>:row.state!=='unavailable'?<button className="bsw-btn" onClick={()=>void act(row.language,row.local?'install':'download')}>{row.state==='failed'?'Retry':row.local?'Install from file…':'Download'}</button>:null}</div>
    </div>)}
    {error?<p role="alert">{error}</p>:null}
  </section>,target)
}
