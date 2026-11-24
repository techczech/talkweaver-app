import { useLayoutEffect, useRef, useState } from 'react'
import { Bookmark, Check, ChevronDown, ChevronLeft, ChevronRight, ClipboardPaste, Plus, StickyNote, Undo2 } from 'lucide-react'
import type { ProjectionRow } from '../../../preload/index'
import type { NotesEntry } from '../../../shared/objects/object-verbs'
import FixedDeckPreview from './FixedDeckPreview'
import { useLiveSlidePreview } from './useLiveSlidePreview'
import type { PanelTry } from './RightPanelPictures'

interface Props {
  path: string
  outline: string
  trying?: PanelTry | null
  applied?: string | null
  onUndoDesign?: () => void
  onOpenReveal: () => void
  row: ProjectionRow | undefined
  index: number
  count: number
  pathwayNavigation?: { prev?: () => void; next?: () => void; empty: boolean }
  place: string
  notes: NotesEntry[]
  notesKey: string
  notesOpen: boolean
  onToggleNotes: () => void
  onNotesChange: (body: string, position: number, expectedHash?: string) => string | null
  onNotesEngaged: () => void
  attachEditor: (el: HTMLDivElement | null) => void
  onTalkDetails: () => void
  editable: boolean
  emptySlide: boolean
  sourceRecovery: boolean
  section?: { label: string; count: number; addFirst: () => void }
  subslides?: { title: string; notes?: string; select: () => void }[]
  addSubslide?: () => void
  subslide?: { title: string; thumb?: string }
}

