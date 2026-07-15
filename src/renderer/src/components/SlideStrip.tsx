import React, { useEffect, useRef, useState } from 'react'
import type { TalkInfo, ProjectionRow } from '../../../preload/index'
import { warningsForSurface, type WarningSurface } from '../../../../compiler/scripts/lib/warning-registry.mjs'

interface Props {
  talk: TalkInfo
  compiledSlides: ProjectionRow[] | null
  outlineContent: string
  thumbnails?: Record<string, string> | null
  activeIndex: number
  onSelectSlide: (index: number) => void
  // Double-click a card: open that slide's source in the editor, focused (single click
  // stays select-only so browsing the strip never steals the keyboard).
  onEdit?: (index: number) => void
  onReorder?: (fromIndex: number, toIndex: number) => void
  // Right-click a card → explain why it rendered this way (ADR-0024). Index = display index.
  onExplain?: (index: number) => void
}

interface SlidePreview {
  // Display position in the strip (includes synthesized title/section/closing slides).
  index: number
  // Position among ONLY the real `### ` outline blocks, or null for synthesized
  // slides the compiler adds (cover title, section dividers, closing). This is the
  // index `window.tw.outline.reorder` expects — the lib moves slides by `### ` block,
  // NOT by strip row, so passing a display index would move the wrong slide. null ⇒
  // not reorderable (no backing heading in the source file).
  blockIndex: number | null
  title: string
  excerpt: string
  layout: string
  role: string
  // High-priority compiler warnings for this slide (already filtered, human-readable).
  warnings: string[]
  row: ProjectionRow | null
}

// Compiler warnings we surface as a slide badge. Most engine warnings are resolution
// HINTS (icon-suggested, icon-gap) that would clutter the strip; only show the ones an
// author needs to act on. `iconlist-no-icons` = an explicit {iconlist}/{iconrow} that
// resolved to NO icons and silently rendered plain.
// Pick the warnings assigned to this surface and render their shared message + remedy.
export function surfacedWarnings(row: ProjectionRow | null, surface: WarningSurface = 'strip-badge'): string[] {
  if (!row || !Array.isArray(row.warnings)) return []
  return warningsForSurface(row.warnings, surface)
}

// Fast client-side parse — used when compiler result is not yet available. Every
// slide here is a real `### ` block, so display index === block index.
function parseSlides(content: string): SlidePreview[] {
  if (!content) return []
  const slides: SlidePreview[] = []
  const lines = content.split('\n')
  let current: { title: string; lines: string[]; layout: string } | null = null

  function push(c: { title: string; lines: string[]; layout: string }) {
    slides.push({
      index: slides.length,
      blockIndex: slides.length,
      title: c.title,
      excerpt: c.lines.slice(0, 3).join(' ').slice(0, 160),
      layout: c.layout,
      role: '',
      warnings: [],
      row: null
    })
  }

  for (const line of lines) {
    if (line.startsWith('### ')) {
      if (current) push(current)
      const title = line.replace(/^### /, '').replace(/\{[^}]*\}/g, '').trim()
      const triggerMatch = line.match(/\{([^}]+)\}/)
      current = { title, lines: [], layout: triggerMatch ? triggerMatch[1].split('|')[0] : '' }
    } else if (current && line.trim() && !line.startsWith('#')) {
      current.lines.push(line.trim())
    }
  }
  if (current) push(current)
  return slides
}

// A projection row is a reorderable outline block iff its source_markdown begins
// with a `### ` heading. Synthesized rows (cover title, section dividers, closing)
// carry empty/non-heading source_markdown and must not be dragged.
function isOutlineBlock(p: ProjectionRow): boolean {
  return /^###\s/.test((p.source_markdown ?? '').trimStart())
}

// Build previews from compiled rows, assigning each real `### ` slide a running
// block index (skipping synthesized rows so the index matches listSlideBlocks).
function compiledToPreviews(rows: ProjectionRow[]): SlidePreview[] {
  let block = 0
  return rows.map((p, i) => {
    const layoutBadge = p.triggers?.layout ?? p.layout ?? ''
    const isBlock = isOutlineBlock(p)
    const preview: SlidePreview = {
      index: i,
      blockIndex: isBlock ? block : null,
      title: p.nav_title || p.title || '(untitled)',
      excerpt: p.text_excerpt ?? '',
      layout: layoutBadge,
      role: p.role ?? '',
      warnings: surfacedWarnings(p),
      row: p
    }
    if (isBlock) block += 1
    return preview
  })
}

