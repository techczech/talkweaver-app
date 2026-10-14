// The Plain view's Command-I picker (ticket 13): a small panel under the caret's line. Search
// field, then a grid of icons with each one's name under it; before a search is typed, the icons
// used recently and the whole Lucide set. ←↑↓→ move in the grid, ↵ inserts, esc closes, a click
// on an icon inserts it, a click outside closes. On a line that already has an icon the panel
// shows it, with a "Remove icon" row.
//
// It owns no outline text: usePlainIconPicker.tsx applies the choice through the verbs in
// shared/icon-verbs.ts. What it lists is plainIconPickerModel.ts's.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Search, Trash2, TriangleAlert } from 'lucide-react'
import { sanitiseRenderedSvg } from '../../../shared/objects/sanitise-svg'
import {
  COLUMNS, PAGE, REMOVE, firstStop, gridRows, iconName, iconSet, iconsBridge, knownRecent, loadAllIcons, moveStop, searchIcons, stopKey,
  type Move, type Section
} from './plainIconPickerModel'

export interface IconAnchor { left: number; top: number; bottom: number }

const DEBOUNCE_MS = 120

// One picture per key for the page's life, sanitised before it is kept.
const pictures = new Map<string, string | null>()
function Glyph({ icon }: { icon: string }) {
  const [svg, setSvg] = useState<string | null>(pictures.get(icon) ?? null)
  useEffect(() => {
    if (pictures.has(icon)) { setSvg(pictures.get(icon) ?? null); return }
    let cancelled = false
    void (iconsBridge()?.svg(icon) ?? Promise.resolve(null)).catch(() => null).then((markup) => {
      const clean = markup ? sanitiseRenderedSvg(markup) : null
      const picture = clean && 'svg' in clean ? clean.svg : null
      pictures.set(icon, picture)
      if (!cancelled) setSvg(picture)
    })
    return () => { cancelled = true }
  }, [icon])
  // The markup was sanitised by sanitiseRenderedSvg before it was kept.
  return svg ? <span className="pv-icon-glyph" dangerouslySetInnerHTML={{ __html: svg }} /> : <span className="pv-icon-glyph pv-icon-glyph--none" />
}

/** The panel's place: under the caret's line, or above it when there is no room below; inside the window. */
function usePlaced(anchor: IconAnchor, deps: unknown[]): { ref: React.RefObject<HTMLDivElement>; left: number; top: number } {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 4 })
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    const below = anchor.bottom + 4
    const top = below + box.height <= window.innerHeight - 8 || anchor.top - 4 - box.height < 8 ? below : anchor.top - 4 - box.height
    setPos({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(top, window.innerHeight - box.height - 8)) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.left, anchor.top, anchor.bottom, ...deps])
  return { ref, ...pos }
}

