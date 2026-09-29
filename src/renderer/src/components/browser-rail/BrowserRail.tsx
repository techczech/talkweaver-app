// The unified Slide Browser rail (ADR-0009): Find a talk + Search slides (ADR-0029 §4) → Scope →
// Browse → Filters, stacked collapsible groups that COMPOSE (no modes). Scope is full-width rows
// (Find a talk's own picks also show as chips in its box, as ADR-0029 draws); the Files tree is
// disk truth; lenses live in Collections; filters follow the ADR-0037 chip grammar. Group collapse
// + the Browse tab persist via localStorage across openings.
import { useEffect, useState } from 'react'
import { ChevronDown, Clock, Filter, Folder, FolderTree, Frame, Search, X } from 'lucide-react'
import { scopeDisplayName, scopeKeyOf } from './railModel'
import type { FsubKey } from './FilterGroups'
import FilterGroups from './FilterGroups'
import { Collections, FilesTree } from './BrowseTabs'
import FindTalk, { type FindTalkProps } from './FindTalk'
import type {
  CollectionRow, ContentItem, FacetItem, RailFacets, ScopeEntry, ScopeFn,
  ToggleFacetFn
} from './railTypes'
import type { FilesTreeSource } from './filesTreeModel'

const RAIL_STATE_KEY = 'tw-browser-rail-v1'

interface RailUiState {
  browse: boolean
  filters: boolean
  fsubs: Record<FsubKey, boolean>
  tab: 'files' | 'coll'
}

const DEFAULT_UI: RailUiState = {
  browse: true,
  filters: true,
  fsubs: { lay: true, ct: true, tags: true, secs: true },
  tab: 'files'
}

function readRailState(): RailUiState {
  try {
    const raw = window.localStorage.getItem(RAIL_STATE_KEY)
    if (!raw) return DEFAULT_UI
    const p = JSON.parse(raw) as Partial<RailUiState>
    return {
      browse: p.browse !== false,
      filters: p.filters !== false,
      fsubs: { ...DEFAULT_UI.fsubs, ...(p.fsubs ?? {}) },
      tab: p.tab === 'coll' ? 'coll' : 'files'
    }
  } catch {
    return DEFAULT_UI
  }
}

export interface BrowserRailProps {
  inputRef: React.RefObject<HTMLInputElement | null>
  query: string
  onQueryChange: (q: string) => void
  /** "Find a talk" (ADR-0029 §4): its query, results and the chips it keeps in the scope. */
  find: FindTalkProps
  /** Find a talk has words typed or a talk picked: the Files tree dims under it (K3, K4). */
  findActive: boolean
  /** The active talk's slug — its rows render dimmed + "current" in Files/Collections and
   *  never scope (the Browser never shows its slides; the tree still tells disk truth). */
  currentTalkSlug: string
  scope: ScopeEntry[]
  scopeCounts: number[]
  coverUrlFor: (e: ScopeEntry) => string | null
  onScope: ScopeFn
  onRemoveScope: (index: number) => void
  onClearScope: () => void
  /** The Files tab's source: the file list's tree, drawn with slide counts (ADR-0029 §4). */
  filesSource: FilesTreeSource
  recentEdits: CollectionRow[]
  deliveries: CollectionRow[]
  facets: RailFacets
  layoutItems: FacetItem[]
  contentItems: ContentItem[]
  tagItems: FacetItem[]
  sectionItems: FacetItem[]
  onToggleFacet: ToggleFacetFn
  onClearFacets: () => void
  anyFacetOn: boolean
}

