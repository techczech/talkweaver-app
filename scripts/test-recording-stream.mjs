// The recording chunk writer (src/main/recording-stream.ts): audio reaches the disk as it is
// recorded. Seams: append (bytes land in order, in the segment file, at once); finalise (segments
// with sizes and times, idempotent, late chunks appended once); partial-file survival (a recording
// that never reaches Stop is found again by a fresh writer — a relaunch — with its audio intact,
// and nothing deletes it); one writer (another window cannot append); containment (unsafe ids, a
// recordings folder linked elsewhere and a link planted at a segment path are refused, and the
// tree outside userData is untouched). Plus the transcription join of several segments
// (transcode-args.ts) run through the real ffmpeg when one is installed.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRecordingStreams, segmentsFromManifest } from '../src/main/recording-stream.ts'
import { existingSegmentPaths, localSegmentPath, streamMarkerPath } from '../src/main/recording-paths.ts'
import { silencesBetween, transcodeArgs } from '../src/main/transcode-args.ts'
import { recordedInk } from '../src/preload/recorder-ink.ts'

const scratch = mkdtempSync(join(tmpdir(), 'talkweaver-recording-stream-'))
let failures = 0
async function check(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`) } catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.stack?.split('\n').slice(0, 2).join('\n       ')}`) }
}
const bytes = (text) => new Uint8Array(Buffer.from(text))
const listTree = (dir) => {
  const out = []
  const walk = (d) => { for (const name of readdirSync(d)) { const p = join(d, name); out.push(p); try { if (statSync(p).isDirectory()) walk(p) } catch {} } }
  walk(dir)
  return out.sort()
}
let n = 0
function fresh() {
  const root = join(scratch, `case-${++n}`)
  const userData = join(root, 'userData')
  mkdirSync(userData, { recursive: true })
  return { root, userData, store: createRecordingStreams({ userDataDir: () => userData, fsyncEveryMs: 0 }) }
}
const OWNER = 7
// Occupy a segment's own name and every replacement name, so no file can be created for it.
const blockSegment = (dir, id, n) => {
  const paths = [join(dir, `${id}.seg-${n}.webm`), ...Array.from({ length: 9 }, (_, k) => join(dir, `${id}.seg-${n}.r${k + 1}.webm`))]
  for (const p of paths) mkdirSync(p)
  return () => { for (const p of paths) rmSync(p, { recursive: true }) }
}

await check('append: each chunk is on disk in order as soon as it is appended', () => {
  const { userData, store } = fresh()
  assert.deepEqual(store.open(OWNER, { sessionId: 'sess-a', talkSlug: 'talk' }), { ok: true, sessionId: 'sess-a' })
  assert.equal(store.startSegment(OWNER, 'sess-a', 0, 0).ok, true)
  const file = join(userData, 'recordings', 'sess-a.webm')
  for (let i = 0; i < 5; i++) {
    assert.equal(store.append(OWNER, 'sess-a', 0, bytes(`chunk${i};`)).ok, true)
    // Read back while the recording is still open: what was appended is already there.
    assert.equal(readFileSync(file, 'utf8'), Array.from({ length: i + 1 }, (_, k) => `chunk${k};`).join(''))
  }
  assert.ok(existsSync(join(userData, 'recordings', 'sess-a.recording.json')), 'the in-progress marker exists while recording')
})

