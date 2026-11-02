import { useEffect, useRef, useState } from 'react'
import type { GalleryHandouts } from '../../../../shared/gallery-handouts'
import { handoutLabel } from '../../../../shared/gallery-handouts'
export default function GalleryHandoutSheet({title,value,close}:{title:string;value?:GalleryHandouts;close():void}) {
 const panel=useRef<HTMLDivElement>(null),[error,setError]=useState('')
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null
  const siblings=Array.from(panel.current?.parentElement?.children??[]).filter(el=>el!==panel.current && !el.hasAttribute('inert'))
  siblings.forEach(el=>el.setAttribute('inert',''));panel.current?.querySelector('button')?.focus()
  return ()=>{siblings.forEach(el=>el.removeAttribute('inert'));previous?.focus()}
 },[])
 return <div className="vg-handout-overlay" ref={panel} role="dialog" aria-modal="true" aria-label={`Published handouts: ${title}`} onKeyDown={e=>{
  e.stopPropagation()
  // SCAN_IGNORE: local dialog focus and dismissal.
  if(e.key==='Escape'){e.preventDefault();close()}
  // SCAN_IGNORE: modal focus containment, not a content command.
  if(e.key==='Tab'){
   const buttons=Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]),first=buttons[0],last=buttons.at(-1)
   // SCAN_IGNORE: modal Tab focus wrap.
   if(e.shiftKey && document.activeElement===first){e.preventDefault();last?.focus()}
   // SCAN_IGNORE: modal Tab focus wrap.
   else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first?.focus()}
  }
 }}><section className="vg-handout-sheet"><button onClick={close}>Close handouts</button><h2>{title}</h2><h3>Published handouts</h3><p>{handoutLabel(value)}</p><p>Recorded addresses are not checked for live availability.</p>{value?.note && <p role="status">{value.note}</p>}{error && <p role="alert">{error}</p>}{value?.unattributed?.length ? <p>Unattributed Run handouts: {value.unattributed.length}. These Run records do not identify this outline.</p>:null}{value?.records.map(row=><article key={row.key}><h3>{row.kind==='talk'?'Talk handout':'Run handout'}</h3><p>{row.title}</p><p>{row.publishedAt ? `${row.dateSource==='record'?'Recorded date':'Local page modified'}: ${new Date(row.publishedAt).toLocaleString()}`:'Publication date unknown'}</p><p className="vg-handout-address">{row.link}</p><p>Local site: {row.site}</p><button onClick={()=>{void window.tw.shell.openExternal(row.link).then(ok=>{if(!ok)setError('This recorded address could not be opened.')}).catch(()=>setError('This recorded address could not be opened.'))}}>Open recorded handout</button></article>)}</section></div>
}
