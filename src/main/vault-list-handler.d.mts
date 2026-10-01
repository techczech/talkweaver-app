import type { createVaultIndex, IndexedTalk, IndexVault, ScanConflicts } from './vault-index.mjs'

type VaultIndex = ReturnType<typeof createVaultIndex>

export function createVaultListHandler(options: { dir: string; legacyCachePath?: string | null; log?: (message: string) => void; scanConflicts?: ScanConflicts | null }): {
  /** The vault's persisted talks now; a refresh runs behind it and streams batches. A closed vault
   *  answers [] and is not scanned. */
  handle(vault: IndexVault, onBatch?: (batch: IndexedTalk[], reset: boolean, done: boolean) => void): Promise<IndexedTalk[]>
  metadata: VaultIndex['metadata']
  cached: VaultIndex['cached']
  invalidate: VaultIndex['invalidate']
  setConflicts: VaultIndex['setConflicts']
  /** The latest refresh of that vault (resolves, never rejects). */
  refreshDone(vaultId: string): Promise<IndexedTalk[]>
}