await check('segments: a reacquired input writes a second file; finalise reports both with sizes and times', () => {
  const { userData, store } = fresh()
  store.open(OWNER, { sessionId: 'sess-b', talkSlug: 'talk', talkTitle: 'Talk' })
  store.startSegment(OWNER, 'sess-b', 0, 0)
  store.append(OWNER, 'sess-b', 0, bytes('aaaa'))
  store.endSegment(OWNER, 'sess-b', 0, 34_000)
  assert.equal(store.append(OWNER, 'sess-b', 0, bytes('late')).ok, false, 'a closed segment takes no more appends')
  store.startSegment(OWNER, 'sess-b', 1, 40_000)
  assert.equal(store.startSegment(OWNER, 'sess-b', 0, 41_000).ok, false, 'segments only go forward')
  store.append(OWNER, 'sess-b', 1, bytes('bbbbbb'))
  const fin = store.finalise(OWNER, 'sess-b', { recordingMs: 100_000, gaps: [{ startMs: 34_000, endMs: 40_000, reason: 'track-ended' }] }, [{ index: 1, bytes: bytes('cc') }])
  assert.equal(fin.ok, true)
  assert.deepEqual(fin.segments, [
    { file: 'sess-b.webm', bytes: 4, startMs: 0, endMs: 34_000 },
    { file: 'sess-b.seg-2.webm', bytes: 8, startMs: 40_000, endMs: 100_000 }
  ])
  assert.equal(fin.bytes, 12)
  assert.equal(readFileSync(join(userData, 'recordings', 'sess-b.seg-2.webm'), 'utf8'), 'bbbbbbcc', 'late chunks go to the end of their segment')
  const again = store.finalise(OWNER, 'sess-b', undefined, [{ index: 1, bytes: bytes('cc') }])
  assert.equal(again.bytes, 12, 'a retried save finalises again without appending the late chunks twice')
  assert.deepEqual(existingSegmentPaths(userData, 'sess-b').map((p) => p.split('/').pop()), ['sess-b.webm', 'sess-b.seg-2.webm'])
  store.complete('sess-b')
  assert.equal(existsSync(join(userData, 'recordings', 'sess-b.recording.json')), false, 'complete drops the marker')
  assert.equal(existsSync(join(userData, 'recordings', 'sess-b.webm')), true, '…and keeps the audio')
})

await check('partial-file survival: no Stop, then a relaunch finds the recording with its audio and marks', () => {
  const { userData, store } = fresh()
  store.open(OWNER, { sessionId: 'sess-c', talkSlug: 'workshop', talkTitle: 'Workshop', startedAt: '2026-10-01T12:00:00.000Z' })
  // Segment 0 carries when the recorder really started (after mic permission and opening).
  store.startSegment(OWNER, 'sess-c', 0, 0, '2026-10-01T12:00:01.250Z')
  for (let i = 0; i < 34; i++) store.append(OWNER, 'sess-c', 0, bytes('x'.repeat(100)))
  store.checkpoint(OWNER, 'sess-c', { recordingMs: 34_000, rawMarks: [{ event: 'enter', slideId: 'one', tMs: 0 }] })
  // The open session is not "interrupted" while its writer still has it.
  assert.equal(store.listInterrupted().length, 0)
  // Crash: the process dies with the file open. A new writer is what the next launch creates.
  const relaunch = createRecordingStreams({ userDataDir: () => userData })
  const found = relaunch.listInterrupted()
  assert.equal(found.length, 1)
  assert.equal(found[0].manifest.sessionId, 'sess-c')
  assert.equal(found[0].manifest.talkSlug, 'workshop')
  assert.equal(found[0].manifest.startedAt, '2026-10-01T12:00:01.250Z', 'the recovered Run starts when the recorder started')
  assert.deepEqual(found[0].manifest.rawMarks, [{ event: 'enter', slideId: 'one', tMs: 0 }])
  assert.deepEqual(found[0].segments, [{ file: 'sess-c.webm', bytes: 3400, startMs: 0, endMs: 34_000 }], 'the open segment ends at the last checkpoint')
  assert.equal(statSync(join(userData, 'recordings', 'sess-c.webm')).size, 3400, 'every appended byte survived')
  relaunch.complete('sess-c')
  assert.equal(relaunch.listInterrupted().length, 0)
  assert.equal(statSync(join(userData, 'recordings', 'sess-c.webm')).size, 3400, 'recovery never deletes audio')
})

