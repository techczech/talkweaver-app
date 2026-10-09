// How much audio a Run holds against how long it was recorded. Seams:
//  1. runAudioSummary (src/shared/run-audio.ts) — the label History and Studio show ("Audio 34 s of
//     2 h 57 min · 1 gap"), and nothing for a complete Run or an older Run without segment data;
//  2. the main process (src/main/recording.ts + recording-stream-ipc.ts, bundled with electron
//     stubbed): a streamed recording saved through recording:save writes segments, gaps, audioMs
//     and bytes into the Run; a recording whose window dies mid-way becomes a partial Run that
//     references its audio at once; one left over from a crash is recovered on the next launch.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUDIO_DIFFERS_TOLERANCE_MS, audioMsFromSegments, fmtAudioLength, runAudioSummary } from '../src/shared/run-audio.ts'

const repo = fileURLToPath(new URL('..', import.meta.url))
let failures = 0
async function check(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`) } catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`) }
}

// ── 1. The summary ──────────────────────────────────────────────────────────
const H = 3_600_000
await check('lengths in words', () => {
  assert.equal(fmtAudioLength(34_000), '34 s')
  assert.equal(fmtAudioLength((2 * 60 + 57) * 60_000), '2 h 57 min')
  assert.equal(fmtAudioLength(12 * 60_000 + 5000), '12 min 5 s')
  assert.equal(fmtAudioLength(H), '1 h')
})

await check('the 1 Oct case: 34 s of audio in a 2 h 57 min recording', () => {
  const run = { recordingMs: (2 * 60 + 57) * 60_000, audio: { r2Key: 'k', bytes: 400_000, uploaded: false, audioMs: 34_000, segments: [{ file: 'a.webm', bytes: 400_000, startMs: 0, endMs: 34_000 }], gaps: [{ startMs: 34_000, endMs: (2 * 60 + 57) * 60_000, reason: 'stalled' }] } }
  const s = runAudioSummary(run)
  assert.equal(s.differs, true)
  assert.equal(s.audioMs, 34_000)
  assert.equal(s.label, 'Audio 34 s of 2 h 57 min · 1 gap')
})

await check('segments with a gap: audio is the sum of the segments', () => {
  const segments = [{ file: 'a', bytes: 1, startMs: 0, endMs: 30 * 60_000 }, { file: 'b', bytes: 1, startMs: 31 * 60_000, endMs: 60 * 60_000 }]
  assert.equal(audioMsFromSegments(segments), 59 * 60_000)
  const s = runAudioSummary({ recordingMs: H, audio: { segments, gaps: [{ startMs: 30 * 60_000, endMs: 31 * 60_000, reason: 'track-ended' }] } })
  assert.equal(s.label, 'Audio 59 min of 1 h · 1 gap')
})

await check('complete, older and audio-less Runs say nothing', () => {
  assert.equal(runAudioSummary({ recordingMs: H, audio: { r2Key: 'k', bytes: 1, uploaded: false } }).label, null, 'older Run without segment data')
  assert.equal(runAudioSummary({ recordingMs: H, audio: { audioMs: H - AUDIO_DIFFERS_TOLERANCE_MS } }).label, null, 'within the chunk tolerance')
  assert.equal(runAudioSummary({ recordingMs: H, audio: null }).label, null)
  assert.equal(runAudioSummary({ recordingMs: H, audio: { audioMs: H, segments: [{ file: 'a', bytes: 1, startMs: 0, endMs: H }] } }).differs, false)
})

await check('a partial (interrupted) Run always says so', () => {
  assert.equal(runAudioSummary({ recordingMs: 60_000, audio: { audioMs: 60_000, partial: true } }).label, 'Audio 1 min of 1 min · recording interrupted')
})

// ── 2. The main process ─────────────────────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'talkweaver-run-audio-'))
const vault = join(scratch, 'vault')
const userData = join(scratch, 'userData')
mkdirSync(join(vault, '_PRESENTATIONS'), { recursive: true })
mkdirSync(userData, { recursive: true })

