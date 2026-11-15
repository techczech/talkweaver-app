import { useEffect, useState } from 'react'
import { answerView, cardView, versionLabel, type AnswerView, type UpdateState } from '@app-patterns/updates'
import type { UpdateSnapshot } from '../../../shared/update-checker'
import { FAIL_TEXT, REFUSAL_TEXT, blockersSentence, reopenText, sizeText } from '../../../shared/update-install'

export type { UpdateSnapshot }
export const UPDATE_ANSWER_EVENT = 'tw-update-answer'
export const WHATS_NEW_OPEN_EVENT = 'tw-whats-new-open'

/** The answers' buttons: the shared ones, and the click's own (ADR-0044). */
export type TwAnswerAction = NonNullable<AnswerView['action']> | 'update' | 'cancel' | 'restart' | 'retry-update'
export interface TwAnswerView extends Omit<AnswerView, 'action'> {
  action: TwAnswerAction | null
  /** Offer "Download from talkweaver.app" beside the action (a failed or refused update). */
  downloadLink?: boolean
}

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

/** The click's state as an answer, or null when no update is under way. */
export function installAnswer(snap: UpdateSnapshot): TwAnswerView | null {
  const s = snap.install
  switch (s.phase) {
    case 'downloading': return {
      tone: 'plain', title: `Downloading TalkWeaver ${s.version}…`,
      detail: `${sizeText(s.received)} of ${sizeText(s.total)}. You can keep working.`, action: 'cancel', version: s.version,
    }
    case 'waiting': return {
      tone: 'new', title: `TalkWeaver ${s.version} is ready`,
      detail: `It opens when you restart. ${blockersSentence(snap.blockers)}`.trim(), action: 'restart', version: s.version,
    }
    case 'restarting': return { tone: 'plain', title: `Restarting into ${s.version}…`, detail: 'macOS checks the new version; then TalkWeaver closes and opens again.', action: null, version: s.version }
    case 'reopen': { const text = reopenText(s); return { tone: 'warn', title: text.title, detail: text.detail, action: null, version: s.version } }
    case 'failed': return {
      tone: 'warn', title: `Could not update to ${s.version}`,
      detail: `${FAIL_TEXT[s.reason]} TalkWeaver ${versionLabel(snap.running)} is unchanged.`, action: 'retry-update', downloadLink: true, version: s.version,
    }
    default: return null
  }
}

/** A shared answer, with Download turned into Update where this copy can update itself. */
function withUpdate(view: AnswerView, snap: UpdateSnapshot): TwAnswerView {
  if (view.action !== 'download') return view
  if (snap.refusal === null && snap.file) return { ...view, action: 'update' }
  const why = snap.refusal && snap.refusal !== 'no-file' ? ` ${REFUSAL_TEXT[snap.refusal]}` : ''
  return { ...view, detail: `${view.detail}${why}` }
}

const stateOf = (snap: UpdateSnapshot): UpdateState => snap.state as unknown as UpdateState

/** What a Check for Updates… says, given the snapshot it returned (asked while presenting: that it will wait). */
export const answerOf = (snap: UpdateSnapshot): TwAnswerView =>
  snap.waiting
    ? { tone: 'plain', title: 'TalkWeaver will check when your talk ends.', detail: 'It sends nothing while you are presenting.', action: null }
    : installAnswer(snap) ?? withUpdate(answerView(stateOf(snap), viewContext(snap)), snap)

/** The New versions card in Settings: the click's state first, then the shared card. */
export function cardOf(snap: UpdateSnapshot): TwAnswerView | null {
  const install = installAnswer(snap)
  if (install) return install
  const view = cardView(stateOf(snap), viewContext(snap))
  return view ? withUpdate(view, snap) : null
}

/** The answer goes to the note, which holds it while a talk is on and shows it when the talk ends. */
export interface AnswerEventDetail { view: TwAnswerView; busy: boolean }
const showAnswer = (view: TwAnswerView, busy = false): TwAnswerView => {
  window.dispatchEvent(new CustomEvent<AnswerEventDetail>(UPDATE_ANSWER_EVENT, { detail: { view, busy } }))
  return view
}

/** Check for Updates… (menu, palette): asks the main process, then shows the answer as a note. */
export async function runCheckForUpdates(): Promise<TwAnswerView | null> {
  const api = window.tw?.updates
  if (!api) return null
  try {
    // While an update is under way, the answer is its state: no new request.
    const current = await api.get()
    const working = installAnswer(current)
    if (working) return showAnswer(working, current.busy)
    const snap = await api.check()
    // Asked while presenting: nothing was requested and nothing is shown now; main sends the answer when the talk is over.
    if (snap.waiting) return null
    // A talk began while the request was out: the finished answer is handed over to be held, never dropped.
    return showAnswer(answerOf(snap), snap.busy)
  } catch {
    const view: TwAnswerView = { tone: 'warn', title: 'Could not check for updates.', detail: 'TalkWeaver could not ask for the answer. Try again.', action: 'try-again' }
    return showAnswer(view)
  }
}

export const openWhatsNewTab = (): void => { window.dispatchEvent(new Event(WHATS_NEW_OPEN_EVENT)) }

/** Bind the controlled package UI (the What's new mark) to TalkWeaver's existing IPC and notes tab. */
export function updateActions(api: NonNullable<Window['tw']>['updates']) {
  return {
    ...api,
    // A rejected read must not escape as an unhandled rejection: fall back to opening the notes tab, which loads its own copy.
    loadNotes: async (_version: string) => { try { return (await api.whatsNew())?.items ?? null } catch { return [] } },
    showNotes: () => openWhatsNewTab(),
  }
}
