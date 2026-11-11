import { galleryIdentity, type GalleryTalk } from '../../../../shared/vault-gallery'
import { plainTalkTitle } from '../../../../shared/plain-title'
import type { InventoryEntry, InventoryResult } from '../../../../shared/vault-gallery-storage'
import { browseRows, folderRole, inspectOnlyPath, knownTalkCount, leafName, parentOf, type BrowseScope } from '../../../../shared/vault-gallery-browse'

/** One selectable thing in the file list: a known talk, a folder, or an inspect-only stored entry. */
export type GalleryItem =
  | { kind: 'talk'; key: string; name: string; talk: GalleryTalk }
  | { kind: 'folder'; key: string; name: string; path: string; count: number }
  | { kind: 'entry'; key: string; name: string; path: string; entry: InventoryEntry }
export const isDirectoryKind = (kind: InventoryEntry['kind']) => ['folder', 'research', 'assets', 'system'].includes(kind)
/** The approved order, in folders, All talks and search alike: ordinary folders, system folders, inspect-only files and links, then talks. */
export const listRank = (item: GalleryItem): number => item.kind === 'folder' ? 0 : item.kind === 'talk' ? 3 : isDirectoryKind(item.entry.kind) ? 1 : 2
export const folderKey = (path: string) => JSON.stringify(['folder', path])
export const entryKey = (path: string) => JSON.stringify(['entry', path])
export const UI = {
  allVaults: 'All vaults', allTalks: 'All talks', searchVault: 'Search this vault', searchFolder: 'Search this folder', searchVaults: 'Search vaults',
  clearSearch: 'Clear search', newTalk: 'New talk', newFolder: 'New folder', openTalk: 'Open talk', openFolder: 'Open folder', openVault: 'Open vault', handouts: 'Handouts',
  previewTitle: 'Preview title slide', rename: 'Rename', duplicate: 'Duplicate', move: 'Move', bin: 'Move to Bin', more: 'More', details: 'Details', folders: 'Folders',
  list: 'List', gallery: 'Gallery', vaultSettings: 'Vault settings', closeVault: 'Close vault', addVault: 'Add or join vault', showSystem: 'Show assets and system folders',
  hideSystem: 'Hide assets and system folders', copyLocation: 'Copy location', measureFolder: 'Measure this folder', measureVault: 'Measure vault', stop: 'Stop', refresh: 'Refresh',
  showAllTalks: 'Show all talks', unknown: 'Unknown', none: '—', notPublished: 'Not published',
  systemNote: 'Inspect only. Assets, research, system folders, files and links are not moved, renamed or binned from here.'
}

/** Everything the file list shows, from the cached catalogue, the registry and what the disk listing and search scan found.
 *  One row per path: folders main treats as system, assets or research are inspect-only entries whatever the registry says,
 *  and they show with the toggle on (or in an explicit search). */
export function buildItems(i: { talks: GalleryTalk[]; folders: string[]; scope: BrowseScope; query: string; listing: InventoryResult | null; search: InventoryResult | null; showSystem: boolean }): { items: GalleryItem[]; flat: boolean } {
  const { talks, scope, query, listing, search, showSystem } = i
  const folder = scope.kind === 'folder' ? scope.path : ''
  const base = browseRows(talks, i.folders.filter(f => !inspectOnlyPath(f)), scope, query)
  const needle = query.trim().toLocaleLowerCase()
  const talkDirs = new Set(talks.map(t => t.relativeOutline.split('/').slice(0, -1).join('/'))), outlines = new Set(talks.map(t => t.relativeOutline))
  const within = (path: string) => !folder || path === folder || path.startsWith(folder + '/')
  const direct = listing?.relativePath === folder ? listing.entries.filter(e => parentOf(e.relativePath) === folder) : []
  // Without a query, All talks lists talks only: the disk listing of the root is for the folder view.
  const found = base.flat ? (needle ? [...(search?.entries ?? []), ...direct].filter(e => e.relativePath !== folder && within(e.relativePath) && leafName(e.relativePath).toLocaleLowerCase().includes(needle)) : []) : direct
  const seen = new Set(base.folders.map(f => f.path))
  const folderItems: GalleryItem[] = base.folders.map(f => ({ kind: 'folder', key: folderKey(f.path), name: f.name, path: f.path, count: f.count }))
  const entries = new Map<string, InventoryEntry>()
  for (const e of found) {
    if (talkDirs.has(e.relativePath) || outlines.has(e.relativePath) || seen.has(e.relativePath) || entries.has(e.relativePath)) continue
    const role = isDirectoryKind(e.kind) ? folderRole(e.relativePath) : 'ordinary'
    if (e.kind === 'folder' && role === 'ordinary') {
      seen.add(e.relativePath)
      folderItems.push({ kind: 'folder', key: folderKey(e.relativePath), name: leafName(e.relativePath), path: e.relativePath, count: knownTalkCount(talks, e.relativePath) })
    } else entries.set(e.relativePath, role === 'ordinary' ? e : { ...e, kind: role })
  }
  // A registry folder the listing has not delivered yet is still a system or assets folder, not an ordinary one.
  if (!base.flat && showSystem) for (const f of i.folders) if (parentOf(f) === folder && inspectOnlyPath(f) && !entries.has(f)) entries.set(f, { relativePath: f, kind: folderRole(f) as InventoryEntry['kind'], logical: null, allocated: null })
  const visible = base.flat || showSystem
  const entryItems: GalleryItem[] = visible ? [...entries.values()].map((e): GalleryItem => ({ kind: 'entry', key: entryKey(e.relativePath), name: leafName(e.relativePath), path: e.relativePath, entry: e })) : []
  const talkItems = base.talks.map((t): GalleryItem => ({ kind: 'talk', key: galleryIdentity(t), name: plainTalkTitle(t.title), talk: t }))
  return { items: [...folderItems, ...talkItems, ...entryItems], flat: base.flat }
}