await check('a window that goes mid-recording leaves its session interrupted (closeOwner)', () => {
  const { store } = fresh()
  store.open(OWNER, { sessionId: 'sess-d', talkSlug: 'talk' })
  store.startSegment(OWNER, 'sess-d', 0, 0)
  store.append(OWNER, 'sess-d', 0, bytes('abc'))
  assert.deepEqual(store.closeOwner(99), [], 'another window closing touches nothing')
  assert.deepEqual(store.closeOwner(OWNER), ['sess-d'])
  assert.deepEqual(store.listInterrupted().map((f) => [f.manifest.sessionId, f.bytes]), [['sess-d', 3]])
})

await check('a new stream never takes an id in use: existing audio, marker or Run refuses the open, and a segment file already there is never appended to', () => {
  const { userData, store } = fresh()
  const rec = join(userData, 'recordings')
  mkdirSync(rec, { recursive: true })
  writeFileSync(join(rec, 'sess-old.webm'), 'earlier')
  assert.deepEqual(store.open(OWNER, { sessionId: 'sess-old', talkSlug: 'talk' }), { ok: false, error: 'id-taken' })
  assert.equal(existsSync(join(rec, 'sess-old.recording.json')), false, 'no marker is written for a taken id')
  writeFileSync(join(rec, 'sess-run.json'), '{}')
  assert.equal(store.open(OWNER, { sessionId: 'sess-run', talkSlug: 'talk' }).error, 'id-taken', 'a no-vault Run takes the id')
  writeFileSync(join(rec, 'sess-mark.recording.json'), '{"keep":true}')
  assert.equal(store.open(OWNER, { sessionId: 'sess-mark', talkSlug: 'talk' }).error, 'id-taken', 'an interrupted marker takes the id')
  assert.equal(readFileSync(join(rec, 'sess-mark.recording.json'), 'utf8'), '{"keep":true}')
  // A free id opens; a file that appears at a later segment's path is refused, never appended to.
  assert.equal(store.open(OWNER, { sessionId: 'sess-new', talkSlug: 'talk' }).ok, true)
  writeFileSync(join(rec, 'sess-new.seg-2.webm'), 'other')
  assert.equal(store.startSegment(OWNER, 'sess-new', 1, 0).ok, false)
  assert.equal(readFileSync(join(rec, 'sess-new.seg-2.webm'), 'utf8'), 'other')
  assert.equal(readFileSync(join(rec, 'sess-old.webm'), 'utf8'), 'earlier', 'the earlier audio is untouched')
})

await check('segment open refused once: later segments still open, and finalise writes the held chunks — no audio lost', () => {
  const { userData, store } = fresh()
  store.open(OWNER, { sessionId: 'sess-j', talkSlug: 'talk' })
  store.startSegment(OWNER, 'sess-j', 0, 0)
  store.append(OWNER, 'sess-j', 0, bytes('AAAA'))
  store.endSegment(OWNER, 'sess-j', 0, 10_000)
  // Something occupies segment 1's path (a folder here; disk full or a permission error in life).
  const blocker = join(userData, 'recordings', 'sess-j.seg-2.webm')
  mkdirSync(blocker)
  assert.equal(store.startSegment(OWNER, 'sess-j', 1, 12_000).ok, false, 'the open is refused')
  rmSync(blocker, { recursive: true })
  // The renderer kept segment 1's chunks; the next segment opens in spite of the skipped index.
  assert.equal(store.startSegment(OWNER, 'sess-j', 2, 20_000).ok, true)
  store.append(OWNER, 'sess-j', 2, bytes('CCC'))
  const fin = store.finalise(OWNER, 'sess-j', { recordingMs: 30_000, segments: [{ index: 0, startMs: 0, endMs: 10_000 }, { index: 1, startMs: 12_000, endMs: 18_000 }, { index: 2, startMs: 20_000, endMs: 30_000 }] },
    [{ index: 1, bytes: bytes('BB') }, { index: 1, bytes: bytes('bb') }])
  assert.equal(fin.ok, true, JSON.stringify(fin))
  assert.deepEqual(fin.segments, [
    { file: 'sess-j.webm', bytes: 4, startMs: 0, endMs: 10_000 },
    { file: 'sess-j.seg-2.webm', bytes: 4, startMs: 12_000, endMs: 18_000 },
    { file: 'sess-j.seg-3.webm', bytes: 3, startMs: 20_000, endMs: 30_000 }
  ])
  assert.equal(readFileSync(join(userData, 'recordings', 'sess-j.seg-2.webm'), 'utf8'), 'BBbb')
  assert.deepEqual(existingSegmentPaths(userData, 'sess-j').map((p) => p.split('/').pop()), ['sess-j.webm', 'sess-j.seg-2.webm', 'sess-j.seg-3.webm'])
})

