import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { slideRows } from '../extensions/slideOutline'
import type { OutlineOps } from './WorkspaceLayout'

interface Props {
  content: string
  onJump: (line: number) => void
  ops: OutlineOps | null
  /** Source line of the slide the editor cursor is in (item 1: outline follows cursor). The row
   *  containing it is marked + scrolled into view. Distinct from the user's click-selection, and
   *  it never triggers onJump — otherwise the editor and outline would fight each other. */
  currentLine?: number | null
}

export default function SlidesOrganizer({ content, onJump, ops, currentLine }: Props) {
  const rows = useMemo(() => slideRows(content), [content])
  // Heading-is-slide model: a row is a SECTION (collapsible, at ANY depth) when it has a child —
  // i.e. the next row in document order sits at a deeper heading level. Everything else is a leaf
  // slide. This replaces the old `level <= 2` hardcode so nesting collapses uniformly.
  const sectionLines = useMemo(() => {
    const set = new Set<number>()
    for (let k = 0; k < rows.length - 1; k += 1) {
      if (rows[k + 1].level > rows[k].level) set.add(rows[k].line)
    }
    return set
  }, [rows])
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set()) // section heading lines
  const [selectedLine, setSelectedLine] = useState<number | null>(null)
  const [highlightedLine, setHighlightedLine] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const rowRefs = useRef(new Map<number, HTMLElement>())

  // Step 1: Drag-to-reorder state
  const dragLineRef = useRef<number | null>(null)
  const [dragOverLine, setDragOverLine] = useState<number | null>(null)
  // The dragged slide's text + a pending-jump marker, so after a drag the editor follows the slide
  // to its NEW position (not the slot it left). Set on drop, consumed when rows re-derive.
  const draggedTextRef = useRef<string | null>(null)
  const pendingJumpRef = useRef<string | null>(null)

  // Step 2: Keyboard ⌘-arrows (panel-scoped). The arrow-key HIGHLIGHT counts as the target
  // when nothing is click-selected — otherwise a pure-keyboard user could walk the outline
  // but never reorder it (the old gate required a prior mouse click). Acting on a highlight
  // promotes it to the selection (and records its text) so the moved row is re-found after
  // the edit exactly like a clicked one.
  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    function onKey(e: KeyboardEvent): void {
      if (!e.metaKey || !ops) return
      const sel = selectedLine ?? highlightedLine
      if (sel == null) return
      if (selectedLine == null) {
        setSelectedLine(sel)
        const r = rows.find((x) => x.line === sel)
        if (r) selTextRef.current = r.text
      }
      if (e.key === 'ArrowUp') { e.preventDefault(); ops.move(sel, 'up') }
      else if (e.key === 'ArrowDown') { e.preventDefault(); ops.move(sel, 'down') }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); ops.reLevel(sel, -1, e.altKey) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); ops.reLevel(sel, 1, e.altKey) }
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [selectedLine, highlightedLine, rows, ops])

  // Focus the search input when the App-level sidebar command switches to the slide outline.
  useEffect(() => {
    const focus = (): void => {
      requestAnimationFrame(() => { searchRef.current?.focus(); searchRef.current?.select() })
    }
    window.addEventListener('tw-search-slides', focus)
    return () => window.removeEventListener('tw-search-slides', focus)
  }, [])

  // Step 3: Keep selection on the moved node after an edit
  const selTextRef = useRef<string | null>(null)
  // Record the selected row's text whenever selection changes (for re-find after an edit).
  useEffect(() => {
    const r = rows.find((x) => x.line === selectedLine)
    if (r) selTextRef.current = r.text
  }, [selectedLine, rows])
  // After content changes (an op ran), if the selected line no longer matches, re-find by text.
  useEffect(() => {
    if (selectedLine == null || !selTextRef.current) return
    const stillThere = rows.some((x) => x.line === selectedLine && x.text === selTextRef.current)
    if (stillThere) return
    const match = rows.find((x) => x.text === selTextRef.current)
    setSelectedLine(match ? match.line : null)
  }, [rows]) // eslint-disable-line react-hooks/exhaustive-deps

  // After a DRAG, once rows re-derive at the new order, move the editor caret to the dragged slide's
  // NEW position (so focus follows the slide, not the slot it left) and select it in the panel.
  useEffect(() => {
    const t = pendingJumpRef.current
    if (!t) return
    pendingJumpRef.current = null
    const match = rows.find((x) => x.text === t)
    if (match) { setSelectedLine(match.line); onJump(match.line) }
  }, [rows]) // eslint-disable-line react-hooks/exhaustive-deps

  // A row is hidden when an ancestor section is collapsed (everything deeper than the collapsed
  // level, until a row at the same-or-shallower level ends the collapsed run). Works at any depth.
  const hidden = useMemo(() => {
    const set = new Set<number>()
    let collapseAtLevel: number | null = null
    for (const r of rows) {
      if (collapseAtLevel !== null && r.level > collapseAtLevel) { set.add(r.line); continue }
      collapseAtLevel = null
      if (sectionLines.has(r.line) && collapsed.has(r.line)) collapseAtLevel = r.level
    }
    return set
  }, [rows, collapsed, sectionLines])

  function toggle(line: number): void {
    setCollapsed((prev) => { const n = new Set(prev); n.has(line) ? n.delete(line) : n.add(line); return n })
  }
  function select(line: number): void {
    setSelectedLine(line)
    setHighlightedLine(line)
    onJump(line) // single-click selects AND jumps (keeps jump behavior)
  }

  // Search filters the outline by heading text. While a query is active, drag-reorder and
  // section-collapse are suspended (matches render as a flat list) and the matched run is marked.
  // Clearing the box restores the normal tree.
  // The row the editor cursor is currently in: the row with the greatest heading line ≤ currentLine
  // (the slide/section that contains the caret). Marked distinctly and scrolled into view below.
  const currentRowLine = useMemo(() => {
    if (currentLine == null) return null
    let best: number | null = null
    for (const r of rows) if (r.line <= currentLine && (best == null || r.line > best)) best = r.line
    return best
  }, [rows, currentLine])

  // Follow the cursor: scroll the current row into view when it changes. block:'nearest' keeps it
  // gentle (no recentring), and it won't fire while the row is already visible.
  useEffect(() => {
    if (currentRowLine == null) return
    rowRefs.current.get(currentRowLine)?.scrollIntoView({ block: 'nearest' })
  }, [currentRowLine])

  const q = query.trim().toLowerCase()
  const searching = q.length > 0
  const visibleRows = rows.filter((r) => (searching ? r.text.toLowerCase().includes(q) : !hidden.has(r.line)))
  const matchCount = searching ? visibleRows.length : 0
  const renderText = (text: string): ReactNode => {
    if (!searching) return text
    const i = text.toLowerCase().indexOf(q)
    if (i < 0) return text
    return (
      <>
        {text.slice(0, i)}
        <mark className="so-match">{text.slice(i, i + q.length)}</mark>
        {text.slice(i + q.length)}
      </>
    )
  }

  useEffect(() => {
    if (highlightedLine != null && !visibleRows.some((r) => r.line === highlightedLine)) {
      setHighlightedLine(null)
    }
  }, [highlightedLine, visibleRows])

  useEffect(() => {
    if (highlightedLine == null) return
    rowRefs.current.get(highlightedLine)?.scrollIntoView({ block: 'nearest' })
  }, [highlightedLine])

  function moveHighlight(direction: 1 | -1): void {
    if (visibleRows.length === 0) return
    setHighlightedLine((current) => {
      const idx = current == null ? -1 : visibleRows.findIndex((r) => r.line === current)
      const nextIdx = idx < 0
        ? (direction > 0 ? 0 : visibleRows.length - 1)
        : (idx + direction + visibleRows.length) % visibleRows.length
      return visibleRows[nextIdx]?.line ?? null
    })
  }

  function handlePanelKey(e: ReactKeyboardEvent<HTMLElement>): void {
    const modified = e.metaKey || e.ctrlKey || e.altKey || e.shiftKey
    if (!modified && e.key === 'ArrowDown') {
      e.preventDefault()
      moveHighlight(1)
      return
    }
    if (!modified && e.key === 'ArrowUp') {
      e.preventDefault()
      moveHighlight(-1)
      return
    }
    if (!modified && e.key === 'Enter' && highlightedLine != null) {
      e.preventDefault()
      select(highlightedLine)
      return
    }
    // ←/→ on a highlighted SECTION row collapse/expand it — the caret button's keyboard path.
    // Suspended while searching (matches render as a flat list, same as drag).
    if (!modified && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !searching) {
      const line = highlightedLine ?? selectedLine
      if (line != null && sectionLines.has(line)) {
        e.preventDefault()
        const isCollapsed = collapsed.has(line)
        if (e.key === 'ArrowLeft' ? !isCollapsed : isCollapsed) toggle(line)
        return
      }
    }
    if (!modified && e.key === 'Escape') {
      e.preventDefault()
      if (query) {
        setQuery('')
        setHighlightedLine(null)
      } else {
        ;(e.target as HTMLElement).blur()
      }
    }
  }

  if (rows.length === 0) {
    return <div className="pres-nav-empty">{content ? 'No headings yet.' : 'Select a talk to see its slides.'}</div>
  }

  return (
    <div className="slides-organizer" data-slides-organizer ref={panelRef} tabIndex={0} onKeyDown={handlePanelKey}>
      <div className="so-search">
        <input
          ref={searchRef}
          type="search"
          className="so-search-input"
          placeholder="Search slides…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setHighlightedLine(null) }}
          aria-label="Search the slide outline"
        />
      </div>
      {searching && matchCount === 0 && (
        <div className="pres-nav-empty">No slides match “{query.trim()}”.</div>
      )}
      {rows.map((r) => {
        if (searching ? !r.text.toLowerCase().includes(q) : hidden.has(r.line)) return null
        const isSel = selectedLine === r.line
        const isHighlighted = highlightedLine === r.line
        // Indent by heading depth (##/# flush left) so nesting reads as a tree at any level;
        // suspended while searching (matches render as a flat list).
        const indent = searching ? undefined : { paddingLeft: `${Math.max(0, r.level - 2) * 14}px` }
        if (sectionLines.has(r.line)) {
          const isCollapsed = collapsed.has(r.line)
          return (
            <div
              key={r.line}
              ref={(el) => {
                if (el) rowRefs.current.set(r.line, el)
                else rowRefs.current.delete(r.line)
              }}
              className={`so-section ${isSel ? 'so-row--sel' : ''} ${isHighlighted ? 'so-row--kbd' : ''} ${currentRowLine === r.line ? 'so-row--current' : ''} ${dragOverLine === r.line ? 'so-row--dragover' : ''}`}
              style={indent}
              data-line={r.line}
              draggable={!searching}
              onDragStart={(e) => { if (searching) return; dragLineRef.current = r.line; draggedTextRef.current = r.text; e.dataTransfer.effectAllowed = 'move' }}
              onDragOver={(e) => { if (dragLineRef.current && dragLineRef.current !== r.line) { e.preventDefault(); setDragOverLine(r.line) } }}
              onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOverLine((l) => (l === r.line ? null : l)) }}
              onDrop={(e) => {
                e.preventDefault()
                const from = dragLineRef.current
                dragLineRef.current = null
                setDragOverLine(null)
                if (from && from !== r.line && ops) { ops.moveTo(from, r.line); pendingJumpRef.current = draggedTextRef.current }
              }}
              onDragEnd={() => { dragLineRef.current = null; setDragOverLine(null) }}
            >
              {!searching && (
                <button type="button" className="so-caret" onClick={(e) => { e.stopPropagation(); toggle(r.line) }} aria-expanded={!isCollapsed}>
                  {isCollapsed ? '▸' : '▾'}
                </button>
              )}
              <button type="button" className="so-section-label" onClick={() => select(r.line)}>{renderText(r.text)}</button>
            </div>
          )
        }
        return (
          <button
            key={r.line}
            type="button"
            ref={(el) => {
              if (el) rowRefs.current.set(r.line, el)
              else rowRefs.current.delete(r.line)
            }}
            className={`so-slide ${isSel ? 'so-row--sel' : ''} ${isHighlighted ? 'so-row--kbd' : ''} ${currentRowLine === r.line ? 'so-row--current' : ''} ${dragOverLine === r.line ? 'so-row--dragover' : ''}`}
            style={indent}
            data-line={r.line}
            onClick={() => select(r.line)}
            draggable={!searching}
            onDragStart={(e) => { if (searching) return; dragLineRef.current = r.line; draggedTextRef.current = r.text; e.dataTransfer.effectAllowed = 'move' }}
            onDragOver={(e) => { if (dragLineRef.current && dragLineRef.current !== r.line) { e.preventDefault(); setDragOverLine(r.line) } }}
            onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOverLine((l) => (l === r.line ? null : l)) }}
            onDrop={(e) => {
              e.preventDefault()
              const from = dragLineRef.current
              dragLineRef.current = null
              setDragOverLine(null)
              if (from && from !== r.line && ops) { ops.moveTo(from, r.line); pendingJumpRef.current = draggedTextRef.current }
            }}
            onDragEnd={() => { dragLineRef.current = null; setDragOverLine(null) }}
          >
            <span className="so-slide-no">{r.slideNo != null ? String(r.slideNo).padStart(2, '0') : ''}</span>
            <span className="so-slide-title">{renderText(r.text)}</span>
          </button>
        )
      })}
    </div>
  )
}