const bundled = await build({
  entryPoints: [join(repo, 'src/main/recording.ts')], bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', logLevel: 'silent',
  plugins: [{ name: 'electron-test-boundary', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test' }))
    b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'module.exports = globalThis.__runAudioElectron', loader: 'js' }))
  } }]
})
// Each load is a fresh main process (module state included) — the second one is the relaunch.
function launchMain() {
  const handlers = new Map()
  const trashed = []
  globalThis.__runAudioElectron = {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    BrowserWindow: { fromWebContents: () => null },
    shell: { trashItem: async (p) => { trashed.push(p) } },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [globalThis.__exportDir] }) }
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
  const saved = []
  module.exports.registerRecordingIpc({
    compilerDir: () => join(repo, 'compiler/scripts'),
    userDataDir: () => userData,
    vaultRoot: () => vault,
    discardThresholdMs: () => 20000,
    r2Config: () => ({ endpoint: '', bucket: '', credsSource: 'settings', bwsSecretId: '' }),
    readSafeKeys: () => null,
    onSessionSaved: (s) => saved.push(s)
  })
  return { handlers, trashed, saved, recover: module.exports.recoverInterruptedRecordings }
}
// A webContents with the events main listens for.
function sender(id) {
  const listeners = {}
  return { id, once: (ev, fn) => { (listeners[ev] ??= []).push(fn) }, on: (ev, fn) => { (listeners[ev] ??= []).push(fn) }, emit: (ev) => { for (const fn of listeners[ev] ?? []) fn() } }
}
const chunk = (n) => new Uint8Array(n).fill(7).buffer
const runFile = (talk, id) => JSON.parse(readFileSync(join(vault, '_PRESENTATIONS', talk, `${id}.json`), 'utf8'))
const waitFor = async (fn, ms = 3000) => { const end = performance.now() + ms; while (performance.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)) } return false }

// Session ids are stamped to the second; this file opens many in a second. Each Date.now() call
// moves the clock a second on, so every stream gets its own id.
let fakeNow = Date.parse('2026-10-01T12:00:00Z')
Date.now = () => (fakeNow += 1000)
const main = launchMain()
const call = (name, wc, payload) => main.handlers.get(name)({ sender: wc }, payload)

await check('save: a streamed recording that lost its input writes segments, gaps and audio length into the Run', async () => {
  const wc = sender(11)
  const open = await call('recording:stream-open', wc, { talkSlug: 'workshop', talkTitle: 'Workshop', startedAt: '2026-10-01T12:00:00.000Z' })
  assert.equal(open.ok, true)
  const id = open.sessionId
  assert.deepEqual(await call('recording:stream-segment', wc, { sessionId: id, index: 0, startMs: 0 }), { ok: true })
  for (let i = 0; i < 34; i++) assert.deepEqual(await call('recording:stream-append', wc, { sessionId: id, index: 0, bytes: chunk(1000) }), { ok: true })
  await call('recording:stream-segment-end', wc, { sessionId: id, index: 0, endMs: 34_000 })
  await call('recording:stream-segment', wc, { sessionId: id, index: 1, startMs: 40_000 })
  for (let i = 0; i < 60; i++) await call('recording:stream-append', wc, { sessionId: id, index: 1, bytes: chunk(500) })
  const gaps = [{ startMs: 34_000, endMs: 40_000, reason: 'track-ended' }]
  const res = await call('recording:save', wc, {
    talkSlug: 'workshop', talkTitle: 'Workshop', startedAt: '2026-10-01T12:00:00.000Z', mode: 'recording', kind: 'delivery', force: true,
    rawMarks: [{ event: 'enter', slideId: 'one', tMs: 0 }, { event: 'stop', tMs: 100_000 }],
    stream: { sessionId: id, tail: [{ index: 1, bytes: chunk(200) }] },
    audioTimeline: { segments: [{ index: 0, startMs: 0, endMs: 34_000 }, { index: 1, startMs: 40_000, endMs: 100_000 }], gaps, audioMs: 94_000 }
  })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.sessionId, id, 'the Run takes the stream session id')
  const run = runFile('workshop', id)
  assert.equal(run.recordingMs, 100_000)
  assert.equal(run.audio.audioMs, 94_000)
  assert.equal(run.audio.bytes, 34_000 + 30_200)
  assert.deepEqual(run.audio.segments, [
    { file: `${id}.webm`, bytes: 34_000, startMs: 0, endMs: 34_000 },
    { file: `${id}.seg-2.webm`, bytes: 30_200, startMs: 40_000, endMs: 100_000 }
  ])
  assert.deepEqual(run.audio.gaps, gaps)
  assert.equal(run.audio.partial, undefined)
  assert.equal(runAudioSummary(run).label, 'Audio 1 min 34 s of 1 min 40 s · 1 gap')
  assert.equal(existsSync(join(userData, 'recordings', `${id}.recording.json`)), false, 'the in-progress marker is gone once the Run is written')
  assert.equal(statSync(join(userData, 'recordings', `${id}.webm`)).size, 34_000)
})

