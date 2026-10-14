import { plainInlineText } from '../../../../compiler/scripts/lib/00-inline-render.mjs'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TalkInfo, ProjectionRow } from '../../../preload/index'
import type { LayoutDoctorFinding } from '../../../shared/layout-doctor'
import { surfacedWarnings } from './SlideStrip'
import { startDragAutoScroll } from '../lib/dragAutoScroll'
import { ancestorKeysOfIndex, matchGroupsToSections } from '../lib/outlineCollapse'
import {
  collapseAllSections, expandAllSections, gridOnlyCollapsed, revealKeys, setGridOnlyCollapsed, setSectionCollapsed, toggleSection,
  toggleSectionTree, useOutlineCollapse
} from '../lib/outlineCollapseStore'
import { IcCollapse, IcExpand } from './talklist/icons'
import { notify } from '../lib/notify'
import type { SlideRow } from '../extensions/slideOutline'
import type { SlideBlockOps } from './Editor'
import SlideRowMenus, { type SlideMenuRequest } from './SlideRowMenus'
import { releaseSelectionOutside } from '../lib/outlineSelection'

interface Props {
  talk: TalkInfo
  compiledSlides: ProjectionRow[] | null
  triggerFindings: readonly LayoutDoctorFinding[]
  thumbnails?: Record<string, string> | null
  activeIndex: number
  onSelectSlide: (index: number) => void
  // Enter / double-click: open this slide's source in the editor, focused and ready to type
  // (leaves grid mode). Single click stays select-only so browsing never steals focus.
  onEdit?: (index: number) => void
  // `placement` names the side of the target block to land on; without it the drag direction decides.
  onReorder?: (fromIndex: number, toIndex: number, placement?: 'before' | 'after') => void
  onExplain?: (index: number) => void
  columns: number
  // Whole-slide operations by source line (Editor.tsx SlideBlockOps). With them a right-click on a
  // card or a section header opens the slide or section menu, and ⌘X / ⌘C / ⌘V act on the selected card.
  slideOps?: SlideBlockOps | null
  /** The source line of the heading behind the card at a display index, or null (cover, closing). */
  lineOfSlide?: (index: number) => number | null
  /** After a paste or a "Move … to…" made here: the heading's new source line, to select and reveal. */
  onLanded?: (line: number) => void
  /** The menu's More actions… row: Actions here for the card at this index. */
  onMoreActions?: (index: number, at: { x: number; y: number }) => void
}

// thumbnails are keyed by render_hash (layout + block model), mirroring SlideStrip — so a
// layout/trigger change busts the cache; content_hash / slide_id are fallbacks.
function thumbKey(row: ProjectionRow): string | null {
  return row.render_hash || row.content_hash || row.slide_id || null
}

// A projection row is a reorderable outline block iff its source_markdown begins
// with a `### ` heading. Synthesized rows (cover title, section dividers, closing)
// carry empty/non-heading source_markdown and must not be dragged. Mirrors SlideStrip.
function isOutlineBlock(p: ProjectionRow): boolean {
  return /^###\s/.test((p.source_markdown ?? '').trimStart())
}

// Flat list of every row with its global display index and outline-block index
// (null for synthesized rows). Same block counter as groupBySection, used by the
// ⌘↑/⌘↓ keyboard-move so the move maps to the lib's block-index reorder.
function flatBlocks(
  rows: ProjectionRow[]
): Array<{ globalIndex: number; blockIndex: number | null }> {
  let block = 0
  return rows.map((row, globalIndex) => {
    const isBlock = isOutlineBlock(row)
    const blockIndex = isBlock ? block : null
    if (isBlock) block += 1
    return { globalIndex, blockIndex }
  })
}

interface SectionGroup {
  // Stable key for the collapsed-set: prefer the section string; fall back to a
  // synthetic key derived from the first slide's global index so consecutive runs
  // with an empty section string stay distinct.
  key: string
  /** The compiled `section` string the run was grouped by ('' before the first section). */
  section: string
  title: string
  // Global slide indices (into compiledSlides) belonging to this section run.
  rows: Array<{ row: ProjectionRow; globalIndex: number; blockIndex: number | null }>
}

// Group consecutive rows sharing the same `section` string into runs. Section title:
// prefer the row whose role === 'section-title' in that run (its nav_title/title),
// else the section string, else "(no section)".
function groupBySection(rows: ProjectionRow[]): SectionGroup[] {
  const groups: SectionGroup[] = []
  let block = 0
  let current: SectionGroup | null = null
  let currentSection: string | null = null

  rows.forEach((row, globalIndex) => {
    const isBlock = isOutlineBlock(row)
    const blockIndex = isBlock ? block : null
    if (isBlock) block += 1

    const section = row.section ?? ''
    if (current === null || section !== currentSection) {
      current = {
        key: section ? `sec:${section}` : `idx:${globalIndex}`,
        section,
        title: section || '(no section)',
        rows: []
      }
      currentSection = section
      groups.push(current)
    }
    current.rows.push({ row, globalIndex, blockIndex })
  })

  // Resolve each section's display title: a section-title row's nav_title/title wins.
  for (const g of groups) {
    const titleRow = g.rows.find((r) => r.row.role === 'section-title')
    if (titleRow) {
      const t = plainInlineText(titleRow.row.nav_title || titleRow.row.title)
      if (t) g.title = t
    }
  }
  return groups
}

