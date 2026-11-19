// Closing an editor window (ADR-0044 §6, rules B and D), for every close: the window's own, a quit, and an update's
// restart. Before this the close flushed the editor's text once and confirmed while typing stayed possible; a
// keystroke during that save scheduled a write the close did not wait for, and main accepted "the last save did not
// fail" as confirmation (review round two, finding 1). Now:
//   1. the editor is frozen at once (no typing, paste, drag, undo, menu or command edits; it says "Saving before the
//      update…" or "Saving before closing…");
//   2. the leave guard runs as before (flush, the save queue settles, the changed-on-disk sheet with Stay here);
//   3. the editor saves until nothing is left unsaved (it is frozen, so this ends), and confirms with its current
//      revision; main answers true (the window closes), false (it stays) or 'resave' (main has not recorded that
//      revision as written: save once more and confirm again);
//   4. anything other than closing unfreezes the editor with nothing lost.
// Pure: the window wiring is useOutlineDiskChange.ts; scripts/test-close-freeze.mjs drives it.

export interface CloseFreezeDeps {
  freeze(): void
  unfreeze(): void
  /** The leave guard (outlineDiskChange.ts guardLeave): false for Stay here. */
  leave(): Promise<boolean>
  /** Saves until the editor holds nothing unsaved; throws when a save fails (main then decides). */
  settle(signal?: AbortSignal): Promise<void>
  /** Writes the editor's current text even when it looks saved (main asked: 'resave'). */
  forceSave(signal?: AbortSignal): Promise<void>
  /** The editor's revision now (lib/editorRevision.ts). */
  revision(): number
  confirm(revision: number): Promise<boolean | 'resave'>
  /** The window stays open (window:close-kept). */
  kept(): Promise<unknown>
  /** Saving could not finish: keep the work editable and tell the person why it stayed open. */
  failed?(): void
}

export type CloseOutcome = 'closed' | 'kept'

/** At most this many confirmations (the first, then a save and a confirmation for each 'resave'). */
export const CLOSE_CONFIRM_ATTEMPTS = 3
/** The save phase has one deadline; a visible changed-on-disk choice can still wait for the person. */
export const CLOSE_SAVE_TIMEOUT_MS = 10_000

export async function closeFrozen(deps: CloseFreezeDeps): Promise<CloseOutcome> {
  deps.freeze()
  const saving = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const stay = async (): Promise<CloseOutcome> => {
    deps.unfreeze()
    try { await deps.kept() } catch { /* the window stays open either way */ }
    return 'kept'
  }
  try {
    if (!(await deps.leave())) return await stay()
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { saving.abort(); reject(new Error('Closing could not finish saving')) }, CLOSE_SAVE_TIMEOUT_MS)
    })
    const save = async (work: (signal?: AbortSignal) => Promise<void>): Promise<void> => {
      try { await Promise.race([work(saving.signal), expired]) }
      catch (error) { if (saving.signal.aborted) throw error /* ordinary save failures still go to main */ }
    }
    for (let attempt = 0; attempt < CLOSE_CONFIRM_ATTEMPTS; attempt++) {
      await save((signal) => deps.settle(signal))
      const answer = await deps.confirm(deps.revision())
      if (answer === true) return 'closed'
      if (answer !== 'resave') { deps.unfreeze(); return 'kept' }
      await save((signal) => deps.forceSave(signal))
    }
    deps.failed?.()
    return await stay()
  } catch {
    deps.failed?.()
    return await stay()
  } finally {
    clearTimeout(timer)
    saving.abort()
  }
}
