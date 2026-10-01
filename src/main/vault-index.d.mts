export type IndexedTalk = {
  name: string
  path: string
  outlinePath: string
  title: string
  slug: string
  /** Sync-conflict copies left to compare (ticket 09); 0 or absent when none. */
  conflicts?: number
}

/** The registry's Vault, or the part of it the index reads. `open` defaults to true. */
export type IndexVault = { id: string; root: string; open?: boolean }

export type TalkMetadata = Record<string, { createdMs: number; editedMs: number; subtitle: string | null; event: string | null }>

export type ScanConflicts = (input: { vault: IndexVault; folder: string; outlineName: string; slug: string; names: string[] }) => Promise<number | null>

export function createVaultIndex(options: { dir: string; legacyCachePath?: string | null; batchSize?: number; scanConflicts?: ScanConflicts | null }): {
  cached(vault: IndexVault): Promise<IndexedTalk[]>
  cachedState(vault: IndexVault): Promise<{ hit: boolean; talks: IndexedTalk[] }>
  metadata(vault: IndexVault): Promise<TalkMetadata>
  refresh(vault: IndexVault, onBatch?: (batch: IndexedTalk[], reset: boolean, done: boolean) => void): Promise<IndexedTalk[]>
  /** One vault's in-memory snapshot (every vault's when id is omitted). */
  invalidate(id?: string | null): void
  snapshotPath(id: string): string
  setConflicts(vaultId: string, outlinePath: string, conflicts: number): IndexedTalk | null
}