/** How long a drag must rest on a collapsed section header before the section opens (ms). */
export const GRID_DRAG_EXPAND_DELAY_MS = 700

// Drop targets other than a cell, held in the same state as the cell's global index:
// 'end' = the zone after the last cell, 'section:<key>' = a section header.
type GridDropTarget = number | string | null
const SECTION_DROP = 'section:'
const END_DROP = 'end'

// The last reorderable (`###`) block of a section run, or null when it has none — a drop on the
// section's header lands after this block.
function lastBlockOf(group: SectionGroup): { globalIndex: number; blockIndex: number } | null {
  for (let i = group.rows.length - 1; i >= 0; i -= 1) {
    const r = group.rows[i]
    if (r.blockIndex !== null) return { globalIndex: r.globalIndex, blockIndex: r.blockIndex }
  }
  return null
}

interface CellThumbProps {
  row: ProjectionRow
  thumbnailUrl: string | null
  triggerFindings: readonly LayoutDoctorFinding[]
}

// Real thumbnail when available; otherwise a neutral schematic box carrying the
// slide title so the grid stays legible before thumbnails render.
// Memoized: during a drag the whole grid re-renders on each cell-crossing (dropTarget state), but a
// cell's thumbnail props (row + url) don't change — so the heavy <img> tree is skipped, keeping drag smooth.
const CellThumb = React.memo(function CellThumb({ row, thumbnailUrl, triggerFindings }: CellThumbProps) {
  const title = plainInlineText(row.nav_title || row.title) || 'Slide'
  const warnings = surfacedWarnings(row, 'strip-badge', triggerFindings)
  return (
    <div style={{ position: 'relative', paddingTop: '56.25%', background: 'var(--paper)' }}>
      {warnings.length > 0 && (
        <span
          className={`tw-slide-warning ${warnings.some((warning) => warning.severity === 'error') ? 'tw-slide-warning--error' : ''}`}
          data-slide-warning
          title={warnings.map((warning) => warning.text).join('\n')}
          style={{
            position: 'absolute',
            top: '4px',
            right: '4px',
            zIndex: 3,
            fontSize: '9px',
            fontWeight: 700,
            lineHeight: 1,
            color: '#fff',
            borderRadius: '3px',
            padding: '2px 5px',
            boxShadow: '0 0 0 1px var(--paper)',
            cursor: 'help'
          }}
        >
          ⚠ {warnings.length}
        </span>
      )}
      {thumbnailUrl ? (
        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
          <img
            src={thumbnailUrl}
            alt={title}
            // Lazy + async decode: off-screen cells in a big deck don't pay decode/compose cost
            // until scrolled near. DnD-safe (unlike content-visibility, which broke native drag).
            loading="lazy"
            decoding="async"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        </div>
      ) : (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '10px',
            background: 'var(--hover, rgba(0,0,0,0.03))'
          }}
        >
          <p
            style={{
              fontSize: '11px',
              fontWeight: 600,
              textAlign: 'center',
              color: 'var(--ink)',
              margin: 0,
              lineHeight: 1.3,
              maxHeight: '100%',
              overflow: 'hidden'
            }}
          >
            {title}
          </p>
        </div>
      )}
    </div>
  )
})

interface GridCellProps {
  row: ProjectionRow
  triggerFindings: readonly LayoutDoctorFinding[]
  thumbnails: Record<string, string> | null
  globalIndex: number
  blockIndex: number | null
  isActive: boolean
  isDropTarget: boolean
  isDragging: boolean
  cellDraggable: boolean
  onSelect: (globalIndex: number) => void
  onEdit?: (globalIndex: number) => void
  onMenu?: (e: React.MouseEvent, globalIndex: number, blockIndex: number | null) => void
  onDragStart: (e: React.DragEvent, globalIndex: number, blockIndex: number | null) => void
  onDragEnter: (globalIndex: number) => void
  onDragOver: (e: React.DragEvent, globalIndex: number) => void
  onDrop: (e: React.DragEvent, globalIndex: number, blockIndex: number | null) => void
  onDragEnd: () => void
}