// thumbnails are keyed by render_hash (layout + block model) so a layout/trigger change busts the
// cache; content_hash / slide_id are fallbacks for the client-parse path.
function thumbKey(row: ProjectionRow | null): string | null {
  if (!row) return null
  return row.render_hash || row.content_hash || row.slide_id || null
}

// Stable identity for a slide preview, used to re-find a slide after a reorder
// recompiles the strip with a new display order. slide_id survives a pure move;
// content_hash and title are fallbacks for the client-parse path.
function slideIdentity(s: SlidePreview): string {
  return s.row?.slide_id || s.row?.content_hash || `${s.title}#${s.blockIndex ?? s.index}`
}

// A consecutive run of slides sharing the same ProjectionRow.section. The strip
// renders one collapsible header per group so its structure mirrors the talk's
// `## ` heading layout (ADR-0019 sidebar).
interface SectionGroup {
  // Stable key for collapse state + React key. Uses the section string; falls back
  // to a positional key for ungrouped/implicit runs so two empty-section runs stay
  // independently collapsible.
  key: string
  // The raw ProjectionRow.section the run was cut on — used only to detect run breaks.
  rawSection: string
  title: string
  slides: SlidePreview[]
}

// Group previews into CONSECUTIVE runs by section. A new run starts whenever the
// section string changes, so the same section name appearing in two separate places
// yields two groups (matching how the strip reads top-to-bottom). The header title
// prefers the run's own `section-title` row (its nav_title/title) over the raw
// section string; slides with no section at all collapse into one implicit run.
function groupBySection(slides: SlidePreview[]): SectionGroup[] {
  const groups: SectionGroup[] = []
  let runIndex = 0
  for (const slide of slides) {
    const section = slide.row?.section ?? ''
    const prev = groups[groups.length - 1]
    if (!prev || prev.rawSection !== section) {
      runIndex += 1
      groups.push({
        // section string makes the key stable across recompiles; runIndex keeps
        // empty-section runs distinct.
        key: section ? `s:${section}` : `run:${runIndex}`,
        rawSection: section,
        title: section,
        slides: [slide]
      })
    } else {
      prev.slides.push(slide)
    }
  }
  // Resolve each group's display title: a `section-title` row inside the run names
  // the section better than the raw key.
  for (const g of groups) {
    const titleRow = g.slides.find((s) => s.row?.role === 'section-title')
    const fromRow = titleRow?.row?.nav_title || titleRow?.row?.title
    g.title = (fromRow || g.title || 'Untitled section').trim() || 'Untitled section'
  }
  return groups
}

interface ThumbnailProps {
  layout: string
  title: string
  excerpt: string | undefined
}

