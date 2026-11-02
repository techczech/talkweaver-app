export interface GalleryTalk { vaultId: string; relativeOutline: string; title: string; slug: string }
export interface GalleryVault { id: string; name: string; status: 'stale' | 'unknown' | 'closed' | 'unavailable'; talks: GalleryTalk[] }
export interface GalleryCatalogue { rootGeneration: number; generation: number; vaults: GalleryVault[] }
export const galleryIdentity = (talk: GalleryTalk): string => JSON.stringify([talk.vaultId, talk.relativeOutline])
export const acceptsGalleryReply = (reply: GalleryCatalogue, generation: number): boolean => reply.generation === generation
export function galleryRows(vault: GalleryVault, folder: string, search: string) {
  const prefix = folder ? folder + '/' : ''
  const scoped = vault.talks.filter(t => t.relativeOutline.startsWith(prefix))
  const folders = new Map<string, number>()
  for (const talk of scoped) {
    const parts = talk.relativeOutline.slice(prefix.length).split('/')
    // The final directory belongs to the talk; earlier directories are categories.
    if (parts.length > 2) folders.set(prefix + parts[0], (folders.get(prefix + parts[0]) ?? 0) + 1)
  }
  const query = search.trim().toLocaleLowerCase()
  return {
    folders: [...folders].map(([path, count]) => ({ path, count })).filter(f => !query || f.path.toLocaleLowerCase().includes(query)),
    talks: scoped.filter(t => !query || `${t.title} ${t.relativeOutline}`.toLocaleLowerCase().includes(query)).sort((a,b)=>a.title.localeCompare(b.title))
  }
}
export interface GalleryFacts {
 revision:string|null
 slideCount:number|null
 imageCount:number|null
 editedMs:number|null
 coverUrl:string|null
 preview:'pending'|'ready'|'unavailable'
}