await check('a refused segment is never appended to at finalise: its chunks go to a fresh file of its own, the other file stays byte-identical', () => {
  const { userData, store } = fresh()
  const rec = join(userData, 'recordings')
  assert.equal(store.open(OWNER, { sessionId: 'sess-p', talkSlug: 'talk' }).ok, true)
  assert.equal(store.startSegment(OWNER, 'sess-p', 0, 0).ok, true)
  store.append(OWNER, 'sess-p', 0, bytes('FIRST;'))
  store.endSegment(OWNER, 'sess-p', 0, 10_000)
  // Another file appears at segment 1's path after the open; the segment open is refused.
  const planted = join(rec, 'sess-p.seg-2.webm')
  const plantedBytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x4f, 0x4c, 0x44])
  writeFileSync(planted, plantedBytes)
  const before = statSync(planted)
  assert.equal(store.startSegment(OWNER, 'sess-p', 1, 12_000).ok, false)
  const fin = store.finalise(OWNER, 'sess-p', { recordingMs: 30_000, segments: [{ index: 0, startMs: 0, endMs: 10_000 }, { index: 1, startMs: 12_000, endMs: 30_000 }] },
    [{ index: 1, bytes: bytes('NEW-1;') }, { index: 1, bytes: bytes('NEW-2;') }])
  assert.equal(fin.ok, true, JSON.stringify(fin))
  assert.ok(readFileSync(planted).equals(plantedBytes), 'the other file is byte-identical')
  assert.equal(statSync(planted).mtimeMs, before.mtimeMs, 'and never written to')
  assert.equal(readFileSync(join(rec, 'sess-p.seg-2.r1.webm'), 'utf8'), 'NEW-1;NEW-2;', 'the new audio is complete in its own file')
  assert.deepEqual(fin.segments, [
    { file: 'sess-p.webm', bytes: 6, startMs: 0, endMs: 10_000 },
    { file: 'sess-p.seg-2.r1.webm', bytes: 12, startMs: 12_000, endMs: 30_000 }
  ])
  const owned = ['sess-p.webm', 'sess-p.seg-2.r1.webm']
  assert.deepEqual(fin.manifest.segments.map((seg) => seg.file), owned, 'the manifest lists only files the stream created')
  const marker = JSON.parse(readFileSync(join(rec, 'sess-p.recording.json'), 'utf8'))
  assert.deepEqual(marker.segments.map((seg) => seg.file), owned, 'so does the marker on disk')
  assert.deepEqual(store.ownedSegments(OWNER, 'sess-p').map((f) => f.path), owned.map((f) => join(rec, f)), 'the export reads only these')
  assert.equal(store.ownedSegments(8, 'sess-p'), null, 'another window gets nothing')
  // A relaunch recovers the same files from the marker, never the other one.
  store.closeOwner(OWNER)
  const later = createRecordingStreams({ userDataDir: () => userData })
  assert.deepEqual(later.listInterrupted().map((f) => f.segments.map((seg) => [seg.file, seg.bytes])), [[['sess-p.webm', 6], ['sess-p.seg-2.r1.webm', 12]]])
  assert.ok(readFileSync(planted).equals(plantedBytes))
})