export default function BrowserRail(props: BrowserRailProps) {
  const [ui, setUi] = useState<RailUiState>(readRailState)
  useEffect(() => {
    try { window.localStorage.setItem(RAIL_STATE_KEY, JSON.stringify(ui)) } catch { /* ignore */ }
  }, [ui])

  const scopedKeys = new Set(props.scope.map(scopeKeyOf))
  const isScoped = (key: string): boolean => scopedKeys.has(key)

  const toggleGroup = (g: 'browse' | 'filters'): void => setUi((s) => ({ ...s, [g]: !s[g] }))
  const toggleFsub = (id: FsubKey): void =>
    setUi((s) => ({ ...s, fsubs: { ...s.fsubs, [id]: !s.fsubs[id] } }))
  const setTab = (tab: 'files' | 'coll'): void => setUi((s) => ({ ...s, tab }))

  // Active filters hidden by a COLLAPSED Filters group still surface as a headline count
  // (the collapsed-is-never-invisible rule, one level up from the sub-group badges).
  const facetTotal =
    props.facets.tagSet.size + props.facets.sectionSet.size +
    props.facets.layoutSet.size + props.facets.contentSet.size

  return (
    <>
      {/* 1 · FIND A TALK above SEARCH SLIDES (ADR-0029 §4; frames K1–K4). Find a talk is the file
          list's talk search and scopes; the slide search finds slides only (no talk-name hits). */}
      <div className="lt-rgroup">
        <FindTalk {...props.find} />
        <div className="lt-rghead static lt-slides-label">
          <Search className="lt-icon" /> Search slides
        </div>
        <div className="lt-rail-search">
          <div className="lt-searchfield rail">
            <Search className="lt-icon" />
            <input
              ref={props.inputRef}
              type="text"
              value={props.query}
              onChange={(e) => props.onQueryChange(e.target.value)}
              placeholder="Words on slides — all words match"
              autoComplete="off"
              aria-label="Search slides — t: title · s: slide · e: exact · i: image text"
              title="t: title · s: slide body · e: exact phrase · i: image text"
            />
            <kbd>⌘S</kbd>
          </div>
        </div>
      </div>

      {/* 2 · SCOPE — full-width rows (cover + title + kind + count + ×); hidden when empty */}
      {props.scope.length > 0 && (
        <div className="lt-rgroup">
          <div className="lt-rghead static">
            <Frame className="lt-icon" /> Scope
            <span className="lt-gsum">{props.scope.length} pinned</span>
          </div>
          <div>
            {props.scope.map((e, i) => {
              const nm = scopeDisplayName(e)
              const cover = props.coverUrlFor(e)
              const initial = (e.kind === 'folder' ? (e.folder ?? '') : (e.talkTitle ?? e.talk ?? ''))
                .replace(/[^a-z0-9]/gi, '').charAt(0).toUpperCase() || '·'
              return (
                <div key={scopeKeyOf(e)} className="lt-scope-row">
                  <span className={`lt-scope-cover${e.kind === 'folder' ? ' fold' : ''}`}>
                    {cover
                      ? <img src={cover} alt="" loading="lazy" decoding="async" />
                      : e.kind === 'section' ? '§' : initial}
                  </span>
                  <span className="lt-scope-body">
                    <span className="lt-scope-nm" title={nm}>{nm}</span>
                    <span className="lt-scope-kind">
                      {e.kind} · <span className="lt-cc">{props.scopeCounts[i] ?? 0} slides</span>
                    </span>
                  </span>
                  <button
                    type="button"
                    className="lt-scope-rm"
                    title="Remove from scope"
                    aria-label={`Remove ${nm} from scope`}
                    onClick={() => props.onRemoveScope(i)}
                  >
                    <X className="lt-icon" />
                  </button>
                </div>
              )
            })}
            <button type="button" className="lt-scope-clear" onClick={props.onClearScope}>
              <X className="lt-icon" /> Clear scope <kbd>⌫</kbd>
            </button>
          </div>
        </div>
      )}

      {/* 3 · BROWSE — Files (disk truth) | Collections (lenses) */}
      <div className={`lt-rgroup${ui.browse ? '' : ' closed'}`}>
        <button type="button" className="lt-rghead" aria-expanded={ui.browse} onClick={() => toggleGroup('browse')}>
          <FolderTree className="lt-icon" /> Browse
          <ChevronDown className="lt-icon lt-chev" />
        </button>
        {ui.browse && (
          <div className={props.findActive ? 'lt-browse-dim' : undefined}>
            <div className="lt-btabs" role="tablist" aria-label="Browse by">
              <button type="button" role="tab" aria-selected={ui.tab === 'files'} className={ui.tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>
                <Folder className="lt-icon" /> Files
              </button>
              <button type="button" role="tab" aria-selected={ui.tab === 'coll'} className={ui.tab === 'coll' ? 'on' : ''} onClick={() => setTab('coll')}>
                <Clock className="lt-icon" /> Collections
              </button>
            </div>
            {ui.tab === 'files'
              ? <FilesTree source={props.filesSource} isScoped={isScoped} onScope={props.onScope} />
              : <Collections recent={props.recentEdits} delivered={props.deliveries} isScoped={isScoped} onScope={props.onScope} currentTalkSlug={props.currentTalkSlug} />}
          </div>
        )}
      </div>

      {/* 4 · FILTERS — Layout → Content → Tags → Sections */}
      <div className={`lt-rgroup${ui.filters ? '' : ' closed'}`}>
        <button type="button" className="lt-rghead" aria-expanded={ui.filters} onClick={() => toggleGroup('filters')}>
          <Filter className="lt-icon" /> Filters
          {!ui.filters && facetTotal > 0 && <span className="lt-fbadge">{facetTotal}</span>}
          <ChevronDown className="lt-icon lt-chev" />
        </button>
        {ui.filters && (
          <FilterGroups
            facets={props.facets}
            layoutItems={props.layoutItems}
            contentItems={props.contentItems}
            tagItems={props.tagItems}
            sectionItems={props.sectionItems}
            onToggle={props.onToggleFacet}
            onClearFacets={props.onClearFacets}
            anyActive={props.anyFacetOn}
            scopeActive={props.scope.length > 0}
            fsubOpen={ui.fsubs}
            onToggleFsub={toggleFsub}
          />
        )}
      </div>

      <div className="lt-rail-foot">
        Search finds · Scope pins places · Browse walks them · Filters narrow by property. All four compose.
      </div>
    </>
  )
}
