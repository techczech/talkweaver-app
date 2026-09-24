import type { SlideFocusState } from '../../worker/protocol'
import type { LiveStatus } from '../main/live-presenter-client'

export function slideIdForAudience(hashSlideId: string, slide: { dataset?: { id?: string } }): string {
  return slide.dataset?.id || hashSlideId
}

export function presenterFocusState(dataset: { twLiveFocus?: string }): SlideFocusState | null {
  if (!dataset.twLiveFocus) return null
  try {
    const value = JSON.parse(dataset.twLiveFocus) as Record<string, unknown>
    if (
      (value.kind !== 'reveal' && value.kind !== 'focus')
      || !Number.isInteger(value.step)
      || Number(value.step) < 0
    ) return null
    return { kind: value.kind, step: Number(value.step) }
  } catch {
    return null
  }
}

export function presenterRevealState(dataset: { twLiveReveal?: string }): number {
  const reveal = Number(dataset.twLiveReveal)
  return Number.isInteger(reveal) && reveal >= 0 ? reveal : 0
}

export function liveSlideStateKey(state: {
  slideId: string
  reveal: number
  focus: SlideFocusState | null
}): string {
  return `${state.slideId}\0${state.reveal}\0${state.focus?.kind ?? ''}\0${state.focus?.step ?? ''}`
}

export function liveControlPresentation(status: LiveStatus): {
  label: string
  tone: 'idle' | 'connecting' | 'live' | 'reconnecting'
  title: string
} {
  if (status === 'ending') return { label: 'Ending live…', tone: 'connecting', title: 'Waiting for the live session to end' }
  if (status === 'expired') return { label: 'Session expired · Go live', tone: 'idle', title: 'Start a new live session (G)' }
  if (status === 'authentication-failed') return { label: 'Live sign-in required', tone: 'idle', title: 'Retry starting a live session (G)' }
  if (status === 'incompatible') return { label: 'Live update required', tone: 'idle', title: 'Retry after updating the live service (G)' }
  if (status === 'connecting') return { label: 'Going live…', tone: 'connecting', title: 'Connecting to the live session' }
  if (status === 'live') return { label: '● LIVE', tone: 'live', title: 'End live' }
  if (status === 'paused-reconnecting') return { label: 'reconnecting…', tone: 'reconnecting', title: 'End live' }
  return { label: 'Go live', tone: 'idle', title: 'Start a live session (G)' }
}
