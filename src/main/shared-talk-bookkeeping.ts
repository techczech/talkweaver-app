// Part of Share for comments (ticket 12 design: the header of src/main/shared-talk.ts, notes [j],
// [n], [o], [p], [q], [s]). The bookkeeping around a share that may or may not stand: create notes
// written before the POST, rows whose close got no answer, and the one place a closed share's row
// is removed.
import { readFileSync, rmSync } from 'fs'
import { basename, dirname, join } from 'path'
import { ownerTokenKey } from './owner-tokens.ts'
import {
  describe, interruptedShareMessage, recordNotRemovedMessage, RecordNotRemoved, writeFileAtomic,
  type InterruptedCreate, type PendingCreate, type SharedTalkRecord,
} from './shared-talk-model.ts'
import type { ShareCore } from './shared-talk-state.ts'
import type { Slot, Slots } from './shared-talk-slots.ts'

// ── creates noted down before the POST (round 2, finding 8) ─────────────────────────────────────
// The Worker makes the share's id and owner token itself (worker/shared-talk.ts createShare): no
// client token, no idempotency key. So the app notes the create (slug, service, talk) here before
// the POST, and drops the note once the reply is registered, or the service said no share was made.
// A note left behind (the app quit, the reply was lost) is REPORTED, never closed from here: no
// admin lookup or admin close is sent for it. The Worker closes a slug's previous share when a new one
// is created, so the talk's next Share retires it, and its registration drops the note.

export interface CreateNotes {
  /** Notes a create about to be sent; throws when the note cannot be written (nothing is created). */
  note(create: PendingCreate): string
  /** The POST for this note was answered or failed: from now on a note still here is left over. */
  answered(id: string): void
  drop(match: (id: string, create: PendingCreate) => boolean): void
  /** The talk's notes not under way in this run (a share from them may still be open). */
  leftoverFor(realPath: string): PendingCreate[]
  /** What the leftover notes for a talk say (the sheet's look, Stop with no row). */
  titleOf(create: PendingCreate): string
  /** The notes an earlier run left, still here: reported at start. */
  interruptedAtStart(): InterruptedCreate[]
}

export function createNotes(core: ShareCore): CreateNotes {
  const { deps, log } = core
  const pendingPath = join(dirname(deps.registryPath), 'shared-talk-pending-creates.json')
  function readPending(): Record<string, PendingCreate> {
    try {
      const parsed = JSON.parse(readFileSync(pendingPath, 'utf8')) as { creates?: unknown }
      return parsed && typeof parsed.creates === 'object' && parsed.creates ? parsed.creates as Record<string, PendingCreate> : {}
    } catch { return {} }
  }
  let noteSeq = 0
  /** Notes whose POST is being sent or awaited in this run. */
  const underWay = new Set<string>()
  /** Notes left by an earlier run: only these are reported at start (this run's own are in hand). */
  const notesAtStart = new Set(Object.keys(readPending()))
  function titleOf(create: PendingCreate): string {
    return create.title || basename(dirname(create.outlinePath)) || 'this talk'
  }
  return {
    note(create) {
      noteSeq += 1
      const id = `${process.pid}-${Date.now().toString(36)}-${noteSeq}`
      const all = readPending()
      all[id] = create
      writeFileAtomic(pendingPath, `${JSON.stringify({ version: 1, creates: all }, null, 2)}\n`, 0o600)
      underWay.add(id)
      return id
    },
    answered(id) { underWay.delete(id) },
    drop(match) {
      try {
        const all = readPending()
        const left = Object.fromEntries(Object.entries(all).filter(([id, create]) => !match(id, create)))
        if (Object.keys(left).length === Object.keys(all).length) return
        // No note left: no file (the user-data folder at rest holds only the registries).
        if (Object.keys(left).length === 0) rmSync(pendingPath, { force: true })
        else writeFileAtomic(pendingPath, `${JSON.stringify({ version: 1, creates: left }, null, 2)}\n`, 0o600)
      } catch (error) {
        log(`[shared-talk] a create note was not cleared: ${describe(error)}`) // cleared by the talk's next Share
      }
    },
    leftoverFor(realPath) {
      return Object.entries(readPending()).flatMap(([id, create]) => (create.realPath === realPath && !underWay.has(id) ? [create] : []))
    },
    titleOf,
    interruptedAtStart() {
      return Object.entries(readPending()).flatMap(([id, create]) => {
        if (!notesAtStart.has(id) || typeof create?.realPath !== 'string' || typeof create.outlinePath !== 'string') return []
        const title = titleOf(create)
        return [{ outlinePath: create.outlinePath, realPath: create.realPath, title, message: interruptedShareMessage(title) }]
      })
    },
  }
}

