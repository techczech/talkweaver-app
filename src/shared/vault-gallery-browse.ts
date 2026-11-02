import type { GalleryTalk } from './vault-gallery.ts'

/** Pure browsing model for the vault browser: folder tree, direct folder contents, All talks, sorting.
 *  Counts are over the cached catalogue only, so they stay "known" counts, never verified totals. */
export type BrowseScope = { kind: 'folder'; path: string } | { kind: 'all' }
export type BrowseView = 'List' | 'Gallery'
export type SortKey = 'name' | 'location' | 'contents' | 'images' | 'size' | 'handouts' | 'modified'
export interface SortState { key: SortKey; dir: 'asc' | 'desc' }

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
export const compareNames = (a: string, b: string): number => collator.compare(a, b)

/** The category folder holding a talk: the final directory belongs to the talk itself. */
export const talkFolder = (talk: GalleryTalk): string => talk.relativeOutline.split('/').slice(0, -2).join('/')
export const talkDirectory = (talk: GalleryTalk): string => talk.relativeOutline.split('/').slice(0, -1).join('/')
export const leafName = (path: string): string => path.split('/').at(-1) ?? path
export const parentOf = (path: string): string => path.split('/').slice(0, -1).join('/')
const within = (path: string, folder: string): boolean => !folder || path === folder || path.startsWith(folder + '/')

/** Every folder that exists in the catalogue or the registry, with its ancestors. */
export function folderPaths(talks: GalleryTalk[], known: string[] = []): string[] {
  const all = new Set<string>()
  const add = (path: string) => { const parts = path.split('/').filter(Boolean); for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join('/')) }
  for (const talk of talks) add(talkFolder(talk))
  for (const path of known) add(path)
  return [...all].sort(compareNames)
}
/** Recursive count of known talks under a folder. */
export const knownTalkCount = (talks: GalleryTalk[], folder: string): number => talks.filter(t => within(talkFolder(t), folder)).length

export interface TreeNode { path: string; name: string; depth: number; count: number; hasChildren: boolean; expanded: boolean }
export function treeNodes(talks: GalleryTalk[], folders: string[], expanded: ReadonlySet<string>): TreeNode[] {
  const out: TreeNode[] = []
  const walk = (parent: string, depth: number) => {
    const children = folders.filter(f => parentOf(f) === parent).sort((a, b) => compareNames(leafName(a), leafName(b)))
    for (const path of children) {
      const hasChildren = folders.some(f => parentOf(f) === path)
      const open = expanded.has(path)
      out.push({ path, name: leafName(path), depth, count: knownTalkCount(talks, path), hasChildren, expanded: open })
      if (hasChildren && open) walk(path, depth + 1)
    }
  }
  walk('', 1)
  return out
}
/** Folders on the way to a path, so selecting a deep folder reveals it in the tree. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

export interface FolderRow { path: string; name: string; count: number }
export interface BrowseRows { folders: FolderRow[]; talks: GalleryTalk[]; flat: boolean }
/** Direct contents of a folder (no descendants) and, for All talks or a search, a flat recursive list. */
export function browseRows(talks: GalleryTalk[], folders: string[], scope: BrowseScope, query: string): BrowseRows {
  const needle = query.trim().toLocaleLowerCase()
  const base = scope.kind === 'all' ? '' : scope.path
  const hit = (text: string) => text.toLocaleLowerCase().includes(needle)
  if (scope.kind === 'all' || needle) {
    const scoped = talks.filter(t => within(talkFolder(t), base))
    return {
      flat: true,
      talks: needle ? scoped.filter(t => hit(`${t.title} ${t.relativeOutline}`)) : scoped,
      folders: needle
        ? folders.filter(f => within(f, base) && f !== base && hit(leafName(f))).map(path => ({ path, name: leafName(path), count: knownTalkCount(talks, path) }))
        : []
    }
  }
  return {
    flat: false,
    folders: folders.filter(f => parentOf(f) === base).map(path => ({ path, name: leafName(path), count: knownTalkCount(talks, path) })),
    talks: talks.filter(t => talkFolder(t) === base)
  }
}