await check('segment open refused once, then a failed save: no audio lost, the retry saves it once', async () => {
  const wc = sender(21)
  const { sessionId: id } = await call('recording:stream-open', wc, { talkSlug: 'refused' })
  await call('recording:stream-segment', wc, { sessionId: id, index: 0, startMs: 0 })
  await call('recording:stream-append', wc, { sessionId: id, index: 0, bytes: chunk(100) })
  await call('recording:stream-segment-end', wc, { sessionId: id, index: 0, endMs: 10_000 })
  const blocker = join(userData, 'recordings', `${id}.seg-2.webm`)
  mkdirSync(blocker)
  assert.equal((await call('recording:stream-segment', wc, { sessionId: id, index: 1, startMs: 12_000 })).ok, false)
  const payload = {
    talkSlug: 'refused', mode: 'recording', kind: 'delivery', force: true, rawMarks: [{ event: 'stop', tMs: 30_000 }],
    // The bridge kept every chunk of the refused segment and hands them over with the save.
    stream: { sessionId: id, tail: [{ index: 1, bytes: chunk(70) }, { index: 1, bytes: chunk(30) }] },
    audioTimeline: { segments: [{ index: 0, startMs: 0, endMs: 10_000 }, { index: 1, startMs: 12_000, endMs: 30_000 }], gaps: [{ startMs: 10_000, endMs: 12_000, reason: 'track-ended' }] }
  }
  const failed = await call('recording:save', wc, payload)
  assert.equal(failed.ok, false, 'the path is still blocked: the save says so instead of dropping the chunks')
  assert.equal(existsSync(join(vault, '_PRESENTATIONS', 'refused', `${id}.json`)), false)
  rmSync(blocker, { recursive: true })
  const saved = await call('recording:save', wc, payload)
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const run = runFile('refused', id)
  assert.equal(run.audio.bytes, 200, 'every byte, once')
  assert.deepEqual(run.audio.segments.map((seg) => [seg.file, seg.bytes, seg.startMs, seg.endMs]), [[`${id}.webm`, 100, 0, 10_000], [`${id}.seg-2.webm`, 100, 12_000, 30_000]])
})

