import type { ReactNode } from 'react'
import { breadcrumbCrumbs } from '../talkTreeNav'
import { TALK_QUERY_HELP } from '../../../../shared/talk-query'
import type { ViewMode } from './model'
import { IcLedger, IcShelf, IcFilePlus, IcFolderPlus, IcSort, IcCollapse, IcRefresh, IcSwap, IcSearch, IcClear } from './icons'

// The Talks browser's chrome above the tree: toolbar (label · Ledger⇄Shelf switch · actions),
// the filter box with its hint row / completion (`assist`, SearchAssist.tsx), and the drill-in
// breadcrumb. Pure presentation — all state lives upstream.
export default function PanelHeader({
  viewMode, onSetViewMode,
  onNewTalk, onNewFolder, onToggleSort, sortOpen, sortBtnRef,
  onCollapseAll, onRefresh, onChangeVault,
  query, onQueryChange, searchRef, onSearchKeyDown,
  onSearchFocus, onSearchBlur, onSearchSelect, assist,
  focusPath, onFocusPath, rootLabel = 'Vault', showSlot
}: {
  viewMode: ViewMode
  onSetViewMode: (mode: ViewMode) => void
  onNewTalk: () => void
  onNewFolder: () => void
  onToggleSort: (e: React.MouseEvent) => void
  sortOpen: boolean
  sortBtnRef: React.RefObject<HTMLButtonElement>
  onCollapseAll: () => void
  onRefresh: () => void
  onChangeVault: () => void
  query: string
  /** `caret`: where the caret is after the change (completion works on the token before it). */
  onQueryChange: (value: string, caret?: number | null) => void
  searchRef: React.RefObject<HTMLInputElement>
  onSearchKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  onSearchFocus?: () => void
  onSearchBlur?: () => void
  onSearchSelect?: (caret: number | null) => void
  /** Under the box: the prefix hint row (L3) or the completion list (L4). */
  assist?: ReactNode
  focusPath: string
  onFocusPath: (path: string) => void
  /** The crumb that leaves the drill-in: the drilled vault's name ("Vault" for a single tree). */
  rootLabel?: string
  /** "Show: All vaults" (ticket 07), under the search and its assist. */
  showSlot?: ReactNode
}) {
  return (
    <>
      <div className="tl-toolbar">
        <span className="tl-label"><IcLedger size={13} />Talks</span>
        <span className="tl-modeswitch" role="group" aria-label="View mode">
          <button className="tl-tbtn" title="Ledger view (v)" aria-label="Ledger view" aria-pressed={viewMode === 'ledger'} onClick={() => onSetViewMode('ledger')}><IcLedger /></button>
          <button className="tl-tbtn" title="Shelf view (v)" aria-label="Shelf view" aria-pressed={viewMode === 'shelf'} onClick={() => onSetViewMode('shelf')}><IcShelf /></button>
        </span>
        <button className="tl-tbtn" title="New talk" aria-label="New talk" onClick={onNewTalk}><IcFilePlus /></button>
        <button className="tl-tbtn" title="New folder" aria-label="New folder" onClick={onNewFolder}><IcFolderPlus /></button>
        <span className="tl-sep" />
        <button ref={sortBtnRef} className={`tl-tbtn ${sortOpen ? 'tl-tbtn--open' : ''}`} title="Sort (s)" aria-label="Sort" aria-expanded={sortOpen} data-talklist-sort onClick={onToggleSort}><IcSort /></button>
        <button className="tl-tbtn" title="Collapse all folders" aria-label="Collapse all folders" onClick={onCollapseAll}><IcCollapse /></button>
        <button className="tl-tbtn" title="Refresh" aria-label="Refresh" onClick={onRefresh}><IcRefresh /></button>
        <button className="tl-tbtn" title="Add vault…" aria-label="Add vault" onClick={onChangeVault}><IcSwap /></button>
      </div>

      <div className="tl-searchrow">
        <div className={`tl-search ${query ? 'tl-search--has-value' : ''}`}>
          <span className="tl-search-glyph"><IcSearch size={12} /></span>
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value, e.target.selectionStart)}
            onKeyDown={onSearchKeyDown}
            onFocus={onSearchFocus}
            onBlur={onSearchBlur}
            onSelect={(e) => onSearchSelect?.(e.currentTarget.selectionStart)}
            placeholder="Search talks…"
            title={TALK_QUERY_HELP}
            aria-label="Filter talks"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="tl-search-slash">/</span>
          <button className="tl-search-clear" title="Clear filter (Esc)" aria-label="Clear filter" onClick={() => { onQueryChange(''); searchRef.current?.focus() }}><IcClear size={11} /></button>
        </div>
      </div>
      {assist}
      {showSlot}

      {focusPath && (
        <nav className="tl-crumbs" aria-label="Location">
          <button onClick={() => onFocusPath('')}>{rootLabel}</button>
          {breadcrumbCrumbs(focusPath).map((c, i, arr) => (
            <span key={c.path}>
              <span className="tl-crumbs-sep">›</span>
              {i === arr.length - 1
                ? <span className="tl-crumbs-here">{c.name}</span>
                : <button onClick={() => onFocusPath(c.path)}>{c.name}</button>}
            </span>
          ))}
        </nav>
      )}
    </>
  )
}
