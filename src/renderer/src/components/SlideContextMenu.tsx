// The editor's slide context menu (v0.15 stage 4 — ROADMAP carve + ADR-0009 wave).
// ⌘K with the editor focused (or right-click inside the editing surface) opens it for the
// CURRENT slide — the one the caret is in. Every row delegates to an existing WorkspaceLayout
// handler; the menu owns no behaviour of its own. Keyboard model is the Talks-panel menus'
// exactly (↑↓ wrap, ↵ runs, ⎋ closes; ⌘K starts with the first row highlighted, right-click
// starts blank) via the shared primitives in talklist/menus.tsx. Right-click adds a small
// "Text" group — cut/copy/paste against the CodeMirror selection — at the bottom, where the
// suppressed native context menu would have offered them.
import { Fragment, useState } from 'react'
import {
  BarChart3, Bold, ClipboardPaste, Code, Copy, Crosshair, FileCode2, GitFork, Highlighter,
  ImagePlus, Info, Italic, LayoutTemplate, Layers, Link2, Network, Play, Scissors, Share2,
  Sparkles, Table2, Tag, Trash2
} from 'lucide-react'
import { useClamped, useDismiss, useMenuKeyNav } from './talklist/menus'
import {
  LAYOUTS,
  objectInsertEntries,
  type LayoutDef,
  type ObjectInsertEntry
} from '../data/layouts'
import { layoutSubmenuEntries } from './layoutPickerModel'
import { liveShortcutLabel } from '../keymap/store'

export type SlideMenuAction =
  | 'layout' | 'icon' | 'image' | 'tag'
  | 'insert-table' | 'insert-mindmap' | 'insert-chart'
  | 'insert-mermaid' | 'insert-diagram' | 'insert-svg'
  | 'fmt-bold' | 'fmt-italic' | 'fmt-code' | 'fmt-highlight' | 'fmt-link'
  | 'focus' | 'where-used' | 'explain' | 'present-here'
  | 'delete'
  | 'cut' | 'copy' | 'paste'

type Item = {
  action: SlideMenuAction
  icon: JSX.Element
  label: string
  shortcutId?: string
  k?: string
  danger?: boolean
}

const IC = 13

const OBJECT_ICONS: Record<string, JSX.Element> = {
  table: <Table2 size={IC} />,
  mindmap: <Share2 size={IC} />,
  chart: <BarChart3 size={IC} />,
  mermaid: <GitFork size={IC} />,
  diagram: <Network size={IC} />,
  svg: <FileCode2 size={IC} />
}

const OBJECT_MENU_ACTIONS = [
  'insert-table',
  'insert-mindmap',
  'insert-chart',
  'insert-mermaid',
  'insert-diagram',
  'insert-svg'
] as const satisfies readonly SlideMenuAction[]

type ObjectMenuAction = (typeof OBJECT_MENU_ACTIONS)[number]
export type ObjectMenuEntry = ObjectInsertEntry & { action: ObjectMenuAction }

const objectMenuActionSet: ReadonlySet<string> = new Set(OBJECT_MENU_ACTIONS)

export function objectMenuEntries(
  layouts: readonly LayoutDef[] = LAYOUTS
): ObjectMenuEntry[] {
  return objectInsertEntries(layouts).flatMap((entry) => {
    if (!objectMenuActionSet.has(entry.action)) {
      console.error(
        `Registry-derived object menu action has no handler: ${entry.action}. Skipping the row.`
      )
      return []
    }
    return [{ ...entry, action: entry.action as ObjectMenuAction }]
  })
}

const OBJECT_ITEMS: Item[] = objectMenuEntries().map((entry) => ({
  action: entry.action,
  icon: OBJECT_ICONS[entry.name] ?? <LayoutTemplate size={IC} />,
  label: entry.menuLabel
}))
const FIRST_OBJECT_ACTION = OBJECT_ITEMS[0]?.action

const FORMAT_ITEMS: Item[] = [
  { action: 'fmt-bold', icon: <Bold size={IC} />, label: 'Bold', shortcutId: 'editor.bold' },
  { action: 'fmt-italic', icon: <Italic size={IC} />, label: 'Italic', shortcutId: 'editor.italic' },
  { action: 'fmt-code', icon: <Code size={IC} />, label: 'Inline code', shortcutId: 'editor.inline-code' },
  { action: 'fmt-highlight', icon: <Highlighter size={IC} />, label: 'Highlight', shortcutId: 'editor.highlight' },
  { action: 'fmt-link', icon: <Link2 size={IC} />, label: 'Link', shortcutId: 'editor.link' }
]

