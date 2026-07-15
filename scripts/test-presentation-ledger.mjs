// Tests for compiler/scripts/lib/16-presentation-ledger.mjs
// (Recording Capture, Phase 1: pure, node-testable session math).
import assert from 'node:assert/strict'
import { newSessionId, recordingMsFromMarks, buildSlideTimeIndex, isDiscardable, serialiseSession, parseSession } from '../compiler/scripts/lib/16-presentation-ledger.mjs'
let failures = 0
const check = (name, fn) => { try { fn(); console.log('ok  -', name) } catch (e) { failures++; console.log('FAIL-', name, '\n   ', e.message) } }

check('newSessionId is deterministic and shaped', () => {
  // 1783339200000 === 2026-07-06T12:00:00Z. (The brief's literal 1751808000000 is
  // actually 2025-07-06T13:20:00Z; corrected here to the time the brief names so the
  // UTC formatter stays a correct general function rather than a hack for one input.)
  assert.equal(newSessionId(1783339200000, () => 0.5), 'sess-20260706-120000-i')
})
check('recordingMs excludes paused spans', () => {
  // enter@0, pause@10000, resume@30000 (20s paused), stop implied at raw 50000 → recorded = 50000-20000 = 30000
  const marks = [{event:'enter',slideId:'a',tMs:0},{event:'pause',tMs:10000},{event:'resume',tMs:30000},{event:'enter',slideId:'b',tMs:40000}]
  assert.equal(recordingMsFromMarks([...marks, {event:'stop', tMs:50000}]), 30000)
})
check('buildSlideTimeIndex maps raw clock to recording clock', () => {
  const raw = [{event:'enter',slideId:'a',tMs:0},{event:'pause',tMs:10000},{event:'resume',tMs:30000},{event:'enter',slideId:'b',tMs:40000}]
  const idx = buildSlideTimeIndex(raw)
  // slide b entered at raw 40000, minus 20000 paused = 20000 on the recording clock
  assert.deepEqual(idx.find(m => m.slideId === 'b'), {event:'enter', slideId:'b', tMs:20000})
})
check('isDiscardable under threshold', () => {
  assert.equal(isDiscardable(15000, 20000), true)
  assert.equal(isDiscardable(25000, 20000), false)
})
check('session JSON round-trips', () => {
  const s = { id:'sess-x', talkSlug:'t', startedAt:'2026-07-06T12:00:00Z', recordingMs:30000, slideTimeIndex:[{event:'enter',slideId:'a',tMs:0}] }
  assert.deepEqual(parseSession(serialiseSession(s)), s)
})
// --- Regression pins for the deliberately-handled edge branches (pause-aware math is
// --- load-bearing for the whole recording feature). Expected values derived by tracing
// --- the current implementation; implementation is unchanged.

