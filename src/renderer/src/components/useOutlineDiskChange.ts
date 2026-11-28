// The outline external-change guard in the workspace (shared-talk ticket 01): the state the bar at the
// top of the talk shows, the person's choices on it, the sheet that holds a talk switch or a window
// close until the person has chosen, and main's close requests. The mechanics live in
// lib/outlineDiskChange.ts; this hook only connects them to the editor, the save queue and window.tw.
import { useCallback, useEffect, useRef, useState } from 'react'
import { dismissToast, notify } from '../lib/notify'
import { outlineWritesSettled, queueOutlineWrite } from '../lib/saveQueue'
import {
  changedAtLabel, guardLeave, outlineDiskChanges, resolveChoice, saveAfterDiskCleared, reloadFromDisk,
  type OutlineDiskChange, type OutlineDiskChoice,
} from '../lib/outlineDiskChange'
import { closeFrozen } from '../lib/closeFreeze'
import { dispatchCloseFreeze } from '../lib/closeFreezeEvent'
import { editorRevision } from '../lib/editorRevision'
import { updateRestartDraft } from '../lib/talkDrafts'
import { applyOutlineMerge, prepareOutlineMerge, type OutlineMergeReview, type OutlineReconcileDeps } from '../lib/outlineReconcile'
import { singleSlideDiskReview } from '../lib/slideDiskReview'
import { trackSlideMergeSave } from '../lib/slideMergeTransaction'
import { normalizeOutlineMergeText, type SlideMergeChoices } from '../../../shared/outline-merge'
import type { SlideMergeReview } from '../../../shared/outline-slide-merge'
import { mergeResultText, revealMergeArchive } from './outlineMergeCopy'

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
  cancelDebouncedSave?(outlinePath: string): void
  beforeClose?(signal: AbortSignal): boolean | Promise<boolean>
  hasMetadataDraft?(): boolean
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
  slideReview: SlideMergeReview | null
  slideReviewStale: 'disk' | 'review' | null
  slideReviewError: string | null
  slideReviewWholeTalk: boolean
  savingMerge: boolean
  refreshSlideReview(): void
  applySlideReview(generation: string, choices: SlideMergeChoices): void
  applyMerge(generation: number, choices: Record<string, string>, decision?: 'merge' | 'put-back'): void
  dismissMerge(): void
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
  const reviewRef = useRef<{ path: string; review: OutlineMergeReview } | null>(null)
  const slideReviewRef = useRef<{ path: string; review: SlideMergeReview } | null>(null)
  const [slideReview, setSlideReview] = useState<SlideMergeReview | null>(null)
  const [slideReviewStale, setSlideReviewStale] = useState<OutlineDiskChangeState['slideReviewStale']>(null)
  const [slideReviewError, setSlideReviewError] = useState<string | null>(null)
  const [slideReviewWholeTalk, setSlideReviewWholeTalk] = useState(false)
  const [savingMerge, setSavingMerge] = useState(false)
  const closeSlideReview = useCallback(() => {
    slideReviewRef.current = null
    setSlideReview(null)
    setSlideReviewStale(null)
    setSlideReviewError(null)
    setSlideReviewWholeTalk(false)
  }, [])
  const recoveryFailedRef = useRef<string | null>(null)
  const autoVersionRef = useRef<string | null>(null)
  const reconciliationRef = useRef<Promise<void> | null>(null)
  const applyingRef = useRef<Promise<void> | null>(null)
  const sheetAnswerRef = useRef<((choice: OutlineDiskChoice) => void) | null>(null)

  const resumeAutosave = useCallback((outlinePath: string): void => {
    const doc = wiringRef.current.readDoc()
    if (outlinePath !== wiringRef.current.activeOutlinePath || doc?.path !== outlinePath ||
        doc.dirty === false || outlineDiskChanges.get(outlinePath)) return
    void saveAfterDiskCleared(outlinePath, { ...depsRef.current!, busy: busyRef.current })
      .catch(error => notify(error instanceof Error ? error.message : String(error), 'warning', TOAST))
  }, [])

  // Main's push (the watcher, focus checks, a refused write) → this window's store. A difference that
  // clears on its own (the other side reverted the file) while no choice is under way leaves typing
  // made meanwhile unsaved: save the buffer so it lands.
  useEffect(() => window.tw.talk.onOutlineChangedOnDisk?.(({ outlinePath, change: next }) => {
    if (next) {
      outlineDiskChanges.report(next)
      if (slideReviewRef.current?.path === outlinePath && next.hash !== slideReviewRef.current.review.diskHash) {
        setSlideReviewStale('disk')
      }
      return
    }
    const had = outlineDiskChanges.get(outlinePath)
    if (had?.kind === 'recovery') return
    if (slideReviewRef.current?.path === outlinePath) {
      // A revert while the cards are open is also a change. Leave the displayed snapshots
      // and the buffer alone until an explicit refresh or dismissal. Apply clears its own report.
      if (!applyingRef.current) {
        wiringRef.current.cancelDebouncedSave?.(outlinePath)
        outlineDiskChanges.clear(outlinePath)
        setSlideReviewStale('disk')
      }
      return
    }
    const review = reviewRef.current?.path === outlinePath ? reviewRef.current : null
    if (review && busyRef.current) return
    if (outlinePath === wiringRef.current.activeOutlinePath) {
      autoVersionRef.current = null
      if (reviewRef.current === review) { reviewRef.current = null; setMergeReview(null) }
    }
    outlineDiskChanges.clear(outlinePath)
    // A late acknowledgement after Reload or explicit discard must not save the
    // newly adopted, clean buffer back over the disk bytes (for example CRLF).
    if (had) resumeAutosave(outlinePath)
  }), [resumeAutosave])
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

  const reconcile = useCallback((refresh = false): Promise<void> => {
    if (reconciliationRef.current) return reconciliationRef.current
    const path = wiringRef.current.activeOutlinePath
    if (!path || busyRef.current) return Promise.resolve()
    const run = (async (): Promise<void> => {
      let diskReverted = false
      busyRef.current = true; setBusy(true)
      try {
        await outlineWritesSettled(path)
        if (path !== wiringRef.current.activeOutlinePath) return
        const old = slideReviewRef.current
        const observed = outlineDiskChanges.get(path)
        if (observed?.kind !== 'changed') {
          if (old?.path === path && refresh) {
            autoVersionRef.current = null
            closeSlideReview()
            diskReverted = !observed
          }
          return
        }
        const doc = wiringRef.current.readDoc()
        if (doc?.path !== path || doc.base == null) return
        const clean = doc.dirty === false || normalizeOutlineMergeText(doc.text) === normalizeOutlineMergeText(doc.base)
        if (old?.path === path && !refresh) {
          if (old.review.diskHash !== observed.hash) setSlideReviewStale('disk')
          if (old.review.sources.mine !== doc.text) setSlideReviewStale(reason => reason ?? 'review')
          setSlideReview(old.review)
          return
        }
        if (!clean) {
          reviewRef.current = null; setMergeReview(null)
          setSlideReviewError(null)
          const planned = await window.tw.talk.planSlideMerge(path)
          if (wiringRef.current.activeOutlinePath !== path) return
          if (planned.ok) {
            const current = outlineDiskChanges.get(path)
            // The stable plan can see newer bytes than the watcher. A notification that
            // arrived during planning wins unless it names the snapshot we just received.
            if (current === observed && current.hash !== planned.diskHash) {
              outlineDiskChanges.report({ outlinePath: path, kind: 'changed', hash: planned.diskHash, changedAt: planned.diskChangedAt })
            }
            const newer = outlineDiskChanges.get(path)?.hash !== planned.diskHash
            autoVersionRef.current = outlineDiskChanges.get(path)?.hash ?? null
            recoveryFailedRef.current = null
            slideReviewRef.current = { path, review: planned }
            setSlideReviewWholeTalk(false)
            setSlideReviewStale(newer ? 'disk' : null)
            setSlideReview(planned)
          } else if (planned.reason === 'no-conflict') {
            const disk = await depsRef.current!.diskVersion(path)
            if (wiringRef.current.activeOutlinePath !== path) return
            if (disk && normalizeOutlineMergeText(disk.text) === normalizeOutlineMergeText(doc.base)) {
              wiringRef.current.cancelDebouncedSave?.(path)
              autoVersionRef.current = null
              outlineDiskChanges.clear(path, observed.hash)
              closeSlideReview()
              diskReverted = true
            } else {
              setSlideReviewError(planned.error)
              notify(planned.error, 'warning', TOAST)
            }
          } else {
            if (planned.reason === 'recovery-failed') recoveryFailedRef.current = path
            if (planned.reason === 'stale-disk' && !await depsRef.current!.diskVersion(path)) {
              if (wiringRef.current.activeOutlinePath !== path) return
              closeSlideReview(); markRemoved(path); return
            }
            const error = 'error' in planned ? planned.error : 'The talk could not be reviewed. Try again.'
            setSlideReviewError(error)
            notify(error, 'warning', TOAST)
          }
          return
        }
        if (old?.path === path) closeSlideReview()
        for (let attempt = 0; attempt < 3; attempt++) {
          const prepared = await prepareOutlineMerge(path, depsRef.current!)
          if (wiringRef.current.activeOutlinePath !== path) return
          if (prepared.kind === 'retry') continue
          if (prepared.kind === 'removed') { markRemoved(path); return }
          if (prepared.kind === 'ready' || prepared.kind === 'conflict') {
            if (prepared.review.mine !== prepared.review.base) {
              // Typing began while the clean snapshot was being read. Use the slide plan
              // on the next turn, before offering any write.
              autoVersionRef.current = null
              return
            }
            reviewRef.current = { path, review: prepared.review }
            setMergeReview(prepared.review)
            autoVersionRef.current = prepared.review.hash
          } else if (prepared.kind === 'error') {
            if (prepared.recoveryFailed) recoveryFailedRef.current = path
            notify(prepared.error, 'warning', TOAST)
          }
          return
        }
        notify('The talk is still changing. Choose Review merge to try again.', 'info', TOAST)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setSlideReviewError(message)
        notify(message, 'warning', TOAST)
      } finally {
        busyRef.current = false; setBusy(false)
        if (diskReverted) resumeAutosave(path)
      }
    })()
    reconciliationRef.current = run
    void run.then(() => { if (reconciliationRef.current === run) reconciliationRef.current = null })
    return run
  }, [closeSlideReview, markRemoved, resumeAutosave])

  useEffect(() => {
    if (busy) return
    const opening = slideReviewRef.current
    if (opening && opening.path === activeOutlinePath) {
      if (change?.hash !== opening.review.diskHash) setSlideReviewStale('disk')
      return
    }
    if (!change || change.kind !== 'changed' || autoVersionRef.current === change.hash) return
    autoVersionRef.current = change.hash
    void reconcile()
  }, [activeOutlinePath, change, busy, reconcile])
  useEffect(() => {
    if (slideReviewRef.current?.path !== activeOutlinePath) closeSlideReview()
    if (reviewRef.current?.path !== activeOutlinePath) { reviewRef.current = null; setMergeReview(null) }
    autoVersionRef.current = null
  }, [activeOutlinePath, closeSlideReview])
  useEffect(() => {
    if (change?.kind !== 'changed') setMergeReview(null)
  }, [change?.kind])

  const refreshSlideReview = useCallback(() => { void reconcile(true) }, [reconcile])

  const applySlideReview = useCallback((generation: string, choices: SlideMergeChoices) => {
    const current = slideReviewRef.current
    if (!current || current.review.generation !== generation || current.path !== wiringRef.current.activeOutlinePath ||
        busyRef.current || slideReviewStale) return
    const observed = outlineDiskChanges.get(current.path)
    if (observed?.hash !== current.review.diskHash) { setSlideReviewStale('disk'); return }
    busyRef.current = true; setBusy(true); setSavingMerge(true); setSlideReviewError(null)
    applyingRef.current = (async () => {
      try {
        const result = await trackSlideMergeSave(generation, window.tw.talk.applySlideMerge(current.path, generation, choices))
        if (wiringRef.current.activeOutlinePath !== current.path || slideReviewRef.current !== current) return
        if (result.ok) {
          outlineDiskChanges.clear(current.path, current.review.diskHash)
          autoVersionRef.current = null
          closeSlideReview()
          notify(`Applied and saved at ${changedAtLabel(result.savedAt)}. ${mergeResultText(result.summary)}`, 'success', TOAST,
            { label: 'Show recovery copy', onAction: () => { void revealMergeArchive(current.review.recovery.path) } })
        } else if (result.reason === 'unsafe-structure' || result.reason === 'duplicate-ids') {
          setSlideReviewWholeTalk(true)
        } else {
          if (result.reason === 'stale-disk') setSlideReviewStale('disk')
          else setSlideReviewStale(reason => reason ?? 'review')
          setSlideReviewError('error' in result ? result.error : 'The merge choices could not be saved. Review the versions again.')
        }
      } catch (error) {
        setSlideReviewStale(reason => reason ?? 'review')
        setSlideReviewError(error instanceof Error ? error.message : String(error))
      } finally {
        applyingRef.current = null; busyRef.current = false; setBusy(false); setSavingMerge(false)
      }
    })()
  }, [closeSlideReview, slideReviewStale])

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
          // The same external bytes may arrive again after Put it back.
          autoVersionRef.current = null
          recoveryFailedRef.current = null; reviewRef.current = null; setMergeReview(null)
          notify(decision === 'put-back' ? 'Put back the slide. The disk edit is in recovery.' : 'Kept the changes to the talk.', 'info', TOAST)
        } else if (result.kind === 'error') { if (result.recoveryFailed) recoveryFailedRef.current = current.path; notify(result.error, 'warning', TOAST) }
      })
      .finally(() => { applyingRef.current = null; busyRef.current = false; setBusy(false) })
    applyingRef.current = applying
  }, [reconcile, markRemoved])
  const dismissMerge = useCallback((): void => {
    if (busyRef.current) return
    const current = slideReviewRef.current
    if (current) {
      autoVersionRef.current = outlineDiskChanges.get(current.path)?.hash ?? null
      closeSlideReview()
    }
    setMergeReview(null)
  }, [closeSlideReview])

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
      if (slideReviewRef.current?.path === outlinePath) { void reconcile(); return }
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
        closeSlideReview()
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
  }, [reconcile, closeSlideReview])

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
  const metadataCloseRef = useRef<AbortController | null>(null)
  // The update's restart was called off: every frozen close of this window is released at once, with nothing lost.
  useEffect(() => window.tw.talk.onCloseCancelled?.(() => {
    metadataCloseRef.current?.abort()
    for (const release of [...unfreezeAllRef.current]) release()
  }), [])
  useEffect(() => window.tw.talk.onCloseRequested?.(({ quit, update }) => {
    // Freezing blurs an object editor (which can commit it): ask before doing either.
    const restartDraft = () => wiringRef.current.hasMetadataDraft?.()
      ? 'Save or discard your changes in Talk design to restart.'
      : updateRestartDraft(document)
    const draft = update === true ? restartDraft() : null
    if (draft) {
      notify(draft, 'warning')
      void window.tw.talk.confirmClose({ quit, revision: editorRevision.current(), hasDraft: true })
      return
    }
    const freezing = freezeFor(update === true)
    unfreezeAllRef.current.add(freezing.unfreeze)
    const from = wiringRef.current.activeOutlinePath
    const confirm = (revision: number) => {
      const draft = update === true ? restartDraft() : null
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
        // Metadata must be committed or discarded before CodeMirror is frozen for close.
        const beforeClose = wiringRef.current.beforeClose
        if (beforeClose) {
          if (metadataCloseRef.current) {
            // A second click on Close still refers to the pending choice.
            if (update !== true) void window.tw.talk.ackCloseRequest?.()
            return
          }
          const choice = new AbortController()
          metadataCloseRef.current = choice
          try {
            const allowed = await beforeClose(choice.signal)
            if (choice.signal.aborted) return
            if (!allowed) { await kept(); return }
          } finally {
            metadataCloseRef.current = null
          }
        }
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
        if (applyingRef.current && update !== true) await window.tw.talk.ackCloseRequest?.()
        if (applyingRef.current) await applyingRef.current
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

  return { change, busy, choose, sheet, answerSheet, guardLeave: leave, mergeReview, applyMerge, dismissMerge,
    slideReview: slideReviewRef.current?.path === activeOutlinePath ? slideReview : null, slideReviewStale, slideReviewError,
    slideReviewWholeTalk, savingMerge, refreshSlideReview, applySlideReview }
}
