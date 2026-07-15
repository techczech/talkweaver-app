import { Fragment, useEffect, useRef, useState } from 'react'
import { SORT_OPTIONS, type TalkSortKey, type NamingMode } from './model'
import { IcOpen, IcRename, IcDuplicate, IcMoveFolder, IcReveal, IcTrash, IcFile, IcMeta } from './icons'

// Popovers + context menus for the Talks browser. Every action carries its keyboard
// shortcut in the menu (ADR-0008: every affordance keyboard-reachable and advertised).

// Exported: the editor's slide context menu (SlideContextMenu.tsx) reuses these primitives —
// same dismissal arming, same ↑↓↵ keyboard model, same viewport clamping — so every context
// menu in the app behaves identically.
export function useDismiss(onClose: () => void): void {
  useEffect(() => {
    // Arm outside-click/contextmenu dismissal on the NEXT task, not immediately: React 18
    // flushes this effect synchronously for discrete events, so the very contextmenu (or
    // click) that OPENED the menu was still bubbling towards window when these listeners
    // attached — and dismissed the menu within the same gesture (0.14.x live bug: right-click
    // menus never appeared). Escape needs no arming; it can never be the opening event.
    let armed = false
    const timer = window.setTimeout(() => { armed = true }, 0)
    const close = (): void => { if (armed) onClose() }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    window.addEventListener('keydown', onKey, { capture: true })
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('keydown', onKey, { capture: true })
    }
  }, [onClose])
}

/** ↑↓/Enter keyboard navigation for an open menu: wraps at both ends; Enter activates the
 *  highlighted item; with no highlight yet (-1, right-click opening) Enter is left untouched.
 *  Returns [activeIndex, setActiveIndex] — hover hands the highlight to the mouse via the setter. */
export function useMenuKeyNav(
  count: number,
  onActivate: (index: number) => void,
  startAtFirst: boolean
): [number, (i: number) => void] {
  const [active, setActive] = useState(startAtFirst ? 0 : -1)
  const activeRef = useRef(active)
  useEffect(() => { activeRef.current = active }, [active])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation()
        setActive(activeRef.current < 0 ? 0 : (activeRef.current + 1) % count)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation()
        setActive(activeRef.current < 0 ? count - 1 : (activeRef.current - 1 + count) % count)
      } else if (e.key === 'Enter' && activeRef.current >= 0) {
        e.preventDefault(); e.stopPropagation()
        onActivate(activeRef.current)
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [count, onActivate])
  return [active, setActive]
}

/** Clamp a fixed-position menu inside the viewport once its real size is known. */
export function useClamped(x: number, y: number): { ref: React.RefObject<HTMLDivElement>; left: number; top: number } {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8))
    })
  }, [x, y])
  return { ref, left: pos.left, top: pos.top }
}

// ── sort popover ─────────────────────────────────────────────────────────────

const NAMING_OPTIONS: Array<{ key: NamingMode; label: string }> = [
  { key: 'title', label: 'Titles' },
  { key: 'file', label: 'Filenames' }
]

export function SortPopover({
  x, y, sortKey, naming, onPick, onPickNaming, onClose
}: {
  x: number
  y: number
  sortKey: TalkSortKey
  naming: NamingMode
  onPick: (key: TalkSortKey) => void
  onPickNaming: (mode: NamingMode) => void
  onClose: () => void
}) {
  useDismiss(onClose)
  const { ref, left, top } = useClamped(x, y)
  return (
    <div ref={ref} className="tl-pop" style={{ left, top }} role="menu" aria-label="Sort talks" data-talklist-sort-menu onClick={(e) => e.stopPropagation()}>
      <div className="tl-pop-title">Sort talks by</div>
      {SORT_OPTIONS.map((option, i) => (
        <button
          type="button"
          key={option.key}
          className={`tl-pop-opt ${sortKey === option.key ? 'tl-pop-opt--on' : ''}`}
          role="menuitem"
          data-sort-key={option.key}
          onClick={() => onPick(option.key)}
        >
          <span className="tl-pop-tick">{sortKey === option.key ? '✓' : ''}</span>
          {option.label}
          <span className="tl-pop-k">{i + 1}</span>
        </button>
      ))}
      <div className="tl-pop-title">Show</div>
      {NAMING_OPTIONS.map((option) => (
        <button
          type="button"
          key={option.key}
          className={`tl-pop-opt ${naming === option.key ? 'tl-pop-opt--on' : ''}`}
          role="menuitem"
          data-naming-key={option.key}
          onClick={() => onPickNaming(option.key)}
        >
          <span className="tl-pop-tick">{naming === option.key ? '✓' : ''}</span>
          {option.label}
          <span className="tl-pop-k">n</span>
        </button>
      ))}
    </div>
  )
}

// ── context menus ────────────────────────────────────────────────────────────

export type TalkAction = 'open' | 'rename' | 'duplicate' | 'move' | 'metadata' | 'reveal' | 'open-file' | 'copy-path' | 'delete'

type MenuItemDef<A extends string> = { action: A; icon: JSX.Element; label: string; k?: string; danger?: boolean }

