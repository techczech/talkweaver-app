// The layout picker, docked in the Inspector's column under the pinned slide preview (ADR-0032 §2).
// State, filtering, grouping and the arrow-key walk live in layoutPickerColumnModel.ts; this file
// draws the rows and turns keys and pointer rests into the model's actions. Trying a layout is
// reported upward (`onTry`) and changes only the preview; ↵ reports `onKeep`, which the workspace
// writes through the set-layout verb.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { History, Layers, Search, Sparkles, Ban, ChevronRight, LibraryBig, TextCursorInput, X } from 'lucide-react'
import '../layoutPicker.css'
import type { SlideRef } from '../../../shared/layout-verbs'
import {
  SUGGESTED_COLUMNS_NARROW,
  SUGGESTED_COLUMNS_WIDE,
  TRY_DELAY_MS,
  buildPickerCatalog,
  highlightedStop,
  initialPickerState,
  ownPictureWanted,
  pickerCommit,
  pickerTry,
  pickerView,
  reducePicker,
  stopKey,
  type PickerAction,
  type PickerCatalog,
  type PickerEntry,
  type PickerGroup,
  type PickerState,
  type PickerStop,
  type TryCause,
  withRenderVerdicts
} from './layoutPickerColumnModel'
import { useOwnSlidePictures } from './useOwnSlidePictures'
import { isGreyMark, type VariantPictureMarks } from '../../../shared/variant-picture-queue'

/** Column width under which the Suggested row wraps to three across (S12). */
const NARROW_BELOW_PX = 470
/** A pointer resting this long on a picture highlights it, which tries it (TRY_DELAY_MS.pointer). */
const POINTER_REST_MS = TRY_DELAY_MS.pointer
/** Rows this far outside the scroll area still get their picture, so it is ready as they scroll in. */
const VISIBLE_MARGIN_PX = 120

// Sample pictures for every layout, fetched once per app run: the picture of a layout the slide cannot take, and the fallback when the own-slide render fails.
let sampleThumbnails: Promise<Record<string, string> | null> | null = null
function loadSampleThumbnails(): Promise<Record<string, string> | null> {
  sampleThumbnails ??= window.tw.layout.previewThumbnails().catch(() => null)
  return sampleThumbnails
}

interface Props {
  outlinePath: string
  /** The outline text now (the editor's buffer as the workspace mirrors it). */
  outline: string
  slide: SlideRef
  /** Search words the box opens with (Insert › a diagram family opens on its name). */
  initialQuery?: string
  /** The layout being tried (shown on the preview, nothing written), or null to show the slide as it is. */
  onTry: (layout: string | null) => void
  onKeep: (layout: string, withStarterText: boolean) => void
  onClose: () => void
}

/** The render's "cannot take" reasons, by layout. */
function greyReasons(marks: VariantPictureMarks): Record<string, string> {
  const reasons: Record<string, string> = {}
  for (const [name, mark] of Object.entries(marks)) if (isGreyMark(mark)) reasons[name] = mark.reason
  return reasons
}

function Picture({ entry, src, pending, showName = true }: { entry: PickerEntry; src: string | undefined; pending: boolean; showName?: boolean }): React.JSX.Element {
  return (
    <span className={`lp-picture${pending ? ' is-pending' : ''}`} aria-hidden>
      {src ? <img src={src} alt="" data-layout-thumb={entry.name} draggable={false} /> : showName ? <span className="lp-picture-name">{entry.label}</span> : null}
    </span>
  )
}

