import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, GripVertical, Image as ImageIcon, ImageOff, Pencil, Plus, Presentation, Trash2, X } from 'lucide-react'
import type {
  Pathway,
  PathwaySnapshot,
  PathwayWindowContext,
  ProjectionRow,
  ResolvedPathway
} from '../../../preload/index'
import { SHORTCUT_REGISTRY } from '../../../shared/shortcut-registry'
import {
  optimisticallySetPathwaySlides,
  reconcilePathwaySnapshot,
  type PendingPathwaySlides
} from '../../../shared/pathway-state'
import {
  PATHWAY_PREVIEWS_STORAGE_KEY,
  PATHWAY_VIEW_STORAGE_KEY,
  readPathwayPreviewsPreference,
  readPathwayViewPreference,
  type PathwayViewMode
} from './pathwayViewModel'
import '../pathways.css'

type Dialog = { kind: 'new'; name: string; note: string } | { kind: 'rename'; name: string } | { kind: 'delete' }

function isError(value: PathwaySnapshot | { error: string }): value is { error: string } {
  return 'error' in value
}

function thumbKey(row: ProjectionRow): string {
  return row.render_hash || row.content_hash || ''
}

function sectionName(row: ProjectionRow): string {
  return row.section || 'Opening'
}

function slideTitle(row: ProjectionRow): string {
  return row.title || row.nav_title || row.slide_id
}

function SlidePreview({ row, image }: { row: ProjectionRow; image?: string }): JSX.Element {
  return image
    ? <img src={image} alt="" />
    : <div className="twp-card-fallback"><span>{sectionName(row)}</span><b>{slideTitle(row)}</b></div>
}

