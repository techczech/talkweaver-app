import type { TalkInfo, TalkMeta } from '../../../../preload/index'
import type { TreeNode } from '../talkTreeNav'
import { displayName, type NamingMode, type PubState, type RowRef, type ViewMode } from './model'
import type { WindowLayout } from './window'
import LedgerRow from './LedgerRow'
import ShelfRow from './ShelfRow'
import { FolderHeader, FolderRow } from './FolderRows'

// The scrolling tree renders the exact RowRef[] used by keyboard navigation. Folder-tree
// traversal below only indexes display metadata; it never derives render order.
export interface TreeCallbacks {
  setRowRef: (key: string) => (el: HTMLDivElement | null) => void
  onOpenTalk: (talk: TalkInfo, key: string) => void
  onTalkContext: (talk: TalkInfo, key: string, e: React.MouseEvent) => void
  onToggleFolder: (path: string, key: string) => void
  onFolderContext: (path: string, key: string, e: React.MouseEvent) => void
  onDrill: (path: string) => void
  onDragStartTalk: (talk: TalkInfo, key: string) => void
  onDragEndTalk: () => void
  onFolderDragOver: (path: string, e: React.DragEvent) => void
  onFolderDragLeave: (path: string, e: React.DragEvent) => void
  onFolderDrop: (path: string, e: React.DragEvent) => void
  onTreeDragOver: (e: React.DragEvent) => void
  onTreeDrop: (e: React.DragEvent) => void
}

type FolderInfo = { node: TreeNode; talkCount: number }

function folderIndex(view: TreeNode): Map<string, FolderInfo> {
  const index = new Map<string, FolderInfo>()
  const visit = (node: TreeNode): number => {
    let talkCount = node.talks.length
    for (const child of node.children) talkCount += visit(child)
    if (node.path) index.set(node.path, { node, talkCount })
    return talkCount
  }
  visit(view)
  return index
}

function spacerHeight(layout: WindowLayout, start: number, end: number): number {
  if (start >= end) return 0
  const top = start === layout.offsets.length ? layout.total : layout.offsets[start]
  const bottom = end === layout.offsets.length ? layout.total : layout.offsets[end]
  return bottom - top
}

export default function Tree({
  searching, query, rows, view, isEmptyVault,
  viewMode, naming, collapsed, focusKey, activeTalkPath, menuTalkPath, dragTopic,
  talkMeta, lastDelivered, pubFor, layout, mounted, containerRef, onScroll, cb
}: {
  searching: boolean
  query: string
  rows: RowRef[]
  view: TreeNode
  isEmptyVault: boolean
  viewMode: ViewMode
  naming: NamingMode
  collapsed: Set<string>
  focusKey: string | null
  activeTalkPath: string | null
  menuTalkPath: string | null
  dragTopic: string | null
  talkMeta: TalkMeta
  lastDelivered: Record<string, number>
  pubFor: (slug: string) => PubState
  layout: WindowLayout
  mounted: Set<number>
  containerRef: React.RefObject<HTMLDivElement>
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void
  cb: TreeCallbacks
}) {
  const folders = folderIndex(view)

  function renderTalk(row: Extract<RowRef, { kind: 'talk' }>): JSX.Element {
    const { talk, depth, key } = row
    const meta = talkMeta[talk.slug]
    const shared = {
      talk, depth,
      selected: activeTalkPath === talk.outlinePath,
      focused: focusKey === key,
      menuAnchor: menuTalkPath === talk.outlinePath,
      warningCount: meta?.warningCount ?? 0,
      pathwayCount: meta?.pathwayCount ?? 0,
      pathwayNames: meta?.pathwayNames ?? [],
      pub: pubFor(talk.slug),
      label: displayName(talk, naming),
      fileMode: naming === 'file',
      rowRef: cb.setRowRef(key),
      onOpen: () => cb.onOpenTalk(talk, key),
      onContextMenu: (e: React.MouseEvent) => cb.onTalkContext(talk, key, e),
      onDragStart: () => cb.onDragStartTalk(talk, key),
      onDragEnd: cb.onDragEndTalk
    }
    return viewMode === 'ledger'
      ? <LedgerRow key={key} {...shared} slideCount={meta?.slideCount ?? null} />
      : <ShelfRow key={key} {...shared} slideCount={meta?.slideCount ?? null} coverKey={meta?.coverKey ?? null} deliveredMs={lastDelivered[talk.slug]} editedMs={meta?.editedMs} event={naming === 'title' ? meta?.event ?? null : null} />
  }

  function renderFolder(row: Extract<RowRef, { kind: 'folder' }>): JSX.Element {
    const info = folders.get(row.path)
    const name = info?.node.name ?? row.path.split('/').pop() ?? row.path
    const isCollapsed = collapsed.has(row.path)
    const shared = {
      name,
      path: row.path,
      expanded: !isCollapsed,
      focused: focusKey === row.key,
      talkCount: info?.talkCount ?? 0,
      isDropTarget: dragTopic === row.path,
      rowRef: cb.setRowRef(row.key),
      onToggle: () => cb.onToggleFolder(row.path, row.key),
      onContextMenu: (e: React.MouseEvent) => cb.onFolderContext(row.path, row.key, e),
      onDragOver: (e: React.DragEvent) => cb.onFolderDragOver(row.path, e),
      onDragLeave: (e: React.DragEvent) => cb.onFolderDragLeave(row.path, e),
      onDrop: (e: React.DragEvent) => cb.onFolderDrop(row.path, e)
    }
    return row.depth === 0
      ? <FolderHeader key={row.key} {...shared} />
      : <FolderRow key={row.key} {...shared} depth={row.depth} onDrill={() => cb.onDrill(row.path)} />
  }

  function renderRow(index: number): JSX.Element {
    const row = rows[index]
    return row.kind === 'talk' ? renderTalk(row) : renderFolder(row)
  }

  return (
    <div
      ref={containerRef}
      className="tl-tree"
      role="tree"
      aria-label="Talks"
      onScroll={onScroll}
      onDragOver={cb.onTreeDragOver}
      onDrop={cb.onTreeDrop}
    >
      {searching && rows.length === 0 ? (
        <div className="tl-empty">No talks match “{query}”.</div>
      ) : isEmptyVault ? (
        <div className="tl-empty">No talks found in vault.</div>
      ) : layout.groups.map((group) => {
        const indices = [...mounted]
          .filter((index) => index >= group.start && index < group.end)
          .sort((a, b) => a - b)
        const content: React.ReactNode[] = []
        let cursor = group.start
        for (const index of indices) {
          const gap = spacerHeight(layout, cursor, index)
          if (gap > 0) content.push(<div key={`gap-${cursor}-${index}`} className="tl-window-spacer" style={{ height: gap }} aria-hidden />)
          content.push(renderRow(index))
          cursor = index + 1
        }
        const bottomGap = spacerHeight(layout, cursor, group.end)
        if (bottomGap > 0) content.push(<div key={`gap-${cursor}-${group.end}`} className="tl-window-spacer" style={{ height: bottomGap }} aria-hidden />)
        return <div className="tl-window-group" key={group.headerIndex == null ? `root-${group.start}` : rows[group.headerIndex].key}>{content}</div>
      })}
    </div>
  )
}
