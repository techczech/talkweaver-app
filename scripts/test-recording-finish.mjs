// Release 0.44.5, the editor's finishing choices (the record-and-edit-video design of 10 Nov 2026, contract
// "look"): even volume and smooth joins, as edits in the sidecar and through real exports. Plain Node;
// ffmpeg-static stands in for the app's bundled ffmpeg.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyEditOp, DEFAULT_FACE, DEFAULT_FINISH, emptyEdits, faceOf, parseEdits, parseEditsText, RECORDING_EDITS_VERSION, serialiseEdits } from '../src/shared/recording-edits.ts'
import { createRecordingEditsStore, olderVersionPath } from '../src/main/recording-edits-store.ts'
import { createEvenVolume, createPlaybackPreparer, createVideoExporter, evenVolumeChain, parseEvenMeasure, resolvePictureLayers } from '../src/main/recording-video.ts'
import { cameraRect, captionCues, chaptersFor, faceAt, faceTrack, keptSpans, placementRects, planRunToEdited, TITLE_BAND_FRACTION, withoutCamera } from '../src/shared/recording-video.ts'
import { createVoiceSplicer, dissolveWindows, JOIN_DISSOLVE_FRAMES, SAMPLES_PER_FRAME, splicedLength, voiceSplicePlan } from '../src/shared/recording-joins.ts'

let count = 0
const pass = (name) => console.log(`PASS ${++count} ${name}`)
const root = mkdtempSync(join(tmpdir(), 'tw-recording-finish-'))
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
const gen = (args) => { const r = spawnSync(ffmpeg, ['-v', 'error', '-y', '-threads', '2', ...args], { timeout: 300_000 }); assert.equal(r.status, 0, r.stderr?.toString()) }
/** Integrated loudness (LUFS) of [from, to) seconds of a file, by ffmpeg's EBU R128 meter. */
const lufs = (file, from, to) => {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-af', `atrim=${from}:${to},ebur128`, '-f', 'null', '-'], { timeout: 120_000 })
  const m = /Integrated loudness:\s+I:\s+(-?[\d.]+|-inf) LUFS/.exec(r.stderr.toString())
  assert.ok(m, r.stderr.toString().slice(-400))
  return Number(m[1])
}
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

