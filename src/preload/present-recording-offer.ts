// The "start recording?" offer (decided 2026-09-24): when the talk moves off a title slide that
// has been up for at least a minute, and no audio recording is running, the presenter gets one
// quiet toast naming ⇧R. This module is the timing rule only — pure, no DOM, no clock — so the
// recorder decides with it and the rule is testable without a presenter window.

import type { RecState } from './present-recorder'

/** How long the title slide must have been showing, continuously, before the offer can appear. */
export const TITLE_DWELL_MS = 60_000

/** How long the offer toast stays up if ignored. */
export const RECORDING_OFFER_VISIBLE_MS = 8_000

export interface RecordingStartOfferInput {
  /** When the presenter last arrived on the title slide (index 0), or null if not on it. */
  titleArrivedAtMs: number | null
  /** The moment of the slide change, on the same clock as titleArrivedAtMs. */
  nowMs: number
  /** Slide index before the change (0 = title slide). */
  fromIndex: number
  /** Slide index after the change. */
  toIndex: number
  /** The audio recorder's state at the moment of the change. */
  recordingState: RecState
  /** Whether this presenting session has already shown the offer. */
  alreadyOffered: boolean
}

/**
 * True exactly when the offer should appear: the presenter moves forward from the title slide
 * to slide 2, the title slide was up for at least TITLE_DWELL_MS, no recording has been started
 * (the recorder is idle), and the offer has not been shown before in this session.
 */
export function shouldOfferRecordingStart(input: RecordingStartOfferInput): boolean {
  if (input.alreadyOffered) return false
  if (input.recordingState !== 'idle') return false
  if (input.fromIndex !== 0 || input.toIndex !== 1) return false
  if (input.titleArrivedAtMs === null) return false
  return input.nowMs - input.titleArrivedAtMs >= TITLE_DWELL_MS
}
