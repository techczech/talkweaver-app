import { IcChevronRight, IcDrillIn, IcFolderClosed, IcFolderOpen } from './icons'

// Folders must read as folders, not page sections (ADR-0008 taste rule): normal-case
// names, open/closed folder icons, sticky top-level headers for scroll context.

interface FolderShared {
  name: string
  path: string
  expanded: boolean
  focused: boolean
  talkCount: number
  isDropTarget: boolean
  rowRef: (el: HTMLDivElement | null) => void
  onToggle: () => void
  onDrill: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
}

/** Top-level folder header: sticky, full-width, count on the right. */
export function FolderHeader({
  name, path, expanded, focused, talkCount, isDropTarget,
  rowRef, onToggle, onContextMenu, onDragOver, onDragLeave, onDrop
}: Omit<FolderShared, 'onDrill'>) {
  const cls = ['tl-fhead']
  if (expanded) cls.push('tl-fhead--expanded')
  if (focused) cls.push('tl-fhead--kfocus')
  if (isDropTarget) cls.push('tl-drop')
  return (
    <div
      ref={rowRef}
      className={cls.join(' ')}
      role="treeitem"
      aria-expanded={expanded}
      data-talk-group-header
      data-folder-path={path}
      onClick={onToggle}
      onContextMenu={onContextMenu}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <span className="tl-twist"><IcChevronRight size={10} /></span>
      <span className="tl-ficon">{expanded ? <IcFolderOpen size={12.5} /> : <IcFolderClosed size={12.5} />}</span>
      <span className="tl-fname">{name}</span>
      <span className="tl-fcount">{talkCount}</span>
    </div>
  )
}

/** Nested folder row: indented like a talk row, with a hover drill-in affordance (→ on keyboard). */
export function FolderRow({
  name, path, depth, expanded, focused, talkCount, isDropTarget,
  rowRef, onToggle, onDrill, onContextMenu, onDragOver, onDragLeave, onDrop
}: FolderShared & { depth: number }) {
  const cls = ['tl-row', 'tl-row--folder']
  if (expanded) cls.push('tl-row--expanded')
  if (focused) cls.push('tl-row--kfocus')
  if (isDropTarget) cls.push('tl-drop')
  return (
    <div
      ref={rowRef}
      className={cls.join(' ')}
      role="treeitem"
      aria-expanded={expanded}
      style={{ paddingLeft: 6 + depth * 14 }}
      data-talk-group-header
      data-folder-path={path}
      onClick={onToggle}
      onContextMenu={onContextMenu}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <span className="tl-row-twist tl-twist"><IcChevronRight size={10} /></span>
      <span className="tl-row-ficon">{expanded ? <IcFolderOpen size={12} /> : <IcFolderClosed size={12} />}</span>
      <span className="tl-row-name tl-row-name--folder">{name}</span>
      <button
        className="tl-drill"
        title={`Open folder (→)`}
        aria-label={`Open folder ${name}`}
        onClick={(e) => { e.stopPropagation(); onDrill() }}
      >
        <IcDrillIn size={11} />
      </button>
      <span className="tl-fcount">{talkCount}</span>
    </div>
  )
}
