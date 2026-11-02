import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
/** A management sheet is above the covered workspace and gallery, with its own focus scope. */
export default function ManagementLayer({children,onDismiss}:{children:ReactNode;onDismiss?:()=>void}) {
 const ref=useRef<HTMLDivElement>(null)
 useEffect(()=>{
  const previous=document.activeElement as HTMLElement|null
  const siblings=Array.from(document.body.children).filter(el=>el!==ref.current&&!el.hasAttribute('inert'))
  siblings.forEach(el=>el.setAttribute('inert',''))
  ref.current?.querySelector<HTMLElement>('input,button,select')?.focus()
  return ()=>{siblings.forEach(el=>el.removeAttribute('inert'));if(previous?.isConnected)previous.focus({preventScroll:true})}
 },[])
 return createPortal(<div ref={ref} className="vg-management-layer" onKeyDown={e=>{
  e.stopPropagation()
  if(e.key==='Escape'&&onDismiss){e.preventDefault();onDismiss()}
  // SCAN_IGNORE: modal focus containment, not a content command.
  if(e.key==='Tab'){
   const controls=Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')??[])
   const first=controls[0],last=controls.at(-1)
   // SCAN_IGNORE: modal Tab focus wrap.
   if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}
   // SCAN_IGNORE: modal Tab focus wrap.
   else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}
  }
 }}>{children}</div>,document.body)
}
