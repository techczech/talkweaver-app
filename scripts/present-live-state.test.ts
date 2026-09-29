import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  liveControlPresentation,
  liveSessionCanStart,
  liveSessionFinished,
  liveSlideStateKey,
  liveStatusView,
  liveToggleIntent,
  END_LIVE_CONFIRM,
  SUPERSEDED_START_CONFIRM,
  presenterFocusState,
  presenterLightboxState,
  presenterLiveSlideState,
  presenterRevealState,
  linkLabel,
  nextVenueWatch,
  settleVenueWatch,
  slideIdForAudience,
  VENUE_WATCH_START,
  venueNoticeView,
  venueScreenCountLabel,
} from '../src/preload/present-live-state'

test('presenter reveal reads the authoritative runtime projection', () => {
  expect(presenterRevealState({ twLiveReveal: '2' })).toBe(2)
  expect(presenterRevealState({ twLiveReveal: 'not-a-step' })).toBe(0)
})

test('audience identity follows the active rendered slide rather than a folded child hash', () => {
  expect(slideIdForAudience('carousel-child', { dataset: { id: 'carousel-parent' } })).toBe('carousel-parent')
})

test('presenter focus state reads the authoritative runtime state', () => {
  expect(presenterFocusState({ twLiveFocus: '{"kind":"reveal","step":2}' })).toEqual({ kind: 'reveal', step: 2 })
  expect(presenterFocusState({ twLiveFocus: '{"kind":"blur","step":2}' })).toBeNull()
})

test('the single live control distinguishes connecting, live, and reconnecting', () => {
  expect(liveControlPresentation('connecting')).toMatchObject({ label: 'Going live…', tone: 'connecting' })
  expect(liveControlPresentation('live')).toMatchObject({ label: 'LIVE', tone: 'live', title: 'End live session' })
  expect(liveControlPresentation('paused-reconnecting')).toMatchObject({ label: 'Live paused · reconnecting', tone: 'reconnecting' })
})
test('venue count is silent at zero and pluralises at two', () => {
  expect(venueScreenCountLabel(0)).toBe('')
  expect(venueScreenCountLabel(1)).toBe('1 venue screen connected')
  expect(venueScreenCountLabel(2)).toBe('2 venue screens connected')
})

test('live publishing detects focus-only changes on the same slide', () => {
  expect(liveSlideStateKey({ slideId: 'slide-a', reveal: 0, focus: { kind: 'focus', step: 1 } }))
    .not.toBe(liveSlideStateKey({ slideId: 'slide-a', reveal: 0, focus: { kind: 'focus', step: 2 } }))
})

test('live publishing carries gallery opening, steps, and closing', () => {
  expect(presenterLightboxState({ twLiveLightbox: '{"open":true,"index":1}' })).toEqual({ open: true, index: 1 })
  expect(presenterLightboxState({ twLiveLightbox: '{"open":true,"index":-1}' })).toEqual({ open: false, index: 0 })
  const base = { slideId: 'slide-a', reveal: 0, focus: null }
  expect(liveSlideStateKey({ ...base, lightbox: { open: true, index: 0 } }))
    .not.toBe(liveSlideStateKey({ ...base, lightbox: { open: true, index: 1 } }))
  expect(liveSlideStateKey({ ...base, lightbox: { open: true, index: 1 } }))
    .not.toBe(liveSlideStateKey({ ...base, lightbox: { open: false, index: 1 } }))
})

test('preload publishes the gallery with the active slide identity', () => {
  expect(presenterLiveSlideState('#child', { dataset: { id: 'parent' } }, {
    twLiveReveal: '1', twLiveFocus: '', twLiveLightbox: '{"open":true,"index":1}',
  })).toEqual({ slideId: 'parent', reveal: 1, focus: null, lightbox: { open: true, index: 1 } })
})

