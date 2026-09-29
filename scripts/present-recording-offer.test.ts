import { expect, test } from 'bun:test'
import {
  RECORDING_OFFER_VISIBLE_MS,
  shouldOfferRecordingStart,
  TITLE_DWELL_MS,
  type RecordingStartOfferInput,
} from '../src/preload/present-recording-offer'

const base: RecordingStartOfferInput = {
  titleArrivedAtMs: 1_000,
  nowMs: 1_000 + TITLE_DWELL_MS,
  fromIndex: 0,
  toIndex: 1,
  recordingState: 'idle',
  alreadyOffered: false,
}

test('the dwell is one minute and the toast lasts about eight seconds', () => {
  expect(TITLE_DWELL_MS).toBe(60_000)
  expect(RECORDING_OFFER_VISIBLE_MS).toBe(8_000)
})

test('offers when the title slide was up a full minute and the talk moves to slide 2', () => {
  expect(shouldOfferRecordingStart(base)).toBe(true)
  expect(shouldOfferRecordingStart({ ...base, nowMs: base.nowMs + 5 * 60_000 })).toBe(true)
})

test('no offer when the title slide was up less than a minute', () => {
  expect(shouldOfferRecordingStart({ ...base, nowMs: base.nowMs - 1 })).toBe(false)
  expect(shouldOfferRecordingStart({ ...base, nowMs: 1_000 })).toBe(false)
})

test('no offer unless the move is title slide → slide 2', () => {
  expect(shouldOfferRecordingStart({ ...base, fromIndex: 1, toIndex: 2 })).toBe(false)
  expect(shouldOfferRecordingStart({ ...base, fromIndex: 0, toIndex: 4 })).toBe(false)
  expect(shouldOfferRecordingStart({ ...base, fromIndex: 1, toIndex: 0 })).toBe(false)
  expect(shouldOfferRecordingStart({ ...base, fromIndex: -1, toIndex: 1 })).toBe(false)
})

test('no offer when the presenter was not on the title slide', () => {
  expect(shouldOfferRecordingStart({ ...base, titleArrivedAtMs: null })).toBe(false)
})

test('no offer once recording has started, in any recorder state but idle', () => {
  for (const recordingState of ['recording', 'paused', 'confirm', 'saving', 'saved', 'error'] as const) {
    expect(shouldOfferRecordingStart({ ...base, recordingState })).toBe(false)
  }
})

test('at most once per presenting session', () => {
  expect(shouldOfferRecordingStart({ ...base, alreadyOffered: true })).toBe(false)
})
