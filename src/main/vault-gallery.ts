import { relative, isAbsolute } from 'node:path'
import type { GalleryCatalogue, GalleryVault } from '../shared/vault-gallery'
interface Vault { id: string; root: string; open: boolean }
interface Dependencies {
  epoch?(): number
  vaults(): Vault[]
  unavailable(id: string): boolean
  cached(vault: Vault): Promise<{ hit: boolean; talks: Array<{ outlinePath: string; title: string; slug: string }> }>
}
/** Reads only the existing index snapshot. No list handler, walk, compiler or writer. */
export function createGalleryCatalogue(deps: Dependencies) {
  return async (generation: unknown): Promise<GalleryCatalogue> => {
    if (!Number.isSafeInteger(generation) || (generation as number) < 0) throw new Error('Invalid gallery generation')
    const epoch = deps.epoch?.()
    const originals = deps.vaults().map(v => ({ ...v }))
    const result: GalleryVault[] = []
    for (const original of originals) {
      const vault = { ...original }
      let status: GalleryVault['status'] = !vault.open ? 'closed' : deps.unavailable(vault.id) ? 'unavailable' : 'unknown'
      let talks: GalleryVault['talks'] = []
      if (status === 'unknown') {
        try {
          const snapshot = await deps.cached(vault)
          status = snapshot.hit ? 'stale' : 'unknown'
          talks = snapshot.talks.flatMap(talk => {
            const path = relative(vault.root, talk.outlinePath).split('\\').join('/')
            if (!path || isAbsolute(path) || path.split('/').some(p=>p==='..' || p.toLowerCase()==='research')) return []
            return [{ vaultId: vault.id, relativeOutline: path, title: talk.title, slug: talk.slug }]
          })
        } catch { status = 'unavailable' }
      }
      const current = deps.vaults().find(v=>v.id===vault.id)
      if (epoch !== deps.epoch?.() || !current || current.root !== vault.root || !current.open || deps.unavailable(vault.id)) {
        status = current && !current.open ? 'closed' : 'unavailable'; talks = []
      }
      result.push({ id: vault.id, name: vault.root.split(/[\\/]/).filter(Boolean).at(-1) ?? vault.id, status, talks })
    }
    // A root returned early may have closed while a later snapshot was being read.
    for (const item of result) {
      const current = deps.vaults().find(v => v.id === item.id)
      const original = originals.find(v => v.id === item.id)!
      if (epoch !== deps.epoch?.() || !current || current.root !== original.root || !current.open || deps.unavailable(item.id)) {
        item.talks = []
        item.status = current && !current.open ? 'closed' : 'unavailable'
      }
    }
    return { rootGeneration: epoch ?? 0, generation: generation as number, vaults: result }
  }
}
