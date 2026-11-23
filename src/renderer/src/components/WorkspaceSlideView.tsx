import { useLayoutEffect, useRef, useState } from 'react'
import { Bookmark, Check, ChevronDown, ChevronRight, ClipboardPaste, Plus, StickyNote, Undo2 } from 'lucide-react'
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
  row: ProjectionRow | undefined
  index: number
  count: number
  place: string
  notes: NotesEntry | undefined
  notesOpen: boolean
  onToggleNotes: () => void
  onNotesChange: (body: string) => string | null
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
  path, outline, trying, applied, onUndoDesign, row, index, count, place, notes, notesOpen, onToggleNotes, onNotesChange,
  attachEditor, onTalkDetails, editable, emptySlide, sourceRecovery, section, subslides, addSubslide, subslide
}: Props) {
  const { previewUrl, previewErr, compiling } = useLiveSlidePreview(path, trying?.text ?? outline, row?.slide_id ?? '', 'workspace')
  const [refused, setRefused] = useState<{ slide: string | undefined; body: string; error: string } | null>(null)
  const refusedNotes = refused?.slide === row?.slide_id ? refused : null
  const open = notesOpen
  const showEmptySlide = editable && emptySlide
  const slideView = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (slideView.current) slideView.current.scrollTop = 0
  }, [path])
  return (
    <div className="workspace-slide-view" data-view="slide" ref={slideView}>
      <div className="workspace-slide-content">
        <div className="workspace-slide-crumb">{place && `${place} · `}{subslide ? <strong>Subslide of “{subslide.title}”</strong> : count > 0 && <strong>Slide {index + 1} of {count}</strong>}</div>
        <div className="workspace-slide-stage" tabIndex={-1} aria-busy={compiling} data-empty-slide={showEmptySlide || undefined} data-panel-trying={!!trying || undefined}>
          {sourceRecovery ? <div className="workspace-slide-message">This slide couldn’t be previewed.</div>
            : subslide?.thumb ? <img className="tw-subslide-stage-image" src={subslide.thumb} alt="" />
              : previewUrl ? <FixedDeckPreview title="Slide preview" src={previewUrl} readOnly />
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
                <button className="workspace-notes-toggle" onClick={onToggleNotes} aria-expanded={open}>
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<StickyNote size={14} />
                  Speaker notes{!notes && <small>None yet</small>}<small>Only you see these</small>
                </button>
                {open && (
                  <>
                    <textarea aria-label="Speaker notes" placeholder="What you want to say on this slide"
                      value={refusedNotes?.body ?? notes?.body ?? ''} disabled={notes?.closed === false}
                      onChange={event => {
                        const body = event.currentTarget.value
                        const error = onNotesChange(body)
                        setRefused(error ? { slide: row?.slide_id, body, error } : null)
                      }} />
                    {refusedNotes && <div role="status">{refusedNotes.error}</div>}
                  </>
                )}
              </div>}
            </>
          ) : (
            <div className="workspace-slide-paste-hint">
              {row ? <>{row.slide_id === 'deck-title' ? 'The first slide' : 'This slide'} is made from the talk’s details. <button className="toolbar-btn" onClick={onTalkDetails}>Edit talk details</button></>
                : 'Preparing the slide…'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
