// The outline external-change guard in the workspace (shared-talk ticket 01): the state the bar at the
// top of the talk shows, the person's choices on it, the sheet that holds a talk switch or a window
// close until the person has chosen, and main's close requests. The mechanics live in
// lib/outlineDiskChange.ts; this hook only connects them to the editor, the save queue and window.tw.
import { useCallback, useEffect, useRef, useState } from 'react'
import { dismissToast, notify } from '../lib/notify'
import { outlineWritesSettled, queueOutlineWrite } from '../lib/saveQueue'
import {
  guardLeave, outlineDiskChanges, resolveChoice, saveAfterDiskCleared, reloadFromDisk,
  type OutlineDiskChange, type OutlineDiskChoice,
} from '../lib/outlineDiskChange'
import { closeFrozen } from '../lib/closeFreeze'
import { dispatchCloseFreeze } from '../lib/closeFreezeEvent'
import { editorRevision } from '../lib/editorRevision'
import { updateRestartDraft } from '../lib/talkDrafts'
import { applyOutlineMerge, prepareOutlineMerge, type OutlineMergeReview, type OutlineReconcileDeps } from '../lib/outlineReconcile'
import { singleSlideDiskReview } from '../lib/slideDiskReview'
import { resolveOutlineMerge } from '../../../shared/outline-merge'

export interface OutlineDiskChangeWiring {
  /** The talk open in this workspace, or null. */
  activeOutlinePath: string | null
  /** The editor's live text for the talk (Editor registerReadDoc), or null. */
  readDoc(): { path: string; text: string; base: string | null; dirty?: boolean } | null
  /** Puts text into the editor as one undoable change (Editor registerReplaceDoc, no save). */
  replaceDoc(text: string, opts?: { fromDisk?: boolean; diskBase?: string; diskHash?: string }): string | null
  /** Saves the editor's buffer as it stands through the file's queue (the D1 seam). */
  saveBuffer(outlinePath: string): Promise<boolean>
  /** Flushes the editor's pending typing (Editor flushSave). */
  flush(): Promise<void>
  /** Saves until the editor holds nothing unsaved (Editor settleSave); throws when a save fails. */
  settle(signal?: AbortSignal): Promise<void>
  /** Writes the editor's current text even when it looks saved (Editor forceSave). */
  forceSave(signal?: AbortSignal): Promise<boolean>
  hasPendingSketch?(): boolean
  saveSketch?(): Promise<boolean>
  /** The talk was discarded (removed on disk): let it go from this window. */
  onDiscardTalk(): void
}

export interface OutlineDiskChangeState {
  /** The active talk's unresolved difference (the bar), or null. */
  change: OutlineDiskChange | null
  busy: boolean
  mergeReview: OutlineMergeReview | null
  mergeChoices: Record<string, string>
  applyMerge(generation: number, choices: Record<string, string>, decision?: 'merge' | 'put-back'): void
  dismissMerge(): void
  keepMergeDraft(generation: number, choices: Record<string, string>): void
  /** A choice on the bar. */
  choose(choice: Exclude<OutlineDiskChoice, 'stay'>): void
  /** The open sheet (a switch or a close waiting for the person), or null. */
  sheet: OutlineDiskChange | null
  answerSheet(choice: OutlineDiskChoice): void
  /** Before the talk is left (switch, close): true when it may go ahead. */
  guardLeave(): Promise<boolean>
}

const TOAST = 'changed-on-disk'