// IDENTITY CONTRACT — React.memo compares every prop by identity, handlers included: pass only
// data that keeps its identity unless it changed, and handlers from GridView's useCallback/latest-refs,
// never inline arrows or parent callbacks directly. Guarded by `npm run test:strip-render-budget`.
const GridCell = React.memo(function GridCell({
  row,
  triggerFindings,
  thumbnails,
  globalIndex,
  blockIndex,
  isActive,
  isDropTarget,
  isDragging,
  cellDraggable,
  onSelect,
  onEdit,
  onMenu,
  onDragStart,
  onDragEnter,
  onDragOver,
  onDrop,
  onDragEnd
}: GridCellProps) {
  const key = thumbKey(row)
  const thumbnailUrl = key && thumbnails ? thumbnails[key] ?? null : null
  const title = plainInlineText(row.nav_title || row.title) || '(untitled)'

  // Carousel sub-slides (ADR-0022): one full-bleed thumbnail per stepped sub-slide
  // of a #### / {carousel} slide, keyed `${key}__N`. Static multi-part layouts emit
  // no `__N` keys, so they render as a single cell with no sub-cells.
  const subUrls: string[] = []
  if (key && thumbnails) {
    let si = 0
    while (thumbnails[`${key}__${si}`]) {
      subUrls.push(thumbnails[`${key}__${si}`])
      si += 1
    }
  }

  return (
    <React.Fragment>
      <div
        className="grid-cell"
        data-slide-index={globalIndex}
        data-block-index={blockIndex ?? ''}
        data-active={isActive ? 'true' : 'false'}
        data-drop-target={isDropTarget ? 'true' : undefined}
        draggable={cellDraggable}
        onClick={() => onSelect(globalIndex)}
        onDoubleClick={onEdit ? () => onEdit(globalIndex) : undefined}
        onContextMenu={onMenu ? (e) => onMenu(e, globalIndex, blockIndex) : undefined}
        onDragStart={
          cellDraggable
            ? (e) => onDragStart(e, globalIndex, blockIndex)
            : undefined
        }
        onDragEnter={
          cellDraggable
            ? () => onDragEnter(globalIndex)
            : undefined
        }
        onDragOver={
          cellDraggable
            ? (e) => onDragOver(e, globalIndex)
            : undefined
        }
        onDrop={
          cellDraggable
            ? (e) => onDrop(e, globalIndex, blockIndex)
            : undefined
        }
        onDragEnd={cellDraggable ? onDragEnd : undefined}
        style={{
          position: 'relative',
          border: `1px solid ${isActive ? 'var(--oxford)' : 'var(--line)'}`,
          borderRadius: '6px',
          background: 'var(--paper)',
          overflow: 'hidden',
          cursor: cellDraggable ? 'grab' : 'pointer',
          boxShadow: isActive
            ? '0 0 0 2px rgba(11,58,107,0.22), 0 2px 6px rgba(0,0,0,0.08)'
            : 'none',
          opacity: isDragging ? 0.4 : 1,
          userSelect: 'none',
          transition: 'box-shadow 0.08s ease, border-color 0.08s ease'
        }}
      >
        {isDropTarget && (
          <div
            aria-hidden
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: 4,
              background: 'var(--oxford)',
              borderRadius: '0 3px 3px 0',
              zIndex: 4
            }}
          />
        )}
        <CellThumb row={row} thumbnailUrl={thumbnailUrl} triggerFindings={triggerFindings} />
        <div
          style={{
            padding: '5px 8px',
            borderTop: '1px solid var(--line)',
            display: 'flex',
            gap: '8px',
            alignItems: 'center'
          }}
        >
          <span
            style={{
              fontSize: '10px',
              color: 'var(--faint)',
              fontFamily: 'var(--font-mono)',
              flexShrink: 0
            }}
          >
            {String(globalIndex + 1).padStart(2, '0')}
          </span>
          <span
            style={{
              fontSize: '11px',
              color: 'var(--ink)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {title}
          </span>
        </div>
      </div>
      {/* Carousel sub-slides: each stepped full-bleed sub-slide as its own cell. */}
      {subUrls.map((u, i) => (
        <div
          key={`sub-${globalIndex}-${i}`}
          className="grid-subcell"
          data-subslide
          title={`${title} — step ${i + 1}`}
          onClick={() => onSelect(globalIndex)}
          style={{
            position: 'relative',
            border: '1px dashed var(--line)',
            borderRadius: '6px',
            background: 'var(--panel)',
            overflow: 'hidden',
            cursor: 'pointer',
            userSelect: 'none'
          }}
        >
          <div style={{ position: 'relative', paddingTop: '56.25%', background: 'var(--paper)' }}>
            <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
              <img
                src={u}
                alt=""
                loading="lazy"
                decoding="async"
                style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
              />
            </div>
          </div>
          <div
            style={{
              padding: '4px 8px',
              borderTop: '1px dashed var(--line)',
              display: 'flex',
              gap: '6px',
              alignItems: 'center'
            }}
          >
            <span style={{ fontSize: '10px', color: 'var(--oxford)', fontFamily: 'var(--font-mono)' }}>
              ↳ {globalIndex + 1}.{i + 1}
            </span>
            <span style={{ fontSize: '10px', color: 'var(--muted)' }}>step</span>
          </div>
        </div>
      ))}
    </React.Fragment>
  )
})