function ThumbnailContent({ layout, title, excerpt }: ThumbnailProps) {
  if (layout === 'statement') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <p style={{ fontSize: '13px', fontWeight: 700, textAlign: 'center', color: 'var(--ink)', margin: 0, lineHeight: 1.3, maxHeight: '100%', overflow: 'hidden' }}>{title}</p>
      </div>
    )
  }

  if (layout === 'contrast') {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', height: '100%' }}>
        <div style={{ background: 'var(--hover)', borderRadius: '2px', padding: '4px', fontSize: '9px', color: 'var(--muted)', overflow: 'hidden' }}>{title}</div>
        <div style={{ background: 'var(--active)', borderRadius: '2px', padding: '4px', fontSize: '9px', color: 'var(--muted)', overflow: 'hidden' }}>{excerpt?.slice(0, 40)}</div>
      </div>
    )
  }

  if (layout === 'cards') {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <p style={{ fontSize: '9px', fontWeight: 600, margin: '0 0 2px', color: 'var(--ink)' }}>{title}</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px', flex: 1 }}>
          {[0, 1, 2, 3].map(i => <div key={i} style={{ background: 'var(--hover)', borderRadius: '2px' }}></div>)}
        </div>
      </div>
    )
  }

  if (layout === 'list') {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '3px' }}>
        <p style={{ fontSize: '9px', fontWeight: 600, margin: '0 0 2px', color: 'var(--ink)' }}>{title}</p>
        {[80, 65, 75, 55].map((w, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <div style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--oxford)', flexShrink: 0 }}></div>
            <div style={{ height: '1.5px', background: 'var(--line)', width: w + '%', borderRadius: '1px' }}></div>
          </div>
        ))}
      </div>
    )
  }

  if (layout === 'quote') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '3px' }}>
        <span style={{ fontSize: '18px', color: 'var(--oxford)', opacity: 0.3, lineHeight: 1, fontFamily: 'Georgia,serif' }}>&ldquo;</span>
        <p style={{ fontSize: '9px', fontStyle: 'italic', textAlign: 'center', color: 'var(--ink)', margin: 0, lineHeight: 1.3 }}>{excerpt?.slice(0, 60)}</p>
        <div style={{ height: '1px', background: 'var(--line)', width: '40%', marginTop: '2px' }}></div>
      </div>
    )
  }

  if (layout === 'code') {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '3px' }}>
        <p style={{ fontSize: '9px', fontWeight: 600, margin: '0 0 2px', color: 'var(--ink)' }}>{title}</p>
        <div style={{ background: '#1e1e2e', borderRadius: '2px', flex: 1, padding: '4px', overflow: 'hidden' }}>
          <div style={{ fontSize: '7px', color: '#89b4fa', fontFamily: 'monospace', lineHeight: 1.5, opacity: 0.9 }}>
            <div><span style={{ color: '#cba6f7' }}>fn</span> main() {'{'}</div>
            <div style={{ color: '#a6e3a1' }}>&nbsp;&nbsp;// code</div>
            <div>{'}'}</div>
          </div>
        </div>
      </div>
    )
  }

  if (layout === 'timeline') {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '3px' }}>
        <p style={{ fontSize: '9px', fontWeight: 600, margin: '0 0 4px', color: 'var(--ink)' }}>{title}</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flex: 1, alignContent: 'center', flexWrap: 'wrap' as const }}>
          {[0, 1, 2].map(i => (
            <React.Fragment key={i}>
              <div style={{ width: '12px', height: '12px', borderRadius: '50%', border: '2px solid var(--oxford)', background: 'var(--paper)', flexShrink: 0 }}></div>
              {i < 2 && <div style={{ height: '2px', background: 'var(--line)', flex: 1 }}></div>}
            </React.Fragment>
          ))}
        </div>
      </div>
    )
  }

  if (layout === 'big-number') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <span style={{ fontSize: '36px', fontWeight: 900, color: 'var(--oxford)', lineHeight: 1, opacity: 0.5 }}>42</span>
        <p style={{ fontSize: '9px', textAlign: 'center', color: 'var(--muted)', margin: '4px 0 0' }}>{title}</p>
      </div>
    )
  }

  if (layout.includes('image')) {
    return (
      <div style={{ height: '100%', background: 'linear-gradient(135deg,#d9d0c1,#c0b8a8)', display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-start', padding: '6px' }}>
        <p style={{ fontSize: '9px', color: 'rgba(23,32,42,0.8)', margin: 0, fontWeight: 500 }}>{title}</p>
      </div>
    )
  }

  if (layout === 'title') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '6px', padding: '4px' }}>
        <p style={{ fontSize: '12px', fontWeight: 700, textAlign: 'center', color: 'var(--ink)', margin: 0, lineHeight: 1.2 }}>{title}</p>
        <p style={{ fontSize: '9px', textAlign: 'center', color: 'var(--muted)', margin: 0 }}>{excerpt?.slice(0, 50)}</p>
      </div>
    )
  }

  if (layout === 'section-title') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '6px' }}>
        <div style={{ height: '1px', background: 'var(--line)', width: '80%' }}></div>
        <p style={{ fontSize: '11px', fontWeight: 600, textAlign: 'center', color: 'var(--oxford)', margin: 0 }}>{title}</p>
        <div style={{ height: '1px', background: 'var(--line)', width: '80%' }}></div>
      </div>
    )
  }

  // default
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <p style={{ fontSize: '10px', fontWeight: 600, margin: '0 0 3px', color: 'var(--ink)', lineHeight: 1.3 }}>{title}</p>
      {excerpt && <p style={{ fontSize: '8px', color: 'var(--muted)', margin: 0, lineHeight: 1.4, overflow: 'hidden' }}>{excerpt.slice(0, 80)}</p>}
    </div>
  )
}