test('preload publishes the talk QR overlay only while it is up', () => {
  const dataset = { twLiveReveal: '0', twLiveFocus: '', twLiveLightbox: '{"open":false,"index":0}' }
  expect(presenterLiveSlideState('#slide-b', { dataset: {} }, { ...dataset, twLiveTalkQr: '1' }))
    .toEqual({ slideId: 'slide-b', reveal: 0, focus: null, lightbox: { open: false, index: 0 }, talkQr: true })
  expect(presenterLiveSlideState('#slide-b', { dataset: {} }, { ...dataset, twLiveTalkQr: '' })).not.toHaveProperty('talkQr')
  const base = { slideId: 'slide-b', reveal: 0, focus: null }
  expect(liveSlideStateKey({ ...base, talkQr: true })).not.toBe(liveSlideStateKey(base))
})

test('generated presenter uses one green-or-reconnecting live control', () => {
  const template = readFileSync(resolve(import.meta.dir, '../compiler/assets/templates/presenter-popup-single-html.html'), 'utf8')
  expect(template).not.toContain('id="liveChip"')
  expect(template).not.toContain('id="liveReconnectChip"')
  expect(template.match(/id="liveGoButton"/g)).toHaveLength(1)
  expect(template).toMatch(/live-go-button\.is-live[^}]*#19733f/)
  expect(template).toMatch(/live-go-button\.is-reconnecting[^}]*#8a4b0f/)
  expect(template).toContain('id="liveVenueUrl"')
  expect(template).toContain('id="liveVenueCopy"')
  expect(template).toContain('id="liveVenueCount"')
  expect(template).toContain('dataset.twLiveLightbox = JSON.stringify(state.lightbox)')
  expect(template).toContain('dataset.twLiveTalkQr = state.talkQr.open ? "1" : ""')
})

test('the status bar shows live status once, with End live only while a session can be ended (ADR-0031 §7)', () => {
  // "Not live" is the Go live button (preview.8 feedback); every other state is status text.
  expect(liveStatusView('ended')).toEqual({ label: 'Not live', tone: 'off', icon: 'radio', active: false, canEnd: false, canStart: true })
  expect(liveStatusView('live')).toEqual({ label: 'Live', tone: 'live', icon: 'radio', active: true, canEnd: true, canStart: false })
  for (const status of ['paused-reconnecting', 'connecting', 'ending', 'expired', 'authentication-failed', 'incompatible'] as const) expect(liveStatusView(status).canStart).toBe(false)
  // Another window took the session over (2026-09-28): "Not live" is the Go live button, as after ending.
  expect(liveStatusView('superseded')).toEqual(liveStatusView('ended'))
  expect(liveStatusView('paused-reconnecting')).toMatchObject({ label: 'Live paused · reconnecting', tone: 'reconnecting', icon: 'wifi-off', active: true, canEnd: true })
  expect(liveStatusView('connecting')).toMatchObject({ active: true, canEnd: false })
  expect(liveStatusView('ending')).toMatchObject({ active: true, canEnd: false })
  for (const status of ['expired', 'authentication-failed', 'incompatible'] as const) expect(liveStatusView(status)).toMatchObject({ active: false, canEnd: false, tone: 'off' })
  expect(liveStatusView('expired').label).toBe('Live session expired')
})

test('a superseded session is finished for this window: Go live starts a new one, never ends it (2026-09-28)', () => {
  // The bridge's toggle (G, Live → Go live, "Not live") asks "End this live session?" and sends
  // live:end whenever liveSessionCanStart is false; main treats 'superseded' as finished.
  expect(liveSessionCanStart('superseded')).toBe(true)
  expect(liveSessionFinished('superseded')).toBe(true)
  for (const status of ['ended', 'expired', 'authentication-failed', 'incompatible'] as const) expect(liveSessionCanStart(status)).toBe(true)
  for (const status of ['live', 'paused-reconnecting', 'connecting', 'ending'] as const) {
    expect(liveSessionCanStart(status)).toBe(false)
    expect(liveSessionFinished(status)).toBe(false)
  }
  expect(liveSessionFinished('ended')).toBe(true)
  expect(liveSessionFinished('expired')).toBe(true)
  expect(liveControlPresentation('superseded').title).toBe('Go live')
  // A venue screen seen in the superseded session is forgotten, as after ending.
  expect(nextVenueWatch({ seen: true, notice: 'lost' }, 'superseded', 0)).toEqual(VENUE_WATCH_START)
})