await check('a segment file replaced after it was written is not appended to: the held chunks go to a fresh file', () => {
  const { userData, store } = fresh()
  const rec = join(userData, 'recordings')
  store.open(OWNER, { sessionId: 'sess-q', talkSlug: 'talk' })
  store.startSegment(OWNER, 'sess-q', 0, 0)
  store.append(OWNER, 'sess-q', 0, bytes('MINE;'))
  store.endSegment(OWNER, 'sess-q', 0, 5000)
  // Our file is moved away and another put in its place (a different file at the same name).
  rmSync(join(rec, 'sess-q.webm'))
  writeFileSync(join(rec, 'sess-q.webm'), 'THEIRS')
  const fin = store.finalise(OWNER, 'sess-q', { recordingMs: 9000 }, [{ index: 0, bytes: bytes('late;') }])
  assert.equal(fin.ok, true, JSON.stringify(fin))
  assert.equal(readFileSync(join(rec, 'sess-q.webm'), 'utf8'), 'THEIRS', 'the replacement is untouched')
  assert.equal(readFileSync(join(rec, 'sess-q.seg-1.r1.webm'), 'utf8'), 'late;')
  assert.deepEqual(fin.segments.map((seg) => seg.file), ['sess-q.seg-1.r1.webm'])
  assert.deepEqual(store.discard(OWNER, 'sess-q').files, [join(rec, 'sess-q.seg-1.r1.webm')], 'discard offers only its own file for the Trash')
  // Replaced with nothing held for it: the segment is left out of the result, never named.
  const other = fresh()
  const rec2 = join(other.userData, 'recordings')
  other.store.open(OWNER, { sessionId: 'sess-r', talkSlug: 'talk' })
  other.store.startSegment(OWNER, 'sess-r', 0, 0)
  other.store.append(OWNER, 'sess-r', 0, bytes('A;'))
  other.store.startSegment(OWNER, 'sess-r', 1, 3000)
  other.store.append(OWNER, 'sess-r', 1, bytes('B;'))
  rmSync(join(rec2, 'sess-r.webm'))
  writeFileSync(join(rec2, 'sess-r.webm'), 'THEIRS')
  const fin2 = other.store.finalise(OWNER, 'sess-r', { recordingMs: 6000 }, [])
  assert.deepEqual(fin2.segments.map((seg) => seg.file), ['sess-r.seg-2.webm'])
})

await check('finalise never drops a held chunk: a failure is an error, and the retry resumes without duplicating', () => {
  const { userData, store } = fresh()
  store.open(OWNER, { sessionId: 'sess-k', talkSlug: 'talk' })
  store.startSegment(OWNER, 'sess-k', 0, 0)
  store.append(OWNER, 'sess-k', 0, bytes('on-disk;'))
  const unblock = blockSegment(join(userData, 'recordings'), 'sess-k', 2)
  const tail = [{ index: 0, bytes: bytes('late0;') }, { index: 1, bytes: bytes('one;') }, { index: 1, bytes: bytes('two;') }]
  const first = store.finalise(OWNER, 'sess-k', { recordingMs: 9000 }, tail)
  assert.equal(first.ok, false, 'the save must not report success with chunks unwritten')
  assert.equal(readFileSync(join(userData, 'recordings', 'sess-k.webm'), 'utf8'), 'on-disk;late0;')
  unblock()
  const retry = store.finalise(OWNER, 'sess-k', { recordingMs: 9000 }, tail)
  assert.equal(retry.ok, true)
  assert.equal(readFileSync(join(userData, 'recordings', 'sess-k.webm'), 'utf8'), 'on-disk;late0;', 'segment 0 tail not written twice')
  assert.equal(readFileSync(join(userData, 'recordings', 'sess-k.seg-2.webm'), 'utf8'), 'one;two;')
  assert.equal(store.finalise(OWNER, 'sess-k', undefined, tail).bytes, 22, 'a third finalise adds nothing')
  assert.equal(store.finalise(OWNER, 'sess-k', undefined, [{ index: 'x', bytes: bytes('?') }, ...tail]).ok, true, 'already-written chunks are not re-read')
})

