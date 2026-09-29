import type { SlideFocusState, SlideLightboxState } from '../../worker/protocol'
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

export function presenterLightboxState(dataset: { twLiveLightbox?: string }): SlideLightboxState {
  try {
    const value = JSON.parse(dataset.twLiveLightbox || '') as Record<string, unknown>
    if (typeof value.open === 'boolean' && Number.isSafeInteger(value.index) && Number(value.index) >= 0)
      return { open: value.open, index: Number(value.index) }
  } catch { /* Older presenter templates do not publish gallery state. */ }
  return { open: false, index: 0 }
}

/** The presenter template stamps "1" while the talk's QR overlay is up (ticket 04). */
export function presenterTalkQrState(dataset: { twLiveTalkQr?: string }): boolean {
  return dataset.twLiveTalkQr === '1'
}

export function presenterLiveSlideState(
  hash: string,
  active: { dataset?: { id?: string } } | null,
  dataset: { twLiveReveal?: string; twLiveFocus?: string; twLiveLightbox?: string; twLiveTalkQr?: string },
): { slideId: string; reveal: number; focus: SlideFocusState | null; lightbox: SlideLightboxState; talkQr?: true } | null {
  const hashSlideId = hash.startsWith('#') ? decodeURIComponent(hash.slice(1)) : ''
  if (!hashSlideId || !active) return null
  return {
    slideId: slideIdForAudience(hashSlideId, active),
    reveal: presenterRevealState(dataset),
    focus: presenterFocusState(dataset),
    lightbox: presenterLightboxState(dataset),
    ...(presenterTalkQrState(dataset) ? { talkQr: true as const } : {}),
  }
}

export function liveSlideStateKey(state: {
  slideId: string
  reveal: number
  focus: SlideFocusState | null
  lightbox?: SlideLightboxState
  talkQr?: boolean
}): string {
  return `${state.slideId}\0${state.reveal}\0${state.focus?.kind ?? ''}\0${state.focus?.step ?? ''}\0${state.lightbox?.open ?? false}\0${state.lightbox?.index ?? 0}\0${state.talkQr === true}`
}

/**
 * The session is over for this window: 'ended', 'expired', or 'superseded' (another window took it
 * over — main's live-presenter-client treats all three as finished). Its polls, join link and
 * venue-screen watch are forgotten.
 */
export function liveSessionFinished(status: LiveStatus): boolean {
  return ['ended', 'expired', 'superseded'].includes(status)
}

/** Go live (G, Live → Go live, the "Not live" button) starts a NEW session from this status; from
 *  any other status it ends the current one ("End this live session?"). */
export function liveSessionCanStart(status: LiveStatus): boolean {
  return ['ended', 'expired', 'superseded', 'authentication-failed', 'incompatible'].includes(status)
}

export const END_LIVE_CONFIRM = 'End this live session?'
export const SUPERSEDED_START_CONFIRM = 'Another window took over this talk’s live session. Start a new session here? New joiners and venue screens will follow this one.'

/** What the live toggle (G, Live → Go live, "Not live", End live) does from `status`, and the question
 *  it asks first (null: none). Starting over a session another window took over asks first; Cancel
 *  leaves everything as it is. */
export function liveToggleIntent(status: LiveStatus): { action: 'start' | 'end'; confirm: string | null } {
  if (!liveSessionCanStart(status)) return { action: 'end', confirm: END_LIVE_CONFIRM }
  return { action: 'start', confirm: status === 'superseded' ? SUPERSEDED_START_CONFIRM : null }
}

/** No session is up for this window, and none is on its way: the venue-screen watch starts over. */
function noLiveSessionHere(status: LiveStatus): boolean {
  return ['ended', 'expired', 'superseded', 'authentication-failed', 'incompatible'].includes(status)
}

export function liveControlPresentation(status: LiveStatus): {
  label: string
  tone: 'idle' | 'connecting' | 'live' | 'reconnecting'
  title: string
} {
  // `title` is the control's name in its tooltip and accessible name; the key (G) comes from the
  // shortcut registry through src/shared/presenter-controls.ts, so it is not repeated here.
  if (status === 'ending') return { label: 'Ending live…', tone: 'connecting', title: 'Waiting for the live session to end' }
  if (status === 'expired') return { label: 'Session expired · Go live', tone: 'idle', title: 'Start a new live session' }
  if (status === 'authentication-failed') return { label: 'Live sign-in required', tone: 'idle', title: 'Retry starting a live session' }
  if (status === 'incompatible') return { label: 'Live update required', tone: 'idle', title: 'Retry after updating the live service' }
  if (status === 'connecting') return { label: 'Going live…', tone: 'connecting', title: 'Connecting to the live session' }
  if (status === 'live') return { label: 'LIVE', tone: 'live', title: 'End live session' }
  if (status === 'paused-reconnecting') return { label: 'Live paused · reconnecting', tone: 'reconnecting', title: 'End live session' }
  return { label: 'Go live', tone: 'idle', title: 'Go live' }
}

