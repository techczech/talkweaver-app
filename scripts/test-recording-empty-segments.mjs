// Empty recording segments never block transcription or video export (9 Nov 2026 incident).
//
// The Run of 9 Nov: the presenter paused, the microphone was lost and reconnected nine times while
// the clock stood still, leaving nine 0-byte segment files each recorded as start === end, then one
// more good segment. The shared ffmpeg timeline refused the whole Run ("An audio segment has
// invalid recording times.") and transcription and video export both failed. Seams:
//  1. recordingTranscodeArgs over the incident's shape (its real times) skips the nine empty
//     segments and keeps the two that hold audio, each placed at its own start;
//  2. audibleSegmentPaths reads the Run from disk and leaves out 0-byte files and no-span segments,
//     while recordedSegmentPaths still lists every file (delete and the "part missing" check use it);
//  3. ffmpeg accepts the arguments: a scaled-down incident Run becomes one WAV of the full length;
//  4. a Run whose only segments are empty gives the "no audio" message; NaN or a negative start is
//     still refused as invalid times;
//  5. a microphone switch overlaps two segments by a moment (the new input starts before the old one
//     stops): each is placed at its own start and mixed, one WAV of the Run's length.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { recordingTranscodeArgs } from '../src/main/transcode-args.ts'
import { recordingAudioTimeline } from '../src/main/recording-audio-timeline.ts'
import { audibleSegmentPaths, readRecordingSource, recordedSegmentPaths } from '../src/main/recording-paths.ts'
import { audibleSegments } from '../src/shared/recording-clock.ts'

const SID = 'sess-20261109-100440-7wgzbtux'
let count = 0
const pass = (name) => console.log(`ok ${++count}. ${name}`)

// The incident Run's audio.segments, as saved (the real file is never read here).
const file = (n) => (n === 1 ? `${SID}.webm` : `${SID}.seg-${n}.webm`)
const incident = (paused, end) => [
  { n: 1, startMs: 0, endMs: paused },
  ...Array.from({ length: 9 }, (_, i) => ({ n: i + 2, startMs: paused, endMs: paused })),
  { n: 11, startMs: paused, endMs: end }
]

