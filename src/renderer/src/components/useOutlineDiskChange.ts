// The outline external-change guard in the workspace (shared-talk ticket 01): the state the bar at the
// top of the talk shows, the person's choices on it, the sheet that holds a talk switch or a window
// close until the person has chosen, and main's close requests. The mechanics live in
// lib/outlineDiskChange.ts; this hook only connects them to the editor, the save queue and window.tw.
import { useCallback, useEffect, useRef, useState } from 'react'
import { dismissToast, notify } from '../lib/notify'
import { outlineWritesSettled, queueOutlineWrite } from '../lib/saveQueue'
import {
  guardLeave, outlineDiskChanges, resolveChoice, saveAfterDiskCleared,
  type OutlineDiskChange, type OutlineDiskChoice, type OutlineDiskResolverDeps,
} from '../lib/outlineDiskChange'

export interface OutlineDiskChangeWiring {
  /** The talk open in this workspace, or null. */
  activeOutlinePath: string | null
  /** The editor's live text for the talk (Editor registerReadDoc), or null. */
  readDoc(): { path: string; text: string } | null
  /** Puts text into the editor as one undoable change (Editor registerReplaceDoc, no save). */
  replaceDoc(text: string): string | null
  /** Saves the editor's buffer as it stands through the file's queue (the D1 seam). */
  saveBuffer(outlinePath: string): Promise<boolean>
  /** Flushes the editor's pending typing (Editor flushSave). */
  flush(): Promise<void>
  /** The talk was discarded (removed on disk): let it go from this window. */
  onDiscardTalk(): void
}

export interface OutlineDiskChangeState {
  /** The active talk's unresolved difference (the bar), or null. */
  change: OutlineDiskChange | null
  busy: boolean
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
  const sheetAnswerRef = useRef<((choice: OutlineDiskChoice) => void) | null>(null)

  // Main's push (the watcher, focus checks, a refused write) → this window's store. A difference that
  // clears on its own (the other side reverted the file) while no choice is under way leaves typing
  // made meanwhile unsaved: save the buffer so it lands.
  useEffect(() => window.tw.talk.onOutlineChangedOnDisk?.(({ outlinePath, change: next }) => {
    if (next) { outlineDiskChanges.report(next); return }
    const had = outlineDiskChanges.get(outlinePath)
    if (had?.kind === 'recovery') return
    outlineDiskChanges.clear(outlinePath)
    if (had && outlinePath === wiringRef.current.activeOutlinePath) {
      void saveAfterDiskCleared(outlinePath, { ...depsRef.current!, busy: busyRef.current })
    }
  }), [])
  useEffect(() => {
    const sync = (): void => setChange(activeOutlinePath ? outlineDiskChanges.get(activeOutlinePath) : null)
    sync()
    return outlineDiskChanges.subscribe(sync)
  }, [activeOutlinePath])

  const depsRef = useRef<OutlineDiskResolverDeps | null>(null)
  if (!depsRef.current) {
    depsRef.current = {
      store: outlineDiskChanges,
      settled: (outlinePath) => outlineWritesSettled(outlinePath),
      queue: (outlinePath, work) => queueOutlineWrite(outlinePath, work),
      diskVersion: (outlinePath) => window.tw.talk.outlineDiskVersion(outlinePath),
      accept: (outlinePath, hash) => window.tw.talk.acceptOutlineDiskVersion(outlinePath, hash),
      readBuffer: (outlinePath) => {
        const doc = wiringRef.current.readDoc()
        return doc && doc.path === outlinePath ? doc.text : null
      },
      replaceBuffer: (outlinePath, text) => {
        const doc = wiringRef.current.readDoc()
        return !!doc && doc.path === outlinePath && wiringRef.current.replaceDoc(text) != null
      },
      saveBuffer: (outlinePath) => wiringRef.current.saveBuffer(outlinePath),
      recovery: (outlinePath) => window.tw.talk.outlineRecovery(outlinePath),
      discardRecovery: (outlinePath) => window.tw.talk.discardOutlineRecovery(outlinePath),
      discardRemoved: (outlinePath) => window.tw.talk.discardRemovedOutline(outlinePath),
    }
  }

  const after = (current: OutlineDiskChange, choice: Exclude<OutlineDiskChoice, 'stay'>, result: Awaited<ReturnType<typeof resolveChoice>>): void => {
    if (!result.ok) { notify(result.error, 'warning', TOAST); return }
    if (current.kind === 'changed' && choice === 'reload' && result.replacedEdits) notify('Reloaded the talk from disk. Your previous text is one undo away (⌘Z).', 'info', TOAST)
    else if (current.kind === 'recovery' && choice === 'restore') notify('Restored your unsaved text. The version it replaced is one undo away (⌘Z).', 'info', TOAST)
    else dismissToast(TOAST)
  }

  const choose = useCallback((choice: Exclude<OutlineDiskChoice, 'stay'>): void => {
    const outlinePath = wiringRef.current.activeOutlinePath
    const current = outlinePath ? outlineDiskChanges.get(outlinePath) : null
    if (!outlinePath || !current || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    void resolveChoice(outlinePath, current, choice, depsRef.current!)
      .then((result) => {
        after(current, choice, result)
        if (result.ok && current.kind === 'removed' && choice === 'discard') wiringRef.current.onDiscardTalk()
      })
      .finally(() => { busyRef.current = false; setBusy(false) })
  }, [])

  const leave = useCallback(async (): Promise<boolean> => {
    const outlinePath = wiringRef.current.activeOutlinePath
    if (!outlinePath) return true
    try {
      return await guardLeave(outlinePath, {
        ...depsRef.current!,
        flush: () => wiringRef.current.flush(),
        ask: (pending) => new Promise<OutlineDiskChoice>((resolve) => {
          // A second leave while the sheet is open (another click, a close): the first one stays.
          sheetAnswerRef.current?.('stay')
          busyRef.current = false
          sheetAnswerRef.current = (choice) => {
            sheetAnswerRef.current = null
            setSheet(null)
            if (choice !== 'stay') busyRef.current = true // its own save clears the difference
            resolve(choice)
          }
          setSheet(pending)
        }),
        report: (error) => notify(error, 'warning', TOAST),
      })
    } finally {
      busyRef.current = false
    }
  }, [])

  const answerSheet = useCallback((choice: OutlineDiskChoice): void => { sheetAnswerRef.current?.(choice) }, [])

  // Main holds a close (or ⌘Q) while this window's talk differs from the disk: the same sheet, then
  // the close goes ahead once the choice has completed.
  useEffect(() => window.tw.talk.onCloseRequested?.(({ quit }) => {
    void window.tw.talk.ackCloseRequest?.()
    void leave().then((ok) => { if (ok) void window.tw.talk.confirmClose({ quit }) })
  }), [leave])

  return { change, busy, choose, sheet, answerSheet, guardLeave: leave }
}