function reorder(ids: string[], id: string, delta: -1 | 1): string[] {
  const from = ids.indexOf(id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= ids.length) return ids
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

function PathwayCheatSheet({ onClose }: { onClose: () => void }): JSX.Element {
  const shortcuts = SHORTCUT_REGISTRY.filter((entry) => entry.scope === 'pathway')
  return (
    <div className="twp-sheet-backdrop" onMouseDown={onClose}>
      <section className="twp-sheet" role="dialog" aria-label="Pathway keyboard shortcuts" onMouseDown={(event) => event.stopPropagation()}>
        <header><h2>Pathway shortcuts</h2><button onClick={onClose} aria-label="Close keyboard shortcuts"><X /></button></header>
        <div className="twp-sheet-grid">
          {shortcuts.map((shortcut) => <div key={shortcut.id}><kbd>{shortcut.keys}</kbd><span><b>{shortcut.label}</b><small>{shortcut.explanation}</small></span></div>)}
        </div>
      </section>
    </div>
  )
}

export default function Pathways({ context, onClose }: { context: PathwayWindowContext | null; onClose: () => void }): JSX.Element {
  const [content, setContent] = useState('')
  const [snapshot, setSnapshot] = useState<PathwaySnapshot | null>(null)
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<PathwayViewMode>(readPathwayViewPreference)
  const [previews, setPreviews] = useState(readPathwayPreviewsPreference)
  const [reordering, setReordering] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [sheet, setSheet] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const pendingSlideIds = useRef<PendingPathwaySlides>({})

  const selected = useMemo<ResolvedPathway | null>(() =>
    snapshot?.pathways.find((pathway) => pathway.id === selectedId) ?? snapshot?.pathways[0] ?? null,
  [snapshot, selectedId])

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id)
  }, [selected, selectedId])

  useEffect(() => {
    try { window.localStorage.setItem(PATHWAY_VIEW_STORAGE_KEY, view) } catch { /* ignore */ }
  }, [view])

  useEffect(() => {
    try { window.localStorage.setItem(PATHWAY_PREVIEWS_STORAGE_KEY, String(previews)) } catch { /* ignore */ }
  }, [previews])

  const applySnapshot = useCallback((next: PathwaySnapshot): void => {
    setSnapshot((current) => {
      if (!current) return next
      const reconciled = reconcilePathwaySnapshot(current, next, pendingSlideIds.current)
      pendingSlideIds.current = reconciled.pending
      return reconciled.snapshot
    })
    setSelectedId((current) => next.pathways.some((pathway) => pathway.id === current) ? current : next.pathways[0]?.id ?? null)
    setError(null)
  }, [])

  const refresh = useCallback(async (showBusy = true): Promise<void> => {
    if (!context) return
    if (showBusy) setBusy(true)
    try {
      const disk = await window.tw.talk.readOutline(context.outlinePath)
      if (disk === null) throw new Error('The outline could not be read.')
      setContent(disk)
      const [next, thumbs] = await Promise.all([
        window.tw.pathways.read(context.outlinePath, disk),
        window.tw.talk.thumbnails(context.outlinePath, disk)
      ])
      if (isError(next)) throw new Error(next.error)
      applySnapshot(next)
      setThumbnails(thumbs ?? {})
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (showBusy) setBusy(false)
    }
  }, [applySnapshot, context])

  useEffect(() => { void refresh() }, [refresh])

  // Main owns both write sources (outline saves and pathway manifest CRUD) and pushes one refresh
  // event for this talk. Snapshot reconciliation keeps an in-flight local membership edit when a
  // pushed read still contains the previous manifest bytes.
  useEffect(() => {
    if (!context) return
    return window.tw.pathways.onChanged(({ outlinePath }) => {
      if (outlinePath === context.outlinePath) void refresh(false)
    })
  }, [context, refresh])

  // Second safety net for edits made outside the app: main's BrowserWindow focus push covers OS-level
  // refocus, but the DOM focus event also fires when the webContents regains focus (and in the e2e
  // harness, where synthetic window focus does not reach the BrowserWindow event).
  useEffect(() => {
    if (!context) return
    const onFocus = (): void => { void refresh(false) }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [context, refresh])

  const mutate = useCallback(async (
    call: (outlinePath: string, content: string) => Promise<PathwaySnapshot | { error: string }>
  ): Promise<boolean> => {
    if (!context) return false
    setBusy(true)
    try {
      const result = await call(context.outlinePath, content)
      if (isError(result)) throw new Error(result.error)
      applySnapshot(result)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setBusy(false)
    }
  }, [applySnapshot, content, context])

  const setSlideIds = useCallback(async (pathway: Pathway, slideIds: string[]): Promise<void> => {
    pendingSlideIds.current = { ...pendingSlideIds.current, [pathway.id]: [...slideIds] }
    setSnapshot((current) => current
      ? optimisticallySetPathwaySlides(current, pathway.id, slideIds)
      : current
    )
    const ok = await mutate((outlinePath, source) =>
      window.tw.pathways.setSlideIds(outlinePath, source, pathway.id, slideIds)
    )
    const stillThisEdit = pendingSlideIds.current[pathway.id]?.length === slideIds.length
      && slideIds.every((id, index) => pendingSlideIds.current[pathway.id]?.[index] === id)
    if (!ok && stillThisEdit) {
      const { [pathway.id]: _failed, ...remaining } = pendingSlideIds.current
      pendingSlideIds.current = remaining
      await refresh(false)
    }
  }, [mutate, refresh])

  const toggle = useCallback((pathway: Pathway, slideId: string): void => {
    const next = pathway.slideIds.includes(slideId)
      ? pathway.slideIds.filter((id) => id !== slideId)
      : [...pathway.slideIds, slideId]
    void setSlideIds(pathway, next)
  }, [setSlideIds])

  const moveSelected = useCallback((delta: -1 | 1): void => {
    if (!selected) return
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.slideId : undefined
    if (!focused) return
    void setSlideIds(selected, reorder(selected.slideIds, focused, delta))
  }, [selected, setSlideIds])

  const present = useCallback(async (): Promise<void> => {
    if (!context || !selected || selected.present.length === 0) return
    const result = await window.tw.pathways.present(context.outlinePath, content, selected.id)
    if (!result.success) setError(result.error || 'The pathway could not be presented.')
  }, [content, context, selected])

  const dropMissing = useCallback((): void => {
    if (!selected || selected.missing.length === 0) return
    const missing = new Set(selected.missing)
    void setSlideIds(selected, selected.slideIds.filter((id) => !missing.has(id)))
  }, [selected, setSlideIds])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (dialog || sheet) {
        if (event.key === 'Escape') { event.preventDefault(); setDialog(null); setSheet(false) }
        return
      }
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea')) return
      const key = event.key.toLowerCase()
      if (event.key === '?') { event.preventDefault(); setSheet(true); return }
      if ((event.metaKey || event.ctrlKey) && event.altKey && key === 'p') return
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'Backspace') { event.preventDefault(); dropMissing(); return }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Backspace') { event.preventDefault(); if (selected) setDialog({ kind: 'delete' }); return }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && key === 'n') { event.preventDefault(); setDialog({ kind: 'new', name: '', note: '' }); return }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && key === 'r') { event.preventDefault(); if (selected) setDialog({ kind: 'rename', name: selected.name }); return }
      if (event.altKey && key === 'r') { event.preventDefault(); setReordering((current) => !current); return }
      if ((event.metaKey || event.ctrlKey) && event.key === 'ArrowUp') { event.preventDefault(); moveSelected(-1); return }
      if ((event.metaKey || event.ctrlKey) && event.key === 'ArrowDown') { event.preventDefault(); moveSelected(1); return }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (key === 'g') { event.preventDefault(); setView('grid'); return }
      if (key === 'l') { event.preventDefault(); setView('list'); return }
      if (key === 'm') { event.preventDefault(); setView('matrix'); return }
      if (key === 'p' && view !== 'grid') { event.preventDefault(); setPreviews((current) => !current); return }
      if (event.key === 'Enter') { event.preventDefault(); void present(); return }
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key === ' ' && selected && target?.dataset.slideId) { event.preventDefault(); toggle(selected, target.dataset.slideId); return }
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
      const items = Array.from(document.querySelectorAll<HTMLElement>('[data-path-focus="true"]'))
      const at = items.indexOf(document.activeElement as HTMLElement)
      if (at < 0 || items.length === 0) return
      event.preventDefault()
      const delta = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1
      items[Math.max(0, Math.min(items.length - 1, at + delta))]?.focus()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [dialog, dropMissing, moveSelected, onClose, present, selected, sheet, toggle, view])

  const submitDialog = async (): Promise<void> => {
    if (!context || !dialog) return
    if (dialog.kind === 'new') {
      if (!dialog.name.trim()) return
      const ok = await mutate((outlinePath, source) => window.tw.pathways.create(outlinePath, source, dialog.name, dialog.note))
      if (ok) setDialog(null)
    } else if (dialog.kind === 'rename' && selected) {
      if (!dialog.name.trim()) return
      const ok = await mutate((outlinePath, source) => window.tw.pathways.rename(outlinePath, source, selected.id, dialog.name))
      if (ok) setDialog(null)
    } else if (dialog.kind === 'delete' && selected) {
      const ok = await mutate((outlinePath, source) => window.tw.pathways.delete(outlinePath, source, selected.id))
      if (ok) setDialog(null)
    }
  }

  const missingUnion = useMemo(() => {
    const ids: string[] = []
    for (const pathway of snapshot?.pathways ?? []) for (const id of pathway.missing) if (!ids.includes(id)) ids.push(id)
    return ids
  }, [snapshot])

  if (!context) return <div className="twp-loading">Opening Pathway view…</div>

  return (
    <div className={`twp ${reordering ? 'is-reordering' : ''}`}>
      <header className="twp-titlebar">
        <div className="twp-title"><b>Pathways</b><span>{context.talkTitle}</span></div>
        <div className="twp-spacer" />
        <button onClick={() => setDialog({ kind: 'new', name: '', note: '' })}><Plus /> New pathway <kbd>⌘N</kbd></button>
        <button className="primary" disabled={!selected?.present.length || busy} onClick={() => void present()}><Presentation /> Present this pathway <kbd>↵</kbd></button>
        <button className="icon" aria-label="Keyboard cheat-sheet" title="Keyboard cheat-sheet (?)" onClick={() => setSheet(true)}>?</button>
        <button className="icon" aria-label="Close Pathway view" onClick={onClose}><X /></button>
      </header>

      <div className="twp-body">
        <aside className="twp-list">
          <div className="twp-list-label">Pathways · {snapshot?.pathways.length ?? 0}</div>
          {(snapshot?.pathways ?? []).map((pathway) => (
            <button key={pathway.id} data-path-focus="true" className={pathway.id === selected?.id ? 'selected' : ''} onClick={() => setSelectedId(pathway.id)}>
              <span>{pathway.name}</span><small>{pathway.slideIds.length}</small>
            </button>
          ))}
          {selected ? <div className="twp-list-actions"><button onClick={() => setDialog({ kind: 'rename', name: selected.name })}><Pencil /> Rename <kbd>⌘R</kbd></button><button className="danger" onClick={() => setDialog({ kind: 'delete' })}><Trash2 /> Delete <kbd>⌘⌫</kbd></button></div> : null}
          <button data-path-focus="true" className="new" onClick={() => setDialog({ kind: 'new', name: '', note: '' })}><Plus /> New pathway</button>
          {!snapshot?.pathways.length ? <p>Create a pathway, then tick slides without changing the outline.</p> : null}
        </aside>

        <main className="twp-main">
          <div className="twp-subhead">
            <b>{selected?.name ?? 'No pathway selected'}</b>
            <span>{selected ? `${selected.present.length} of ${snapshot?.slides.length ?? 0} slides ticked` : 'Create a pathway to begin'}</span>
            <div className="twp-spacer" />
            <div className="twp-segment" aria-label="Pathway view">
              <button className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')}><kbd>G</kbd> Grid</button>
              <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}><kbd>L</kbd> List</button>
              <button className={view === 'matrix' ? 'active' : ''} onClick={() => setView('matrix')}><kbd>M</kbd> Matrix</button>
            </div>
            <small>{view === 'grid' ? "this pathway's slides" : view === 'list' ? 'running order · with previews' : 'all pathways side by side'}</small>
            {view !== 'grid' ? <button
              className={`previews ${previews ? 'active' : ''}`}
              data-pathway-previews-toggle
              aria-pressed={previews}
              onClick={() => setPreviews((current) => !current)}
            >{previews ? <ImageIcon /> : <ImageOff />} Previews <kbd>P</kbd></button> : null}
            <button className={`reorder ${reordering ? 'active' : ''}`} onClick={() => setReordering((current) => !current)}><GripVertical /> Reorder <kbd>⌥R</kbd></button>
          </div>

          {error ? <div className="twp-error" role="alert"><AlertTriangle /><span>{error}</span><button onClick={() => void refresh()}>Try again</button></div> : null}
          {selected?.missing.length ? (
            <div className="twp-warning" role="status" data-pathway-warning><AlertTriangle /><span>{selected.missing.length} ticked slide{selected.missing.length === 1 ? '' : 's'} no longer exist in the outline — skipped on present.</span><button onClick={dropMissing}>Drop {selected.missing.length === 1 ? 'it' : 'them'} <kbd>⌘⇧⌫</kbd></button></div>
          ) : null}

          <div className="twp-viewframe">
            {view === 'grid' ? (
              <div className="twp-grid" data-pathway-view="grid">
                {(snapshot?.slides ?? []).map((slide, index) => {
                  const ticked = !!selected?.slideIds.includes(slide.slide_id)
                  const order = selected ? selected.slideIds.indexOf(slide.slide_id) + 1 : 0
                  const image = thumbnails[thumbKey(slide)]
                  return <button
                    key={slide.slide_id || index}
                    className={`twp-card ${ticked ? 'ticked' : ''}`}
                    data-path-focus="true"
                    data-slide-id={slide.slide_id}
                    data-ticked={ticked ? 'true' : 'false'}
                    draggable={!!(reordering && ticked)}
                    onDragStart={() => setDragId(slide.slide_id)}
                    onDragOver={(event) => { if (dragId && ticked) event.preventDefault() }}
                    onDrop={() => {
                      if (!selected || !dragId || !ticked || dragId === slide.slide_id) return
                      const next = selected.slideIds.filter((id) => id !== dragId)
                      next.splice(next.indexOf(slide.slide_id), 0, dragId)
                      setDragId(null)
                      void setSlideIds(selected, next)
                    }}
                    onClick={() => { if (selected) toggle(selected, slide.slide_id) }}
                  >
                    <SlidePreview row={slide} image={image} />
                    <span className="twp-check"><Check /></span>
                    {ticked ? <span className="twp-order">{order}</span> : null}
                    <footer><small>{sectionName(slide)}</small><span>{slideTitle(slide)}</span></footer>
                  </button>
                })}
                {(selected?.missing ?? []).map((id) => <button key={id} className="twp-card missing" data-path-focus="true" data-slide-id={id}><AlertTriangle /><b>{id}</b><span>Slide removed</span></button>)}
                <p className="twp-grid-note">Click a thumbnail to tick · drag ticked cards (or ⌘↑/↓) to reorder when Reorder is on · the outline itself never changes</p>
              </div>
            ) : view === 'list' ? (
              <div className={`twp-list-wrap ${previews ? '' : 'no-previews'}`} data-pathway-view="list">
                {(snapshot?.slides ?? []).map((slide, index) => {
                  const ticked = !!selected?.slideIds.includes(slide.slide_id)
                  const order = selected ? selected.slideIds.indexOf(slide.slide_id) + 1 : 0
                  const image = thumbnails[thumbKey(slide)]
                  const snippet = slide.text_excerpt?.trim()
                  return <button
                    key={slide.slide_id || index}
                    className={`twp-list-row ${ticked ? 'ticked' : ''}`}
                    data-path-focus="true"
                    data-slide-id={slide.slide_id}
                    data-ticked={ticked ? 'true' : 'false'}
                    draggable={!!(reordering && ticked)}
                    onDragStart={() => setDragId(slide.slide_id)}
                    onDragOver={(event) => { if (dragId && ticked) event.preventDefault() }}
                    onDrop={() => {
                      if (!selected || !dragId || !ticked || dragId === slide.slide_id) return
                      const next = selected.slideIds.filter((id) => id !== dragId)
                      next.splice(next.indexOf(slide.slide_id), 0, dragId)
                      setDragId(null)
                      void setSlideIds(selected, next)
                    }}
                    onClick={() => { if (selected) toggle(selected, slide.slide_id) }}
                  >
                    <span className="twp-list-check">{ticked ? <Check /> : null}</span>
                    {previews ? <span className="twp-list-preview"><SlidePreview row={slide} image={image} /></span> : null}
                    <span className="twp-list-meta">
                      <small>{sectionName(slide)} · {slide.slide_id}</small>
                      <b>{slideTitle(slide)}</b>
                      {previews && snippet ? <span className="twp-list-snippet">{snippet}</span> : null}
                    </span>
                    {ticked ? <span className="twp-list-order">{order}</span> : null}
                    {reordering && ticked ? <GripVertical className="twp-list-drag" /> : null}
                  </button>
                })}
                {(selected?.missing ?? []).map((id) => {
                  const order = selected ? selected.slideIds.indexOf(id) + 1 : 0
                  return <button
                    key={id}
                    className="twp-list-row ticked missing"
                    data-path-focus="true"
                    data-slide-id={id}
                    data-ticked="true"
                    draggable={reordering}
                    onDragStart={() => setDragId(id)}
                    onDragOver={(event) => { if (dragId) event.preventDefault() }}
                    onDrop={() => {
                      if (!selected || !dragId || dragId === id) return
                      const next = selected.slideIds.filter((slideId) => slideId !== dragId)
                      next.splice(next.indexOf(id), 0, dragId)
                      setDragId(null)
                      void setSlideIds(selected, next)
                    }}
                    onClick={() => { if (selected) toggle(selected, id) }}
                  >
                    <span className="twp-list-check"><AlertTriangle /></span>
                    {previews ? <span className="twp-list-preview"><AlertTriangle /></span> : null}
                    <span className="twp-list-meta"><small>Missing · {id}</small><b>{id} — slide removed</b></span>
                    <span className="twp-list-order">{order}</span>
                    {reordering ? <GripVertical className="twp-list-drag" /> : null}
                  </button>
                })}
                <p className="twp-list-note">Click a row to tick · drag ticked rows (or ⌘↑/↓) to reorder when Reorder is on · the outline itself never changes</p>
              </div>
            ) : (
              <div className="twp-matrix-wrap" data-pathway-view="matrix">
                <table className="twp-matrix">
                  <thead><tr><th>OUTLINE ORDER →</th>{(snapshot?.pathways ?? []).map((pathway) => <th key={pathway.id} className={pathway.id === selected?.id ? 'selected' : ''}><button data-path-focus="true" onClick={() => setSelectedId(pathway.id)}><b>{pathway.name}</b><small>{pathway.slideIds.length} slides</small></button></th>)}<th><button data-path-focus="true" className="new" onClick={() => setDialog({ kind: 'new', name: '', note: '' })}><Plus /> New</button></th></tr></thead>
                  <tbody>
                    {(snapshot?.slides ?? []).map((slide, rowIndex, rows) => {
                      const showSection = rowIndex === 0 || sectionName(rows[rowIndex - 1]) !== sectionName(slide)
                      return [
                        showSection ? <tr className="section" key={`section-${rowIndex}`}><td>{sectionName(slide)}</td>{(snapshot?.pathways ?? []).map((pathway) => <td key={pathway.id} className={pathway.id === selected?.id ? 'selected' : ''} />)}<td /></tr> : null,
                        <tr key={slide.slide_id || rowIndex}>
                          <td>{previews ? <span className="twp-matrix-preview"><SlidePreview row={slide} image={thumbnails[thumbKey(slide)]} /></span> : null}<small>{slide.slide_id}</small><span>{slideTitle(slide)}</span></td>
                          {(snapshot?.pathways ?? []).map((pathway) => {
                            const ticked = pathway.slideIds.includes(slide.slide_id)
                            const order = pathway.slideIds.indexOf(slide.slide_id) + 1
                            return <td key={pathway.id} className={pathway.id === selected?.id ? 'selected' : ''}><button data-path-focus="true" data-slide-id={slide.slide_id} data-pathway-id={pathway.id} aria-label={`${ticked ? 'Untick' : 'Tick'} ${slide.title || slide.slide_id} in ${pathway.name}`} onClick={() => { setSelectedId(pathway.id); toggle(pathway, slide.slide_id) }}><span className={ticked ? 'box ticked' : 'box'}>{ticked ? <Check /> : null}</span>{ticked && pathway.id === selected?.id ? <small className="order">{order}</small> : null}</button></td>
                          })}
                          <td />
                        </tr>
                      ]
                    })}
                    {missingUnion.map((id) => <tr className="missing" key={`missing-${id}`}><td>{previews ? <span className="twp-matrix-preview missing"><AlertTriangle /></span> : null}<small>{id}</small><span>{id} — slide removed</span></td>{(snapshot?.pathways ?? []).map((pathway) => { const ticked = pathway.missing.includes(id); return <td key={pathway.id} className={`${pathway.id === selected?.id ? 'selected ' : ''}${ticked ? 'missing-cell' : ''}`}><button data-path-focus="true" data-slide-id={id} data-pathway-id={pathway.id} onClick={() => { setSelectedId(pathway.id); if (ticked) toggle(pathway, id) }}><span className={ticked ? 'box missing' : 'box'}>{ticked ? '!' : ''}</span></button></td>})}<td /></tr>)}
                  </tbody>
                </table>
                <p className="twp-matrix-note">Every pathway is a column against the one outline · click any cell to tick · the selected column is what “Present this pathway” runs · the outline never changes.</p>
              </div>
            )}
          </div>
        </main>
      </div>

      {busy ? <div className="twp-busy" role="status">Updating pathway…</div> : null}
      {sheet ? <PathwayCheatSheet onClose={() => setSheet(false)} /> : null}
      {dialog ? <div className="twp-dialog-backdrop"><form className="twp-dialog" onSubmit={(event) => { event.preventDefault(); void submitDialog() }}>
        <h2>{dialog.kind === 'new' ? 'New pathway' : dialog.kind === 'rename' ? 'Rename pathway' : 'Delete pathway?'}</h2>
        {dialog.kind === 'delete' ? <p>Delete “{selected?.name}”? The outline and its slides will not change.</p> : <>
          <label>Name<input autoFocus value={dialog.name} onChange={(event) => setDialog({ ...dialog, name: event.target.value })} /></label>
          {dialog.kind === 'new' ? <label>Note <textarea value={dialog.note} onChange={(event) => setDialog({ ...dialog, note: event.target.value })} placeholder="Optional context for this pathway" /></label> : null}
        </>}
        <footer><button type="button" onClick={() => setDialog(null)}>Cancel</button><button className={dialog.kind === 'delete' ? 'danger' : 'primary'} type="submit">{dialog.kind === 'delete' ? <><Trash2 /> Delete</> : dialog.kind === 'new' ? 'Create pathway' : 'Rename'}</button></footer>
      </form></div> : null}
    </div>
  )
}
