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
import type { SlideRef } from '../../../shared/slide-handling/blocks'
import { slideKeys, useSlideSelection } from '../lib/useSlideSelection'
import BatchBar from './slide-handling/BatchBar'
import { writeSlideClipboard } from './SlideRowMenus'
import { registerSlideSelection } from '../lib/slideSelectionBus'
import { placeAtHeading, type SlidePlace } from '../../../shared/slide-handling/place'
import { sectionDropBoundary, type DropRow } from '../lib/sectionDrop'
import { headingLevelOfSource, highlightSegments, isEmptyQuery, parseQuery, type Snippet } from '../../../shared/slide-handling/query.ts'
import { firstHitFrom, hitPosition, runSearch, stepHit } from '../lib/slideSearchModel'
import { registerSearchSurface, usePictureText, useSlideQuery } from '../lib/slideSearch'

interface Props {
  talk: TalkInfo
  compiledSlides: ProjectionRow[] | null
  triggerFindings: readonly LayoutDoctorFinding[]
  thumbnails?: Record<string, string> | null
  previewsPending?: boolean
  activeIndex: number
  onSelectSlide: (index: number) => void
  // Enter / double-click: open this slide's source in the editor, focused and ready to type
  // (leaves grid mode). Single click stays select-only so browsing never steals focus.
  onEdit?: (index: number) => void
  /** The heading behind the card at a display index, in the editor's current text (null: a card with no heading). */
  slideRefOf?: (index: number) => SlideRef | null
  /** Move these slides or sections to `place` (shared/slide-handling moveBlocks, one undo step). */
  onMoveSlides?: (refs: SlideRef[], place: SlidePlace) => void
  /** ⌘↑ / ⌘↓ on the selected card. */
  onStepSlide?: (ref: SlideRef, dir: 'up' | 'down') => void
  /** Cut or delete these slides as ONE undo step (the clip goes on the clipboard by the host for 'cut'); false: refused. */
  onSetAsideSlides?: (refs: SlideRef[]) => Promise<boolean>
  onScratchDrop?: (id: string, place: SlidePlace) => void
  onCutSlides?: (refs: SlideRef[], mode: 'cut' | 'delete') => Promise<boolean>
  /** Copy these slides, talk order: the clip text, or null. */
  onCopySlides?: (refs: SlideRef[]) => string | null
  onExplain?: (index: number) => void
  columns: number
  // Whole-slide operations by source line (Editor.tsx SlideBlockOps). With them a right-click on a
  // card or a section header opens the slide or section menu, and ⌘X / ⌘C / ⌘V act on the selected card.
  slideOps?: SlideBlockOps | null
  /** The source line of the heading behind the card at a display index, or null (cover, closing). */
  lineOfSlide?: (index: number) => number | null
  /** Paste after the card at a display index (⌘V, the card menu's Paste); the host checks the card's heading is
   *  still on its line and refuses otherwise. Returns the pasted heading's line, or null. */
  onPasteAfterCard?: (clip: string, index: number) => number | null
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

// A projection row is a movable outline block iff it is a section's card or its source_markdown
// begins with a slide or section heading (`##`–`######`): a section's card moves the whole
// section. The cover title and closing carry no heading and are not dragged; a card whose heading
// line the host cannot find (slideRefOf null) does not move either. Moves are addressed by source line and heading text (slideRefOf), never by this counter,
// which only numbers the movable cards. Mirrors SlideStrip.
function isOutlineBlock(p: ProjectionRow): boolean {
  return p.role === 'section-title' || /^#{2,6}\s/.test((p.source_markdown ?? '').trimStart())
}

interface SectionGroup {
  // Identity of a section run, independent of its current position.
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
function groupBySection(rows: ProjectionRow[], keys: ReadonlyArray<string | null>): SectionGroup[] {
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
        key: `group:${keys[globalIndex]}`,
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

// The last movable block of a section run, or null when it has none — a drop on the
// section's header lands after this block.
function lastBlockOf(group: SectionGroup): { globalIndex: number; blockIndex: number } | null {
  for (let i = group.rows.length - 1; i >= 0; i -= 1) {
    const r = group.rows[i]
    if (r.blockIndex !== null) return { globalIndex: r.globalIndex, blockIndex: r.blockIndex }
  }
  return null
}

/** The drag image of several slides: a small stack with the count. */
function setStackDragImage(e: React.DragEvent, n: number): void {
  if (!e.dataTransfer?.setDragImage) return
  const ghost = document.createElement('div')
  ghost.textContent = `${n} slides`
  ghost.style.cssText = 'position:fixed;top:-200px;left:-200px;padding:10px 16px;background:#fff;color:#1b2d57;font:600 12px sans-serif;border:2px solid #1b2d57;border-radius:6px;box-shadow:4px 4px 0 -1px #fff,5px 5px 0 0 #1b2d57,9px 9px 0 -1px #fff,10px 10px 0 0 #1b2d57'
  document.body.appendChild(ghost)
  e.dataTransfer.setDragImage(ghost, 20, 16)
  window.setTimeout(() => ghost.remove(), 0)
}

interface CellThumbProps {
  row: ProjectionRow
  thumbnailUrl: string | null
  previewsPending: boolean
  triggerFindings: readonly LayoutDoctorFinding[]
}

// Real thumbnail when available; otherwise a neutral schematic box carrying the
// slide title so the grid stays legible before thumbnails render.
// Memoized: during a drag the whole grid re-renders on each cell-crossing (dropTarget state), but a
// cell's thumbnail props (row + url) don't change — so the heavy <img> tree is skipped, keeping drag smooth.
const CellThumb = React.memo(function CellThumb({ row, thumbnailUrl, triggerFindings, previewsPending }: CellThumbProps) {
  // A recompilation may change section-dependent artwork. Keep only this SAME source slide's
  // last decoded image while its replacement is pending; do not attach it to a new artwork hash.
  // Decode before swapping src, otherwise an already-loaded card flashes blank for a frame.
  const identity = JSON.stringify([row.slide_id, row.source_markdown])
  const [decoded, setDecoded] = useState({ identity, url: thumbnailUrl })
  useEffect(() => {
    if (!thumbnailUrl) return
    if (decoded.identity === identity && decoded.url === thumbnailUrl) return
    let cancelled = false
    const image = document.createElement('img')
    image.src = thumbnailUrl
    image.decode().then(() => {
      if (!cancelled) setDecoded({ identity, url: image.src })
    }).catch(() => {
      // A rejected decode alone is not a load failure. A fully loaded candidate is still this
      // exact picture and can use the browser's normal paint path. Never substitute another slide.
      if (!cancelled) setDecoded({ identity, url: image.complete && image.naturalWidth > 0 ? image.src : null })
    })
    return () => { cancelled = true }
    // Request completion does not change the image; keep an unchanged decode in flight.
  }, [identity, thumbnailUrl]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!thumbnailUrl && !previewsPending) setDecoded(previous =>
      previous.identity === identity && previous.url === null ? previous : { identity, url: null })
  }, [identity, thumbnailUrl, previewsPending])
  const visibleUrl = decoded.identity === identity ? decoded.url : thumbnailUrl
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
      {visibleUrl ? (
        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
          <img
            src={visibleUrl}
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
  previewsPending: boolean
  globalIndex: number
  blockIndex: number | null
  isActive: boolean
  isDropTarget: boolean
  isDragging: boolean
  isSelected: boolean
  /** Searching and this card does not match: dimmed in place. */
  dim: boolean
  isHitNow: boolean
  /** Strings to mark in the title while searching, else null. */
  marks: readonly string[] | null
  snippet: Snippet | null
  cellDraggable: boolean
  onSelect: (globalIndex: number, e: React.MouseEvent) => void
  onTick?: (globalIndex: number) => void
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
  previewsPending,
  globalIndex,
  blockIndex,
  isActive,
  isDropTarget,
  isDragging,
  isSelected,
  dim,
  isHitNow,
  marks,
  snippet,
  cellDraggable,
  onSelect,
  onTick,
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
        data-selected={isSelected ? 'true' : undefined}
        data-search-dim={dim ? 'true' : undefined}
        data-search-hit={isHitNow ? 'true' : undefined}
        data-drop-target={isDropTarget ? 'true' : undefined}
        draggable={cellDraggable}
        onClick={(e) => onSelect(globalIndex, e)}
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
          opacity: isDragging ? 0.4 : dim ? 0.3 : 1,
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
        {onTick && (
          <input
            type="checkbox"
            className="grid-tick"
            data-grid-tick
            aria-label={`Select ${title}`}
            checked={isSelected}
            draggable={false}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onTick(globalIndex)}
          />
        )}
        <CellThumb row={row} thumbnailUrl={thumbnailUrl} previewsPending={previewsPending} triggerFindings={triggerFindings} />
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
            {marks ? highlightSegments(title, marks).map((seg, i) => (seg.hit ? <mark key={i} className="so-match">{seg.text}</mark> : seg.text)) : title}
          </span>
        </div>
        {snippet && (
          <div className="so-snippet" data-grid-snippet style={{ padding: '0 8px 5px' }}>
            {snippet.label}: {snippet.segments.map((seg, i) => (seg.hit ? <mark key={i} className="so-match">{seg.text}</mark> : seg.text))}
          </div>
        )}
      </div>
      {/* Carousel sub-slides: each stepped full-bleed sub-slide as its own cell. */}
      {subUrls.map((u, i) => (
        <div
          key={`sub-${globalIndex}-${i}`}
          className="grid-subcell"
          data-subslide
          title={`${title} — step ${i + 1}`}
          onClick={(e) => onSelect(globalIndex, e)}
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
}, (before, after) => {
  // Each progressive update replaces the map. Compare only THIS cell's pictures so an arriving
  // preview cannot re-render a whole large grid. Every other prop (handlers included) still counts.
  for (const key of Object.keys(before) as Array<keyof GridCellProps>) {
    if (key !== 'thumbnails' && !Object.is(before[key], after[key])) return false
  }
  const key = thumbKey(after.row)
  if (!key || before.thumbnails === after.thumbnails) return true
  if (before.thumbnails?.[key] !== after.thumbnails?.[key]) return false
  for (let i = 0; ; i++) {
    const a = before.thumbnails?.[`${key}__${i}`]
    const b = after.thumbnails?.[`${key}__${i}`]
    if (a !== b) return false
    if (!a && !b) return true
  }
})

export default function GridView({
  talk,
  compiledSlides,
  triggerFindings,
  thumbnails,
  previewsPending = false,
  activeIndex,
  onSelectSlide,
  onEdit,
  slideRefOf,
  onMoveSlides,
  onStepSlide,
  onSetAsideSlides,
  onScratchDrop,
  onCutSlides,
  onCopySlides,
  onExplain,
  columns,
  slideOps,
  lineOfSlide,
  onPasteAfterCard,
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
  // Include generated opening/closing cards; disambiguate malformed/legacy duplicate ids too.
  const cardKeys = useMemo(() => slideKeys(compiledSlides ?? [], () => true), [compiledSlides])
  const groups = useMemo(() => (compiledSlides ? groupBySection(compiledSlides, cardKeys) : []), [compiledSlides, cardKeys])
  // Search (ticket 2): the outline's query, the same rule. Non-matching cards dim in place; drag and selection stay on.
  const [query, setQuery] = useSlideQuery(tk)
  const [hitIndex, setHitIndex] = useState<number | null>(null)
  const queryActive = !isEmptyQuery(parseQuery(query))
  const blocks = useMemo(() => (compiledSlides ?? []).map((r) => r.source_markdown ?? ''), [compiledSlides])
  const pictureText = usePictureText(tk || null, blocks, queryActive)
  const run = useMemo(() => runSearch((compiledSlides ?? []).map((r, i) => ({
    key: i, level: r.role === 'section-title' ? 2 : headingLevelOfSource(r.source_markdown ?? ''), title: `${r.nav_title || ''}\n${r.title || ''}`, body: r.source_markdown ?? '', image: pictureText.length === blocks.length ? pictureText[i] : ''
  })), query, talk?.title ?? ''), [compiledSlides, query, pictureText, blocks, talk?.title])
  const searching = run.active
  const titleScope = run.query.scope === 'all' || run.query.scope === 'title'
  const hitsInGroup = useMemo(() => groups.map((g) => g.rows.filter((r) => run.isHit.has(r.globalIndex)).length), [groups, run])
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
  const explicitRevealRef = useRef(false)
  const seenActiveRef = useRef(activeIndex)
  const seenActiveKeyRef = useRef(cardKeys[activeIndex])
  useEffect(() => {
    if (seenActiveRef.current === activeIndex) return
    seenActiveRef.current = activeIndex
    const previousKey = seenActiveKeyRef.current
    seenActiveKeyRef.current = cardKeys[activeIndex]
    if (previousKey === cardKeys[activeIndex] && !explicitRevealRef.current) return
    if (noRevealRef.current) { noRevealRef.current = false; return } // typing a search lands on a hit without opening its section
    const gi = groups.findIndex((g) => g.rows.some((r) => r.globalIndex === activeIndex))
    if (gi < 0 || !isCollapsedAt(gi)) return
    const key = outlineKeys[gi]
    if (key) revealKeys(tk, [key, ...ancestorKeysOfIndex(snap.rows, snap.rows.findIndex((r) => r.key === key))])
    else setCollapsedAt(gi, false)
    setRevealTick((n) => n + 1)
  }, [activeIndex]) // eslint-disable-line react-hooks/exhaustive-deps
  const containerRef = useRef<HTMLDivElement>(null)
  const [barHeight, setBarHeight] = useState(0)
  // dragFrom is the GLOBAL slide index of the source cell; held in a ref too so the
  // synchronous drop handler reads the live value, not a stale render closure.
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [scratchDragging, setScratchDragging] = useState(false)
  const [dropTarget, setDropTarget] = useState<GridDropTarget>(null)
  const stopAutoScrollRef = useRef<(() => void) | null>(null)
  const dragFromRef = useRef<number | null>(null)
  const dragFromBlockRef = useRef<number | null>(null)
  const dragRefRef = useRef<SlideRef | null>(null)

  const canReorder = !!onMoveSlides && !!slideRefOf

  const resetDrag = useCallback((keepGroupKey: string | null = null): void => {
    closeSprungRef.current(keepGroupKey)
    dragFromRef.current = null
    dragFromBlockRef.current = null
    dragRefRef.current = null
    dragRefsRef.current = []
    setDragMulti(false)
    setDragFrom(null)
    setScratchDragging(false)
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

  // ⌘↑ / ⌘↓ — move the active slide or section past its neighbour of the same level (the host
  // works the place out from the text: shared/slide-handling stepPlace). GridView only mounts in
  // grid mode, so this window listener is scoped to the grid; it also bows out while the editor or
  // any text input is focused so it never hijacks caret navigation.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.closest('.cm-editor') || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
        return
      }
      if (!onStepSlide || !slideRefOf || !compiledSlides) return
      const row = compiledSlides[activeIndex]
      if (!row || !isOutlineBlock(row)) return
      const ref = slideRefOf(activeIndex)
      if (!ref) return
      e.preventDefault()
      e.stopPropagation()
      explicitRevealRef.current = true
      onStepSlide(ref, e.key === 'ArrowUp' ? 'up' : 'down') // the host selects the moved slide where it lands
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [activeIndex, compiledSlides, onStepSlide, slideRefOf])

  // The grid owns keyboard focus while it is on screen: it only mounts in grid mode, so
  // focusing on mount means ⌘4 (or the Grid button) lands you ready to arrow around.
  useEffect(() => {
    containerRef.current?.focus({ preventScroll: true })
  }, [])

  // Reindexing the SAME active card is not navigation. In particular, a drop must not scroll
  // back to the previous selection before the moved card's landing selects its destination.
  const scrolledSelectionRef = useRef<{ key: string | null; reveal: number } | null>(null)
  useEffect(() => {
    const key = cardKeys[activeIndex] ?? null
    const previous = scrolledSelectionRef.current
    scrolledSelectionRef.current = { key, reveal: revealTick }
    if (previous?.key === key && previous.reveal === revealTick && !explicitRevealRef.current) return
    explicitRevealRef.current = false
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
    if (e.key === 'Escape' && sel.count > 0) { e.preventDefault(); sel.clear(); return }
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
  const onMoveSlidesRef = useRef(onMoveSlides)
  const onScratchDropRef = useRef(onScratchDrop)
  const onSetAsideRef = useRef(onSetAsideSlides)
  onScratchDropRef.current = onScratchDrop
  onSetAsideRef.current = onSetAsideSlides
  const slideRefOfRef = useRef(slideRefOf)
  onSelectSlideRef.current = onSelectSlide
  onEditRef.current = onEdit
  onExplainRef.current = onExplain
  onMoveSlidesRef.current = onMoveSlides
  slideRefOfRef.current = slideRefOf
  const stableOnEdit = useCallback((index: number) => onEditRef.current?.(index), [])
  const gotoHit = (index: number | null): void => {
    if (index == null) return
    setHitIndex(index)
    onSelectSlideRef.current(index)
    requestAnimationFrame(() => containerRef.current?.querySelector(`[data-slide-index="${index}"]`)?.scrollIntoView({ block: 'nearest' }))
  }
  const stepSearch = (dir: 1 | -1): void => gotoHit(stepHit(run.order, hitIndex, dir))
  const orderKey = run.order.join(',')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const surfaceRef = useRef<{ focus(): void; step(dir: 1 | -1): boolean }>({ focus: () => {}, step: () => false })
  surfaceRef.current = {
    focus: () => { searchInputRef.current?.focus(); searchInputRef.current?.select() },
    step: (dir) => { if (!searching) return false; stepSearch(dir); return true }
  }
  useEffect(() => registerSearchSurface('grid', { focus: () => surfaceRef.current.focus(), step: (d) => surfaceRef.current.step(d) }), [])
  // Landing on the first hit happens ONLY when the query changes (a new non-empty query), once it has a hit, and
  // typing does not open collapsed sections (the outline does not either; Next / Previous and a click do).
  // After a recompile nothing moves: the current hit is found again by its title, or dropped when it is gone.
  const runRef = useRef(run)
  runRef.current = run
  const titleAt = (i: number): string => { const r = compiledSlides?.[i]; return r ? `${r.nav_title || ''}\n${r.title || ''}` : '' }
  const hitTitleRef = useRef<string | null>(null)
  useEffect(() => { hitTitleRef.current = hitIndex == null ? null : titleAt(hitIndex) }, [hitIndex]) // eslint-disable-line react-hooks/exhaustive-deps
  const noRevealRef = useRef(false)
  useEffect(() => {
    if (!searching) { setHitIndex(null); return }
    // Keyed on the query text alone: reads the hits at that moment; no hit -> nothing lands until the query changes again.
    const order = runRef.current.order
    if (order.length === 0) return
    const first = firstHitFrom(order, activeIndex)
    noRevealRef.current = first != null && first !== activeIndex
    gotoHit(first)
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps
  // After a recompile: the current hit, found again by its title (or dropped when it is gone). Nothing else moves.
  useEffect(() => {
    if (hitIndex == null) return
    let next: number | null = hitIndex
    if (hitTitleRef.current != null && titleAt(hitIndex) !== hitTitleRef.current) {
      const at = (compiledSlides ?? []).findIndex((_, i) => titleAt(i) === hitTitleRef.current)
      next = at >= 0 ? at : null
    }
    const keep = next != null && run.isHit.has(next) ? next : null
    if (keep !== hitIndex) setHitIndex(keep)
  }, [compiledSlides]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── The slide and section menus, and ⌘X / ⌘C / ⌘V on the selected card ──
  // Everything is addressed by SOURCE LINE through slideOps (the editor's whole-slide operations),
  // as the drag is. A card can be cut, copied, moved or deleted here when it has a heading of its
  // own, at any level (a section's card takes the whole section); a paste goes after any such card.
  // A section is also addressed through its outline row.
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
    if (sel.count >= 2 && onCutSlides && onCopySlides) {
      // Several selected: one cut or copy of all, talk order (the host puts a cut on the clipboard itself).
      e.preventDefault()
      if (cut) void cutSelected('cut')
      else { const clip = onCopySlides(selectedRefs()); if (clip != null) e.clipboardData.setData('text/plain', clip) }
      return
    }
    const row = compiledSlides[activeIndex]
    if (!row) return
    e.preventDefault()
    // One card: the same checked cut / copy as several (the card's heading must still be on its line).
    const clip = cardCutCopy(activeIndex, cut ? 'cut' : 'copy')
    if (clip != null) e.clipboardData.setData('text/plain', clip)
  }
  /** Cut, copy or delete ONE card through the host's checked handlers (cutBlocks / copyBlocks); the clip for a copy. */
  function cardCutCopy(index: number, mode: 'cut' | 'copy' | 'delete'): string | null {
    const ref = slideRefOfRef.current?.(index) ?? null
    const cutFn = onCutSlidesRef.current
    const copyFn = onCopySlidesRef.current
    if (!ref || !cutFn || !copyFn) {
      const verb = mode === 'copy' ? 'copied' : mode === 'cut' ? 'cut' : 'deleted'
      notify(`This card cannot be ${verb} from the grid. Do it in the Slides outline or the editor.`, 'info', 'slide-clipboard')
      return null
    }
    if (mode === 'copy') return copyFn([ref])
    void cutFn([ref], mode) // the host puts a cut on the clipboard itself
    return null
  }
  function handlePaste(e: React.ClipboardEvent): void {
    if (inTextField(e.target) || !slideOps || !onPasteAfterCard) return
    e.preventDefault()
    // After the selected card's slide (after its whole block); at the end of the talk when it has no heading of its own.
    const at = onPasteAfterCard(e.clipboardData.getData('text/plain'), activeIndex)
    if (at != null) onLanded?.(at)
  }
  // The card menu's Cut / Copy / Delete / Paste go through the same checked handlers as the keys (a section header's
  // menu keeps the editor's line operations: its line is read from the buffer's own outline, not from a card).
  const cardMenuOps = useMemo<SlideBlockOps | null>(() => {
    if (!slideOps) return null
    const cardIndex = (): number | null => { const f = menuForRef.current; return f && 'index' in f ? f.index : null }
    return {
      ...slideOps,
      cut: (line) => { const i = cardIndex(); return i == null ? slideOps.cut(line) : cardCutCopy(i, 'cut') },
      copy: (line) => { const i = cardIndex(); return i == null ? slideOps.copy(line) : cardCutCopy(i, 'copy') },
      delete: (line) => { const i = cardIndex(); if (i == null) slideOps.delete(line); else cardCutCopy(i, 'delete') },
      // Move slide to…: the card's heading goes with the move, so a stale card is refused (moveBlocks' ref check).
      moveTo: (line, target) => {
        const i = cardIndex()
        if (i == null) return slideOps.moveTo(line, target)
        const ref = slideRefOfRef.current?.(i) ?? null
        if (!ref) { notify('This card cannot be moved from the grid. Do it in the Slides outline or the editor.', 'info', 'slide-clipboard'); return null }
        return slideOps.moveTo(ref.line, target, ref)
      },
      paste: (clip, afterLine) => {
        const i = cardIndex()
        if (i == null) return slideOps.paste(clip, afterLine)
        return onPasteAfterCard ? onPasteAfterCard(clip, i) : null
      }
    }
  }, [slideOps, onPasteAfterCard]) // eslint-disable-line react-hooks/exhaustive-deps

  // Stable handler callbacks — deps are minimal so these survive re-renders during drag.
  // Selecting by click also claims keyboard focus for the grid container, so arrows work
  // immediately after a click (a plain div click otherwise focuses nothing).
  // The selection of several slides (slide handling 1b): ticks, ⇧-click range, ⌘-click toggle, Select section.
  // Keys are the slides' stable identity (useSlideSelection.slideKeys), so it survives a move.
  const slideKeyList = useMemo(
    () => (compiledSlides ? slideKeys(compiledSlides, (i) => isOutlineBlock(compiledSlides[i])) : []),
    [compiledSlides]
  )
  const sel = useSlideSelection(slideKeyList)
  const [moveOpen, setMoveOpen] = useState(false)
  const [dragMulti, setDragMulti] = useState(false)
  const dragRefsRef = useRef<SlideRef[]>([])
  const onCutSlidesRef = useRef(onCutSlides)
  const onCopySlidesRef = useRef(onCopySlides)
  onCutSlidesRef.current = onCutSlides
  onCopySlidesRef.current = onCopySlides
  const live = useRef({ sel, groups, activeIndex, canReorder, isCollapsedAt })
  live.current = { sel, groups, activeIndex, canReorder, isCollapsedAt }
  // A section card dragged onto a slide card lands at that slide's section boundary (sectionDrop.ts); the bar shows there.
  const dropRows = useMemo<DropRow[]>(
    () => (compiledSlides ?? []).map((r) => ({ role: r.role, section: r.section ?? '', movable: isOutlineBlock(r) })),
    [compiledSlides]
  )
  const dropRowsRef = useRef(dropRows)
  dropRowsRef.current = dropRows
  const barCell = (index: number): number => {
    const from = dragFromRef.current
    return from === null ? index : sectionDropBoundary(dropRowsRef.current, from, index)?.cell ?? index
  }
  const selectedRefs = (): SlideRef[] =>
    live.current.sel.indices.map((i) => slideRefOfRef.current?.(i) ?? null).filter((r): r is SlideRef => r !== null)
  useEffect(() => { if (sel.count < 2) setMoveOpen(false) }, [sel.count])

  const onSelect = useCallback(
    (index: number, e?: React.MouseEvent) => {
      containerRef.current?.focus({ preventScroll: true })
      const L = live.current
      if (L.canReorder && e?.shiftKey) {
        const visible = new Set<number>()
        L.groups.forEach((g, gi) => { if (!L.isCollapsedAt(gi)) for (const r of g.rows) visible.add(r.globalIndex) })
        L.sel.extendTo(index, L.activeIndex, (i) => visible.has(i))
      } else if (L.canReorder && (e?.metaKey || e?.ctrlKey)) L.sel.toggle(index)
      else L.sel.reset(index)
      onSelectSlideRef.current(index)
    },
    []
  )
  const onTick = useCallback((index: number) => {
    containerRef.current?.focus({ preventScroll: true })
    live.current.sel.toggle(index)
  }, [])
  /** "Select section": every movable card of the section (its own card included, so it all moves as one block). */
  function selectGroup(gi: number, keepOthers = false): void {
    const group = groups[gi]
    if (!group) return
    const list = group.rows.filter((r) => r.blockIndex !== null).map((r) => r.globalIndex)
    if (list.length === 0) return
    if (!keepOthers) sel.reset(list[0])
    sel.addMany(list)
  }
  const selectedLines = (): number[] => live.current.sel.indices.map((i) => lineOfSlideRef.current?.(i) ?? null).filter((n): n is number => n !== null)
  async function cutSelected(mode: 'cut' | 'delete'): Promise<void> {
    const refs = selectedRefs()
    if (refs.length === 0 || !onCutSlidesRef.current) return
    if (await onCutSlidesRef.current(refs, mode)) live.current.sel.clear()
  }
  async function asideSelected(refs = selectedRefs()): Promise<void> {
    if (refs.length > 0 && await onSetAsideRef.current?.(refs)) live.current.sel.clear()
  }
  function copySelected(): void {
    const clip = onCopySlidesRef.current?.(selectedRefs()) ?? null
    if (clip != null) writeSlideClipboard(clip, false)
  }
  useEffect(() => registerSlideSelection({
    count: () => live.current.sel.count,
    selectLines: lines => {
      const rows = live.current.groups.flatMap(group => group.rows)
      const indices = lines.map(line => rows.find(row => lineOfSlideRef.current?.(row.globalIndex) === line)?.globalIndex)
      if (!indices.length || indices.some(index => index === undefined)) return false
      live.current.sel.clear()
      live.current.sel.addMany(indices as number[])
      return true
    },
    selectSection: () => {
      const gi = live.current.groups.findIndex((g) => g.rows.some((r) => r.globalIndex === live.current.activeIndex))
      if (gi < 0) return false
      selectGroup(gi)
      return true
    },
    clear: () => live.current.sel.clear(),
    openMove: () => { if (live.current.sel.count < 2) return false; setMoveOpen(true); return true },
    setAside: () => { const refs = live.current.sel.count > 0 ? selectedRefs() : [slideRefOfRef.current?.(live.current.activeIndex)].filter((r): r is SlideRef => r != null); if (!refs.length || !onSetAsideRef.current) return false; void asideSelected(refs); return true },
    remove: () => { if (live.current.sel.count < 2) return false; void cutSelected('delete'); return true }
  }), []) // eslint-disable-line react-hooks/exhaustive-deps

  const onDragStart = useCallback(
    (e: React.DragEvent, index: number, blockIdx: number | null) => {
      dragFromRef.current = index
      dragFromBlockRef.current = blockIdx
      // What is dragged: the card's heading line and text as the buffer has them NOW, so a drop after
      // the talk changed is refused (moveBlocks) instead of moving another block.
      dragRefRef.current = blockIdx !== null ? slideRefOfRef.current?.(index) ?? null : null
      // A selected card drags every selected slide (talk order); an unselected card drags just itself.
      const L = live.current
      const multi = dragRefRef.current !== null && L.sel.count >= 2 && L.sel.isSelected(index)
      dragRefsRef.current = multi ? selectedRefs() : dragRefRef.current ? [dragRefRef.current] : []
      setDragMulti(multi && dragRefsRef.current.length >= 2)
      if (multi && dragRefsRef.current.length >= 2) setStackDragImage(e, dragRefsRef.current.length)
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
            const raw = dropTargetAt(document.elementFromPoint(p.x, p.y), p.x, p.y)
            const at = typeof raw === 'number' ? barCell(raw) : raw
            // Outside the grid: keep the last target, the pointer has not moved.
            if (at !== null) setDropTarget((d) => (d === at ? d : at))
          }
        })
      }
    },
    [dropTargetAt]
  )

  const onDragEnter = useCallback((index: number) => {
    if (dragFromRef.current !== null) setDropTarget(barCell(index))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const onDragOver = useCallback((e: React.DragEvent, index: number) => {
    if (e.dataTransfer?.types.includes('application/x-tw-scratch-item') && onScratchDropRef.current) {
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setScratchDragging(true); setDropTarget(index); return
    }
    if (dragFromRef.current === null) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    const at = barCell(index)
    setDropTarget((d) => (d === at ? d : at))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const onDrop = useCallback(
    (e: React.DragEvent, index: number, blockIdx: number | null) => {
      e.preventDefault()
      const scratchId = e.dataTransfer?.getData('application/x-tw-scratch-item')
      if (scratchId) {
        e.stopPropagation()
        const target = slideRefOfRef.current?.(index)
        resetDrag()
        if (target) onScratchDropRef.current?.(scratchId, placeAtHeading('before', target))
        return
      }
      const from = dragFromRef.current
      const dragged = dragRefsRef.current
      const multi = dragged.length >= 2
      resetDrag(groupKeyOfCellRef.current(index))
      if (from === null || dragged.length === 0 || blockIdx === null || from === index) return
      if (multi && live.current.sel.isSelected(index)) return // dropped on one of the dragged slides: nothing to do
      // A section card on a slide card: the boundary of that slide's section (before it going up, after it going down).
      const boundary = sectionDropBoundary(dropRowsRef.current, from, index)
      const target = slideRefOfRef.current?.(boundary ? boundary.refIndex : index)
      if (!target) return
      // Dragging down lands after the target card's block, dragging up before it (the drop line shows which).
      onMoveSlidesRef.current?.(dragged, placeAtHeading(boundary ? boundary.kind : index > from ? 'after' : 'before', target))
    },
    [resetDrag]
  )

  const onDragEnd = useCallback((): void => resetDrag(), [resetDrag])

  // Section headers, the end zone and the open space under it: handled on the grid container
  // (cells keep their own memoised handlers above and are skipped here).
  function handleAreaDragOver(e: React.DragEvent): void {
    const scratch = e.dataTransfer?.types.includes('application/x-tw-scratch-item') && !!onScratchDropRef.current
    if (dragFromRef.current === null && !scratch) return
    if (scratch) {
      setScratchDragging(true)
      if (!stopAutoScrollRef.current && containerRef.current) stopAutoScrollRef.current = startDragAutoScroll(containerRef.current, {
        sticky: '[data-grid-toolbar]',
        onScroll: (pointer) => {
          const at = dropTargetAt(document.elementFromPoint(pointer.x, pointer.y), pointer.x, pointer.y)
          if (at !== null) setDropTarget(at)
        }
      })
    }
    const at = dropTargetAt(e.target as Element, e.clientX, e.clientY)
    if (typeof at !== 'string') {
      // Not a header or the end zone. Off every target (a gap, a header with nothing to land after)
      // the indicator goes; over a cell the cell's own handler has already set it.
      if (at === null) setDropTarget(null)
      return
    }
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = scratch ? 'copy' : 'move'
    setDropTarget((d) => (d === at ? d : at))
  }
  // A drop on a header puts the slide after that section's last slide; a drop on the end zone puts
  // it after the last slide of the talk. Both go through the same move as a cell drop.
  function handleAreaDrop(e: React.DragEvent, groups: SectionGroup[]): void {
    const dragged = dragRefsRef.current
    const from = dragFromRef.current
    const scratchId = e.dataTransfer?.getData('application/x-tw-scratch-item')
    if (from === null && !scratchId) return
    const at = dropTargetAt(e.target as Element, e.clientX, e.clientY)
    if (typeof at !== 'string') return
    e.preventDefault()
    const group = at === END_DROP
      ? [...groups].reverse().find((g) => lastBlockOf(g) !== null)
      : groups.find((g) => g.key === at.slice(SECTION_DROP.length))
    resetDrag(group?.key ?? null)
    const last = group ? lastBlockOf(group) : null
    if (!last || (!scratchId && (dragged.length === 0 || last.globalIndex === from))) return
    const target = slideRefOf?.(last.globalIndex)
    if (!target) return
    if (scratchId) { onScratchDropRef.current?.(scratchId, placeAtHeading('after', target)); return }
    onMoveSlidesRef.current?.(dragged, placeAtHeading('after', target)) // the host selects the moved slide
  }

  if (!compiledSlides || compiledSlides.length === 0) {
    return (
      <div
        className="grid-view"
        data-view="grid"
        data-drop-target={scratchDragging ? 'true' : undefined}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('application/x-tw-scratch-item') || !onScratchDrop) return
          event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setScratchDragging(true)
        }}
        onDragLeave={() => setScratchDragging(false)}
        onDrop={(event) => {
          const id = event.dataTransfer.getData('application/x-tw-scratch-item')
          if (!id || !onScratchDrop) return
          event.preventDefault(); event.stopPropagation(); resetDrag(); onScratchDrop(id, { kind: 'start' })
        }}
        style={{
          boxShadow: scratchDragging ? 'inset 4px 0 var(--oxford)' : undefined,
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
        overflowAnchor: 'none',
        padding: '16px',
        // While the selection bar shows it sticks over the lowest cards: pad by its height (and its 12px margin plus a gap).
        paddingBottom: barHeight > 0 ? `${barHeight + 12 + 16}px` : '16px',
        outline: 'none'
      }}
      onDragOver={handleAreaDragOver}
      onDrop={(e) => handleAreaDrop(e, groups)}
      onDragLeave={(e) => {
        // Clear the target only when the pointer leaves the whole view, not when it
        // crosses between cells inside it.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDropTarget(null)
          if (scratchDragging) resetDrag()
        }
      }}
    >
      <div
        data-grid-toolbar
        style={{ position: 'sticky', top: '-16px', zIndex: 2, display: 'flex', alignItems: 'center', gap: '6px', margin: '-16px -16px 12px', padding: '6px 16px', background: 'var(--panel)', borderBottom: '1px solid var(--line)' }}
      >
        <input
          type="search"
          className="so-search-input grid-search-input"
          data-grid-search
          ref={searchInputRef}
          placeholder="Search titles, text and pictures…"
          aria-label="Search the slides"
          value={query}
          style={{ width: '260px', flex: '0 1 260px' }}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && searching && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); stepSearch(e.shiftKey ? -1 : 1) }
            else if (e.key === 'Escape' && query) { e.preventDefault(); setQuery('') }
          }}
          onCut={(e) => e.stopPropagation()}
          onCopy={(e) => e.stopPropagation()}
          onPaste={(e) => e.stopPropagation()}
        />
        {searching && (
          <span data-grid-hitbar style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--muted)' }}>
            <span data-grid-hitcount><b style={{ color: 'var(--ink)' }}>{hitPosition(run.order, hitIndex).k}</b> of {run.order.length}</span>
            <button type="button" className="tl-tbtn so-hitbtn" data-grid-prev disabled={run.order.length === 0} onClick={() => stepSearch(-1)}>‹ Previous</button>
            <button type="button" className="tl-tbtn so-hitbtn" data-grid-next disabled={run.order.length === 0} onClick={() => stepSearch(1)}>Next ›</button>
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" className="tl-tbtn" title="Collapse all sections" aria-label="Collapse all sections" data-grid-collapse-all onClick={() => collapseAllSections(tk)}><IcCollapse /></button>
        <button type="button" className="tl-tbtn" title="Expand all sections" aria-label="Expand all sections" data-grid-expand-all onClick={() => expandAllSections(tk)}><IcExpand /></button>
      </div>
      {groups.map((group, groupIndex) => {
        const isCollapsed = isCollapsedAt(groupIndex)
        const isHeaderDrop = (scratchDragging || dragFrom !== null) && dropTarget === SECTION_DROP + group.key
        const groupHits = hitsInGroup[groupIndex]
        return (
          <section key={group.key} style={{ marginBottom: '20px' }} data-group-dim={searching && groupHits === 0 ? 'true' : undefined}>
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
                opacity: searching && groupHits === 0 ? 0.4 : 1,
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
              {searching && groupHits > 0 && (
                <span data-grid-section-hits className="so-hits">{groupHits} hit{groupHits === 1 ? '' : 's'}</span>
              )}
              {canReorder && lastBlockOf(group) && (
                <button
                  type="button"
                  className="grid-select-section"
                  data-grid-select-section
                  onClick={(e) => { e.stopPropagation(); selectGroup(groupIndex, e.metaKey || e.ctrlKey) }}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  Select section
                </button>
              )}
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
                    key={cardKeys[globalIndex]}
                    row={row}
                    triggerFindings={triggerFindings}
                    thumbnails={thumbnails ?? null}
                    previewsPending={previewsPending}
                    globalIndex={globalIndex}
                    blockIndex={blockIndex}
                    isActive={activeIndex === globalIndex}
                    isDropTarget={dropTarget === globalIndex && (scratchDragging || (dragFrom !== null && dragFrom !== globalIndex))}
                    isDragging={dragFrom === globalIndex || (dragMulti && dragFrom !== null && sel.isSelected(globalIndex))}
                    isSelected={sel.isSelected(globalIndex)}
                    dim={searching && !run.isHit.has(globalIndex)}
                    isHitNow={searching && hitIndex === globalIndex}
                    marks={searching && titleScope ? run.terms : null}
                    snippet={run.snippets.get(globalIndex) ?? null}
                    cellDraggable={canReorder && blockIndex !== null}
                    onSelect={onSelect}
                    onTick={canReorder && blockIndex !== null ? onTick : undefined}
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
          data-drop-active={(scratchDragging || dragFrom !== null) && dropTarget === END_DROP ? 'true' : undefined}
          aria-hidden
          style={{ position: 'relative', height: '56px', marginTop: '-12px' }}
        >
          {(scratchDragging || dragFrom !== null) && dropTarget === END_DROP && (
            <div style={{ position: 'absolute', left: 0, right: 0, top: '4px', height: '4px', borderRadius: '2px', background: 'var(--oxford)' }} />
          )}
        </div>
      )}
      {canReorder && onCutSlides && onCopySlides && (
        <BatchBar
          count={sel.count}
          rows={menuRows}
          selectedLines={selectedLines()}
          moveOpen={moveOpen}
          onMoveOpenChange={setMoveOpen}
          onClear={() => sel.clear()}
          onMove={(place) => { const refs = selectedRefs(); if (refs.length > 0) { explicitRevealRef.current = true; onMoveSlidesRef.current?.(refs, place) } }}
          onCut={() => { void cutSelected('cut') }}
          onSetAside={onSetAsideSlides ? () => { void asideSelected() } : undefined}
          onHeight={setBarHeight}
          onCopy={copySelected}
          onDelete={() => { void cutSelected('delete') }}
        />
      )}
      <SlideRowMenus
        request={menu}
        rows={menuRows}
        ops={cardMenuOps}
        onClose={() => setMenu(null)}
        onActed={() => containerRef.current?.focus({ preventScroll: true })}
        onLanded={(line) => { explicitRevealRef.current = true; onLanded?.(line) }}
        onSetAside={onSetAsideSlides ? () => { const f = menuForRef.current; const ref = f && 'index' in f ? slideRefOfRef.current?.(f.index) : null; if (ref) void asideSelected([ref]) } : undefined}
        onToggleCollapse={() => { const f = menuForRef.current; if (f && 'group' in f) toggleAt(f.group) }}
        onExplain={onExplain ? () => { const f = menuForRef.current; if (f && 'index' in f) onExplain(f.index) } : undefined}
        onMore={onMoreActions ? () => { const f = menuForRef.current; if (f && 'index' in f && menu) onMoreActions(f.index, { x: menu.x, y: menu.y }) } : undefined}
      />
    </div>
  )
}
