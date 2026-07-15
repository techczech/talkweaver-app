import { breadcrumbCrumbs } from '../talkTreeNav'
import type { ViewMode } from './model'
import { IcLedger, IcShelf, IcFilePlus, IcFolderPlus, IcSort, IcCollapse, IcRefresh, IcSwap, IcSearch, IcClear } from './icons'

// The Talks browser's chrome above the tree: toolbar (label · Ledger⇄Shelf switch · actions),
// the filter box, and the drill-in breadcrumb. Pure presentation — all state lives upstream.
export default function PanelHeader({
  viewMode, onSetViewMode,
  onNewTalk, onNewFolder, onToggleSort, sortOpen, sortBtnRef,
  onCollapseAll, onRefresh, onChangeVault,
  query, onQueryChange, searchRef, onSearchKeyDown,
  focusPath, onFocusPath
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
  onQueryChange: (value: string) => void
  searchRef: React.RefObject<HTMLInputElement>
  onSearchKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  focusPath: string
  onFocusPath: (path: string) => void
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
        <button className="tl-tbtn" title="Change vault" aria-label="Change vault" onClick={onChangeVault}><IcSwap /></button>
      </div>

      <div className="tl-searchrow">
        <div className={`tl-search ${query ? 'tl-search--has-value' : ''}`}>
          <span className="tl-search-glyph"><IcSearch size={12} /></span>
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="Filter talks…"
            aria-label="Filter talks"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="tl-search-slash">/</span>
          <button className="tl-search-clear" title="Clear filter (Esc)" aria-label="Clear filter" onClick={() => { onQueryChange(''); searchRef.current?.focus() }}><IcClear size={11} /></button>
        </div>
      </div>

      {focusPath && (
        <nav className="tl-crumbs" aria-label="Location">
          <button onClick={() => onFocusPath('')}>Vault</button>
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
