// The recorder's audio-loss detector (src/preload/recording-loss.ts), driven as the pure state
// machine it is. The 1 Oct incident: a 2 h 57 min recording kept 34 s of audio and nothing noticed.
// Each loss signal — track end, held mute, recorder error, stall, device change — must be declared
// once, with the moment the audio really stopped; pausing must not read as a stall; a lost detector
// stays lost until a new segment starts.
import assert from 'node:assert/strict'
import { DEFAULT_LOSS_CONFIG, initialLossState, inputStillPresent, stepLoss } from '../src/preload/recording-loss.ts'

const cfg = { stallMs: 5000, muteGraceMs: 3000 }
let failures = 0
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`) } catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`) }
}
// Run a list of events; return every loss declared and the final state.
function run(events, config = cfg) {
  let state = initialLossState()
  const losses = []
  for (const event of events) {
    const step = stepLoss(state, event, config)
    state = step.state
    if (step.lost) losses.push(step.lost)
  }
  return { state, losses }
}
const chunks = (from, to) => Array.from({ length: Math.floor((to - from) / 1000) + 1 }, (_, i) => ({ type: 'chunk', at: from + i * 1000 }))
const ticks = (from, to) => Array.from({ length: Math.floor((to - from) / 1000) + 1 }, (_, i) => ({ type: 'tick', at: from + i * 1000 }))

check('defaults match a 1 s timeslice: stall at 5 s', () => {
  assert.equal(DEFAULT_LOSS_CONFIG.stallMs, 5000)
})

check('healthy recording: chunks every second, ticks, no loss for an hour', () => {
  const events = []
  events.push({ type: 'start', at: 0 })
  for (let t = 1000; t <= 3_600_000; t += 1000) events.push({ type: 'chunk', at: t }, { type: 'tick', at: t + 10 })
  const { state, losses } = run(events)
  assert.equal(losses.length, 0)
  assert.equal(state.phase, 'flowing')
})

check('stall: chunks stop at 34 s → lost as "stalled", gap starts at the last chunk', () => {
  const { state, losses } = run([{ type: 'start', at: 0 }, ...chunks(1000, 34_000), ...ticks(35_000, 60_000)])
  assert.equal(losses.length, 1, 'declared exactly once')
  assert.deepEqual(losses[0], { reason: 'stalled', at: 34_000 })
  assert.equal(state.phase, 'lost')
})

check('stall is declared within stallMs of the last chunk, not before', () => {
  const early = run([{ type: 'start', at: 0 }, { type: 'chunk', at: 1000 }, { type: 'tick', at: 5999 }])
  assert.equal(early.losses.length, 0, 'not yet at 4.999 s')
  const due = run([{ type: 'start', at: 0 }, { type: 'chunk', at: 1000 }, { type: 'tick', at: 6000 }])
  assert.equal(due.losses.length, 1, 'declared at 5 s')
})

check('track ended → lost at once as "track-ended"', () => {
  const { losses } = run([{ type: 'start', at: 0 }, ...chunks(1000, 10_000), { type: 'track-ended', at: 10_400 }])
  assert.deepEqual(losses, [{ reason: 'track-ended', at: 10_400 }])
})

check('recorder error → lost at once as "recorder-error"', () => {
  const { losses } = run([{ type: 'start', at: 0 }, { type: 'chunk', at: 1000 }, { type: 'recorder-error', at: 1500 }])
  assert.deepEqual(losses, [{ reason: 'recorder-error', at: 1500 }])
})

check('device change: input gone → lost; input still there → nothing', () => {
  const gone = run([{ type: 'start', at: 0 }, { type: 'device-change', at: 2000, inputPresent: false }])
  assert.deepEqual(gone.losses, [{ reason: 'device-change', at: 2000 }])
  const present = run([{ type: 'start', at: 0 }, { type: 'chunk', at: 1000 }, { type: 'device-change', at: 1200, inputPresent: true }, { type: 'tick', at: 2000 }])
  assert.equal(present.losses.length, 0)
})

