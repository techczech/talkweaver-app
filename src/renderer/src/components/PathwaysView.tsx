import ModeBack from './ModeBack'
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PathwaySnapshot, ProjectionRow, TalkInfo } from '../../../preload/index'
import { addPathwaySlides, insertPathwaySlides, movePathwaySlide, removePathwaySlides } from '../../../shared/slide-handling/pathway-list'
import { notify } from '../lib/notify'
import { useSlideSelection } from '../lib/useSlideSelection'
import { plainInlineText } from '../../../../compiler/scripts/lib/00-inline-render.mjs'
import { unresolvedTriggerBlock } from '../../../shared/layout-doctor'
import { commandRan } from '../commands/command-ran'
import { ConfirmCard, NameCard } from './cards'
import '../pathways.css'

export const PATHWAY_GRID_DRAG = 'application/x-tw-slides'
const LIST_DRAG = 'application/x-tw-pathway-slide'
type GridProps = { pathwayIds?: readonly string[]; onAddToPathway?: (ids: string[]) => void }
type Dialog = { kind: 'new' | 'rename' | 'delete'; name: string; add?: string[] }
type Props = {
  talk: TalkInfo; content: string; slides: ProjectionRow[] | null; thumbnails: Record<string, string> | null
  docked: boolean; children: (props: GridProps) => ReactNode
  /** The one back control (house rule R16): "Back to <talk>", and Esc, return to the Slides view. */
  onBack?: () => void
}