export function useOutlineDiskChange(wiring: OutlineDiskChangeWiring): OutlineDiskChangeState {
  const wiringRef = useRef(wiring)
  wiringRef.current = wiring
  const { activeOutlinePath } = wiring
  const [change, setChange] = useState<OutlineDiskChange | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [sheet, setSheet] = useState<OutlineDiskChange | null>(null)
  const [mergeReview, setMergeReview] = useState<OutlineMergeReview | null>(null)
  const reviewRef = useRef<{ path: string; review: OutlineMergeReview; draft?: string; choices?: Record<string, string> } | null>(null)
  const recoveryFailedRef = useRef<string | null>(null)
  const autoVersionRef = useRef<string | null>(null)
  const reconciliationRef = useRef<Promise<void> | null>(null)
  const applyingRef = useRef<Promise<void> | null>(null)
  const sheetAnswerRef = useRef<((choice: OutlineDiskChoice) => void) | null>(null)

  // Main's push (the watcher, focus checks, a refused write) → this window's store. A difference that
  // clears on its own (the other side reverted the file) while no choice is under way leaves typing
  // made meanwhile unsaved: save the buffer so it lands.
  useEffect(() => window.tw.talk.onOutlineChangedOnDisk?.(({ outlinePath, change: next }) => {
    if (next) { outlineDiskChanges.report(next); return }
    const had = outlineDiskChanges.get(outlinePath)
    if (had?.kind === 'recovery') return
    const review = reviewRef.current?.path === outlinePath ? reviewRef.current : null
    // Apply/reconcile preserves this review and clears the report itself on success.
    if (review && busyRef.current) return
    void (async () => {
      if (review?.draft !== undefined) {
        const draft = review.draft
        const kept = await depsRef.current!.preserve(outlinePath, { ...review.review, draft }).catch(() => null)
        // A result edited during preservation needs its own archive before it can close.
        if (reviewRef.current !== review || review.draft !== draft || busyRef.current || outlineDiskChanges.get(outlinePath) !== had) return
        if (!kept) { recoveryFailedRef.current = outlinePath; notify('Could not keep your merge draft. It is still open; retry before leaving.', 'warning', TOAST); return }
      }
      if (outlineDiskChanges.get(outlinePath) !== had) return // a newer event won
      if (outlinePath === wiringRef.current.activeOutlinePath) {
        autoVersionRef.current = null
        if (reviewRef.current === review) { reviewRef.current = null; setMergeReview(null) }
      }
      outlineDiskChanges.clear(outlinePath)
      if (had && outlinePath === wiringRef.current.activeOutlinePath) {
        await saveAfterDiskCleared(outlinePath, { ...depsRef.current!, busy: busyRef.current })
      }
    })().catch(error => notify(error instanceof Error ? error.message : String(error), 'warning', TOAST))
  }), [])
  useEffect(() => {
    const sync = (): void => setChange(activeOutlinePath ? outlineDiskChanges.get(activeOutlinePath) : null)
    sync()
    return outlineDiskChanges.subscribe(sync)
  }, [activeOutlinePath])

  const depsRef = useRef<OutlineReconcileDeps | null>(null)
  if (!depsRef.current) {
    depsRef.current = {
      store: outlineDiskChanges,
      revision: () => editorRevision.current(),
      settled: (outlinePath) => outlineWritesSettled(outlinePath),
      queue: (outlinePath, work) => queueOutlineWrite(outlinePath, work),
      diskVersion: (outlinePath) => window.tw.talk.outlineDiskVersion(outlinePath),
      accept: (outlinePath, hash, opts) => window.tw.talk.acceptOutlineDiskVersion(outlinePath, hash, opts),
      readBase: (outlinePath) => {
        const doc = wiringRef.current.readDoc()
        return doc?.path === outlinePath ? (doc.dirty === false ? doc.text : doc.base) : null
      },
      preserve: (path, snapshot) => window.tw.talk.preserveOutlineMerge(path, snapshot),
      readBuffer: (outlinePath) => {
        const doc = wiringRef.current.readDoc()
        return doc && doc.path === outlinePath ? doc.text : null
      },
      replaceBuffer: (outlinePath, text, opts) => {
        const doc = wiringRef.current.readDoc()
        return !!doc && doc.path === outlinePath && wiringRef.current.replaceDoc(text, opts) != null
      },
      saveBuffer: (outlinePath) => wiringRef.current.saveBuffer(outlinePath),
      recovery: (outlinePath) => window.tw.talk.outlineRecovery(outlinePath),
      discardRecovery: (outlinePath) => window.tw.talk.discardOutlineRecovery(outlinePath),
      discardRemoved: (outlinePath) => window.tw.talk.discardRemovedOutline(outlinePath),
    }
  }

  const markRemoved = useCallback((path: string): void => {
    reviewRef.current = null; setMergeReview(null)
    recoveryFailedRef.current = null; autoVersionRef.current = null
    // A version read can discover removal before main's watcher does. Route it through
    // the same explicit Save it again / Discard journey; never leave a stale merge open.
    if (outlineDiskChanges.get(path)?.kind !== 'removed') {
      outlineDiskChanges.report({ outlinePath: path, kind: 'removed', hash: 'removed', changedAt: Date.now() })
    }
  }, [])

  const reconcile = useCallback((): Promise<void> => {
    if (reconciliationRef.current) return reconciliationRef.current
    const path = wiringRef.current.activeOutlinePath
    if (!path || busyRef.current) return Promise.resolve()
    const run = (async (): Promise<void> => {
      busyRef.current = true; setBusy(true)
      try {
        const previous = reviewRef.current
        if (previous?.path === path && previous.draft !== undefined) {
          if (!await depsRef.current!.preserve(path, { ...previous.review, draft: previous.draft }).catch(() => null)) { recoveryFailedRef.current = path; throw Error('Could not keep your merge draft. Retry, or leave using the disk version after discarding these edits.') }
        }
        // A review still current (same buffer, base and disk version) stays open as it is, with the
        // person's choices and edited Result: a denied close or quit must not reset the merge.
        if (previous?.path === path && reviewRef.current === previous) {
          const doc = wiringRef.current.readDoc()
          const pending = outlineDiskChanges.get(path)
          if (doc?.path === path && doc.text === previous.review.mine && depsRef.current!.readBase(path) === previous.review.base &&
            pending?.kind === 'changed' && pending.hash === previous.review.hash) {
            // Keep the same guarantee a rebuild gives: a recovery copy exists before anyone may leave.
            if (previous.draft === undefined && !await depsRef.current!.preserve(path, previous.review).catch(() => null)) {
              recoveryFailedRef.current = path
              throw Error('Could not keep your merge draft. Retry, or leave using the disk version after discarding these edits.')
            }
            recoveryFailedRef.current = null
            setMergeReview(previous.review)
            return
          }
        }
        for (let attempt = 0; attempt < 3; attempt++) {
          const prepared = await prepareOutlineMerge(path, depsRef.current!)
          if (wiringRef.current.activeOutlinePath !== path) return
          if (prepared.kind === 'retry') continue
          if (prepared.kind === 'removed') { markRemoved(path); return }
          if (prepared.kind === 'conflict' || prepared.kind === 'ready') {
            recoveryFailedRef.current = null
            reviewRef.current = { path, review: prepared.review }
            setMergeReview(prepared.review)
            autoVersionRef.current = prepared.review.hash
          } else if (prepared.kind === 'error') {
            if (prepared.recoveryFailed) recoveryFailedRef.current = path
            notify(prepared.error, 'warning', TOAST)
          }
          return
        }
        notify('The talk is still changing. Choose Review merge to try again; both versions are kept.', 'info', TOAST)
      } catch (error) { notify(error instanceof Error ? error.message : String(error), 'warning', TOAST) }
      finally { busyRef.current = false; setBusy(false) }
    })()
    reconciliationRef.current = run
    void run.then(() => { if (reconciliationRef.current === run) reconciliationRef.current = null })
    return run
  }, [markRemoved])

  useEffect(() => {
    if (!change || change.kind !== 'changed' || autoVersionRef.current === change.hash || busy) return
    autoVersionRef.current = change.hash
    void reconcile()
  }, [change, busy, reconcile])
  useEffect(() => {
    if (reviewRef.current?.path !== activeOutlinePath) { reviewRef.current = null; setMergeReview(null); autoVersionRef.current = null }
    if (!change || change.kind !== 'changed') { setMergeReview(null); autoVersionRef.current = null }
    if (recoveryFailedRef.current !== activeOutlinePath) recoveryFailedRef.current = null
  }, [activeOutlinePath, change?.kind])

  const applyMerge = useCallback((generation: number, choices: Record<string, string>, decision: 'merge' | 'put-back' = 'merge'): void => {
    const current = reviewRef.current
    if (!current || generation !== current.review.generation || current.path !== wiringRef.current.activeOutlinePath || busyRef.current) return
    if (decision === 'put-back' && !singleSlideDiskReview(current.review)) return
    const doc = wiringRef.current.readDoc()
    if (doc?.text !== current.review.mine || depsRef.current!.readBase(current.path) !== current.review.base) { void reconcile(); return }
    const pending = outlineDiskChanges.get(current.path)
    if (pending?.kind !== 'changed' || pending.hash !== current.review.hash) { void reconcile(); return }
    busyRef.current = true; setBusy(true)
    // The decision is made. Return focus so typing can continue while disk acknowledgement runs.
    // Conflict choices remain visible until saved so a failed save keeps the edited result in view.
    if (!current.review.merge.conflicts.length) setMergeReview(null)
    const applying = applyOutlineMerge(current.path, current.review, choices, depsRef.current!, decision)
      .then(async result => {
        if (wiringRef.current.activeOutlinePath !== current.path) return
        if (result.kind === 'retry') {
          busyRef.current = false; await reconcile(); return
        }
        if (result.kind === 'removed') { markRemoved(current.path); return }
        if (result.kind === 'saved' || result.kind === 'reloaded') {
          recoveryFailedRef.current = null; reviewRef.current = null; setMergeReview(null)
          notify(decision === 'put-back' ? 'Put back the slide. The disk edit is in recovery.' : 'Kept the changes to the talk.', 'info', TOAST)
        } else if (result.kind === 'error') { if (result.recoveryFailed) recoveryFailedRef.current = current.path; notify(result.error, 'warning', TOAST) }
      })
      .finally(() => { applyingRef.current = null; busyRef.current = false; setBusy(false) })
    applyingRef.current = applying
  }, [reconcile, markRemoved])
  const keepMergeDraft = useCallback((generation: number, choices: Record<string, string>): void => {
    const current = reviewRef.current
    if (!current || current.review.generation !== generation) return
    const defaults = Object.fromEntries(current.review.merge.conflicts.map(item => [item.id, item.mine]))
    current.choices = choices
    current.draft = resolveOutlineMerge(current.review.merge, { ...defaults, ...choices }) ?? undefined
  }, [])
  const dismissMerge = useCallback((): void => {
    const current = reviewRef.current
    if (!current || busyRef.current) return
    void depsRef.current!.preserve(current.path, { ...current.review, draft: current.draft }).catch(() => null)
      .then(kept => {
        if (reviewRef.current !== current || busyRef.current) return
        setMergeReview(null)
        if (!kept) {
          recoveryFailedRef.current = current.path
          notify('The merge draft could not be kept. You can retry or explicitly discard your unsaved edits when leaving.', 'warning', TOAST)
        }
      })
  }, [])

  const after = (current: OutlineDiskChange, choice: Exclude<OutlineDiskChoice, 'stay'>, result: Awaited<ReturnType<typeof resolveChoice>>): void => {
    if (!result.ok) { notify(result.error, 'warning', TOAST); return }
    if (current.kind === 'recovery' && choice === 'restore') notify('Restored your unsaved text. The version it replaced is one undo away (⌘Z).', 'info', TOAST)
    else dismissToast(TOAST)
  }

  const choose = useCallback((choice: Exclude<OutlineDiskChoice, 'stay'>): void => {
    const outlinePath = wiringRef.current.activeOutlinePath
    const current = outlinePath ? outlineDiskChanges.get(outlinePath) : null
    if (!outlinePath || !current || busyRef.current) return
    if (current.kind === 'changed') {
      const previous = reviewRef.current
      const doc = wiringRef.current.readDoc()
      if (previous?.path === outlinePath && previous.review.hash === current.hash && doc?.text === previous.review.mine && (doc.dirty === false ? doc.text : doc.base) === previous.review.base) setMergeReview(previous.review)
      else void reconcile()
      return
    }
    busyRef.current = true
    setBusy(true)
    void resolveChoice(outlinePath, current, choice, depsRef.current!)
      .then((result) => {
        after(current, choice, result)
        if (result.ok && current.kind === 'removed' && choice === 'discard') wiringRef.current.onDiscardTalk()
      })
      .finally(() => { busyRef.current = false; setBusy(false) })
  }, [reconcile])

  const leave = useCallback(async (): Promise<boolean> => {
    const outlinePath = wiringRef.current.activeOutlinePath
    if (wiringRef.current.saveSketch && !await wiringRef.current.saveSketch()) return false
    if (!outlinePath) return true
    if (applyingRef.current) await applyingRef.current
    if (reconciliationRef.current) await reconciliationRef.current
    if (wiringRef.current.activeOutlinePath !== outlinePath || busyRef.current) return false
    let ownsBusy = false
    try {
      const allowed = await guardLeave(outlinePath, {
        ...depsRef.current!,
        flush: () => wiringRef.current.flush(),
        reconcile: () => reconcile(),
        ask: (pending) => new Promise<OutlineDiskChoice>((resolve) => {
          if (busyRef.current) { resolve('stay'); return }
          // A visible choice may wait indefinitely; an ordinary stalled flush must retain main's timeout.
          void window.tw.talk.ackCloseRequest?.()
          // A second leave while the sheet is open (another click, a close): the first one stays.
          sheetAnswerRef.current?.('stay')
          busyRef.current = false
          sheetAnswerRef.current = (choice) => {
            sheetAnswerRef.current = null
            setSheet(null)
            if (choice !== 'stay') { busyRef.current = true; ownsBusy = true } // its own save clears the difference
            resolve(choice)
          }
          setSheet(pending)
        }),
        report: (error) => notify(error, 'warning', TOAST),
      })
      const pending = outlineDiskChanges.get(outlinePath)
      if (!allowed && pending?.kind === 'changed' && recoveryFailedRef.current === outlinePath) {
        setMergeReview(null)
        void window.tw.talk.ackCloseRequest?.()
        const choice = await new Promise<OutlineDiskChoice>(resolve => {
          sheetAnswerRef.current = answer => { sheetAnswerRef.current = null; setSheet(null); resolve(answer) }
          setSheet({ ...pending, recoveryFailed: true })
        })
        if (choice === 'reload') {
          busyRef.current = true; ownsBusy = true
          const result = await reloadFromDisk(outlinePath, depsRef.current!)
          if (result.ok) { recoveryFailedRef.current = null; return true }
          notify(result.error, 'warning', TOAST)
        }
      }
      return allowed
    } finally {
      if (ownsBusy) busyRef.current = false
    }
  }, [reconcile])

  const answerSheet = useCallback((choice: OutlineDiskChoice): void => { sheetAnswerRef.current?.(choice) }, [])

  // Every close of this window (its own, ⌘Q, an update's restart) comes here when a talk is open: the editor freezes,
  // the leave guard runs (the sheet when the talk differs from the disk), the editor saves until nothing is left
  // unsaved and confirms the revision it holds; anything but closing unfreezes it (lib/closeFreeze.ts, ADR-0044 §6).
  const freezesRef = useRef(0)
  const freezeFor = (update: boolean) => {
    let frozen = false
    return {
      freeze: () => { if (frozen) return; frozen = true; freezesRef.current += 1; dispatchCloseFreeze({ frozen: true, update }) },
      unfreeze: () => {
        if (!frozen) return
        frozen = false
        freezesRef.current = Math.max(0, freezesRef.current - 1)
        if (freezesRef.current === 0) dispatchCloseFreeze({ frozen: false, update })
      },
    }
  }
  const unfreezeAllRef = useRef<Set<() => void>>(new Set())
  // The update's restart was called off: every frozen close of this window is released at once, with nothing lost.
  useEffect(() => window.tw.talk.onCloseCancelled?.(() => { for (const release of [...unfreezeAllRef.current]) release() }), [])
  useEffect(() => window.tw.talk.onCloseRequested?.(({ quit, update }) => {
    // Freezing blurs an object editor (which can commit it): ask before doing either.
    const draft = update === true ? updateRestartDraft(document) : null
    if (draft) {
      notify(draft, 'warning')
      void window.tw.talk.confirmClose({ quit, revision: editorRevision.current(), hasDraft: true })
      return
    }
    const freezing = freezeFor(update === true)
    unfreezeAllRef.current.add(freezing.unfreeze)
    const from = wiringRef.current.activeOutlinePath
    const confirm = (revision: number) => {
      const draft = update === true ? updateRestartDraft(document) : null
      if (draft) notify(draft, 'warning')
      return window.tw.talk.confirmClose({ quit, revision, hasDraft: draft !== null })
    }
    const kept = () => window.tw.talk.closeKept?.() ?? Promise.resolve(true)
    const editorDeps = {
      freeze: freezing.freeze,
      unfreeze: freezing.unfreeze,
      settle: (signal?: AbortSignal) => wiringRef.current.settle(signal),
      forceSave: async (signal?: AbortSignal) => { await wiringRef.current.forceSave(signal) },
      failed: () => notify('The talk could not finish saving, so this window stayed open. Your edits are still here. Try saving again before closing.', 'error', 'save-failed'),
      revision: () => editorRevision.current(),
      confirm,
      kept,
    }
    void (async () => {
      try {
        if (from) {
          const receipt = await window.tw.windows.recoverMovedTalk(from)
          if (wiringRef.current.activeOutlinePath !== from) { await kept(); return }
          if (receipt.kind !== 'no-receipt') {
            await window.tw.talk.ackCloseRequest?.()
            await closeFrozen({
              ...editorDeps,
              leave: async () => {
                if (wiringRef.current.saveSketch && !await wiringRef.current.saveSketch()) return false
                const keep = await new Promise<boolean>(done => window.dispatchEvent(new CustomEvent('tw-retire-moved-editor', {detail:{from,retire:true,done}})))
                return keep && (!wiringRef.current.activeOutlinePath || wiringRef.current.activeOutlinePath === from)
              },
            })
            return
          }
        }
        // The ordinary close keeps its timing: main's five-second fallback covers the flush in the leave guard, then is
        // switched off, as before. An update's restart keeps the fallback on through the confirmation: a frozen editor
        // that does not confirm in time calls the restart off.
        await closeFrozen({ ...editorDeps, leave: async () => {
          if (update !== true && wiringRef.current.hasPendingSketch?.()) await window.tw.talk.ackCloseRequest?.()
          const mayLeave = await leave()
          if (update !== true) await window.tw.talk.ackCloseRequest?.()
          return mayLeave
        } })
      } finally {
        unfreezeAllRef.current.delete(freezing.unfreeze)
      }
    })()
  }), [leave])

  return { change, busy, choose, sheet, answerSheet, guardLeave: leave, mergeReview, mergeChoices: reviewRef.current?.choices ?? {}, applyMerge, dismissMerge, keepMergeDraft }
}
