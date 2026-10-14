// Part of Share for comments (ticket 12 design: the header of src/main/shared-talk.ts, sections 2–3).
// The two kinds of step the talk's queue holds — create (k1, k1', e3–e5x) and close (e9–e10x) — and
// the Share op around a create (k2, [R*]).
import { isShareId } from '../shared/share-id.ts'
import { OwnerRequestError, ownerFetch, validOwnerToken } from './owner-tokens.ts'
import { LIVE_ACCESS_REMOVED, sendAsAdmin } from './live-admin-request.ts'
import { isSharedTalkStopped, STOPPED_LOCALLY_MESSAGE, type SharedTalkStopResult } from '../shared/shared-talk.ts'
import {
  describe, errorMessage, HttpError, NotKept, readJson, SHARE_LOCKED, SHARE_NOT_KEPT, SHARE_NOT_KEPT_OPEN, SHARE_NOT_NOTED,
  SHARE_RACED, SHARE_UNVERIFIED, stopInterruptedMessage, workerTalkSlug,
  type Shared, type SharedTalkRecord, type PushMode,
} from './shared-talk-model.ts'
import type { ShareCore } from './shared-talk-state.ts'
import type { Slot, Slots } from './shared-talk-slots.ts'
import type { CreateNotes, RowBookkeeping } from './shared-talk-bookkeeping.ts'

export interface ShareSteps {
  /** One Share request (e1): the create step in the queue, then QR, share_url and the first push
   *  outside it, checked at k2 after each. */
  shareOp(slot: Slot, outlinePath: string, title: string | undefined, gen: number): Promise<Shared>
  /** The close step (in the slot's queue): closes whatever row the slot holds now. */
  closeStep(slot: Slot): Promise<{ closed: boolean; result: SharedTalkStopResult }>
}