await check('save fails at held chunk k, then "Save audio elsewhere": each chunk exactly once', async () => {
  const wc = sender(24)
  const { sessionId: id } = await call('recording:stream-open', wc, { talkSlug: 'export-talk' })
  await call('recording:stream-segment', wc, { sessionId: id, index: 0, startMs: 0 })
  await call('recording:stream-append', wc, { sessionId: id, index: 0, bytes: Buffer.from('D0;') })
  await call('recording:stream-segment-end', wc, { sessionId: id, index: 0, endMs: 5000 })
  const blocker = join(userData, 'recordings', `${id}.seg-2.webm`)
  mkdirSync(blocker)
  const parts = [{ index: 0, bytes: Buffer.from('A0;') }, { index: 1, bytes: Buffer.from('B1;') }, { index: 1, bytes: Buffer.from('C1;') }]
  const failed = await call('recording:save', wc, { talkSlug: 'export-talk', mode: 'recording', force: true, rawMarks: [{ event: 'stop', tMs: 9000 }], stream: { sessionId: id, tail: parts } })
  assert.equal(failed.ok, false, 'held chunk 1 cannot be written')
  assert.equal(readFileSync(join(userData, 'recordings', `${id}.webm`), 'utf8'), 'D0;A0;', 'chunk 0 already reached the disk')
  rmSync(blocker, { recursive: true })
  globalThis.__exportDir = join(scratch, 'exported')
  mkdirSync(globalThis.__exportDir)
  assert.deepEqual(await call('recording:export-held-audio', sender(25), { sessionId: id, talkSlug: 'export-talk', parts }), { ok: false, error: 'not-owner' }, 'another window cannot export it')
  const res = await call('recording:export-held-audio', wc, { sessionId: id, talkSlug: 'export-talk', parts })
  assert.equal(res.ok, true, JSON.stringify(res))
  const read = (n) => readFileSync(join(globalThis.__exportDir, `export-talk audio part ${n}.webm`), 'utf8')
  assert.equal(read(1), 'D0;A0;', 'segment 1: the disk file, without A0 a second time')
  assert.equal(read(2), 'B1;C1;', 'segment 2: the chunks that never reached the disk')
  // Retry still works after the export, and writes each chunk once.
  const saved = await call('recording:save', wc, { talkSlug: 'export-talk', mode: 'recording', force: true, rawMarks: [{ event: 'stop', tMs: 9000 }], stream: { sessionId: id, tail: parts } })
  assert.equal(saved.ok, true)
  assert.equal(runFile('export-talk', id).audio.bytes, 12, 'D0;A0; + B1;C1;, nothing twice')
})

await check('Run segment times are matched by index: a segment with no file does not shift the next', async () => {
  const wc = sender(22)
  const { sessionId: id } = await call('recording:stream-open', wc, { talkSlug: 'skipped' })
  await call('recording:stream-segment', wc, { sessionId: id, index: 0, startMs: 0 })
  await call('recording:stream-append', wc, { sessionId: id, index: 0, bytes: chunk(10) })
  await call('recording:stream-segment', wc, { sessionId: id, index: 1, startMs: 5000 })
  // Segment 1 recorded nothing (lost again at once); segment 2 carries on.
  await call('recording:stream-segment', wc, { sessionId: id, index: 2, startMs: 9000 })
  await call('recording:stream-append', wc, { sessionId: id, index: 2, bytes: chunk(20) })
  rmSync(join(userData, 'recordings', `${id}.seg-2.webm`))
  const res = await call('recording:save', wc, {
    talkSlug: 'skipped', mode: 'recording', force: true, rawMarks: [{ event: 'stop', tMs: 20_000 }], stream: { sessionId: id, tail: [] },
    audioTimeline: { segments: [{ index: 0, startMs: 0, endMs: 4000 }, { index: 1, startMs: 5000, endMs: 5000 }, { index: 2, startMs: 9000, endMs: 20_000 }], gaps: [] }
  })
  assert.equal(res.ok, true)
  assert.deepEqual(runFile('skipped', id).audio.segments.map((seg) => [seg.file, seg.startMs, seg.endMs]), [[`${id}.webm`, 0, 4000], [`${id}.seg-3.webm`, 9000, 20_000]])
})

await check('stream-open refuses an unsafe talk slug, so it never leaves a marker recovery cannot turn into a Run', async () => {
  for (const slug of ['../x', 'a/b', '.hidden', ' padded', '']) {
    const res = await call('recording:stream-open', sender(23), { talkSlug: slug })
    assert.equal(res.ok, false, `refused ${JSON.stringify(slug)}`)
  }
})

await check('save refuses a stream another window opened', async () => {
  const owner = sender(12)
  const other = sender(13)
  const { sessionId } = await call('recording:stream-open', owner, { talkSlug: 'workshop' })
  await call('recording:stream-segment', owner, { sessionId, index: 0, startMs: 0 })
  assert.equal((await call('recording:stream-append', other, { sessionId, index: 0, bytes: chunk(10) })).ok, false)
  const res = await call('recording:save', other, { talkSlug: 'workshop', mode: 'recording', force: true, rawMarks: [{ event: 'stop', tMs: 30_000 }], stream: { sessionId } })
  assert.equal(res.ok, false)
  assert.equal(existsSync(join(vault, '_PRESENTATIONS', 'workshop', `${sessionId}.json`)), false)
  owner.emit('destroyed')
})

