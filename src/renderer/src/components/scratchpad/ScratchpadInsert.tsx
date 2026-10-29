// Slide Scratchpad ticket 2 in the panel: the two Insert buttons (with the small chooser when a picked slide shows
// several visuals) and the placement note with Change place. The panel only asks; the workspace inserts
// (lib/scratchpadInsert.ts through WorkspaceLayout), so nothing in this file can change the outline by itself.
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { ScratchItem } from '../../../../shared/scratchpad'
import { scratchVisuals, type ScratchPlace, type ScratchVisual } from '../../../../shared/scratchpad-insert'

/** One slide of the talk, as Change place lists it. */
export interface PlaceChoice { line: number; level: number; title: string; no: number | null }

/** What the workspace gives the panel for inserting. */
export interface ScratchpadInsertApi {
  /** Where an insert goes now: the place chosen by hand, else after the slide at the cursor (or selected in the grid). */
  place: ScratchPlace
  /** The place was chosen by hand (Change place). */
  chosen: boolean
  /** The cursor is inside a slide's text in the editor, so Insert visual only goes there (while not chosen by hand). */
  caretInBody: boolean
  /** The talk's slides for Change place. */
  rows(): PlaceChoice[]
  /** The strip's number of the slide on this heading line, or null. */
  numberAt(line: number): number | null
  /** Change place: a place by hand; null follows the cursor again. */
  choose(place: ScratchPlace | null): void
  insert(item: ScratchItem, mode: 'slide' | 'visual', visual?: ScratchVisual | null): Promise<boolean>
  insertMany(ids: string[]): Promise<boolean>
  /** An insert is running; the Insert buttons wait. */
  busy: boolean
  /** The card's Inserted note: a slide with this title is in the talk now (gone after an Undo or a delete). */
  hasSlideTitled(title: string): boolean
}

const quoted = (title: string): string => `‘${title}’`

/**
 * A small menu closes on any press, click or focus outside `inside` (the menu and the button that opens it), and on
 * Escape. Capture phase, and click and focus as well as mousedown: a click delivered without a mousedown (an
 * accessibility press, a synthetic click) or a press whose handler stops propagation still closes it, so the menu
 * never stays over the panel blocking clicks.
 */
function useDismiss(inside: RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return undefined
    const away = (e: Event): void => { if (inside.current && !inside.current.contains(e.target as Node)) close.current() }
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); close.current() } }
    const kinds = ['mousedown', 'click', 'focusin'] as const
    for (const kind of kinds) document.addEventListener(kind, away, true)
    document.addEventListener('keydown', esc, true)
    return () => { for (const kind of kinds) document.removeEventListener(kind, away, true); document.removeEventListener('keydown', esc, true) }
  }, [inside, open])
}

/** "slide 7" when the strip numbers it, else the slide's title. */
function slideName(api: ScratchpadInsertApi, place: ScratchPlace): string {
  if (place.kind === 'start') return 'the start of the talk'
  const no = api.numberAt(place.line)
  return no != null ? `slide ${no}` : quoted(place.title)
}

/** What the note says an insert will do, for this item (or for any item, in the comparison). */
export function placeRule(api: ScratchpadInsertApi, item: ScratchItem | null): string {
  if (api.place.kind === 'start') return 'Adds a new slide at the start of the talk.'
  const name = slideName(api, api.place)
  const atCaret = !api.chosen && api.caretInBody
  if (!atCaret) return `Adds a new slide after ${name}.`
  if (item?.kind === 'file') return `Adds to ${name} at the cursor.`
  return `Insert whole slide adds a new slide after ${name}. Insert visual only adds to ${name} at the cursor.`
}

export function placeHeadline(api: ScratchpadInsertApi): string {
  if (api.place.kind === 'start') return 'Inserts at the start of the talk'
  const no = api.numberAt(api.place.line)
  return `Inserts after ${no != null ? `slide ${no} · ` : ''}${quoted(api.place.title)}`
}

export function ScratchpadPlaceNote({ api, item, open, onOpenChange }: {
  api: ScratchpadInsertApi
  item: ScratchItem | null
  /** Change place is open (the panel holds this, so the command can open it too). */
  open: boolean
  onOpenChange: (open: boolean) => void
}): JSX.Element {
  const setOpen = onOpenChange
  const anchor = useRef<HTMLSpanElement>(null)
  useDismiss(anchor, open, () => setOpen(false))
  return (
    <div className="sp-place" data-testid="sp-place">
      <div className="sp-place-line">
        <span className="sp-place-where">{placeHeadline(api)}</span>
        <span className="sp-anchor" ref={anchor}>
          <button type="button" className="sp-link" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>Change place</button>
          {open && <PlaceChooser api={api} onClose={() => setOpen(false)} />}
        </span>
        {api.chosen && <button type="button" className="sp-link" onClick={() => api.choose(null)}>Follow the cursor</button>}
      </div>
      <div className="sp-place-rule">{placeRule(api, item)}</div>
    </div>
  )
}

