import type { GalleryHandouts } from '../../../../shared/gallery-handouts'
import { galleryIdentity, type GalleryFacts } from '../../../../shared/vault-gallery'
import { scanSize, type InventoryEntry, type InventoryResult } from '../../../../shared/vault-gallery-storage'
import { formatBytes, formatBytesAtLeast, plural, talkDirectory, type RowFacts } from '../../../../shared/vault-gallery-browse'
import { isDirectoryKind, type GalleryItem } from './galleryItems'

export interface Known { facts: Record<string, GalleryFacts>; handouts: Record<string, GalleryHandouts>; scans: (InventoryResult | null)[] }
/** A value that has not arrived (`pending`), one that could not be read (`unknown`), or a real one. */
export type Cell = { text: string; state: 'value' | 'atLeast' | 'pending' | 'unknown' | 'none'; published?: boolean }
const pending: Cell = { text: '', state: 'pending' }, unknown: Cell = { text: 'Unknown', state: 'unknown' }, none: Cell = { text: '—', state: 'none' }
const entryNames: Record<InventoryEntry['kind'], string> = { folder: 'Folder', file: 'File', research: 'Research', assets: 'Assets', system: 'System folder', link: 'Link', alias: 'Finder alias', other: 'Other item' }
export const entryKindName = (kind: InventoryEntry['kind']) => entryNames[kind]

/** A size is exact, a floor from an incomplete measurement, or unknown. A floor sorts by its value and is never counted as measured. */
export interface SizeInfo { exact: number | null; atLeast: number | null }
export function sizeInfo(item: GalleryItem, known: Known): SizeInfo {
  // A link's target is not followed, so a link has no size. A folder-like stored entry (assets, research, a system folder) is sized by a measurement; its listing row has no size of its own.
  if (item.kind === 'entry' && item.entry.kind === 'link') return { exact: null, atLeast: null }
  const measured = item.kind === 'entry' && !isDirectoryKind(item.entry.kind) ? null : scanSize(known.scans, item.kind === 'talk' ? talkDirectory(item.talk) : item.path)
  if (item.kind === 'entry' && !measured) return { exact: item.entry.allocated, atLeast: null }
  const size = measured
  return { exact: size?.allocated ?? null, atLeast: size?.allocatedAtLeast ?? null }
}
const allocated = (item: GalleryItem, known: Known): number | null => { const s = sizeInfo(item, known); return s.exact ?? s.atLeast }
export const sizeCell = (item: GalleryItem, known: Known): Cell => {
  if (item.kind === 'entry' && item.entry.kind === 'link') return none
  const s = sizeInfo(item, known)
  return s.exact != null ? { text: formatBytes(s.exact), state: 'value' } : s.atLeast != null ? { text: formatBytesAtLeast(s.atLeast), state: 'atLeast' } : unknown
}
export function handoutCell(item: GalleryItem, known: Known): Cell {
  if (item.kind !== 'talk') return none
  const key = galleryIdentity(item.talk), h = known.handouts[key]
  if (!h) return known.facts[key] ? unknown : pending
  if (h.status === 'unknown') return unknown
  if (h.status === 'unpublished') return { text: 'Not published', state: 'value' }
  return { text: `${plural(h.records.length, 'handout')}${h.partial ? ' · incomplete' : ''}`, state: 'value', published: true }
}
export function contentsCell(item: GalleryItem, known: Known, flat: boolean): Cell {
  if (item.kind === 'folder') return { text: plural(item.count, 'talk'), state: 'value' }
  if (item.kind === 'entry') return isDirectoryKind(item.entry.kind) ? none : { text: entryKindName(item.entry.kind), state: 'value' }
  const f = known.facts[galleryIdentity(item.talk)]
  if (!f) return pending
  return f.slideCount == null ? unknown : { text: flat ? String(f.slideCount) : plural(f.slideCount, 'slide'), state: 'value' }
}
export function imagesCell(item: GalleryItem, known: Known): Cell {
  if (item.kind !== 'talk') return none
  const f = known.facts[galleryIdentity(item.talk)]
  return !f ? pending : f.imageCount == null ? unknown : { text: String(f.imageCount), state: 'value' }
}
export function modifiedCell(item: GalleryItem, known: Known): Cell {
  if (item.kind !== 'talk') return none
  const f = known.facts[galleryIdentity(item.talk)]
  return !f ? pending : f.editedMs == null ? unknown : { text: new Date(f.editedMs).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }), state: 'value' }
}
export function rowFacts(item: GalleryItem, known: Known): RowFacts {
  const key = item.kind === 'talk' ? galleryIdentity(item.talk) : ''
  const f = known.facts[key], h = known.handouts[key]
  return {
    slides: item.kind === 'folder' ? item.count : f?.slideCount, images: f?.imageCount, size: allocated(item, known),
    handouts: h ? (h.status === 'published' ? h.records.length : h.status === 'unpublished' ? 0 : null) : null, modified: f?.editedMs
  }
}
