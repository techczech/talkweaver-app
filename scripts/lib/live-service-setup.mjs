// TESTS ONLY. The live service's set-up as the main process wires it (deployLiveWorker in
// src/main/index.ts), over a shipped worker-dist folder and an API address of the test's choosing:
// the same sequence (src/main/live-service-deploy.ts), the same reading of the shipped files, the
// keys kept in memory. Used by the API, trace, compile-integrity and packaged-smoke tests.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deployLiveService } from '../../src/main/live-service-deploy.ts'
import { readShippedFiles } from '../../src/main/live-service-upload.ts'
import { acceptingLive, instantClock, singleKeyPort } from './live-worker-double.mjs'
import { TOKEN_REMOVED } from '../../src/main/cloudflare-connection.ts'

/** The shipped files as the main process reads them (shippedLiveWorker): null for one that cannot be read. */
export function shippedFrom(distDir) {
  return readShippedFiles((name) => { try { return readFileSync(join(distDir, name)) } catch { return null } })
}

/** Leave for one generation that never ends, as a connection gives it (for tests without a connection). */
export function steadyLeave(token, accountId) {
  return {
    accountId,
    current: () => true,
    run: async (launch) => ({ superseded: false, result: await launch({ CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId }) }),
    clean: (text) => String(text).split(token).join(TOKEN_REMOVED),
  }
}

/**
 * Set the live service up from `distDir`. `keys`: an object whose `stored` field holds the keys
 * (null: none yet); new ones are put there. Returns the sequence's result and what it saved.
 */
export async function setUpLiveService({ distDir, expectedBuild, authorise, apiBase, keys = { stored: null }, fetch = globalThis.fetch, made, liveFetch }) {
  const saved = []
  const result = await deployLiveService({
    shipped: () => shippedFrom(distDir),
    expectedBuild,
    authorise,
    // This computer's own key, kept in `keys.stored` before it is handed over (as the app's key store does).
    keys: singleKeyPort(keys, () => made ?? { computerId: 'aaaa0000bbbb1111', adminSecret: `test-admin-${Math.random().toString(36).slice(2)}-0123456789` }),
    computerName: () => 'Test computer',
    // The live service is not what these tests are about: one that answers as this build and accepts the key.
    liveFetch: liveFetch ?? acceptingLive({ build: expectedBuild, self: () => keys.stored?.computerId }),
    live: instantClock().live,
    fetch,
    apiBase: () => apiBase,
    save: ({ baseUrl, accountId }) => saved.push({ baseUrl, accountId }),
  })
  return { result, saved, keys }
}

/** The main module the fake API received in an upload request, and the metadata beside it. */
export function uploadedOf(request) {
  const metadata = JSON.parse(request.parts.find((part) => part.name === 'metadata').bytes.toString('utf8'))
  return { metadata, module: request.parts.find((part) => part.name === metadata.main_module) }
}