// Order per the v0.15 carve (docs/ROADMAP.md): insertions → slide views → present → delete.
const SLIDE_ITEMS: Item[] = [
  { action: 'layout', icon: <LayoutTemplate size={IC} />, label: 'Set layout…', k: '⌘L' },
  { action: 'icon', icon: <Sparkles size={IC} />, label: 'Insert icon…', k: '⌘I' },
  { action: 'image', icon: <ImagePlus size={IC} />, label: 'Insert image from archive…', k: '⌘⇧I' },
  { action: 'tag', icon: <Tag size={IC} />, label: 'Tag slide…' },
  ...OBJECT_ITEMS,
  ...FORMAT_ITEMS,
  { action: 'focus', icon: <Crosshair size={IC} />, label: 'Focus this slide', k: '⌘⇧F' },
  { action: 'where-used', icon: <Layers size={IC} />, label: 'Where used & versions', k: '⌘⇧U' },
  { action: 'explain', icon: <Info size={IC} />, label: 'Explain rendering' },
  { action: 'present-here', icon: <Play size={IC} />, label: 'Present from here', k: '⇧F5' },
  { action: 'delete', icon: <Trash2 size={IC} />, label: 'Delete slide', k: '⌘⇧⌫', danger: true }
]
// Separators AFTER these rows (visual grouping only — keyboard order ignores them).
const SLIDE_BREAKS = new Set<SlideMenuAction>(['tag', 'present-here'])

const TEXT_ITEMS: Item[] = [
  { action: 'cut', icon: <Scissors size={IC} />, label: 'Cut', k: '⌘X' },
  { action: 'copy', icon: <Copy size={IC} />, label: 'Copy', k: '⌘C' },
  { action: 'paste', icon: <ClipboardPaste size={IC} />, label: 'Paste', k: '⌘V' }
]

export default function SlideContextMenu({
  x, y, startAtFirst = false, startAtAction, withText = false, currentLayoutName, onAction, onSetLayout, onClose
}: {
  x: number
  y: number
  /** True when opened via ⌘K — the first row starts highlighted (right-click starts blank). */
  startAtFirst?: boolean
  /** Triple-backtick opens with the first Insert object command highlighted. */
  startAtAction?: SlideMenuAction
  /** True for right-click openings: the Text (cut/copy/paste) group joins at the bottom. */
  withText?: boolean
  onAction: (action: SlideMenuAction) => void
  currentLayoutName?: string
  onSetLayout: (layout: LayoutDef) => void
  onClose: () => void
}) {
  useDismiss(onClose)
  const { ref, left, top } = useClamped(x, y)
  const items = withText ? [...SLIDE_ITEMS, ...TEXT_ITEMS] : SLIDE_ITEMS
  const [layoutOpen, setLayoutOpen] = useState(false)
  const layoutItems = layoutSubmenuEntries(LAYOUTS)
  const startAtIndex = startAtAction == null
    ? -1
    : items.findIndex((item) => item.action === startAtAction)
  const [active, setActive] = useMenuKeyNav(
    items.length,
    (i) => onAction(items[i].action),
    startAtFirst,
    startAtIndex >= 0 ? startAtIndex : undefined
  )
  return (
    <div ref={ref} className="tl-menu" style={{ left, top }} role="menu" aria-label="Slide actions" data-slide-menu onClick={(e) => e.stopPropagation()}>
      {items.map((it, i) => (
        <Fragment key={it.action}>
          {it.action === FIRST_OBJECT_ACTION && <div className="tl-pop-title">Insert object</div>}
          {it.action === 'fmt-bold' && <div className="tl-pop-title">Text formatting</div>}
          {withText && it.action === 'cut' && <div className="tl-pop-title">Text</div>}
          {(() => {
            const shortcut = it.shortcutId
              ? liveShortcutLabel(it.shortcutId)
              : it.k
            return (
          <button
            type="button"
            className={`tl-mi ${it.danger ? 'tl-mi--danger' : ''} ${i === active ? 'tl-mi--kbd' : ''}`}
            role="menuitem"
            data-slide-action={it.action}
            onClick={() => it.action === 'layout' ? setLayoutOpen((open) => !open) : onAction(it.action)}
            onMouseEnter={() => setActive(i)}
          >
            {it.icon}{it.label}{shortcut && <span className="tl-mi-k">{shortcut}</span>}
          </button>
            )
          })()}
          {it.action === 'layout' && layoutOpen && (
            <div className="tl-pop" role="menu" aria-label="Set layout">
              {layoutItems.map((layout) => (
                <button key={layout.name} type="button" className="tl-mi" role="menuitemradio"
                  aria-checked={layout.name === currentLayoutName}
                  onClick={() => onSetLayout(layout)}>
                  <span>{layout.name === currentLayoutName ? '●' : '○'}</span>{layout.label}
                </button>
              ))}
              <hr />
              <button type="button" className="tl-mi" role="menuitem" onClick={() => onAction('layout')}>More…</button>
            </div>
          )}
          {SLIDE_BREAKS.has(it.action) && <hr />}
        </Fragment>
      ))}
    </div>
  )
}
