import { useEffect, useRef, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronUp, File, FileText, FlaskConical, Folder, Globe, Image, Link, Archive } from 'lucide-react'
import { parentOf, shortLocation, talkFolder, type SortKey, type SortState } from '../../../../shared/vault-gallery-browse'
import type { InventoryEntry } from '../../../../shared/vault-gallery-storage'
import type { GalleryItem } from './galleryItems'
import { contentsCell, handoutCell, imagesCell, modifiedCell, sizeCell, type Cell, type Known } from './galleryValues'

interface Props {
  items: GalleryItem[]
  flat: boolean
  mixed: boolean
  vaultName: string
  known: Known
  sort: SortState
  setSort(key: SortKey): void
  selected: string | null
  select(key: string | null): void
  activate(item: GalleryItem): void
  preview(item: GalleryItem): void
  focusKey: string | null
  contextMenu(item: GalleryItem, at: { x: number; y: number }): void
}
const CellView = ({ cell }: { cell: Cell }) => cell.state === 'pending' ? <span className="vg-skel" aria-label="Reading…" /> : cell.state === 'unknown' ? <span className="vg-unk">{cell.text}</span>
  : cell.published ? <span className="vg-pub"><Globe size={13} aria-hidden />{cell.text}</span> : <>{cell.text}</>
/** The approved mark for each kind of stored entry: assets, research, a system folder, a link, a file or Finder alias. */
export function EntryIcon({ kind, size = 16 }: { kind: InventoryEntry['kind']; size?: number }) {
  const Icon = kind === 'folder' ? Folder : kind === 'assets' ? Image : kind === 'research' ? FlaskConical : kind === 'system' ? Archive : kind === 'link' ? Link : File
  return <Icon size={size} className={`vg-ic ${kind === 'folder' ? 'vg-ic-folder' : 'vg-ic-sys'}`} aria-hidden />
}
function RowIcon({ item }: { item: GalleryItem }) {
  if (item.kind === 'talk') return <FileText size={16} className="vg-ic vg-ic-doc" aria-hidden />
  if (item.kind === 'folder') return <Folder size={16} className="vg-ic vg-ic-folder" aria-hidden />
  return <EntryIcon kind={item.entry.kind} />
}
/** The normal file list: one real grid, sortable column headers, one selectable row per item. */
export default function GalleryList({ items, flat, mixed, vaultName, known, sort, setSort, selected, select, activate, preview, focusKey, contextMenu }: Props) {
  const rows = useRef<HTMLDivElement>(null)
  const columns: [SortKey, string, string][] = flat
    ? [['name', 'Name', 'c-name'], ['location', 'Location', 'c-loc'], ['contents', mixed ? 'Contents' : 'Slides', 'c-contents'], ['images', 'Images', 'c-images r'], ['size', 'Size on disk', 'c-size r'], ['handouts', 'Handouts', 'c-hand'], ['modified', 'Modified', 'c-mod']]
    : [['name', 'Name', 'c-name'], ['contents', 'Contents', 'c-contents'], ['images', 'Images', 'c-images r'], ['size', 'Size on disk', 'c-size r'], ['handouts', 'Handouts', 'c-hand'], ['modified', 'Modified', 'c-mod']]
  // Roving focus: the selected row, else the first, is the one tab stop.
  const tabKey = selected && items.some(i => i.key === selected) ? selected : items[0]?.key
  useEffect(() => { if (focusKey) rows.current?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: false }) }, [focusKey])
  const onKey = (e: KeyboardEvent<HTMLDivElement>, item: GalleryItem, index: number) => {
    // SCAN_IGNORE: local grid navigation inside the modal gallery; not an app command.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      const next = items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next) { select(next.key); rows.current?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(next.key)}"]`)?.focus() }
    } else if (e.key === 'Enter') { e.preventDefault(); activate(item) }
    else if (e.key === ' ') { e.preventDefault(); preview(item) }
  }
  return <div className={`vg-lst ${flat ? 'flat' : ''} ${mixed ? 'mixed' : ''}`} role="grid" aria-label="Talks and folders" aria-rowcount={items.length + 1} aria-colcount={columns.length}>
    <div role="row" className="vg-lhead">{columns.map(([key, label, cls]) =>
      <div key={key} role="columnheader" className={cls.split(' ').map(c => 'vg-' + c).join(' ')} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button className={sort.key === key ? 'sorted' : ''} onClick={() => setSort(key)}>{label}{sort.key === key && (sort.dir === 'asc' ? <ChevronUp size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />)}</button>
      </div>)}</div>
    <div ref={rows} role="rowgroup" className="vg-rows">{items.map((item, index) => {
      const here = selected === item.key
      const location = item.kind === 'talk' ? talkFolder(item.talk) : parentOf(item.path)
      const cell = (key: SortKey): Cell => key === 'contents' ? contentsCell(item, known, flat && !mixed) : key === 'images' ? imagesCell(item, known) : key === 'size' ? sizeCell(item, known) : key === 'handouts' ? handoutCell(item, known) : modifiedCell(item, known)
      return <div key={item.key} role="row" aria-rowindex={index + 2} aria-selected={here} tabIndex={item.key === tabKey ? 0 : -1} data-row-key={item.key} data-identity={item.kind === 'talk' ? item.key : undefined}
        className={`vg-row ${here ? 'sel' : ''} ${item.kind !== 'talk' ? 'is-folder' : ''}`} aria-label={item.name}
        onClick={() => select(item.key)} onDoubleClick={() => activate(item)} onContextMenu={e => { e.preventDefault(); contextMenu(item, { x: e.clientX, y: e.clientY }) }} onKeyDown={e => onKey(e, item, index)}>
        {columns.map(([key, , cls]) => {
          const klass = cls.split(' ').map(c => 'vg-' + c).join(' ')
          if (key === 'name') return <div key={key} role="gridcell" className={`vg-c ${klass}`}><RowIcon item={item} /><span className="vg-tx" title={item.name}>{item.name}</span></div>
          if (key === 'location') return <div key={key} role="gridcell" className={`vg-c ${klass}`} title={location || vaultName}>{shortLocation(location, vaultName)}</div>
          return <div key={key} role="gridcell" className={`vg-c ${klass}`}><CellView cell={cell(key)} /></div>
        })}
      </div>
    })}</div>
  </div>
}