await check('window lost mid-recording: a partial Run referencing the audio is written at once', async () => {
  const wc = sender(14)
  const { sessionId } = await call('recording:stream-open', wc, { talkSlug: 'crash-talk', talkTitle: 'Crash', startedAt: '2026-10-01T13:00:00.000Z' })
  await call('recording:stream-segment', wc, { sessionId, index: 0, startMs: 0 })
  for (let i = 0; i < 20; i++) await call('recording:stream-append', wc, { sessionId, index: 0, bytes: chunk(100) })
  await call('recording:stream-checkpoint', wc, { sessionId, recordingMs: 20_000, rawMarks: [{ event: 'enter', slideId: 'one', tMs: 0 }, { event: 'enter', slideId: 'two', tMs: 12_000 }] })
  wc.emit('render-process-gone')
  assert.ok(await waitFor(() => existsSync(join(vault, '_PRESENTATIONS', 'crash-talk', `${sessionId}.json`))), 'Run written')
  const run = runFile('crash-talk', sessionId)
  assert.equal(run.audio.partial, true)
  assert.deepEqual(run.audio.segments, [{ file: `${sessionId}.webm`, bytes: 2000, startMs: 0, endMs: 20_000 }])
  assert.equal(run.recordingMs, 20_000)
  assert.deepEqual(run.slideTimeIndex.map((m) => m.slideId), ['one', 'two'], 'slide timings from the last checkpoint')
  assert.equal(statSync(join(userData, 'recordings', `${sessionId}.webm`)).size, 2000, 'audio kept')
  assert.equal(runAudioSummary(run).label, 'Audio 20 s of 20 s · recording interrupted')
})

await check('crash: the next launch recovers the recording as a partial Run; the audio is never deleted', async () => {
  const wc = sender(15)
  const { sessionId } = await call('recording:stream-open', wc, { talkSlug: 'relaunch-talk', talkTitle: 'Relaunch' })
  await call('recording:stream-segment', wc, { sessionId, index: 0, startMs: 0 })
  for (let i = 0; i < 5; i++) await call('recording:stream-append', wc, { sessionId, index: 0, bytes: chunk(300) })
  await call('recording:stream-checkpoint', wc, { sessionId, recordingMs: 5000, rawMarks: [] })
  // The process dies here: no Stop, no window event. Launch a fresh main process.
  const next = launchMain()
  assert.equal(await next.recover(), 1)
  const run = runFile('relaunch-talk', sessionId)
  assert.equal(run.audio.partial, true)
  assert.equal(run.audio.bytes, 1500)
  assert.equal(statSync(join(userData, 'recordings', `${sessionId}.webm`)).size, 1500)
  assert.equal(await next.recover(), 0, 'a recovered recording is not recovered twice')
  assert.deepEqual(next.trashed, [], 'recovery moves nothing to the Trash')
})

await check('discard: a kept-short recording the presenter discards goes to the Trash, not deleted', async () => {
  const wc = sender(16)
  const { sessionId } = await call('recording:stream-open', wc, { talkSlug: 'short' })
  await call('recording:stream-segment', wc, { sessionId, index: 0, startMs: 0 })
  await call('recording:stream-append', wc, { sessionId, index: 0, bytes: chunk(10) })
  assert.deepEqual(await call('recording:stream-discard', wc, { sessionId }), { ok: true })
  assert.deepEqual(main.trashed, [join(userData, 'recordings', `${sessionId}.webm`)])
  assert.equal(existsSync(join(userData, 'recordings', `${sessionId}.recording.json`)), false)
})

rmSync(scratch, { recursive: true, force: true })
if (failures) {
  console.error(`\n${failures} run-audio check(s) failed`)
  process.exit(1)
}
console.log('\nrun-audio: all checks passed')