/**
 * The live status as the presenter's status bar shows it (ADR-0031 §2 and §7: live status appears
 * once, there). `active` = a session is up or on its way (the Go live button steps aside and End
 * live, where `canEnd`, takes its place); otherwise the slot says why there is no session.
 * `canStart` = the slot itself is the Go live button ("Not live", tooltip "Go live  G"; Dominik's
 * preview.8 feedback, 28 Sep); the other states stay status text.
 */
export function liveStatusView(status: LiveStatus): {
  label: string
  tone: 'off' | 'connecting' | 'live' | 'reconnecting'
  icon: 'radio' | 'wifi-off'
  active: boolean
  canEnd: boolean
  canStart: boolean
} {
  if (status === 'live') return { label: 'Live', tone: 'live', icon: 'radio', active: true, canEnd: true, canStart: false }
  if (status === 'paused-reconnecting') return { label: 'Live paused · reconnecting', tone: 'reconnecting', icon: 'wifi-off', active: true, canEnd: true, canStart: false }
  if (status === 'connecting') return { label: 'Going live…', tone: 'connecting', icon: 'radio', active: true, canEnd: false, canStart: false }
  if (status === 'ending') return { label: 'Ending live…', tone: 'connecting', icon: 'radio', active: true, canEnd: false, canStart: false }
  if (status === 'expired') return { label: 'Live session expired', tone: 'off', icon: 'radio', active: false, canEnd: false, canStart: false }
  if (status === 'authentication-failed') return { label: 'Live sign-in required', tone: 'off', icon: 'radio', active: false, canEnd: false, canStart: false }
  if (status === 'incompatible') return { label: 'Live update required', tone: 'off', icon: 'radio', active: false, canEnd: false, canStart: false }
  // 'ended', and 'superseded' (another window took this session over; main treats it as finished):
  // "Not live", and the slot is the Go live button — pressing it starts a new session.
  return { label: 'Not live', tone: 'off', icon: 'radio', active: false, canEnd: false, canStart: true }
}

/** A link as the go-live panel shows it: without its scheme (the drawing's "handouts.fyi/737u"). */
export function linkLabel(url: string): string {
  return url.replace(/^https?:\/\//, '')
}

export function venueScreenCountLabel(count: number): string {
  return count > 0 ? `${count} venue screen${count === 1 ? '' : 's'} connected` : ''
}

/**
 * Whether the venue screen (the talk's `/p` page) is following, as the presenter can tell it
 * (ADR-0026 §3; surfaces-and-states D6; presenter redesign ticket 06). The only signal is the live
 * session's presence count, `venueScreens`: how many venue screens hold a connection to the
 * session (the Worker counts `kind=screen` sockets and pushes the count on every connect and
 * close; the main process forwards it as `live:presence`). A connected venue screen follows the
 * laptop (ADR-0026 amendment), so:
 *  - `lost`: the session is live, a venue screen was following, and now none is connected;
 *  - `back`: one is connected again after `lost` (shown briefly, then `settleVenueWatch` clears it);
 *  - `null`: nothing to say (no venue screen was ever opened, or it follows as it should).
 * While the laptop itself is not live (reconnecting, ending, or no session) the count is not
 * current, so no notice shows; the live status says what is happening. A session that finishes
 * forgets that a venue screen was ever seen. The count cannot tell a dropped connection from a
 * page someone closed; both read as `lost`.
 */
export interface VenueWatch {
  /** A venue screen has been connected during this session. */
  seen: boolean
  notice: 'lost' | 'back' | null
}

export const VENUE_WATCH_START: VenueWatch = { seen: false, notice: null }

export function nextVenueWatch(previous: VenueWatch, status: LiveStatus, venueScreens: number): VenueWatch {
  if (noLiveSessionHere(status)) return VENUE_WATCH_START
  if (status !== 'live') return { seen: previous.seen, notice: null }
  if (venueScreens > 0) return { seen: true, notice: previous.notice === 'lost' || previous.notice === 'back' ? 'back' : null }
  return { seen: previous.seen, notice: previous.seen ? 'lost' : null }
}

/** The "following again" notice has been seen long enough (the drawing: three seconds). */
export function settleVenueWatch(previous: VenueWatch): VenueWatch {
  return previous.notice === 'back' ? { seen: previous.seen, notice: null } : previous
}

export const VENUE_BACK_MS = 3000

/**
 * The venue notice as the status bar shows it, beside the live status. `long` is the part collapse
 * step c7 drops at narrow widths ("Venue screen reconnecting"); the tooltip keeps the full words.
 */
export function venueNoticeView(notice: VenueWatch['notice']): {
  hidden: boolean
  tone: 'lost' | 'back' | ''
  icon: 'monitor-x' | 'monitor-check' | ''
  lead: string
  long: string
  tail: string
  tip: string
} {
  if (notice === 'lost') return {
    hidden: false, tone: 'lost', icon: 'monitor-x', lead: 'Venue screen ', long: 'not following · ', tail: 'reconnecting',
    tip: 'Venue screen not following · reconnecting. It holds its slide until it follows again'
  }
  if (notice === 'back') return {
    hidden: false, tone: 'back', icon: 'monitor-check', lead: 'Venue screen following again', long: '', tail: '',
    tip: 'Venue screen following again'
  }
  return { hidden: true, tone: '', icon: '', lead: '', long: '', tail: '', tip: '' }
}
