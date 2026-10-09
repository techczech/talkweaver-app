// Audio-loss detector for the presenter's recorder — pure, no DOM, no timers.
//
// On 1 Oct a 2 h 57 min recording kept only its first 34 s of audio: the microphone input went
// away, MediaRecorder stopped producing data, and nothing noticed. This state machine is the one
// place that decides "audio has stopped" from what the browser reports. The audio capture
// (present-audio-capture.ts) feeds it events and a 1 s tick; it answers with a loss — its reason
// and the moment the audio really stopped (the start of the gap) — at most once per segment.
//
// Signals:
//   track-ended     the mic track's `ended` event (device unplugged, input switched away)
//   track-muted     the track's `mute` event, held for `muteGraceMs` without an `unmute`
//   recorder-error  MediaRecorder's `error` event
//   stalled         no data chunk for `stallMs` while recording (the recorder runs with a 1 s
//                   timeslice, so a healthy recorder delivers one about every second)
//   device-change   `navigator.mediaDevices` `devicechange`, after which the track's own input is
//                   no longer in the device list
// Pausing suspends the stall and mute clocks (a paused recorder delivers nothing by design).

export type LossReason = 'track-ended' | 'track-muted' | 'recorder-error' | 'stalled' | 'device-change'

export interface LossConfig {
  /** No chunk for this long while recording = stalled. */
  stallMs: number
  /** A `mute` must last this long before it counts as loss (brief OS mutes are normal). */
  muteGraceMs: number
}

/** Defaults for a recorder started with a 1000 ms timeslice. */
export const DEFAULT_LOSS_CONFIG: LossConfig = { stallMs: 5000, muteGraceMs: 3000 }

export type LossEvent =
  | { type: 'start'; at: number }
  | { type: 'chunk'; at: number }
  | { type: 'track-ended'; at: number }
  | { type: 'track-mute'; at: number }
  | { type: 'track-unmute'; at: number }
  | { type: 'recorder-error'; at: number }
  | { type: 'device-change'; at: number; inputPresent: boolean }
  | { type: 'pause'; at: number }
  | { type: 'resume'; at: number }
  | { type: 'tick'; at: number }
  | { type: 'stop'; at: number }

export type LossPhase = 'idle' | 'flowing' | 'paused' | 'lost'

export interface LossState {
  phase: LossPhase
  /** When audio was last known to flow: the last chunk, the segment start, or the resume. */
  lastDataAt: number
  /** When an unanswered `mute` began, else null. */
  mutedSince: number | null
  /** Set once lost: why, and when the audio stopped (the gap's start). */
  reason: LossReason | null
  lostAt: number | null
}

export interface Loss {
  reason: LossReason
  /** When the audio stopped — earlier than the event for a stall or a held mute. */
  at: number
}

export interface LossStep {
  state: LossState
  /** Present exactly on the step that declares the loss. */
  lost?: Loss
}

export function initialLossState(): LossState {
  return { phase: 'idle', lastDataAt: 0, mutedSince: null, reason: null, lostAt: null }
}

function lose(state: LossState, reason: LossReason, at: number): LossStep {
  return { state: { ...state, phase: 'lost', reason, lostAt: at, mutedSince: null }, lost: { reason, at } }
}

/** Advance the detector by one event. A lost detector stays lost until the next `start`. */
export function stepLoss(state: LossState, event: LossEvent, config: LossConfig = DEFAULT_LOSS_CONFIG): LossStep {
  const live = state.phase === 'flowing' || state.phase === 'paused'
  switch (event.type) {
    case 'start':
      // A new segment (first start, or after reacquiring the input): audio flows from now.
      return { state: { phase: 'flowing', lastDataAt: event.at, mutedSince: null, reason: null, lostAt: null } }
    case 'stop':
      return { state: { ...initialLossState() } }
    case 'chunk':
      if (state.phase !== 'flowing') return { state }
      return { state: { ...state, lastDataAt: Math.max(state.lastDataAt, event.at) } }
    case 'pause':
      if (state.phase !== 'flowing') return { state }
      return { state: { ...state, phase: 'paused' } }
    case 'resume':
      if (state.phase !== 'paused') return { state }
      // The stall clock restarts: nothing was owed while paused. A mute held across the pause
      // restarts its grace too.
      return { state: { ...state, phase: 'flowing', lastDataAt: event.at, mutedSince: state.mutedSince === null ? null : event.at } }
    case 'track-ended':
      return live ? lose(state, 'track-ended', event.at) : { state }
    case 'recorder-error':
      return live ? lose(state, 'recorder-error', event.at) : { state }
    case 'device-change':
      if (!live || event.inputPresent) return { state }
      return lose(state, 'device-change', event.at)
    case 'track-mute':
      if (!live || state.mutedSince !== null) return { state }
      return { state: { ...state, mutedSince: event.at } }
    case 'track-unmute':
      if (!live) return { state }
      return { state: { ...state, mutedSince: null } }
    case 'tick': {
      if (state.phase !== 'flowing') return { state }
      if (state.mutedSince !== null && event.at - state.mutedSince >= config.muteGraceMs) {
        return lose(state, 'track-muted', state.mutedSince)
      }
      if (event.at - state.lastDataAt >= config.stallMs) {
        // The gap starts at the last chunk: that is the last audio known to be on disk.
        return lose(state, 'stalled', state.lastDataAt)
      }
      return { state }
    }
    default:
      return { state }
  }
}

/**
 * After a `devicechange`: is the track's own input still in the device list? A track opened on a
 * named device must find that device id; a track on the system default ('default') must find its
 * physical device by group id — when the default moves to another device, the old one may be gone.
 * A track that reports no device (the test tone) is always present.
 */
export function inputStillPresent(
  settings: { deviceId?: string; groupId?: string } | null | undefined,
  devices: ReadonlyArray<{ kind: string; deviceId: string; groupId?: string }>
): boolean {
  const deviceId = settings?.deviceId
  if (!deviceId) return true
  const inputs = devices.filter((d) => d.kind === 'audioinput')
  if (deviceId !== 'default') return inputs.some((d) => d.deviceId === deviceId)
  const groupId = settings?.groupId
  if (!groupId) return inputs.length > 0
  return inputs.some((d) => d.groupId === groupId)
}

/** Words for the notice, by reason. */
export function lossReasonText(reason: LossReason | null): string {
  switch (reason) {
    case 'track-ended': return 'The microphone went away.'
    case 'track-muted': return 'The system muted the microphone.'
    case 'recorder-error': return 'The recorder reported an error.'
    case 'stalled': return 'No audio for 5 seconds.'
    case 'device-change': return 'The audio input changed.'
    default: return 'Audio stopped.'
  }
}
