// One request to the live service that carries this computer's key (a share, a Run's results link,
// pre-work: the requests that MAKE something there). The same rules as Go live's `POST /sessions`
// (going live from several Macs, "Which key is presented"), in one place:
//   - the key chosen for the use is sent first; only when the live service's own 401
//     (`admin_auth_required`) refuses it is the request sent once more with the other key held for
//     the same live service. That 401 means the live service did nothing, so re-sending a request
//     that makes something makes it once;
//   - another key is tried only if it is stored for the recorded live service, and only when the
//     request goes to that live service's recorded address. A request to any other address (a live
//     service on this computer in a test run) carries the one key it was given;
//   - `refused` (which reads "access was removed") only when EVERY key tried got that 401. Any other
//     status is handed back as it is, and no answer at all is thrown on: neither is "removed".
//
// No Electron import and erasable TypeScript only: the suites of the three callers drive it.
import { sendWithHeldKeys, type LiveServiceAt, type StoredKey } from './live-service-key.ts'

/** The sentence for `refused`: the Going live row's own (live-service-deploy.ts `LIVE_ACCESS_REMOVED`). */
export { LIVE_ACCESS_REMOVED } from './live-service-deploy.ts'

/** The keys this computer holds for the live service Settings record (`at`), for requests to its address. */
export type HeldKeys = { at: LiveServiceAt; keys: readonly StoredKey[] }
/** The live service and the key to present to it; `held`: what else may be tried after its 401. */
export type AdminEndpoint = { baseUrl: string; adminSecret: string; held?: HeldKeys }

const NOWHERE: LiveServiceAt = { accountId: null, workerName: '', baseUrl: null }
function origin(address: string | null): string | null {
  try { return address ? new URL(address).origin : null } catch { return null }
}

/**
 * Send one keyed request. `init` is asked for once per try (a time limit starts when its try does);
 * its `authorization` header is set here and nowhere else.
 */
export async function sendAsAdmin(fetchImpl: typeof fetch, endpoint: AdminEndpoint, url: string, init: () => RequestInit): Promise<{ response: Response; refused: boolean }> {
  const recorded = origin(endpoint.held?.at.baseUrl ?? null)
  const held = endpoint.held && recorded !== null && origin(url) === recorded ? endpoint.held : null
  return sendWithHeldKeys(held?.at ?? NOWHERE, held?.keys ?? [], endpoint.adminSecret, (key) => {
    const made = init()
    return fetchImpl(url, { ...made, headers: { ...(made.headers as Record<string, string> | undefined), authorization: `Bearer ${key}` } })
  })
}