check('recordingMs handles multiple pause/resume cycles', () => {
  // pauses 10–20s (10s) and 40–55s (15s), run to 60s → 60000 - 25000 = 35000
  const marks = [
    {event:'enter',slideId:'a',tMs:0},
    {event:'pause',tMs:10000},{event:'resume',tMs:20000},
    {event:'enter',slideId:'b',tMs:30000},
    {event:'pause',tMs:40000},{event:'resume',tMs:55000},
    {event:'enter',slideId:'c',tMs:58000},
    {event:'stop',tMs:60000},
  ]
  assert.equal(recordingMsFromMarks(marks), 35000)
})
check('buildSlideTimeIndex re-bases every mark across multiple cycles (stop excluded)', () => {
  const raw = [
    {event:'enter',slideId:'a',tMs:0},
    {event:'pause',tMs:10000},{event:'resume',tMs:20000},
    {event:'enter',slideId:'b',tMs:30000},
    {event:'pause',tMs:40000},{event:'resume',tMs:55000},
    {event:'enter',slideId:'c',tMs:58000},
    {event:'stop',tMs:60000},
  ]
  assert.deepEqual(buildSlideTimeIndex(raw), [
    {event:'enter',slideId:'a',tMs:0},
    {event:'pause',tMs:10000},{event:'resume',tMs:10000}, // pause+resume collapse to one instant
    {event:'enter',slideId:'b',tMs:20000},
    {event:'pause',tMs:30000},{event:'resume',tMs:30000},
    {event:'enter',slideId:'c',tMs:33000},
  ])
})
check('recordingMs: bare pause with no resume does not count the paused tail', () => {
  // recorded 30s then paused with nothing after → 30000 (the open span is charged to `last`)
  assert.equal(recordingMsFromMarks([{event:'pause',tMs:30000}]), 30000)
  // paused at 30s, stopped at 50s while still paused → the 20s tail is NOT recorded → 30000
  assert.equal(recordingMsFromMarks([{event:'pause',tMs:30000},{event:'stop',tMs:50000}]), 30000)
})
check('buildSlideTimeIndex clamps an enter during an open pause to the pause instant (non-decreasing, not dropped)', () => {
  const raw = [{event:'enter',slideId:'a',tMs:0},{event:'pause',tMs:30000},{event:'enter',slideId:'b',tMs:40000}]
  const idx = buildSlideTimeIndex(raw)
  assert.deepEqual(idx, [
    {event:'enter',slideId:'a',tMs:0},
    {event:'pause',tMs:30000},
    {event:'enter',slideId:'b',tMs:30000}, // clamped to the pause instant, not dropped
  ])
  const b = idx.find(m => m.slideId === 'b')
  const pause = idx.find(m => m.event === 'pause')
  assert.equal(b.tMs, pause.tMs) // enter during pause == pause instant
  const times = idx.map(m => m.tMs)
  assert.ok(times.every((t, i) => i === 0 || t >= times[i - 1]), 'tMs non-decreasing')
})
check('recordingMs: a redundant (double) pause is a no-op', () => {
  // second pause@15000 must not move the paused-span start (still 10–20s = 10s) → 30000-10000 = 20000
  const marks = [{event:'enter',slideId:'a',tMs:0},{event:'pause',tMs:10000},{event:'pause',tMs:15000},{event:'resume',tMs:20000},{event:'stop',tMs:30000}]
  assert.equal(recordingMsFromMarks(marks), 20000)
})
check('recordingMs: a spurious (unmatched) resume is a no-op', () => {
  // resume@5000 with no open pause is ignored; only the 10–20s span counts → 30000-10000 = 20000
  const marks = [{event:'enter',slideId:'a',tMs:0},{event:'resume',tMs:5000},{event:'pause',tMs:10000},{event:'resume',tMs:20000},{event:'stop',tMs:30000}]
  assert.equal(recordingMsFromMarks(marks), 20000)
})
check('buildSlideTimeIndex excludes stop and unknown events', () => {
  const raw = [{event:'enter',slideId:'a',tMs:0},{event:'stop',tMs:5000},{event:'wibble',tMs:6000},{event:'enter',slideId:'b',tMs:10000}]
  const idx = buildSlideTimeIndex(raw)
  assert.deepEqual(idx, [{event:'enter',slideId:'a',tMs:0},{event:'enter',slideId:'b',tMs:10000}])
  assert.ok(!idx.some(m => m.event === 'stop' || m.event === 'wibble'))
})
check('isDiscardable: recordingMs exactly at threshold is KEPT (strict <)', () => {
  assert.equal(isDiscardable(20000, 20000), false) // == threshold → not discardable
  assert.equal(isDiscardable(19999, 20000), true)
})
check('buildSlideTimeIndex passes through reveal/highlight, pause-aware, carrying their state', () => {
  const raw = [
    { event: 'enter', slideId: 'a', tMs: 0 },
    { event: 'reveal', slideId: 'a', hidden: 2, tMs: 4000 },
    { event: 'pause', tMs: 6000 },
    { event: 'resume', tMs: 16000 },                       // 10s paused
    { event: 'highlight', slideId: 'a', marks: 1, tMs: 20000 },
    { event: 'reveal', slideId: 'a', hidden: 0, tMs: 22000 }
  ]
  const idx = buildSlideTimeIndex(raw)
  // reveal before the pause keeps its raw offset; marks after resume drop the 10s paused span.
  assert.deepEqual(idx.find(m => m.event === 'reveal' && m.hidden === 2), { event: 'reveal', slideId: 'a', tMs: 4000, hidden: 2 })
  assert.deepEqual(idx.find(m => m.event === 'highlight'), { event: 'highlight', slideId: 'a', tMs: 10000, marks: 1 })
  assert.deepEqual(idx.find(m => m.event === 'reveal' && m.hidden === 0), { event: 'reveal', slideId: 'a', tMs: 12000, hidden: 0 })
})
check('buildSlideTimeIndex passes highlight ranges through unchanged', () => {
  const ranges = [{ block: 2, start: 5, end: 14 }]
  const idx = buildSlideTimeIndex([
    { event: 'enter', slideId: 'a', tMs: 0 },
    { event: 'pause', tMs: 1000 },
    { event: 'resume', tMs: 6000 },
    { event: 'highlight', slideId: 'a', marks: 1, ranges, tMs: 8000 }
  ])
  assert.deepEqual(idx.find(m => m.event === 'highlight'), {
    event: 'highlight',
    slideId: 'a',
    tMs: 3000,
    marks: 1,
    ranges
  })
})
check('buildSlideTimeIndex keeps legacy highlight marks without ranges valid', () => {
  const idx = buildSlideTimeIndex([
    { event: 'enter', slideId: 'a', tMs: 0 },
    { event: 'highlight', slideId: 'a', marks: 2, tMs: 9000 }
  ])
  assert.deepEqual(idx.find(m => m.event === 'highlight'), {
    event: 'highlight',
    slideId: 'a',
    tMs: 9000,
    marks: 2
  })
})

console.log(failures ? `\n${failures} FAILED` : '\nall passed'); process.exit(failures?1:0)
