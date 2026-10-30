// Draws only the lines (headings, card rows, the open expansion) in or near the viewport of the
// results' scroll box: about one screen above and below. Line heights are measured once mounted
// (one ResizeObserver, read in its callback, so no forced layout) and estimated from the content
// width until then; the pure layout lives in gridWindowing.ts.
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  type GridLine, type MeasureCache, type ScrollAnchor, anchorFor, anchorShift, createMeasureCache, layoutLines, lineHeight,
  lineOfPositions, recordMeasure, scrollTargetFor, visibleRange
} from './gridWindowing'

/** How long a new result set's first cards keep their staggered entry animation (ms). */
const ENTRY_MS = 1200
/** The viewport assumed before the box is measured (and in DOM tests, which have no layout). */
const FALLBACK_VIEWPORT = 800

export function VirtualGrid({ lines, scrollRef, renderLine, focusPos, focusDeps, entryKey }: {
  lines: GridLine[]
  /** The scroll box the lines live in (.lt-table-scroll). */
  scrollRef: RefObject<HTMLDivElement>
  /** Draw one line; `stagger(p)` is the entry-animation step of the card at position p, or null. */
  renderLine: (line: GridLine, stagger: (p: number) => number | null) => ReactNode
  /** The focused card: scrolled into view when it or `focusDeps` changes. */
  focusPos: number
  focusDeps: unknown
  /** A new value = a new result set: the cards then on screen play the entry animation. */
  entryKey: unknown
}) {
  const listRef = useRef<HTMLDivElement>(null)
  // Measurements per content width: the results narrow while a talk is beside them, and their
  // own measurements are still right when it closes.
  const cachesRef = useRef(new Map<number, MeasureCache>())
  const cacheFor = (w: number): MeasureCache => {
    let c = cachesRef.current.get(w)
    if (!c) {
      if (cachesRef.current.size >= 4) cachesRef.current.clear()
      c = createMeasureCache(w)
      cachesRef.current.set(w, c)
    }
    return c
  }
  const [box, setBox] = useState({ width: 0, height: 0, listTop: 0 })
  const [scrollTop, setScrollTop] = useState(0)
  const [, setMeasureTick] = useState(0)
  const boxRef = useRef(box)
  boxRef.current = box

  const lineByKey = useMemo(() => new Map(lines.map((l) => [l.key, l])), [lines])
  const lineByKeyRef = useRef(lineByKey)
  lineByKeyRef.current = lineByKey
  const posLine = useMemo(() => lineOfPositions(lines), [lines])

  const width = box.width
  // Recomputed every render: cheap (one pass over the lines), and it picks up new measurements.
  const cache = cacheFor(width)
  const layout = layoutLines(lines, (l) => lineHeight(l, cache, width))
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const linesRef = useRef(lines)
  linesRef.current = lines

  // The scroll box's size and where the list starts in it: read once, then from ResizeObserver
  // callbacks (layout is already done there, so the reads cost nothing extra).
  useLayoutEffect(() => {
    const el = scrollRef.current
    const list = listRef.current
    if (!el || !list) return
    const read = (): void => {
      const next = { width: list.clientWidth, height: el.clientHeight, listTop: list.offsetTop }
      const cur = boxRef.current
      if (next.width !== cur.width || next.height !== cur.height || next.listTop !== cur.listTop) setBox(next)
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    ro.observe(list)
    return () => ro.disconnect()
  }, [scrollRef])

  // Scroll position, at most once a frame.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let frame = 0
    const onScroll = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => { frame = 0; setScrollTop(el.scrollTop) })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => { el.removeEventListener('scroll', onScroll); if (frame) cancelAnimationFrame(frame) }
  }, [scrollRef])

  // Mounted lines report their real height; one observer for all of them.
  const roRef = useRef<ResizeObserver | null>(null)
  const observedRef = useRef(new Set<Element>())
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    let frame = 0
    const ro = new ResizeObserver((entries) => {
      let changed = false
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.vkey
        const line = key ? lineByKeyRef.current.get(key) : undefined
        if (!line) continue
        const size = entry.borderBoxSize?.[0]?.blockSize ?? (entry.target as HTMLElement).offsetHeight
        const w = boxRef.current.width
        if (recordMeasure(cacheFor(w), line, w, size)) changed = true
      }
      if (changed && !frame) frame = requestAnimationFrame(() => { frame = 0; setMeasureTick((n) => n + 1) })
    })
    roRef.current = ro
    const observed = observedRef.current
    return () => { ro.disconnect(); observed.clear(); roRef.current = null; if (frame) cancelAnimationFrame(frame) }
  }, [])
  useLayoutEffect(() => {
    const ro = roRef.current
    const list = listRef.current
    if (!ro || !list) return
    const observed = observedRef.current
    for (const el of observed) if (!el.isConnected) { ro.unobserve(el); observed.delete(el) }
    for (const el of list.children) if (!observed.has(el)) { ro.observe(el); observed.add(el) }
  })

  // Scroll anchoring: a measurement (or a new width) changes the heights above what is on screen,
  // and with them every offset below. The anchor line (the focused card's when it is in view, else
  // the first line in view) is held where it was: the scroll moves by however far it moved. Only
  // for the same lines: a new result set or a view change places itself (focus effect, Esc restore).
  const anchorRef = useRef<{ lines: GridLine[]; anchor: ScrollAnchor | null } | null>(null)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const held = anchorRef.current
    if (held && held.lines === lines) {
      const shift = anchorShift(lines, layout, held.anchor)
      if (Math.abs(shift) >= 0.5) {
        el.scrollTop = Math.max(0, el.scrollTop + shift)
        setScrollTop(el.scrollTop)
      }
    }
    const b = boxRef.current
    anchorRef.current = {
      lines,
      anchor: anchorFor(lines, layout, el.scrollTop - b.listTop, b.height || FALLBACK_VIEWPORT, posLine.get(focusPos))
    }
  })

  // The focused card in view (the virtual list scrolls; the card is then drawn).
  useEffect(() => {
    const el = scrollRef.current
    const i = posLine.get(focusPos)
    if (!el || i === undefined) return
    const b = boxRef.current
    // The box's own position: it may have been set this commit (Esc restoring the results).
    const target = scrollTargetFor(linesRef.current, layoutRef.current, i, el.scrollTop, b.height || FALLBACK_VIEWPORT, b.listTop)
    if (target === null) return
    el.scrollTop = target
    setScrollTop(target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPos, focusDeps])

  // What is drawn: the viewport plus one screen above and below.
  const viewport = box.height || FALLBACK_VIEWPORT
  const top = scrollTop - box.listTop
  const range = visibleRange(layout, top - viewport, top + 2 * viewport)

  // The entry animation plays for the cards on screen when a result set arrives, never for a card
  // scrolled into view later.
  const entryRef = useRef<{ key: unknown; first: number; last: number; live: boolean } | null>(null)
  const [, setEntryTick] = useState(0)
  if (!entryRef.current || entryRef.current.key !== entryKey) {
    // Where the view will be once the focused card is scrolled into view (a new result set focuses
    // its first card), so the animated cards are the ones then on screen.
    const fi = posLine.get(focusPos)
    const target = fi === undefined ? null : scrollTargetFor(lines, layout, fi, scrollTop, viewport, box.listTop)
    const entryTop = (target ?? scrollTop) - box.listTop
    const shown = visibleRange(layout, entryTop, entryTop + viewport)
    let first = Infinity
    let last = -1
    for (let i = shown.start; i < shown.end; i++) {
      const l = lines[i]
      if (l?.kind === 'row') { first = Math.min(first, l.base); last = Math.max(last, l.base + l.cards.length - 1) }
    }
    entryRef.current = { key: entryKey, first, last, live: true }
  }
  useEffect(() => {
    const t = setTimeout(() => {
      if (entryRef.current) entryRef.current.live = false
      setEntryTick((n) => n + 1)
    }, ENTRY_MS)
    return () => clearTimeout(t)
  }, [entryKey])
  const entry = entryRef.current
  const stagger = (p: number): number | null =>
    entry.live && p >= entry.first && p <= entry.last ? p - entry.first : null

  // The focused card's line is always drawn, even out of range: it never unmounts under the keyboard.
  const focusLine = posLine.get(focusPos)
  const drawnIdx: number[] = []
  if (focusLine !== undefined && focusLine < range.start) drawnIdx.push(focusLine)
  for (let i = range.start; i < range.end; i++) drawnIdx.push(i)
  if (focusLine !== undefined && focusLine >= range.end) drawnIdx.push(focusLine)
  const drawn: ReactNode[] = []
  for (const i of drawnIdx) {
    const line = lines[i]
    drawn.push(
      <div
        key={line.key}
        data-vkey={line.key}
        className="lt-vline"
        style={{ top: layout.offsets[i], paddingBottom: line.after }}
      >
        {renderLine(line, stagger)}
      </div>
    )
  }
  return (
    <div ref={listRef} className="lt-vlist" style={{ height: layout.total }} data-lines={lines.length}>
      {drawn}
    </div>
  )
}
