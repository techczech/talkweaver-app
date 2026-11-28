import type { TalkInfo, VaultView } from '../../../../preload'
import { folderPaths, inspectOnlyPath, talkFolder } from '../../../../shared/vault-gallery-browse'
import type { GalleryTalk } from '../../../../shared/vault-gallery'
import type { SearchResult } from '../slide-browser/types'

export interface ExplorerTalk extends GalleryTalk {
  info: TalkInfo
  vault: VaultView
  folder: string
  cachedEditedMs?: number
}
export interface ExplorerVault {
  vault: VaultView
  talks: ExplorerTalk[]
  folders: string[]
}
export interface ExplorerResult {
  talk: ExplorerTalk
  slide?: SearchResult
}
export interface ExplorerPlace {
  vaultId: string
  folder: string
}

const slashes = (path: string): string => path.replace(/\\/g, '/')

export function explorerVaults(vaults: VaultView[], talks: TalkInfo[], folders: Record<string, string[]>): ExplorerVault[] {
  const byVault = new Map<string, TalkInfo[]>()
  for (const talk of talks) {
    if (!talk.vaultId) continue
    let list = byVault.get(talk.vaultId)
    if (!list) byVault.set(talk.vaultId, list = [])
    list.push(talk)
  }
  return vaults.map(vault => {
    if (!vault.open || vault.unavailable) return { vault, talks: [], folders: [] }
    const prefix = slashes(vault.root).replace(/\/+$/, '') + '/'
    const entries = (byVault.get(vault.id) ?? []).flatMap((info): ExplorerTalk[] => {
      const path = slashes(info.outlinePath)
      if (!path.startsWith(prefix)) return []
      const talk = { vaultId: vault.id, relativeOutline: path.slice(prefix.length), title: info.title, slug: info.slug }
      const folder = talkFolder(talk)
      return inspectOnlyPath(folder) ? [] : [{ ...talk, info, vault, folder }]
    })
    return { vault, talks: entries, folders: folderPaths(entries, folders[vault.id]).filter(path => !inspectOnlyPath(path)) }
  })
}

export function withinPlace(talk: ExplorerTalk, place: ExplorerPlace | null): boolean {
  return !place || (talk.vaultId === place.vaultId &&
    (!place.folder || talk.folder === place.folder || talk.folder.startsWith(place.folder + '/')))
}

// This is only a display snapshot. A disconnected talk cannot be opened through this data.
export type ExplorerHistory = Record<string, { root: string; count: number; recent: Array<{ info: TalkInfo; editedMs: number }> }>
const HISTORY = 'tw.vaultExplorer.history.v1'

export function readExplorerHistory(): ExplorerHistory {
  try {
    const stored = JSON.parse(localStorage.getItem(HISTORY) ?? '{}')
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
    return Object.fromEntries(Object.entries(stored as ExplorerHistory).filter(([, value]) =>
      typeof value?.root === 'string' && Number.isInteger(value.count) && Array.isArray(value.recent)))
  } catch { return {} }
}

export function writeExplorerHistory(history: ExplorerHistory): void {
  try {
    const stored = JSON.stringify(history)
    if (localStorage.getItem(HISTORY) !== stored) localStorage.setItem(HISTORY, stored)
  } catch { /* local history is optional */ }
}

export function offlineExplorerTalks(item: ExplorerVault, snapshot: ExplorerHistory[string] | undefined): ExplorerTalk[] {
  if (snapshot?.root !== item.vault.root || !Array.isArray(snapshot.recent)) return []
  const prefix = slashes(item.vault.root).replace(/\/+$/, '') + '/'
  return snapshot.recent.flatMap(entry => {
    const { info, editedMs } = entry ?? {}
    if (typeof info?.outlinePath !== 'string' || !slashes(info.outlinePath).startsWith(prefix) ||
      typeof info.title !== 'string' || typeof info.slug !== 'string') return []
    const talk = { vaultId: item.vault.id, relativeOutline: slashes(info.outlinePath).slice(prefix.length), title: info.title, slug: info.slug }
    return [{ ...talk, info, vault: item.vault, folder: talkFolder(talk), cachedEditedMs: Number.isFinite(editedMs) ? editedMs : undefined }]
  })
}