// The grid remains the outline surface; the dock only writes manifest lists. Serialize reads and
// writes together so a change notification cannot overwrite a later edit with an older snapshot.
export default function PathwaysView({ talk, content, slides, thumbnails, docked, children, onBack }: Props): JSX.Element {
  const [snapshot, setSnapshot] = useState<PathwaySnapshot | null>(null)
  const [pathwayId, setPathwayId] = useState<string | null>(null)
  const [matrix, setMatrix] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [adding, setAdding] = useState<string[] | null>(null)
  const [marker, setMarker] = useState<number | null>(null)
  const current = useRef({ snapshot, content, slides, pathwayId })
  current.current = { snapshot, content, slides, pathwayId }
  const queue = useRef(Promise.resolve())
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const enqueue = (work: () => Promise<void>): void => {
    queue.current = queue.current.then(async () => {
      if (alive.current) setBusy(true)
      try { await work(); if (alive.current) setError(null) }
      catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        if (alive.current) setError(message)
        else notify(message, 'error', 'pathway-edit')
      }
      finally { if (alive.current) setBusy(false) }
    })
  }
  const accept = (next: PathwaySnapshot | { error: string }): PathwaySnapshot => {
    if ('error' in next) throw new Error(next.error)
    current.current.snapshot = next
    if (alive.current) setSnapshot(next)
    return next
  }
  const refresh = (): void => enqueue(async () => { accept(await window.tw.pathways.read(talk.outlinePath, current.current.content)) })
  useEffect(() => { refresh() }, [talk.outlinePath]) // current editor buffer, never re-read disk over unsaved text
  const refreshInputs = useRef({ content, docked, adding: false })
  const choosing = adding !== null
  useEffect(() => {
    const before = refreshInputs.current
    refreshInputs.current = { content, docked, adding: choosing }
    if ((docked && !before.docked) || (choosing && !before.adding)) { refresh(); return }
    if (content === before.content || (!docked && !choosing)) return
    const timer = window.setTimeout(refresh, 300)
    return () => window.clearTimeout(timer)
  }, [talk.outlinePath, content, docked, choosing])
  useEffect(() => window.tw.pathways.onChanged(({ outlinePath }) => { if (outlinePath === talk.outlinePath) refresh() }), [talk.outlinePath])
  useEffect(() => {
    if (!docked && !choosing) return
    const focus = (): void => refresh()
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [talk.outlinePath, docked, choosing])

  const pathway = snapshot?.pathways.find(p => p.id === pathwayId) ?? snapshot?.pathways[0] ?? null
  const rows = slides ?? snapshot?.slides ?? []
  const byId = new Map(rows.map(r => [r.slide_id, r]))
  const ids = pathway?.slideIds ?? []
  const missing = pathway?.missing ?? []
  const keys = useMemo(() => ids.map(id => `pathway:${pathway?.id}:${id}`), [pathway?.id, ids])
  const selection = useSlideSelection(keys)
  const title = (id: string): string => plainInlineText(byId.get(id)?.title || byId.get(id)?.nav_title) || id
  const writeIds = (id: string, change: (before: string[]) => string[]): void => enqueue(async () => {
    const before = current.current.snapshot?.pathways.find(p => p.id === id)
    if (!before) throw new Error('That pathway no longer exists.')
    const next = change(before.slideIds)
    if (next.length === before.slideIds.length && next.every((value, i) => value === before.slideIds[i])) return
    accept(await window.tw.pathways.setSlideIds(talk.outlinePath, current.current.content, id, next))
  })
  const add = (id: string, chosen: string[]): void => {
    writeIds(id, before => addPathwaySlides(before, chosen, (current.current.slides ?? []).map(r => r.slide_id)))
    setAdding(null)
    commandRan('add-to-pathway')
  }
  const present = (): void => {
    if (!pathway) return
    const id = pathway.id
    enqueue(async () => {
      const source = current.current.content
      const blocked = unresolvedTriggerBlock(source)
      if (blocked) throw new Error(blocked.message)
      const result = await window.tw.pathways.present(talk.outlinePath, source, id)
      if (!result.success) throw new Error(result.error || 'The pathway could not be presented.')
      commandRan('present-pathway')
    })
  }
  useEffect(() => {
    if (!docked) return
    const onCommand = (event: Event): void => { if ((event as CustomEvent).detail === 'present') present() }
    window.addEventListener('tw-pathway-command', onCommand)
    return () => window.removeEventListener('tw-pathway-command', onCommand)
  })
  useEffect(() => {
    if (!dialog && !adding) return
    const close = (event: KeyboardEvent): void => {
      // SHORTCUT-SCAN-IGNORE: Escape dismisses this local dialog; no pathway-window keymap.
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDialog(null); setAdding(null) }
    }
    window.addEventListener('keydown', close, { capture: true })
    return () => window.removeEventListener('keydown', close, { capture: true })
  }, [dialog, adding])
  // Esc leaves Pathways for the talk, as the back control does. A dialog's own Esc (above, capture phase) goes first; a field or
  // control that handles Escape itself (clearing a search, closing a menu) stops it or prevents its default and keeps it;
  // an Escape nothing handled, even with the dock's select focused, leaves.
  useEffect(() => {
    if (!docked || !onBack) return
    const leave = (event: KeyboardEvent): void => {
      // SHORTCUT-SCAN-IGNORE: Escape leaves the mode, the same as its back control (house rule R16); no pathway-window keymap.
      if (event.key !== 'Escape' || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (dialog || adding || document.querySelector('[role=dialog][aria-modal=true], [role=menu]')) return
      event.preventDefault()
      onBack()
    }
    window.addEventListener('keydown', leave)
    return () => window.removeEventListener('keydown', leave)
  }, [docked, onBack, dialog, adding])
  const submit = (typed?: string): void => {
    if (!dialog) return
    const name = (typed ?? dialog.name).trim()
    if (dialog.kind !== 'delete' && !name) return
    const choice = { ...dialog, name }
    const selected = pathway?.id
    setDialog(null)
    enqueue(async () => {
      if (choice.kind === 'new') {
        const old = new Set(current.current.snapshot?.pathways.map(p => p.id))
        const next = accept(await window.tw.pathways.create(talk.outlinePath, current.current.content, choice.name.trim()))
        const created = next.pathways.find(p => !old.has(p.id))
        if (created) {
          setPathwayId(created.id)
          // New-with-selection is a create action followed by the single membership edit.
          if (choice.add?.length) add(created.id, choice.add)
        }
      } else if (selected) {
        accept(await (choice.kind === 'rename'
          ? window.tw.pathways.rename(talk.outlinePath, current.current.content, selected, choice.name.trim())
          : window.tw.pathways.delete(talk.outlinePath, current.current.content, selected)))
      }
      commandRan(choice.kind === 'delete' ? 'pathway.delete' : `pathway.${choice.kind}`)
    })
  }
  const readDrop = (event: React.DragEvent): string[] | null => {
    try {
      const list = event.dataTransfer.getData(LIST_DRAG)
      const raw = JSON.parse(list || event.dataTransfer.getData(PATHWAY_GRID_DRAG))
      if (raw.outlinePath !== talk.outlinePath || !Array.isArray(raw.slideIds) || !raw.slideIds.every((id: unknown) => typeof id === 'string')) return null
      if (list) return raw.pathwayId === pathway?.id && raw.slideIds.every((id: string) => ids.includes(id)) ? raw.slideIds : null
      return raw.slideIds.every((id: string) => byId.has(id)) ? raw.slideIds : null
    } catch { return null }
  }
  const dropProps = (at: number) => ({
    onDragOver: (event: React.DragEvent) => {
      if (!pathway || ![PATHWAY_GRID_DRAG, LIST_DRAG].some(type => event.dataTransfer.types.includes(type))) return
      event.preventDefault(); event.stopPropagation(); setMarker(at)
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault(); event.stopPropagation(); setMarker(null)
      const incoming = readDrop(event)
      if (pathway && incoming?.length) writeIds(pathway.id, before => insertPathwaySlides(before, incoming, at))
    }
  })
  const image = (id: string): string | undefined => { const row = byId.get(id); return row ? thumbnails?.[row.render_hash || row.content_hash || id] : undefined }
  return <div className={`pathways-layout${docked ? ' pathways-layout--docked' : ''}`}>
    <div className="pathways-grid">{docked && onBack && <div className="mode-back-bar" data-pathways-back><ModeBack talkTitle={talk.title} onBack={onBack} /></div>}{children({ pathwayIds: docked ? ids : undefined, onAddToPathway: docked ? setAdding : undefined })}</div>
    {docked && <aside className={`pathway-dock${matrix ? ' pathway-dock--matrix' : ''}`} aria-label="Pathway" data-pathway-dock>
      <header><h3>Pathway <small>The outline never changes</small></h3>
        <select aria-label="Pathway" value={pathway?.id ?? ''} onChange={e => { setPathwayId(e.target.value); selection.clear() }}>
          {!pathway && <option value="">Choose or create a pathway</option>}
          {snapshot?.pathways.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="pathway-actions"><button onClick={() => setDialog({ kind: 'new', name: '' })}>New</button><button disabled={!pathway} onClick={() => setDialog({ kind: 'rename', name: pathway?.name ?? '' })}>Rename</button><button disabled={!pathway} onClick={() => setDialog({ kind: 'delete', name: pathway?.name ?? '' })}>Delete</button></div>
        <div className="pathway-actions"><span>{ids.length} slides</span><button aria-pressed={!matrix} onClick={() => setMatrix(false)}>List</button><button aria-pressed={matrix} onClick={() => setMatrix(true)}>Matrix</button></div>
      </header>
      {error && <p role="alert">{error} <button onClick={refresh}>Try again</button></p>}
      {missing.length > 0 && <p role="status" data-pathway-warning>{missing.length} slides no longer in the talk. <button onClick={() => pathway && writeIds(pathway.id, before => removePathwaySlides(before, current.current.snapshot?.pathways.find(p => p.id === pathway.id)?.missing ?? []))}>Drop missing</button></p>}
      {matrix ? <div className="pathway-matrix-scroll"><table data-pathway-matrix><thead><tr><th>Talk order</th>{snapshot?.pathways.map(p => <th key={p.id}><button onClick={() => setPathwayId(p.id)} aria-pressed={pathway?.id === p.id}>{p.name}</button></th>)}</tr></thead><tbody>
        {[...rows.map(r => r.slide_id), ...new Set(snapshot?.pathways.flatMap(p => p.slideIds.filter(id => !byId.has(id))) ?? [])].map(id => <tr key={id}><td>{title(id)}{snapshot?.pathways.some(p => p.missing.includes(id)) && ' — missing'}</td>{snapshot?.pathways.map(p => <td key={p.id}><button aria-label={`${p.slideIds.includes(id) ? 'Remove' : 'Add'} ${title(id)} ${p.slideIds.includes(id) ? 'from' : 'to'} ${p.name}`} onClick={() => writeIds(p.id, before => before.includes(id) ? removePathwaySlides(before, [id]) : addPathwaySlides(before, [id], rows.map(r => r.slide_id)))}>{p.slideIds.includes(id) ? p.slideIds.indexOf(id) + 1 : '+'}</button></td>)}</tr>)}
      </tbody></table></div> : <div className="pathway-list" data-pathway-list onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setMarker(null) }}>
        {!ids.length && <p>Empty. Drag slides here, or select slides and use Add to pathway.</p>}
        {ids.map((id, i) => <Fragment key={id}>
          {marker === i && <div className="pathway-insertion-marker" data-pathway-insertion-marker />}
          <div className={`pathway-row${selection.focusedIndex === i ? ' pathway-row--focused' : ''}`} data-pathway-row={id} role="listitem" tabIndex={0} draggable
            onFocus={() => selection.reset(i)} onClick={() => selection.reset(i)}
            onKeyDown={e => {
              if ((e.metaKey || e.ctrlKey) && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
                e.preventDefault(); e.stopPropagation()
                if (pathway) writeIds(pathway.id, before => movePathwaySlide(before, id, e.key === 'ArrowUp' ? -1 : 1))
                commandRan('pathway.move-item')
              } else if (!e.metaKey && !e.ctrlKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
                e.preventDefault(); const next = Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowUp' ? -1 : 1)))
                e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[data-pathway-row]')[next]?.focus()
              }
            }}
            onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData(LIST_DRAG, JSON.stringify({ outlinePath: talk.outlinePath, pathwayId: pathway?.id, slideIds: [id] })) }} onDragEnd={() => setMarker(null)} {...dropProps(i)}>
            <span className="pathway-grip" aria-hidden>⠿</span><span className="pathway-number">{i + 1}</span>
            {image(id) && <img src={image(id)} alt="" />}<span className="pathway-row-title">{title(id)}{missing.includes(id) && <small>Slide removed</small>}</span>
            <button aria-label={`Remove ${title(id)} from pathway`} onClick={e => { e.stopPropagation(); if (pathway) writeIds(pathway.id, before => removePathwaySlides(before, [id])) }}>×</button>
          </div>
        </Fragment>)}
        <div className="pathway-drop-end" data-pathway-drop-end {...dropProps(ids.length)}>{marker === ids.length && <div className="pathway-insertion-marker" data-pathway-insertion-marker />}</div>
      </div>}
      <footer><button disabled={!pathway || !ids.some(id => byId.has(id)) || busy} onClick={present}>Present this pathway</button></footer>
    </aside>}
    {!docked && error && <p role="alert">{error}</p>}
    {adding && <div className="pathway-dialog-backdrop" onMouseDown={() => setAdding(null)}><section role="dialog" aria-label="Add to pathway" className="pathway-dialog" onMouseDown={e => e.stopPropagation()}><h3>Add {adding.length} slides in talk order</h3>{snapshot?.pathways.map(p => <button key={p.id} onClick={() => add(p.id, adding)}>{p.name} ({p.slideIds.length} slides)</button>)}<button onClick={() => { setDialog({ kind: 'new', name: '', add: adding }); setAdding(null) }}>New pathway…</button><button onClick={() => setAdding(null)}>Cancel</button></section></div>}
    {dialog?.kind === 'delete' && <ConfirmCard title="Delete this pathway?" itemName={dialog.name} consequence="The pathway is removed from this talk. The talk's slides are not affected." recovery="A deleted pathway cannot be recovered." cta="Delete" onCancel={() => setDialog(null)} onConfirm={() => submit()} />}
    {dialog && dialog.kind !== 'delete' && <NameCard kind="pathway" mode={dialog.kind} initial={dialog.name} cta={dialog.kind === 'new' ? 'Create' : 'Rename'} onCancel={() => setDialog(null)} onSubmit={(value) => submit(value)} />}
  </div>
}
