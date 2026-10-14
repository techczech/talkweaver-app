// The context menu of a slide or section row (Slides outline, grid) and the destination list of
// "Move slide to…" / "Move section to…". One component for both panels and for the two palette
// commands, so the rows, keys and wording are the same everywhere.
//
// The menu is built on the Talks panel's menu primitives (talklist/menus.tsx: same dismissal, same
// ↑↓↵ model, same clamping, same tl-menu look). The destination list is built like Actions here
// (ActionsHerePanel.tsx: a filter box that owns the focus, ↑↓ wrapping, Return chooses, Escape closes
// with nothing changed; the same actions-here classes). The lists come from lib/moveDestinations.ts
// and every operation is one call on `ops` (the editor's whole-slide operations): this file owns no
// text arithmetic.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpDown, ChevronsDownUp, ChevronsUpDown, CircleHelp, ClipboardPaste, Copy, MoreHorizontal, Scissors, Search, Trash2 } from 'lucide-react'
import { useClamped, useDismiss, useMenuKeyNav } from './talklist/menus'
import { liveShortcutLabel } from '../keymap/store'
import { notify } from '../lib/notify'
import { getStripNumbers, outlineNumbers } from '../lib/stripNumbers'
import { placementOptions, slideNumber, sectionMoveOptions, slideMoveOptions, type MoveOption } from '../lib/moveDestinations'
import type { SlideRow } from '../extensions/slideOutline'
import { rememberSlideClip } from '../extensions/slideBlockOps'
import type { SlideBlockOps } from './Editor'

export interface SlideMenuRequest {
  x: number
  y: number
  /** 1-based heading line of the slide or section; null when the row has no line in the outline. */
  line: number | null
  /** 'menu': the context menu. 'move': straight to the destination list (the two commands). */
  mode: 'menu' | 'move'
  /** A section row: whether it is collapsed now. Leave out (or null) for no Collapse / Expand row. */
  collapsed?: boolean | null
  /** False where the slide cannot be cut, moved or deleted from here (a grid card that is not a `###` slide). */
  editable?: boolean
  /** True when opened from the keyboard: the first row starts highlighted. */
  startAtFirst?: boolean
}

export type SlideRowAction = 'move' | 'cut' | 'copy' | 'paste' | 'delete' | 'collapse' | 'explain' | 'more'

interface Props {
  request: SlideMenuRequest | null
  /** The outline rows of the talk's current text. */
  rows: readonly SlideRow[]
  ops: SlideBlockOps | null
  onClose: () => void
  /** A row was chosen (not a dismissal): the panel takes the keyboard back, so ⌘V after Copy slide reaches it. */
  onActed?: () => void
  /** After a paste or a move: the heading's new line, to select and reveal. */
  onLanded?: (line: number) => void
  /** After a cut: the row is gone. */
  onCut?: () => void
  onToggleCollapse?: () => void
  /** Present = the menu has an Explain rendering row. */
  onExplain?: () => void
  /** Present = the menu has a More actions… row (Actions here for the slide). */
  onMore?: () => void
  /** The chord shown on Collapse / Expand where the panel has one (the outline's ← and →). */
  collapseChords?: { collapse: string; expand: string }
}

interface Item { action: SlideRowAction; icon: JSX.Element; label: string; k?: string; danger?: boolean; breakAfter?: boolean }
const IC = 13

/** The rows of the menu, in order. Exported for the tests. */
export function slideRowMenuItems(opts: { section: boolean; hasLine: boolean; editable: boolean; collapsed: boolean | null; explain: boolean; more: boolean; collapseChords?: { collapse: string; expand: string } }): Item[] {
  const items: Item[] = []
  const what = opts.section ? 'section' : 'slide'
  if (opts.hasLine && opts.editable) {
    items.push(
      { action: 'move', icon: <ArrowUpDown size={IC} />, label: `Move ${what} to…` },
      { action: 'cut', icon: <Scissors size={IC} />, label: `Cut ${what}`, k: '⌘X' },
      { action: 'copy', icon: <Copy size={IC} />, label: `Copy ${what}`, k: '⌘C' }
    )
  }
  if (opts.hasLine) items.push({ action: 'paste', icon: <ClipboardPaste size={IC} />, label: opts.section ? 'Paste after section' : 'Paste slide after', k: '⌘V', breakAfter: true })
  if (opts.section && opts.collapsed != null) {
    items.push(opts.collapsed
      ? { action: 'collapse', icon: <ChevronsUpDown size={IC} />, label: 'Expand', k: opts.collapseChords?.expand }
      : { action: 'collapse', icon: <ChevronsDownUp size={IC} />, label: 'Collapse', k: opts.collapseChords?.collapse })
  }
  if (!opts.section && opts.hasLine && opts.editable) {
    items.push({ action: 'delete', icon: <Trash2 size={IC} />, label: 'Delete slide', k: liveShortcutLabel('editor.delete-slide') || undefined, danger: true, breakAfter: opts.explain || opts.more })
  }
  if (opts.explain) items.push({ action: 'explain', icon: <CircleHelp size={IC} />, label: 'Explain rendering' })
  if (opts.more) items.push({ action: 'more', icon: <MoreHorizontal size={IC} />, label: 'More actions…', k: liveShortcutLabel('app.context-menu') || undefined })
  if (items.length > 0) items[items.length - 1].breakAfter = false
  return items
}

