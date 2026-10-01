import type { TalkInfo, TalkMeta, VaultView } from '../../../../preload/index'
import type { TreeNode } from '../talkTreeNav'
import { ARCHIVE_FOLDER, ARCHIVE_LABEL, collapseId, displayName, folderTotals, type NamingMode, type PubState, type RowRef, type ViewMode } from './model'
import { VaultCompact, VaultEmpty, VaultHeader } from './VaultRows'
import { rowVaultId } from './vaultSections'
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
  // Folder callbacks carry the vault the folder belongs to (paths are vault-relative).
  onToggleFolder: (path: string, key: string, vaultId?: string) => void
  onFolderContext: (path: string, key: string, e: React.MouseEvent, vaultId?: string) => void
  onDrill: (path: string, vaultId?: string) => void
  onToggleVault: (vaultId: string, key: string) => void
  onVaultMenu: (vaultId: string, key: string, e: React.MouseEvent) => void
  onNewTalkIn: (vaultId: string) => void
  /** The unavailable note's one action (open the service, or check again). */
  onUnavailableAction?: (vaultId: string) => void
  /** A one-line vault row was clicked: show that vault. */
  onShowVault?: (vaultId: string) => void
  /** Talks per vault, for the "N hidden" note on one-line rows. */
  hiddenCount?: (vaultId: string) => number
  onDragStartTalk: (talk: TalkInfo, key: string) => void
  onDragEndTalk: () => void
  onFolderDragOver: (path: string, e: React.DragEvent, vaultId?: string) => void
  onFolderDragLeave: (path: string, e: React.DragEvent, vaultId?: string) => void
  onFolderDrop: (path: string, e: React.DragEvent, vaultId?: string) => void
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
  rows, trees, vaults, sectionCollapsed, isEmptyVault,
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
  /** Each open vault's whole folder tree, by vault id (display metadata only). */
  trees: Map<string, TreeNode>
  vaults: VaultView[]
  /** Vaults whose section is folded to its header. */
  sectionCollapsed: Set<string>
  isEmptyVault: boolean
  viewMode: ViewMode
  naming: NamingMode
  /** Folder ids (collapseId) that are closed. */
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
  const folderIndexes = new Map<string, Map<string, FolderInfo>>()
  for (const [id, tree] of trees) folderIndexes.set(id, folderIndex(tree))
  const vaultById = new Map(vaults.map((v) => [v.id, v]))

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
    const info = folderIndexes.get(row.vaultId ?? '')?.get(row.path)
    const name = info?.node.name ?? row.path.split('/').pop() ?? row.path
    const isCollapsed = collapsed.has(collapseId(row.vaultId, row.path))
    const shared = {
      name,
      path: row.path,
      expanded: !isCollapsed,
      focused: focusKey === row.key,
      talkCount: info?.talkCount ?? 0,
      isDropTarget: dragTopic === collapseId(row.vaultId, row.path),
      rowRef: cb.setRowRef(row.key),
      onToggle: () => cb.onToggleFolder(row.path, row.key, row.vaultId),
      onContextMenu: (e: React.MouseEvent) => cb.onFolderContext(row.path, row.key, e, row.vaultId),
      onDragOver: (e: React.DragEvent) => cb.onFolderDragOver(row.path, e, row.vaultId),
      onDragLeave: (e: React.DragEvent) => cb.onFolderDragLeave(row.path, e, row.vaultId),
      onDrop: (e: React.DragEvent) => cb.onFolderDrop(row.path, e, row.vaultId)
    }
    return row.depth === 0
      ? row.path === ARCHIVE_FOLDER
        ? <FolderHeader key={row.key} {...shared} name={ARCHIVE_LABEL} archive />
        : <FolderHeader key={row.key} {...shared} />
      : <FolderRow key={row.key} {...shared} depth={row.depth} onDrill={() => cb.onDrill(row.path, row.vaultId)} />
  }

  function renderRow(index: number): JSX.Element {
    const row = rows[index]
    if (row.kind === 'vault' || row.kind === 'empty') {
      const vault = vaultById.get(row.vaultId)
      if (!vault) return <div key={row.key} />
      if (row.kind === 'vault' && row.compact) {
        return <VaultCompact key={row.key} vault={vault} hidden={cb.hiddenCount?.(vault.id) ?? 0} focused={focusKey === row.key}
          rowRef={cb.setRowRef(row.key)} onShow={() => cb.onShowVault?.(vault.id)} />
      }
      return row.kind === 'vault'
        ? <VaultHeader key={row.key} vault={vault} expanded={!sectionCollapsed.has(vault.id)} focused={focusKey === row.key}
            rowRef={cb.setRowRef(row.key)} onToggle={() => cb.onToggleVault(vault.id, row.key)} onMenu={(e) => cb.onVaultMenu(vault.id, row.key, e)} />
        : <VaultEmpty key={row.key} vault={vault} focused={focusKey === row.key} rowRef={cb.setRowRef(row.key)} onNewTalk={() => cb.onNewTalkIn(vault.id)} onUnavailableAction={cb.onUnavailableAction} />
    }
    return row.kind === 'talk' ? renderTalk(row) : renderFolder(row)
  }
  // The colour rail: every row of a vault's section carries that vault's colour on its left edge.
  function groupColor(start: number): string | undefined {
    const row = rows[start]
    if (!row || vaults.length === 0) return undefined
    const id = rowVaultId(row, vaults)
    const vault = id ? vaultById.get(id) : undefined
    return vault ? (vault.open && !vault.unavailable ? vault.color : '#cfcabd') : undefined
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
        const color = searching ? undefined : groupColor(group.start)
        return (
          <div
            className={`tl-window-group${color ? ' tl-window-group--vault' : ''}`}
            style={color ? ({ '--vc': color } as React.CSSProperties) : undefined}
            key={group.headerIndex == null ? `root-${group.start}` : rows[group.headerIndex].key}
          >{content}</div>
        )
      })}
    </div>
  )
}
