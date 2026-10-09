// The REC cluster in the presenter's status bar (ADR-0031 §3; presenter redesign ticket 03; drawn
// in docs/design/2026-09-26-presenter-redesign/round-2/, shots rec-*). This module is the
// recorder state → what the cluster shows mapping only: pure, no DOM, so the recording UI
// (present-rec-ui.ts) renders from it and a test can read it without a presenter window.
//
//   idle       grey dot · "Not recording" · Record
//   recording  red dot · "REC" · recorded length · Pause recording, Stop and save recording
//   paused     amber dot · "Recording paused" · length (amber) · Resume recording, Stop
//   saving     spinner · "Saving recording…" · length · no buttons
//   saved      green check · "Saved as <kind>" · Change (opens the run-kind picker)
// Not drawn, kept with their content in the same style: a short recording waiting on Keep /
// Discard, and a failed save waiting on Retry / Discard. And audio lost while recording (the
// microphone went away): red ring · "Audio stopped" (or "Reconnecting microphone…") · length ·
// Stop — the clock and slide timings carry on, so the cluster must not read "REC". The kind of run is chosen when saving,
// never on start (ADR-0031 §3).

import type { RecState } from './present-recorder'

export type RunKind = 'delivery' | 'rehearsal' | 'recording'
/** The cluster's buttons, by the id suffix of their element (#twrec-<name>). */
export type RecButton = 'primary' | 'pause' | 'resume' | 'stop' | 'change-kind' | 'keep' | 'export' | 'discard'
export type RecMark = 'dot' | 'spinner' | 'check'

export interface RecViewInput {
  state: RecState
  /** Pause-aware recorded length in ms. */
  displayMs: number
  /** The kind the saved run carries. */
  kind: RunKind
  /** A stopped recording's audio is still held (a failed save can be retried). */
  audioHeld: boolean
  /** Audio stopped arriving while recording or paused; recovering = reconnecting the input. */
  audio?: { lost: boolean; recovering: boolean }
}

export interface RecView {
  /** Colour family; the cluster's data-rec keeps the recorder's own state. */
  tone: 'idle' | 'recording' | 'paused' | 'saving' | 'saved' | 'confirm' | 'error' | 'lost'
  mark: RecMark
  word: string
  /** Collapse step c5 may drop the word; the dot's colour and the button's tooltip carry it. */
  wordCollapses: boolean
  /** Recorded length as mm:ss, or null when the cluster shows none. */
  time: string | null
  buttons: RecButton[]
  /** Keep reads "Retry save" while a failed save waits. */
  retrying: boolean
}

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(s / 60)
  return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
}

export function kindLabel(kind: RunKind): string {
  return kind === 'delivery' ? 'Delivery' : kind === 'rehearsal' ? 'Rehearsal' : 'Recording'
}

export function recView({ state, displayMs, kind, audioHeld, audio }: RecViewInput): RecView {
  const time = fmtClock(displayMs)
  const base = { wordCollapses: false, retrying: false }
  if (audio?.lost && (state === 'recording' || state === 'paused')) {
    const word = audio.recovering ? 'Reconnecting microphone…' : state === 'paused' ? 'Paused · audio stopped' : 'Audio stopped'
    return { ...base, tone: 'lost', mark: 'dot', word, time, buttons: state === 'paused' ? ['resume', 'stop'] : ['stop'] }
  }
  switch (state) {
    case 'recording':
      return { ...base, tone: 'recording', mark: 'dot', word: 'REC', time, buttons: ['pause', 'stop'] }
    case 'paused':
      return { ...base, tone: 'paused', mark: 'dot', word: 'Recording paused', wordCollapses: true, time, buttons: ['resume', 'stop'] }
    case 'saving':
      return { ...base, tone: 'saving', mark: 'spinner', word: 'Saving recording…', time, buttons: [] }
    case 'saved':
      return { ...base, tone: 'saved', mark: 'check', word: `Saved as ${kindLabel(kind)}`, time: null, buttons: ['change-kind'] }
    case 'confirm':
      return { ...base, tone: 'confirm', mark: 'dot', word: 'Short recording — keep it?', time, buttons: ['keep', 'discard'] }
    case 'error':
      if (audioHeld) return { ...base, tone: 'error', mark: 'dot', word: 'Recording not saved — try again?', time, buttons: ['keep', 'export', 'discard'], retrying: true }
      return { ...base, tone: 'idle', mark: 'dot', word: 'Not recording', wordCollapses: true, time: null, buttons: ['primary'] }
    default:
      return { ...base, tone: 'idle', mark: 'dot', word: 'Not recording', wordCollapses: true, time: null, buttons: ['primary'] }
  }
}
