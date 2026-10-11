// Actions here (onboarding 0.38.1 ticket 03): the small panel ⌘K opens at the caret, the selected
// slide or the selected Talks-panel row. It lists the rows it is given (shared/actions-here.ts) under
// their task groups, a filter, and a last row "All commands…". The panel owns no behaviour: a row
// calls onRun, and All commands… calls onAllCommands with the typed text.
//
// Keyboard: typing filters (the filter box owns the focus), ↑↓ move (wrapping, All commands… is the
// last stop), Return runs the highlighted row, Escape closes. A filter with no match highlights
// All commands…, and Return opens the palette with the text kept.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlignLeft, AppWindow, ArrowDown, ArrowUp, ArrowUpDown, Bold, ChartColumn, ChevronsLeft, ChevronsRight, ChevronsUpDown,
  CircleHelp, CircleX, ClipboardCopy, Code, CodeXml, Copy, Eye, FilePlus, FilePlus2, FileText, FolderInput, FolderMinus,
  FolderOpen, FolderPlus, FolderSearch, Focus, Globe, HardDrive, Heading, Heading2, Highlighter, IndentDecrease,
  IndentIncrease, Image, Italic, Layers, LayoutDashboard, LayoutList, LayoutTemplate, Link, List, ListFilter, ListOrdered,
  MousePointerClick, Network, Palette, PanelRight, Pencil, PenTool, Presentation, QrCode, RefreshCw, Search, Settings2,
  Shapes, Share2, Sparkles, SquareArrowOutUpRight, Stethoscope, Strikethrough, Table, Tag, Timer, Trash2, Type, Underline,
  Workflow, Wrench, type LucideIcon
} from 'lucide-react'
import { useClamped, useDismiss } from './talklist/menus'
import {
  allCommandsHint, filterActionRows, groupActionRows, noMatchText, rowChordText,
  type ActionRow
} from '../../../shared/actions-here.ts'
import { actionIconName, type ActionIconName } from '../../../shared/actions-here-icons.ts'

/** Every icon name shared/actions-here-icons.ts can return; the Record type makes a missing one a type error. */
const ICON_COMPONENTS: Record<ActionIconName, LucideIcon> = {
  AlignLeft, AppWindow, ArrowDown, ArrowUp, ArrowUpDown, Bold, ChartColumn, ChevronsLeft, ChevronsRight, ChevronsUpDown,
  CircleHelp, CircleX, ClipboardCopy, Code, CodeXml, Copy, Eye, FilePlus, FilePlus2, FileText, FolderInput, FolderMinus,
  FolderOpen, FolderPlus, FolderSearch, Focus, Globe, HardDrive, Heading, Heading2, Highlighter, IndentDecrease,
  IndentIncrease, Image, Italic, Layers, LayoutDashboard, LayoutList, LayoutTemplate, Link, List, ListFilter, ListOrdered,
  MousePointerClick, Network, Palette, PanelRight, Pencil, PenTool, Presentation, QrCode, RefreshCw, Search, Settings2,
  Shapes, Share2, Sparkles, SquareArrowOutUpRight, Stethoscope, Strikethrough, Table, Tag, Timer, Trash2, Type, Underline,
  Workflow, Wrench
}

interface Props {
  x: number
  y: number
  rows: readonly ActionRow[]
  /** The text of a chord for a shortcut id (the effective chord, rebinding applied). */
  chordOf: (shortcutId: string) => string
  /** The chord of the command palette, shown on the last row. */
  paletteChord: string
  onRun: (row: ActionRow) => void
  onAllCommands: (query: string) => void
  onClose: () => void
}

export default function ActionsHerePanel({ x, y, rows, chordOf, paletteChord, onRun, onAllCommands, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const filtered = useMemo(() => filterActionRows(rows, query), [rows, query])
  const groups = useMemo(() => groupActionRows(filtered), [filtered])
  // The stops: every filtered row, then All commands…
  const stops = filtered.length + 1
  const allIndex = filtered.length
  useDismiss(onClose)
  const { ref, left, top } = useClamped(x, y)

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { setActive(0) }, [query])
  useEffect(() => {
    ref.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, ref])

  // Capture phase, so the editor underneath never sees these keys. Escape is handled by useDismiss.
  const stateRef = useRef({ active, stops, allIndex, filtered, query })
  stateRef.current = { active, stops, allIndex, filtered, query }
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const state = stateRef.current
      if (event.key === 'ArrowDown') {
        event.preventDefault(); event.stopPropagation()
        setActive((state.active + 1) % state.stops)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault(); event.stopPropagation()
        setActive((state.active - 1 + state.stops) % state.stops)
      } else if (event.key === 'Enter') {
        event.preventDefault(); event.stopPropagation()
        if (state.active === state.allIndex) onAllCommands(state.query)
        else {
          const row = state.filtered[state.active]
          if (row) onRun(row)
        }
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onRun, onAllCommands])

  let index = 0
  return (
    <div
      ref={ref}
      className="actions-here"
      style={{ left, top }}
      role="dialog"
      aria-label="Actions here"
      data-actions-here
      onClick={(event) => event.stopPropagation()}
    >
      <div className="actions-here-filter">
        <Search size={13} aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="Filter actions"
          aria-label="Filter actions"
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="actions-here-count" data-actions-here-count>{filtered.length}</span>
      </div>
      <div className="actions-here-list" role="listbox" aria-label="Actions here">
        {filtered.length === 0 ? (
          <div className="actions-here-empty" data-actions-here-empty>{noMatchText(query)}</div>
        ) : groups.map((group) => (
          <Fragment key={group.taskGroup}>
            <div className="actions-here-group" role="presentation">{group.taskGroup}</div>
            {group.rows.map((row) => {
              const at = index++
              const chord = rowChordText(row, chordOf)
              const iconName = actionIconName(row.key, row.taskGroup)
              const RowIcon = ICON_COMPONENTS[iconName]
              return (
                <button
                  key={row.key}
                  type="button"
                  role="option"
                  aria-selected={at === active}
                  data-active={at === active ? 'true' : 'false'}
                  data-actions-here-row={row.key}
                  className={`actions-here-row${at === active ? ' actions-here-row--active' : ''}${row.danger ? ' actions-here-row--danger' : ''}`}
                  onMouseEnter={() => setActive(at)}
                  onClick={() => onRun(row)}
                >
                  <span className="actions-here-icon" data-actions-here-icon={iconName} aria-hidden="true"><RowIcon size={14} /></span>
                  <span className="actions-here-label">{row.label}</span>
                  <span className={`actions-here-chord${chord === 'no key' ? ' actions-here-chord--none' : ''}`}>{chord}</span>
                </button>
              )
            })}
          </Fragment>
        ))}
      </div>
      <button
        type="button"
        role="option"
        aria-selected={active === allIndex}
        data-active={active === allIndex ? 'true' : 'false'}
        data-actions-here-all
        className={`actions-here-row actions-here-all${active === allIndex ? ' actions-here-row--active' : ''}`}
        onMouseEnter={() => setActive(allIndex)}
        onClick={() => onAllCommands(query)}
      >
        <span className="actions-here-icon" data-actions-here-icon="Search" aria-hidden="true"><Search size={14} /></span>
        <span className="actions-here-label">All commands…</span>
        {filtered.length === 0 && query.trim() && <span className="actions-here-hint">{allCommandsHint(query)}</span>}
        <span className="actions-here-chord">{paletteChord}</span>
      </button>
    </div>
  )
}
