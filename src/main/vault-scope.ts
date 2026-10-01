// Which vault a cached path belongs to, for caches keyed by absolute path (the slide-text search
// index, search-index.json). The keys stay absolute paths; the vault of each is found with the
// registry's resolve() over one list read (several-vaults ticket 02; architecture.md, "Slide-text
// search").
import { resolveInVaults, type Vault } from './vault-registry.ts'

/** The paths that resolve into vaultId. */
export function pathsInVault(paths: Iterable<string>, vaults: Vault[], vaultId: string): string[] {
  const out: string[] = []
  for (const p of paths) if (resolveInVaults(vaults, p)?.vault.id === vaultId) out.push(p)
  return out
}

/** The paths in no open vault (a closed vault's talks, or a folder no longer registered). */
export function pathsOutsideOpenVaults(paths: Iterable<string>, vaults: Vault[]): string[] {
  const out: string[] = []
  for (const p of paths) if (!resolveInVaults(vaults, p)?.vault.open) out.push(p)
  return out
}

/** The vaults a slide search covers. `{ vaultIds }` names them (unknown and closed ids are dropped;
 *  an empty result searches nothing); anything else means the first open vault, as today. */
export function searchVaults(vaults: Vault[], options: unknown): Vault[] {
  const open = vaults.filter((v) => v.open)
  const ids = (options as { vaultIds?: unknown } | null | undefined)?.vaultIds
  if (Array.isArray(ids)) {
    const wanted = new Set(ids.filter((id): id is string => typeof id === 'string'))
    return open.filter((v) => wanted.has(v.id))
  }
  return open.slice(0, 1)
}
