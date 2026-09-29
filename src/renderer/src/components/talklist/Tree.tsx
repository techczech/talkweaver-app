import type { TalkInfo, TalkMeta } from '../../../../preload/index'
import type { TreeNode } from '../talkTreeNav'
import { ARCHIVE_FOLDER, ARCHIVE_LABEL, displayName, folderTotals, type NamingMode, type PubState, type RowRef, type ViewMode } from './model'
import type { WindowLayout } from './window'
import LedgerRow from './LedgerRow'
import ShelfRow from './ShelfRow'
import { FolderHeader, FolderRow } from './FolderRows'
import type { Suggestion } from './prefixAssist'

// The scrolling tree renders the exact RowRef[] used by keyboard navigation. Folder-tree
// traversal below only indexes display metadata; it never derives render order.
export interface TreeCallbacks {
  setRowRef: (key: string) => (el: HTMLDivElement | null) => void
  onOpenTalk: (talk: TalkInfo, key: string) => void
  // Hover intent for the preview card (T29): rows report enter/leave, TalkList feeds the model.
  onRowEnter: (talk: TalkInfo, key: string) => void
  onRowLeave: (key: string) => void
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

// Display metadata per folder: its node and its talk total, subfolders included (the shared
// tree's 'talks' count mode; the slide picker uses 'slides').
function folderIndex(view: TreeNode): Map<string, FolderInfo> {
  const totals = folderTotals(view, 'talks')
  const index = new Map<string, FolderInfo>()
  const visit = (node: TreeNode): void => {
    if (node.path) index.set(node.path, { node, talkCount: totals.get(node.path) ?? 0 })
    node.children.forEach(visit)
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
  searching, query, searchSettled = true, focusPath = '', everywhereCount = null, onSearchEverywhere,
  suggestions = [], onSuggest,
  rows, view, isEmptyVault,
  viewMode, naming, collapsed, focusKey, activeTalkPath, menuTalkPath, dragTopic,
  talkMeta, lastDelivered, pubFor, sharedFor = () => false, feedbackCountFor = () => 0, layout, mounted, containerRef, onScroll, cb
}: {
  searching: boolean
  query: string
  /** False while the first result for the typed query is still on its way (no "No talks match" flash). */
  searchSettled?: boolean
  focusPath?: string
  /** With a drilled-in folder: how many talks match everywhere (offered when none match here). */
  everywhereCount?: number | null
  onSearchEverywhere?: () => void
  /** Under "No talks match" (L8): the nearest folder, "Drop <term>", slide text. */
  suggestions?: Suggestion[]
  onSuggest?: (query: string) => void
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
  /** Share for comments: whether the talk has an active share (matched by path, not name). */
  sharedFor?: (talk: TalkInfo) => boolean
  /** Feedback rail: unread feedback items for the talk's share (0 when none or not shared). */
  feedbackCountFor?: (talk: TalkInfo) => number
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
      hit: row.hit,
      focusPath,
      selected: activeTalkPath === talk.outlinePath,
      focused: focusKey === key,
      menuAnchor: menuTalkPath === talk.outlinePath,
      warningCount: meta?.warningCount ?? 0,
      pathwayCount: meta?.pathwayCount ?? 0,
      pathwayNames: meta?.pathwayNames ?? [],
      pub: pubFor(talk.slug),
      shared: sharedFor(talk),
      feedbackCount: feedbackCountFor(talk),
      label: displayName(talk, naming),
      fileMode: naming === 'file',
      rowKey: key,
      rowRef: cb.setRowRef(key),
      onOpen: () => cb.onOpenTalk(talk, key),
      onHoverEnter: () => cb.onRowEnter(talk, key),
      onHoverLeave: () => cb.onRowLeave(key),
      onContextMenu: (e: React.MouseEvent) => cb.onTalkContext(talk, key, e),
      onDragStart: () => cb.onDragStartTalk(talk, key),
      onDragEnd: cb.onDragEndTalk
    }
    return viewMode === 'ledger'
      ? <LedgerRow key={key} {...shared} slideCount={meta?.slideCount ?? null} line={row.line} />
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
      ? row.path === ARCHIVE_FOLDER
        ? <FolderHeader key={row.key} {...shared} name={ARCHIVE_LABEL} archive />
        : <FolderHeader key={row.key} {...shared} />
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
        searchSettled ? (
          <div className="tl-empty tl-empty--search">
            <p>No talks match <b>“{query}”</b>.</p>
            {everywhereCount != null && everywhereCount > 0 && onSearchEverywhere && (
              <p className="tl-empty-sugg"><button type="button" className="tl-res-wide" onClick={onSearchEverywhere}>Search everywhere ({everywhereCount})</button></p>
            )}
            {suggestions.map((s) => (
              <p key={s.key} className="tl-empty-sugg" data-suggestion={s.kind}>
                {s.kind === 'folder' ? (
                  <>Did you mean folder <button type="button" className="tl-res-wide" onClick={() => onSuggest?.(s.query)}>{s.name}</button>? · {s.count} {s.count === 1 ? 'talk' : 'talks'}</>
                ) : (
                  <button type="button" className="tl-res-wide" onClick={() => onSuggest?.(s.query)}>{s.label}</button>
                )}
              </p>
            ))}
          </div>
        ) : null
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
