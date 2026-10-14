import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { slideRows, talkTitleLine } from '../extensions/slideOutline'
import { startDragAutoScroll } from '../lib/dragAutoScroll'
import { hiddenLines, hidingSectionLine, keyRows, slideCount } from '../lib/outlineCollapse'
import {
  collapseAllSections, expandAllSections, publishOutline, revealLine, setSectionCollapsed, toggleSection,
  toggleSectionTree, useOutlineCollapse
} from '../lib/outlineCollapseStore'
import { IcCollapse, IcExpand } from './talklist/icons'
import { releaseSelectionOutside, setOutlineSelection } from '../lib/outlineSelection'
import { rowAfterEdit } from '../lib/activeOutlineLine'
import { getStripNumbers, outlineNumbers, subscribeStripNumbers } from '../lib/stripNumbers'
import SlideRowMenus, { type SlideMenuRequest } from './SlideRowMenus'
import type { OutlineOps } from './WorkspaceLayout'

interface Props {
  content: string
  onJump: (line: number) => void
  ops: OutlineOps | null
  /** Source line of the slide the editor cursor is in (item 1: outline follows cursor). The row
   *  containing it is marked + scrolled into view. Distinct from the user's click-selection, and
   *  it never triggers onJump — otherwise the editor and outline would fight each other. */
  currentLine?: number | null
  /** The open talk's outline path: the key its collapse state is kept and remembered under. Without
   *  one the state lasts only as long as the app is open. */
  talkKey?: string | null
}

// Where a dragged row would land: before the row at `line`, inside the collapsed section at `line`
// (as its last slide), or at the end of the talk.
type DropTarget = { kind: 'before' | 'into'; line: number } | { kind: 'end' }
/** How long a drag must rest on a collapsed section row before the section opens (ms). */
export const DRAG_EXPAND_DELAY_MS = 700

