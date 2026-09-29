// Outline external-change guard, renderer side (shared-talk ticket 01). The main process
// (src/main/outline-disk-guard.ts) notices when the open talk's outline file differs from what the
// editor holds, refuses every save over it, and reports the difference here: by push (the watcher) and
// in the refused save's reply. This module holds that state per outline path (the bar at the top of the
// talk reads it) and carries out the person's answers:
//
//   changed   Reload     — the disk text goes into the editor as ONE undoable change (⌘Z brings the
//                          person's version back), then that disk version is accepted.
//             Keep mine  — the version the person saw is accepted, then the editor's text is saved.
//   removed   Save it again (Keep mine's mechanics: accept the removal, save, which recreates the file)
//             Discard    — the talk is let go without saving it again.
//   partial   Save again (accept the incomplete file, save the editor's text over it). Never Reload.
//   recovery  Restore my unsaved text — the recovery copy an earlier session kept goes into the editor
//             as one undoable change and is saved; Discard drops the copy.
//
// Every accept names the version the bar showed. If the file changed again since, main refuses with the
// newer change and the bar shows that instead: nothing newer is ever overwritten unseen. The accept runs
// through the file's save queue, so a save queued before it can never land after it.
//
// Leaving the talk (a switch, closing the window, ⌘Q) goes through `guardLeave`: pending typing is
// flushed first; while a difference remains, the person must choose (the sheet), and the leave goes
// ahead only once Reload / Keep mine (or Save it again / Discard) has completed.
import type { OutlineDiskAccept, OutlineDiskChange, OutlineRecoveryCopy } from '../../../shared/outline-disk-change.ts'

export type { OutlineDiskChange }

