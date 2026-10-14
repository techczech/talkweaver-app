// A scan of the outline that waits for a pause in the typing (Layout Doctor, plain view ticket 15).
//
// Some readings of the whole outline cost tens of milliseconds on a long talk (the stranded-title-icon
// scan reads it with the compiler's facts). A surface that stays open while the person types must not
// run one for every text it is handed: the scan runs once the text has been the same for `pauseMs`,
// from a timer, never during a render.
//
//   createPausedScan  the schedule itself, with the timers passed in (scripts/test-paused-scan.mjs)
//   usePausedScan     the same for a React component: the last reading, the text it was read from,
//                     and whether a newer text is still waiting for its reading
import { useEffect, useRef, useState } from 'react'

/** The workspace's pause before it compiles an edited outline (WorkspaceLayout's debounced compile). */
export const OUTLINE_PAUSE_MS = 900

export interface PauseTimers {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: PauseTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export interface PausedScan {
  /** The text as it now stands. A text that differs from the one waiting starts the pause again. */
  update(text: string): void
  /** Drops the waiting text and forgets the last reading (the surface closed, or shows another talk). */
  cancel(): void
  /** True while a text is waiting for its reading. */
  pending(): boolean
}

export interface PausedScanOptions<T> {
  scan(text: string): T
  /** Called from the timer with the text that was read and its reading. */
  onResult(text: string, result: T): void
  pauseMs: number
  timers?: PauseTimers
}

export function createPausedScan<T>({ scan, onResult, pauseMs, timers = realTimers }: PausedScanOptions<T>): PausedScan {
  let scanned: string | null = null
  let waiting: string | null = null
  let handle: unknown = null
  const stop = (): void => {
    if (handle !== null) timers.clear(handle)
    handle = null
    waiting = null
  }
  return {
    update(text) {
      // The same text handed over again is not a change: its pause keeps running.
      if (waiting === text) return
      stop()
      // Back at the text already read (an undo): nothing is owed.
      if (scanned === text) return
      waiting = text
      handle = timers.set(() => {
        const due = waiting
        handle = null
        waiting = null
        if (due === null) return
        const result = scan(due)
        scanned = due
        onResult(due, result)
      }, pauseMs)
    },
    cancel() {
      stop()
      scanned = null
    },
    pending: () => waiting !== null
  }
}

export interface PausedScanState<T> {
  /** The last reading and the exact text it was read from; null until the first one is in. */
  scanned: { text: string; result: T } | null
  /** True while `text` is not the text of that reading: a newer reading is waiting for the pause. */
  pending: boolean
}

/**
 * `scan(text)` once `text` has been unchanged for `pauseMs`. `text` null: nothing is scanned and the
 * last reading is dropped. `source` names what the text belongs to (a talk's path): a reading made
 * for another source is never returned.
 */
export function usePausedScan<T>(text: string | null, scan: (text: string) => T, source: string, pauseMs: number = OUTLINE_PAUSE_MS): PausedScanState<T> {
  const [reading, setReading] = useState<{ source: string; text: string; result: T } | null>(null)
  const scanRef = useRef(scan)
  scanRef.current = scan
  const scheduleRef = useRef<PausedScan | null>(null)

  // One schedule per source, declared before the effect that feeds it so it exists when that runs.
  useEffect(() => {
    const schedule = createPausedScan<T>({
      scan: (due) => scanRef.current(due),
      onResult: (read, result) => setReading({ source, text: read, result }),
      pauseMs
    })
    scheduleRef.current = schedule
    return () => {
      schedule.cancel()
      if (scheduleRef.current === schedule) scheduleRef.current = null
    }
  }, [source, pauseMs])

  useEffect(() => {
    if (text === null) {
      scheduleRef.current?.cancel()
      setReading(null)
      return
    }
    scheduleRef.current?.update(text)
  }, [text, source, pauseMs])

  const scanned = text !== null && reading && reading.source === source ? { text: reading.text, result: reading.result } : null
  return { scanned, pending: text !== null && scanned?.text !== text }
}