export default function LayoutPickerColumn({ outlinePath, outline, slide, initialQuery = '', onTry, onKeep, onClose }: Props): React.JSX.Element | null {
  const rootRef = useRef<HTMLElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<PickerState>(() => {
    if (!initialQuery.trim()) return initialPickerState()
    try { return reducePicker(buildPickerCatalog({ outline, slide }), initialPickerState(), { type: 'query', query: initialQuery }) } catch { return initialPickerState() }
  })
  const [narrow, setNarrow] = useState(false)
  const [samples, setSamples] = useState<Record<string, string> | null | undefined>(undefined)
  const [visible, setVisible] = useState<string[]>([])
  const causeRef = useRef<TryCause>('keys')
  const sessionRecent = useRef<string[]>([])
  const restTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const baseCatalog = useMemo<PickerCatalog | null>(() => {
    try { return buildPickerCatalog({ outline, slide, sessionRecent: sessionRecent.current }) } catch { return null }
  }, [outline, slide])
  // The slide is gone (deleted or renamed away from under the picker): nothing to pick for.
  useEffect(() => { if (!baseCatalog) onClose() }, [baseCatalog, onClose])

  useEffect(() => { let live = true; void loadSampleThumbnails().then((map) => { if (live) setSamples(map) }); return () => { live = false } }, [])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const measure = (): void => setNarrow(root.clientWidth < NARROW_BELOW_PX)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  // Focus the search box on open. CodeMirror still holds focus when ⌘L fires and can take it back on blur,
  // so the focus is retried once.
  useEffect(() => {
    const focus = (): void => inputRef.current?.focus()
    focus()
    const frame = requestAnimationFrame(focus)
    const timer = setTimeout(focus, 60)
    return () => { cancelAnimationFrame(frame); clearTimeout(timer) }
  }, [])

  // Own-slide pictures (ADR-0032 §6): the Suggested layouts at once, every other row only while it is on
  // screen. Layouts the slide cannot take are not asked for; they keep their sample.
  const wanted = useMemo(() => (baseCatalog ? ownPictureWanted(baseCatalog, visible) : []), [baseCatalog, visible])
  const own = useOwnSlidePictures({ outlinePath, outline, slide, wanted })
  // The render's "cannot take" verdicts grey a row exactly as the registry's do (not keepable, reason shown).
  const catalog = useMemo<PickerCatalog | null>(() => (baseCatalog ? withRenderVerdicts(baseCatalog, greyReasons(own)) : null), [baseCatalog, own])
  const options = useMemo(() => ({ suggestedColumns: narrow ? SUGGESTED_COLUMNS_NARROW : SUGGESTED_COLUMNS_WIDE }), [narrow])
  const view = useMemo(() => (catalog ? pickerView(catalog, state, options) : null), [catalog, state, options])

  // Which picture rows are on screen: the body's scroll area is the observer's root.
  const viewKey = view ? view.rows.flat().map(stopKey).join('|') : ''
  useEffect(() => {
    const body = bodyRef.current
    if (!body || typeof IntersectionObserver === 'undefined') return
    const seen = new Set<string>()
    const publish = (): void => {
      const next = [...seen].sort()
      setVisible((current) => (current.length === next.length && current.every((name, index) => name === next[index]) ? current : next))
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const name = (entry.target as HTMLElement).dataset.layoutName
        if (!name) continue
        if (entry.isIntersecting) seen.add(name); else seen.delete(name)
      }
      publish()
    }, { root: body, rootMargin: `${VISIBLE_MARGIN_PX}px 0px` })
    body.querySelectorAll<HTMLElement>('[data-layout-name]').forEach((element) => { if (element.querySelector('.lp-picture')) observer.observe(element) })
    return () => { observer.disconnect(); seen.clear(); publish() }
  }, [viewKey])

  const tried = catalog && view ? pickerTry(catalog, view, state) : null
  const shownTry = tried && tried !== catalog?.currentName ? tried : null
  useEffect(() => {
    const timer = setTimeout(() => onTry(shownTry), TRY_DELAY_MS[causeRef.current])
    return () => clearTimeout(timer)
  }, [shownTry]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onTry(null), []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (state.cursor == null) return
    bodyRef.current?.querySelector<HTMLElement>(`[data-stop="${CSS.escape(state.cursor)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [state.cursor])

  const send = (action: PickerAction, cause: TryCause = 'keys'): void => {
    if (!catalog) return
    causeRef.current = cause
    setState((current) => reducePicker(catalog, current, action, options))
  }

  const keep = (withStarterText: boolean): void => {
    if (!catalog || !view) return
    const commit = pickerCommit(catalog, view, state)
    if (!commit || 'blocked' in commit) return
    sessionRecent.current = [commit.layout, ...sessionRecent.current.filter((name) => name !== commit.layout)]
    onKeep(commit.layout, withStarterText)
  }

  useEffect(() => {
    if (!catalog || !view) return
    const onKey = (event: KeyboardEvent): void => {
      const active = document.activeElement
      const root = rootRef.current
      if (!root || !(root.contains(active) || active === document.body || active == null)) return
      const stop = highlightedStop(view, state)
      const consume = (): void => { event.preventDefault(); event.stopPropagation() }
      if (event.key === 'Escape') { consume(); onClose(); return }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { consume(); send({ type: 'move', dir: event.key === 'ArrowDown' ? 'down' : 'up' }); return }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        // In the result list the arrows stay with the search box's caret; on a picture row or a purpose they walk.
        const rowLength = stop ? view.rows.find((row) => row.some((candidate) => stopKey(candidate) === stopKey(stop)))?.length ?? 1 : 1
        if (stop && (stop.kind === 'purpose' || rowLength > 1)) { consume(); send({ type: 'move', dir: event.key === 'ArrowRight' ? 'right' : 'left' }) }
        return
      }
      if (event.key === 'Tab') { consume(); send({ type: 'next-group' }); return }
      if (event.key === 'Enter') {
        consume()
        if (view.noResults) { inputRef.current?.select(); return }
        if (stop?.kind === 'purpose') send({ type: 'activate' })
        else keep(event.metaKey || event.ctrlKey)
        return
      }
      if (active !== inputRef.current && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) inputRef.current?.focus()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  })

  if (!catalog || !view) return null

  const entryOf = (name: string): PickerEntry => catalog.entries.find((candidate) => candidate.name === name) as PickerEntry
  const highlighted = highlightedStop(view, state)
  const highlightedEntry = highlighted?.kind === 'layout' ? entryOf(highlighted.name) : null
  const isCursor = (stop: PickerStop): boolean => state.cursor === stopKey(stop)

  // A pointer resting on a picture for a quarter of a second tries it; a click keeps it (mockup keyboard map).
  const pointAt = (stop: PickerStop): void => {
    if (restTimer.current) clearTimeout(restTimer.current)
    restTimer.current = setTimeout(() => send({ type: 'point', key: stopKey(stop) }), POINTER_REST_MS)
  }
  const leave = (): void => { if (restTimer.current) clearTimeout(restTimer.current) }
  const clickStop = (stop: PickerStop): void => {
    leave()
    if (stop.kind === 'purpose') { send({ type: 'point', key: stopKey(stop) }); send({ type: 'activate' }); return }
    const entry = entryOf(stop.name)
    if (!entry.usable) { send({ type: 'point', key: stopKey(stop) }); return }
    sessionRecent.current = [entry.name, ...sessionRecent.current.filter((name) => name !== entry.name)]
    onKeep(entry.name, false)
  }

  const pictureFor = (entry: PickerEntry, group: PickerGroup['id']): React.JSX.Element => {
    // The author's own slide wherever the layout can take it; the registry sample otherwise, and when the render fails.
    const wantsOwn = entry.usable
    const mark = own[entry.name]
    const ownUrl = wantsOwn ? (typeof mark === 'string' || mark === null ? mark : undefined) : null
    const drawing = wantsOwn && ownUrl === undefined
    const src = ownUrl ?? (drawing ? undefined : samples?.[entry.name])
    const pending = drawing || (!wantsOwn && samples === undefined)
    return <Picture entry={entry} src={src ?? undefined} pending={pending} showName={!(group === 'suggested' && drawing)} />
  }

  const stopProps = (stop: PickerStop, extra = ''): React.HTMLAttributes<HTMLElement> & { 'data-stop': string } => ({
    'data-stop': stopKey(stop),
    className: `${extra}${isCursor(stop) ? ' is-cursor' : ''}`.trim(),
    onMouseDown: (event) => event.preventDefault(),
    onMouseEnter: () => pointAt(stop),
    onMouseLeave: leave,
    onClick: () => clickStop(stop)
  })

  const layoutButton = (stop: Extract<PickerStop, { kind: 'layout' }>, shape: PickerGroup['shape'], groupId: PickerGroup['id']): React.JSX.Element => {
    const entry = entryOf(stop.name)
    const now = entry.name === catalog.currentName
    // Greyed when the registry verdict says so, or when the render says this text cannot take it.
    const base = `lp-item lp-item--${shape}${entry.usable ? '' : ' is-unusable'}`
    const common = { 'data-layout-name': entry.name, role: 'option' as const, 'aria-selected': isCursor(stop), 'aria-disabled': !entry.usable || undefined, type: 'button' as const, title: entry.usable ? entry.fits : entry.reason ?? undefined }
    if (shape === 'chips') {
      return <button key={stopKey(stop)} {...common} {...stopProps(stop, base)}>{entry.label}</button>
    }
    if (shape === 'pictures') {
      return (
        <button key={stopKey(stop)} {...common} {...stopProps(stop, base)}>
          {pictureFor(entry, groupId)}
          <span className="lp-name">{entry.label}</span>
        </button>
      )
    }
    if (shape === 'list') {
      return (
        <button key={stopKey(stop)} {...common} {...stopProps(stop, base)}>
          {pictureFor(entry, groupId)}
          <span className="lp-text">
            <span className="lp-name">{entry.label}{now && <em className="lp-now-badge">now</em>}</span>
            {entry.usable ? <span className="lp-fits">{entry.fits}</span> : <span className="lp-reason"><Ban aria-hidden /> {entry.reason}</span>}
          </span>
          <span className="lp-purpose">{entry.purpose}</span>
        </button>
      )
    }
    // cards
    return (
      <button key={stopKey(stop)} {...common} {...stopProps(stop, base)}>
        <span className="lp-picture-wrap">
          {pictureFor(entry, groupId)}
          {groupId === 'container' && catalog.container && <span className="lp-stack-badge"><Layers aria-hidden /> {catalog.container.slides}</span>}
        </span>
        <span className="lp-name">{entry.label}{now && <em className="lp-now-badge">now</em>}</span>
        {entry.usable ? <span className="lp-fits">{entry.fits}</span> : <span className="lp-reason"><Ban aria-hidden /> {entry.reason}</span>}
      </button>
    )
  }

  const icon = (id: PickerGroup['id']): React.JSX.Element =>
    id === 'recent' ? <History aria-hidden /> : id === 'suggested' ? <Sparkles aria-hidden /> : id === 'container' ? <Layers aria-hidden /> : <LibraryBig aria-hidden />

  // S5: while the Suggested pictures are still being drawn the caption says so.
  const suggestedDrawing = catalog.suggested.some((suggestion) => own[suggestion.layout] === undefined)
  const caption = (group: PickerGroup): string => (group.id === 'suggested' && group.shape === 'pictures' && suggestedDrawing ? 'Drawing your slide…' : group.caption)

  const renderGroup = (group: PickerGroup): React.JSX.Element => (
    <section key={group.id} className={`lp-group lp-group--${group.id}`} aria-label={group.heading}>
      <h3 className="lp-group-head">
        {group.id !== 'results' && icon(group.id)}
        <span>{group.heading}</span>
        {caption(group) && <span className="lp-group-caption">{caption(group)}</span>}
      </h3>
      {group.shape === 'note' && (
        <p className="lp-note">
          <TextCursorInput aria-hidden />
          <span>
            <b>{group.noteLead}</b>{' '}
            {(group.note ?? '').split('⌘↵').map((part, index) => (index === 0 ? part : <span key={index}><kbd>⌘↵</kbd>{part}</span>))}
          </span>
        </p>
      )}
      {group.blocks.map((block, index) => (
        <div key={block.header ? block.header.purpose : index} className="lp-block">
          {block.header && (
            <button
              type="button"
              role="option"
              aria-selected={isCursor(block.header)}
              aria-expanded={block.header.open}
              {...stopProps(block.header, 'lp-purpose-row')}
            >
              <ChevronRight className={block.header.open ? 'is-open' : ''} aria-hidden />
              <span className="lp-purpose-name">{block.header.purpose}</span>
              <span className="lp-count">{block.header.count}</span>
            </button>
          )}
          {block.rows.length > 0 && (
            <div
              className={`lp-rows lp-rows--${group.id === 'container' || group.id === 'all' ? 'cards' : group.shape}`}
              style={group.shape === 'pictures' || group.id === 'container' ? { gridTemplateColumns: `repeat(${block.rows[0].length}, minmax(0, 1fr))` } : undefined}
            >
              {block.rows.flat().map((stop) => layoutButton(stop, group.id === 'container' || group.id === 'all' ? 'cards' : group.shape, group.id))}
            </div>
          )}
        </div>
      ))}
    </section>
  )

  const keys = (
    highlighted?.kind === 'purpose'
      ? [['↵', 'Open'], ['←', 'Close group'], ['↑↓', 'Move'], ['Esc', 'Close']]
      : highlightedEntry && !highlightedEntry.usable
        ? [['↑↓', 'Move'], ['Esc', 'Close']]
        : highlightedEntry
          ? [['⌘↵', 'Keep with starter text'], ['Esc', 'Put back'], ['↑↓', 'Try another']]
          : view.noResults
            ? [['↵', 'Edit the search'], ['Esc', 'Close']]
            : [['↑↓', 'Try on the slide'], ['Tab', 'Next group'], ['Esc', 'Close']]
  )

  return (
    <section ref={rootRef} className="lp" aria-label="Layout picker" data-layout-picker>
      <header className="lp-head">
        <span className="lp-title"><LibraryBig aria-hidden /> Layout</span>
        <span className="lp-current">now <b>{catalog.currentLabel}</b></span>
        <button type="button" className="lp-close" aria-label="Close the layout picker (Esc)" title="Put the slide back and close (Esc)" onClick={onClose}><X aria-hidden /></button>
      </header>
      <div className="lp-search">
        <Search aria-hidden />
        <input
          ref={inputRef}
          type="text"
          value={state.query}
          placeholder="Find a layout"
          aria-label="Find a layout"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => send({ type: 'query', query: event.target.value }, 'typing')}
        />
      </div>
      <div className="lp-body" role="listbox" aria-label="Layouts" ref={bodyRef}>
        {view.noResults ? (
          <div className="lp-empty">
            <p className="lp-empty-title"><Search aria-hidden /> No layout matches “{state.query.trim()}”</p>
            <p className="lp-empty-help">Search looks at names and the line under each name.</p>
            <button type="button" onClick={() => send({ type: 'browse-all' })}><LibraryBig aria-hidden /> Browse all {view.total} layouts</button>
          </div>
        ) : view.groups.map(renderGroup)}
      </div>
      <footer className="lp-foot">
        {highlightedEntry && !highlightedEntry.usable && <span className="lp-foot-warn">Not available on this slide</span>}
        {highlightedEntry?.usable && <span className="lp-foot-keep"><b>↵</b> Keep {highlightedEntry.label}</span>}
        {keys.map(([key, label]) => <span key={label} className="lp-foot-key"><kbd>{key}</kbd> {label}</span>)}
      </footer>
    </section>
  )
}
