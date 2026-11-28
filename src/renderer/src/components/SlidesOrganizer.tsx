import { Bookmark, CornerDownRight, Ellipsis, Image, LayoutTemplate, StickyNote } from 'lucide-react'
import { structureDrop, type DropSide, type structureOf } from '../../../shared/talk-structure'
import { slideKeys, useSlideSelection } from '../lib/useSlideSelection'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { slideRows, talkTitleLine } from '../extensions/slideOutline'
import { startDragAutoScroll } from '../lib/dragAutoScroll'
import { createSidebarSlideScroll } from '../lib/sidebarSlideScroll'
import { hiddenLines, hidingSectionLine, keyRows, slideCount } from '../lib/outlineCollapse'
import {
  collapseAllSections, expandAllSections, publishOutline, revealLine, setSectionCollapsed, toggleSection,
  toggleSectionTree, useOutlineCollapse
} from '../lib/outlineCollapseStore'
import { IcCollapse, IcExpand } from './talklist/icons'
import { layoutDisplayName } from '../../../shared/layout-registry/options'
import { highlightSegments, isEmptyQuery, parseQuery } from '../../../shared/slide-handling/query.ts'
import { firstHitFrom, hitPosition, outlineBlocks, outlineItems, runSearch, sectionHitCounts, stepHit } from '../lib/slideSearchModel'
import { registerSearchSurface, useSlideQuery, useWidgetTitles, usePictureText, useSlideThumbs } from '../lib/slideSearch'
import { releaseSelectionOutside, setOutlineSelection } from '../lib/outlineSelection'
import { rowAfterEdit } from '../lib/activeOutlineLine'
import { getOutlineMarks, getStripNumbers, numbersAreCurrent, outlineNumbers, subscribeStripNumbers, type OutlineMark } from '../lib/stripNumbers'
import SlideRowMenus, { type SlideMenuRequest, type StructureRowItems } from './SlideRowMenus'
import type { OutlineOps } from './WorkspaceLayout'

interface Props {
  content: string
  /** In Previews, show these cards until the search has a query. */
  idlePreviews?: ReactNode
  structureRows?: ReturnType<typeof structureOf>['nodes']
  dropStructure?: ReturnType<typeof structureOf>
  rowStructureItems?: StructureRowItems
  selectedLines?: readonly number[]
  onPickStructure?: (line: number, event: ReactMouseEvent) => void
  renderAddLine?: (line: number | null) => ReactNode
  onStructureMove?: (lines: readonly number[], target: number, side: DropSide) => void
  cover?: string
  closing?: string
  currentGenerated?: 'cover' | 'closing'
  onGenerated?: (kind: 'cover' | 'closing') => void
  onJump: (line: number, opts?: { takeFocus?: boolean }) => void
  ops: OutlineOps | null
  /** Source line of the slide the editor cursor is in (item 1: outline follows cursor). The row
   *  containing it is marked + scrolled into view. Distinct from the user's click-selection, and
   *  it never triggers onJump — otherwise the editor and outline would fight each other. */
  currentLine?: number | null
  /** The open talk's outline path: the key its collapse state is kept and remembered under. Without
   *  one the state lasts only as long as the app is open. */
  talkKey?: string | null
  /** The talk's title: what `from:` compares with (the grid reads the same value). */
  talkTitle?: string | null
}

// Where a dragged row would land: before the row at `line`, inside the collapsed section at `line`
// (as its last slide), or at the end of the talk.
type DropTarget = { kind: 'before' | 'into'; line: number } | { kind: 'end' }
/** How long a drag must rest on a collapsed section row before the section opens (ms). */
export const DRAG_EXPAND_DELAY_MS = 700

