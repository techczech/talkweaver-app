import { ChevronDown, ChevronUp, HardDrive, Unplug } from 'lucide-react'
import type { GalleryCatalogue } from '../../../../shared/vault-gallery'
import type { VaultView } from '../../../../preload'
import type { SortKey, SortState } from '../../../../shared/vault-gallery-browse'
import { compareNames } from '../../../../shared/vault-gallery-browse'

export const vaultState = (catalogue: GalleryCatalogue, vaults: VaultView[] | undefined, id: string): 'open' | 'closed' | 'unavailable' => {
  const v = vaults?.find(item => item.id === id), c = catalogue.vaults.find(item => item.id === id)
  return c?.status === 'closed' || v?.open === false ? 'closed' : c?.status === 'unavailable' || v?.unavailable ? 'unavailable' : 'open'
}
const statusText = { open: 'Open', closed: 'Closed', unavailable: 'Not connected' }
/** All vaults: one row per vault. Counts the catalogue cannot give stay Unknown. */
export default function GalleryOverview({ catalogue, vaults, vaultId, query, sort, setSort, select, activate }: {
  catalogue: GalleryCatalogue; vaults?: VaultView[]; vaultId: string | null; query: string; sort: SortState | null; setSort(key: SortKey): void; select(id: string): void; activate(id: string): void
}) {
  const rows = catalogue.vaults.map(v => {
    const root = vaults?.find(item => item.id === v.id)?.root ?? ''
    const state = vaultState(catalogue, vaults, v.id)
    return { v, root, state, talks: state === 'open' && v.status === 'stale' ? v.talks.length : null }
  }).filter(r => !query.trim() || `${r.v.name} ${r.root}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
      .sort((a, b) => !sort ? 0 : (sort.dir === 'asc' ? 1 : -1) * (sort.key === 'location' ? compareNames(a.root, b.root) : sort.key === 'contents' ? (a.talks ?? -1) - (b.talks ?? -1) : sort.key === 'handouts' ? compareNames(statusText[a.state], statusText[b.state]) : compareNames(a.v.name, b.v.name)))
  const head: [SortKey, string, string][] = [['name', 'Name', 'c-name'], ['location', 'Location', 'c-loc'], ['contents', 'Talks', 'c-talks'], ['images', 'Files', 'c-files r'], ['size', 'Size on disk', 'c-size r'], ['handouts', 'Status', 'c-status']]
  const unk = <span className="vg-unk">Unknown</span>
  return <div className="vg-lst vaults" role="grid" aria-label="Vaults">
    <div role="row" className="vg-lhead">{head.map(([key, label, cls]) => <div key={key} role="columnheader" className={cls.split(' ').map(c => 'vg-' + c).join(' ')} aria-sort={sort?.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button className={sort?.key === key ? 'sorted' : ''} onClick={() => setSort(key)}>{label}{sort?.key === key && (sort.dir === 'asc' ? <ChevronUp size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />)}</button></div>)}</div>
    <div role="rowgroup" className="vg-rows">{rows.map(({ v, root, state, talks }, i) =>
      <div key={v.id} role="row" aria-selected={v.id === vaultId} aria-label={v.name} aria-rowindex={i + 2} tabIndex={v.id === vaultId || (!vaultId && i === 0) ? 0 : -1} className={`vg-row ${v.id === vaultId ? 'sel' : ''}`} onClick={() => select(v.id)} onDoubleClick={() => activate(v.id)}
        onKeyDown={e => {
          // SCAN_IGNORE: local grid navigation inside the modal gallery; not an app command.
          if (e.key === 'Enter') { e.preventDefault(); activate(v.id) }
          else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const next = rows[i + (e.key === 'ArrowDown' ? 1 : -1)]; if (next) { select(next.v.id); requestAnimationFrame(() => (e.currentTarget.parentElement?.querySelector(`[aria-label="${CSS.escape(next.v.name)}"]`) as HTMLElement | null)?.focus()) } }
        }}>
        <div role="gridcell" className="vg-c vg-c-name">{state === 'unavailable' ? <Unplug size={16} className="vg-ic vg-ic-sys" aria-hidden /> : <HardDrive size={16} className="vg-ic vg-ic-sys" aria-hidden />}<span className="vg-tx">{v.name}</span></div>
        <div role="gridcell" className="vg-c vg-c-loc" title={root}>{root || 'Location unknown'}</div>
        <div role="gridcell" className="vg-c">{talks == null ? unk : talks.toLocaleString()}</div>
        <div role="gridcell" className="vg-c vg-c-files vg-r">{unk}</div>
        <div role="gridcell" className="vg-c vg-c-size vg-r">{unk}</div>
        <div role="gridcell" className="vg-c vg-c-status">{statusText[state]}</div>
      </div>)}</div>
  </div>
}
