import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { TalkInfo, ProjectionRow } from '../../../preload/index'
import { warningsForSurface } from '../../../../compiler/scripts/lib/warning-registry.mjs'

interface Props {
  talk: TalkInfo
  compiledSlides: ProjectionRow[] | null
  thumbnails?: Record<string, string> | null
  activeIndex: number
  onSelectSlide: (index: number) => void
  // Enter / double-click: open this slide's source in the editor, focused and ready to type
  // (leaves grid mode). Single click stays select-only so browsing never steals focus.
  onEdit?: (index: number) => void
  onReorder?: (fromIndex: number, toIndex: number) => void
  onExplain?: (index: number) => void
  columns: number
}

// thumbnails are keyed by render_hash (layout + block model), mirroring SlideStrip — so a
// layout/trigger change busts the cache; content_hash / slide_id are fallbacks.
function thumbKey(row: ProjectionRow): string | null {
  return row.render_hash || row.content_hash || row.slide_id || null
}

// Compiler warnings surfaced as a grid badge. Mirrors SlideStrip's SURFACED_WARNINGS:
// most engine warnings are resolution hints; only show the actionable ones. Keyed on the
// warning TYPE (the `<type>:<slide-id>[:<extra>]` prefix).
function surfacedWarnings(row: ProjectionRow): string[] {
  return warningsForSurface(row.warnings, 'strip-badge')
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
      const t = titleRow.row.nav_title || titleRow.row.title
      if (t) g.title = t
    }
  }
  return groups
}

interface CellThumbProps {
  row: ProjectionRow
  thumbnailUrl: string | null
}