export default function SlidesOrganizer({ content, idlePreviews, onJump, ops, currentLine, talkKey, talkTitle: talkTitleProp, structureRows, dropStructure, rowStructureItems, selectedLines, onPickStructure, renderAddLine, onStructureMove, cover, closing, currentGenerated, onGenerated }: Props) {
  const tk = talkKey ?? ''
  // The grid shares this query; the match rules live in src/shared/slide-handling/query.ts.
  const [query, setQuery] = useSlideQuery(tk)
  const widgetTitles = useWidgetTitles()
  const queryActive = useMemo(() => !isEmptyQuery(parseQuery(query)), [query])
  const previewsIdle = idlePreviews != null && !queryActive
  const rows = useMemo(() => previewsIdle ? [] : slideRows(content), [content, previewsIdle])
  const structureAt = useMemo(() => new Map(structureRows?.map(row => [row.line + 1, row])), [structureRows])
  const [structureTarget, setStructureTarget] = useState<{ line: number; side: DropSide; label: string } | null>(null)
  const dragSource = useRef<string | null>(null)
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
    if (structureRows) return new Set(structureRows.filter(row => row.section || row.container).map(row => row.line + 1))
    for (let k = 0; k < rows.length - 1; k += 1) {
      if (rows[k + 1].level > rows[k].level) set.add(rows[k].line)
    }
    return set
  }, [rows, structureRows])
  // Collapse keys count same-titled occurrences; selection must follow the authored block
  // when those occurrences swap. Use the exact source (including descendants), never a title hash.
  const selectionKeys = useMemo(() => {
    if (!rows.length) return []
    const lines = content.split('\n')
    return slideKeys(rows.map((row, i) => {
      let end = i + 1
      while (end < rows.length && rows[end].level > row.level) end++
      return { slide_id: row.id, content_hash: lines.slice(row.line - 1, end < rows.length ? rows[end].line - 1 : lines.length).join('\n').trimEnd() }
    }), () => true)
  }, [content, rows])
  const selection = useSlideSelection(selectionKeys, {
    focusRows: rows,
    focusAfterEdit: (rows, line, title, sameCount) => rowAfterEdit(rows, line, title, sameCount)
  })
  const selectedLine = selection.focusedIndex == null ? null : rows[selection.focusedIndex].line
  const setSelectedLine = (line: number | null): void => {
    if (line == null) selection.clear()
    else selection.reset(rows.findIndex(r => r.line === line))
  }
  const [highlightedLine, setHighlightedLine] = useState<number | null>(null)
  const [hitLine, setHitLine] = useState<number | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const rowRefs = useRef(new Map<number, HTMLElement>())
  const coverRef = useRef<HTMLButtonElement>(null)
  const closingRef = useRef<HTMLButtonElement>(null)
  const [sidebarScroll] = useState(createSidebarSlideScroll)
  const followed = useRef<{ talk: string; key: string } | null>(null)
  const clickedRow = useRef<number | 'cover' | 'closing' | null>(null)
  const pointerHighlight = useRef<number | null>(null)

  // Step 1: Drag-to-reorder state. The row under the pointer is held as a line (or 'end'); whether
  // a drop there goes BEFORE the row or INTO it is worked out from the live collapse state, so the
  // indicator and the drop agree even after the section under a resting pointer has opened.
  const dragLineRef = useRef<number | null>(null)
  const dragLevelRef = useRef(0)
  const [dropAt, setDropAt] = useState<number | 'end' | null>(null)
  const stopAutoScrollRef = useRef<(() => void) | null>(null)
  // The dragged slide's source identity + a pending-jump marker, so after a drag the editor follows the slide
  // to its NEW position (not the slot it left). Set on drop, consumed when rows re-derive.
  const draggedKeyRef = useRef<string | null>(null)
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
      if (!e.metaKey || !ops || e.target === searchRef.current) return
      const sel = selectedLine ?? highlightedLine
      if (sel == null) return
      if (selectedLine == null) {
        setSelectedLine(sel)
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

  // The shared selection follows keyed rows through edits and moves.
  const rowCountRef = useRef(rows.length)
  useEffect(() => {
    if (selectedLine != null && Date.now() < revealMovedUntilRef.current) {
      revealMovedUntilRef.current = 0
      revealLine(tk, selectedLine, content)
    }
  }, [selectedLine]) // eslint-disable-line react-hooks/exhaustive-deps

  // The keyboard highlight is a line number too. After an edit that line is another row's: follow
  // the row it was on (by its text, as the selection does), or drop the highlight when that row is
  // gone, so a row the person never chose is not drawn as chosen. Declared before the two effects
  // below, whose own choice of row wins.
  const hlTextRef = useRef<string | null>(null)
  const hlKeyRef = useRef<string | null>(null)
  useEffect(() => {
    hlKeyRef.current = selectionKeys[rows.findIndex(row => row.line === highlightedLine)] ?? null
    hlTextRef.current = highlightedLine == null ? null : rows.find((x) => x.line === highlightedLine)?.text ?? null
  }, [highlightedLine]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const sameCount = rowCountRef.current === rows.length
    rowCountRef.current = rows.length
    if (highlightedLine == null) return
    const identityIndex = selectionKeys.indexOf(hlKeyRef.current)
    const next = identityIndex >= 0 ? rows[identityIndex].line : rowAfterEdit(rows, highlightedLine, hlTextRef.current, sameCount)
    hlKeyRef.current = selectionKeys[rows.findIndex(row => row.line === next)] ?? null
    hlTextRef.current = next == null ? null : rows.find((x) => x.line === next)?.text ?? null
    if (next !== highlightedLine) setHighlightedLine(next)
  }, [rows]) // eslint-disable-line react-hooks/exhaustive-deps

  // After a DRAG, once rows re-derive at the new order, move the editor caret to the dragged slide's
  // NEW position (so focus follows the slide, not the slot it left) and select it in the panel.
  useEffect(() => {
    const t = pendingJumpRef.current
    if (!t) return
    pendingJumpRef.current = null
    const match = rows[selectionKeys.indexOf(t)]
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
    setSelectedLine(line)
    setHighlightedLine(line)
    revealLine(tk, line, content)
    onJump(line)
  }, [rows]) // eslint-disable-line react-hooks/exhaustive-deps
  const landed = (line: number): void => { landedLineRef.current = line }
  const afterCut = (): void => { setSelectedLine(null); setHighlightedLine(null) }

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

  function select(line: number, event?: ReactMouseEvent): void {
    if (event && structureRows) {
      clickedRow.current = line === currentRowLine && !currentGenerated ? null : line
      if (line !== highlightedLine) pointerHighlight.current = line
    }
    if (event && onPickStructure && !structureAt.get(line)?.folded) {
      onPickStructure(line, event)
      setHighlightedLine(line)
      if (searching && run.isHit.has(line)) setHitLine(line)
      return
    }
    // Choosing a search result shows it in its tree: the sections around it open and it is scrolled to.
    if (searching) revealLine(tk, line, content)
    setSelectedLine(line)
    setHighlightedLine(line)
    if (searching && run.isHit.has(line)) setHitLine(line)
    onJump(line) // single-click selects AND jumps (keeps jump behavior)
  }

  // Search dims the rows that do not match, in place: the tree, drag, section collapse and the row menu all stay on.
  // The row the editor cursor is currently in: the row with the greatest heading line ≤ currentLine
  // (the slide/section that contains the caret). Marked distinctly and scrolled into view below.
  const currentRowLine = useMemo(() => {
    if (currentLine == null) return null
    let best: number | null = null
    for (const r of rows) if (r.line <= currentLine && (best == null || r.line > best)) best = r.line
    return best
  }, [rows, currentLine])

  // Match each heading with its slide text, widget titles and any picture text fetched for the search.
  const baseItems = useMemo(() => outlineItems(content, rows), [content, rows])
  const pictureText = usePictureText(talkKey ?? null, useMemo(() => outlineBlocks(baseItems), [baseItems]), queryActive)
  const items = useMemo(() => baseItems.map((it, i) => ({
    ...it, image: pictureText[i] ?? '', widget: widgetTitles.get(it.key)
  })), [baseItems, pictureText, widgetTitles])
  const talkTitle = talkTitleProp ?? (rows[0]?.level === 1 ? rows[0].text : '') // the same value the grid's from: reads (the talk's title)
  const run = useMemo(() => runSearch(items, query, talkTitle), [items, query, talkTitle])
  const searching = run.active
  const filterResults = idlePreviews != null && searching
  const titleScope = run.query.scope === 'all' || run.query.scope === 'title'
  const sectionHits = useMemo(() => sectionHitCounts(rows, run.isHit), [rows, run.isHit])
  const thumbs = useSlideThumbs()

  // Typing in a slide inside a collapsed section does not open it. The row that stands for the caret
  // is then the collapsed section that hides it (outermost), so the marker and the scroll still show
  // where the caret is.
  const titleRow = rows.find(row => row.level === 1)
  const shownCurrentLine = useMemo(() => {
    if (currentGenerated === 'cover') return titleRow?.line ?? null
    if (currentGenerated === 'closing') return null
    if (currentRowLine == null) return null
    return hidingSectionLine(keyed, collapsed, currentRowLine) || currentRowLine
  }, [currentRowLine, keyed, collapsed, currentGenerated, titleRow])

  // Keep the older nearest-row behavior for the generic outline without workspace structure.
  useEffect(() => {
    if (structureRows || shownCurrentLine == null) return
    rowRefs.current.get(shownCurrentLine)?.scrollIntoView({ block: 'nearest' })
  }, [shownCurrentLine, structureRows])
  useLayoutEffect(() => {
    if (!structureRows) return
    const key = currentGenerated ? `generated:${currentGenerated}` : currentRowLine == null ? null : keyByLine.get(currentRowLine)
    const panel = panelRef.current
    const row = currentGenerated === 'cover' ? coverRef.current ?? (titleRow && rowRefs.current.get(titleRow.line))
      : currentGenerated === 'closing' ? closingRef.current : shownCurrentLine == null ? null : rowRefs.current.get(shownCurrentLine)
    if (!key || !panel || !row || (followed.current?.talk === tk && followed.current.key === key)) return
    const clicked = clickedRow.current
    const isClick = followed.current?.talk === tk &&
      (clicked === (currentGenerated ?? currentRowLine) || (currentGenerated === 'cover' && clicked === titleRow?.line))
    clickedRow.current = null
    followed.current = { talk: tk, key }
    if (isClick) return
    const section = shownCurrentLine == null ? undefined
      : structureAt.get(shownCurrentLine)?.ancestors.findLast(index => structureRows[index].section)
    const heading = section === undefined ? null : rowRefs.current.get(structureRows[section].line + 1)?.parentElement ?? null
    const search = searchRef.current?.parentElement?.offsetHeight ?? 0
    const hits = panel.querySelector<HTMLElement>('.so-hitbar')
    const inset = hits ? Math.max(search, Number.parseFloat(getComputedStyle(hits).top) || 0) + hits.offsetHeight : search
    sidebarScroll.align(panel, row, heading, inset)
  }, [structureRows, structureAt, tk, currentRowLine, shownCurrentLine, keyByLine, sidebarScroll, currentGenerated, titleRow, previewsIdle])
  function selectGenerated(kind: 'cover' | 'closing'): void {
    clickedRow.current = currentGenerated === kind ? null : kind
    onGenerated?.(kind)
  }

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
    // Workspace jumps also change the caret. Alignment there owns the scroll.
    if (structureRows) return
    const line = keyed.find((r) => r.key === snap.revealKey)?.line
    if (line != null) rowRefs.current.get(line)?.scrollIntoView({ block: 'nearest' })
  }, [snap.revealSeq, snap.revealKey, keyed, structureRows])
  const matchCount = run.order.length
  const renderText = (text: string, marked = true): ReactNode => {
    if (!searching || !marked || !titleScope) return text
    return highlightSegments(text, run.terms).map((seg, i) => (seg.hit ? <mark key={i} className="so-match">{seg.text}</mark> : seg.text))
  }
  const snippetOf = (line: number): ReactNode => {
    const sn = run.snippets.get(line)
    if (!sn) return null
    return <span className="so-snippet" data-so-snippet>{sn.label}: {sn.segments.map((seg, i) => (seg.hit ? <mark key={i} className="so-match">{seg.text}</mark> : seg.text))}</span>
  }
  // Option C: a thumbnail under each matching row, only while a search is active.
  const thumbOf = (line: number): ReactNode => {
    if (!searching || !run.isHit.has(line)) return null
    const no = numbersCurrent ? numbersByLine.get(line) : null // stale numbers (counted by position): no preview rather than a wrong one
    const url = no != null && thumbs ? thumbs[no - 1] : null
    return url ? <span className="so-thumb" data-so-thumb><img src={url} alt="" draggable={false} /></span> : null
  }
  const dimmed = (line: number, isSection: boolean): boolean => searching && !run.isHit.has(line) && !(isSection && (sectionHits.get(line) ?? 0) > 0)
  const isRowVisible = (line: number): boolean => !previewsIdle && (filterResults
    ? !dimmed(line, sectionLines.has(line))
    : !hidden.has(line))
  const visibleRows = rows.filter((row) => isRowVisible(row.line))

  // Previous / Next move the editor to the hit (the caret stays in the search box) and open the sections around it. Typing lands on the first hit at or after the caret's row without changing which sections are open.
  function gotoHit(line: number | null, takeFocus: boolean, reveal = true): void {
    if (line == null) return
    setHitLine(line)
    setSelectedLine(line)
    setHighlightedLine(line)
    if (reveal) revealLine(tk, line, content)
    onJump(line, { takeFocus })
  }
  const stepSearch = (dir: 1 | -1): void => gotoHit(stepHit(run.order, hitLine, dir), false)
  const orderKey = run.order.join(',')
  const surfaceRef = useRef<{ focus(): void; step(dir: 1 | -1): boolean }>({ focus: () => {}, step: () => false })
  surfaceRef.current = {
    focus: () => { searchRef.current?.focus(); searchRef.current?.select() },
    step: (dir) => { if (!searching) return false; stepSearch(dir); return true }
  }
  useEffect(() => registerSearchSurface('outline', { focus: () => surfaceRef.current.focus(), step: (d) => surfaceRef.current.step(d) }), [])
  // Landing on the first hit happens ONLY when the query itself changes (a new non-empty query), once it has a hit.
  // After the content changes (an edit, a move) nothing moves: the current hit is found again by its heading text
  // (as rowAfterEdit does for the selection) or dropped when it is gone; the k of N count follows, nothing else.
  const runRef = useRef(run)
  runRef.current = run
  const hitTextRef = useRef<string | null>(null)
  const hitCountRef = useRef(rows.length)
  useEffect(() => {
    hitTextRef.current = hitLine == null ? null : rows.find((x) => x.line === hitLine)?.text ?? null
  }, [hitLine]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!searching) { setHitLine(null); return }
    // Keyed on the query text alone: reads the hits at that moment; no hit -> nothing lands until the query changes again.
    const order = runRef.current.order
    if (order.length === 0) return
    gotoHit(firstHitFrom(order, currentRowLine), false, false) // typing never opens or closes a section; Next / Previous and a click do
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const sameCount = hitCountRef.current === rows.length
    hitCountRef.current = rows.length
    if (hitLine == null) return
    const next = rowAfterEdit(rows, hitLine, hitTextRef.current, sameCount)
    const keep = next != null && run.isHit.has(next) ? next : null
    if (keep !== hitLine) setHitLine(keep)
  }, [rows]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (highlightedLine != null && !visibleRows.some((r) => r.line === highlightedLine)) {
      setHighlightedLine(null)
    }
  }, [highlightedLine, visibleRows])

  useEffect(() => {
    const clicked = pointerHighlight.current
    pointerHighlight.current = null
    if (highlightedLine == null || highlightedLine === clicked || (structureRows && highlightedLine === currentRowLine)) return
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
    if (e.target === searchRef.current && e.key !== 'Escape') return
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
    if (!modified && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
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
    setMenu({ x, y, line, mode: 'menu', collapsed: sectionLines.has(line) ? collapsed.has(keyByLine.get(line) ?? '') : null, startAtFirst })
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
    if (typeof at === 'number') landed(at)
    else if (at) void at.then((line) => { if (line != null) landed(line) })
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
  const numbersCurrent = useMemo(() => numbersAreCurrent(rows, stripNumbers), [rows, stripNumbers])
  // Section numbers (§1) and layout marks (R7): what the strip and the margin say of the same heading.
  const outlineMarks = useSyncExternalStore(subscribeStripNumbers, getOutlineMarks)
  const markOf = (r: { line: number; level: number }): OutlineMark => {
    const own = outlineMarks.get(r.line)
    // The talk title stands for the cover, which the compiler places on file line 1.
    if (r.level === 1 && r.line === titleLine && !own?.layout) return { ...own, layout: outlineMarks.get(1)?.layout }
    return own ?? {}
  }
  const markChips = (mark: OutlineMark): ReactNode => (mark.layout ? <span className="so-layout" data-so-layout title={`Layout: ${layoutDisplayName(mark.layout)} (${mark.layout})`}>{layoutDisplayName(mark.layout)}</span> : null)
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
    setStructureTarget(null)
    stopAutoScrollRef.current?.()
    stopAutoScrollRef.current = null
  }
  function beginDrag(e: ReactDragEvent<HTMLElement>, line: number, level: number): void {
    dragSource.current = content
    dragLineRef.current = line
    dragLevelRef.current = level
    draggedKeyRef.current = selectionKeys[rows.findIndex(row => row.line === line)] ?? null
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-tw-structure', String(line))
    stopAutoScrollRef.current?.()
    if (panelRef.current) {
      stopAutoScrollRef.current = startDragAutoScroll(panelRef.current, { sticky: '.so-search', onScroll: (p) => dropAtPointRef.current(p.x, p.y) })
    }
  }
  function structureTargetFor(e: ReactDragEvent<HTMLElement>) {
    const row = (e.target as Element).closest<HTMLElement>('[data-line]')
    if (!row || !dropStructure) return null
    const line = Number(row.dataset.line)
    const box = row.getBoundingClientRect()
    const node = structureAt.get(line)
    const indent = Number.parseFloat(row.style.paddingLeft) || 0
    const side: DropSide = node?.section && e.clientX >= box.left + Math.max(34, indent + 23) ? 'inside'
      : e.clientY < box.top + box.height / 2 ? 'before' : 'after'
    const target = structureDrop(dropStructure, line, side)
    return target ? { line, side, label: target.label } : null
  }

  function handleDragOver(e: ReactDragEvent<HTMLElement>): void {
    if (dragLineRef.current == null) return
    if (onStructureMove) {
      const target = structureTargetFor(e)
      if (target) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }
      setStructureTarget(target)
      return
    }
    const at = dropAtElement(e.target as Element, e.clientY)
    if (at != null) { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }
    setDropAt((prev) => (prev === at ? prev : at))
  }
  function handleDrop(e: ReactDragEvent<HTMLElement>): void {
    const from = dragLineRef.current
    if (from == null) return
    e.preventDefault()
    if (onStructureMove) {
      const target = structureTargetFor(e)
      endDrag(target?.line ?? null)
      if (target && dragSource.current === content) {
        onStructureMove(selectedLines?.includes(from) ? selectedLines : [from], target.line, target.side)
      }
      dragSource.current = null
      return
    }
    const target = targetFor(dropAtElement(e.target as Element, e.clientY))
    endDrag(target && target.kind !== 'end' ? target.line : null)
    if (!target || !ops) return
    if (target.kind === 'end') ops.moveToEnd(from)
    else if (target.kind === 'into') ops.moveInto(from, target.line)
    else ops.moveTo(from, target.line)
    pendingJumpRef.current = draggedKeyRef.current
  }
  const dropTarget = targetFor(dropAt)
  const dropClass = (line: number): string =>
    dropTarget && dropTarget.kind !== 'end' && dropTarget.line === line
      ? dropTarget.kind === 'into' ? 'so-row--dropinto' : 'so-row--dragover'
      : ''

  if (idlePreviews == null && rows.length === 0 && !cover) {
    return <div className="pres-nav-empty">{content ? 'No headings yet.' : 'Select a talk to see its slides.'}</div>
  }

  const dropLabel = (line: number) => structureTarget?.line === line
    ? <span className="tw-structure-drop" data-drop-side={structureTarget.side}>{structureTarget.label}</span> : null
  const more = (line: number) => rowStructureItems && <button type="button" className="tw-structure-row-more" aria-label="More for this row"
    onClick={e => { e.stopPropagation(); const box = e.currentTarget.getBoundingClientRect(); openMenu(line, box.right, box.top, e.detail === 0) }}><Ellipsis size={14} /></button>
  const outlineMark = (row: typeof rows[number]) => {
    if (!structureRows) return markChips(markOf(row))
    const source = structureAt.get(row.line)
    return <>
      {source?.folded ? <CornerDownRight size={12} aria-label="Subslide" /> : <LayoutTemplate size={13} aria-label={markOf(row).layout ?? 'Slide'} />}
      {source?.notes && <StickyNote size={11} aria-label="Has speaker notes" />}
      {source?.content.includes('![') && <Image size={11} aria-label="Has a picture" />}
    </>
  }
  return (
    <>
    <div
      className="slides-organizer"
      data-slides-organizer
      data-sidebar-search-idle={previewsIdle || undefined}
      ref={panelRef}
      data-sidebar-follow-list={structureRows && !previewsIdle ? '' : undefined}
      data-multi-selection={(selectedLines?.length ?? 0) > 1 || undefined}
      onScroll={event => sidebarScroll.onScroll(event.currentTarget)}
      tabIndex={previewsIdle ? -1 : 0}
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
          placeholder="Search titles, text and pictures…"
          title="Use widget: to search only widgets"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setHighlightedLine(null) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && searching && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); stepSearch(e.shiftKey ? -1 : 1) } }}
          aria-label="Search the slide outline"
        />
        {idlePreviews == null && <>
          <button type="button" className="tl-tbtn" title="Collapse all sections" aria-label="Collapse all sections" data-so-collapse-all onClick={() => { publishOutline(tk, content); collapseAllSections(tk) }}><IcCollapse /></button>
          <button type="button" className="tl-tbtn" title="Expand all sections" aria-label="Expand all sections" data-so-expand-all onClick={() => { publishOutline(tk, content); expandAllSections(tk) }}><IcExpand /></button>
        </>}
      </div>
      {searching && (
        <div className="so-hitbar" data-so-hitbar>
          <span className="so-hitcount" data-so-hitcount><b>{hitPosition(run.order, hitLine).k}</b> of {matchCount}</span>
          <button type="button" className="tl-tbtn so-hitbtn" data-so-prev disabled={matchCount === 0} onClick={() => stepSearch(-1)}>‹ Previous</button>
          <button type="button" className="tl-tbtn so-hitbtn" data-so-next disabled={matchCount === 0} onClick={() => stepSearch(1)}>Next ›</button>
        </div>
      )}
      {searching && matchCount === 0 && (
        <div className="pres-nav-empty">No slides match “{query.trim()}”.</div>
      )}
      {!previewsIdle && !filterResults && cover && !titleRow && <><button ref={coverRef} type="button" className={`so-slide tw-structure-generated${currentGenerated === 'cover' ? ' so-row--current' : ''}`} title={cover} onClick={() => selectGenerated('cover')}><span className="so-slide-no">1</span><span className="tw-sidebar-row-title">{cover}</span></button>{renderAddLine?.(null)}</>}
      {rows.map((r, index) => {
        if (!isRowVisible(r.line)) return null
        const source = structureAt.get(r.line)
        const isSel = selectedLines ? selectedLines.includes(r.line) : selectedLine === r.line
        const add = !filterResults && index < rows.length - 1 && !source?.folded ? renderAddLine?.(r.level === 1 ? null : r.line) : null
        const isHighlighted = highlightedLine === r.line
        // Indent by heading depth (##/# flush left) so nesting reads as a tree at any level.
        const indent = { paddingLeft: `${6 + Math.max(0, r.level - 2) * 14}px` }
        if (sectionLines.has(r.line)) {
          const rowKey = keyByLine.get(r.line) ?? ''
          const isCollapsed = collapsed.has(rowKey)
          const heldSlides = isCollapsed ? slideCount(keyed, rowKey) : 0
          const title = r.text === '(untitled)' ? source?.level === 2 ? 'New section' : 'New subsection' : r.text
          return (
            <div key={r.line} className="tw-structure-row-wrap">
            <div
              key={r.line}
              ref={(el) => {
                if (el) rowRefs.current.set(r.line, el)
                else rowRefs.current.delete(r.line)
              }}
              className={`so-section ${source?.container ? 'so-as-slide' : ''} ${isSel ? 'so-row--sel' : ''} ${isHighlighted ? 'so-row--kbd' : ''} ${shownCurrentLine === r.line ? 'so-row--current' : ''} ${dimmed(r.line, true) ? 'so-row--dim' : ''} ${dropClass(r.line)}`}
              style={indent}
              data-line={r.line}
              draggable
              onDragStart={(e) => beginDrag(e, r.line, r.level)}
            >
              {dropLabel(r.line)}
              <span className="so-slide-no" data-so-no>{rowNumber(r)}</span>
              {!filterResults && <button type="button" className="so-caret" onClick={(e) => { e.stopPropagation(); toggle(r.line, e.altKey) }} aria-expanded={!isCollapsed} title="Option-click: this section and all inside it">
                {isCollapsed ? '▸' : '▾'}
              </button>}
              {(!structureRows || source?.section) && markOf(r).sectionNumber && <span className="so-section-no" data-so-section-no title={`Section ${markOf(r).sectionNumber}`}>§{markOf(r).sectionNumber}</span>}
              <button type="button" className="so-section-label" title={title} onClick={e => select(r.line, e)}>
                <span className="tw-sidebar-row-title">{renderText(title)}</span>
              </button>
              {structureRows && source?.section ? <Bookmark size={13} /> : outlineMark(r)}
              {more(r.line)}
              {searching && (sectionHits.get(r.line) ?? 0) > 0 && <span className="so-hits" data-so-hits title="Hits inside this section">{sectionHits.get(r.line)} hit{sectionHits.get(r.line) === 1 ? '' : 's'}</span>}
              {heldSlides > 0 && <span className="so-count" data-so-count title={`${heldSlides} slide${heldSlides === 1 ? '' : 's'} inside`}>{heldSlides}</span>}
            </div>
            {add}
            </div>
          )
        }
        return (
          <div key={r.line} className="tw-structure-row-wrap">
          <button
            key={r.line}
            type="button"
            ref={(el) => {
              if (el) rowRefs.current.set(r.line, el)
              else rowRefs.current.delete(r.line)
            }}
            className={`so-slide ${isSel ? 'so-row--sel' : ''} ${isHighlighted ? 'so-row--kbd' : ''} ${shownCurrentLine === r.line ? 'so-row--current' : ''} ${dimmed(r.line, false) ? 'so-row--dim' : ''} ${run.isHit.has(r.line) && searching && hitLine === r.line ? 'so-row--hit' : ''} ${dropClass(r.line)}`}
            style={indent}
            title={r.text}
            data-line={r.line}
            onClick={e => select(r.line, e)}
            data-subslide={source?.folded || undefined}
            draggable={r.level !== 1}
            onDragStart={(e) => beginDrag(e, r.line, r.level)}
          >
            {dropLabel(r.line)}
            <span className="so-slide-no">{source?.folded ? "" : rowNumber(r)}</span>
            <span className="so-slide-text">
              <span className="so-slide-title tw-sidebar-row-title">{renderText(r.text)}</span>
              {snippetOf(r.line)}
              {thumbOf(r.line)}
            </span>
            {outlineMark(r)}
          </button>
          {more(r.line)}
          {add}
          </div>
        )
      })}
      {!previewsIdle && !filterResults && closing && <button ref={closingRef} type="button" className={`so-slide tw-structure-generated${currentGenerated === 'closing' ? ' so-row--current' : ''}`} onClick={() => selectGenerated('closing')}>{closing}</button>}
      {/* Always in the tree (adding it at drag start would shift the list under the pointer): the
          drop zone after the last row, which moves the dragged slide to the end of the talk. */}
      {!previewsIdle && <div className={`so-drop-end ${dropTarget?.kind === 'end' ? 'so-drop-end--active' : ''}`} data-drop-end aria-hidden />}
      {structureRows && !previewsIdle && <div className="tw-sidebar-follow-tail" aria-hidden />}
    </div>
    {previewsIdle && idlePreviews}
    <SlideRowMenus
      request={menu}
      structureItems={rowStructureItems}
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
