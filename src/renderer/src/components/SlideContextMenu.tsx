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
  ClipboardPaste, Copy, Crosshair, Info, LayoutTemplate, Layers, ImagePlus, Play, Scissors,
  Sparkles, Tag, Trash2
} from 'lucide-react'
import { useClamped, useDismiss, useMenuKeyNav } from './talklist/menus'
import { LAYOUTS, type LayoutDef } from '../data/layouts'
import { layoutSubmenuEntries } from './layoutPickerModel'

export type SlideMenuAction =
  | 'layout' | 'icon' | 'image' | 'tag'
  | 'focus' | 'where-used' | 'explain' | 'present-here'
  | 'delete'
  | 'cut' | 'copy' | 'paste'

type Item = { action: SlideMenuAction; icon: JSX.Element; label: string; k?: string; danger?: boolean }

const IC = 13

// Order per the v0.15 carve (docs/ROADMAP.md): insertions → slide views → present → delete.
const SLIDE_ITEMS: Item[] = [
  { action: 'layout', icon: <LayoutTemplate size={IC} />, label: 'Set layout…', k: '⌘L' },
  { action: 'icon', icon: <Sparkles size={IC} />, label: 'Insert icon…', k: '⌘I' },
  { action: 'image', icon: <ImagePlus size={IC} />, label: 'Insert image from archive…', k: '⌘⇧I' },
  { action: 'tag', icon: <Tag size={IC} />, label: 'Tag slide…' },
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
  x, y, startAtFirst = false, withText = false, currentLayoutName, onAction, onSetLayout, onClose
}: {
  x: number
  y: number
  /** True when opened via ⌘K — the first row starts highlighted (right-click starts blank). */
  startAtFirst?: boolean
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
  const [active, setActive] = useMenuKeyNav(items.length, (i) => onAction(items[i].action), startAtFirst)
  return (
    <div ref={ref} className="tl-menu" style={{ left, top }} role="menu" aria-label="Slide actions" data-slide-menu onClick={(e) => e.stopPropagation()}>
      {items.map((it, i) => (
        <Fragment key={it.action}>
          {withText && it.action === 'cut' && <div className="tl-pop-title">Text</div>}
          <button
            type="button"
            className={`tl-mi ${it.danger ? 'tl-mi--danger' : ''} ${i === active ? 'tl-mi--kbd' : ''}`}
            role="menuitem"
            data-slide-action={it.action}
            onClick={() => it.action === 'layout' ? setLayoutOpen((open) => !open) : onAction(it.action)}
            onMouseEnter={() => setActive(i)}
          >
            {it.icon}{it.label}{it.k && <span className="tl-mi-k">{it.k}</span>}
          </button>
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