await check('one writer: another window cannot append, finalise or discard', () => {
  const { store } = fresh()
  store.open(OWNER, { sessionId: 'sess-e', talkSlug: 'talk' })
  store.startSegment(OWNER, 'sess-e', 0, 0)
  assert.deepEqual(store.append(8, 'sess-e', 0, bytes('x')), { ok: false, error: 'not-owner' })
  assert.deepEqual(store.finalise(8, 'sess-e'), { ok: false, error: 'not-owner' })
  assert.deepEqual(store.discard(8, 'sess-e'), { ok: false, error: 'not-owner' })
  assert.deepEqual(store.open(8, { sessionId: 'sess-e', talkSlug: 'talk' }), { ok: false, error: 'already-open' })
})

await check('discard: returns the files for the Trash and drops the marker, deleting nothing itself', () => {
  const { userData, store } = fresh()
  store.open(OWNER, { sessionId: 'sess-f', talkSlug: 'talk' })
  store.startSegment(OWNER, 'sess-f', 0, 0)
  store.append(OWNER, 'sess-f', 0, bytes('short'))
  const res = store.discard(OWNER, 'sess-f')
  assert.equal(res.ok, true)
  assert.deepEqual(res.files, [join(userData, 'recordings', 'sess-f.webm')])
  assert.equal(existsSync(res.files[0]), true)
  assert.equal(existsSync(join(userData, 'recordings', 'sess-f.recording.json')), false)
})

await check('containment: unsafe ids are refused and nothing is written outside the recordings folder', () => {
  const { root, userData, store } = fresh()
  const outside = join(root, 'outside')
  mkdirSync(outside)
  const before = listTree(root)
  for (const id of ['../escape', 'a/b', '..', '', '.hidden', 'x'.repeat(200), 'manifest', 42, null]) {
    const res = store.open(OWNER, { sessionId: id, talkSlug: 'talk' })
    assert.equal(res.ok, false, `open refuses ${JSON.stringify(id)}`)
    assert.equal(store.append(OWNER, id, 0, bytes('x')).ok, false)
  }
  for (const index of [-1, 1.5, '0', 1000, NaN]) assert.equal(localSegmentPath(userData, 'sess-g', index).ok, false, `segment index ${index} refused`)
  assert.equal(streamMarkerPath(userData, '../x').ok, false)
  const after = listTree(root).filter((p) => !p.endsWith('/recordings'))
  assert.deepEqual(after, before, 'only the recordings folder itself may appear')
})

await check('containment: a recordings folder linked outside userData is refused', () => {
  const root = join(scratch, 'linked-dir')
  const userData = join(root, 'userData')
  const outside = join(root, 'outside')
  mkdirSync(userData, { recursive: true })
  mkdirSync(outside)
  symlinkSync(outside, join(userData, 'recordings'))
  const store = createRecordingStreams({ userDataDir: () => userData })
  assert.deepEqual(store.open(OWNER, { sessionId: 'sess-h', talkSlug: 'talk' }), { ok: false, error: 'unsafe-path' })
  assert.deepEqual(readdirSync(outside), [], 'nothing written through the link')
  assert.deepEqual(store.listInterrupted(), [])
})

await check('containment: a link planted at the segment path is refused, its target untouched', () => {
  const { root, userData, store } = fresh()
  const victim = join(root, 'victim.txt')
  writeFileSync(victim, 'keep me')
  store.open(OWNER, { sessionId: 'sess-i', talkSlug: 'talk' })
  symlinkSync(victim, join(userData, 'recordings', 'sess-i.webm'))
  const res = store.startSegment(OWNER, 'sess-i', 0, 0)
  assert.equal(res.ok, false)
  assert.equal(store.append(OWNER, 'sess-i', 0, bytes('overwrite')).ok, false)
  assert.equal(readFileSync(victim, 'utf8'), 'keep me')
})

await check('segmentsFromManifest: missing files are skipped; an open segment ends at recordingMs', () => {
  const manifest = { sessionId: 's', recordingMs: 9000, segments: [{ index: 0, startMs: 0, endMs: 4000 }, { index: 1, startMs: 6000, endMs: null }, { index: 2, startMs: 8000, endMs: null }] }
  const segs = segmentsFromManifest(manifest, (i) => (i === 2 ? null : 10))
  assert.deepEqual(segs, [{ file: 's.webm', bytes: 10, startMs: 0, endMs: 4000 }, { file: 's.seg-2.webm', bytes: 10, startMs: 6000, endMs: 9000 }])
})