export interface OutlineDiskChangeStore {
  /** The unresolved difference for `outlinePath`, or null. */
  get(outlinePath: string): OutlineDiskChange | null
  /** Records a difference (a newer version replaces an older one; a disk difference replaces a
   *  recovery offer, never the other way round). */
  report(change: OutlineDiskChange): void
  /** Clears `outlinePath`'s difference (only while it is still version `hash`, when given). */
  clear(outlinePath: string, hash?: string): void
  /** The person discarded this talk (removed on disk): its editor must not save it again. */
  discard(outlinePath: string): void
  isDiscarded(outlinePath: string): boolean
  /** A fresh load of the talk: forget its discard and its difference. */
  loaded(outlinePath: string): void
  /** Called after every change to the store; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void
}

export function createOutlineDiskChangeStore(): OutlineDiskChangeStore {
  const changes = new Map<string, OutlineDiskChange>()
  const discarded = new Set<string>()
  const listeners = new Set<() => void>()
  const emit = (): void => { for (const listener of [...listeners]) { try { listener() } catch { /* a listener never breaks the store */ } } }
  return {
    get: (outlinePath) => changes.get(outlinePath) ?? null,
    report(change) {
      const previous = changes.get(change.outlinePath)
      if (previous && previous.hash === change.hash && previous.changedAt === change.changedAt && previous.saveError === change.saveError) return
      if (change.kind === 'recovery' && previous && previous.kind !== 'recovery') return
      changes.set(change.outlinePath, change)
      emit()
    },
    clear(outlinePath, hash) {
      const previous = changes.get(outlinePath)
      if (!previous || (hash !== undefined && previous.hash !== hash)) return
      changes.delete(outlinePath)
      emit()
    },
    discard(outlinePath) { discarded.add(outlinePath); changes.delete(outlinePath); emit() },
    isDiscarded: (outlinePath) => discarded.has(outlinePath),
    loaded(outlinePath) {
      const hadChange = changes.delete(outlinePath)
      const hadDiscard = discarded.delete(outlinePath)
      if (hadChange || hadDiscard) emit()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/** This window's store (the bar, the sheet and every save path share it). */
export const outlineDiskChanges = createOutlineDiskChangeStore()

type SaveReplyLike = { ok?: unknown; refused?: unknown; change?: unknown } | false | null | undefined

/** True when a save reply is the guard's refusal (the file differs from the editor); the change is recorded. */
export function noteOutlineSaveReply(reply: SaveReplyLike, store: OutlineDiskChangeStore = outlineDiskChanges): boolean {
  if (!reply || typeof reply !== 'object' || reply.ok !== false || reply.refused !== 'changed-on-disk') return false
  const change = reply.change as OutlineDiskChange | undefined
  if (change && typeof change.outlinePath === 'string' && typeof change.hash === 'string') store.report(change)
  return true
}

export interface OutlineDiskResolverDeps {
  store: OutlineDiskChangeStore
  /** Resolves once every save queued so far for the file has finished (lib/saveQueue outlineWritesSettled). */
  settled(outlinePath: string): Promise<void>
  /** Runs `work` in the file's save queue (lib/saveQueue queueOutlineWrite). */
  queue<T>(outlinePath: string, work: () => Promise<T>): Promise<T>
  /** The file's text and version on disk now (window.tw.talk.outlineDiskVersion). */
  diskVersion(outlinePath: string): Promise<{ text: string; hash: string } | null>
  /** Accepts version `hash` as the baseline (window.tw.talk.acceptOutlineDiskVersion). `keepPending`:
   *  a save follows, and the difference stays reported until it lands. */
  accept(outlinePath: string, hash: string, opts?: { keepPending?: boolean }): Promise<OutlineDiskAccept>
  /** The editor's live text for the talk, or null when the editor does not hold it. */
  readBuffer(outlinePath: string): string | null
  /** Puts `text` into the editor as one undoable change (no save of its own). False when not ready. */
  replaceBuffer(outlinePath: string, text: string): boolean
  /** Saves the editor's buffer as it stands through the file's queue (the D1 seam, forced). */
  saveBuffer(outlinePath: string): Promise<boolean>
  /** The recovery copy for the talk (window.tw.talk.outlineRecovery), and dropping it. */
  recovery?(outlinePath: string): Promise<OutlineRecoveryCopy | null>
  discardRecovery?(outlinePath: string): Promise<boolean>
  /** The person discarded a talk removed on disk (window.tw.talk.discardRemovedOutline). */
  discardRemoved?(outlinePath: string): Promise<boolean>
}

export type ResolveResult =
  | { ok: true; replacedEdits?: boolean }
  | { ok: false; error: string; change?: OutlineDiskChange }

const NOT_READY = 'The talk is not ready in the editor. Nothing was changed; try again.'
const GONE = 'The talk’s file is no longer on disk, so there is nothing to reload. Save it again keeps your text.'
const CHANGED_AGAIN = 'The talk changed on disk again. Nothing was changed: look at the newer version and choose again.'
const NO_RECOVERY = 'The unsaved text is no longer kept. Nothing was changed.'
const errorOf = (reply: OutlineDiskAccept): string => (!reply.ok && reply.error) || CHANGED_AGAIN

async function acceptInQueue(outlinePath: string, hash: string, deps: OutlineDiskResolverDeps, keepPending = false): Promise<OutlineDiskAccept> {
  const reply = await deps.queue(outlinePath, () => deps.accept(outlinePath, hash, keepPending ? { keepPending: true } : undefined))
  if (reply.ok) { if (!keepPending) deps.store.clear(outlinePath, hash) }
  else if (reply.change) deps.store.report({ ...reply.change, outlinePath })
  return reply
}
const refused = (reply: OutlineDiskAccept): ResolveResult =>
  ({ ok: false, error: errorOf(reply), ...(!reply.ok && reply.change ? { change: reply.change } : {}) })

/** Reload (a `changed` file only): the disk text replaces the editor's as one undoable change, then that
 *  version is accepted. `replacedEdits`: the editor held other text (the caller says ⌘Z restores it). */
export async function reloadFromDisk(outlinePath: string, deps: OutlineDiskResolverDeps): Promise<ResolveResult> {
  await deps.settled(outlinePath)
  const disk = await deps.diskVersion(outlinePath)
  if (!disk) return { ok: false, error: GONE }
  const before = deps.readBuffer(outlinePath)
  if (before === null) return { ok: false, error: NOT_READY }
  if (before !== disk.text && !deps.replaceBuffer(outlinePath, disk.text)) return { ok: false, error: NOT_READY }
  const accepted = await acceptInQueue(outlinePath, disk.hash, deps)
  if (!accepted.ok) return refused(accepted)
  // The person chose the disk's version: text kept from a refused save is dropped with it.
  await deps.discardRecovery?.(outlinePath).catch(() => false)
  return { ok: true, replacedEdits: before !== disk.text }
}

/** Keep mine / Save it again / Save again: accepts the version the person saw (`change.hash`), then
 *  saves the editor's text over it. The bar (and main's pending difference) stays until that save has
 *  landed; a save that fails keeps it, with the failure shown in the bar (and the text in main's
 *  recovery copy). */
export async function keepMine(outlinePath: string, change: OutlineDiskChange, deps: OutlineDiskResolverDeps): Promise<ResolveResult> {
  if (deps.readBuffer(outlinePath) === null) return { ok: false, error: NOT_READY }
  const accepted = await acceptInQueue(outlinePath, change.hash, deps, true)
  if (!accepted.ok) return refused(accepted)
  if (await deps.saveBuffer(outlinePath)) { deps.store.clear(outlinePath); return { ok: true } }
  const now = deps.store.get(outlinePath)
  const why = now?.saveError ? ` (${now.saveError})` : ''
  return { ok: false, error: `Your text could not be saved to the file on disk${why}. It is kept as unsaved text; try again.`, ...(now ? { change: now } : {}) }
}

/** Main said the file no longer differs from the editor (the other side reverted it, or put back the
 *  version the editor had). Typing made while the bar was up has not been saved: save the buffer now,
 *  so it lands. `busy`: a choice is under way (its own save is what cleared it), so nothing to do. */
export async function saveAfterDiskCleared(outlinePath: string, deps: Pick<OutlineDiskResolverDeps, 'readBuffer' | 'saveBuffer'> & { busy: boolean }): Promise<boolean> {
  if (deps.busy || deps.readBuffer(outlinePath) === null) return false
  return deps.saveBuffer(outlinePath)
}

/** Discard (a talk removed on disk): the talk is let go; its editor never saves it again. */
export async function discardRemoved(outlinePath: string, deps: OutlineDiskResolverDeps): Promise<ResolveResult> {
  deps.store.discard(outlinePath)
  await deps.discardRemoved?.(outlinePath)
  return { ok: true }
}

/** After a load: offers the recovery copy an earlier session kept when it differs from `loaded` (a copy
 *  equal to the file is dropped silently). */
export async function lookForRecovery(outlinePath: string, loaded: string, deps: Pick<OutlineDiskResolverDeps, 'store' | 'recovery' | 'discardRecovery'>): Promise<void> {
  const copy = await deps.recovery?.(outlinePath).catch(() => null)
  if (!copy) return
  if (copy.text === loaded) { await deps.discardRecovery?.(outlinePath).catch(() => false); return }
  deps.store.report({ outlinePath, kind: 'recovery', hash: 'recovery', changedAt: copy.savedAt })
}

/** Restore my unsaved text: the recovery copy goes into the editor as one undoable change and is saved
 *  (main drops the copy once that save lands). */
export async function restoreRecovery(outlinePath: string, deps: OutlineDiskResolverDeps): Promise<ResolveResult> {
  const copy = await deps.recovery?.(outlinePath).catch(() => null)
  if (!copy) { deps.store.clear(outlinePath, 'recovery'); return { ok: false, error: NO_RECOVERY } }
  if (deps.readBuffer(outlinePath) === null || !deps.replaceBuffer(outlinePath, copy.text)) return { ok: false, error: NOT_READY }
  deps.store.clear(outlinePath, 'recovery')
  if (await deps.saveBuffer(outlinePath)) return { ok: true, replacedEdits: true }
  const now = deps.store.get(outlinePath)
  return { ok: false, error: 'The restored text is in the editor, but it could not be saved yet.', ...(now ? { change: now } : {}) }
}

/** Discard on the recovery offer: the copy is dropped. */
export async function discardRecovery(outlinePath: string, deps: OutlineDiskResolverDeps): Promise<ResolveResult> {
  deps.store.clear(outlinePath, 'recovery')
  await deps.discardRecovery?.(outlinePath)
  return { ok: true }
}

/** The person's answer on the bar or the sheet. */
export type OutlineDiskChoice = 'reload' | 'keep' | 'discard' | 'restore' | 'stay'

/** Carries out a choice for the talk's current difference `change`. */
export function resolveChoice(outlinePath: string, change: OutlineDiskChange, choice: Exclude<OutlineDiskChoice, 'stay'>, deps: OutlineDiskResolverDeps): Promise<ResolveResult> {
  if (change.kind === 'recovery') return choice === 'restore' ? restoreRecovery(outlinePath, deps) : discardRecovery(outlinePath, deps)
  if (choice === 'reload' && change.kind === 'changed') return reloadFromDisk(outlinePath, deps)
  if (choice === 'discard' && change.kind === 'removed') return discardRemoved(outlinePath, deps)
  return keepMine(outlinePath, change, deps)
}

export interface LeaveGuardDeps extends OutlineDiskResolverDeps {
  /** Flushes the editor's pending typing to disk (a refusal records the difference). */
  flush(): Promise<void>
  /** Shows the sheet for `change` and resolves with the person's choice. */
  ask(change: OutlineDiskChange): Promise<OutlineDiskChoice>
  /** Tells the person why a choice did not complete (the sheet then asks again). */
  report?(error: string): void
}

/** Before leaving the talk (switch, close, quit): true when the leave may go ahead. Pending typing is
 *  flushed; while the file differs from the editor, the person chooses, and the leave waits until the
 *  choice has completed. Stay here (or a failing choice the person then leaves) answers false. A
 *  recovery offer never blocks a leave (the copy stays for the next open). */
export async function guardLeave(outlinePath: string, deps: LeaveGuardDeps): Promise<boolean> {
  if (!deps.store.isDiscarded(outlinePath)) await deps.flush()
  await deps.settled(outlinePath)
  for (;;) {
    const change = deps.store.get(outlinePath)
    if (!change || change.kind === 'recovery' || deps.store.isDiscarded(outlinePath)) return true
    const choice = await deps.ask(change)
    if (choice === 'stay') return false
    const result = await resolveChoice(outlinePath, change, choice, deps)
    if (!result.ok) deps.report?.(result.error)
    else if (!deps.store.get(outlinePath)) return true
  }
}

/** The bar's clock time for a change: "09:12" (24-hour), with the day when it was not today. */
export function changedAtLabel(changedAt: number, now: number = Date.now()): string {
  const at = new Date(changedAt)
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return new Date(now).toDateString() === at.toDateString()
    ? time
    : `${time} on ${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
}

/** What the bar and the sheet say for a difference, and the choices they offer (in order). */
export function describeDiskChange(change: OutlineDiskChange): { text: string; sheetTitle: string; actions: Array<{ choice: Exclude<OutlineDiskChoice, 'stay'>; label: string; title: string }> } {
  const base = describeKind(change)
  // A choice was made but its save failed: the bar says so (the choice is offered again).
  return change.saveError
    ? { ...base, text: `${base.text} — saving your text failed (${change.saveError}); it is kept as unsaved text` }
    : base
}

function describeKind(change: OutlineDiskChange): ReturnType<typeof describeDiskChange> {
  switch (change.kind) {
    case 'removed':
      return {
        text: 'This talk was removed on disk',
        sheetTitle: 'This talk was removed on disk while you were working on it',
        actions: [
          { choice: 'keep', label: 'Save it again', title: 'Write your text back to the talk’s file.' },
          { choice: 'discard', label: 'Discard', title: 'Let the talk go without saving it again.' },
        ],
      }
    case 'partial':
      return {
        text: `A save failed halfway; the file on disk may be incomplete${change.tempPath ? ` (the full text is kept in ${change.tempPath})` : ''}`,
        sheetTitle: 'A save failed halfway; the file on disk may be incomplete',
        actions: [{ choice: 'keep', label: 'Save again', title: 'Write your text to the talk’s file again.' }],
      }
    case 'recovery':
      return {
        text: `Unsaved text from ${changedAtLabel(change.changedAt)} was kept when this talk could not be saved`,
        sheetTitle: 'Unsaved text was kept for this talk',
        actions: [
          { choice: 'restore', label: 'Restore my unsaved text', title: 'Put the kept text in the editor (one undo brings this version back) and save it.' },
          { choice: 'discard', label: 'Discard', title: 'Drop the kept text.' },
        ],
      }
    default:
      return {
        text: `This talk changed on disk at ${changedAtLabel(change.changedAt)}`,
        sheetTitle: 'This talk changed on disk while you were typing',
        actions: [
          { choice: 'reload', label: 'Reload', title: 'Show the version on disk. Your text stays one undo (⌘Z) away.' },
          { choice: 'keep', label: 'Keep mine', title: 'Save your text over the version on disk.' },
        ],
      }
  }
}
