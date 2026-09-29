// The share id rule — ONE definition for the Worker and the app (src/shared/share-id.ts re-exports
// it). It lives in worker/ because the packaged app deploys worker/ on its own, so the Worker may
// not import from src/. No imports: both tsconfigs and wrangler read this file as is.
export const SHARE_ID_LENGTH = 8
export const SHARE_ID_SOURCE = `[a-z0-9]{${SHARE_ID_LENGTH}}`
const SHARE_ID = new RegExp(`^${SHARE_ID_SOURCE}$`)

// Never issued or accepted as a share id, even when it fits the character class above: each is a
// real top-level route word on this Worker (worker/index.ts's own `/sessions`, `/session/<slug>`,
// `/shares`, `/capabilities`, and the object's own `/internal/...` bootstrap routes). `sessions`
// and `internal` are the only two that are actually SHARE_ID_LENGTH letters today, so the only two
// that could otherwise collide; the rest are reserved too so a future length change stays safe.
// Security review, ticket 07: without this, a share id could equal `internal` and a forwarded
// `/internal/close` would reach the object's unauthenticated internal Stop handler.
const RESERVED_SHARE_IDS = new Set(['sessions', 'internal', 'session', 'shares', 'capabilities'])

export function isShareId(value: unknown): value is string {
  return typeof value === 'string' && SHARE_ID.test(value) && !RESERVED_SHARE_IDS.has(value)
}