await check('transcription join: one file is the plain conversion; several get the gaps as silence', () => {
  assert.deepEqual(transcodeArgs(['/r/a.webm'], [0], '/t/o.wav'), ['-y', '-i', '/r/a.webm', '/t/o.wav'])
  assert.deepEqual(silencesBetween([{ startMs: 0, endMs: 34_000 }, { startMs: 40_000, endMs: 50_000 }, { startMs: 50_000, endMs: 60_000 }]), [0, 6000, 0])
  const args = transcodeArgs(['/r/a.webm', '/r/b.webm', '/r/c.webm'], [0, 6000, 0], '/t/o.wav')
  assert.deepEqual(args, ['-y', '-i', '/r/a.webm', '-f', 'lavfi', '-t', '6.000', '-i', 'anullsrc=r=48000:cl=mono', '-i', '/r/b.webm', '-i', '/r/c.webm',
    '-filter_complex', [0, 1, 2, 3].map((i) => `[${i}:a]aresample=48000,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=mono[n${i}]`).join(';') + ';[n0][n1][n2][n3]concat=n=4:v=0:a=1[a]',
    '-map', '[a]', '/t/o.wav'])
})

const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => existsSync(p))
if (ffmpeg) {
  await check('transcription join through real ffmpeg: 2 s mono + 3 s gap + 1 s stereo WebM/Opus → a 6 s WAV', () => {
    const dir = join(scratch, 'ffmpeg')
    mkdirSync(dir)
    const make = (name, secs, channels) => execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`, '-ac', String(channels), '-c:a', 'libopus', join(dir, name)])
    make('a.webm', 2, 1)
    // The input after the gap is stereo (a headset after the laptop mic): concat must still work.
    make('b.webm', 1, 2)
    const out = join(dir, 'out.wav')
    execFileSync(ffmpeg, ['-loglevel', 'error', ...transcodeArgs([join(dir, 'a.webm'), join(dir, 'b.webm')], [0, 3000], out)])
    // 16-bit PCM WAV: bytes / (rate * channels * 2) = seconds. Read rate and channels from the header.
    const wav = readFileSync(out)
    const channels = wav.readUInt16LE(22)
    const rate = wav.readUInt32LE(24)
    const dataAt = wav.indexOf('data')
    const seconds = wav.readUInt32LE(dataAt + 4) / (rate * channels * 2)
    assert.ok(Math.abs(seconds - 6) < 0.1, `WAV is ${seconds.toFixed(2)} s`)
  })
} else {
  console.log('  skip transcription join through real ffmpeg (no ffmpeg installed)')
}

rmSync(scratch, { recursive: true, force: true })
// The Pen's ink (ticket 08) on its way into a recording: the recorder reads the deck's slot with the
// byte cap, and main checks every ink mark of a checkpoint before the marker is written.
const box = { tool: 'rectangle', ink: 'blue', width: 'thick', points: [[0.1, 0.2], [0.8, 0.9]] }
const longDecimals = (n) => Array.from({ length: n }, (_, i) => [0.1 + i / 10000 + 0.0000123456789012, 0.2 + i / 10000 + 0.0000987654321098])
await check('the recorder reads the ink slot with the byte cap: a 93 KB image layer is refused, a normal one kept', () => {
  const heavy = { slideId: 's', space: 'image', image: 0, strokes: Array.from({ length: 6 }, () => ({ ...box, tool: 'freehand', points: longDecimals(400) })), draft: null }
  const bytesOf = new TextEncoder().encode(JSON.stringify({ type: 'ink.live', ink: heavy })).length
  assert.ok(bytesOf > 88_000 && bytesOf < 100_000, `fixture ${bytesOf} bytes`)
  // Within every count cap (2,400 points): only the byte cap refuses it.
  assert.equal(recordedInk(JSON.stringify(heavy), 's'), null)
  assert.equal(recordedInk(JSON.stringify({ ...heavy, strokes: heavy.strokes.slice(0, 2) }), 's')?.strokes.length, 2, 'a smaller layer of the same strokes is kept')
  assert.deepEqual(recordedInk(JSON.stringify({ slideId: 's', space: 'image', image: 3, strokes: [box], draft: null }), 's'),
    { strokes: [box], layer: { space: 'image', image: 3 } })
  assert.equal(recordedInk(JSON.stringify({ slideId: 's', space: 'slide', strokes: [box], draft: box }), 's'), null, 'a stroke being drawn is not recorded')
  assert.equal(recordedInk(JSON.stringify({ slideId: 'other', space: 'slide', strokes: [], draft: null }), 's'), null)
  assert.equal(recordedInk('{not json', 's'), null)
  assert.equal(recordedInk(' '.repeat(70_000) + '{}', 's'), null)
  // Just over the cap as a message while the slot itself is under it: only the byte cap on the
  // checked message refuses it.
  const enc = (v) => new TextEncoder().encode(JSON.stringify({ type: 'ink.live', ink: v })).length
  const layer = (points, id) => ({ slideId: id, space: 'image', image: 0, strokes: [400, 400, 400, points].map((n) => ({ ...box, tool: 'freehand', points: longDecimals(n) })), draft: null })
  let points = 1
  while (enc(layer(points + 1, 's')) <= 64_000 - 60) points++
  let id = 's'
  while (enc(layer(points, id)) <= 64_000) id += 's'
  const edge = layer(points, id)
  assert.ok(JSON.stringify(edge).length <= 64_000 && enc(edge) > 64_000 && id.length <= 100, `edge: slot ${JSON.stringify(edge).length}, message ${enc(edge)}`)
  assert.equal(recordedInk(JSON.stringify(edge), id), null, 'over the byte cap by a few bytes')
  const under = layer(points, id.slice(0, -30))
  assert.ok(recordedInk(JSON.stringify(under), under.slideId), 'just under it is kept')
})
await check('a checkpoint\'s ink marks are checked before the marker is written: oversized and extra-field marks dropped', () => {
  const { userData, store } = fresh()
  store.open(OWNER, { sessionId: 'sess-ink', talkSlug: 'workshop', talkTitle: 'Workshop', startedAt: '2026-10-09T12:00:00.000Z' })
  store.startSegment(OWNER, 'sess-ink', 0, 0)
  const heavy = Array.from({ length: 6 }, () => ({ ...box, tool: 'freehand', points: longDecimals(400) }))
  store.checkpoint(OWNER, 'sess-ink', { recordingMs: 5000, rawMarks: [
    { event: 'enter', slideId: 's', tMs: 0 },
    { event: 'ink', slideId: 's', tMs: 100, space: 'image', image: 0, ink: [box] },
    { event: 'ink', slideId: 's', tMs: 200, space: 'image', image: 0, ink: heavy },
    { event: 'ink', slideId: 's', tMs: 300, ink: [{ ...box, junk: 'x'.repeat(2_000_000) }] },
    { event: 'ink', slideId: 's', tMs: 400, ink: [box], extra: 1 },
    { event: 'ink', slideId: 's', tMs: 500, ink: [{ ...box, ink: ['red'] }] },
    { event: 'reveal', slideId: 's', hidden: 0, tMs: 600 },
  ] })
  const marker = readFileSync(streamMarkerPath(userData, 'sess-ink').path, 'utf8')
  assert.ok(marker.length < 10_000, `the marker stays small: ${marker.length}`)
  assert.deepEqual(JSON.parse(marker).rawMarks, [
    { event: 'enter', slideId: 's', tMs: 0 },
    { event: 'ink', slideId: 's', tMs: 100, space: 'image', image: 0, ink: [box] },
    { event: 'reveal', slideId: 's', hidden: 0, tMs: 600 },
  ])
  store.complete('sess-ink')
})

if (failures) {
  console.error(`\n${failures} recording-stream check(s) failed`)
  process.exit(1)
}
console.log('\nrecording-stream: all checks passed')