check('mute: a brief mute is ignored; a held mute is lost from when it began', () => {
  const brief = run([{ type: 'start', at: 0 }, ...chunks(1000, 3000), { type: 'track-mute', at: 3100 }, { type: 'tick', at: 4000 }, { type: 'track-unmute', at: 4500 }, ...chunks(5000, 9000), ...ticks(5000, 9000)])
  assert.equal(brief.losses.length, 0)
  // Chunks keep coming while muted (the recorder records silence), so only the mute rule catches it.
  const held = run([{ type: 'start', at: 0 }, { type: 'track-mute', at: 2000 }, ...chunks(1000, 6000), { type: 'tick', at: 4999 }, { type: 'tick', at: 5000 }])
  assert.deepEqual(held.losses, [{ reason: 'track-muted', at: 2000 }])
})

check('pause suspends the stall clock; resume restarts it', () => {
  const { losses, state } = run([
    { type: 'start', at: 0 }, ...chunks(1000, 10_000),
    { type: 'pause', at: 10_500 }, ...ticks(11_000, 600_000),
    { type: 'resume', at: 600_500 }, { type: 'tick', at: 603_000 }, { type: 'chunk', at: 601_500 }, { type: 'tick', at: 605_000 }
  ])
  assert.equal(losses.length, 0, 'ten minutes paused is not a stall')
  assert.equal(state.phase, 'flowing')
  const after = run([{ type: 'start', at: 0 }, { type: 'pause', at: 1000 }, { type: 'resume', at: 50_000 }, { type: 'tick', at: 55_000 }])
  assert.deepEqual(after.losses, [{ reason: 'stalled', at: 50_000 }], 'a resumed recorder that sends nothing is a stall, dated from the resume')
})

check('a track that ends while paused is still a loss', () => {
  const { losses } = run([{ type: 'start', at: 0 }, { type: 'pause', at: 1000 }, { type: 'track-ended', at: 9000 }])
  assert.deepEqual(losses, [{ reason: 'track-ended', at: 9000 }])
})

check('lost stays lost (one report) until a new segment starts; then it watches again', () => {
  const { losses, state } = run([
    { type: 'start', at: 0 }, { type: 'track-ended', at: 1000 }, { type: 'recorder-error', at: 1100 }, ...ticks(2000, 30_000),
    { type: 'start', at: 31_000 }, { type: 'chunk', at: 32_000 }, ...ticks(33_000, 37_000)
  ])
  assert.deepEqual(losses.map((l) => l.reason), ['track-ended', 'stalled'])
  assert.equal(state.phase, 'lost')
})

check('idle and stopped detectors declare nothing', () => {
  assert.equal(run([{ type: 'track-ended', at: 1 }, { type: 'tick', at: 100_000 }]).losses.length, 0)
  assert.equal(run([{ type: 'start', at: 0 }, { type: 'stop', at: 1000 }, { type: 'tick', at: 100_000 }, { type: 'track-ended', at: 100_001 }]).losses.length, 0)
})

check('inputStillPresent: named device, default device by group, and the test tone', () => {
  const devices = [
    { kind: 'audioinput', deviceId: 'default', groupId: 'g-usb' },
    { kind: 'audioinput', deviceId: 'mac-mic', groupId: 'g-mac' },
    { kind: 'audiooutput', deviceId: 'usb', groupId: 'g-usb' }
  ]
  assert.equal(inputStillPresent({ deviceId: 'mac-mic', groupId: 'g-mac' }, devices), true)
  assert.equal(inputStillPresent({ deviceId: 'usb-mic', groupId: 'g-usb' }, devices), false, 'a named input that left the list is gone')
  assert.equal(inputStillPresent({ deviceId: 'default', groupId: 'g-mac' }, devices), true, 'default track whose device is still connected')
  assert.equal(inputStillPresent({ deviceId: 'default', groupId: 'g-dock' }, devices), false, 'default track whose device was unplugged')
  assert.equal(inputStillPresent({}, devices), true, 'no device id (synthetic stream)')
  assert.equal(inputStillPresent({ deviceId: 'default', groupId: 'g-mac' }, []), false, 'no inputs at all')
})

if (failures) {
  console.error(`\n${failures} recording-loss check(s) failed`)
  process.exit(1)
}
console.log('\nrecording-loss: all checks passed')
