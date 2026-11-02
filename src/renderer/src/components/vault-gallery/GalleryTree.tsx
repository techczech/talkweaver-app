import { ChevronDown, ChevronRight, Folder, HardDrive, Library, Files, Plus, Archive, Unplug } from 'lucide-react'
import type { GalleryCatalogue } from '../../../../shared/vault-gallery'
import { folderPaths, inspectOnlyPath, treeNodes, type BrowseScope } from '../../../../shared/vault-gallery-browse'
import type { VaultView } from '../../../../preload'
import { UI } from './galleryItems'

interface Props {
  catalogue: GalleryCatalogue
  vaults?: VaultView[]
  foldersByVault: Record<string, string[]>
  vaultId: string | null
  browsing: boolean
  scope: BrowseScope
  expandedVaults: ReadonlySet<string>
  expandedFolders: ReadonlySet<string>
  toggleVault(id: string): void
  toggleFolder(path: string): void
  chooseOverview(): void
  chooseVault(id: string): void
  chooseFolder(id: string, path: string): void
  chooseAll(id: string): void
  showSystem: boolean
  setShowSystem(v: boolean): void
  addVault?(): void
}
function treeKey(e: React.KeyboardEvent, expandable: boolean, expanded: boolean, toggle: () => void) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const items = Array.from((e.currentTarget as HTMLElement).closest('[role="tree"]')?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])
    const at = items.indexOf(e.currentTarget as HTMLElement), next = items[at + (e.key === 'ArrowDown' ? 1 : -1)]
    if (next) { e.preventDefault(); next.focus() }
  } else if (expandable && ((e.key === 'ArrowRight' && !expanded) || (e.key === 'ArrowLeft' && expanded))) { e.preventDefault(); toggle() }
}
/** The one navigation surface: vaults, All talks and the folder tree of the selected vault. */
export default function GalleryTree(p: Props) {
  const stateOf = (id: string): 'open' | 'closed' | 'unavailable' => {
    const v = p.vaults?.find(item => item.id === id)
    const c = p.catalogue.vaults.find(item => item.id === id)
    return c?.status === 'closed' || v?.open === false ? 'closed' : c?.status === 'unavailable' || v?.unavailable ? 'unavailable' : 'open'
  }
  return <>
    <div className="vg-tree" role="tree" aria-label="Vaults and folders">
      <button role="treeitem" aria-level={1} aria-selected={!p.browsing} className={`vg-tr ${!p.browsing ? 'here' : ''}`} onClick={p.chooseOverview}><span className="vg-tw" /><Library size={16} className="vg-ic" /><span className="vg-nm">{UI.allVaults}</span></button>
      {p.catalogue.vaults.map(v => {
        const state = stateOf(v.id), here = v.id === p.vaultId, open = here && p.expandedVaults.has(v.id) && state === 'open'
        const folders = here ? folderPaths(v.talks, p.foldersByVault[v.id] ?? []).filter(f => p.showSystem || !inspectOnlyPath(f)) : []
        const nodes = open ? treeNodes(v.talks, folders, p.expandedFolders) : []
        return <div key={v.id} role="group" aria-label={v.name}>
          <div className="vg-trrow">
            <button role="treeitem" aria-level={1} aria-expanded={state === 'open' ? open : undefined} aria-selected={here && p.browsing && p.scope.kind === 'folder' && p.scope.path === ''} className={`vg-tr ${here && p.browsing && p.scope.kind === 'folder' && !p.scope.path ? 'here' : ''} ${state !== 'open' ? 'dim' : ''}`} onClick={() => p.chooseVault(v.id)} onKeyDown={e => treeKey(e, state === 'open', open, () => p.toggleVault(v.id))}>
              <span className="vg-tw" onClick={e => { if (state === 'open') { e.stopPropagation(); p.toggleVault(v.id) } }}>{state === 'open' ? (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}</span>
              {state === 'unavailable' ? <Unplug size={16} className="vg-ic" /> : <HardDrive size={16} className="vg-ic" />}
              <span className="vg-nm">{v.name}</span>
              <span className="vg-ct">{state === 'closed' ? 'Closed' : state === 'unavailable' ? 'Not connected' : v.status === 'stale' ? v.talks.length.toLocaleString() : ''}</span>
            </button>
          </div>
          {open && <>
            <button role="treeitem" aria-level={2} aria-selected={p.browsing && p.scope.kind === 'all'} className={`vg-tr lvl2 ${p.browsing && p.scope.kind === 'all' ? 'here' : ''}`} onClick={() => p.chooseAll(v.id)}><span className="vg-tw" /><Files size={16} className="vg-ic" /><span className="vg-nm">{UI.allTalks}</span><span className="vg-ct">{v.talks.length.toLocaleString()}</span></button>
            {nodes.map(n => {
              const selected = p.browsing && p.scope.kind === 'folder' && p.scope.path === n.path
              return <button key={n.path} role="treeitem" aria-level={n.depth + 1} aria-expanded={n.hasChildren ? n.expanded : undefined} aria-selected={selected} className={`vg-tr ${selected ? 'here' : ''}`} style={{ paddingLeft: 4 + n.depth * 12 }} onClick={() => p.chooseFolder(v.id, n.path)} onKeyDown={e => treeKey(e, n.hasChildren, n.expanded, () => p.toggleFolder(n.path))}>
                <span className="vg-tw" onClick={e => { if (n.hasChildren) { e.stopPropagation(); p.toggleFolder(n.path) } }}>{n.hasChildren ? (n.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}</span>
                <Folder size={16} className="vg-ic vg-ic-folder" /><span className="vg-nm" title={n.path}>{n.name}</span><span className="vg-ct" title="Known talks, including subfolders">{n.count.toLocaleString()}</span>
              </button>
            })}
          </>}
        </div>
      })}
    </div>
    <div className="vg-sbfoot">
      {p.addVault && <button onClick={p.addVault}><Plus size={16} />{UI.addVault}</button>}
      <button aria-pressed={p.showSystem} onClick={() => p.setShowSystem(!p.showSystem)}><Archive size={16} />{p.showSystem ? UI.hideSystem : UI.showSystem}</button>
    </div>
  </>
}