export default function PlainIconPicker({
  anchor, place, current, onPick, onRemove, onClose
}: {
  anchor: IconAnchor
  /** What the caret's line is: "title", "paragraph" or "list item". */
  place: string
  /** The icon the line carries, as written; null when none. */
  current: string | null
  onPick: (key: string) => void
  onRemove: () => void
  /** Escape, a click outside: the caller returns focus to the editor. */
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [all, setAll] = useState<string[]>([])
  const [recent, setRecent] = useState<string[]>([])
  const [hits, setHits] = useState<{ query: string; keys: string[] } | null>(null)
  const [shown, setShown] = useState(PAGE)
  const [active, setActive] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const chosen = useRef(false)

  const q = query.trim()
  const searching = q.length >= 2

  useEffect(() => {
    let live = true
    void loadAllIcons().then((names) => { if (live) setAll(names) })
    void knownRecent().then((keys) => { if (live) setRecent(keys) })
    // CodeMirror can take the focus back on the opening key's keyup: ask again.
    const focus = (): void => inputRef.current?.focus()
    focus()
    const again = window.setTimeout(focus, 60)
    return () => { live = false; window.clearTimeout(again) }
  }, [])

  // The compiler's search (two letters or more), a moment after the last keystroke.
  useEffect(() => {
    if (!searching) { setHits(null); return }
    let live = true
    const timer = window.setTimeout(() => {
      void searchIcons(q).then((keys) => { if (live) setHits({ query: q, keys }) })
    }, DEBOUNCE_MS)
    return () => { live = false; window.clearTimeout(timer) }
  }, [q, searching])

  const sections = useMemo<Section[]>(() => {
    if (searching) {
      // Only the hits of the current query are listed: while the new search runs, the grid is empty and Enter has nothing to choose.
      if (!hits || hits.query !== q) return []
      const n = hits.keys.length
      const label = n === 0 ? `No icons match “${hits.query}”` : n >= 40 ? `First ${n} icons that match “${hits.query}”` : `${n} ${n === 1 ? 'icon matches' : 'icons match'} “${hits.query}”`
      return [{ label, keys: hits.keys }]
    }
    return [
      ...(recent.length ? [{ label: 'Recent', keys: recent }] : []),
      { label: q.length === 1 ? 'All icons (type one more letter to search)' : 'All icons', keys: all.slice(0, shown) }
    ]
  }, [searching, hits, q, recent, all, shown, q.length])
  const withRemove = current !== null && !searching
  const rows = useMemo(() => gridRows(sections, withRemove), [sections, withRemove])
  const stops = useMemo(() => new Set(rows.flat()), [rows])

  // The highlight: kept while its icon is still listed, otherwise the first icon.
  const highlighted = active !== null && stops.has(active) ? active : firstStop(rows)
  const { ref, left, top } = usePlaced(anchor, [rows.length, withRemove])

  // More of the full set as the highlight or the scroll nears the end of what is drawn.
  const more = (): void => setShown((n) => (n < all.length ? n + PAGE : n))
  useEffect(() => {
    if (searching || !highlighted) return
    const flat = rows.flat()
    if (flat.indexOf(highlighted) >= flat.length - 2 * COLUMNS) more()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlighted, searching, rows])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])

  // A click outside closes. Armed on the next task, so the click that opened the panel is not it.
  useEffect(() => {
    let armed = false
    const timer = window.setTimeout(() => { armed = true }, 0)
    const down = (event: MouseEvent): void => {
      if (armed && ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    window.addEventListener('mousedown', down, { capture: true })
    return () => { window.clearTimeout(timer); window.removeEventListener('mousedown', down, { capture: true }) }
  }, [onClose, ref])

  const choose = (stop: string | null): void => {
    if (!stop || chosen.current) return
    chosen.current = true
    if (stop === REMOVE) onRemove(); else onPick(stopKey(stop))
  }

  const MOVES: Record<string, Move> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); choose(highlighted); return }
    if (event.key === 'Tab') { event.preventDefault(); return }
    const move = MOVES[event.key]
    if (!move || event.metaKey || event.ctrlKey || event.altKey) return
    event.preventDefault()
    event.stopPropagation()
    setActive(moveStop(rows, highlighted, move))
  }

  const highlightedKey = highlighted && highlighted !== REMOVE ? stopKey(highlighted) : null
  let row = 0
  return (
    <div ref={ref} className="pv-icon-picker" style={{ left, top }} role="dialog" aria-label="Insert icon" data-plain-icon-picker onKeyDown={onKeyDown}>
      <label className="pv-icon-search">
        <Search size={14} aria-hidden="true" />
        <input
          ref={inputRef} type="text" value={query} placeholder="Search icons" aria-label="Search icons" spellCheck={false} autoComplete="off"
          onChange={(event) => { setQuery(event.target.value); setActive(null); if (listRef.current) listRef.current.scrollTop = 0 }}
          data-plain-icon-search
        />
        <kbd>⌘I</kbd>
      </label>
      <div
        ref={listRef} className="pv-icon-list"
        onScroll={(event) => { const el = event.currentTarget; if (!searching && el.scrollTop + el.clientHeight >= el.scrollHeight - 80) more() }}
      >
        {withRemove && current !== null && (
          <>
            <div className="pv-icon-label">On this {place}</div>
            <div className="pv-icon-current">
              <span className="pv-icon-current-box"><Glyph icon={current} /></span>
              <span className="pv-icon-current-name">{iconName(current)}<small>{[iconSet(current), 'selected'].filter(Boolean).join(' · ')}</small></span>
            </div>
            <button
              type="button" className="pv-icon-remove" data-plain-icon-remove data-active={highlighted === REMOVE ? 'true' : 'false'}
              onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActive(REMOVE)} onClick={() => choose(REMOVE)}
            >
              <Trash2 size={14} aria-hidden="true" />Remove icon
            </button>
          </>
        )}
        {searching && (!hits || hits.query !== q) && <div className="pv-icon-label">Searching…</div>}
        {sections.map((section) => (
          <div key={section.label}>
            <div className="pv-icon-label">{section.label}</div>
            <div className="pv-icon-grid" role="listbox" aria-label={section.label}>
              {section.keys.map((key, index) => {
                if (index % COLUMNS === 0) row += 1
                const stop = `${section.label}\n${key}`
                const on = stop === highlighted
                return (
                  <button
                    key={key} type="button" role="option" aria-selected={on} title={iconName(key)}
                    className={`pv-icon-cell${key === current ? ' pv-icon-cell--current' : ''}`}
                    data-active={on ? 'true' : 'false'} data-icon-key={key} data-row={row}
                    onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActive(stop)} onClick={() => choose(stop)}
                  >
                    <Glyph icon={key} />
                    <span className="pv-icon-name">{iconName(key)}</span>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="pv-icon-foot">
        <div className="pv-icon-foot-name" data-plain-icon-footer>
          {highlighted === REMOVE ? 'Remove icon' : highlightedKey ? <>{iconName(highlightedKey)} <span>{highlightedKey === current ? 'current' : iconSet(highlightedKey)}</span></> : ''}
        </div>
        <div className="pv-icon-hint">
          <span><kbd>↵</kbd>{highlighted === REMOVE ? 'Remove' : 'Insert'}</span>
          <span><kbd>esc</kbd>Close</span>
        </div>
      </div>
    </div>
  )
}

/** The short message under the caret's line when the line takes no icon. It closes itself. */
export function PlainIconNote({ anchor, message, detail }: { anchor: IconAnchor; message: string; detail: string }) {
  const { ref, left, top } = usePlaced({ ...anchor, bottom: anchor.bottom + 2 }, [message, detail])
  return (
    <div ref={ref} className="pv-icon-note" style={{ left, top }} role="status" data-plain-icon-note>
      <TriangleAlert size={15} aria-hidden="true" />
      <div>{message}<small>{detail}</small></div>
    </div>
  )
}
