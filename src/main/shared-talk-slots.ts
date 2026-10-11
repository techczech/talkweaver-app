// Part of Share for comments (ticket 12 design: the header of src/main/shared-talk.ts, section 2).
// The talk slot, the keyed queue of create and close steps (by slot id), the stop generation, and
// the [R*] / [R*'] rules every reply follows.
import { createKeyedQueue } from './owner-tokens.ts'
import type { SharedTalkState } from '../shared/shared-talk.ts'
import { SHARE_UNVERIFIED } from './shared-talk-model.ts'
import type { Shared, SharedTalkRecord } from './shared-talk-model.ts'
import type { ShareCore } from './shared-talk-state.ts'

/** One talk's share requests (ticket 12 design, section 2). `id` never changes; key and realPath
 *  follow the talk (slotFor). */
export interface Slot {
  id: string
  key: string
  realPath: string
  outlinePath: string
  stopGen: number
  /** The Share in flight, joined by a later Share only while no Stop came between. */
  pending?: { gen: number; promise: Promise<Shared> }
  /** The Stops pressed and not yet settled (the design's lastStop: a Share waits for all of them). */
  stops: Set<Promise<void>>
  /** Close steps queued or running. */
  closesPending: number
  /** Every link this module wrote as the talk's share_url: the only values a tidy-up may remove. */
  madeUrls: Set<string>
}

export interface Slots {
  /** Talk slots by slot id. */
  slots: Map<string, Slot>
  /** The queue of create and close steps, keyed by slot id. */
  steps: ReturnType<typeof createKeyedQueue>
  slotFor(outlinePath: string): Slot
  rowOf(slot: Slot): SharedTalkRecord | null
  currentState(slot: Slot, record: SharedTalkRecord): Promise<SharedTalkState | null>
  settle(slot: Slot, gen: number, record: SharedTalkRecord | null): Promise<Shared>
}

export function createSlots(core: ShareCore): Slots {
  const { deps, registry, stopping, withQr } = core
  const slots = new Map<string, Slot>()
  let slotSeq = 0
  const steps = createKeyedQueue()

  /** The talk's slot, found by the identity NOW (key or real path, the rule recordFor uses for rows)
   *  and re-keyed to it; made when the talk has none. */
  function slotFor(outlinePath: string): Slot {
    const identity = deps.identityOf(outlinePath)
    let slot = [...slots.values()].find((candidate) => candidate.key === identity.key)
      ?? [...slots.values()].find((candidate) => candidate.realPath === identity.realPath)
    if (!slot) {
      slotSeq += 1
      slot = { id: `slot-${slotSeq}`, key: identity.key, realPath: identity.realPath, outlinePath, stopGen: 0, stops: new Set(), closesPending: 0, madeUrls: new Set() }
      slots.set(slot.id, slot)
    }
    slot.key = identity.key
    slot.realPath = identity.realPath
    slot.outlinePath = outlinePath
    return slot
  }
  /** The slot's row: under its key, or (not re-keyed yet) the row for the same real path. */
  function rowOf(slot: Slot): SharedTalkRecord | null {
    return registry.shares[slot.key] ?? Object.values(registry.shares).find((record) => record.realPath === slot.realPath) ?? null
  }

  /** A row whose share is gone: closed here with its record not removed, or ended (the owner
   *  socket found it stopped, retired or refusing the token). Never offered as a link. */
  const gone = (record: SharedTalkRecord): boolean => !!record.closedRemotely || !!record.ended
  /** The one predicate for "may this row be offered as a live link" (round 4): not gone, not
   *  stopping, and not closeUncertain (its close may have happened; a link is never offered until
   *  the service has been asked, and a reply that cannot ask fails with SHARE_UNVERIFIED). */
  const offerable = (record: SharedTalkRecord): boolean => !gone(record) && !stopping.has(record.shareId) && !record.closeUncertain
  /** A reply about a row that is the slot's row, not gone, and uncertainly closed fails. */
  const failIfUnverified = (slot: Slot, record: SharedTalkRecord | null): void => {
    if (record && rowOf(slot) === record && !gone(record) && record.closeUncertain) throw new Error(SHARE_UNVERIFIED)
  }

  /**
   * [R*] for every reply that is not a Share (round 2, findings 1 and 2): the share's state only
   * while it is still the slot's row with no Stop pressed or running, read AFTER the last await;
   * a running Stop is waited out first. Null when the share is gone (the caller says stopped).
   */
  async function currentState(slot: Slot, record: SharedTalkRecord): Promise<SharedTalkState | null> {
    for (;;) {
      if (rowOf(slot) !== record || gone(record)) return null
      if (stopping.has(record.shareId) || slot.stops.size > 0) {
        if (slot.stops.size === 0) return null
        await Promise.all([...slot.stops])
        continue
      }
      failIfUnverified(slot, record)
      const state = await withQr(record)
      if (rowOf(slot) === record && slot.stops.size === 0) {
        failIfUnverified(slot, record)
        if (offerable(record)) return state
      }
    }
  }

  /**
   * [R*]: what a Share op returns after its last await — its own link while its share is the talk's
   * row and no Stop is pressed or running; once every Stop has settled, its own link if the share is
   * still the row (the Stop failed), else stopped. Never another share's state.
   */
  async function settle(slot: Slot, gen: number, record: SharedTalkRecord | null): Promise<Shared> {
    const holds = (): boolean => !!record && rowOf(slot) === record && offerable(record)
    for (;;) {
      if (slot.stopGen === gen && holds()) {
        const state = await withQr(record!)
        if (slot.stopGen === gen && holds()) return state
        continue
      }
      if (slot.stops.size > 0) {
        await Promise.all([...slot.stops])
        continue
      }
      failIfUnverified(slot, record)
      if (holds()) {
        const state = await withQr(record!)
        failIfUnverified(slot, record)
        if (slot.stops.size === 0 && holds()) return state
        continue
      }
      return { stopped: true, shareId: record?.shareId ?? null }
    }
  }

  return { slots, steps, slotFor, rowOf, currentState, settle }
}