test('the live toggle: End live asks first; Go live over a superseded session asks first; after ending it just starts (2026-09-28)', () => {
  expect(liveToggleIntent('live')).toEqual({ action: 'end', confirm: END_LIVE_CONFIRM })
  expect(liveToggleIntent('paused-reconnecting')).toEqual({ action: 'end', confirm: END_LIVE_CONFIRM })
  expect(END_LIVE_CONFIRM).toBe('End this live session?')
  expect(liveToggleIntent('superseded')).toEqual({ action: 'start', confirm: SUPERSEDED_START_CONFIRM })
  expect(SUPERSEDED_START_CONFIRM).toBe('Another window took over this talk’s live session. Start a new session here? New joiners and venue screens will follow this one.')
  for (const status of ['ended', 'expired', 'authentication-failed', 'incompatible'] as const) expect(liveToggleIntent(status)).toEqual({ action: 'start', confirm: null })
})

test('the venue-screen notice follows the presence count while live (ADR-0026 §3, presenter redesign ticket 06)', () => {
  // No venue screen ever opened: a count of 0 says nothing.
  let watch = nextVenueWatch(VENUE_WATCH_START, 'live', 0)
  expect(watch).toEqual({ seen: false, notice: null })
  // One follows: still nothing to say.
  watch = nextVenueWatch(watch, 'live', 1)
  expect(watch).toEqual({ seen: true, notice: null })
  // It drops: not following · reconnecting.
  watch = nextVenueWatch(watch, 'live', 0)
  expect(watch.notice).toBe('lost')
  // Another count of 0 keeps it lost.
  expect(nextVenueWatch(watch, 'live', 0).notice).toBe('lost')
  // It comes back: following again, which stays until settled, then clears.
  watch = nextVenueWatch(watch, 'live', 1)
  expect(watch.notice).toBe('back')
  expect(nextVenueWatch(watch, 'live', 2).notice).toBe('back')
  watch = settleVenueWatch(watch)
  expect(watch).toEqual({ seen: true, notice: null })
  expect(settleVenueWatch({ seen: true, notice: 'lost' }).notice).toBe('lost')
  // While the laptop itself is not live the count is stale: no notice, but the screen stays known.
  const lost = nextVenueWatch(watch, 'live', 0)
  for (const status of ['paused-reconnecting', 'connecting', 'ending'] as const) expect(nextVenueWatch(lost, status, 0)).toEqual({ seen: true, notice: null })
  expect(nextVenueWatch(nextVenueWatch(lost, 'paused-reconnecting', 0), 'live', 0).notice).toBe('lost')
  // A finished session forgets the venue screen.
  for (const status of ['ended', 'expired', 'authentication-failed', 'incompatible'] as const) expect(nextVenueWatch(lost, status, 0)).toEqual(VENUE_WATCH_START)
})

test('the venue notice reads as drawn, with the part c7 drops kept apart', () => {
  expect(venueNoticeView(null).hidden).toBe(true)
  const lost = venueNoticeView('lost')
  expect({ hidden: lost.hidden, tone: lost.tone, icon: lost.icon }).toEqual({ hidden: false, tone: 'lost', icon: 'monitor-x' })
  expect(lost.lead + lost.long + lost.tail).toBe('Venue screen not following · reconnecting')
  expect(lost.lead + lost.tail).toBe('Venue screen reconnecting')
  expect(lost.tip.startsWith('Venue screen not following · reconnecting')).toBe(true)
  const back = venueNoticeView('back')
  expect({ tone: back.tone, icon: back.icon, text: back.lead + back.long + back.tail }).toEqual({ tone: 'back', icon: 'monitor-check', text: 'Venue screen following again' })
  expect(linkLabel('https://handouts.fyi/737u/p')).toBe('handouts.fyi/737u/p')
})