export default function GridView({
  talk,
  compiledSlides,
  triggerFindings,
  thumbnails,
  activeIndex,
  onSelectSlide,
  onEdit,
  onReorder,
  onExplain,
  columns,
  slideOps,
  lineOfSlide,
  onLanded,
  onMoreActions
}: Props): React.JSX.Element {
  // Collapsed sections are shared with the Slides outline and remembered per talk (outlineCollapseStore.ts):
  // a group is the outline section with its id, else with its title (outlineCollapse.ts,
  // matchGroupsToSections). Groups that match no outline section (slides before the first section, the
  // closing slide) have no identity in the outline, so they collapse here only, while this view is open.
  const tk = talk?.outlinePath ?? ''
  const snap = useOutlineCollapse(tk)
  const [localCollapsed, setLocalState] = useState<Set<string>>(() => gridOnlyCollapsed(tk))
  // Kept per talk outside the component (outlineCollapseStore.ts), so leaving the grid and coming back shows the same groups collapsed.
  const setLocalCollapsed = (next: Set<string> | ((prev: Set<string>) => Set<string>)): void => {
    setLocalState((prev) => {
      const value = typeof next === 'function' ? next(prev) : next
      setGridOnlyCollapsed(tk, value)
      return value
    })
  }
  const groups = useMemo(() => (compiledSlides ? groupBySection(compiledSlides) : []), [compiledSlides])
  const outlineKeys = useMemo(() => matchGroupsToSections(snap.rows, groups.map((g) => ({ section: g.section, title: g.title }))), [snap.rows, groups])
  const isCollapsedAt = (gi: number): boolean => {
    const key = outlineKeys[gi]
    return key ? snap.collapsed.has(key) : localCollapsed.has(groups[gi]?.key ?? '')
  }
  function setCollapsedAt(gi: number, value: boolean): void {
    const key = outlineKeys[gi]
    if (key) { setSectionCollapsed(tk, key, value); return }
    const gk = groups[gi]?.key
    if (gk) setLocalCollapsed((prev) => { const n = new Set(prev); if (value) n.add(gk); else n.delete(gk); return n })
  }
  function toggleAt(gi: number, wholeTree = false): void {
    const key = outlineKeys[gi]
    if (key) { if (wholeTree) toggleSectionTree(tk, key); else toggleSection(tk, key) } else setCollapsedAt(gi, !isCollapsedAt(gi))
  }
  // Collapse all / Expand all (the buttons below and the palette commands both go through the store).
  const seenBulkRef = useRef(snap.bulkSeq)
  useEffect(() => {
    if (seenBulkRef.current === snap.bulkSeq) return
    seenBulkRef.current = snap.bulkSeq
    setLocalCollapsed(snap.bulkCollapsed ? new Set(groups.filter((_, i) => !outlineKeys[i]).map((g) => g.key)) : new Set())
  }, [snap.bulkSeq]) // eslint-disable-line react-hooks/exhaustive-deps
  // Sections a resting drag opened, closed again when the drag ends without a drop inside them.
  const sprungRef = useRef(new Set<string>())
  const closeSprungRef = useRef<(keepGroupKey: string | null) => void>(() => {})
  closeSprungRef.current = (keep) => {
    for (const gk of sprungRef.current) {
      const gi = groups.findIndex((g) => g.key === gk)
      if (gi >= 0 && gk !== keep) setCollapsedAt(gi, true)
    }
    sprungRef.current.clear()
  }
  const groupKeyOfCell = (globalIndex: number): string | null => groups.find((g) => g.rows.some((r) => r.globalIndex === globalIndex))?.key ?? null
  const groupKeyOfCellRef = useRef(groupKeyOfCell)
  groupKeyOfCellRef.current = groupKeyOfCell
  // A jump that lands on a slide in a collapsed group (the strip, a search, a drop on a header)
  // opens the group; moving the selection with the arrow keys only ever visits visible cells.
  const [revealTick, setRevealTick] = useState(0)
  const seenActiveRef = useRef(activeIndex)
  useEffect(() => {
    if (seenActiveRef.current === activeIndex) return
    seenActiveRef.current = activeIndex
    const gi = groups.findIndex((g) => g.rows.some((r) => r.globalIndex === activeIndex))
    if (gi < 0 || !isCollapsedAt(gi)) return
    const key = outlineKeys[gi]
    if (key) revealKeys(tk, [key, ...ancestorKeysOfIndex(snap.rows, snap.rows.findIndex((r) => r.key === key))])
    else setCollapsedAt(gi, false)
    setRevealTick((n) => n + 1)
  }, [activeIndex]) // eslint-disable-line react-hooks/exhaustive-deps
  const containerRef = useRef<HTMLDivElement>(null)
  // dragFrom is the GLOBAL slide index of the source cell; held in a ref too so the
  // synchronous drop handler reads the live value, not a stale render closure.
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<GridDropTarget>(null)
  const stopAutoScrollRef = useRef<(() => void) | null>(null)
  const dragFromRef = useRef<number | null>(null)
  const dragFromBlockRef = useRef<number | null>(null)

  const canReorder = !!onReorder

  const resetDrag = useCallback((keepGroupKey: string | null = null): void => {
    closeSprungRef.current(keepGroupKey)
    dragFromRef.current = null
    dragFromBlockRef.current = null
    setDragFrom(null)
    setDropTarget(null)
    stopAutoScrollRef.current?.()
    stopAutoScrollRef.current = null
  }, [])
  // Leaving grid mode mid-drag must not leave the scroll loop running.
  useEffect(() => () => { stopAutoScrollRef.current?.() }, [])

  // What a drop at this element would hit: a reorderable cell, a section header that has a slide
  // to land after, or the end zone (open space under the last section counts as the end zone).
  // Used by the auto-scroll loop, which re-reads the target when the grid moves under a still pointer.
  const dropTargetAt = useCallback((el: Element | null, clientX: number, clientY: number): GridDropTarget => {
    const container = containerRef.current
    if (!container || !el || !container.contains(el)) return null
    const cell = el.closest('[data-slide-index]')
    if (cell) return cell.getAttribute('data-block-index') ? Number(cell.getAttribute('data-slide-index')) : null
    const header = el.closest('[data-section-header]')
    if (header) {
      const key = header.getAttribute('data-section-drop')
      return key ? SECTION_DROP + key : null
    }
    if (el.closest('[data-grid-drop-end]')) return END_DROP
    const end = container.querySelector('[data-grid-drop-end]')
    if (!end) return null
    if (el === container) return clientY >= end.getBoundingClientRect().top ? END_DROP : null
    // The empty cell slots beside the very last cell are "after the last cell" too.
    if (el.hasAttribute('data-last-section-cells') && el.lastElementChild) {
      const last = el.lastElementChild.getBoundingClientRect()
      if (clientY > last.bottom || (clientY >= last.top && clientX > last.right)) return END_DROP
    }
    return null
  }, [])

  // A drag resting on a collapsed section's header opens the section after a moment.
  const restingOnCollapsed =
    typeof dropTarget === 'string' && dropTarget.startsWith(SECTION_DROP)
      && isCollapsedAt(groups.findIndex((g) => g.key === dropTarget.slice(SECTION_DROP.length)))
      ? dropTarget.slice(SECTION_DROP.length)
      : null
  useEffect(() => {
    if (restingOnCollapsed == null) return
    const timer = setTimeout(() => {
      const gi = groups.findIndex((g) => g.key === restingOnCollapsed)
      if (gi < 0) return
      sprungRef.current.add(restingOnCollapsed)
      setCollapsedAt(gi, false)
    }, GRID_DRAG_EXPAND_DELAY_MS)
    return () => clearTimeout(timer)
  }, [restingOnCollapsed])

  // If the slide set changes underneath an in-flight drag (e.g. a reorder
  // recompiles the grid), clear drag state so a stale index can't paint the wrong cell.
  const slideCount = compiledSlides?.length ?? 0
  useEffect(() => {
    resetDrag()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideCount])

  // ⌘↑ / ⌘↓ — move the active slide up/down among reorderable blocks. GridView only mounts
  // in grid mode, so this window listener is scoped to the grid; it also bows out while the
  // editor or any text input is focused so it never hijacks caret navigation.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.closest('.cm-editor') || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
        return
      }
      if (!onReorder || !compiledSlides) return
      const flat = flatBlocks(compiledSlides)
      const active = flat.find((r) => r.globalIndex === activeIndex)
      if (!active || active.blockIndex === null) return
      const fromBlock = active.blockIndex
      const toBlock = e.key === 'ArrowUp' ? fromBlock - 1 : fromBlock + 1
      const target = flat.find((r) => r.blockIndex === toBlock)
      if (!target) return
      e.preventDefault()
      e.stopPropagation()
      onReorder(fromBlock, toBlock)
      onSelectSlide(target.globalIndex) // follow the moved slide to its new slot
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [activeIndex, compiledSlides, onReorder, onSelectSlide])

  // The grid owns keyboard focus while it is on screen: it only mounts in grid mode, so
  // focusing on mount means ⌘4 (or the Grid button) lands you ready to arrow around.
  useEffect(() => {
    containerRef.current?.focus({ preventScroll: true })
  }, [])

  // Keep the active cell in view when selection moves by keyboard.
  useEffect(() => {
    containerRef.current
      ?.querySelector(`[data-slide-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, revealTick])

  // Roving selection: plain arrows move the active cell over VISIBLE cells only (cards in
  // a collapsed section have no DOM node — selecting them would give zero feedback, the
  // same trap SlideStrip's key handler avoids). ←/→ step by one; ↑/↓ step by a visual row
  // (the column count); Enter opens the active slide in the editor.
  function handleGridKey(e: React.KeyboardEvent): void {
    if (!compiledSlides || compiledSlides.length === 0) return
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    // Keys typed in the Move … to… filter box (it is drawn inside this view) are not grid navigation.
    if (e.target instanceof HTMLElement && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return
    const visible: number[] = []
    groups.forEach((g, gi) => {
      if (!isCollapsedAt(gi)) for (const r of g.rows) visible.push(r.globalIndex)
    })
    if (visible.length === 0) return
    const pos = visible.indexOf(activeIndex)
    const step = (delta: number): number => {
      if (pos < 0) return delta > 0 ? visible[0] : visible[visible.length - 1]
      const next = Math.min(visible.length - 1, Math.max(0, pos + delta))
      return visible[next]
    }
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault()
        onSelectSlide(step(1))
        break
      case 'ArrowLeft':
        e.preventDefault()
        onSelectSlide(step(-1))
        break
      case 'ArrowDown':
        e.preventDefault()
        onSelectSlide(step(columns))
        break
      case 'ArrowUp':
        e.preventDefault()
        onSelectSlide(step(-columns))
        break
      case 'Home':
        e.preventDefault()
        onSelectSlide(visible[0])
        break
      case 'End':
        e.preventDefault()
        onSelectSlide(visible[visible.length - 1])
        break
      case 'Enter':
        e.preventDefault()
        if (onEdit && pos >= 0) onEdit(activeIndex)
        break
    }
  }

  // Latest-refs for the parent callbacks. WorkspaceLayout passes plain functions and inline arrows,
  // new on every one of its renders; depending on them directly made every handler below (and so
  // every memoised GridCell) change identity on each parent render — a selection change re-rendered
  // all cells. The handlers read the current callback through these refs and never change identity.
  const onSelectSlideRef = useRef(onSelectSlide)
  const onEditRef = useRef(onEdit)
  const onExplainRef = useRef(onExplain)
  const onReorderRef = useRef(onReorder)
  onSelectSlideRef.current = onSelectSlide
  onEditRef.current = onEdit
  onExplainRef.current = onExplain
  onReorderRef.current = onReorder
  const stableOnEdit = useCallback((index: number) => onEditRef.current?.(index), [])

  // ── The slide and section menus, and ⌘X / ⌘C / ⌘V on the selected card ──
  // Everything is addressed by SOURCE LINE through slideOps (the editor's whole-slide operations),
  // not by the block-index counter the drag uses. A card can be cut, copied, moved or deleted here
  // only when it is a `###` slide (the same cards the drag moves, isOutlineBlock); a paste goes
  // after any card that has a heading of its own. A section is addressed through its outline row.
  const slideOpsRef = useRef(slideOps ?? null)
  const lineOfSlideRef = useRef(lineOfSlide)
  slideOpsRef.current = slideOps ?? null
  lineOfSlideRef.current = lineOfSlide
  const [menu, setMenu] = useState<SlideMenuRequest | null>(null)
  // What the open menu is for: a card's display index, or a section group's index.
  const menuForRef = useRef<{ index: number } | { group: number } | null>(null)
  const menuRows = useMemo<SlideRow[]>(() => {
    let n = 0
    return snap.rows.map((r) => ({ line: r.line, level: r.level, text: r.text, id: null, slideNo: r.slide ? (n += 1) : null }))
  }, [snap.rows])
  const stableOnMenu = useCallback((e: React.MouseEvent, index: number, blockIndex: number | null) => {
    e.preventDefault()
    if (!slideOpsRef.current) { onExplainRef.current?.(index); return } // no slide operations wired: the old right-click
    containerRef.current?.focus({ preventScroll: true })
    onSelectSlideRef.current(index)
    menuForRef.current = { index }
    setMenu({ x: e.clientX, y: e.clientY, line: lineOfSlideRef.current?.(index) ?? null, mode: 'menu', editable: blockIndex !== null })
  }, [])
  function openSectionMenu(e: React.MouseEvent, gi: number): void {
    if (!slideOps) return
    e.preventDefault()
    const key = outlineKeys[gi]
    menuForRef.current = { group: gi }
    setMenu({ x: e.clientX, y: e.clientY, line: key ? snap.rows.find((r) => r.key === key)?.line ?? null : null, mode: 'menu', collapsed: isCollapsedAt(gi) })
  }
  const inTextField = (target: EventTarget): boolean => target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  function handleCutCopy(e: React.ClipboardEvent, cut: boolean): void {
    if (inTextField(e.target) || !slideOps || !compiledSlides) return
    const line = lineOfSlide?.(activeIndex) ?? null
    const row = compiledSlides[activeIndex]
    if (!row) return
    e.preventDefault()
    if (line == null || !isOutlineBlock(row)) {
      notify(`This card cannot be ${cut ? 'cut' : 'copied'} from the grid. ${cut ? 'Cut' : 'Copy'} it in the Slides outline or the editor.`, 'info', 'slide-clipboard')
      return
    }
    const clip = cut ? slideOps.cut(line) : slideOps.copy(line)
    if (clip != null) e.clipboardData.setData('text/plain', clip)
  }
  function handlePaste(e: React.ClipboardEvent): void {
    if (inTextField(e.target) || !slideOps) return
    e.preventDefault()
    // After the selected card's slide (after its whole block); at the end of the talk when it has no heading of its own.
    const at = slideOps.paste(e.clipboardData.getData('text/plain'), lineOfSlide?.(activeIndex) ?? null)
    if (at != null) onLanded?.(at)
  }

  // Stable handler callbacks — deps are minimal so these survive re-renders during drag.
  // Selecting by click also claims keyboard focus for the grid container, so arrows work
  // immediately after a click (a plain div click otherwise focuses nothing).
  const onSelect = useCallback(
    (index: number) => {
      containerRef.current?.focus({ preventScroll: true })
      onSelectSlideRef.current(index)
    },
    []
  )

  const onDragStart = useCallback(
    (e: React.DragEvent, index: number, blockIdx: number | null) => {
      dragFromRef.current = index
      dragFromBlockRef.current = blockIdx
      setDragFrom(index)
      setDropTarget(index)
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move'
        try {
          e.dataTransfer.setData('text/plain', String(index))
        } catch {
          /* Firefox quirk: ignore */
        }
      }
      stopAutoScrollRef.current?.()
      if (containerRef.current) {
        stopAutoScrollRef.current = startDragAutoScroll(containerRef.current, {
          sticky: '[data-grid-toolbar]',
          onScroll: (p) => {
            const at = dropTargetAt(document.elementFromPoint(p.x, p.y), p.x, p.y)
            // Outside the grid: keep the last target, the pointer has not moved.
            if (at !== null) setDropTarget((d) => (d === at ? d : at))
          }
        })
      }
    },
    [dropTargetAt]
  )

  const onDragEnter = useCallback((index: number) => {
    if (dragFromRef.current !== null) setDropTarget(index)
  }, [])

  const onDragOver = useCallback((e: React.DragEvent, index: number) => {
    if (dragFromRef.current === null) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    setDropTarget((d) => (d === index ? d : index))
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent, index: number, blockIdx: number | null) => {
      e.preventDefault()
      const fromBlock = dragFromBlockRef.current
      resetDrag(groupKeyOfCellRef.current(index))
      if (fromBlock !== null && blockIdx !== null && fromBlock !== blockIdx) {
        onReorderRef.current?.(fromBlock, blockIdx)
        onSelectSlideRef.current(index)
      }
    },
    [resetDrag]
  )

  const onDragEnd = useCallback((): void => resetDrag(), [resetDrag])

  // Section headers, the end zone and the open space under it: handled on the grid container
  // (cells keep their own memoised handlers above and are skipped here).
  function handleAreaDragOver(e: React.DragEvent): void {
    if (dragFromRef.current === null) return
    const at = dropTargetAt(e.target as Element, e.clientX, e.clientY)
    if (typeof at !== 'string') {
      // Not a header or the end zone. Off every target (a gap, a header with nothing to land after)
      // the indicator goes; over a cell the cell's own handler has already set it.
      if (at === null) setDropTarget(null)
      return
    }
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    setDropTarget((d) => (d === at ? d : at))
  }
  // A drop on a header puts the slide after that section's last slide; a drop on the end zone puts
  // it after the last slide of the talk. Both go through the same block-index reorder as a cell drop.
  function handleAreaDrop(e: React.DragEvent, groups: SectionGroup[]): void {
    const fromBlock = dragFromBlockRef.current
    const from = dragFromRef.current
    if (from === null) return
    const at = dropTargetAt(e.target as Element, e.clientX, e.clientY)
    if (typeof at !== 'string') return
    e.preventDefault()
    const group = at === END_DROP
      ? [...groups].reverse().find((g) => lastBlockOf(g) !== null)
      : groups.find((g) => g.key === at.slice(SECTION_DROP.length))
    resetDrag(group?.key ?? null)
    const last = group ? lastBlockOf(group) : null
    if (fromBlock === null || !last || last.blockIndex === fromBlock) return
    onReorderRef.current?.(fromBlock, last.blockIndex, 'after')
    // Follow the moved slide: it takes the old last slide's place when it came from above it, and
    // the place after it when it came from below.
    onSelectSlideRef.current(Math.min(slideCount - 1, from < last.globalIndex ? last.globalIndex : last.globalIndex + 1))
  }

  if (!compiledSlides || compiledSlides.length === 0) {
    return (
      <div
        className="grid-view"
        data-view="grid"
        style={{
          background: 'var(--panel)',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '16px'
        }}
      >
        <p style={{ fontSize: '12px', color: 'var(--muted)', margin: 0, textAlign: 'center' }}>
          No slides to show.
        </p>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="grid-view"
      data-view="grid"
      data-place-region="strip"
      tabIndex={0}
      onFocus={(e) => releaseSelectionOutside(e.currentTarget)}
      onKeyDown={handleGridKey}
      onCut={(e) => handleCutCopy(e, true)}
      onCopy={(e) => handleCutCopy(e, false)}
      onPaste={handlePaste}
      style={{
        background: 'var(--panel)',
        height: '100%',
        overflowY: 'auto',
        padding: '16px',
        outline: 'none'
      }}
      onDragOver={handleAreaDragOver}
      onDrop={(e) => handleAreaDrop(e, groups)}
      onDragLeave={(e) => {
        // Clear the target only when the pointer leaves the whole view, not when it
        // crosses between cells inside it.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDropTarget(null)
        }
      }}
    >
      <div
        data-grid-toolbar
        style={{ position: 'sticky', top: '-16px', zIndex: 2, display: 'flex', justifyContent: 'flex-end', gap: '2px', margin: '-16px -16px 12px', padding: '6px 16px', background: 'var(--panel)', borderBottom: '1px solid var(--line)' }}
      >
        <button type="button" className="tl-tbtn" title="Collapse all sections" aria-label="Collapse all sections" data-grid-collapse-all onClick={() => collapseAllSections(tk)}><IcCollapse /></button>
        <button type="button" className="tl-tbtn" title="Expand all sections" aria-label="Expand all sections" data-grid-expand-all onClick={() => expandAllSections(tk)}><IcExpand /></button>
      </div>
      {groups.map((group, groupIndex) => {
        const isCollapsed = isCollapsedAt(groupIndex)
        const isHeaderDrop = dragFrom !== null && dropTarget === SECTION_DROP + group.key
        return (
          <section key={group.key} style={{ marginBottom: '20px' }}>
            <div
              className="grid-section-header"
              data-section-header
              data-section-drop={canReorder && lastBlockOf(group) ? group.key : undefined}
              data-drop-into={isHeaderDrop ? 'true' : undefined}
              role="button"
              tabIndex={0}
              onClick={(e) => toggleAt(groupIndex, e.altKey)}
              onContextMenu={(e) => openSectionMenu(e, groupIndex)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  // Don't bubble to the grid container's key handler (Enter there = edit slide).
                  e.stopPropagation()
                  toggleAt(groupIndex, e.altKey)
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '6px 4px',
                marginBottom: '10px',
                borderBottom: '1px solid var(--line)',
                cursor: 'pointer',
                userSelect: 'none',
                // Drop indicator: the slide will go inside this section, as its last slide.
                borderRadius: isHeaderDrop ? '4px' : undefined,
                background: isHeaderDrop ? 'color-mix(in srgb, var(--oxford) 14%, transparent)' : undefined,
                boxShadow: isHeaderDrop ? 'inset 0 0 0 2px var(--oxford)' : undefined
              }}
            >
              <span
                aria-hidden
                style={{
                  fontSize: '11px',
                  color: 'var(--oxford)',
                  width: '12px',
                  display: 'inline-block',
                  textAlign: 'center'
                }}
              >
                {isCollapsed ? '▸' : '▾'}
              </span>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  color: 'var(--ink)',
                  letterSpacing: '0.02em',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {group.title}
              </span>
              <span
                style={{
                  fontSize: '10px',
                  color: 'var(--faint)',
                  fontFamily: 'var(--font-mono)',
                  flexShrink: 0
                }}
              >
                ({group.rows.length})
              </span>
            </div>

            {!isCollapsed && (
              <div
                className="grid-section-cells"
                data-last-section-cells={groupIndex === groups.length - 1 ? '' : undefined}
                style={{
                  display: 'grid',
                  gridTemplateColumns: `repeat(${columns}, 1fr)`,
                  gap: '14px'
                }}
              >
                {group.rows.map(({ row, globalIndex, blockIndex }) => (
                  <GridCell
                    key={`${row.slide_id || row.content_hash || 'row'}-${globalIndex}`}
                    row={row}
                    triggerFindings={triggerFindings}
                    thumbnails={thumbnails ?? null}
                    globalIndex={globalIndex}
                    blockIndex={blockIndex}
                    isActive={activeIndex === globalIndex}
                    isDropTarget={dropTarget === globalIndex && dragFrom !== null && dragFrom !== globalIndex}
                    isDragging={dragFrom === globalIndex}
                    cellDraggable={canReorder && blockIndex !== null}
                    onSelect={onSelect}
                    onEdit={onEdit ? stableOnEdit : undefined}
                    onMenu={onExplain || slideOps ? stableOnMenu : undefined}
                    onDragStart={onDragStart}
                    onDragEnter={onDragEnter}
                    onDragOver={onDragOver}
                    onDrop={onDrop}
                    onDragEnd={onDragEnd}
                  />
                ))}
              </div>
            )}
          </section>
        )
      })}
      {/* Always in the tree (adding it at drag start would shift the grid under the pointer): the
          drop zone after the last cell, which moves the dragged slide to the end. */}
      {canReorder && (
        <div
          data-grid-drop-end
          data-drop-active={dragFrom !== null && dropTarget === END_DROP ? 'true' : undefined}
          aria-hidden
          style={{ position: 'relative', height: '56px', marginTop: '-12px' }}
        >
          {dragFrom !== null && dropTarget === END_DROP && (
            <div style={{ position: 'absolute', left: 0, right: 0, top: '4px', height: '4px', borderRadius: '2px', background: 'var(--oxford)' }} />
          )}
        </div>
      )}
      <SlideRowMenus
        request={menu}
        rows={menuRows}
        ops={slideOps ?? null}
        onClose={() => setMenu(null)}
        onActed={() => containerRef.current?.focus({ preventScroll: true })}
        onLanded={onLanded}
        onToggleCollapse={() => { const f = menuForRef.current; if (f && 'group' in f) toggleAt(f.group) }}
        onExplain={onExplain ? () => { const f = menuForRef.current; if (f && 'index' in f) onExplain(f.index) } : undefined}
        onMore={onMoreActions ? () => { const f = menuForRef.current; if (f && 'index' in f && menu) onMoreActions(f.index, { x: menu.x, y: menu.y }) } : undefined}
      />
    </div>
  )
}