// ── rows that may or may not stand ──────────────────────────────────────────────────────────────

export interface RowBookkeeping {
  removeRow(slot: Slot, record: SharedTalkRecord): void
  verifyUncertain(slot: Slot, record: SharedTalkRecord): Promise<'open' | 'closed' | 'unknown'>
  /** An ended row (the owner socket found its share gone) is removed like a closed one. True when removed. */
  dropEnded(slot: Slot, record: SharedTalkRecord): boolean
}

export function createRowBookkeeping(core: ShareCore, slots: Pick<Slots, 'rowOf'>, reconcile: (slot: Slot) => Promise<void>): RowBookkeeping {
  const { deps, registry, registryFile, lastError, attempts, fileKeysOf, persist, emit, track, linkOf, remoteStatus, cancelPending, stopping, log } = core

  /**
   * The one place a share's row is removed (and its token forgotten), once the service has closed
   * it: the file first, then memory (round 2, finding 7). When the file cannot be written the row
   * stays in memory marked closed (no pushes, no link), its token is forgotten so a restart cannot
   * load it as live, and RecordNotRemoved says the share is closed but its record stayed.
   */
  function removeRow(slot: Slot, record: SharedTalkRecord): void {
    slot.madeUrls.add(linkOf(record))
    const rows = Object.fromEntries(Object.entries(registry.shares).filter(([, row]) => row !== record && !row.closedRemotely))
    const closedElsewhere = Object.values(registry.shares).filter((row) => row !== record && row.closedRemotely)
    try {
      registryFile.write(rows, { remove: [record, ...closedElsewhere].flatMap((row) => fileKeysOf(row.shareId)) })
    } catch (error) {
      record.closedRemotely = true
      record.ended = 'stopped'
      delete record.closeUncertain
      cancelPending(record.key)
      const tokenKey = ownerTokenKey('share', record.shareId, record.workerBaseUrl)
      if (tokenKey) deps.ownerTokens.forget([tokenKey])
      log(`[shared-talk] a closed share's row was not removed: ${describe(error)}`)
      throw new RecordNotRemoved(recordNotRemovedMessage(describe(error)))
    }
    for (const row of [record, ...closedElsewhere]) {
      if (registry.shares[row.key] === row) delete registry.shares[row.key]
      lastError.delete(row.key)
      attempts.delete(row.key)
    }
    for (const row of closedElsewhere) emit(row.key)
  }

  /**
   * A row whose last close got no answer (finding 6): asked on the service. Closed → removed;
   * open → kept, the mark cleared. 'unknown' when the service could not be asked. Runs in the
   * slot's queue.
   */
  async function verifyUncertain(slot: Slot, record: SharedTalkRecord): Promise<'open' | 'closed' | 'unknown'> {
    if (slots.rowOf(slot) !== record || !record.closeUncertain) return 'open'
    const status = await remoteStatus(record)
    if (status === 'open') {
      delete record.closeUncertain
      try { persist() } catch (error) { log(`[shared-talk] registry not written: ${describe(error)}`) }
    } else if (status === 'closed') {
      try { removeRow(slot, record) } finally {
        emit(record.key)
        track(reconcile(slot))
      }
    }
    return status
  }

  /** Runs in the slot's queue. Not while a Stop is running for it (the Stop removes it). A removal
   *  that fails leaves the row closedRemotely ([p]) and throws RecordNotRemoved. */
  function dropEnded(slot: Slot, record: SharedTalkRecord): boolean {
    if (slots.rowOf(slot) !== record || !record.ended || record.closedRemotely || stopping.has(record.shareId)) return false
    try { removeRow(slot, record) } finally {
      emit(record.key)
      track(reconcile(slot))
    }
    return true
  }

  return { removeRow, verifyUncertain, dropEnded }
}
