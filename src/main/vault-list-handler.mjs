import { createVaultIndex } from './vault-index.mjs'

// The talk list behind vault:list-talks, per vault: answer from the vault's persisted snapshot at
// once, refresh it behind the answer. Each vault has its own pending refresh and its own log line.
export function createVaultListHandler({ dir, legacyCachePath = null, log = console.log, scanConflicts = null }) {
  const index = createVaultIndex({ dir, legacyCachePath, scanConflicts })
  /** vault id → latest refresh promise (always resolves) */
  const pending = new Map()
  const logged = new Set()

  async function handle(vault, onBatch) {
    if (!vault || vault.open === false) return [] // closed vaults are not listed or scanned
    const cached = await index.cachedState(vault)
    const where = index.snapshotPath(vault.id)
    if (cached.hit && !logged.has(vault.id)) {
      log(`[vault-index] cache hit: ${cached.talks.length} talks (${where})`)
      logged.add(vault.id)
    }
    // Attach the rejection handler at the point of assignment: the pending slot is overwritten by
    // overlapping list-talks calls, so a handler attached later (via refreshDone) could bind to a
    // newer promise and leave this one's rejection unhandled — a fatal abort under Node's default.
    // Owning the catch here makes every refresh safe.
    pending.set(vault.id, index.refresh(vault, onBatch).then((talks) => {
      if (!cached.hit && !logged.has(vault.id)) {
        log(`[vault-index] cache rebuilt: ${talks.length} talks (${where})`)
        logged.add(vault.id)
      }
      return talks
    }).catch((error) => {
      log(`[vault-index] refresh failed: ${error?.message ?? error}`)
      return cached.talks
    }))
    return cached.talks
  }

  return {
    handle,
    metadata: index.metadata,
    cached: index.cached,
    invalidate: index.invalidate,
    setConflicts: index.setConflicts,
    refreshDone: (vaultId) => pending.get(vaultId) ?? Promise.resolve([])
  }
}
