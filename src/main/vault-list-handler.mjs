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
    // Attach the rejection handler at the point of assignment: `pendingRefresh` is a single
    // slot that overlapping list-talks calls overwrite, so a handler attached later (via
    // refreshDone) could bind to a newer promise and leave this one's rejection unhandled —
    // a fatal abort under Node's default. Owning the catch here makes every refresh safe.
    pendingRefresh = index.refresh(root, onBatch).then((talks) => {
      if (!cached.hit && !logged) {
        log(`[vault-index] cache rebuilt: ${talks.length} talks (${cachePath})`)
        logged = true
      }
      return talks
    }).catch((error) => {
      log(`[vault-index] refresh failed: ${error?.message ?? error}`)
      return cached.talks
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
