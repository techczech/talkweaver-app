// The shared-talk URL grammar, parsed once by one function for both the entry Worker (body cap,
// early auth, which object) and the SharedTalk object (which action). Anything outside the
// grammar is not a shared-talk route at all.

export type ShareAction = 'page' | 'talk' | 'talk.json' | 'items' | 'item' | 'audience' | 'owner' | 'close'

export interface ShareRoute {
  shareId: string
  action: ShareAction
  /** Only for `item` (`/shares/<id>/items/<itemId>`). */
  itemId?: string
}

import { isShareId, SHARE_ID_LENGTH, SHARE_ID_SOURCE } from './share-id.ts'

export { isShareId, SHARE_ID_LENGTH }
export const MAX_PUSH_BODY_BYTES = 32 * 1024 * 1024
export const MAX_ITEM_BODY_BYTES = 64 * 1024
export const MAX_PATCH_BODY_BYTES = 1024

// `/shares/` is optional: a colleague's link on the drafts domain (ticket 07) is `<domain>/<id>`,
// with no room for the `/shares` segment the app's own Worker origin uses as its share prefix
// (sharedTalkLink in src/shared/shared-talk.ts builds exactly this bare form once a link base is
// configured). Both forms name the same object either way, so accepting both here costs nothing —
// `isShareId` below is what actually keeps this safe (see the reserved-id note in share-id.ts).
const ROUTE = new RegExp(
  `^/(?:shares/)?(${SHARE_ID_SOURCE})(?:/(talk|talk\\.json|items|audience|owner|close)|/items/([A-Za-z0-9_-]{1,100}))?$`,
)

export function parseShareRoute(pathname: string): ShareRoute | null {
  const match = pathname.match(ROUTE)
  if (!match) return null
  const [, shareId, action, itemId] = match
  // A share id that collides with a reserved word (worker/share-id.ts — `sessions`, `internal`, …)
  // is never a route: it never got issued as a share, and without this check a bare `/internal/close`
  // would parse as {shareId: 'internal', action: 'close'} and reach the object's raw internal handler.
  if (!isShareId(shareId)) return null
  if (itemId) return { shareId, action: 'item', itemId }
  return { shareId, action: (action as ShareAction | undefined) ?? 'page' }
}

/** The canonical `/shares/<id>/…` form of a parsed route — what the entry Worker forwards to the
 *  object, regardless of which of the two accepted forms the incoming request actually used. This
 *  guarantees the pathname the object's own `fetch()` sees for any forwarded request always starts
 *  with `/shares/`, so it can never coincide with the object's `/internal/*` bootstrap routes. */
export function canonicalShareRoutePath(route: ShareRoute): string {
  const base = `/shares/${route.shareId}`
  if (route.action === 'page') return base
  if (route.action === 'item') return `${base}/items/${route.itemId}`
  return `${base}/${route.action}`
}

/** The byte cap for the route's body, or null when the route takes no body. */
export function shareBodyLimit(route: ShareRoute, method: string): number | null {
  if (route.action === 'talk' && method === 'PUT') return MAX_PUSH_BODY_BYTES
  if (route.action === 'items' && method === 'POST') return MAX_ITEM_BODY_BYTES
  if (route.action === 'item' && method === 'PATCH') return MAX_PATCH_BODY_BYTES
  return null
}

/** Routes the owner token guards; the entry Worker checks it before reading their body. */
export function shareRouteNeedsOwner(route: ShareRoute, method: string): boolean {
  return (route.action === 'talk' && method === 'PUT') || (route.action === 'item' && method === 'PATCH')
}
