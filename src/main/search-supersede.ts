// Which `search:all-slides` request is the latest for one window and key, so an older scan can stop.
//
// A renderer numbers its requests from 1 per document; a reload starts again at 1. So the latest-id
// record must never outlive the document that made it: main forgets a window's records when its
// webContents navigates (reload included) or is destroyed (`forgetSender`), and the renderer also
// puts a per-load random token in its key, so a request from a new document is never compared with
// ids from an old one even if it arrives before main has seen the navigation.

export interface SupersedeTracker {
  /**
   * Record a request. Returns `superseded()`: true once a newer request with the same sender and key
   * has begun. A request without a numeric id or a non-empty key is never superseded.
   */
  begin(senderId: number, key: unknown, requestId: unknown): () => boolean
  /** Drop every record of this sender (its document is gone). */
  forgetSender(senderId: number): void
  /** How many keys are recorded (tests). */
  size(): number
}

export function createSupersedeTracker(): SupersedeTracker {
  const bySender = new Map<number, Map<string, number>>()
  return {
    begin(senderId, key, requestId) {
      if (typeof requestId !== 'number' || !Number.isFinite(requestId) || typeof key !== 'string' || !key) return () => false
      let latest = bySender.get(senderId)
      if (!latest) { latest = new Map(); bySender.set(senderId, latest) }
      if (requestId >= (latest.get(key) ?? 0)) latest.set(key, requestId)
      const map = latest
      // Read through the sender's current map: once forgotten, nothing supersedes this request.
      return () => bySender.get(senderId) === map && (map.get(key) ?? 0) > requestId
    },
    forgetSender(senderId) { bySender.delete(senderId) },
    size() { let n = 0; for (const m of bySender.values()) n += m.size; return n }
  }
}