const TALK_MENU_ITEMS: MenuItemDef<TalkAction>[] = [
  { action: 'open', icon: <IcOpen size={12} />, label: 'Open', k: '↵' },
  { action: 'rename', icon: <IcRename size={12} />, label: 'Rename…', k: 'F2' },
  { action: 'move', icon: <IcMoveFolder size={12} />, label: 'Move to folder…', k: 'M' },
  { action: 'duplicate', icon: <IcDuplicate size={12} />, label: 'Duplicate…', k: '⌘D' },
  { action: 'metadata', icon: <IcMeta size={12} />, label: 'Metadata…' },
  { action: 'reveal', icon: <IcReveal size={12} />, label: 'Reveal in Finder' },
  { action: 'open-file', icon: <IcFile size={12} />, label: 'Open outline file' },
  { action: 'copy-path', icon: <IcDuplicate size={12} />, label: 'Copy file path' },
  { action: 'delete', icon: <IcTrash size={12} />, label: 'Move to Bin…', k: '⌘⌫', danger: true }
]
// Separators sit AFTER these actions (purely visual — keyboard order ignores them).
const TALK_MENU_BREAKS = new Set<TalkAction>(['metadata', 'copy-path'])

/** One keyboard-navigable action menu (talk or folder): ↑↓ wrap, ↵ activates, hover takes over. */
function ActionMenu<A extends string>({
  x, y, items, breaks, ariaLabel, startAtFirst, onAction, onClose
}: {
  x: number
  y: number
  items: MenuItemDef<A>[]
  breaks: Set<A>
  ariaLabel: string
  startAtFirst: boolean
  onAction: (action: A) => void
  onClose: () => void
}) {
  useDismiss(onClose)
  const { ref, left, top } = useClamped(x, y)
  const [active, setActive] = useMenuKeyNav(items.length, (i) => onAction(items[i].action), startAtFirst)
  return (
    <div ref={ref} className="tl-menu" style={{ left, top }} role="menu" aria-label={ariaLabel} onClick={(e) => e.stopPropagation()}>
      {items.map((it, i) => (
        <Fragment key={it.action}>
          <button
            type="button"
            className={`tl-mi ${it.danger ? 'tl-mi--danger' : ''} ${i === active ? 'tl-mi--kbd' : ''}`}
            role="menuitem"
            onClick={() => onAction(it.action)}
            onMouseEnter={() => setActive(i)}
          >
            {it.icon}{it.label}{it.k && <span className="tl-mi-k">{it.k}</span>}
          </button>
          {breaks.has(it.action) && <hr />}
        </Fragment>
      ))}
    </div>
  )
}

export function TalkContextMenu({
  x, y, startAtFirst = false, onAction, onClose
}: {
  x: number
  y: number
  /** True when opened via ⌘K — the first item starts highlighted (right-click starts blank). */
  startAtFirst?: boolean
  onAction: (action: TalkAction) => void
  onClose: () => void
}) {
  return (
    <ActionMenu
      x={x} y={y}
      items={TALK_MENU_ITEMS}
      breaks={TALK_MENU_BREAKS}
      ariaLabel="Talk actions"
      startAtFirst={startAtFirst}
      onAction={onAction}
      onClose={onClose}
    />
  )
}

export type FolderAction = 'new-talk' | 'new-subfolder' | 'rename' | 'delete'

const FOLDER_MENU_ITEMS: MenuItemDef<FolderAction>[] = [
  { action: 'new-talk', icon: <IcOpen size={12} />, label: 'New talk here…' },
  { action: 'new-subfolder', icon: <IcMoveFolder size={12} />, label: 'New subfolder…' },
  { action: 'rename', icon: <IcRename size={12} />, label: 'Rename folder…', k: 'F2' },
  { action: 'delete', icon: <IcTrash size={12} />, label: 'Delete folder…', danger: true }
]
const FOLDER_MENU_BREAKS = new Set<FolderAction>(['new-subfolder'])

export function FolderContextMenu({
  x, y, startAtFirst = false, onAction, onClose
}: {
  x: number
  y: number
  /** True when opened via ⌘K — the first item starts highlighted (right-click starts blank). */
  startAtFirst?: boolean
  onAction: (action: FolderAction) => void
  onClose: () => void
}) {
  return (
    <ActionMenu
      x={x} y={y}
      items={FOLDER_MENU_ITEMS}
      breaks={FOLDER_MENU_BREAKS}
      ariaLabel="Folder actions"
      startAtFirst={startAtFirst}
      onAction={onAction}
      onClose={onClose}
    />
  )
}

// ── move-to-folder menu (context-menu item + the `m` key, anchored to the row) ──

export function MoveMenu({
  x, y, topics, currentTopic, onPick, onClose
}: {
  x: number
  y: number
  topics: string[]
  currentTopic: string
  onPick: (topic: string) => void
  onClose: () => void
}) {
  useDismiss(onClose)
  const { ref, left, top } = useClamped(x, y)
  const [active, setActive] = useState(() => Math.max(0, topics.indexOf(currentTopic)))
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Wrap at both ends — same keyboard model as the context menus.
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setActive((i) => (i + 1) % topics.length) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setActive((i) => (i - 1 + topics.length) % topics.length) }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onPick(topics[active]) }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [topics, active, onPick])
  useEffect(() => {
    ref.current?.querySelector('.tl-mi--kbd')?.scrollIntoView({ block: 'nearest' })
  }, [active, ref])
  return (
    <div ref={ref} className="tl-menu tl-menu--move" style={{ left, top }} role="menu" aria-label="Move to folder" onClick={(e) => e.stopPropagation()}>
      <div className="tl-pop-title">Move to folder</div>
      {topics.map((topic, i) => (
        <button
          type="button"
          key={topic || '__root__'}
          className={`tl-mi ${topic === currentTopic ? 'tl-mi--current' : ''} ${i === active ? 'tl-mi--kbd' : ''}`}
          role="menuitem"
          onClick={() => onPick(topic)}
        >
          <IcMoveFolder size={12} />{topic || 'Vault root'}
        </button>
      ))}
    </div>
  )
}