/** Change place: the talk's slides, numbered, searchable by title or number; "At the start" first. */
/** Change place's list; the note around it closes it (useDismiss) and a pick closes it. */
export function PlaceChooser({ api, onClose }: { api: ScratchpadInsertApi; onClose: () => void }): JSX.Element {
  const [query, setQuery] = useState('')
  const rows = useMemo(() => api.rows(), [api])
  const needle = query.trim().toLowerCase()
  const shown = rows.filter((r) => !needle || r.title.toLowerCase().includes(needle) || (/^\d+$/.test(needle) && r.no != null && String(r.no).startsWith(needle)))
  const top = Math.min(...rows.map((r) => r.level), 6)
  const pick = (place: ScratchPlace): void => { onClose(); api.choose(place) }
  return (
    <div className="sp-menu sp-placemenu" role="dialog" aria-label="Change place">
      <div className="sp-menu-head">Insert after</div>
      <input
        className="sp-placemenu-search" autoFocus value={query} placeholder="Find a slide by title or number" aria-label="Find a slide"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) { e.preventDefault(); pick({ kind: 'after', line: shown[0].line, title: shown[0].title }) } }}
      />
      {!needle && (
        <button type="button" className={`sp-menu-row${api.chosen && api.place.kind === 'start' ? ' is-current' : ''}`} onClick={() => pick({ kind: 'start' })}>
          <span>At the start of the talk</span>
        </button>
      )}
      {shown.map((r) => (
        <button
          key={r.line} type="button" data-line={r.line}
          className={`sp-menu-row sp-placemenu-row${api.place.kind === 'after' && api.place.line === r.line ? ' is-current' : ''}`}
          style={{ paddingLeft: 8 + (r.level - top) * 12 }}
          onClick={() => pick({ kind: 'after', line: r.line, title: r.title })}
        >
          <span><i className="sp-no">{r.no != null ? String(r.no).padStart(2, '0') : ''}</i>{r.title}</span>
        </button>
      ))}
      {shown.length === 0 && <div className="sp-menu-head">No slide matches.</div>}
    </div>
  )
}

/** A visual's small picture in the chooser: a pool picture or a web picture; a tile names the rest. */
function VisualThumb({ item, visual }: { item: ScratchItem; visual: ScratchVisual }): JSX.Element {
  const [failed, setFailed] = useState(false)
  const vault = item.slide?.vaultId
  const src = /^img-[0-9a-f]{7}$/i.test(visual.ref) ? `twasset://${visual.ref}${vault ? `?vault=${encodeURIComponent(vault)}` : ''}`
    : /^https?:\/\//i.test(visual.ref) && visual.kind !== 'page' ? visual.ref : null
  if (src && !failed) return <span className="sp-vthumb"><img src={src} alt="" draggable={false} onError={() => setFailed(true)} /></span>
  return <span className="sp-vthumb sp-vthumb--tile">{visual.kind === 'page' ? 'Page' : visual.kind === 'svg' ? 'SVG' : 'Picture'}</span>
}

/** Insert whole slide (picked slides only) and Insert visual only. */
export function ScratchpadInsertButtons({ api, item }: { api: ScratchpadInsertApi; item: ScratchItem }): JSX.Element {
  const [choosing, setChoosing] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const visuals = useMemo(() => (item.kind === 'slide' ? scratchVisuals(item.slide?.markdown ?? '') : []), [item])
  useDismiss(ref, choosing, () => setChoosing(false))
  const slide = item.kind === 'slide'
  const noVisual = slide ? visuals.length === 0 : item.missing
  const visualOnly = (): void => {
    if (visuals.length > 1) { setChoosing(!choosing); return }
    void api.insert(item, 'visual', visuals[0] ?? null)
  }
  return (
    <>
      <button
        type="button" className={`sp-btn sp-btn--sm${slide ? ' sp-btn--primary' : ''}`} disabled={!slide || api.busy}
        title={slide ? undefined : 'Only a slide picked from a talk can go in whole.'}
        onClick={() => void api.insert(item, 'slide')}
      >Insert whole slide</button>
      <span className="sp-anchor" ref={ref}>
        <button
          type="button" className={`sp-btn sp-btn--sm${slide ? '' : ' sp-btn--primary'}`} disabled={noVisual || api.busy}
          aria-haspopup={visuals.length > 1 ? 'menu' : undefined} aria-expanded={visuals.length > 1 ? choosing : undefined}
          title={noVisual ? (item.missing ? 'The file is missing.' : 'This slide has no picture, SVG or page.') : undefined}
          onClick={visualOnly}
        >Insert visual only{visuals.length > 1 ? ' ▾' : ''}</button>
        {choosing && (
          <div className="sp-menu sp-vmenu" role="menu" aria-label="Choose a visual">
            <div className="sp-menu-head">{visuals.length} visuals on this slide</div>
            {visuals.map((v) => (
              <button key={v.markdown} type="button" role="menuitem" className="sp-menu-row sp-vrow" onClick={() => { setChoosing(false); void api.insert(item, 'visual', v) }}>
                <VisualThumb item={item} visual={v} />
                <span className="sp-vlabel">{v.label}<em>{v.kind === 'page' ? 'Page' : v.kind === 'svg' ? 'SVG' : 'Picture'}</em></span>
              </button>
            ))}
          </div>
        )}
      </span>
    </>
  )
}
