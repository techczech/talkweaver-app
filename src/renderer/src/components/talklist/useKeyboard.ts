import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { TalkInfo } from '../../../../preload/index'
import type { RowRef, TalkSortKey } from './model'

// The panel-scoped keyboard model (identical in both view modes — ADR-0008):
// ↑↓ walk · → expand · ← collapse (from a talk: fold its containing folder) ·
// ↵/⌘O open talk / drill into folder · ⌘↑ up one level · ⌘←/⌘→ collapse/expand all subfolders ·
// v view · n naming · / search · s sort (1–5 pick) · F2 rename (talk or folder) ·
// ⌘D duplicate · m move · ⌘⌫ delete · Esc clears search else blurs.
interface Deps {
  rows: RowRef[]
  focusKey: string | null
  setFocusKey: (key: string) => void
  focusedRow: RowRef | null
  focusedTalk: TalkInfo | null
  collapsed: Set<string>
  toggleFolder: (path: string) => void
  /** Drill into a folder (breadcrumb navigation) — Enter/→ on a folder row. */
  drillInto: (path: string) => void
  /** ⌘↑ — go up one breadcrumb level; refocuses the folder just left. No-op at root. */
  upOneLevel: () => void
  /** ⌘← / ⌘→ — collapse / expand every subfolder of the current drilled-in view. */
  collapseAllInView: () => void
  expandAllInView: () => void
  cycleViewMode: () => void
  cycleNaming: () => void
  sortPopOpen: boolean
  toggleSortPop: () => void
  closeSortPop: () => void
  setSortKey: (key: TalkSortKey) => void
  query: string
  clearQuery: () => void
  focusSearch: () => void
  anyOverlayOpen: boolean
  onSelectTalk: (talk: TalkInfo) => void
  startRename: (talk: TalkInfo) => void
  startRenameFolder: (path: string) => void
  startDuplicate: (talk: TalkInfo) => void
  startDelete: (talk: TalkInfo) => void
  startMove: (talk: TalkInfo, at: { x: number; y: number }) => void
  focusedRowRect: () => { x: number; y: number }
}

/** The folder row that CONTAINS the given row, from render order: the nearest preceding
 *  folder row one level shallower. Null for rows at the current view's root. */
function containingFolder(rows: RowRef[], row: RowRef): Extract<RowRef, { kind: 'folder' }> | null {
  const idx = rows.findIndex((r) => r.key === row.key)
  for (let i = idx - 1; i >= 0; i--) {
    const r = rows[i]
    if (r.kind === 'folder' && r.depth === row.depth - 1) return r
  }
  return null
}

export function makePanelKeyHandler(d: Deps) {
  return function handlePanelKey(e: ReactKeyboardEvent<HTMLElement>): void {
    const t = e.target as HTMLElement
    // Text entry (the filter box, a modal's input) and open menus own their keys entirely.
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
    if (d.anyOverlayOpen) return
    // A toolbar button with real focus keeps its native Enter/Space activation.
    if (t !== e.currentTarget && t.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return
    const mod = e.metaKey || e.ctrlKey
    if (!mod && !e.altKey && !e.shiftKey) {
      if (e.key === 'v' || e.key === 'V') { e.preventDefault(); d.cycleViewMode(); return }
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); d.cycleNaming(); return }
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); d.toggleSortPop(); return }
      if (d.sortPopOpen && /^[1-5]$/.test(e.key)) {
        e.preventDefault()
        const keys: TalkSortKey[] = ['edited', 'delivered', 'name', 'slides', 'created']
        d.setSortKey(keys[parseInt(e.key, 10) - 1])
        d.closeSortPop()
        return
      }
      if (e.key === 'm' || e.key === 'M') { if (d.focusedTalk) { e.preventDefault(); d.startMove(d.focusedTalk, d.focusedRowRect()) } return }
      if (e.key === '/') { e.preventDefault(); d.focusSearch(); return }
      if (e.key === 'Escape') {
        e.preventDefault()
        if (d.sortPopOpen) d.closeSortPop()
        else if (d.query) d.clearQuery()
        else e.currentTarget.blur()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (!d.rows.length) return
        const dir = e.key === 'ArrowDown' ? 1 : -1
        const idx = d.focusKey ? d.rows.findIndex((r) => r.key === d.focusKey) : -1
        const next = idx < 0 ? (dir > 0 ? 0 : d.rows.length - 1) : Math.min(d.rows.length - 1, Math.max(0, idx + dir))
        d.setFocusKey(d.rows[next].key)
        return
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        // Expand only — drilling in belongs to ↵/⌘O (an already-expanded folder is a no-op).
        if (d.focusedRow?.kind === 'folder' && d.collapsed.has(d.focusedRow.path)) d.toggleFolder(d.focusedRow.path)
        return
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (d.focusedRow?.kind === 'folder' && !d.collapsed.has(d.focusedRow.path)) { d.toggleFolder(d.focusedRow.path); return }
        // From a TALK row: one keystroke jumps to its containing folder and folds it.
        if (d.focusedRow?.kind === 'talk') {
          const parent = containingFolder(d.rows, d.focusedRow)
          if (parent) {
            d.setFocusKey(parent.key)
            d.toggleFolder(parent.path) // contents were visible, so this collapses
            return
          }
        }
        // Collapsed folder row / root-level talk: climb out of the drill-in instead.
        d.upOneLevel()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (d.focusedRow?.kind === 'talk') d.onSelectTalk(d.focusedRow.talk)
        // Opening is the default for folders too: Enter drills in (folding stays on ←/→ and the caret).
        else if (d.focusedRow?.kind === 'folder') d.drillInto(d.focusedRow.path)
        return
      }
      // F2 = rename the focused item, talk or folder (the classic file-manager chord).
      if (e.key === 'F2') {
        if (d.focusedRow?.kind === 'talk') { e.preventDefault(); d.startRename(d.focusedRow.talk) }
        else if (d.focusedRow?.kind === 'folder') { e.preventDefault(); d.startRenameFolder(d.focusedRow.path) }
        return
      }
    }
    if (mod && !e.altKey && !e.shiftKey) {
      // ⌘O — the Mac-conventional open chord; same as ↵ (open the talk / drill into the folder).
      if (e.key === 'o' || e.key === 'O') {
        e.preventDefault(); e.stopPropagation()
        if (d.focusedRow?.kind === 'talk') d.onSelectTalk(d.focusedRow.talk)
        else if (d.focusedRow?.kind === 'folder') d.drillInto(d.focusedRow.path)
        return
      }
      // stopPropagation on the ⌘-arrows: GridView binds ⌘↑/⌘↓ on a window listener that only
      // bows out for the editor and text inputs — without it a panel ⌘↑ would ALSO move a slide.
      if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); d.upOneLevel(); return }
      if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); d.collapseAllInView(); return }
      if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); d.expandAllInView(); return }
      if (d.focusedTalk) {
        if (e.key === 'd' || e.key === 'D') { e.preventDefault(); d.startDuplicate(d.focusedTalk); return }
        if (e.key === 'Backspace') { e.preventDefault(); d.startDelete(d.focusedTalk) }
      }
    }
  }
}
