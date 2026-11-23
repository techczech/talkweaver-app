import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Circle, CircleDot, History, NotebookPen, Pencil, Plus } from 'lucide-react'
import { SAMPLE_SKETCH } from '../../../shared/sketch-sample'
import { sketchTitleFromText, titleFromFileName, type ScratchItem } from '../../../shared/scratchpad'
import ModeBack from './ModeBack'
import '../sketch.css'

export default function SketchView({ talkTitle, name, text, error, sketches, onChange, onOpen, onRename,
  onCopyDraft, onSaveElsewhere, onDiscard, onBack, toolbar, used, detached = false, frozen = false, children }: {
  talkTitle: string
  name: string
  text: string
  error: string | null
  sketches: (ScratchItem & { usedSlideCount?: number })[]
  onChange: (text: string) => void
  onOpen: (name?: string) => void
  onRename?: (title: string) => Promise<boolean>
  onCopyDraft?: () => void
  onSaveElsewhere: () => void
  onDiscard: () => void
  onBack: () => void
  detached?: boolean
  frozen?: boolean
  used?: { day: string; show: () => void }
  toolbar?: ReactNode
  children?: ReactNode
}) {
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [rename, setRename] = useState('')
  const anchor = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open], [aria-modal="true"]')) return
      event.preventDefault()
      if (menu || renaming) {
        setMenu(false)
        setRenaming(false)
        requestAnimationFrame(() => trigger.current?.focus())
      } else onBack()
    }
    function outside(event: PointerEvent) {
      if (!anchor.current?.contains(event.target as Node)) setMenu(false)
    }
    window.addEventListener('keydown', escape)
    if (menu) window.addEventListener('pointerdown', outside)
    return () => { window.removeEventListener('keydown', escape); window.removeEventListener('pointerdown', outside) }
  }, [menu, renaming, onBack])

  const current = sketches.find(item => item.file === name)
  const title = current?.sketchTitle || sketchTitleFromText(text) || (name ? titleFromFileName(name) : 'New sketch')
  const lines = text.split(/\r?\n/).filter(line => line.trim()).length
  function open(file?: string) {
    setMenu(false)
    onOpen(file)
  }
  return <section className="tw-sketch" aria-label="Sketch">
    <div className="tw-sketch-bar">
      <ModeBack talkTitle={children ? 'the sketch' : talkTitle} onBack={onBack} />
      <span className="tw-sketch-chip is-warning"><NotebookPen size={13} aria-hidden="true" />Sketch · not in the talk yet</span>
      <div className="tw-sketch-actions">{toolbar}</div>
    </div>
    {children ?? <div className="tw-sketch-page">
      {used && <div className="tw-sketch-notice is-warning" role="status">
        <History size={16} aria-hidden="true" />
        <span>This sketch was broken into slides on {used.day}. Breaking it again adds new slides. It does not change the ones already there.</span>
        <button type="button" className="tw-btn tw-btn--secondary" onClick={used.show}>Show the slides it made</button>
      </div>}
      <div className="tw-sketch-head">
        <div className="tw-sketch-picker" ref={anchor} data-sketch-name={name}>
          {renaming ? <form className="tw-sketch-rename" onSubmit={event => {
            event.preventDefault()
            if (rename.trim() && onRename) void onRename(rename).then(ok => {
              if (ok) { setRenaming(false); requestAnimationFrame(() => trigger.current?.focus()) }
            })
          }}>
            <input autoFocus aria-label="Sketch name" value={rename} maxLength={200} onChange={event => setRename(event.target.value)} />
            <button type="submit" className="tw-btn tw-btn--primary" disabled={!rename.trim() || frozen}>Save name</button>
            <button type="button" className="tw-btn tw-btn--secondary" onClick={() => setRenaming(false)}>Cancel</button>
          </form> : <h2>
            <button ref={trigger} type="button" className="tw-sketch-name" aria-label={`Sketches for this talk, ${title}`}
              aria-expanded={menu} aria-haspopup="menu" disabled={frozen || detached} onClick={() => setMenu(!menu)}>
              <span>{title}</span><ChevronDown size={15} aria-hidden="true" />
            </button>
          </h2>}
          {menu && <div className="tw-sketch-menu" role="menu" aria-label="Sketches for this talk">
            <div className="tw-sketch-label">Sketches for this talk</div>
            {sketches.map(item => <button type="button" key={item.id} role="menuitemradio" aria-checked={item.file === name}
              title={item.file} data-sketch-file={item.file} onClick={() => open(item.file)}>
              {item.file === name ? <CircleDot size={14} /> : <Circle size={14} />}<span>{item.title}</span>
              <small>{item.usedSlideCount ? `Broken into ${item.usedSlideCount} ${item.usedSlideCount === 1 ? 'slide' : 'slides'}`
                : item.sketchLineCount === undefined ? '' : `${item.sketchLineCount} ${item.sketchLineCount === 1 ? 'line' : 'lines'}`}</small>
            </button>)}
            <div className="tw-sketch-menu-actions">
              <button type="button" role="menuitem" onClick={() => open()}><Plus size={15} />New sketch</button>
              <button type="button" role="menuitem" disabled={!name || !onRename} onClick={() => { setMenu(false); setRename(title); setRenaming(true) }}>
                <Pencil size={14} />Rename this sketch
              </button>
            </div>
          </div>}
        </div>
        <span>{lines === 0 ? 'Empty' : `${lines} ${lines === 1 ? 'line' : 'lines'}`}{name && !detached ? ' · kept in the Scratchpad' : ' · not saved yet'}</span>
      </div>
      {error && <div className="tw-sketch-error" role="alert">{error}{' '}
        {onCopyDraft && <button type="button" className="tw-btn tw-btn--secondary" disabled={frozen || !text} onClick={onCopyDraft}>Save as a new sketch</button>}
        {' '}<button type="button" className="tw-btn tw-btn--secondary" disabled={frozen} onClick={onSaveElsewhere}>Save a copy elsewhere…</button>
        {' '}<button type="button" className="tw-btn tw-btn--secondary" disabled={frozen} onClick={onDiscard}>Discard sketch changes</button>
      </div>}
      <textarea autoFocus aria-label="Sketch text" readOnly={frozen} spellCheck={false} value={text}
        placeholder={'Type or paste your outline. Plain lines are sections, lines starting with - are points, indented lines are details.\n\nNext season\n- Repair the beds\n- Share the tools'}
        onChange={event => onChange(event.target.value)} />
      {!lines && <p className="tw-sketch-example">Nothing here needs to be a slide yet.{' '}
        <button type="button" disabled={frozen} onClick={() => onChange(SAMPLE_SKETCH)}>Paste the example outline</button>
      </p>}
    </div>}
  </section>
}