// Memoized on data props ONLY (custom compare below skips the function props): the
// handlers are fresh closures every render, but each one reaches mutable state through
// refs or through `slide` itself — and any change to the slide set produces new slide
// objects, which fails the `slide` identity check and re-renders with fresh closures.
// This keeps a keystroke (which re-renders the strip with identical data) from
// reconciling every card.
// null = no indicator; 'above' = insert before this card (drag-up);
// 'below' = insert after this card (drag-down). Mirrors the main-process
// `position = toIndex > fromIndex ? 'after' : 'before'` contract so the line the
// author sees matches where the block actually lands.
type DropEdge = 'above' | 'below' | null

interface SlideCardProps {
  slide: SlidePreview
  isActive: boolean
  isDragging: boolean
  thumbnailUrl: string | null
  draggable: boolean
  dropEdge: DropEdge
  onClick: () => void
  onDoubleClick?: () => void
  onDragStart: (e: React.DragEvent) => void
  onDragEnter: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}

function SlideCard({
  slide,
  isActive,
  isDragging,
  thumbnailUrl,
  draggable,
  dropEdge,
  onClick,
  onDoubleClick,
  onDragStart,
  onDragEnter,
  onDragOver,
  onDrop,
  onDragEnd,
  onContextMenu
}: SlideCardProps) {
  const layout = slide.layout.toLowerCase() || 'default'
  const title = slide.title || 'Slide'
  const excerpt = slide.excerpt || undefined
  const warnings = slide.warnings

  // Insertion bar that floats over the card's top or bottom edge. Sits in the
  // 4px margin gutter so it never shifts layout (no reflow → no flicker).
  const dropBar = (where: 'above' | 'below') => (
    <div
      data-testid="slide-drop-indicator"
      style={{
        position: 'absolute' as const,
        left: 0,
        right: 0,
        [where === 'above' ? 'top' : 'bottom']: '-3px',
        height: '3px',
        borderRadius: '2px',
        background: 'var(--oxford)',
        boxShadow: '0 0 0 1px var(--paper), 0 0 5px rgba(11,58,107,0.6)',
        pointerEvents: 'none' as const,
        zIndex: 2
      }}
    />
  )

  return (
    <div
      className="tw-slide-card"
      data-slide-index={slide.index}
      data-block-index={slide.blockIndex ?? ''}
      data-active={isActive ? 'true' : 'false'}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragEnter={draggable ? onDragEnter : undefined}
      onDragOver={draggable ? onDragOver : undefined}
      onDrop={draggable ? onDrop : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
      style={{
        position: 'relative' as const,
        margin: '4px 8px',
        border: `1px solid ${isActive ? 'var(--oxford)' : 'var(--line)'}`,
        borderRadius: '4px',
        background: 'var(--paper)',
        cursor: draggable ? 'grab' : 'pointer',
        boxShadow: isActive ? '0 0 0 2px rgba(11,58,107,0.2)' : 'none',
        opacity: isDragging ? 0.4 : 1,
        overflow: 'visible' as const,
        userSelect: 'none' as const
      }}
    >
      {dropEdge === 'above' && dropBar('above')}
      {dropEdge === 'below' && dropBar('below')}
      {/* 16:9 thumbnail */}
      <div style={{ position: 'relative' as const, paddingTop: '56.25%', background: 'var(--paper)' }}>
        {warnings.length > 0 && (
          <span
            className="tw-slide-warning"
            data-slide-warning
            title={warnings.join('\n')}
            style={{
              position: 'absolute' as const,
              top: '3px',
              right: '3px',
              zIndex: 3,
              fontSize: '8px',
              fontWeight: 700,
              lineHeight: 1,
              color: '#fff',
              background: '#d97706',
              borderRadius: '3px',
              padding: '2px 4px',
              boxShadow: '0 0 0 1px var(--paper)',
              pointerEvents: 'auto' as const,
              cursor: 'help'
            }}
          >
            ⚠ {warnings.length}
          </span>
        )}
        {thumbnailUrl ? (
          <div style={{ position: 'absolute' as const, inset: 0, overflow: 'hidden' }}>
            <img src={thumbnailUrl} style={{ width: '100%', display: 'block', borderRadius: '2px' }} alt={title} />
          </div>
        ) : (
          <div style={{ position: 'absolute' as const, inset: 0, padding: '8px', overflow: 'hidden' }}>
            <ThumbnailContent layout={layout} title={title} excerpt={excerpt} />
          </div>
        )}
      </div>
      {/* Caption below thumbnail */}
      <div style={{ padding: '4px 6px', borderTop: '1px solid var(--line)', display: 'flex', gap: '6px', alignItems: 'center' }}>
        <span style={{ fontSize: '9px', color: 'var(--faint)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>{String(slide.index + 1).padStart(2, '0')}</span>
        <span style={{ fontSize: '10px', color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{title}</span>
        {layout !== 'default' && (
          <span style={{ fontSize: '8px', color: 'var(--oxford)', background: 'rgba(11,58,107,0.1)', borderRadius: '2px', padding: '1px 3px', flexShrink: 0, marginLeft: 'auto' }}>{layout}</span>
        )}
      </div>
    </div>
  )
}

const MemoSlideCard = React.memo(
  SlideCard,
  (prev, next) =>
    prev.slide === next.slide &&
    prev.isActive === next.isActive &&
    prev.isDragging === next.isDragging &&
    prev.thumbnailUrl === next.thumbnailUrl &&
    prev.draggable === next.draggable &&
    prev.dropEdge === next.dropEdge
)

interface SectionHeaderProps {
  title: string
  count: number
  collapsed: boolean
  onToggle: () => void
}

// Collapsible run header. Exposed to the e2e harness via `.strip-section-header` +
// `data-section-header`; the ▾/▸ control is a real <button> so keyboard/click both
// toggle. When collapsed it reads "Title (N)" so the count is visible without the cards.
function SectionHeader({ title, count, collapsed, onToggle }: SectionHeaderProps) {
  return (
    <div
      className="strip-section-header"
      data-section-header
      onClick={onToggle}
      style={{
        position: 'sticky' as const,
        top: 0,
        zIndex: 1,
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '5px 8px 4px',
        margin: '2px 0',
        background: 'var(--panel)',
        borderBottom: '1px solid var(--line)',
        cursor: 'pointer',
        userSelect: 'none' as const
      }}
    >
      <button
        type="button"
        className="strip-section-toggle"
        aria-expanded={!collapsed}
        title={collapsed ? 'Expand section' : 'Collapse section'}
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
        style={{
          all: 'unset' as const,
          cursor: 'pointer',
          fontSize: '10px',
          color: 'var(--muted)',
          width: '12px',
          textAlign: 'center' as const,
          flexShrink: 0
        }}
      >
        {collapsed ? '▸' : '▾'}
      </button>
      <span
        style={{
          fontSize: '10px',
          fontWeight: 700,
          color: 'var(--ink)',
          letterSpacing: '0.02em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap' as const,
          flex: 1
        }}
      >
        {collapsed ? `${title} (${count})` : title}
      </span>
      {!collapsed && (
        <span style={{ fontSize: '9px', color: 'var(--faint)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
          {count}
        </span>
      )}
    </div>
  )
}

export default function SlideStrip({
  talk,
  compiledSlides,
  outlineContent,
  thumbnails,
  activeIndex,
  onSelectSlide,
  onEdit,
  onReorder,
  onExplain
}: Props) {
  const [slides, setSlides] = useState<SlidePreview[]>([])
  const [usingCompiler, setUsingCompiler] = useState(false)
  // Drag state lives in BOTH state (drives the visual indicator on re-render) and
  // a ref (the synchronous drop handler must read the live value, not a stale
  // closure capture from the render that bound the handler).
  // dragFromIndex is the DISPLAY index of the source card (drives source styling +
  // drop-edge direction). dragFromBlockRef is its OUTLINE-BLOCK index — the value
  // onReorder needs. Both held as refs too so the synchronous drop handler reads
  // live values, not a stale render closure.
  const [dragFromIndex, setDragFromIndex] = useState<number | null>(null)
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null)
  // Section keys the author has collapsed. Default = all expanded. Persists across
  // recompiles because the key is the section string (a pure reorder keeps it stable).
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set())

  function toggleSection(key: string) {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const dragFromRef = useRef<number | null>(null)
  const dragFromBlockRef = useRef<number | null>(null)
  // The slide this component just moved, awaiting the recompiled strip so we can
  // re-assert selection on its NEW row. The parent's editor↔strip cursor sync
  // resets activeIndex to the top on editor remount; re-selecting by identity once
  // the new order lands makes activeIndex deterministically follow the move.
  // `fromDisplay` is the slide's display index BEFORE the move — we only consume the
  // pending move once the recompiled slides show it at a DIFFERENT index, so a
  // pre-reorder render (same order) cannot trigger a premature, wrong re-select.
  const pendingMoveRef = useRef<{ id: string; fromDisplay: number } | null>(null)

  const listRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<Array<HTMLDivElement | null>>([])

  const canReorder = !!onReorder

  // Latest-refs for the parent callbacks. MemoSlideCard deliberately keeps old handler
  // closures across skipped re-renders, so handlers must never call a captured (possibly
  // stale) parent callback directly — a stale onReorder would rewrite the outline from
  // an old snapshot. These refs always point at the current render's props.
  const onSelectSlideRef = useRef(onSelectSlide)
  const onEditRef = useRef(onEdit)
  const onReorderRef = useRef(onReorder)
  const onExplainRef = useRef(onExplain)
  onSelectSlideRef.current = onSelectSlide
  onEditRef.current = onEdit
  onReorderRef.current = onReorder
  onExplainRef.current = onExplain

  function resetDrag() {
    dragFromRef.current = null
    dragFromBlockRef.current = null
    setDragFromIndex(null)
    setDropTargetIndex(null)
  }

  // The strip is a controlled view of `slides`; after a reorder the parent rewrites
  // the outline and the new order arrives as fresh props. If a drag is still flagged
  // when the slide set changes underneath us, clear it so a stale source/target index
  // can never paint an indicator on the wrong card.
  useEffect(() => {
    resetDrag()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slides.length])

  // After a reorder WE initiated recompiles the strip, re-select the moved slide on
  // its new row so activeIndex follows the move (wins over the cursor-sync reset).
  useEffect(() => {
    const pending = pendingMoveRef.current
    if (!pending || slides.length === 0) return
    const moved = slides.find((s) => slideIdentity(s) === pending.id)
    // Wait for the RECOMPILED order: the moved slide must sit at a new display index.
    if (!moved || moved.index === pending.fromDisplay) return
    pendingMoveRef.current = null
    if (moved.index !== activeIndex) onSelectSlide(moved.index)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slides])

  // Once a compile result exists, previews derive from it alone — the raw outline text
  // must NOT be a dependency, or every keystroke rebuilds all ~N preview objects and
  // re-renders every card during the 900ms compile debounce. The client-side parse is
  // only the pre-first-compile fallback, so it alone tracks keystrokes.
  const fallbackContent = compiledSlides ? null : outlineContent
  useEffect(() => {
    if (compiledSlides) {
      setSlides(compiledToPreviews(compiledSlides))
      setUsingCompiler(true)
    } else {
      setSlides(parseSlides(fallbackContent ?? ''))
      setUsingCompiler(false)
    }
  }, [compiledSlides, fallbackContent])

  // Scroll the active card to the TOP of the strip when activeIndex changes, so the slide
  // you're editing sits at the top of the sidebar (requested) rather than just "nearest".
  useEffect(() => {
    const node = cardRefs.current[activeIndex]
    if (node) node.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [activeIndex, slides.length])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (slides.length === 0) return
    const last = slides.length - 1
    // Arrow/Home/End land on VISIBLE cards only: cards inside a collapsed section have no DOM
    // node, so selecting them gave zero visual feedback (no highlight, no scroll) and the strip
    // read as dead until enough presses escaped the section.
    const hidden = new Set<number>()
    for (const g of groupBySection(slides)) {
      if (collapsedSections.has(g.key)) for (const s of g.slides) hidden.add(s.index)
    }
    const step = (from: number, dir: 1 | -1): number => {
      let i = from + dir
      while (i >= 0 && i <= last && hidden.has(i)) i += dir
      return i < 0 || i > last ? from : i
    }
    const edge = (start: number, dir: 1 | -1): number => {
      let i = start
      while (i >= 0 && i <= last && hidden.has(i)) i += dir
      return i < 0 || i > last ? activeIndex : i
    }
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        e.preventDefault()
        onSelectSlide(step(activeIndex, 1))
        break
      case 'ArrowUp':
      case 'ArrowLeft':
        e.preventDefault()
        onSelectSlide(step(activeIndex, -1))
        break
      case 'Home':
        e.preventDefault()
        onSelectSlide(edge(0, 1))
        break
      case 'End':
        e.preventDefault()
        onSelectSlide(edge(last, -1))
        break
      case 'Enter':
        // Open the active slide's source in the editor, focused (same act as double-click).
        // Not when a section-toggle button is focused — Enter there means collapse/expand.
        if (e.target instanceof HTMLElement && e.target.tagName === 'BUTTON') break
        e.preventDefault()
        onEditRef.current?.(activeIndex)
        break
    }
  }

  if (slides.length === 0) {
    return (
      <div
        style={{
          background: 'var(--panel)',
          borderLeft: '1px solid var(--line)',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '16px',
          gap: '8px'
        }}
      >
        <p style={{ fontSize: '12px', color: 'var(--muted)', margin: 0, textAlign: 'center' }}>No slides found.</p>
        <p style={{ fontSize: '10px', color: 'var(--faint)', margin: 0, textAlign: 'center' }}>
          Use <code style={{ fontFamily: 'var(--font-mono)' }}>### Slide title</code> to create slides.
        </p>
      </div>
    )
  }

  // Slides grouped into consecutive section runs, each with its own collapsible header
  // so the strip mirrors the talk's heading structure (ADR-0019 sidebar).
  const groups = groupBySection(slides)

  // Render one card. Kept as a closure (not a child component) so it captures the live
  // drag refs/state and handlers unchanged from the pre-grouping flat list — every
  // index it uses is the GLOBAL display index (slide.index), so reorder/active/keyboard
  // behaviour is identical whether or not sections are collapsed.
  function renderCard(slide: SlidePreview) {
    const key = thumbKey(slide.row)
    const thumbnailUrl = key && thumbnails ? thumbnails[key] ?? null : null
    // Carousel sub-slides (ADR-0022): a #### / {carousel} slide captures one full-bleed
    // thumbnail per stepped sub-slide, keyed `${key}__N`. Static multi-part layouts (columns,
    // contrast, image-grid, cards-grid, gallery) emit no `__N` keys, so they show no sub-cards.
    const subUrls: string[] = []
    if (key && thumbnails) {
      let si = 0
      while (thumbnails[`${key}__${si}`]) {
        subUrls.push(thumbnails[`${key}__${si}`])
        si += 1
      }
    }
    // Only real `### ` blocks participate in reorder; synthesized slides
    // (cover/section/closing) have no outline block to move.
    const isBlock = slide.blockIndex !== null
    const cardDraggable = canReorder && isBlock
    const isValidTarget = isBlock && dragFromIndex !== null && dragFromIndex !== slide.index
    const isHoverTarget = isValidTarget && dropTargetIndex === slide.index
    // Direction-aware insertion line, matching the writeback contract: dragging
    // DOWN lands the block AFTER the hovered card (bar below); dragging UP lands
    // it BEFORE (bar above).
    let dropEdge: DropEdge = null
    if (isHoverTarget && dragFromIndex !== null) {
      dropEdge = slide.index > dragFromIndex ? 'below' : 'above'
    }
    return (
      <React.Fragment key={slide.index}>
      <div ref={(el) => { cardRefs.current[slide.index] = el }}>
        <MemoSlideCard
          slide={slide}
          isActive={activeIndex === slide.index}
          isDragging={dragFromIndex === slide.index}
          thumbnailUrl={thumbnailUrl}
          draggable={cardDraggable}
          dropEdge={dropEdge}
          onClick={() => onSelectSlideRef.current(slide.index)}
          onDoubleClick={onEdit ? () => onEditRef.current?.(slide.index) : undefined}
          onContextMenu={onExplain ? (e) => { e.preventDefault(); onExplainRef.current?.(slide.index) } : undefined}
          onDragStart={(e) => {
            dragFromRef.current = slide.index
            dragFromBlockRef.current = slide.blockIndex
            setDragFromIndex(slide.index)
            setDropTargetIndex(slide.index)
            // Firefox requires data on the transfer for the drag to start at
            // all; move effect drives the cursor affordance.
            if (e.dataTransfer) {
              e.dataTransfer.effectAllowed = 'move'
              try { e.dataTransfer.setData('text/plain', String(slide.index)) } catch { /* ignore */ }
            }
          }}
          onDragEnter={() => {
            if (dragFromRef.current !== null && isBlock) setDropTargetIndex(slide.index)
          }}
          onDragOver={(e) => {
            // Only a real block is a valid drop target. preventDefault is
            // REQUIRED on dragover or the drop event never fires.
            if (dragFromRef.current === null || !isBlock) return
            e.preventDefault()
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
            if (dropTargetIndex !== slide.index) setDropTargetIndex(slide.index)
          }}
          onDrop={(e) => {
            e.preventDefault()
            const fromBlock = dragFromBlockRef.current
            const fromDisplay = dragFromRef.current
            const toBlock = slide.blockIndex
            const toDisplay = slide.index
            // Capture the moved slide's identity (by its source display index)
            // BEFORE resetDrag clears the drag refs.
            const movedSlide = fromDisplay !== null ? slides[fromDisplay] : undefined
            resetDrag()
            if (fromBlock !== null && toBlock !== null && fromBlock !== toBlock) {
              // onReorder takes OUTLINE-BLOCK indices (what the lib moves by).
              onReorderRef.current?.(fromBlock, toBlock)
              // activeIndex must follow the moved card. Optimistically select the
              // target slot (the block lands there in both directions); then the
              // pending-move effect re-asserts by identity after the recompile so
              // the parent's cursor-sync reset cannot win the race.
              if (movedSlide && fromDisplay !== null) {
                pendingMoveRef.current = { id: slideIdentity(movedSlide), fromDisplay }
              }
              onSelectSlideRef.current(toDisplay)
            }
          }}
          onDragEnd={resetDrag}
        />
      </div>
      {/* Carousel sub-slides: each stepped full-bleed sub-slide of a carousel, nested under it. */}
      {subUrls.map((u, i) => (
        <div
          key={`sub-${slide.index}-${i}`}
          className="tw-subslide-card"
          data-subslide
          title={`${slide.title} — step ${i + 1}`}
          onClick={() => onSelectSlide(slide.index)}
          style={{
            margin: '2px 8px 2px 24px',
            border: '1px dashed var(--line)',
            borderRadius: '4px',
            background: 'var(--panel)',
            cursor: 'pointer',
            overflow: 'hidden',
            userSelect: 'none' as const
          }}
        >
          <div style={{ position: 'relative' as const, paddingTop: '56.25%', background: 'var(--paper)' }}>
            <div style={{ position: 'absolute' as const, inset: 0, overflow: 'hidden' }}>
              <img src={u} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
            </div>
          </div>
          <div style={{ padding: '3px 6px', borderTop: '1px dashed var(--line)', display: 'flex', gap: '6px', alignItems: 'center' }}>
            <span style={{ fontSize: '9px', color: 'var(--oxford)', fontFamily: 'var(--font-mono)' }}>↳ {slide.index + 1}.{i + 1}</span>
            <span style={{ fontSize: '9px', color: 'var(--muted)' }}>step</span>
          </div>
        </div>
      ))}
      </React.Fragment>
    )
  }

  return (
    <div
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{
        background: 'var(--panel)',
        borderLeft: '1px solid var(--line)',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        outline: 'none'
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '6px 8px 4px',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          borderBottom: '1px solid var(--line)',
          flexShrink: 0
        }}
      >
        <span style={{ fontSize: '9px', fontWeight: 600, color: 'var(--muted)', letterSpacing: '0.06em', fontFamily: 'var(--font-mono)' }}>
          {slides.length} SLIDES
        </span>
        {usingCompiler && (
          <span
            title="Compiler output"
            style={{
              fontSize: '9px',
              color: 'var(--oxford)',
              background: 'rgba(11,58,107,0.1)',
              borderRadius: '2px',
              padding: '1px 4px',
              fontFamily: 'var(--font-mono)'
            }}
          >
            ✓
          </span>
        )}
      </div>
      {/* Scrollable slide list */}
      <div
        ref={listRef}
        style={{ overflowY: 'auto', flex: 1, paddingBottom: '8px' }}
        onDragLeave={(e) => {
          // Only clear the target when the pointer leaves the whole list, not when
          // it crosses between two cards inside it.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDropTargetIndex(null)
          }
        }}
      >
        {groups.map((group) => {
          const collapsed = collapsedSections.has(group.key)
          return (
            <div key={group.key} className="strip-section" data-section-key={group.key}>
              <SectionHeader
                title={group.title}
                count={group.slides.length}
                collapsed={collapsed}
                onToggle={() => toggleSection(group.key)}
              />
              {/* Collapsed runs keep the header but drop their cards from the DOM, so
                  the global slide index (data-slide-index) stays correct on the cards
                  that remain. */}
              {!collapsed && group.slides.map((slide) => renderCard(slide))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