export function createShareSteps(
  core: ShareCore,
  slots: Slots,
  notes: CreateNotes,
  rows: RowBookkeeping,
  reconcile: (slot: Slot) => Promise<void>,
  enqueue: (key: string, mode: PushMode) => Promise<void>,
): ShareSteps {
  const { deps, registry, registryFile, stopping, inFlight, lastError, creating, recordFor, unusableRowsFor, persist, emit, withQr, cancelPending, log, now } = core
  const { steps, rowOf, settle } = slots
  const { removeRow, verifyUncertain, dropEnded } = rows

  /**
   * The POST that makes a share. Null when a Stop was pressed before it was sent (k1). `asSeen`
   * throws when the registry file no longer holds what the create step saw (finding 5: another
   * instance registered a share for this talk meanwhile); it runs after the last await before the
   * POST, so the Worker never closes a share another instance registered after that look.
   */
  async function createRemote(slot: Slot, slug: string, title: string, superseded: () => boolean, asSeen: () => void): Promise<{ record: SharedTalkRecord; note: string } | null> {
    // A share whose owner token could not be kept is never made: it could not be updated or stopped.
    registryFile.assertCanStore()
    const endpoint = await deps.endpoint()
    // k1: a Stop pressed while the endpoint was being fetched — nothing is created.
    if (superseded()) return null
    let base: string
    try { base = new URL(endpoint.baseUrl).origin } catch { throw new Error('Could not create the share: the sharing service address is not valid.') }
    const workerSlug = workerTalkSlug(slug, slot.realPath)
    asSeen()
    // k1': noted down before the POST (finding 8), so a share the reply never registers is reported.
    let note: string
    try {
      note = notes.note({ workerSlug, workerBaseUrl: base, realPath: slot.realPath, outlinePath: slot.outlinePath, sentAt: now().toISOString(), title })
    } catch (error) {
      log(`[shared-talk] create note not written: ${describe(error)}`)
      throw new Error(SHARE_NOT_NOTED)
    }
    let response: Response
    let refused: boolean
    let body: { shareId?: unknown; ownerToken?: unknown } | null
    try {
      // No answer (the request failed in transit): the share may exist, so the note stays.
      // Each key held for the live service is tried, as Go live does (live-admin-request.ts): a key
      // refused by its 401 made no share, so the next try makes the only one.
      ;({ response, refused } = await sendAsAdmin(deps.fetch, endpoint, `${base}/shares`, () => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ talkSlug: workerSlug, title }),
        signal: AbortSignal.timeout(15_000),
      })))
      body = await readJson(response) as { shareId?: unknown; ownerToken?: unknown } | null
    } finally {
      notes.answered(note)
    }
    if (refused) {
      // Every key this computer holds for the live service was refused: no share was made.
      notes.drop((id) => id === note)
      throw new HttpError(401, LIVE_ACCESS_REMOVED)
    }
    if (!response.ok) {
      // The Worker answers an error only when it made no share (or discarded the one it made).
      notes.drop((id) => id === note)
      throw new HttpError(response.status, `Could not create the share: ${errorMessage(body, `the sharing service answered ${response.status}.`)}`)
    }
    // A 201 the app cannot use: a share may stand without a usable token, so the note stays.
    if (!isShareId(body?.shareId)) throw new Error('Could not create the share: the sharing service returned an id this app does not accept.')
    if (!validOwnerToken(body?.ownerToken)) throw new Error('Could not create the share: the sharing service returned an unusable owner credential.')
    // Not cancelled after the reply: the share exists, so it is registered (its token kept first) and
    // a queued close step closes it. The slot's identity NOW: the outline may have been replaced meanwhile.
    return {
      note,
      record: {
        key: slot.key, slug, workerSlug, outlinePath: slot.outlinePath, realPath: slot.realPath,
        shareId: body.shareId, ownerToken: body.ownerToken, workerBaseUrl: base,
        revision: 0, liveUpdates: true, proposals: true,
        createdAt: now().toISOString(), lastPushedAt: null, lastPushHash: null,
      },
    }
  }

  /** Close a share on the service with its own token. True when the service confirms it is closed or gone. */
  async function closeRemote(record: SharedTalkRecord): Promise<boolean> {
    try {
      const response = await ownerFetch(deps.fetch, `${record.workerBaseUrl}/shares/${record.shareId}/close`, record.ownerToken, {
        method: 'POST', signal: AbortSignal.timeout(15_000),
      })
      return response.ok || response.status === 410 || response.status === 404
    } catch { return false }
  }

  /**
   * The create step (in the slot's queue): the talk's row if it has one, else a new share, stored and
   * registered in one synchronous step with the create reply (e3 → e5). Null: skipped at k1.
   */
  async function createStep(slot: Slot, outlinePath: string, slug: string, title: string | undefined, superseded: () => boolean): Promise<{ record: SharedTalkRecord; made: boolean } | null> {
    // Asked before the rows are looked up, so a row still without its token is known to be for good.
    const storeReadable = deps.ownerTokens.readable()
    let existing = recordFor(outlinePath)
    // Closed on the service, its row not removed (finding 7): removed now, or the Share fails saying so.
    if (existing?.closedRemotely) {
      try { removeRow(slot, existing) } finally { emit(existing.key) }
      existing = null
    }
    // Ended on the service (the owner socket said so): gone, so its row is removed and a new share made.
    if (existing?.ended && dropEnded(slot, existing)) existing = null
    // Its last close got no answer (finding 6): the service is asked before the link is returned.
    if (existing?.closeUncertain) {
      const status = await verifyUncertain(slot, existing)
      if (status === 'unknown') throw new Error(SHARE_UNVERIFIED)
      if (status === 'closed') existing = null
    }
    if (existing) return { record: existing, made: false }
    // The talk has a row this cannot use. While secure storage cannot be read that row is a working
    // share whose token is out of reach: it is left alone, and no new share is made (the service
    // would end the earlier one).
    const unusable = unusableRowsFor(deps.identityOf(outlinePath), outlinePath)
    if (unusable.length > 0 && !storeReadable) throw new Error(SHARE_LOCKED)
    const expect: Record<string, string | null> = {}
    for (const fileKey of unusable) expect[fileKey] = registryFile.idAt(fileKey)
    // Checked again right before the POST (finding 5), not only on the write after it.
    const asSeen = (): void => {
      const now = unusableRowsFor(deps.identityOf(outlinePath), outlinePath)
      const changed = now.some((fileKey) => !Object.prototype.hasOwnProperty.call(expect, fileKey))
        || Object.entries(expect).some(([fileKey, id]) => registryFile.idAt(fileKey) !== id)
        || (!Object.prototype.hasOwnProperty.call(expect, slot.key) && registryFile.idAt(slot.key) !== null)
      if (changed) throw new Error(SHARE_RACED)
    }
    const made = await createRemote(slot, slug, title || slug, superseded, asSeen)
    if (!made) return null
    const { record, note } = made
    // Stored (and read back) before anything is pushed. If that fails — or the file no longer holds
    // what was seen (the backstop `expect`) — the share is closed while its token is still here:
    // nothing is left on the service that cannot be stopped.
    if (!Object.prototype.hasOwnProperty.call(expect, record.key)) expect[record.key] = null
    registry.shares[record.key] = record
    try {
      registryFile.write(registry.shares, { remove: unusable, expect }) // dead rows of this talk are replaced by name
    } catch {
      // Compensation: this create's own share is closed with its token in hand, and the Share fails.
      // (A refusal from `expect` cannot come from another TalkWeaver: one instance per user-data
      // folder, index.ts.)
      delete registry.shares[record.key]
      const closed = await closeRemote(record)
      if (closed) notes.drop((id) => id === note)
      if (closed) throw new NotKept(SHARE_NOT_KEPT, record.shareId)
      throw new Error(SHARE_NOT_KEPT_OPEN)
    }
    // Registered: this note is done, and so is any older one for the same slug — the create closed
    // the slug's previous share on the service, so a share an earlier run left open is retired.
    notes.drop((id, create) => id === note || (create.workerSlug === record.workerSlug && create.workerBaseUrl === record.workerBaseUrl))
    emit(record.key)
    return { record, made: true }
  }

  async function shareOp(slot: Slot, outlinePath: string, title: string | undefined, gen: number): Promise<Shared> {
    const superseded = (): boolean => slot.stopGen !== gen
    const slug = deps.slugOf(outlinePath)
    let outcome: { record: SharedTalkRecord; made: boolean } | null
    try {
      const step = steps.run(slot.id, () => createStep(slot, outlinePath, slug, title, superseded))
      creating.add(step)
      void step.catch(() => {}).finally(() => creating.delete(step))
      outcome = await step
    } catch (error) {
      // An orphan on the service is always a failure the person must hear of.
      if (!superseded() || (error instanceof Error && error.message === SHARE_NOT_KEPT_OPEN)) throw error
      return { stopped: true, shareId: error instanceof NotKept ? error.shareId : null }
    }
    if (!outcome) return settle(slot, gen, null)
    const { record, made } = outcome
    let reconciled = false
    if (made) {
      if (!superseded()) await withQr(record)
      if (!superseded()) { await reconcile(slot); reconciled = true }
      // The first push: a failure is shown on the sheet (lastError), the share itself stands.
      if (!superseded()) await enqueue(record.key, { kind: 'current' }).catch(() => {})
    } else if (!superseded()) {
      // Resolved to the talk's existing row (finding 4): its share_url is reconciled too.
      await reconcile(slot)
      reconciled = true
      if (record.revision === 0) await enqueue(record.key, { kind: 'current' }).catch(() => {})
    }
    const result = await settle(slot, gen, record)
    if (reconciled || isSharedTalkStopped(result)) return result
    // A Share that ends with a live row whose reconcile was skipped (a Stop that came and failed):
    // the line is written now, and the result read again after it.
    await reconcile(slot)
    return settle(slot, gen, record)
  }

  async function closeStep(slot: Slot): Promise<{ closed: boolean; result: SharedTalkStopResult }> {
    let record: SharedTalkRecord | null = null
    let closed = false
    try {
      record = rowOf(slot)
      if (!record) {
        // Nothing registered — but a create of this talk noted down and never registered (the app
        // quit, the reply was lost: finding 8) may have left a share open. Nothing can close it
        // from here (its token was never kept, and no admin secret is sent on a stop): the Stop
        // says so, and the talk's next Share replaces it.
        const [left] = notes.leftoverFor(slot.realPath)
        if (left) throw new Error(stopInterruptedMessage(notes.titleOf(left)))
        return { closed: false, result: { serverClosed: true, message: null } }
      }
      // Closed on the service already, its row still to remove (finding 7).
      if (record.closedRemotely) {
        removeRow(slot, record)
        closed = true
        return { closed: true, result: { serverClosed: true, message: null } }
      }
      // Nothing is pushed from here on: pending saves dropped, queued pushes skip, the running one
      // is aborted (and its reply, if it lands, is never confirmed).
      stopping.add(record.shareId)
      cancelPending(record.key)
      inFlight.get(record.shareId)?.abort()
      let response: Response
      try {
        // The share's own origin and owner token only — never an admin secret, never elsewhere.
        response = await ownerFetch(deps.fetch, `${record.workerBaseUrl}/shares/${record.shareId}/close`, record.ownerToken, {
          method: 'POST', signal: AbortSignal.timeout(15_000),
        })
      } catch (error) {
        // Sent, and no answer (finding 6): the service may have closed it. Marked, so the next
        // Share or inspect asks before returning this link. (bad-token: never sent.)
        if (!(error instanceof OwnerRequestError) || error.reason !== 'bad-token') {
          record.closeUncertain = true
          try { persist() } catch (persistError) { log(`[shared-talk] registry not written: ${describe(persistError)}`) }
        }
        lastError.set(record.key, describe(error))
        throw new Error(`Could not stop sharing: ${describe(error)}`)
      }
      let result: SharedTalkStopResult = { serverClosed: true, message: null }
      if (response.status === 401 || response.status === 403) {
        result = { serverClosed: false, message: STOPPED_LOCALLY_MESSAGE }
        log(`[shared-talk] owner token refused on close (${response.status}); stopped locally`)
      } else if (!response.ok && response.status !== 410 && response.status !== 404) {
        // 410/404: already closed or retired on the Worker — stopping here is the right outcome.
        const message = errorMessage(await readJson(response), `the sharing service answered ${response.status}.`)
        lastError.set(record.key, message)
        throw new Error(`Could not stop sharing: ${message}`)
      }
      // Removed from the file before memory; a failed write throws RecordNotRemoved (finding 7).
      removeRow(slot, record)
      closed = true
      // The feedback folder (items, revision slide text) is his record and stays.
      return { closed: true, result }
    } finally {
      slot.closesPending -= 1
      if (record) {
        // A failed close leaves the share as it was, unless another Stop is still to try.
        if (closed || record.closedRemotely || slot.closesPending === 0) stopping.delete(record.shareId)
        emit(record.key)
      }
    }
  }

  return { shareOp, closeStep }
}
