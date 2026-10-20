// What the participant work page keeps in the phone's browser (2026-10-19 prework-responses design,
// decisions 6, 7 and 10). Two stores, one per pre-work or post-work page (by its id), beside the device id
// the page already keeps:
//
//   tw-prework-local-<id>    the person's own entries for Local only steps (`{local}`): answers, done
//                            marks and read marks. They never leave the phone; the speaker never sees them.
//   tw-prework-outbox-<id>   submissions for Sent steps that have not reached the speaker yet, by the page's
//                            slot key (`answer:<step>`, `done:<step>`, `q:<id>`). A newer body for the same
//                            slot replaces the older one. Each is sent again when the phone is back online
//                            and on the next visit, with its own submission id, so the Worker never takes it
//                            twice. It is taken out once the Worker has it, or has refused it for good.
//
// A page with no storage (a preview, or a browser that refuses it) keeps both in memory for the visit.
// Self-contained: the page embeds it by `.toString()` (work-page.js workPageRuntimeSource).

/**
 * The page's browser store. `storage` is `{ get(key), set(key, value) }` or null.
 * @param {any} storage @param {string} preworkId
 */
export function createWorkPageStore(storage, preworkId) {
  const localKey = 'tw-prework-local-' + preworkId
  const outboxKey = 'tw-prework-outbox-' + preworkId
  const memory = new Map()
  function read(key, fallback) {
    let raw = memory.has(key) ? memory.get(key) : null
    if (raw === null && storage) { try { raw = storage.get(key) } catch (_) { raw = null } }
    if (typeof raw !== 'string' || !raw) return fallback
    try { const value = JSON.parse(raw); return value && typeof value === 'object' ? value : fallback } catch (_) { return fallback }
  }
  function write(key, value) {
    const raw = JSON.stringify(value)
    memory.set(key, raw)
    // Saved on the phone when it can be; a browser that refuses keeps it for this visit only.
    if (storage) { try { storage.set(key, raw); memory.delete(key) } catch (_) { /* kept in memory */ } }
  }
  const validEntry = (entry) => Boolean(entry) && typeof entry === 'object' && typeof entry.ref === 'string' && typeof entry.stepId === 'string'
    && (entry.kind === 'read' || entry.kind === 'answer' || entry.kind === 'done')
  const validBody = (body) => Boolean(body) && typeof body === 'object' && typeof body.stepId === 'string' && typeof body.submissionId === 'string'
    && typeof body.participantId === 'string' && typeof body.kind === 'string'
  return {
    /** The entries of Local only steps, as the page keeps them. */
    localEntries() {
      const list = read(localKey, [])
      return Array.isArray(list) ? list.filter(validEntry) : []
    },
    /** Keep one Local only entry; a later one for the same ref replaces it. */
    putLocal(entry) {
      const list = this.localEntries().filter((held) => held.ref !== entry.ref)
      list.push(entry)
      write(localKey, list)
    },
    /** What has not reached the speaker yet, as `[slot key, body]` pairs. */
    outbox() {
      const box = read(outboxKey, {})
      return Object.keys(box).filter((key) => validBody(box[key])).map((key) => [key, box[key]])
    },
    putOutbox(key, body) {
      const box = read(outboxKey, {})
      box[key] = body
      write(outboxKey, box)
    },
    /** Take a slot out, but only while it still holds this body (a newer one stays). */
    dropOutbox(key, body) {
      const box = read(outboxKey, {})
      if (!(key in box) || (body && box[key] && box[key].submissionId !== body.submissionId)) return
      delete box[key]
      write(outboxKey, box)
    },
    hasOutbox(key) {
      return Object.prototype.hasOwnProperty.call(read(outboxKey, {}), key)
    },
  }
}

export function workPageStoreSource() {
  return createWorkPageStore.toString()
}
