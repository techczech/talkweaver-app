// Updating in place (ADR-0044 §6, update-engine.ts commit): an update's restart closes the editor windows through
// their own close route first, and only then may the native install be called, with no window open. Electron's
// native quit-and-install, called with a window open, would instead watch the window list and install whenever the
// last window closes, however much later.
//
// THE RULE (ADR-0044 §6, third review round): a restart for an update goes ahead only when the only open windows
// were frozen editors that each confirmed the save of their current revision, every other window was already closed
// by the person, every main-process write queue has drained, and every blocker is clear in the same tick as the
// native call. Anything else calls it off.
//
// This file decides the window part, and only here. The restart closes only plain editor windows (and the hidden
// helpers, which hold no work). Any other window (Tools, Settings, Capture embed, a deck, a window of no known kind)
// is a blocker the person closes (window-kinds.ts); with one open, closeWindows closes nothing and answers false. An
// editor's close answers 'closed' only when the window has closed AND its close route said its work is saved
// (`saved`: the frozen editor confirmed the save of its current revision) beforehand. Kept open, no answer in time,
// a close that throws, a window that closed without that report: 'kept' or 'unknown', and the restart is off. After
// a called-off restart (`abandoned`) no further close is asked, every editor still open that the restart had asked
// to close is released (unfrozen, `release`), a late confirmation does not close it, and an editor is opened again
// whenever none is left, including after closes that were still in flight settle. No Electron here: index.ts
// supplies the windows; scripts/test-update-install.mjs and scripts/test-update-engine.mjs drive it with stand-ins.

/** A window as this needs it: its close route, and the event that says it has gone. */
export interface ClosableWindow {
  isDestroyed(): boolean
  close(): void
  once(event: 'closed', listener: () => void): unknown
  removeListener(event: 'closed', listener: () => void): unknown
}

/** One window's answer: closed with its work safe; kept open; or anything not positively known to be safe. */
export type CloseAnswer = 'closed' | 'kept' | 'unknown'

/**
 * Closes every window with `close`. True once every window has answered 'closed'; false as soon as one answers
 * anything else (or its close cannot start). Closes still in flight are settled by `abandoned`, not here.
 */
export function closeEveryWindow<W>(windows: readonly W[], close: (window: W) => Promise<CloseAnswer>): Promise<boolean> {
  if (windows.length === 0) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let left = windows.length
    for (const window of windows) {
      let closing: Promise<CloseAnswer>
      try { closing = Promise.resolve(close(window)) } catch { closing = Promise.resolve('unknown') }
      closing.then((answer) => {
        if (answer !== 'closed') resolve(false)
        else if (--left === 0) resolve(true)
      }, () => resolve(false))
    }
  })
}

export interface RestartWindowsPorts<W extends ClosableWindow> {
  /** Every window open now (hidden ones too: Electron's window list holds them all). The gate counts these. */
  windows(): W[]
  /** The window's identity (its webContents id: what its renderer's messages carry). */
  id(window: W): number
  /** What the restart does with the window (window-kinds.ts): an editor is closed and counts as safe only after
   *  `saved`; a hidden helper counts as safely closed when it has closed; a blocker is never closed by the restart
   *  (the person closes it), and while one is open the restart closes nothing. */
  classOf(window: W): 'editor' | 'blocker' | 'helper'
  /** The restart is over for this editor and it is still open (called off, kept, no answer in time): its frozen
   *  editor is unfrozen with nothing lost (index.ts sends outline:close-cancelled). */
  release(window: W): void
  /** Stops background work that opens hidden windows by itself (the thumbnail prewarm). Once every window open at
   *  the start has closed; never when the restart is called off before that. */
  stopBackground(): Promise<void>
  /** An editor window is open that the person can use. */
  hasEditor(): boolean
  /** Opens an editor window. */
  openEditor(): void
  log(message: string): void
  /** Further rounds for hidden windows that open again (default 3). */
  rounds?: number
}

/** What the editor's close route decides at its confirmation. */
export type ConfirmVerdict = 'close' | 'keep'