export interface RowFacts { slides: number | null | undefined; images: number | null | undefined; size: number | null | undefined; handouts: number | null | undefined; modified: number | null | undefined }
/** Unknown values always sort last, whichever direction is chosen. */
export function compareBy(key: SortKey, dir: 'asc' | 'desc', a: { name: string; location: string; facts: RowFacts }, b: { name: string; location: string; facts: RowFacts }): number {
  const sign = dir === 'asc' ? 1 : -1
  if (key === 'name') return sign * compareNames(a.name, b.name)
  if (key === 'location') return sign * compareNames(a.location, b.location) || compareNames(a.name, b.name)
  const pick = (r: typeof a) => key === 'contents' ? r.facts.slides : key === 'images' ? r.facts.images : key === 'size' ? r.facts.size : key === 'handouts' ? r.facts.handouts : r.facts.modified
  const x = pick(a), y = pick(b)
  if (x == null && y == null) return compareNames(a.name, b.name)
  if (x == null) return 1
  if (y == null) return -1
  return sign * (x - y) || compareNames(a.name, b.name)
}
export const nextSort = (current: SortState, key: SortKey): SortState => current.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }

/** Middle-shortened location for a table cell: first part, ellipsis, last part. Full text stays in Details. */
export function shortLocation(path: string, vaultName: string): string {
  if (!path) return vaultName
  const parts = path.split('/')
  return parts.length <= 2 ? parts.join(' / ') : `${parts[0]} / … / ${parts.at(-1)}`
}
/** Breadcrumb under the vault: all parts, or first + gap + last two when the path is deep. */
export function crumbParts(path: string): { label: string; path: string | null }[] {
  const parts = path.split('/').filter(Boolean)
  const all = parts.map((label, i) => ({ label, path: parts.slice(0, i + 1).join('/') }))
  return all.length <= 3 ? all : [all[0], { label: '…', path: null }, ...all.slice(-2)]
}

const UNITS = ['KB', 'MB', 'GB', 'TB']
function scaled(bytes: number, round: (n: number) => number): string {
  if (bytes < 1000) return `${bytes} B`
  let value = bytes, i = -1
  do { value /= 1000; i++ } while (value >= 1000 && i < UNITS.length - 1)
  let shown = value >= 100 ? round(value) : round(value * 10) / 10
  // 999,999 B rounds to 1000 KB: say 1 MB instead.
  if (shown >= 1000 && i < UNITS.length - 1) { i++; shown = round(shown / 100) / 10 }
  return `${shown} ${UNITS[i]}`
}
export function formatBytes(bytes: number | null | undefined): string {
  return bytes == null ? 'Unknown' : scaled(bytes, Math.round)
}
/** A lower bound is never overstated: the shown figure rounds down. */
export const formatBytesAtLeast = (bytes: number): string => `≥ ${scaled(bytes, Math.floor)}`
export const plural = (n: number, one: string, many = one + 's'): string => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** The remembered view; anything unreadable or unknown is List. */
export function readView(raw: string | null | undefined): BrowseView { return raw === 'Gallery' ? 'Gallery' : 'List' }

/** What a folder is to the browser. Names follow what main's folder listing already treats as non-category
 *  (`_`-prefixed system areas, `research`, build output) plus the assets folders; classification is by name, so it
 *  holds for registry folders and for folders found on disk alike. */
export type FolderRole = 'ordinary' | 'assets' | 'research' | 'system'
const SYSTEM_NAMES = new Set(['bundle', 'dist', 'node_modules', '.git'])
export function folderRole(path: string): FolderRole {
  for (const part of path.split('/').filter(Boolean)) {
    const name = part.toLowerCase()
    if (name === 'research') return 'research'
    if (name === 'assets' || name === '_assets') return 'assets'
    if (name.startsWith('.') || name.startsWith('_') || SYSTEM_NAMES.has(name)) return 'system'
  }
  return 'ordinary'
}
/** Inspect-only: never renamed, moved, binned, offered as a destination or a place to create. */
export const inspectOnlyPath = (path: string): boolean => folderRole(path) !== 'ordinary'
/** A talk's folder name from its title: a name main treats as inspect-only (Assets, Research, Bundle, Dist…) gets the `-talk` suffix, the title itself is untouched. */
export const safeTalkSlug = (slug: string): string => slug && inspectOnlyPath(slug) ? `${slug}-talk` : slug
