// The bar over a selection of two or more slides (locked mockup H01, H02): "N selected · Clear", Move to…, Cut,
// Copy, Delete. It owns no text arithmetic: every button is a call the host answers (one Undo step each), and
// Move to… hands back a SlidePlace for the host's moveBlocks. Destinations come from lib/moveDestinations.ts.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDismiss } from '../talklist/menus'
import { batchMoveOptions, type BatchMoveOption } from '../../lib/moveDestinations'
import { getStripNumbers, outlineNumbers } from '../../lib/stripNumbers'
import type { SlideRow } from '../../extensions/slideOutline'
import type { SlidePlace } from '../../../../shared/slide-handling/place'

export interface BatchBarProps {
  count: number
  /** The outline rows of the talk's current text, and the heading lines of the selected slides. */
  rows: readonly SlideRow[]
  selectedLines: readonly number[]
  /** Move to… menu open (controlled: the "Move selected slides to…" command opens it too). */
  moveOpen: boolean
  onMoveOpenChange: (open: boolean) => void
  onClear: () => void
  onMove: (place: SlidePlace) => void
  onCut: () => void
  onCopy: () => void
  onDelete: () => void
  onSetAside?: () => void
  /** The bar's height while it shows (0 when it does not): the grid pads its scroll area by it so the last row scrolls clear. */
  onHeight?: (px: number) => void
}

function MoveToMenu({ count, rows, selectedLines, onChoose, onClose }: {
  count: number; rows: readonly SlideRow[]; selectedLines: readonly number[]
  onChoose: (option: BatchMoveOption) => void; onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const numbers = useMemo(() => outlineNumbers(rows, getStripNumbers()), [rows])
  const options = useMemo(() => batchMoveOptions(rows, selectedLines, query, numbers).slice(0, 300), [rows, selectedLines, query, numbers])
  useDismiss(onClose)
  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { setActive(0) }, [query])
  const state = useRef({ active, options })
  state.current = { active, options }
  const chooseRef = useRef(onChoose)
  chooseRef.current = onChoose
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const { active: a, options: list } = state.current
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopPropagation()
        if (list.length > 0) setActive((a + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length)
      } else if (event.key === 'Enter') {
        event.preventDefault(); event.stopPropagation()
        if (list[a]) chooseRef.current(list[a])
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [])
  useEffect(() => { document.querySelector('[data-batch-menu] [data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [active])
  return (
    <div className="batch-menu" role="dialog" aria-label={`Move ${count} slides to`} data-batch-menu onClick={(e) => e.stopPropagation()}>
      <div className="batch-menu-title">Move {count} slides to</div>
      <input
        ref={inputRef} type="text" value={query} placeholder="Find a section or slide…" aria-label="Filter destinations"
        data-batch-move-input onChange={(e) => setQuery(e.target.value)}
      />
      <div className="batch-menu-list" role="listbox" aria-label="Destinations">
        {options.length === 0 && <div className="batch-menu-empty" data-batch-move-empty>Nothing matches.</div>}
        {options.map((o, at) => (
          <Fragment key={o.key}>
            {(at === 0 || options[at - 1].group !== o.group) && <div className="batch-menu-group" role="presentation">{o.group}</div>}
            <button
              type="button" role="option" aria-selected={at === active} data-active={at === active ? 'true' : 'false'} data-batch-move-option={o.key}
              className="batch-menu-row" style={o.indent > 0 ? { paddingLeft: `${10 + o.indent * 12}px` } : undefined}
              onMouseEnter={() => setActive(at)} onClick={() => onChoose(o)}
            >
              <span className="batch-menu-no">{o.no}</span>
              <span className="batch-menu-label">{o.group === 'End of section' ? `End of “${o.label}”` : o.label}</span>
              {o.detail && <span className="batch-menu-detail">{o.detail}</span>}
            </button>
          </Fragment>
        ))}
      </div>
    </div>
  )
}

export default function BatchBar({ count, rows, selectedLines, moveOpen: moving, onMoveOpenChange: setMoving, onClear, onMove, onCut, onCopy, onDelete, onSetAside, onHeight }: BatchBarProps) {
  const close = useCallback(() => setMoving(false), [setMoving])
  const barRef = useRef<HTMLDivElement>(null)
  const showing = count >= 2
  useEffect(() => {
    const el = barRef.current
    if (!showing || !el) return
    const report = (): void => onHeight?.(el.offsetHeight)
    report()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(report) : null
    ro?.observe(el)
    return () => { ro?.disconnect(); onHeight?.(0) }
  }, [showing, onHeight])
  // The Slide Scratchpad's collapsed pill and its floating panel are fixed over the bottom-right corner; where one
  // overlaps the bar, the bar ends left of it (a right margin), so Delete stays reachable.
  useEffect(() => {
    const el = barRef.current
    if (!showing || !el) return
    const fit = (): void => {
      const now = el.style.marginRight ? parseFloat(el.style.marginRight) : -4
      const rect = el.getBoundingClientRect()
      // The bar's right edge with the default -4px margin (so the measure does not depend on the margin it set).
      const own = { left: rect.left, top: rect.top, bottom: rect.bottom, right: rect.right + (now + 4) }
      let cut = 0
      document.querySelectorAll<HTMLElement>('.sp-pill, .sp-panel--float').forEach((o) => {
        const r = o.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) return
        if (r.top < own.bottom && r.bottom > own.top && r.left < own.right && r.right > own.left) cut = Math.max(cut, own.right - r.left + 8)
      })
      const want = cut > 0 ? `${-4 + cut}px` : ''
      if (el.style.marginRight !== want) el.style.marginRight = want
    }
    fit()
    const mo = new MutationObserver(fit)
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] })
    window.addEventListener('resize', fit)
    return () => { mo.disconnect(); window.removeEventListener('resize', fit); el.style.marginRight = '' }
  }, [showing])
  if (!showing) return null
  return (
    <div ref={barRef} className="batch-bar" data-batch-bar role="toolbar" aria-label="Selected slides" onClick={(e) => e.stopPropagation()}>
      <span className="batch-bar-n" data-batch-count>{count} selected</span>
      <button type="button" className="batch-bar-link" data-batch-action="clear" onClick={onClear}>Clear</button>
      <span className="batch-bar-wrap">
        <button type="button" className="batch-bar-btn" data-batch-action="move" aria-haspopup="dialog" onClick={() => setMoving(!moving)}>Move to…</button>
        {moving && (
          <MoveToMenu
            count={count} rows={rows} selectedLines={selectedLines} onClose={close}
            onChoose={(o) => { setMoving(false); onMove(o.place) }}
          />
        )}
      </span>
      {onSetAside && <button type="button" className="batch-bar-btn" data-batch-action="set-aside" onClick={onSetAside}>Set aside in Scratchpad</button>}
      <button type="button" className="batch-bar-btn" data-batch-action="cut" onClick={onCut}>Cut</button>
      <button type="button" className="batch-bar-btn" data-batch-action="copy" onClick={onCopy}>Copy</button>
      <button type="button" className="batch-bar-btn batch-bar-btn--danger" data-batch-action="delete" onClick={onDelete}>Delete</button>
    </div>
  )
}