// Real thumbnail when available; otherwise a neutral schematic box carrying the
// slide title so the grid stays legible before thumbnails render.
// Memoized: during a drag the whole grid re-renders on each cell-crossing (dropTarget state), but a
// cell's thumbnail props (row + url) don't change — so the heavy <img> tree is skipped, keeping drag smooth.
const CellThumb = React.memo(function CellThumb({ row, thumbnailUrl }: CellThumbProps) {
  const title = row.nav_title || row.title || 'Slide'
  const warnings = surfacedWarnings(row)
  return (
    <div style={{ position: 'relative', paddingTop: '56.25%', background: 'var(--paper)' }}>
      {warnings.length > 0 && (
        <span
          className="tw-slide-warning"
          data-slide-warning
          title={warnings.join('\n')}
          style={{
            position: 'absolute',
            top: '4px',
            right: '4px',
            zIndex: 3,
            fontSize: '9px',
            fontWeight: 700,
            lineHeight: 1,
            color: '#fff',
            background: '#d97706',
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
  thumbnails: Record<string, string> | null
  globalIndex: number
  blockIndex: number | null
  isActive: boolean
  isDropTarget: boolean
  isDragging: boolean
  cellDraggable: boolean
  onSelect: (globalIndex: number) => void
  onEdit?: (globalIndex: number) => void
  onExplain?: (globalIndex: number) => void
  onDragStart: (e: React.DragEvent, globalIndex: number, blockIndex: number | null) => void
  onDragEnter: (globalIndex: number) => void
  onDragOver: (e: React.DragEvent, globalIndex: number) => void
  onDrop: (e: React.DragEvent, globalIndex: number, blockIndex: number | null) => void
  onDragEnd: () => void
}

const GridCell = React.memo(function GridCell({
  row,
  thumbnails,
  globalIndex,
  blockIndex,
  isActive,
  isDropTarget,
  isDragging,
  cellDraggable,
  onSelect,
  onEdit,
  onExplain,
  onDragStart,
  onDragEnter,
  onDragOver,
  onDrop,
  onDragEnd
}: GridCellProps) {
  const key = thumbKey(row)
  const thumbnailUrl = key && thumbnails ? thumbnails[key] ?? null : null
  const title = row.nav_title || row.title || '(untitled)'

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
        draggable={cellDraggable}
        onClick={() => onSelect(globalIndex)}
        onDoubleClick={onEdit ? () => onEdit(globalIndex) : undefined}
        onContextMenu={onExplain ? (e) => { e.preventDefault(); onExplain(globalIndex) } : undefined}
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
        <CellThumb row={row} thumbnailUrl={thumbnailUrl} />
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
  talk: _talk,
  compiledSlides,
  thumbnails,
  activeIndex,
  onSelectSlide,
  onEdit,
  onReorder,
  onExplain,
  columns
}: Props): React.JSX.Element {
  // Section keys the user has collapsed. Local UI state only.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const containerRef = useRef<HTMLDivElement>(null)
  // dragFrom is the GLOBAL slide index of the source cell; held in a ref too so the
  // synchronous drop handler reads the live value, not a stale render closure.
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<number | null>(null)
  const dragFromRef = useRef<number | null>(null)
  const dragFromBlockRef = useRef<number | null>(null)

  const canReorder = !!onReorder

  const resetDrag = useCallback((): void => {
    dragFromRef.current = null
    dragFromBlockRef.current = null
    setDragFrom(null)
    setDropTarget(null)
  }, [])

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

  function toggleSection(key: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

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
  }, [activeIndex])

  // Roving selection: plain arrows move the active cell over VISIBLE cells only (cards in
  // a collapsed section have no DOM node — selecting them would give zero feedback, the
  // same trap SlideStrip's key handler avoids). ←/→ step by one; ↑/↓ step by a visual row
  // (the column count); Enter opens the active slide in the editor.
  function handleGridKey(e: React.KeyboardEvent): void {
    if (!compiledSlides || compiledSlides.length === 0) return
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    const groups = groupBySection(compiledSlides)
    const visible: number[] = []
    for (const g of groups) {
      if (!collapsed.has(g.key)) for (const r of g.rows) visible.push(r.globalIndex)
    }
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

  // Stable handler callbacks — deps are minimal so these survive re-renders during drag.
  // Selecting by click also claims keyboard focus for the grid container, so arrows work
  // immediately after a click (a plain div click otherwise focuses nothing).
  const onSelect = useCallback(
    (index: number) => {
      containerRef.current?.focus({ preventScroll: true })
      onSelectSlide(index)
    },
    [onSelectSlide]
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
    },
    []
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
      resetDrag()
      if (fromBlock !== null && blockIdx !== null && fromBlock !== blockIdx) {
        onReorder?.(fromBlock, blockIdx)
        onSelectSlide(index)
      }
    },
    [onReorder, onSelectSlide, resetDrag]
  )

  const onDragEnd = resetDrag

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

  const groups = groupBySection(compiledSlides)

  return (
    <div
      ref={containerRef}
      className="grid-view"
      data-view="grid"
      tabIndex={0}
      onKeyDown={handleGridKey}
      style={{
        background: 'var(--panel)',
        height: '100%',
        overflowY: 'auto',
        padding: '16px',
        outline: 'none'
      }}
      onDragLeave={(e) => {
        // Clear the target only when the pointer leaves the whole view, not when it
        // crosses between cells inside it.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDropTarget(null)
        }
      }}
    >
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.key)
        return (
          <section key={group.key} style={{ marginBottom: '20px' }}>
            <div
              className="grid-section-header"
              data-section-header
              role="button"
              tabIndex={0}
              onClick={() => toggleSection(group.key)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  // Don't bubble to the grid container's key handler (Enter there = edit slide).
                  e.stopPropagation()
                  toggleSection(group.key)
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
                userSelect: 'none'
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
                    thumbnails={thumbnails ?? null}
                    globalIndex={globalIndex}
                    blockIndex={blockIndex}
                    isActive={activeIndex === globalIndex}
                    isDropTarget={dropTarget === globalIndex && dragFrom !== null && dragFrom !== globalIndex}
                    isDragging={dragFrom === globalIndex}
                    cellDraggable={canReorder && blockIndex !== null}
                    onSelect={onSelect}
                    onEdit={onEdit}
                    onExplain={onExplain}
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
    </div>
  )
}