export default function SlidesOrganizer({ content, onJump, ops, currentLine, talkKey }: Props) {
  const rows = useMemo(() => slideRows(content), [content])
  const tk = talkKey ?? ''
  // Which sections are collapsed lives in the per-talk store (outlineCollapseStore.ts), by section
  // identity rather than line number, so it survives edits, moves, this panel unmounting, and the
  // grid shares it. `keyed` is this panel's own reading of the text it is showing.
  const snap = useOutlineCollapse(tk)
  const collapsed = snap.collapsed
  const keyed = useMemo(() => keyRows(rows), [rows])
  const keyByLine = useMemo(() => new Map(keyed.map((r) => [r.line, r.key])), [keyed])
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
  const [selectedLine, setSelectedLine] = useState<number | null>(null)
  const [highlightedLine, setHighlightedLine] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const rowRefs = useRef(new Map<number, HTMLElement>())

  // Step 1: Drag-to-reorder state. The row under the pointer is held as a line (or 'end'); whether
  // a drop there goes BEFORE the row or INTO it is worked out from the live collapse state, so the
  // indicator and the drop agree even after the section under a resting pointer has opened.
  const dragLineRef = useRef<number | null>(null)
  const dragLevelRef = useRef(0)
  const [dropAt, setDropAt] = useState<number | 'end' | null>(null)
  const stopAutoScrollRef = useRef<(() => void) | null>(null)
  // The dragged slide's text + a pending-jump marker, so after a drag the editor follows the slide
  // to its NEW position (not the slot it left). Set on drop, consumed when rows re-derive.
  const draggedTextRef = useRef<string | null>(null)
  const pendingJumpRef = useRef<string | null>(null)
  // Sections a resting drag opened (they return to collapsed when the drag ends unless the slide
  // was dropped inside), and the moment until which a keyboard move should reveal its result.
  const sprungRef = useRef(new Set<string>())
  const revealMovedUntilRef = useRef(0)
  // The row menu (right-click, the Menu key) and its Move … to… list; the line a paste or a move
  // landed on, selected and revealed once the rows show it.
  const [menu, setMenu] = useState<SlideMenuRequest | null>(null)
  const landedLineRef = useRef<number | null>(null)
  const slideOps = ops?.slides ?? null

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
      // A move done from here reveals the slide where it lands (see the re-find effect below).
      const wasArrow = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)
      if (wasArrow) revealMovedUntilRef.current = Date.now() + 1500
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
  // Only when the SELECTION changes. (It used to run on every change of the rows as well, and so
  // took the title of whatever row had come to sit on the selected line number before the re-find
  // below could look for the selected slide: when a slide of the same length moved past it, the
  // selection passed to another slide without a word.)
  useEffect(() => {
    const r = rows.find((x) => x.line === selectedLine)
    if (r) selTextRef.current = r.text
  }, [selectedLine]) // eslint-disable-line react-hooks/exhaustive-deps
  const rowCountRef = useRef(rows.length)
  // After content changes (an op ran), if the selected line no longer matches, re-find by text.
  useEffect(() => {
    const sameCount = rowCountRef.current === rows.length
    if (selectedLine == null || !selTextRef.current) return
    const next = rowAfterEdit(rows, selectedLine, selTextRef.current, sameCount)
    selTextRef.current = next == null ? selTextRef.current : rows.find((x) => x.line === next)?.text ?? selTextRef.current
    if (next === selectedLine) return
    setSelectedLine(next)
    // The slide moved from here: open the sections it landed in so it can be seen.
    if (next != null && Date.now() < revealMovedUntilRef.current) {
      revealMovedUntilRef.current = 0
      revealLine(tk, next, content)
    }
  }, [rows]) // eslint-disable-line react-hooks/exhaustive-deps

  // The keyboard highlight is a line number too. After an edit that line is another row's: follow
  // the row it was on (by its text, as the selection does), or drop the highlight when that row is
  // gone, so a row the person never chose is not drawn as chosen. Declared before the two effects
  // below, whose own choice of row wins.
  const hlTextRef = useRef<string | null>(null)
  useEffect(() => {
    hlTextRef.current = highlightedLine == null ? null : rows.find((x) => x.line === highlightedLine)?.text ?? null
  }, [highlightedLine]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const sameCount = rowCountRef.current === rows.length
    rowCountRef.current = rows.length
    if (highlightedLine == null) return
    const next = rowAfterEdit(rows, highlightedLine, hlTextRef.current, sameCount)
    hlTextRef.current = next == null ? null : rows.find((x) => x.line === next)?.text ?? null
    if (next !== highlightedLine) setHighlightedLine(next)
  }, [rows]) // eslint-disable-line react-hooks/exhaustive-deps

  // After a DRAG, once rows re-derive at the new order, move the editor caret to the dragged slide's
  // NEW position (so focus follows the slide, not the slot it left) and select it in the panel.
  useEffect(() => {
    const t = pendingJumpRef.current
    if (!t) return
    pendingJumpRef.current = null
    const match = rows.find((x) => x.text === t)
    if (match) {
      setSelectedLine(match.line)
      // A highlight left on another row would be a second marked row: it goes with the dragged slide.
      setHighlightedLine((was) => (was == null ? was : match.line))
      revealLine(tk, match.line, content)
      onJump(match.line)
    }
  }, [rows]) // eslint-disable-line react-hooks/exhaustive-deps

  // After a paste or a "Move … to…" (the op answers with the heading's new line): once the rows show
  // it, select it, open the sections around it, scroll to it and take the editor there, as a drag does.
  useEffect(() => {
    const line = landedLineRef.current
    if (line == null) return
    const row = rows.find((x) => x.line === line)
    if (!row) return
    landedLineRef.current = null
    selTextRef.current = row.text
    setSelectedLine(line)
    setHighlightedLine(line)
    revealLine(tk, line, content)
    onJump(line)
  }, [rows]) // eslint-disable-line react-hooks/exhaustive-deps
  const landed = (line: number): void => { landedLineRef.current = line }
  const afterCut = (): void => { selTextRef.current = null; setSelectedLine(null); setHighlightedLine(null) }

  // The row a command from the palette acts on when this panel has the keyboard (lib/outlineSelection.ts).
  useEffect(() => { setOutlineSelection(selectedLine ?? highlightedLine) }, [selectedLine, highlightedLine])
  useEffect(() => () => setOutlineSelection(null), [])

  // A row is hidden when an ancestor section is collapsed (everything deeper than the collapsed
  // level, until a row at the same-or-shallower level ends the collapsed run). Works at any depth.
  const hidden = useMemo(() => hiddenLines(keyed, collapsed), [keyed, collapsed])

  function toggle(line: number, wholeTree = false): void {
    const key = keyByLine.get(line)
    if (!key) return
    publishOutline(tk, content)
    if (wholeTree) toggleSectionTree(tk, key)
    else toggleSection(tk, key)
  }
  // A drag resting on a collapsed section row opens it after a moment, so the slide can be placed
  // among its slides. (dropAt is declared with the drag state above.)
  const restingOnCollapsed = typeof dropAt === 'number' && sectionLines.has(dropAt) && collapsed.has(keyByLine.get(dropAt) ?? '') ? dropAt : null
  useEffect(() => {
    if (restingOnCollapsed == null) return
    const key = keyByLine.get(restingOnCollapsed)
    if (!key) return
    const timer = setTimeout(() => {
      sprungRef.current.add(key)
      setSectionCollapsed(tk, key, false)
    }, DRAG_EXPAND_DELAY_MS)
    return () => clearTimeout(timer)
  }, [restingOnCollapsed]) // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving the Slides tab mid-drag must not leave the scroll loop running.
  useEffect(() => () => { stopAutoScrollRef.current?.() }, [])

  function select(line: number): void {
    // Choosing a search result shows it in its tree: the sections around it open and it is scrolled to.
    if (searching) revealLine(tk, line, content)
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

  const q = query.trim().toLowerCase()
  const searching = q.length > 0

  // Typing in a slide inside a collapsed section does not open it. The row that stands for the caret
  // is then the collapsed section that hides it (outermost), so the marker and the scroll still show
  // where the caret is.
  const shownCurrentLine = useMemo(() => {
    if (currentRowLine == null) return null
    return (!searching && hidingSectionLine(keyed, collapsed, currentRowLine)) || currentRowLine
  }, [currentRowLine, keyed, collapsed, searching])

  // Follow the cursor: scroll the current row into view when it changes. block:'nearest' keeps it
  // gentle (no recentring), and it won't fire while the row is already visible.
  useEffect(() => {
    if (shownCurrentLine == null) return
    rowRefs.current.get(shownCurrentLine)?.scrollIntoView({ block: 'nearest' })
  }, [shownCurrentLine])

  // Clearing the search puts the tree back: bring the slide that was chosen from the results into view.
  // (A frame later: the list has just grown from a handful of rows to the whole tree.)
  const wasSearchingRef = useRef(false)
  useEffect(() => {
    let frame = 0
    if (wasSearchingRef.current && !searching && selectedLine != null) {
      frame = requestAnimationFrame(() => rowRefs.current.get(selectedLine)?.scrollIntoView({ block: 'nearest' }))
    }
    wasSearchingRef.current = searching
    return () => cancelAnimationFrame(frame)
  }, [searching]) // eslint-disable-line react-hooks/exhaustive-deps

  // A reveal (a drop, a jump from the grid or strip, a search result) names a row to bring into view;
  // by the time this runs the sections around it are open and the row is rendered.
  const seenRevealRef = useRef(snap.revealSeq)
  useEffect(() => {
    if (seenRevealRef.current === snap.revealSeq) return
    seenRevealRef.current = snap.revealSeq
    const line = keyed.find((r) => r.key === snap.revealKey)?.line
    if (line != null) rowRefs.current.get(line)?.scrollIntoView({ block: 'nearest' })
  }, [snap.revealSeq, snap.revealKey, keyed])
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
        const isCollapsed = collapsed.has(keyByLine.get(line) ?? '')
        if (e.key === 'ArrowLeft' ? !isCollapsed : isCollapsed) toggle(line)
        return
      }
    }
    // The Menu key (or ⇧F10) opens the row's menu at the row, first row highlighted.
    if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const line = highlightedLine ?? selectedLine
      const el = line != null ? rowRefs.current.get(line) : null
      if (line != null && el) {
        e.preventDefault()
        const r = el.getBoundingClientRect()
        openMenu(line, r.left + 24, r.bottom, true)
      }
      return
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

  // ── The row menu, and ⌘X / ⌘C / ⌘V on the selected row ──
  // The clipboard keys arrive as the browser's cut / copy / paste events (so the Edit menu's items do
  // the same thing here), and act on the selected row, or the one highlighted with the arrow keys.
  function openMenu(line: number, x: number, y: number, startAtFirst = false): void {
    setSelectedLine(line)
    setHighlightedLine(line)
    setMenu({ x, y, line, mode: 'menu', collapsed: sectionLines.has(line) && !searching ? collapsed.has(keyByLine.get(line) ?? '') : null, startAtFirst })
  }
  function handleContextMenu(e: ReactMouseEvent<HTMLElement>): void {
    const row = (e.target as Element).closest('[data-line]')
    if (!row || !panelRef.current?.contains(row)) return
    e.preventDefault()
    openMenu(Number(row.getAttribute('data-line')), e.clientX, e.clientY)
  }
  const inTextField = (target: EventTarget): boolean => target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  function handleCutCopy(e: ReactClipboardEvent<HTMLElement>, cut: boolean): void {
    if (inTextField(e.target) || !slideOps) return
    const line = selectedLine ?? highlightedLine
    if (line == null) return
    e.preventDefault()
    const clip = cut ? slideOps.cut(line) : slideOps.copy(line)
    if (clip == null) return
    e.clipboardData.setData('text/plain', clip)
    if (cut) afterCut()
  }
  function handlePaste(e: ReactClipboardEvent<HTMLElement>): void {
    if (inTextField(e.target) || !slideOps) return
    e.preventDefault()
    // After the selected slide (after the whole section when a section is selected); at the end of the talk when nothing is.
    const at = slideOps.paste(e.clipboardData.getData('text/plain'), selectedLine ?? highlightedLine)
    if (at != null) landed(at)
  }

  // ── Drag and drop ──
  // One set of handlers on the panel (rows only carry `draggable` + data-line): the target is read
  // from the element under the pointer, which is also how the auto-scroll loop re-reads it when the
  // list moves under a pointer that is not moving.
  const levelByLine = useMemo(() => new Map(rows.map((r) => [r.line, r.level])), [rows])
  const isCollapsedSection = (line: number): boolean => sectionLines.has(line) && collapsed.has(keyByLine.get(line) ?? '')
  // A drop on a collapsed section row puts a deeper heading inside it; anything else (an open
  // section, a slide row, or a dragged section that could not be a child) goes before the row.
  const targetFor = (at: number | 'end' | null): DropTarget | null => {
    if (at == null) return null
    if (at === 'end') return { kind: 'end' }
    const into = isCollapsedSection(at) && dragLevelRef.current > (levelByLine.get(at) ?? 0)
    return { kind: into ? 'into' : 'before', line: at }
  }
  // The talk's title row (and any row above it) is never a place to drop before: nothing goes above
  // the title. No drop line is drawn there and a drop released there does nothing; relocateBlock
  // refuses the same move, so the two cannot disagree.
  const titleLine = useMemo(() => talkTitleLine(content), [content])
  // Row numbers are the strip's (compiled) numbers, the same map the Move list reads.
  const stripNumbers = useSyncExternalStore(subscribeStripNumbers, getStripNumbers)
  const numbersByLine = useMemo(() => outlineNumbers(rows, stripNumbers), [rows, stripNumbers])
  const rowNumber = (r: { line: number }): string => {
    const n = numbersByLine.get(r.line)
    return n != null ? String(n).padStart(2, '0') : ''
  }
  const droppable = (line: number): boolean => line !== dragLineRef.current && (titleLine == null || line > titleLine)
  function dropAtElement(el: Element | null, clientY: number): number | 'end' | null {
    const panel = panelRef.current
    if (!panel || !el || !panel.contains(el) || dragLineRef.current == null) return null
    const row = el.closest('[data-line]')
    if (row) {
      const line = Number(row.getAttribute('data-line'))
      return droppable(line) ? line : null
    }
    if (el.closest('[data-drop-end]')) return 'end'
    // Over the search box (it covers the top of the list) with the list at its top: the start of the
    // talk, which is before the first row under the title (before the first row when there is no title).
    if (el.closest('.so-search')) {
      if (panel.scrollTop > 0) return null
      const first = [...panel.querySelectorAll('[data-line]')].map((r) => Number(r.getAttribute('data-line'))).find((line) => titleLine == null || line > titleLine)
      return first === undefined || first === dragLineRef.current ? null : first
    }
    // Open space under the last row counts as the end of the talk too.
    const end = panel.querySelector('[data-drop-end]')
    return el === panel && end && clientY >= end.getBoundingClientRect().top ? 'end' : null
  }
  const dropAtPointRef = useRef<(x: number, y: number) => void>(() => {})
  dropAtPointRef.current = (x, y) => {
    const at = dropAtElement(document.elementFromPoint(x, y), y)
    if (at != null) setDropAt(at) // outside the list: keep the last target, the pointer has not moved
  }
  // A section the drag opened by resting on it goes back to collapsed, unless the slide was dropped
  // inside it (`droppedAtLine` is the row the drop landed on or before).
  function closeSprung(droppedAtLine: number | null): void {
    for (const key of sprungRef.current) {
      const i = keyed.findIndex((r) => r.key === key)
      let end = i + 1
      while (i >= 0 && end < keyed.length && keyed[end].level > keyed[i].level) end += 1
      const inside = i >= 0 && droppedAtLine != null && droppedAtLine > keyed[i].line && droppedAtLine <= (keyed[end - 1]?.line ?? 0)
      if (!inside) setSectionCollapsed(tk, key, true)
    }
    sprungRef.current.clear()
  }
  function endDrag(droppedAtLine: number | null = null): void {
    closeSprung(droppedAtLine)
    dragLineRef.current = null
    setDropAt(null)
    stopAutoScrollRef.current?.()
    stopAutoScrollRef.current = null
  }
  function beginDrag(e: ReactDragEvent<HTMLElement>, line: number, level: number, text: string): void {
    if (searching) return
    dragLineRef.current = line
    dragLevelRef.current = level
    draggedTextRef.current = text
    e.dataTransfer.effectAllowed = 'move'
    stopAutoScrollRef.current?.()
    if (panelRef.current) {
      stopAutoScrollRef.current = startDragAutoScroll(panelRef.current, { sticky: '.so-search', onScroll: (p) => dropAtPointRef.current(p.x, p.y) })
    }
  }
  function handleDragOver(e: ReactDragEvent<HTMLElement>): void {
    if (dragLineRef.current == null) return
    const at = dropAtElement(e.target as Element, e.clientY)
    if (at != null) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }
    setDropAt((prev) => (prev === at ? prev : at))
  }
  function handleDrop(e: ReactDragEvent<HTMLElement>): void {
    const from = dragLineRef.current
    if (from == null) return
    e.preventDefault()
    const target = targetFor(dropAtElement(e.target as Element, e.clientY))
    endDrag(target && target.kind !== 'end' ? target.line : null)
    if (!target || !ops) return
    if (target.kind === 'end') ops.moveToEnd(from)
    else if (target.kind === 'into') ops.moveInto(from, target.line)
    else ops.moveTo(from, target.line)
    pendingJumpRef.current = draggedTextRef.current
  }
  const dropTarget = targetFor(dropAt)
  const dropClass = (line: number): string =>
    dropTarget && dropTarget.kind !== 'end' && dropTarget.line === line
      ? dropTarget.kind === 'into' ? 'so-row--dropinto' : 'so-row--dragover'
      : ''

  if (rows.length === 0) {
    return <div className="pres-nav-empty">{content ? 'No headings yet.' : 'Select a talk to see its slides.'}</div>
  }

  return (
    <>
    <div
      className="slides-organizer"
      data-slides-organizer
      ref={panelRef}
      tabIndex={0}
      onFocus={(e) => releaseSelectionOutside(e.currentTarget)}
      onKeyDown={handlePanelKey}
      onContextMenu={handleContextMenu}
      onCut={(e) => handleCutCopy(e, true)}
      onCopy={(e) => handleCutCopy(e, false)}
      onPaste={handlePaste}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragEnd={() => endDrag()}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null) }}
    >
      <div className="so-search">
        <input
          ref={searchRef}
          type="search"
          className="so-search-input"
          placeholder="Search slide titles…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setHighlightedLine(null) }}
          aria-label="Search the slide outline"
        />
        <button type="button" className="tl-tbtn" title="Collapse all sections" aria-label="Collapse all sections" data-so-collapse-all onClick={() => { publishOutline(tk, content); collapseAllSections(tk) }}><IcCollapse /></button>
        <button type="button" className="tl-tbtn" title="Expand all sections" aria-label="Expand all sections" data-so-expand-all onClick={() => { publishOutline(tk, content); expandAllSections(tk) }}><IcExpand /></button>
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
        const indent = searching ? undefined : { paddingLeft: `${6 + Math.max(0, r.level - 2) * 14}px` }
        if (sectionLines.has(r.line)) {
          const rowKey = keyByLine.get(r.line) ?? ''
          const isCollapsed = collapsed.has(rowKey)
          const heldSlides = isCollapsed && !searching ? slideCount(keyed, rowKey) : 0
          return (
            <div
              key={r.line}
              ref={(el) => {
                if (el) rowRefs.current.set(r.line, el)
                else rowRefs.current.delete(r.line)
              }}
              className={`so-section ${isSel ? 'so-row--sel' : ''} ${isHighlighted ? 'so-row--kbd' : ''} ${shownCurrentLine === r.line ? 'so-row--current' : ''} ${dropClass(r.line)}`}
              style={indent}
              data-line={r.line}
              draggable={!searching}
              onDragStart={(e) => beginDrag(e, r.line, r.level, r.text)}
            >
              <span className="so-slide-no" data-so-no>{rowNumber(r)}</span>
              {!searching && (
                <button type="button" className="so-caret" onClick={(e) => { e.stopPropagation(); toggle(r.line, e.altKey) }} aria-expanded={!isCollapsed} title="Option-click: this section and all inside it">
                  {isCollapsed ? '▸' : '▾'}
                </button>
              )}
              <button type="button" className="so-section-label" onClick={() => select(r.line)}>{renderText(r.text)}</button>
              {heldSlides > 0 && <span className="so-count" data-so-count title={`${heldSlides} slide${heldSlides === 1 ? '' : 's'} inside`}>{heldSlides}</span>}
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
            className={`so-slide ${isSel ? 'so-row--sel' : ''} ${isHighlighted ? 'so-row--kbd' : ''} ${shownCurrentLine === r.line ? 'so-row--current' : ''} ${dropClass(r.line)}`}
            style={indent}
            data-line={r.line}
            onClick={() => select(r.line)}
            draggable={!searching}
            onDragStart={(e) => beginDrag(e, r.line, r.level, r.text)}
          >
            <span className="so-slide-no">{rowNumber(r)}</span>
            <span className="so-slide-title">{renderText(r.text)}</span>
          </button>
        )
      })}
      {/* Always in the tree (adding it at drag start would shift the list under the pointer): the
          drop zone after the last row, which moves the dragged slide to the end of the talk. */}
      {!searching && (
        <div className={`so-drop-end ${dropTarget?.kind === 'end' ? 'so-drop-end--active' : ''}`} data-drop-end aria-hidden />
      )}
    </div>
    <SlideRowMenus
      request={menu}
      rows={rows}
      ops={slideOps}
      onClose={() => setMenu(null)}
      onActed={() => panelRef.current?.focus({ preventScroll: true })}
      onLanded={landed}
      onCut={afterCut}
      onToggleCollapse={() => { if (menu?.line != null) toggle(menu.line) }}
      collapseChords={{ collapse: '←', expand: '→' }}
    />
    </>
  )
}