function RowMenu({ x, y, items, label, startAtFirst, onAction, onClose }: {
  x: number; y: number; items: Item[]; label: string; startAtFirst: boolean
  onAction: (action: SlideRowAction) => void
  onClose: () => void
}) {
  useDismiss(onClose)
  const { ref, left, top } = useClamped(x, y)
  const [active, setActive] = useMenuKeyNav(items.length, (i) => onAction(items[i].action), startAtFirst)
  return (
    <div ref={ref} className="tl-menu" style={{ left, top }} role="menu" aria-label={label} data-slide-row-menu onClick={(e) => e.stopPropagation()}>
      {items.map((it, i) => (
        <Fragment key={it.action}>
          <button
            type="button"
            className={`tl-mi ${it.danger ? 'tl-mi--danger' : ''} ${i === active ? 'tl-mi--kbd' : ''}`}
            role="menuitem"
            data-slide-row-action={it.action}
            onClick={() => onAction(it.action)}
            onMouseEnter={() => setActive(i)}
          >
            {it.icon}{it.label}{it.k && <span className="tl-mi-k">{it.k}</span>}
          </button>
          {it.breakAfter && <hr />}
        </Fragment>
      ))}
    </div>
  )
}

function MoveToPanel({ x, y, rows, line, section, onChoose, onClose }: {
  x: number; y: number
  rows: readonly SlideRow[]
  line: number
  section: boolean
  onChoose: (option: MoveOption) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  // The slide chosen from the list, when the question is now "before or after it".
  const [beside, setBeside] = useState<number | null>(null)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const movedRow = rows.find((r) => r.line === line)
  const title = movedRow?.text ?? '(untitled)'
  const numbers = useMemo(() => outlineNumbers(rows, getStripNumbers()), [rows])
  const movedNo = slideNumber(movedRow, numbers)
  const besideTitle = beside == null ? '' : rows.find((r) => r.line === beside)?.text ?? ''
  const options = useMemo(
    () => beside != null ? placementOptions(rows, line, beside, numbers) : section ? sectionMoveOptions(rows, line, query, numbers) : slideMoveOptions(rows, line, query, numbers),
    [rows, line, section, query, beside, numbers]
  )
  useDismiss(onClose)
  const { ref, left, top } = useClamped(x, y)
  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { setActive(0) }, [query, beside])
  useEffect(() => { ref.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [active, ref])

  const choose = (option: MoveOption | undefined): void => {
    if (!option) return
    if (option.target == null && option.slideLine != null) { setBeside(option.slideLine); return }
    onChoose(option)
  }
  // Capture phase, as in Actions here: the panel underneath never sees these keys. Escape is useDismiss's.
  const stateRef = useRef({ active, options })
  stateRef.current = { active, options }
  const chooseRef = useRef(choose)
  chooseRef.current = choose
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const state = stateRef.current
      const n = state.options.length
      if (event.key === 'ArrowDown') {
        event.preventDefault(); event.stopPropagation()
        if (n > 0) setActive((state.active + 1) % n)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault(); event.stopPropagation()
        if (n > 0) setActive((state.active - 1 + n) % n)
      } else if (event.key === 'Enter') {
        event.preventDefault(); event.stopPropagation()
        chooseRef.current(state.options[state.active])
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [])

  const what = section ? 'section' : 'slide'
  return (
    <div ref={ref} className="actions-here move-to" style={{ left, top }} role="dialog" aria-label={`Move ${what} to`} data-move-to={what} onClick={(e) => e.stopPropagation()}>
      <div className="move-to-title" data-move-to-title>Move {what}{movedNo && <> <span className="move-to-no">{movedNo}</span></>} “{title}” to</div>
      <div className="actions-here-filter">
        <Search size={13} aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder={section ? 'Filter sections' : 'Filter sections, or type a slide title'}
          aria-label="Filter destinations"
          data-move-to-input
          onChange={(event) => { setBeside(null); setQuery(event.target.value) }}
        />
        <span className="actions-here-count">{options.length}</span>
      </div>
      <div className="actions-here-list" role="listbox" aria-label="Destinations">
        {beside != null && <div className="actions-here-group" role="presentation">Next to “{besideTitle}”</div>}
        {options.length === 0 && (
          <div className="actions-here-empty" data-move-to-empty>
            {beside != null ? 'It is already next to that slide.' : query.trim() ? `No ${section ? 'section' : 'section or slide'} matches “${query.trim()}”.` : 'There is nowhere else to move it.'}
          </div>
        )}
        {options.map((option, at) => (
          <Fragment key={option.key}>
            {beside == null && (at === 0 || options[at - 1].group !== option.group) && <div className="actions-here-group" role="presentation">{option.group}</div>}
            <button
              type="button"
              role="option"
              aria-selected={at === active}
              data-active={at === active ? 'true' : 'false'}
              data-move-option={option.key}
              data-current={option.current ? 'true' : undefined}
              className={`actions-here-row${at === active ? ' actions-here-row--active' : ''}${option.current ? ' move-to-row--current' : ''}`}
              style={option.indent > 0 ? { paddingLeft: `${14 + option.indent * 14}px` } : undefined}
              onMouseEnter={() => setActive(at)}
              onClick={() => choose(option)}
            >
              {option.no
                ? <span className="so-slide-no move-to-no" data-move-no>{option.no}</span>
                : <span className="so-slide-no move-to-no" aria-hidden="true" />}
              <span className="actions-here-label">{option.label}</span>
              {option.current && <span className="actions-here-hint">it is here now</span>}
              {option.detail && <span className="actions-here-chord">{option.detail}</span>}
              {option.target == null && <span className="actions-here-chord" aria-hidden="true">before or after ›</span>}
            </button>
          </Fragment>
        ))}
      </div>
    </div>
  )
}

/** Puts a cut or copied slide on the system clipboard; says so when the clipboard refuses. The text
 *  is recorded as this app's slide text (the same record cutSlideAt and copySlideAt set), which is
 *  what makes a later paste a whole-slide paste. */
export function writeSlideClipboard(clip: string, cut: boolean): void {
  rememberSlideClip(clip)
  const failed = (): void => notify(
    cut ? 'The slide was cut but could not be put on the clipboard. Undo with ⌘Z to get it back.' : 'The slide could not be put on the clipboard.',
    'warning', 'slide-clipboard-failed'
  )
  try { navigator.clipboard.writeText(clip).catch(failed) } catch { failed() }
}

export default function SlideRowMenus({ request, rows, ops, onClose, onActed, onLanded, onCut, onToggleCollapse, onExplain, onMore, collapseChords }: Props) {
  // 'move' once the menu's Move … to… row is chosen (or at once, for the two commands).
  // Held as the request it was chosen for, so a new request always starts at its own first step.
  const [movingFor, setMovingFor] = useState<SlideMenuRequest | null>(null)
  if (!request) return null
  const moving = movingFor === request
  const line = request.line
  const at = line == null ? -1 : rows.findIndex((r) => r.line === line)
  const hasLine = at >= 0
  // A section row has rows under it; a grid section header asks for the section menu by passing `collapsed`.
  const section = (hasLine && at + 1 < rows.length && rows[at + 1].level > rows[at].level) || request.collapsed != null
  const editable = request.editable !== false && ops != null

  if ((moving || request.mode === 'move') && hasLine && line != null) {
    return (
      <MoveToPanel
        x={request.x} y={request.y} rows={rows} line={line} section={section}
        onClose={onClose}
        onChoose={(option) => {
          onClose()
          onActed?.()
          if (!option.target || !ops) return
          const landed = ops.moveTo(line, option.target)
          if (landed != null) onLanded?.(landed)
        }}
      />
    )
  }

  // A grid card keeps Explain rendering and More actions… whatever its heading is (a section-title
  // card's line is a section's); a grid section header, which passes `collapsed`, has neither.
  const forHeader = request.collapsed != null
  const items = slideRowMenuItems({ section, hasLine, editable, collapsed: request.collapsed ?? null, explain: !!onExplain && !forHeader, more: !!onMore && !forHeader, collapseChords })
  if (items.length === 0) return null
  const run = (action: SlideRowAction): void => {
    if (action === 'move') { setMovingFor(request); return }
    onClose()
    onActed?.()
    switch (action) {
      case 'cut': {
        const clip = line != null ? ops?.cut(line) ?? null : null
        if (clip != null) { writeSlideClipboard(clip, true); onCut?.() }
        break
      }
      case 'copy': {
        const clip = line != null ? ops?.copy(line) ?? null : null
        if (clip != null) writeSlideClipboard(clip, false)
        break
      }
      case 'paste':
        navigator.clipboard.readText()
          .then((text) => {
            const landed = ops?.paste(text, line) ?? null
            if (landed != null) onLanded?.(landed)
          })
          .catch(() => notify('Couldn’t read the clipboard. Paste with ⌘V instead.', 'warning', 'slide-clipboard-failed'))
        break
      case 'delete': if (line != null) { ops?.delete(line); onCut?.() } break
      case 'collapse': onToggleCollapse?.(); break
      case 'explain': onExplain?.(); break
      case 'more': onMore?.(); break
    }
  }
  return (
    <RowMenu
      x={request.x} y={request.y} items={items}
      label={section ? 'Section actions' : 'Slide actions'}
      startAtFirst={request.startAtFirst === true}
      onAction={run} onClose={onClose}
    />
  )
}