const root = mkdtempSync(join(tmpdir(), 'tw-empty-segments-'))
try {
  // 1. The shape alone, with the incident's own times.
  const real = incident(8523600, 16911877).map((s) => ({ path: `/r/${file(s.n)}`, startMs: s.startMs, endMs: s.endMs }))
  const args = recordingTranscodeArgs(real, 16911877.49999988, '/r/out.wav')
  const inputs = args.filter((_, i) => args[i - 1] === '-i')
  assert.deepEqual(inputs, ['anullsrc=r=48000:cl=mono', `/r/${SID}.webm`, `/r/${SID}.seg-11.webm`], 'only the two segments that hold audio are inputs')
  const graph = args[args.indexOf('-filter_complex') + 1]
  assert.match(graph, /\[1:a\]atrim=duration=8523\.6,.*adelay=0:all=1\[segment0\]/)
  assert.match(graph, /\[2:a\]atrim=duration=8388\.277,.*adelay=8523600:all=1\[segment1\]/)
  assert.match(graph, /amix=inputs=3:duration=first:normalize=0\[recording\]$/)
  assert.ok(!graph.includes('duration=0,'), 'no zero-length trim')
  pass('the incident Run gives a timeline of its two audible segments, each at its own start')

  // 2. From disk: the Run JSON beside the audio (no vault), 0-byte files for the nine reconnects.
  const userData = join(root, 'userData')
  const recordings = join(userData, 'recordings')
  mkdirSync(recordings, { recursive: true })
  const pcm = Buffer.alloc(48000 * 2 / 2) // 0.5 s of 48 kHz mono s16
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * 440 * i / 48000)), i * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(48000, 24); header.writeUInt32LE(96000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
  const wav = Buffer.concat([header, pcm])
  const scaled = incident(500, 1500)
  for (const s of scaled) writeFileSync(join(recordings, file(s.n)), s.startMs === s.endMs ? '' : wav)
  const run = {
    id: SID, talkSlug: 'talk', recordingMs: 1500,
    audio: { segments: scaled.map((s) => ({ file: file(s.n), bytes: s.startMs === s.endMs ? 0 : wav.length, startMs: s.startMs, endMs: s.endMs })) }
  }
  writeFileSync(join(recordings, `${SID}.json`), JSON.stringify(run))
  const source = readRecordingSource(null, userData, 'talk', SID)
  assert.equal(source?.kind, 'run')
  assert.equal(recordedSegmentPaths(userData, SID, source).length, 11, 'every listed file is still the Run\'s (delete, the missing-part check)')
  const audible = await audibleSegmentPaths(userData, SID, source)
  assert.deepEqual(audible.map((s) => s.path), [join(recordings, file(1)), join(recordings, file(11))])
  // A 0-byte file with a real span is left out too (nothing to decode).
  writeFileSync(join(recordings, file(11)), '')
  assert.deepEqual((await audibleSegmentPaths(userData, SID, source)).map((s) => s.path), [join(recordings, file(1))])
  writeFileSync(join(recordings, file(11)), wav)
  pass('audibleSegmentPaths leaves out 0-byte files and no-span segments; recordedSegmentPaths keeps them')

  // 3. ffmpeg accepts the arguments: one WAV the length of the Run.
  const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
  const out = join(root, 'out.wav')
  const converted = spawnSync(ffmpeg, ['-v', 'error', ...recordingTranscodeArgs(audible, 1500, out)], { encoding: 'utf8' })
  assert.equal(converted.status, 0, converted.stderr)
  const bytes = statSync(out).size - 44
  assert.ok(Math.abs(bytes / 96000 - 1.5) < 0.02, `the WAV is ${bytes / 96000} s, not 1.5 s`)
  pass('ffmpeg turns the scaled incident Run into one WAV of the Run\'s length')

  // 5. A switch: segment 2 starts 120 ms before segment 1 ends.
  const overlapping = [{ path: join(recordings, 'a.webm'), startMs: 0, endMs: 820 }, { path: join(recordings, 'b.webm'), startMs: 700, endMs: 1500 }]
  for (const s of overlapping) writeFileSync(s.path, wav)
  const mixGraph = recordingAudioTimeline(overlapping, 1500).filters.join(';')
  assert.match(mixGraph, /adelay=0:all=1\[segment0\]/)
  assert.match(mixGraph, /adelay=700:all=1\[segment1\]/)
  const mixed = join(root, 'mixed.wav')
  const mixRun = spawnSync(ffmpeg, ['-v', 'error', ...recordingTranscodeArgs(overlapping, 1500, mixed)], { encoding: 'utf8' })
  assert.equal(mixRun.status, 0, mixRun.stderr)
  assert.ok(Math.abs((statSync(mixed).size - 44) / 96000 - 1.5) < 0.02)
  pass('overlapping segments (a microphone switch) are each placed at their own start and mixed')

  // 4. Nothing audible, and times that really are invalid.
  const empties = real.slice(1, 10)
  assert.throws(() => recordingAudioTimeline(empties, 16911877), /The local recording has no audio segments\./)
  assert.throws(() => recordingAudioTimeline([...real.slice(0, 1), { path: '/r/x.webm', startMs: Number.NaN, endMs: 10 }], 20), /invalid recording times/)
  assert.throws(() => recordingAudioTimeline([...real.slice(0, 1), { path: '/r/x.webm', startMs: -5, endMs: -5 }], 20), /invalid recording times/)
  assert.deepEqual(audibleSegments([{ startMs: 0, endMs: 0 }, { startMs: 0, endMs: 0 }]).length, 2, 'a legacy 0–0 list is kept whole')
  for (const s of scaled) if (s.n === 1 || s.n === 11) writeFileSync(join(recordings, file(s.n)), '')
  assert.deepEqual((await audibleSegmentPaths(userData, SID, source)), [], 'a Run of empty files hears nothing')
  pass('only empty segments: the no-audio message; NaN or a negative start: still invalid')
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log('recording-empty-segments: all checks passed')
