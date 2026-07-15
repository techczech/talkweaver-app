import { createVaultIndex } from './vault-index.mjs'

export function createVaultListHandler({ cachePath, log = console.log }) {
  const index = createVaultIndex({ cachePath })
  let pendingRefresh = Promise.resolve([])
  let logged = false

  async function handle(root, onBatch) {
    const cached = await index.cachedState(root)
    if (cached.hit && !logged) {
      log(`[vault-index] cache hit: ${cached.talks.length} talks (${cachePath})`)
      logged = true
    }
    pendingRefresh = index.refresh(root, onBatch).then((talks) => {
      if (!cached.hit && !logged) {
        log(`[vault-index] cache rebuilt: ${talks.length} talks (${cachePath})`)
        logged = true
      }
      return talks
    })
    return cached.talks
  }

  return {
    handle,
    metadata: index.metadata,
    cached: index.cached,
    invalidate: index.invalidate,
    refreshDone: () => pendingRefresh
  }
}