try {
  // ---- The finishing choices are edits: stored, undoable, read from older files ------------------
  {
    const D = 60_000
    assert.equal(RECORDING_EDITS_VERSION, 5)
    let e = emptyEdits()
    assert.deepEqual(e.finish, DEFAULT_FINISH)
    assert.deepEqual(DEFAULT_FINISH, { camera: true, evenVolume: true, smoothJoins: true }, 'the design draws every finishing choice on')
    e = applyEditOp(e, { kind: 'cut', ranges: [{ start: 1000, end: 2000 }] }, D)
    const off = applyEditOp(e, { kind: 'finish', finish: { evenVolume: false } }, D)
    assert.equal(off.finish.evenVolume, false); assert.equal(off.undo.length, 2, 'turning even volume off is one undo step'); assert.equal(off.redo.length, 0)
    assert.equal(applyEditOp(off, { kind: 'finish', finish: { evenVolume: false } }, D), off, 'no change is no step')
    const back = applyEditOp(off, { kind: 'undo' }, D)
    assert.equal(back.finish.evenVolume, true, 'undo turns it back on'); assert.deepEqual(back.cuts, e.cuts, 'and leaves the cuts')
    assert.equal(applyEditOp(back, { kind: 'redo' }, D).finish.evenVolume, false, 'redo turns it off again')
    const cam = applyEditOp(e, { kind: 'finish', finish: { camera: false, smoothJoins: false } }, D)
    assert.deepEqual(cam.finish, { camera: false, evenVolume: true, smoothJoins: false }); assert.equal(cam.undo.length, 2, 'two choices at once are one step')
    assert.throws(() => applyEditOp(e, { kind: 'finish', finish: { evenVolume: 'yes' } }, D), /Invalid/)
    // The bytes the store writes read back the same.
    const read = parseEditsText(serialiseEdits(cam), D)
    assert.ok(read.ok); assert.deepEqual(read.edits, cam)
    // Version 4 (release 0.44): finish had the camera only and no history of it.
    const v4 = parseEdits({ version: 4, revision: 3, cuts: [{ start: 0, end: 500 }], boundaries: [], leftOut: [], undo: [{ cuts: [], boundaries: [], leftOut: [] }], redo: [], finish: { camera: false } }, D)
    assert.ok(v4.ok); assert.equal(v4.from, 4)
    assert.deepEqual(v4.edits.finish, { camera: false, evenVolume: true, smoothJoins: true }, 'choices a 0.44 file never made are at their defaults')
    assert.deepEqual(v4.edits.undo[0].finish, v4.edits.finish, 'undoing a 0.44 step keeps the choices as they are')
    assert.equal(applyEditOp(v4.edits, { kind: 'undo' }, D).finish.camera, false)
    // Malformed and newer files are refused, never reset.
    assert.equal(parseEdits({ ...JSON.parse(serialiseEdits(cam)), finish: { evenVolume: 1 } }, D).problem?.kind, 'corrupt')
    const bare = parseEdits({ ...JSON.parse(serialiseEdits(cam)), undo: [{ cuts: [], boundaries: [], leftOut: [] }] }, D)
    assert.ok(bare.ok); assert.deepEqual(bare.edits.undo[0].finish, cam.finish, 'a version 5 step without its choices keeps the document\'s')
    assert.equal(parseEdits({ ...JSON.parse(serialiseEdits(cam)), undo: [{ cuts: [], boundaries: [], leftOut: [], finish: { camera: 'no' } }] }, D).problem?.kind, 'corrupt')
    assert.equal(parseEdits({ ...JSON.parse(serialiseEdits(cam)), version: 6 }, D).problem?.kind, 'newer')
    pass('finishing choices are stored in the edits file, each change one undo step; 0.44 files read with the defaults')
  }

  // ---- The first save over a 0.44 file keeps it once (review item 7) --------------------------------
  {
    const D = 60_000, folder = join(root, 'upgrade'); mkdirSync(folder)
    const path = join(folder, 'sess-up.edits.json')
    const v4 = JSON.stringify({ version: 4, revision: 2, recording: 'fp', cuts: [{ start: 0, end: 500 }], boundaries: [], leftOut: [], undo: [], redo: [], finish: { camera: true } })
    writeFileSync(path, v4)
    const store = createRecordingEditsStore({ locate: () => ({ path, runId: 'sess-up', durationMs: D, fingerprint: 'fp' }) })
    const first = store.apply({}, { kind: 'finish', finish: { evenVolume: false } }, 2)
    const kept = olderVersionPath(path, 'sess-up', 4)
    assert.equal(kept, join(folder, 'sess-up.edits.version-4.json'))
    assert.equal(readFileSync(kept, 'utf8'), v4, 'the version 4 file is kept beside it, byte for byte')
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 5)
    store.apply({}, { kind: 'finish', finish: { evenVolume: true } }, first.edits.revision)
    assert.equal(readFileSync(kept, 'utf8'), v4, 'kept once: later saves never replace it')
    assert.deepEqual(readdirSync(folder).sort(), ['sess-up.edits.json', 'sess-up.edits.version-4.json'], 'no temporary file is left behind')
    // A crash part way through writing the copy leaves only a temporary file: the next save still keeps it whole.
    const folder2 = join(root, 'upgrade-crash'); mkdirSync(folder2)
    const path2 = join(folder2, 'sess-c.edits.json'); writeFileSync(path2, v4)
    writeFileSync(join(folder2, '.sess-c.edits.version-4.0000.tmp'), v4.slice(0, 20))
    createRecordingEditsStore({ locate: () => ({ path: path2, runId: 'sess-c', durationMs: D, fingerprint: 'fp' }) }).apply({}, { kind: 'finish', finish: { evenVolume: false } }, 2)
    assert.equal(readFileSync(join(folder2, 'sess-c.edits.version-4.json'), 'utf8'), v4, 'the kept copy is whole')
    // Keeping the older file is a condition of the save. A volume that refuses hard links still gets a whole copy.
    const noLinks = (code) => () => { throw Object.assign(Error(code), { code }) }
    const folder3 = join(root, 'upgrade-no-links'); mkdirSync(folder3)
    const path3 = join(folder3, 'sess-n.edits.json'); writeFileSync(path3, v4)
    createRecordingEditsStore({ locate: () => ({ path: path3, runId: 'sess-n', durationMs: D, fingerprint: 'fp' }), io: { link: noLinks('ENOTSUP') } }).apply({}, { kind: 'finish', finish: { evenVolume: false } }, 2)
    assert.equal(readFileSync(join(folder3, 'sess-n.edits.version-4.json'), 'utf8'), v4, 'without hard links the version 4 file is still kept, byte for byte')
    assert.equal(JSON.parse(readFileSync(path3, 'utf8')).version, 5)
    assert.deepEqual(readdirSync(folder3).sort(), ['sess-n.edits.json', 'sess-n.edits.version-4.json'])
    // When the copy cannot be made at all, the save is refused and the older file is untouched.
    const folder4 = join(root, 'upgrade-refused'); mkdirSync(folder4)
    const path4 = join(folder4, 'sess-r.edits.json'); writeFileSync(path4, v4)
    mkdirSync(join(folder4, 'sess-r.edits.version-4.json')) // the kept name is taken by a folder
    assert.throws(() => createRecordingEditsStore({ locate: () => ({ path: path4, runId: 'sess-r', durationMs: D, fingerprint: 'fp' }) }).apply({}, { kind: 'finish', finish: { evenVolume: false } }, 2), /could not be kept/)
    assert.equal(readFileSync(path4, 'utf8'), v4, 'a refused save leaves the version 4 file exactly as it was')
    assert.deepEqual(readdirSync(folder4).sort(), ['sess-r.edits.json', 'sess-r.edits.version-4.json'], 'and leaves no temporary file')
    // A kept copy already there (another window got there first) is never replaced, with or without hard links.
    const earlier = JSON.stringify({ version: 4, revision: 1, recording: 'fp', cuts: [], boundaries: [], leftOut: [], undo: [], redo: [], finish: { camera: true } })
    for (const [name, io] of [['kept-first', undefined], ['kept-first-no-links', { link: noLinks('ENOTSUP') }], ['kept-first-raced', { link: noLinks('EEXIST') }]]) {
      const folder5 = join(root, `upgrade-${name}`); mkdirSync(folder5)
      const path5 = join(folder5, 'sess-k.edits.json'); writeFileSync(path5, v4)
      writeFileSync(join(folder5, 'sess-k.edits.version-4.json'), earlier)
      createRecordingEditsStore({ locate: () => ({ path: path5, runId: 'sess-k', durationMs: D, fingerprint: 'fp' }), io }).apply({}, { kind: 'finish', finish: { evenVolume: false } }, 2)
      assert.equal(readFileSync(join(folder5, 'sess-k.edits.version-4.json'), 'utf8'), earlier, `${name}: the copy kept earlier stays`)
      assert.deepEqual(readdirSync(folder5).sort(), ['sess-k.edits.json', 'sess-k.edits.version-4.json'], `${name}: no temporary file`)
    }
    // A kept copy cut short (a crash while it was being written by something else) never stands in for a whole
    // one: the save is refused, the version 4 file is untouched and the partial file is left for the owner.
    for (const partial of [v4.slice(0, 20), '', JSON.stringify({ version: 3 }), JSON.stringify({ version: 4 }), JSON.stringify({ ...JSON.parse(v4), recording: 'another-recording' }), 'not an edits file']) {
      const folder6 = join(root, `upgrade-partial-${createHash('sha1').update(partial).digest('hex').slice(0, 8)}`); mkdirSync(folder6)
      const path6 = join(folder6, 'sess-p.edits.json'); writeFileSync(path6, v4)
      writeFileSync(join(folder6, 'sess-p.edits.version-4.json'), partial)
      assert.throws(() => createRecordingEditsStore({ locate: () => ({ path: path6, runId: 'sess-p', durationMs: D, fingerprint: 'fp' }) }).apply({}, { kind: 'finish', finish: { evenVolume: false } }, 2), /could not be kept.*not a complete copy/)
      assert.equal(readFileSync(path6, 'utf8'), v4)
      assert.equal(readFileSync(join(folder6, 'sess-p.edits.version-4.json'), 'utf8'), partial)
      assert.deepEqual(readdirSync(folder6).sort(), ['sess-p.edits.json', 'sess-p.edits.version-4.json'])
    }
    // Without hard links the copy is created exclusively, so nothing under the kept name is ever replaced.
    // A file another writer puts there at any moment before that creation stops the save and is left as it is:
    // before the link is tried, and again after this save has looked and found the name free.
    const enotsup = () => { throw Object.assign(Error('ENOTSUP'), { code: 'ENOTSUP' }) }
    for (const [name, racing, when] of [['before-link', 'racing-owner-file', 'link'], ['after-check', 'racing-owner-file', 'create'], ['after-check-empty', '', 'create'], ['after-check-partial', v4.slice(0, 30), 'create']]) {
      const folder8 = join(root, `upgrade-raced-${name}`); mkdirSync(folder8)
      const path8 = join(folder8, 'sess-x.edits.json'); writeFileSync(path8, v4)
      const kept8 = join(folder8, 'sess-x.edits.version-4.json')
      const io = when === 'link' ? { link: () => { writeFileSync(kept8, racing); enotsup() } } : { link: enotsup, beforeCreate: () => writeFileSync(kept8, racing) }
      assert.throws(() => createRecordingEditsStore({ locate: () => ({ path: path8, runId: 'sess-x', durationMs: D, fingerprint: 'fp' }), io }).apply({}, { kind: 'finish', finish: { evenVolume: false } }, 2), /could not be kept/, name)
      assert.equal(readFileSync(kept8, 'utf8'), racing, `${name}: the other writer's file is left as it is`)
      assert.equal(readFileSync(path8, 'utf8'), v4, `${name}: the version 4 edits are untouched`)
      assert.deepEqual(readdirSync(folder8).sort(), ['sess-x.edits.json', 'sess-x.edits.version-4.json'], `${name}: no temporary file`)
    }
    // The other writer's whole copy arriving at either moment is accepted, not replaced.
    for (const [name, io9] of [['at-link', (kept9) => ({ link: () => { writeFileSync(kept9, earlier); throw Object.assign(Error('EEXIST'), { code: 'EEXIST' }) } })], ['after-check', (kept9) => ({ link: enotsup, beforeCreate: () => writeFileSync(kept9, earlier) })]]) {
      const folder9 = join(root, `upgrade-raced-whole-${name}`); mkdirSync(folder9)
      const path9 = join(folder9, 'sess-y.edits.json'); writeFileSync(path9, v4)
      const kept9 = join(folder9, 'sess-y.edits.version-4.json')
      createRecordingEditsStore({ locate: () => ({ path: path9, runId: 'sess-y', durationMs: D, fingerprint: 'fp' }), io: io9(kept9) }).apply({}, { kind: 'finish', finish: { evenVolume: false } }, 2)
      assert.equal(readFileSync(kept9, 'utf8'), earlier, name)
      assert.equal(JSON.parse(readFileSync(path9, 'utf8')).version, 5, name)
    }
    // Once the kept file exists under its name, a failure while writing it leaves that name alone: it may hold
    // another writer's file by then, or bytes another save has already accepted. The save is refused, the
    // version 4 edits stay, and a file cut short stops later saves until it is moved away.
    for (const [name, during, left] of [['disk-full', () => {}, ''], ['replaced-meanwhile', (kept) => { rmSync(kept); writeFileSync(kept, 'other-owner-file') }, 'other-owner-file']]) {
      const folder10 = join(root, `upgrade-fails-after-create-${name}`); mkdirSync(folder10)
      const path10 = join(folder10, 'sess-s.edits.json'); writeFileSync(path10, v4)
      const kept10 = join(folder10, 'sess-s.edits.version-4.json')
      const store10 = (io) => createRecordingEditsStore({ locate: () => ({ path: path10, runId: 'sess-s', durationMs: D, fingerprint: 'fp' }), io })
      assert.throws(() => store10({ link: enotsup, write: () => { during(kept10); return 0 } }).apply({}, { kind: 'finish', finish: { evenVolume: false } }, 2), /could not be kept.*stopped accepting data/, name)
      assert.equal(readFileSync(kept10, 'utf8'), left, `${name}: what is under the kept name is not removed`)
      assert.equal(readFileSync(path10, 'utf8'), v4, `${name}: the version 4 edits are untouched`)
      assert.throws(() => store10(undefined).apply({}, { kind: 'finish', finish: { evenVolume: false } }, 2), /not a complete copy/, `${name}: a later save is refused until the file is moved away`)
      assert.equal(readFileSync(path10, 'utf8'), v4)
    }
    // A whole copy this save wrote and another save has since accepted survives a late failure of this save.
    {
      const folder11 = join(root, 'upgrade-accepted-meanwhile'); mkdirSync(folder11)
      const path11 = join(folder11, 'sess-a.edits.json'); writeFileSync(path11, v4)
      const kept11 = join(folder11, 'sess-a.edits.version-4.json')
      let wrote = false
      const io = { link: enotsup, write: (fd, bytes, offset) => { if (!wrote) { wrote = true; return writeSync(fd, bytes, offset, bytes.length - offset) } throw Object.assign(Error('EIO'), { code: 'EIO' }) } }
      // The whole copy is written in one call; make the sidecar's own write (the next call) fail instead of the flush.
      assert.throws(() => createRecordingEditsStore({ locate: () => ({ path: path11, runId: 'sess-a', durationMs: D, fingerprint: 'fp' }), io }).apply({}, { kind: 'finish', finish: { evenVolume: false } }, 2), /EIO/)
      assert.equal(readFileSync(kept11, 'utf8'), v4, 'the kept copy stays after a later failure of the same save')
      assert.equal(readFileSync(path11, 'utf8'), v4)
    }
    pass('the first save over a 0.44 edits file keeps that file once as <run>.edits.version-4.json')
  }

  // ---- Even volume -------------------------------------------------------------------------------
  assert.equal(parseEvenMeasure('noise {"input_i" : "-20.11", "input_lra" : "17.80", "input_tp" : "-0.88", "input_thresh" : "-31.95", "target_offset" : "-0.23"}').i, -20.11)
  assert.equal(parseEvenMeasure('{"input_i" : "-inf", "input_lra" : "0.00", "input_tp" : "-inf", "input_thresh" : "-70.00", "target_offset" : "0.00"}'), null, 'silence has no measurement')
  assert.match(evenVolumeChain(null), /^dynaudnorm=.*aformat/, 'silence: the dynamic step only')
  assert.match(evenVolumeChain({ i: -20, lra: 5, tp: -1, thresh: -30, offset: 0.2 }), /loudnorm=I=-16:TP=-1\.5:LRA=11:measured_I=-20:.*linear=true/)
  pass('the even-volume chain: dynamic normalisation, then two-pass EBU R128 to −16 LUFS')

  const userData = join(root, 'userData'), runId = 'sess-finish', rec = join(userData, 'recordings', runId)
  mkdirSync(rec, { recursive: true })
  // Speech-like fixture: pink noise in 4 Hz syllables with a breath every five seconds; the first 20 s
  // about 19 LU quieter than the last 20 s.
  const voicePath = join(userData, 'recordings', `${runId}.webm`)
  gen(['-f', 'lavfi', '-i', 'anoisesrc=c=pink:r=48000:a=0.9:d=40:s=7', '-af', "volume='if(lt(t,20),0.1,0.9)':eval=frame,volume='0.5+0.5*sin(2*PI*4*t)':eval=frame,volume='if(lt(mod(t,5),4),1,0.02)':eval=frame", '-ac', '1', '-c:a', 'libopus', '-b:a', '96k', '-f', 'webm', voicePath])
  const voiceHash = sha(voicePath)
  const layers = { runId, durationMs: 40_000, slides: [], camera: [], missing: [], voice: [{ path: voicePath, startMs: 0, endMs: 40_000 }] }
  const quiet = lufs(voicePath, 0, 20), loud = lufs(voicePath, 20, 40)
  assert.ok(loud - quiet > 15, `the fixture has a quiet and a loud half (${quiet} / ${loud})`)

  const even = createEvenVolume({ ffmpeg: () => ffmpeg })
  const exporter = createVideoExporter({ ffmpeg: () => ffmpeg, even })
  const base = { layers, cuts: [], camera: true, title: 't', enters: [], slides: {}, words: [], segments: [], replace: true, extras: { captions: false, chapterList: false, sound: false } }
  const out = join(root, 'out'); mkdirSync(out)
  const plain = await exporter.run({ ...base, destination: join(out, 'plain.m4a'), evenVolume: false }, () => {})
  assert.equal(plain.state, 'done', JSON.stringify(plain))
  const evened = await exporter.run({ ...base, destination: join(out, 'even.m4a'), evenVolume: true }, () => {})
  assert.equal(evened.state, 'done', JSON.stringify(evened))
  const p = [lufs(plain.file, 0, 20), lufs(plain.file, 20, 40)], q = [lufs(evened.file, 0, 20), lufs(evened.file, 20, 40)], whole = lufs(evened.file, 0, 40)
  console.log(`  loudness, quiet half / loud half: recorded ${quiet} / ${loud} LUFS; exported as recorded ${p[0]} / ${p[1]}; evened ${q[0]} / ${q[1]} (whole ${whole})`)
  assert.ok(Math.abs((p[1] - p[0]) - (loud - quiet)) < 1.5, 'off: the export keeps the difference')
  assert.ok(Math.abs(q[1] - q[0]) <= 2, `on: the two halves are within 2 LU of each other (${q[1] - q[0]})`)
  assert.ok(Math.abs(whole - -16) <= 1.5, `on: the whole is at −16 LUFS (${whole})`)
  assert.equal(Math.abs(evened.durationMs - 40_000) < 50, true, 'evening out changes no length')
  assert.equal(sha(voicePath), voiceHash, 'the original voice file is never changed')
  pass(`even volume: a ${(loud - quiet).toFixed(1)} LU difference between halves becomes ${Math.abs(q[1] - q[0]).toFixed(1)} LU in the export`)

  // The player's evened voice uses the same measurement and sounds the same.
  const preparer = createPlaybackPreparer({ userDataDir: () => userData, ffmpeg: () => ffmpeg, even })
  await preparer.prepare(layers)
  const made = await preparer.prepareEven(layers)
  assert.ok(made && made.name === 'voice-even.webm')
  const copy = join(userData, 'recording-playback', runId, made.identity, made.name)
  assert.ok(statSync(copy).size > 1000)
  const c = [lufs(copy, 0, 20), lufs(copy, 20, 40)]
  assert.ok(Math.abs(c[0] - q[0]) <= 1 && Math.abs(c[1] - q[1]) <= 1, `the player's evened voice matches the export (${c} / ${q})`)
  const again = await preparer.prepareEven(layers)
  assert.equal(statSync(copy).mtimeMs, statSync(copy).mtimeMs); assert.deepEqual(again, made, 'made once, then reused')
  assert.equal(sha(voicePath), voiceHash)
  pass('Studio playback plays an evened copy made with the same measurement; the recording is untouched')

  // ---- Smooth joins: the splice, on samples ------------------------------------------------------
  {
    const D = 4000, spans = keptSpans([{ start: 1000, end: 2000 }], D)
    const total = 4000 * 48
    // A 440 Hz tone whose phase jumps inside the cut: the two sides of the join do not line up.
    const input = new Int16Array(total)
    for (let i = 0; i < total; i++) input[i] = Math.round(16000 * Math.sin((2 * Math.PI * 440 * i) / 48000 + (i >= 1500 * 48 ? 2.1 : 0)))
    const run = (smooth, chunk) => {
      const sp = createVoiceSplicer(voiceSplicePlan(spans, 120, smooth))
      const parts = []
      for (let i = 0; i < total; i += chunk) parts.push(...sp.push(input.subarray(i, Math.min(total, i + chunk))))
      parts.push(...sp.end())
      const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0
      for (const p of parts) { out.set(p, o); o += p.length }
      return out
    }
    const smooth = run(true, 4096), hard = run(false, 4096)
    assert.equal(smooth.length, splicedLength(spans)); assert.equal(hard.length, splicedLength(spans))
    assert.equal(smooth.length, 3000 * 48, 'the edited length is exactly the kept frames, with or without the crossfade')
    assert.deepEqual(run(true, 777), smooth, 'any chunk size gives the same samples'); assert.deepEqual(run(true, 1), smooth.subarray(0), 'even one sample at a time')
    const natural = Math.ceil(16000 * 2 * Math.PI * 440 / 48000) + 2
    const maxStep = (a, from, to) => { let m = 0; for (let i = Math.max(1, from); i < to; i++) m = Math.max(m, Math.abs(a[i] - a[i - 1])); return m }
    const join = 1000 * 48
    assert.ok(maxStep(smooth, join - 960, join + 960) <= natural * 1.5, `smooth: no step at the join beyond the tone's own (${maxStep(smooth, join - 960, join + 960)} vs ${natural})`)
    assert.ok(maxStep(hard, join - 960, join + 960) <= natural * 1.5, 'hard joins fade out and in, so no click either')
    // Away from the join the samples are the recording's own, in place.
    assert.deepEqual(smooth.subarray(0, join - 480), input.subarray(0, join - 480)); assert.deepEqual(smooth.subarray(join + 480, join + 9000), input.subarray(2000 * 48 + 480, 2000 * 48 + 9000))
    // The crossfade keeps the level: equal power, no dip in the middle (as a fade out and in would).
    const rms = (a, from, to) => Math.sqrt(a.subarray(from, to).reduce((s, v) => s + v * v, 0) / (to - from))
    assert.ok(rms(smooth, join - 240, join + 240) > 0.6 * rms(smooth, join - 4800, join - 2400), 'the smooth join has no dip')
    assert.ok(rms(hard, join - 240, join + 240) < 0.5 * rms(hard, join - 4800, join - 2400), 'the hard join dips to silence')
    assert.equal(SAMPLES_PER_FRAME, 1600)
    assert.deepEqual(dissolveWindows(spans), [{ first: 30, last: 30 + JOIN_DISSOLVE_FRAMES - 2 }])
    pass('smooth joins: an equal-power crossfade centred on each join, no click, no dip, same length; hard joins fade out and in')
  }

  // ---- Smooth joins: real exports ---------------------------------------------------------------
  {
    const rid = 'sess-joins', folder = join(userData, 'recordings', rid)
    mkdirSync(folder, { recursive: true })
    // Picture: black for 2 s, then white; voice: a tone in a different phase after 2 s, with a 30 ms
    // marker beep (1 kHz, loud) at 3.5 s and 5.0 s of Run time.
    gen(['-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=white:s=320x180:r=30:d=4', '-filter_complex', '[0][1]concat=n=2:v=1', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '200k', '-f', 'webm', join(folder, 'slides.webm')])
    const pcm = new Int16Array(6 * 48000)
    for (let i = 0; i < pcm.length; i++) {
      const t = i / 48000
      pcm[i] = Math.round(4000 * Math.sin(2 * Math.PI * 300 * t + (t >= 2 ? 1.7 : 0)) + ((t >= 3.5 && t < 3.53) || (t >= 5 && t < 5.03) ? 20000 * Math.sin(2 * Math.PI * 1000 * t) : 0))
    }
    const raw = join(root, 'joins.raw'); writeFileSync(raw, Buffer.from(pcm.buffer))
    const voice = join(userData, 'recordings', `${rid}.wav`)
    gen(['-f', 's16le', '-ar', '48000', '-ac', '1', '-i', raw, '-c:a', 'pcm_s16le', voice])
    const pictures = resolvePictureLayers(userData, rid, { layers: { slides: { file: 'slides.webm', bytes: statSync(join(folder, 'slides.webm')).size, startMs: 0 } } }, 6000)
    const jl = { runId: rid, durationMs: 6000, ...pictures, voice: [{ path: voice, startMs: 0, endMs: 6000 }] }
    const cuts = [{ start: 1000, end: 2500 }]
    const spans = keptSpans(cuts, 6000)
    const words = [{ text: 'Before', start: 300, end: 800 }, { text: 'beep', start: 3500, end: 3530 }, { text: 'again', start: 5000, end: 5030 }]
    const enters = [{ tMs: 0, slideId: 'a' }, { tMs: 2000, slideId: 'b' }]
    const run = async (smoothJoins, name) => {
      const done = await exporter.run({ ...base, layers: jl, cuts, enters, slides: { a: { title: 'Black' }, b: { title: 'White' } }, words, destination: join(out, name), evenVolume: false, smoothJoins, extras: { captions: true, chapterList: true, sound: false } }, () => {})
      assert.equal(done.state, 'done', JSON.stringify(done))
      return done
    }
    const hard = await run(false, 'hard.mp4'), smooth = await run(true, 'smooth.mp4')
    assert.equal(smooth.durationMs, hard.durationMs); assert.equal(smooth.durationMs, 4500, 'the same length either way')
    const decode = (file) => new Int16Array(new Uint8Array(spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 's16le', '-ar', '48000', '-ac', '1', '-'], { maxBuffer: 1 << 28 }).stdout).buffer)
    const sa = decode(smooth.file), ha = decode(hard.file)
    // Sound at the join (edited 1.0 s): no sample-to-sample step beyond the tone's own (plus the encoder's noise).
    const joinAt = 48000
    const step = (a, from, to) => { let m = 0; for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i] - a[i - 1])); return m }
    const toneStep = step(sa, 24000, 40000)
    const smoothStep = step(sa, joinAt - 2400, joinAt + 2400)
    console.log(`  largest step at the join: smooth ${smoothStep}, hard ${step(ha, joinAt - 2400, joinAt + 2400)}; the tone's own ${toneStep}`)
    assert.ok(smoothStep <= toneStep * 1.6, `no click at the join (${smoothStep} vs ${toneStep})`)
    // The markers are where the edited timeline says: captions and chapters keep their times.
    const onset = (a, nearMs) => { const from = Math.round((nearMs - 200) * 48), to = Math.round((nearMs + 200) * 48); for (let i = from; i < to; i++) if (Math.abs(a[i]) > 12000) return i / 48; return NaN }
    for (const t of [3500, 5000]) {
      const want = planRunToEdited(spans, t)
      const got = onset(sa, want)
      assert.ok(Math.abs(got - want) <= 3, `the marker at Run ${t} ms is at edited ${got.toFixed(1)} ms, as planned (${want})`)
    }
    const srt = readFileSync(join(out, 'smooth.srt'), 'utf8'), cues = captionCues(words, spans).cues
    assert.ok(srt.includes('00:00:02,000 --> ') && cues.some((c) => c.startMs === Math.round(planRunToEdited(spans, 3500))), 'caption times are those of the edited timeline')
    assert.equal(readFileSync(join(out, 'smooth chapters.txt'), 'utf8'), readFileSync(join(out, 'hard chapters.txt'), 'utf8'), 'chapters do not move')
    assert.deepEqual(chaptersFor(enters, { a: { title: 'Black' }, b: { title: 'White' } }, spans).map((c) => c.startMs), [0, 1000])
    // Picture: frames 30.. after the join dissolve from black to white with smooth joins; cut straight without.
    const luma = (file) => { const b = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-vf', 'scale=16:9,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 }).stdout; return Array.from({ length: b.length / 144 }, (_, i) => b[i * 144 + 72]) }
    const sl = luma(smooth.file), hl = luma(hard.file)
    assert.equal(sl.length, 135); assert.equal(hl.length, 135)
    console.log(`  frames 28–37 after the join, smooth: ${sl.slice(28, 38).join(' ')}; hard: ${hl.slice(28, 38).join(' ')}`)
    assert.ok(hl[29] < 40 && hl[30] > 200, 'hard: black then white on the frame boundary')
    assert.ok(sl[29] < 40 && sl[35] > 200, 'smooth: black before the join, white once the dissolve is over')
    for (let f = 30; f < 35; f++) assert.ok(sl[f] > sl[f - 1] + 15 && sl[f] < 245, `smooth: frame ${f} is part way (${sl[f]})`)
    pass('smooth joins in a real export: no click, markers and captions at their planned edited times, a five-frame dissolve; hard joins cut on the frame')
  }

  // ---- Face position per slide: the edits ---------------------------------------------------------
  {
    const D = 60_000
    const side = { layout: 'side', corner: 'bottom-right', size: 'medium' }, hidden = { ...DEFAULT_FACE, layout: 'slide' }, big = { layout: 'corner', corner: 'bottom-left', size: 'large' }
    let e = emptyEdits()
    assert.deepEqual(e.faces, { all: DEFAULT_FACE, slides: [] })
    e = applyEditOp(e, { kind: 'face', changes: [12_000], face: side }, D)
    assert.deepEqual(faceOf(e.faces, 12_000), side); assert.deepEqual(faceOf(e.faces, 0), DEFAULT_FACE); assert.equal(e.undo.length, 1)
    e = applyEditOp(e, { kind: 'face', changes: [20_000, 30_000, 40_000], face: hidden }, D)
    assert.deepEqual(e.faces.slides.map((x) => [x.change, x.face.layout]), [[12_000, 'side'], [20_000, 'slide'], [30_000, 'slide'], [40_000, 'slide']], 'slides 3 to 5 at once, sorted')
    assert.equal(e.undo.length, 2, 'a run of slides is one step')
    const putBack = applyEditOp(e, { kind: 'face', changes: [30_000], face: null }, D)
    assert.deepEqual(faceOf(putBack.faces, 30_000), DEFAULT_FACE, 'a slide put back follows the whole video')
    const whole = applyEditOp(e, { kind: 'face', changes: null, face: big }, D)
    assert.deepEqual(whole.faces, { all: big, slides: [] }, 'the whole video: every slide follows it again')
    assert.deepEqual(applyEditOp(whole, { kind: 'undo' }, D).faces, e.faces, 'undo brings the per-slide choices back')
    assert.equal(applyEditOp(e, { kind: 'face', changes: [12_000], face: side }, D), e, 'no change is no step')
    assert.deepEqual(applyEditOp(e, { kind: 'face', changes: [50_000], face: DEFAULT_FACE }, D).faces, e.faces, 'a slide set to what the whole video has needs no entry')
    for (const bad of [{ changes: [1], face: { layout: 'top', corner: 'bottom-right', size: 'small' } }, { changes: [1], face: { ...DEFAULT_FACE, corner: 'top-left' } }, { changes: null, face: null }, { changes: ['x'], face: side }])
      assert.throws(() => applyEditOp(e, { kind: 'face', ...bad }, D), /Invalid face/)
    const read = parseEditsText(serialiseEdits(e), D)
    assert.ok(read.ok); assert.deepEqual(read.edits.faces, e.faces); assert.deepEqual(read.edits.undo, e.undo)
    assert.equal(parseEdits({ ...JSON.parse(serialiseEdits(e)), faces: { all: { layout: 'corner' }, slides: [] } }, D).problem?.kind, 'corrupt')
    assert.equal(parseEdits({ ...JSON.parse(serialiseEdits(e)), faces: undefined }, D).problem?.kind, 'corrupt', 'version 5 always says where the face is')
    const v4 = parseEdits({ version: 4, revision: 1, cuts: [], boundaries: [], leftOut: [], undo: [], redo: [], finish: {} }, D)
    assert.ok(v4.ok); assert.deepEqual(v4.edits.faces, { all: DEFAULT_FACE, slides: [] }, 'a 0.44 file has the face in the bottom-right corner, as 0.44 exported it')
    pass('face position per slide: this slide, a run of slides, the whole video, put back; each one undo step; stored and read back')
  }

  // ---- Face position: geometry at every export size -----------------------------------------------
  {
    assert.deepEqual(cameraRect(), { x: 1471, y: 815, width: 422, height: 238 }, '0.44\'s corner is unchanged')
    const placements = [
      ...['bottom-right', 'bottom-left'].flatMap((corner) => ['small', 'medium', 'large'].map((size) => ({ layout: 'corner', corner, size }))),
      { layout: 'side', corner: 'bottom-right', size: 'medium' }, { layout: 'face', corner: 'bottom-right', size: 'medium' }, { layout: 'slide', corner: 'bottom-right', size: 'medium' }
    ]
    const inside = (r, f) => r.x >= 0 && r.y >= 0 && r.x + r.width <= f.width && r.y + r.height <= f.height && r.width > 0 && r.height > 0
    const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
    let checked = 0
    for (const frame of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }, { width: 3840, height: 2160 }, { width: 854, height: 480 }, { width: 640, height: 360 }]) {
      for (const face of placements) {
        const r = placementRects(face, frame)
        for (const rect of [r.slides, r.camera]) if (rect) {
          assert.ok(inside(rect, frame), `${JSON.stringify(face)} at ${frame.width}×${frame.height} is not cut off: ${JSON.stringify(rect)}`)
          assert.ok(rect.width % 2 === 0 && rect.height % 2 === 0 && Number.isInteger(rect.x) && Number.isInteger(rect.y), 'whole, even sizes for H.264')
        }
        if (r.slides && r.camera && face.layout !== 'face') {
          const title = { x: r.slides.x, y: r.slides.y, width: r.slides.width, height: Math.ceil(r.slides.height * TITLE_BAND_FRACTION) }
          assert.ok(!overlap(r.camera, title), `${JSON.stringify(face)} at ${frame.width}×${frame.height} never covers the slide's title band`)
          if (face.layout === 'side') assert.ok(!overlap(r.camera, r.slides), 'side by side: the face never covers the slide')
        }
        checked++
      }
    }
    assert.deepEqual(placementRects({ layout: 'face', corner: 'bottom-right', size: 'small' }).slides, null)
    assert.deepEqual(placementRects({ layout: 'slide', corner: 'bottom-right', size: 'small' }).camera, null)
    assert.deepEqual(withoutCamera(DEFAULT_FACE).layout, 'slide')
    pass(`face positions: ${checked} placement and size pairs inside the frame, even-sized, never over the slide's title band`)

    const rows = [{ change: 0, start: 0 }, { change: 5000, start: 4800 }, { change: 9000, start: 9100 }, { change: 12_000, start: 12_000 }]
    const faces = { all: DEFAULT_FACE, slides: [{ change: 5000, face: { layout: 'side', corner: 'bottom-right', size: 'medium' } }, { change: 9000, face: { layout: 'side', corner: 'bottom-right', size: 'medium' } }] }
    const track = faceTrack(rows, faces, 20_000)
    assert.deepEqual(track.map((t) => [t.start, t.end, t.face.layout]), [[0, 4800, 'corner'], [4800, 12_000, 'side'], [12_000, 20_000, 'corner']], 'by edit boundary, neighbours merged')
    assert.equal(faceAt(track, 4799).layout, 'corner'); assert.equal(faceAt(track, 4800).layout, 'side')
    pass('the face track follows each slide\'s edit boundary')
  }

  // ---- Face position: a real export ---------------------------------------------------------------
  {
    const rid = 'sess-faces', folder = join(userData, 'recordings', rid)
    mkdirSync(folder, { recursive: true })
    gen(['-f', 'lavfi', '-i', 'color=c=white:s=640x360:r=30:d=8', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '200k', '-f', 'webm', join(folder, 'slides.webm')])
    gen(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=30:d=8', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '100k', '-f', 'webm', join(folder, 'camera.webm')])
    const size = (f) => statSync(join(folder, f)).size
    const pictures = resolvePictureLayers(userData, rid, { layers: { slides: { file: 'slides.webm', bytes: size('slides.webm'), startMs: 0 }, camera: { file: 'camera.webm', bytes: size('camera.webm'), startMs: 0 } } }, 8000)
    const fl = { runId: rid, durationMs: 8000, ...pictures, voice: [] }
    const track = [
      { start: 0, end: 2000, face: { layout: 'corner', corner: 'bottom-left', size: 'large' } },
      { start: 2000, end: 4000, face: { layout: 'side', corner: 'bottom-right', size: 'medium' } },
      { start: 4000, end: 6000, face: { layout: 'face', corner: 'bottom-right', size: 'medium' } },
      { start: 6000, end: 8000, face: { layout: 'slide', corner: 'bottom-right', size: 'medium' } }
    ]
    const frameAt = (file, sec) => spawnSync(ffmpeg, ['-v', 'error', '-ss', String(sec), '-i', file, '-frames:v', '1', '-vf', 'scale=192:108,format=rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 }).stdout
    const px = (buf, xFrac, yFrac) => { const x = Math.floor(xFrac * 192), y = Math.floor(yFrac * 108), i = (y * 192 + x) * 3; return [buf[i], buf[i + 1], buf[i + 2]] }
    const kind = ([r, g, b]) => (r > 180 && g > 180 && b > 180 ? 'white' : r > 150 && g < 90 && b < 90 ? 'red' : r < 50 && g < 50 && b < 50 ? 'black' : `${r},${g},${b}`)
    for (const [cameraOn, name] of [[true, 'faces.mp4'], [false, 'faces-off.mp4']]) {
      const done = await exporter.run({ ...base, layers: fl, camera: cameraOn, faces: track, destination: join(out, name), evenVolume: false, smoothJoins: false }, () => {})
      assert.equal(done.state, 'done', JSON.stringify(done))
      const at = (sec, xf, yf) => kind(px(frameAt(done.file, sec), xf, yf))
      if (cameraOn) {
        assert.equal(at(1, 0.1, 0.85), 'red', 'slide 1: the face in the bottom-left corner, large'); assert.equal(at(1, 0.9, 0.85), 'white'); assert.equal(at(1, 0.5, 0.1), 'white', 'the title band is clear')
        assert.equal(at(3, 0.3, 0.5), 'white', 'slide 2 side by side: the slide at the left'); assert.equal(at(3, 0.86, 0.5), 'red', 'and the face at the right'); assert.equal(at(3, 0.5, 0.05), 'black', 'black above and below the slide')
        assert.equal(at(5, 0.5, 0.5), 'red'); assert.equal(at(5, 0.05, 0.05), 'red', 'slide 3: the face fills the frame')
        assert.equal(at(7, 0.9, 0.85), 'white'); assert.equal(at(7, 0.1, 0.85), 'white', 'slide 4: the face hidden')
      } else {
        for (const t of [1, 3, 5, 7]) { assert.equal(at(t, 0.1, 0.85), 'white'); assert.equal(at(t, 0.86, 0.5), 'white', `camera switched off: the slides alone at ${t} s`) }
      }
    }
    pass('face position in a real export: corner, side by side, face only and hidden, each over its slide; the Camera switch still leaves the face out')
  }
  // ---- Chapter titles are the names the presenter sees, in the MP4 and the chapter list (release journey on
  // 1a68f785: section ids such as "before-the-walk" were written) ----
  {
    const { slideTitlesFromRows } = await import('../src/shared/talk-title-text.ts')
    const { prepareSource } = await import('../compiler/scripts/lib/08-source-adapters.mjs')
    const { buildPerSlideProjections } = await import('../compiler/scripts/lib/10-projections.mjs')
    // Three kinds of section: one with a trigger line (it gets an id and a section-title slide), one in another
    // script, and a plain heading (its text is the section) with the characters FFmpeg's metadata escapes.
    const outline = '# Walk talk\n\n## Before the *walk*: "Ready?" 🎒\n{timer=4m}\n\n### Gate\n\nWords here.\n\n## 日本語の道\n{timer=2m}\n\n### Path\n\nWords.\n\n## On the path = the #1 step; really\n\n### Stile\n\nWords.\n'
    const rows = buildPerSlideProjections(await prepareSource('/tmp/walk.md', outline, 'walk'), 'walk')
    const slides = slideTitlesFromRows(rows)
    const names = ['Before the walk: "Ready?" 🎒', '日本語の道', 'On the path = the #1 step; really']
    assert.deepEqual(['gate', 'path', 'stile'].map((id) => slides[id]?.section), names, `each slide's section is its name, as in the outline, without markup (${JSON.stringify(rows.map((r) => [r.slide_id, r.role, r.section]))})`)
    assert.equal(slides.gate.title, 'Gate')
    const rid = 'sess-chapters', folder = join(userData, 'recordings', rid)
    mkdirSync(folder, { recursive: true })
    gen(['-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=30:d=3', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '100k', '-f', 'webm', join(folder, 'slides.webm')])
    const voice = join(userData, 'recordings', `${rid}.webm`)
    gen(['-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', '-c:a', 'libopus', '-f', 'webm', voice])
    const layers = { runId: rid, durationMs: 3000, ...resolvePictureLayers(userData, rid, { layers: { slides: { file: 'slides.webm', bytes: statSync(join(folder, 'slides.webm')).size, startMs: 0 } } }, 3000), voice: [{ path: voice, startMs: 0, endMs: 3000 }] }
    const chapterOut = join(root, 'chapters-out'); mkdirSync(chapterOut)
    const done = await createVideoExporter({ ffmpeg: () => ffmpeg }).run({ layers, cuts: [], camera: false, evenVolume: false, smoothJoins: false, extras: { captions: false, chapterList: true, sound: false }, destination: join(chapterOut, 'walk.mp4'), replace: true, title: 'Walk talk', enters: [{ tMs: 0, slideId: 'gate' }, { tMs: 1000, slideId: 'path' }, { tMs: 2000, slideId: 'stile' }], slides, words: [], segments: [] }, () => {})
    assert.equal(done.state, 'done', JSON.stringify(done))
    const listed = readFileSync(join(chapterOut, 'walk chapters.txt'), 'utf8').trim().split('\n').map((l) => l.replace(/^\d+:\d\d /, ''))
    assert.deepEqual(listed, names, 'the chapter list to paste into YouTube')
    // The MP4's own chapter markers, read back (FFmpeg's metadata dump; ffprobe is not among the app's tools).
    const meta = spawnSync(ffmpeg, ['-v', 'error', '-i', done.file, '-f', 'ffmetadata', '-'], { maxBuffer: 1 << 20 }).stdout.toString('utf8')
    const inFile = meta.split('[CHAPTER]').slice(1).map((c) => /\ntitle=(.*)/.exec(c)?.[1].replace(/\\(.)/g, '$1'))
    assert.deepEqual(inFile, names, `the MP4's chapters (${JSON.stringify(inFile)})`)
    pass('chapter titles are the section names as the presenter sees them, in the MP4 and the chapter list: quotes, colons, emoji, another script and FFmpeg\'s escaped characters survive')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
