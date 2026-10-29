import { useEffect, useState } from 'react'
import type { UpdateSnapshot } from '@app-patterns/updates'
import { answerView, type AnswerView } from '@app-patterns/updates'

export const UPDATE_ANSWER_EVENT = 'tw-update-answer'
export const WHATS_NEW_OPEN_EVENT = 'tw-whats-new-open'

/** The facts every wording function needs, from a snapshot. */
export const viewContext = (snap: UpdateSnapshot, now: number = Date.now()) =>
  ({ identity: snap.identity, arch: snap.arch, running: snap.running, platform: snap.platform, source: snap.source, enabled: snap.enabled, checking: snap.checking, now })

/** The snapshot, kept current: read once, then pushed by the main process and re-read when the window regains focus. */
export function useUpdateSnapshot(): UpdateSnapshot | null {
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null)
  useEffect(() => {
    const api = window.tw?.updates
    if (!api) return
    let live = true
    const read = (): void => { void api.get().then((s) => { if (live) setSnapshot(s) }).catch(() => {}) }
    read()
    const off = api.onChange((s) => { if (live) setSnapshot(s) })
    // A presenting window closing hands focus back here: the mark (held back while presenting) returns.
    window.addEventListener('focus', read)
    return () => { live = false; off(); window.removeEventListener('focus', read) }
  }, [])
  return snapshot
}

/** What a Check for Updates… says, given the snapshot it returned (asked while presenting: that it will wait). */
export const answerOf = (snap: UpdateSnapshot): AnswerView =>
  snap.waiting
    ? { tone: 'plain', title: 'TalkWeaver will check when your talk ends.', detail: 'It sends nothing while you are presenting.', action: null }
    : answerView(snap.state, viewContext(snap))

/** The answer goes to the note, which holds it while a talk is on and shows it when the talk ends. */
export interface AnswerEventDetail { view: AnswerView; busy: boolean }
const showAnswer = (view: AnswerView, busy = false): AnswerView => {
  window.dispatchEvent(new CustomEvent<AnswerEventDetail>(UPDATE_ANSWER_EVENT, { detail: { view, busy } }))
  return view
}

/** Check for Updates… (menu, palette): asks the main process, then shows the answer as a note. */
export async function runCheckForUpdates(): Promise<AnswerView | null> {
  const api = window.tw?.updates
  if (!api) return null
  try {
    const snap = await api.check()
    // Asked while presenting: nothing was requested and nothing is shown now; main sends the answer when the talk is over.
    if (snap.waiting) return null
    // A talk began while the request was out: the finished answer is handed over to be held, never dropped.
    return showAnswer(answerOf(snap), snap.busy)
  } catch {
    const view: AnswerView = { tone: 'warn', title: 'Could not check for updates.', detail: 'TalkWeaver could not ask for the answer. Try again.', action: 'try-again' }
    return showAnswer(view)
  }
}

export const openWhatsNewTab = (): void => { window.dispatchEvent(new Event(WHATS_NEW_OPEN_EVENT)) }

/** Bind the controlled package UI to TalkWeaver's existing IPC and notes tab. */
export function updateActions(api: NonNullable<Window['tw']>['updates']) {
  return {
    ...api,
    // A rejected read must not escape as an unhandled rejection: fall back to opening the notes tab, which loads its own copy.
    loadNotes: async (_version: string) => { try { return (await api.whatsNew())?.items ?? null } catch { return [] } },
    showNotes: () => openWhatsNewTab(),
  }
}