// WN1 / NT1 use Slide Focus's stage and the same scoped editor, with the editor under the stage.
export default function WorkspaceSlideView({
  path, outline, trying, applied, onUndoDesign, onOpenReveal, row, index, count, pathwayNavigation, place, notes, notesKey, notesOpen, onToggleNotes, onNotesChange, onNotesEngaged,
  attachEditor, onTalkDetails, editable, emptySlide, sourceRecovery, section, subslides, addSubslide, subslide
}: Props) {
  const { previewUrl, previewErr, compiling } = useLiveSlidePreview(path, trying?.text ?? outline, row?.slide_id ?? '', 'workspace')
  const open = notesOpen
  const showEmptySlide = editable && emptySlide
  const slideView = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (slideView.current) slideView.current.scrollTop = 0
  }, [path])
  return (
    <div className="workspace-slide-view" data-view="slide" ref={slideView}>
      <div className="workspace-slide-content">
        <div className="workspace-slide-crumb">{place && `${place} · `}{subslide ? <strong>Subslide of “{subslide.title}”</strong> : index >= 0 && count > 0 && <strong>Slide {index + 1} of {count}</strong>}
          {pathwayNavigation && count > 0 && <div className="pathway-slide-nav" role="group" aria-label="Pathway slides">
            <button type="button" className="icon-btn" aria-label="Previous pathway slide" disabled={!pathwayNavigation.prev} onClick={pathwayNavigation.prev}><ChevronLeft size={16} aria-hidden /></button>
            <button type="button" className="icon-btn" aria-label="Next pathway slide" disabled={!pathwayNavigation.next} onClick={pathwayNavigation.next}><ChevronRight size={16} aria-hidden /></button>
          </div>}
        </div>
        {pathwayNavigation?.empty ? <p className="workspace-slide-message">No slides in this pathway.</p> : <>
        <div className="workspace-slide-stage" tabIndex={-1} aria-busy={compiling} data-empty-slide={showEmptySlide || undefined} data-panel-trying={!!trying || undefined}>
          {sourceRecovery ? <div className="workspace-slide-message">This slide couldn’t be previewed.</div>
            : subslide?.thumb ? <img className="tw-subslide-stage-image" src={subslide.thumb} alt="" />
              : previewUrl ? <FixedDeckPreview title="Slide preview" src={previewUrl} onOpenReveal={onOpenReveal} readOnly />
            : previewErr && <div className="workspace-slide-message">This slide couldn’t be previewed.</div>}
          {showEmptySlide && (
            <div className="workspace-empty-preview" aria-hidden="true">
              <span>Slide title</span>
              <span>First point</span>
            </div>
          )}
          {trying && <div className="tw-right-bar is-trying tw-try-chip" role="status">Trying: {trying.label}. Not applied.</div>}
        </div>
        {applied && <div className="tw-right-bar" role="status"><Check size={15} />Applied: {applied}
            <button type="button" className="toolbar-btn" onClick={onUndoDesign}><Undo2 size={14} />Undo</button>
          </div>}
        <div className="workspace-slide-text">
          <div className="workspace-slide-text-label">
            <strong>{sourceRecovery ? 'Talk text' : section?.label ?? (subslide ? 'Subslide text' : 'Slide text')}</strong>
            {editable && !sourceRecovery && <span>{section ? 'Type its name. The slide above follows.' : 'Type here. The slide above follows.'}</span>}
          </div>
          {editable ? (
            <>
              <div className="workspace-slide-input" data-empty-slide={showEmptySlide || undefined}>
                <div className="editor-portal-slot" ref={attachEditor} />
                {showEmptySlide && (
                  <div className="workspace-empty-text" aria-hidden="true">
                    <span>Slide title</span>
                    <span>First point</span>
                  </div>
                )}
              </div>
              {section && <div className="workspace-slide-paste-hint"><Bookmark size={14} />{section.count
                ? `This slide opens the ${section.label.toLowerCase()}. ${section.count} slide${section.count === 1 ? ' follows' : 's follow'} it.`
                : <>Nothing in it yet. <button type="button" className="toolbar-btn" onClick={section.addFirst}>Add its first slide</button></>}</div>}
              {subslides && <div className="tw-section-subslides">
                {subslides.map((pane, index) => <button type="button" key={index} onClick={pane.select}><span>{index + 1}</span><strong>{pane.title}</strong><small>Subslide</small><ChevronRight size={14} /></button>)}
                <button type="button" className="toolbar-btn" onClick={addSubslide}><Plus size={14} />New subslide</button>
              </div>}
              {!sourceRecovery && !section && !subslides && <div className="workspace-slide-paste-hint"><ClipboardPaste size={14} /> Paste a picture or a table here with ⌘V, or drop a file.</div>}
              {!sourceRecovery && <div className="workspace-slide-notes">
                <button type="button" className="workspace-notes-toggle" onClick={onToggleNotes} aria-expanded={open}>
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<StickyNote size={14} />
                  Speaker notes{!notes.length && <small>None yet</small>}<small>Only you see these</small>
                </button>
                <div hidden={!open}>
                  {(notes.length ? notes : [undefined]).map((note, index) =>
                    <SlideNote key={`${notesKey}:${index}`} note={note} index={index} count={notes.length}
                      onChange={onNotesChange} onEngaged={onNotesEngaged} />)}
                </div>
              </div>}
            </>
          ) : (
            <div className="workspace-slide-paste-hint">
              {row ? <>{row.slide_id === 'deck-title' ? 'The first slide' : 'This slide'} is made from the talk’s details. <button className="toolbar-btn" onClick={onTalkDetails}>Edit talk details</button></>
                : 'Preparing the slide…'}
            </div>
          )}
        </div>
        </>}
      </div>
    </div>
  )
}

function SlideNote({ note, index, count, onChange, onEngaged }: {
  note: NotesEntry | undefined
  index: number
  count: number
  onChange: Props['onNotesChange']
  onEngaged: Props['onNotesEngaged']
}) {
  const [refused, setRefused] = useState<{ body: string; error: string } | null>(null)
  useLayoutEffect(() => { setRefused(null) }, [note?.hash])
  return (
    <>
      <textarea aria-label={count > 1 ? `Speaker notes ${index + 1} of ${count}` : 'Speaker notes'}
        placeholder="What you want to say on this slide" value={refused?.body ?? note?.body ?? ''}
        disabled={note?.closed === false} onClick={onEngaged}
        onChange={event => {
          onEngaged()
          const body = event.currentTarget.value
          const error = onChange(body, index, note?.hash)
          setRefused(error ? { body, error } : null)
        }} />
      {refused && <div role="status">{refused.error}</div>}
    </>
  )
}
