import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  liveControlPresentation,
  liveSlideStateKey,
  presenterFocusState,
  presenterRevealState,
  slideIdForAudience,
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
  expect(liveControlPresentation('live')).toMatchObject({ label: '● LIVE', tone: 'live' })
  expect(liveControlPresentation('paused-reconnecting')).toMatchObject({ label: 'reconnecting…', tone: 'reconnecting' })
})

test('live publishing detects focus-only changes on the same slide', () => {
  expect(liveSlideStateKey({ slideId: 'slide-a', reveal: 0, focus: { kind: 'focus', step: 1 } }))
    .not.toBe(liveSlideStateKey({ slideId: 'slide-a', reveal: 0, focus: { kind: 'focus', step: 2 } }))
})

test('generated presenter uses one green-or-reconnecting live control', () => {
  const template = readFileSync(resolve(import.meta.dir, '../compiler/assets/templates/presenter-popup-single-html.html'), 'utf8')
  expect(template).not.toContain('id="liveChip"')
  expect(template).not.toContain('id="liveReconnectChip"')
  expect(template.match(/id="liveGoButton"/g)).toHaveLength(1)
  expect(template).toMatch(/live-go-button\.is-live[^}]*#19733f/)
  expect(template).toMatch(/live-go-button\.is-reconnecting[^}]*#8a4b0f/)
})
