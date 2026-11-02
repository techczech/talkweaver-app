import { useEffect, useRef } from 'react'
import { FileText, Folder } from 'lucide-react'
import { galleryIdentity, type GalleryFacts, type GalleryTalk } from '../../../../shared/vault-gallery'
import { plural } from '../../../../shared/vault-gallery-browse'
import { EntryIcon } from './GalleryList'
import type { GalleryItem } from './galleryItems'
import { handoutCell, sizeCell, type Known } from './galleryValues'

interface Props {
  items: GalleryItem[]
  known: Known
  selected: string | null
  select(key: string | null): void
  activate(item: GalleryItem): void
  preview(item: GalleryItem): void
  dropCover(key: string): void
  strip?: boolean
  focusKey?: string | null
  contextMenu(item: GalleryItem, at: { x: number; y: number }): void
  mosaicTalks?(path: string): GalleryTalk[]
}
export function Mosaic({ talks, known }: { talks: GalleryTalk[]; known: Known }) {
  const covers = talks.map(t => known.facts[galleryIdentity(t)]?.coverUrl ?? null)
  // Until at least one real title slide has arrived, the tile is a plain folder.
  if (!covers.some(Boolean)) return <span className="vg-nopreview vg-foldertile"><Folder size={28} aria-hidden /></span>
  return <span className="vg-mosaic">{[0, 1, 2, 3].map(i => covers[i] ? <img key={i} src={covers[i]!} alt="" /> : <span key={i} className="vg-blankslide" />)}</span>
}
const line = (parts: (string | null)[]) => parts.filter(Boolean).join(' · ')
/** Gallery: real title slides (or a plain placeholder while they load) with the title and facts under each. */
export default function GalleryTiles({ items, known, selected, select, activate, preview, dropCover, strip, focusKey, mosaicTalks, contextMenu }: Props) {
  const grid = useRef<HTMLDivElement>(null)
  // Focus moves only when focusKey changes (after Enter on a folder), never on a re-render, so typing in the search box is not taken.
  useEffect(() => { if (focusKey) grid.current?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(focusKey)}"]`)?.focus() }, [focusKey])
  const tabKey = selected && items.some(i => i.key === selected) ? selected : items[0]?.key
  return <div ref={grid} className={`vg-gal ${strip ? 'strip' : ''}`} role="listbox" aria-label="Talks and folders" aria-orientation="horizontal">{items.map(item => {
    const here = selected === item.key
    const f: GalleryFacts | undefined = item.kind === 'talk' ? known.facts[galleryIdentity(item.talk)] : undefined
    const meta = item.kind === 'talk'
      ? [line([f?.slideCount == null ? (f ? 'Slides unknown' : null) : plural(f.slideCount, 'slide'), f?.imageCount == null ? null : plural(f.imageCount, 'image')]),
        line([['value', 'atLeast'].includes(sizeCell(item, known).state) ? sizeCell(item, known).text : null, handoutCell(item, known).state === 'value' ? handoutCell(item, known).text : null]) || (f ? 'Size and handouts unknown' : '')]
      : item.kind === 'folder' ? [line([plural(item.count, 'talk'), ['value', 'atLeast'].includes(sizeCell(item, known).state) ? sizeCell(item, known).text : null])] : [item.entry.kind]
    return <div key={item.key} role="option" aria-selected={here} aria-label={item.name} tabIndex={item.key === tabKey ? 0 : -1} data-row-key={item.key} data-identity={item.kind === 'talk' ? item.key : undefined} data-mosaic={item.kind === 'folder' && mosaicTalks ? JSON.stringify(mosaicTalks(item.path).map(galleryIdentity)) : undefined}
      className={`vg-card ${here ? 'sel' : ''}`} onClick={() => select(item.key)} onDoubleClick={() => activate(item)} onContextMenu={e => { e.preventDefault(); contextMenu(item, { x: e.clientX, y: e.clientY }) }}
      onKeyDown={e => {
        // SCAN_IGNORE: local tile navigation inside the modal gallery; not an app command.
        if (e.key === 'Enter') { e.preventDefault(); activate(item) }
        else if (e.key === ' ') { e.preventDefault(); preview(item) }
        else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const at = items.indexOf(item), columns = Math.max(1, Math.round(((e.currentTarget.parentElement?.clientWidth ?? 1)) / (e.currentTarget.clientWidth + 18)))
          const next = items[Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? columns : -columns)))]
          if (next) { select(next.key); (e.currentTarget.parentElement?.querySelector(`[data-row-key="${CSS.escape(next.key)}"]`) as HTMLElement | null)?.focus() }
        }
      }}>
      <span className="vg-thumb">{item.kind === 'talk'
        ? f?.coverUrl ? <img src={f.coverUrl} alt={`Title slide of ${item.talk.title}`} onError={() => dropCover(item.key)} />
          : <span className="vg-nopreview"><FileText size={20} aria-hidden />{f?.preview === 'unavailable' ? 'Title preview unavailable' : 'Title preview pending'}</span>
        : item.kind === 'folder' && mosaicTalks ? <Mosaic talks={mosaicTalks(item.path)} known={known} />
          : <span className="vg-nopreview vg-foldertile"><Folder size={28} aria-hidden /></span>}</span>
      <span className="vg-cname">{item.kind === 'folder' ? <Folder size={14} className="vg-ic vg-ic-folder" aria-hidden /> : item.kind === 'entry' ? <EntryIcon kind={item.entry.kind} size={14} /> : null}{item.name}</span>
      <span className="vg-cmeta">{meta.filter(Boolean).map((m, i) => <div key={i}>{m}</div>)}</span>
    </div>
  })}</div>
}