export function createRestartWindows<W extends ClosableWindow>(p: RestartWindowsPorts<W>) {
  /** A restart's close is under way and has not been called off. */
  let active = false
  /** Closes the restart is waiting for, by window. */
  const waiting = new Map<number, (answer: CloseAnswer) => void>()
  /** Windows the restart asked to close that have not closed yet. */
  const requested = new Map<number, W>()
  /** Windows whose close route reported their work saved (or that hold none), during this restart. */
  const safe = new Set<number>()
  /** After a called-off restart: windows it had asked to close, still open. A late confirmation leaves them open;
   *  if one closes anyway, an editor is opened again when none is left. */
  const held = new Map<number, { window: W; late: () => void }>()

  const message = (error: unknown): string => String((error as Error)?.message ?? error)
  function restoreEditor(why: string): void {
    try {
      if (p.hasEditor()) return
      p.log(`no editor is open after the restart was called off (${why}): opening one`)
      p.openEditor()
    } catch (error) { p.log(`an editor could not be opened again: ${message(error)}`) }
  }

  /** One window through its own route (`close()`, so its 'close' guard runs). */
  function closeOne(window: W): Promise<CloseAnswer> {
    return new Promise<CloseAnswer>((resolve) => {
      if (!active) { resolve('kept'); return }
      // Already gone before it was asked: nothing said its work was safe.
      if (window.isDestroyed()) { resolve('unknown'); return }
      const id = p.id(window)
      let kind: 'editor' | 'blocker' | 'helper'
      try { kind = p.classOf(window) } catch { resolve('unknown'); return }
      // A blocker is the person's to close; the restart never closes one.
      if (kind === 'blocker') { resolve('kept'); return }
      if (kind === 'helper') safe.add(id)
      let done = false
      const onClosed = (): void => {
        requested.delete(id)
        finish(safe.has(id) ? 'closed' : 'unknown')
      }
      const finish = (answer: CloseAnswer): void => {
        if (done) return
        done = true
        if (waiting.get(id) === finish) waiting.delete(id)
        try { window.removeListener('closed', onClosed) } catch { /* gone */ }
        resolve(answer)
      }
      window.once('closed', onClosed)
      waiting.get(id)?.('kept')
      waiting.set(id, finish)
      requested.set(id, window)
      try { window.close() } catch { finish('unknown') }
    })
  }

  return {
    /**
     * The restart's commit (engine port closeWindows): every window open now, closed through its own route; then
     * the background work that opens hidden windows is stopped, and a hidden window that opened meanwhile is closed
     * in a further round. A window the person can see that opened meanwhile is not closed: the restart is off. True
     * only when every window answered 'closed' and no window is left.
     */
    async closeWindows(): Promise<boolean> {
      // A blocker open (read in the same turn as the engine's last blocker check): nothing is closed.
      const blocked = (): boolean => p.windows().some((window) => { try { return p.classOf(window) === 'blocker' } catch { return true } })
      if (blocked()) { p.log('a window the person must close is open: no window was closed'); return false }
      active = true
      if (!(await closeEveryWindow(p.windows(), closeOne))) return false
      if (!active) return false
      try { await p.stopBackground() } catch { /* the rounds below and the engine's window count still hold */ }
      for (let round = 0; round < (p.rounds ?? 3); round++) {
        if (!active) return false
        const left = p.windows()
        if (left.length === 0) return true
        if (left.some((window) => { try { return p.classOf(window) !== 'helper' } catch { return true } })) return false
        if (!(await closeEveryWindow(left, closeOne))) return false
      }
      return active && p.windows().length === 0
    },
    /** How many windows are open now (engine port openWindows): every one, hidden ones too. */
    openWindows: (): number => p.windows().length,
    /**
     * The restart was called off after its commit began (engine port commitAbandoned). No further close is asked;
     * every close still waited for answers 'kept'; a window asked to close that is still open stays open (a late
     * confirmation does not close it), and if one closes anyway an editor is opened again when none is left. An
     * editor is opened now if none is left.
     */
    abandoned(): void {
      if (!active) { restoreEditor('the restart was called off'); return }
      active = false
      for (const finish of [...waiting.values()]) finish('kept')
      waiting.clear()
      for (const [id, window] of requested) {
        if (window.isDestroyed() || held.has(id)) continue
        try { p.release(window) } catch (error) { p.log(`an editor could not be released: ${message(error)}`) }
        const late = (): void => { held.delete(id); restoreEditor('a window the restart had asked to close closed afterwards') }
        held.set(id, { window, late })
        try { window.once('closed', late) } catch { held.delete(id) }
      }
      requested.clear()
      restoreEditor('the restart was called off')
    },

    // ── What the windows' own close routes report (index.ts) ─────────────────────────────────────────
    /** The restart is waiting for this window's close. */
    waiting: (id: number): boolean => active && waiting.has(id),
    /** The close route reports the window's work saved, or that it holds none: its close may count as safe. */
    saved(id: number): void { if (active && waiting.has(id)) safe.add(id) },
    /** The close route kept the window open (an editor's "Stay here", a deck's close offer). */
    kept(id: number): void { waiting.get(id)?.('kept') },
    /**
     * The editor's 5-second fallback found no answer from its renderer. True when this restart owns the close: the
     * window is left open with its work (the caller does not close it) and the restart is off. False otherwise: the
     * ordinary fallback goes ahead unchanged.
     */
    timedOut(id: number): boolean {
      if (!active || !waiting.has(id)) return false
      p.log(`window ${id} did not answer the restart's close in time: left open, the restart is off`)
      waiting.get(id)?.('unknown')
      return true
    },
    /**
     * The editor's renderer confirms its close (window:confirm-close), with `saved` true only when main knows its
     * work is saved (its last save succeeded, no failed save kept, no changed-on-disk choice pending). During the
     * restart: saved → its close counts as safe; not saved → kept open, the restart is off. After a called-off
     * restart, a window the restart had asked to close is kept open. Otherwise the ordinary close goes ahead.
     */
    confirm(id: number, saved: boolean): ConfirmVerdict {
      if (held.has(id)) return 'keep'
      if (!active) return 'close'
      // Asked by this restart and already answered kept or unknown: it stays open.
      if (!waiting.has(id)) return requested.has(id) ? 'keep' : 'close'
      if (saved) { safe.add(id); return 'close' }
      p.log(`window ${id} confirmed its close but its work is not saved: left open, the restart is off`)
      waiting.get(id)?.('kept')
      return 'keep'
    },
    /** A close of this window starts that the restart did not ask for (the person's own, or a quit): any hold left
     *  from a called-off restart is released, and its close is the ordinary one. */
    ordinaryClose(id: number): void {
      if (active && waiting.has(id)) return
      const h = held.get(id)
      if (!h) return
      held.delete(id)
      try { h.window.removeListener('closed', h.late) } catch { /* gone */ }
    },
  }
}
export type RestartWindows<W extends ClosableWindow> = ReturnType<typeof createRestartWindows<W>>
