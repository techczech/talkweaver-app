import { useEffect, useRef, useState } from 'react'
import { imageMarksSvg, type ImageEditPreview, type ImageMark, type ImageRect } from '../../../shared/image-edit'
import '../image-edit.css'

type Props = { imageId: string; outlinePath: string; onClose: () => void; onSaved: (id: string) => void; onUseCopy?: (id: string) => Promise<boolean> }
type Tool = 'crop' | ImageMark['kind']
export default function ImageEditDialog({imageId,outlinePath,onClose,onSaved,onUseCopy}: Props) {
  const [source,setSource] = useState<ImageEditPreview | null>(null)
  const [error,setError] = useState('')
  const [tool,setTool] = useState<Tool>('crop')
  const [rect,setRect] = useState<ImageRect>({x:0,y:0,width:100,height:100})
  const [reverseX,setReverseX] = useState(false)
  const [reverseY,setReverseY] = useState(false)
  const [colour,setColour] = useState('#dc2626')
  const [text,setText] = useState('Label')
  const [busy,setBusy] = useState(false)
  const [copied,setCopied] = useState(false)
  const [savedId,setSavedId] = useState<string | null>(null)
  const [history,setHistory] = useState<ImageEditPreview['recipe'][]>([])
  const dialog = useRef<HTMLDialogElement>(null)
  const start = useRef<{x:number;y:number}|null>(null)
  useEffect(()=>{
    dialog.current?.showModal()
    let live=true
    window.tw.asset.readImageEdit(outlinePath,imageId).then(s=>{if(live){setSource(s);if(s)setRect(s.recipe.crop);else setError('The original or edit recipe could not be read. Close and restore the original picture, then try again.')}}).catch(()=>{if(live)setError('Could not load the picture. Close and try again.')})
    return ()=>{live=false}
  },[imageId,outlinePath])
  function apply() {
    if (!source || busy) return
    const r = {...rect}
    if (![r.x,r.y,r.width,r.height].every(Number.isSafeInteger) || r.x<0 || r.y<0 || r.width<1 || r.height<1 || r.x+r.width>source.width || r.y+r.height>source.height) {setError('Keep the crop or mark inside the image.');return}
    setHistory(h=>[...h,source.recipe])
    setSource({...source,recipe: tool==='crop' ? {...source.recipe,crop:r} : {...source.recipe,marks:[...source.recipe.marks,{...r,kind:tool,colour,text,reverseX,reverseY}]}})
    setSavedId(null);setError('')
  }
  async function save() {
    if(!source || busy)return
    setBusy(true);start.current=null;setError('')
    try {
      const result=await window.tw.asset.saveImageEdit(outlinePath,source.originalId,source.recipe)
      if(!result.ok)setError(result.message)
      else {setSavedId(result.id);onSaved(result.id)}
    } catch {setError('Could not save the edited copy. Try again.')} finally {setBusy(false)}
  }
  function point(e: React.PointerEvent<HTMLDivElement>) {
    const b=e.currentTarget.getBoundingClientRect()
    return {x:Math.max(0,Math.min(source!.width-1,Math.round((e.clientX-b.left)/b.width*source!.width))),y:Math.max(0,Math.min(source!.height-1,Math.round((e.clientY-b.top)/b.height*source!.height)))}
  }
  return <dialog ref={dialog} className="image-edit-dialog" aria-labelledby="image-edit-heading" onCancel={e=>{e.preventDefault();if(!busy)onClose()}}>
    <header><h2 id="image-edit-heading">Crop and mark up image</h2><button disabled={busy} onClick={onClose}>Close</button></header>
    {error && <p role="alert">{error}</p>}
    {!source ? <p>Loading image…</p> : <>
      <div className="image-edit-body"><div className="image-edit-stage">
        <div className="image-edit-picture" style={{aspectRatio:`${source.width}/${source.height}`,maxWidth:`min(100%, ${62*source.width/source.height}vh)`}}
          onPointerDown={e=>{if(busy)return;start.current=point(e);e.currentTarget.setPointerCapture(e.pointerId)}}
          onPointerMove={e=>{if(busy||!start.current)return;const p=point(e),s=start.current;setReverseX(p.x<s.x);setReverseY(p.y<s.y);setRect({x:Math.min(p.x,s.x),y:Math.min(p.y,s.y),width:Math.max(1,Math.abs(p.x-s.x)),height:Math.max(1,Math.abs(p.y-s.y))})}}
          onPointerUp={()=>{start.current=null}} onPointerCancel={()=>{start.current=null}}>
          <img src={source.previewUrl} alt="Original image with editable marks" draggable={false}/>
          <img className="image-edit-overlay" src={'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(imageMarksSvg(source.recipe,source.width,source.height))} alt="" draggable={false}/>
          <svg className="image-edit-overlay" viewBox={`0 0 ${source.width} ${source.height}`}><rect {...source.recipe.crop} fill="none" stroke="#2563eb" strokeWidth={Math.max(2,source.width/300)} strokeDasharray="8 5"/><rect {...rect} fill="none" stroke="#15803d" strokeWidth={Math.max(2,source.width/300)}/></svg>
        </div><p>Drag to choose an area, or enter coordinates. Blue: saved crop. Green: next change.</p>
      </div><aside>
        <label>Tool<select disabled={busy} aria-label="Tool" value={tool} onChange={e=>setTool(e.target.value as Tool)}>{(['crop','arrow','box','highlight','text'] as Tool[]).map(t=><option key={t} value={t}>{({crop:'Crop',arrow:'Arrow',box:'Box',highlight:'Highlight',text:'Text label'})[t]}</option>)}</select></label>
        {(['x','y','width','height'] as const).map(k=><label key={k}>{k[0].toUpperCase()+k.slice(1)}<input disabled={busy} type="number" min={k==='x'||k==='y'?0:1} max={k==='x'||k==='width'?source.width:source.height} value={rect[k]} onChange={e=>setRect({...rect,[k]:Number(e.target.value)})}/></label>)}
        {tool!=='crop' && <label>Colour<input disabled={busy} type="color" value={colour} onChange={e=>setColour(e.target.value)}/></label>}
        {tool==='arrow' && <><label>Point left<input disabled={busy} type="checkbox" checked={reverseX} onChange={e=>setReverseX(e.target.checked)}/></label><label>Point up<input disabled={busy} type="checkbox" checked={reverseY} onChange={e=>setReverseY(e.target.checked)}/></label></>}
        {tool==='text' && <label>Text label<input disabled={busy} value={text} maxLength={300} onChange={e=>setText(e.target.value)}/></label>}
        <button disabled={busy||(tool!=='crop'&&source.recipe.marks.length>=100)} onClick={apply}>{tool==='crop'?'Apply crop':'Add mark'}</button>
        <button disabled={!history.length||busy} onClick={()=>{setSource({...source,recipe:history[history.length-1]});setHistory(h=>h.slice(0,-1));setSavedId(null)}}>Undo change</button>
        <ol aria-label="Marks">{source.recipe.marks.map((m,i)=><li key={i}>{m.kind==='text'?m.text:m.kind}<button disabled={busy} aria-label={`Remove mark ${i+1}`} onClick={()=>{setHistory(h=>[...h,source.recipe]);setSource({...source,recipe:{...source.recipe,marks:source.recipe.marks.filter((_,n)=>n!==i)}});setSavedId(null)}}>Remove</button></li>)}</ol>
      </aside></div>
      <footer><button className="image-edit-save" disabled={busy} onClick={save}>{busy?'Saving…':'Save edited copy'}</button><button disabled={busy} onClick={onClose}>Cancel</button><span>Original kept. Crop and marks remain editable.</span></footer>
      {savedId && <p role="status">Saved edited copy: {onUseCopy && <button onClick={()=>void onUseCopy(savedId)}>Use edited copy here</button>} <code>![]({savedId})</code> <button onClick={()=>{navigator.clipboard.writeText(`![](${savedId})`).then(()=>setCopied(true)).catch(()=>setError('Select and copy the reference shown here.'))}}>{copied?'Copied':'Copy reference'}</button></p>}
    </>}
  </dialog>
}
