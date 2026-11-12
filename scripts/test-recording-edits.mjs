// Slice 3a: the layered Run's edit sidecar, the shared play/export plan, and a real export through
// ffmpeg on generated layer files. Plain Node; ffmpeg-static stands in for the app's bundled ffmpeg.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyEditOp, editedToRun, effectiveCuts, emptyEdits, EDIT_HISTORY_LIMIT, keptMs, normaliseRanges, parseEdits, restoreRange, runToEdited, trimEndAt, trimStartAt } from '../src/shared/recording-edits.ts'
import { cameraRect, captionCues, chapterListText, chaptersFor, editedDurationMs, ffmetadata, keptSpans, layerClips, planEditedToRun, planRunToEdited, silentEndSuggestions, toSrt, toWebVtt, VIDEO_FRAME, hasPictureLayers } from '../src/shared/recording-video.ts'
import { createRecordingEditsStore } from '../src/main/recording-edits-store.ts'
import { createPlaybackPreparer, createVideoExporter, exportArgs, exportFailureMessage, freeName, inspectMedia, playbackFile, resolvePictureLayers } from '../src/main/recording-video.ts'

let count = 0
const pass = (name) => console.log(`PASS ${++count} ${name}`)
const root = mkdtempSync(join(tmpdir(), 'tw-recording-edits-'))
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
try {
  // ---- edit model ------------------------------------------------------------------------------
  assert.deepEqual(normaliseRanges([{ start: 500, end: 900 }, { start: 100, end: 300 }, { start: 280, end: 520 }, { start: 5, end: 5 }, { start: -10, end: 20 }], 1000), [{ start: 0, end: 20 }, { start: 100, end: 900 }])
  assert.deepEqual(restoreRange([{ start: 0, end: 1000 }], { start: 200, end: 300 }), [{ start: 0, end: 200 }, { start: 300, end: 1000 }])
  pass('cuts merge when they touch and split when a range inside one is restored')

  const D = 60_000
  let e = emptyEdits()
  e = applyEditOp(e, { kind: 'trim-start', at: 3000 }, D)
  e = applyEditOp(e, { kind: 'trim-end', at: 55_000 }, D)
  assert.deepEqual(e.cuts, [{ start: 0, end: 3000 }, { start: 55_000, end: 60_000 }])
  assert.equal(trimStartAt(e.cuts), 3000); assert.equal(trimEndAt(e.cuts, D), 55_000)
  e = applyEditOp(e, { kind: 'trim-start', at: 1000 }, D)
  assert.deepEqual(e.cuts[0], { start: 0, end: 1000 }, 'a new start trim replaces the old one, it does not add to it')
  e = applyEditOp(e, { kind: 'cut', ranges: [{ start: 10_000, end: 12_000 }, { start: 11_000, end: 14_000 }] }, D)
  assert.deepEqual(e.cuts, [{ start: 0, end: 1000 }, { start: 10_000, end: 14_000 }, { start: 55_000, end: 60_000 }])
  assert.equal(e.undo.length, 4); assert.equal(e.revision, 4)
  assert.equal(applyEditOp(e, { kind: 'trim-start', at: 1000 }, D), e, 'no change is no step')
  assert.throws(() => applyEditOp(e, { kind: 'trim-start', at: 56_000 }, D), /before the end/)
  assert.throws(() => applyEditOp(e, { kind: 'cut', ranges: [{ start: 0, end: D }] }, D), /whole recording/)
  assert.throws(() => applyEditOp(e, { kind: 'cut', ranges: [{ start: NaN, end: 3 }] }, D), /Invalid/)
  pass('trim start, trim end and general cuts are each one undoable step; impossible edits are refused')

  let u = applyEditOp(e, { kind: 'undo' }, D)
  assert.deepEqual(u.cuts, [{ start: 0, end: 1000 }, { start: 55_000, end: 60_000 }])
  u = applyEditOp(u, { kind: 'undo' }, D); u = applyEditOp(u, { kind: 'redo' }, D)
  assert.deepEqual(u.cuts, [{ start: 0, end: 1000 }, { start: 55_000, end: 60_000 }])
  const branched = applyEditOp(u, { kind: 'restore-all' }, D)
  assert.deepEqual(branched.cuts, []); assert.equal(branched.redo.length, 0)
  assert.deepEqual(applyEditOp(branched, { kind: 'undo' }, D).cuts, u.cuts, '"Use the whole recording" is undoable')
  let many = emptyEdits()
  for (let i = 0; i < EDIT_HISTORY_LIMIT + 20; i++) many = applyEditOp(many, { kind: 'cut', ranges: [{ start: i * 100, end: i * 100 + 50 }] }, D)
  assert.equal(many.undo.length, EDIT_HISTORY_LIMIT)
  const cam = applyEditOp(many, { kind: 'finish', finish: { camera: false } }, D)
  assert.equal(cam.finish.camera, false); assert.equal(cam.undo, many.undo, 'the camera choice is not a cut step')
  pass(`undo and redo are bounded to ${EDIT_HISTORY_LIMIT} steps; a new edit clears redo; the camera choice is kept apart`)

  const cuts = [{ start: 1000, end: 2000 }, { start: 5000, end: 6000 }]
  assert.equal(runToEdited(500, cuts), 500); assert.equal(runToEdited(1500, cuts), 1000); assert.equal(runToEdited(7000, cuts), 5000)
  assert.equal(editedToRun(1000, cuts), 2000); assert.equal(editedToRun(4500, cuts), 6500)
  assert.equal(keptMs(cuts, 10_000), 8000)
  assert.deepEqual(effectiveCuts([{ start: 0, end: 100 }], [{ start: 50, end: 300 }], 1000), [{ start: 0, end: 300 }])
  pass('Run time and edited time map both ways; transcript trims on the Run join the sidecar cuts')

  assert.equal(parseEdits(null, D).ok, true)
  const v2 = parseEdits({ version: 2, source: 'x', revision: 4, cuts: [{ start: 0, end: 500 }], restoredLegacy: [] }, D, { legacySource: () => 'x' })
  assert.equal(v2.ok && v2.from, 2); assert.deepEqual(v2.ok && v2.edits.cuts, [{ start: 0, end: 500 }])
  assert.equal(parseEdits({ version: 9, cuts: [] }, D).ok, false)
  assert.equal(parseEdits({ version: 9 }, D).problem.kind, 'newer')
  for (const bad of [[], 'x', { version: 3, revision: -1, cuts: [], undo: [], redo: [] }, { version: 3, revision: 1, cuts: 'x', undo: [], redo: [] }, { version: 3, revision: 1, cuts: [], undo: [[{ start: 'a' }]], redo: [] }])
    assert.equal(parseEdits(bad, D).problem.kind, 'corrupt')
  pass('a missing or older sidecar reads; a newer or malformed one is a stated problem')

  // ---- sidecar store ---------------------------------------------------------------------------
  const folder = join(root, 'talk'); mkdirSync(folder)
  const path = join(folder, 'sess-a.edits.json')
  let failRename = false
  const store = createRecordingEditsStore({ locate: () => ({ path, runId: 'sess-a', durationMs: D, fingerprint: 'fx/sess-a@1/60000' }), beforeRename: () => { if (failRename) throw Error('disk gone') } })
  assert.equal(existsSync(path), false); assert.equal(store.get({}).edits.revision, 0)
  const s1 = store.apply({}, { kind: 'trim-start', at: 2000 }, 0)
  const onDisk = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(onDisk.version, 4); assert.equal(onDisk.revision, 1); assert.equal(onDisk.id, undefined, 'never looks like a Run file')
  assert.throws(() => store.apply({}, { kind: 'trim-end', at: 50_000 }, 0), /changed in another window/)
  failRename = true
  assert.throws(() => store.apply({}, { kind: 'trim-end', at: 50_000 }, 1), /disk gone/)
  failRename = false
  assert.deepEqual(readdirSync(folder), ['sess-a.edits.json'], 'a failed write leaves no temporary file and the old sidecar intact')
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).revision, 1)
  const s2 = store.apply({}, { kind: 'trim-end', at: 50_000 }, s1.edits.revision)
  const reopened = createRecordingEditsStore({ locate: () => ({ path, runId: 'sess-a', durationMs: D, fingerprint: 'fx/sess-a@1/60000' }) })
  assert.deepEqual(reopened.get({}).edits.undo, s2.edits.undo)
  assert.deepEqual(reopened.apply({}, { kind: 'undo' }, 2).edits.cuts, [{ start: 0, end: 2000 }], 'undo works after reopening')
  pass('the sidecar is written atomically, revision-checked, and its history survives reopening')

  writeFileSync(path, '{ not json')
  const broken = store.get({})
  assert.equal(broken.problem.kind, 'corrupt')
  assert.throws(() => store.apply({}, { kind: 'trim-start', at: 10 }, 0), /kept unchanged/)
  assert.equal(readFileSync(path, 'utf8'), '{ not json')
  const fresh = store.startFresh({})
  assert.equal(fresh.problem, null); assert.ok(fresh.keptAs && existsSync(fresh.keptAs)); assert.equal(readFileSync(fresh.keptAs, 'utf8'), '{ not json')
  store.apply({}, { kind: 'trim-start', at: 10 }, 0)
  writeFileSync(path, JSON.stringify({ version: 5, cuts: [] }))
  assert.equal(store.get({}).problem.kind, 'newer')
  assert.throws(() => store.apply({}, { kind: 'trim-start', at: 20 }, 1), /newer version/)
  const linked = join(folder, 'sess-b.edits.json'); symlinkSync(join(root, 'elsewhere.json'), linked)
  const linkStore = createRecordingEditsStore({ locate: () => ({ path: linked, runId: 'sess-b', durationMs: D, fingerprint: 'fx/sess-b@1/60000' }) })
  assert.equal(linkStore.get({}).problem.kind, 'corrupt')
  assert.throws(() => linkStore.apply({}, { kind: 'trim-start', at: 5 }, 0))
  assert.equal(existsSync(join(root, 'elsewhere.json')), false, 'never writes through a link')
  pass('a corrupt or newer sidecar is refused and kept; Start new edits keeps it beside a fresh one; links are refused')

  // ---- plan ------------------------------------------------------------------------------------
  const rect = cameraRect()
  assert.deepEqual(rect, { x: 1471, y: 815, width: 422, height: 238 })
  assert.ok(rect.width % 2 === 0 && rect.height % 2 === 0)
  const spans = keptSpans([{ start: 0, end: 1010 }, { start: 3000, end: 4000 }], 10_000)
  assert.deepEqual(spans.map((s) => [s.startFrame, s.endFrame]), [[30, 90], [120, 300]])
  assert.equal(editedDurationMs(spans), 8000)
  assert.deepEqual(spans.map((s) => [s.fadeIn, s.fadeOut]), [[true, true], [true, false]])
  assert.equal(planRunToEdited(spans, 3500), 2000); assert.equal(planEditedToRun(spans, 2000), 4000)
  pass('kept spans sit on the 30 fps frame grid; joins made by edits fade; the camera rectangle is one fixed size')

  const capture = { durationMs: 9000, layers: { slides: { file: 'slides.webm', bytes: 10, startMs: 40, segments: [{ file: 'slides.webm', bytes: 10, startMs: 40, endMs: 4000 }, { file: 'slides.seg-1.webm', bytes: 0, startMs: 4500 }, { file: 'slides.seg-2.webm', bytes: 9, startMs: 5000 }] }, camera: { file: 'camera.webm', bytes: 5, startMs: 60, lostAtMs: 3000 } } }
  const clips = layerClips(capture, 9000)
  assert.deepEqual(clips.slides.map((c) => [c.part, c.startMs, c.endMs]), [[0, 40, 4000], [2, 5000, 9000]])
  assert.deepEqual(clips.camera.map((c) => [c.startMs, c.endMs]), [[60, 3000]])
  assert.equal(hasPictureLayers(capture), true); assert.equal(hasPictureLayers(null), false)
  pass('layer files are placed on the Run clock; empty parts and a lost camera end where they ended')

  const chapters = chaptersFor([{ tMs: 0, slideId: 'a' }, { tMs: 2500, slideId: 'b' }, { tMs: 3200, slideId: 'c' }, { tMs: 6000, slideId: 'd' }], { a: { title: 'Intro' }, b: { title: 'Two' }, c: { title: 'Cut away' }, d: { title: 'Four' } }, spans)
  assert.deepEqual(chapters.map((c) => [c.startMs, c.title]), [[0, 'Intro'], [1500, 'Two'], [2000, 'Cut away'], [4000, 'Four']])
  const sectioned = chaptersFor([{ tMs: 1100, slideId: 'a' }, { tMs: 2000, slideId: 'b' }, { tMs: 5000, slideId: 'c' }], { a: { title: 'A', section: 'Start' }, b: { title: 'B', section: 'Start' }, c: { title: 'C', section: 'Middle' } }, spans)
  assert.deepEqual(sectioned.map((c) => [c.startMs, c.title]), [[0, 'Start'], [3000, 'Middle']])
  assert.equal(chapterListText(sectioned), '0:00 Start\n0:03 Middle\n')
  assert.match(ffmetadata(sectioned, 'My = talk'), /^;FFMETADATA1\ntitle=My \\= talk\n\[CHAPTER\]\nTIMEBASE=1\/1000\nSTART=0\nEND=3000\ntitle=Start/)
  pass('chapters come from slide changes in edited time, by section where the talk has sections')

  const words = [{ text: 'Hello', start: 1100, end: 1400 }, { text: 'there.', start: 1450, end: 1800 }, { text: 'gone', start: 3200, end: 3600 }, { text: 'Next', start: 4100, end: 4400, alignment: { status: 'aligned', start: 4200, end: 4500 } }, { text: 'part', start: 4600, end: 4900 }]
  const { cues } = captionCues(words, spans)
  assert.deepEqual(cues.map((c) => c.text), ['Hello there.', 'Next part'])
  assert.equal(cues[1].startMs, 2200, 'aligned times are used, mapped to edited time')
  assert.match(toSrt(cues), /^1\n00:00:00,100 --> 00:00:00,800\nHello there\.\n\n2\n00:00:02,200 --> 00:00:02,900\nNext part\n$/)
  assert.match(toWebVtt(cues), /^WEBVTT\n\n00:00:00\.100 --> 00:00:00\.800\nHello there\.\n/)
  pass('captions are timed in edited time and leave out words in cuts')

  const sugg = silentEndSuggestions([{ start: 0, end: 4200 }, { start: 20_000, end: 21_000 }, { start: 57_000, end: 60_000 }], 60_000, 0, 60_000)
  assert.deepEqual(sugg, [{ side: 'start', at: 3900, silentMs: 4200 }, { side: 'end', at: 57_300, silentMs: 3000 }])
  assert.deepEqual(silentEndSuggestions([{ start: 0, end: 1500 }], 60_000, 0, 60_000), [])
  assert.deepEqual(silentEndSuggestions([{ start: 0, end: 4200 }], 60_000, 3900, 60_000), [], 'no suggestion once trimmed')
  pass('a silent start or end of 2 s or more is suggested, never applied')

  // ---- export arguments ------------------------------------------------------------------------
  const { args, editedMs } = exportArgs({ durationMs: 10_000, cuts: [{ start: 0, end: 1010 }], slides: [{ path: '/s.webm', startMs: 40, endMs: 10_000 }], camera: [{ path: '/c.webm', startMs: 60, endMs: 9000 }], voice: [{ path: '/v.webm', startMs: 0, endMs: 10_000 }], audioOnly: false, metadataFile: '/m.txt' }, '/out.part')
  assert.equal(editedMs, 9000)
  const graph = args[args.indexOf('-filter_complex') + 1]
  assert.match(graph, /tpad=start_mode=clone:start_duration=0\.04,/, 'the first slides frame is held from 0, not black')
  assert.match(graph, /overlay=x=1471:y=815/); assert.match(graph, /asetnsamples=n=1600/); assert.match(graph, /afade=t=in:st=1:d=0\.015/)
  assert.ok(!args.some((a) => /\s/.test(a) && a !== graph && !a.includes('enable')), 'arguments are an array, never a shell line')
  assert.deepEqual(args.slice(args.indexOf('-map_metadata'), args.indexOf('-map_metadata') + 4), ['-map_metadata', '4', '-map_chapters', '4'])
  pass('the export command places the camera in the player’s rectangle and cuts sound on the picture’s frames')

  assert.equal(freeName('/x/a.srt', (p) => p === '/x/a.srt' || p === '/x/a (2).srt'), '/x/a (3).srt')
  assert.match(exportFailureMessage(Object.assign(Error('x'), { ffmpegLog: 'av_interleaved_write_frame(): No space left on device' })), /disk is full/)
  assert.match(exportFailureMessage(Error('weird')), /recording and your edits are safe/)
  pass('extras never replace an existing file; failures say why in plain words')

  // ---- real ffmpeg: layers → playback copies → export ------------------------------------------
  const userData = join(root, 'userData'), runId = 'sess-fixture', rec = join(userData, 'recordings', runId)
  mkdirSync(rec, { recursive: true })
  const gen = (args) => { const r = spawnSync(ffmpeg, ['-v', 'error', '-y', '-threads', '2', ...args], { timeout: 300_000 }); assert.equal(r.status, 0, r.stderr?.toString()) }
  // Slides: 6 s of blue then 4 s of green; camera: red; voice: a tone, silence from 6 s.
  gen(['-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080:r=30:d=6', '-f', 'lavfi', '-i', 'color=c=green:s=1920x1080:r=30:d=4', '-filter_complex', '[0][1]concat=n=2:v=1', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '300k', '-f', 'webm', join(rec, 'slides.webm')])
  gen(['-f', 'lavfi', '-i', 'color=c=red:s=640x480:r=30:d=9', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '100k', '-f', 'webm', join(rec, 'camera.webm')])
  const voicePath = join(userData, 'recordings', `${runId}.webm`)
  gen(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-af', 'apad=whole_dur=10', '-c:a', 'libopus', '-f', 'webm', voicePath])
  const manifest = { durationMs: 10_000, layers: { slides: { file: 'slides.webm', bytes: statSync(join(rec, 'slides.webm')).size, startMs: 0 }, camera: { file: 'camera.webm', bytes: statSync(join(rec, 'camera.webm')).size, startMs: 500 }, } }
  const pictures = resolvePictureLayers(userData, runId, manifest, 10_000)
  assert.equal(pictures.missing.length, 0)
  const noCamera = resolvePictureLayers(userData, runId, { layers: { ...manifest.layers, camera: { file: 'camera.seg-1.webm', bytes: 5, startMs: 0 } } }, 10_000)
  assert.deepEqual(noCamera.missing, [{ layer: 'camera', file: 'camera.seg-1.webm' }])
  const layers = { runId, durationMs: 10_000, ...pictures, voice: [{ path: voicePath, startMs: 0, endMs: 10_000 }] }
  pass('a missing layer file is named, not fatal')

  const preparer = createPlaybackPreparer({ userDataDir: () => userData, ffmpeg: () => ffmpeg })
  const set = await preparer.prepare(layers)
  assert.equal(set.voice, 'voice.webm'); assert.deepEqual(set.slides.map((s) => s.name), ['slides-0.webm']); assert.deepEqual(set.camera.map((s) => [s.name, s.startMs]), [['camera-0.webm', 500]])
  assert.ok(playbackFile(userData, runId, set.identity, 'voice.webm'))
  assert.equal(playbackFile(userData, runId, set.identity, '../capture.json'), null); assert.equal(playbackFile(userData, '../x', set.identity, 'voice.webm'), null)
  const voiceCopy = await inspectMedia(ffmpeg, playbackFile(userData, runId, set.identity, 'voice.webm'))
  assert.ok(Math.abs(voiceCopy.durationMs - 10_000) < 80, `voice copy spans the Run: ${voiceCopy.durationMs}`)
  assert.equal((await preparer.prepare(layers)).identity, set.identity, 'a second open reuses the copies')
  assert.deepEqual(readdirSync(rec).sort(), ['camera.webm', 'slides.webm'], 'the recording folder is untouched')
  pass('playback copies are made once in app data, served only by checked name, and the recording is untouched')

  const out = join(root, 'out'); mkdirSync(out)
  const exporter = createVideoExporter({ ffmpeg: () => ffmpeg })
  const states = []
  const done = await exporter.run({
    layers, cuts: [{ start: 0, end: 1000 }, { start: 8000, end: 10_000 }], camera: true, extras: { captions: true, chapterList: true, sound: true },
    destination: join(out, 'talk.mp4'), replace: true, title: 'Fixture', enters: [{ tMs: 0, slideId: 'a' }, { tMs: 6000, slideId: 'b' }], slides: { a: { title: 'Blue' }, b: { title: 'Green' } },
    words: [{ text: 'Tone', start: 1200, end: 2000 }, { text: 'gone', start: 300, end: 700 }], segments: []
  }, (s) => states.push(s.state))
  assert.equal(done.state, 'done', JSON.stringify(done))
  assert.ok(states.includes('working'))
  assert.deepEqual(readdirSync(out).sort(), ['talk chapters.txt', 'talk.m4a', 'talk.mp4', 'talk.srt', 'talk.vtt'])
  const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', join(out, 'talk.mp4'), '-f', 'null', '-'], { encoding: 'utf8' }).stderr
  assert.match(probe, /Video: h264[^\n]*1920x1080[^\n]*30 fps/); assert.match(probe, /Audio: aac[^\n]*48000 Hz/)
  assert.ok(Math.abs(done.durationMs - 7000) <= 34); assert.equal(done.chapters, 2)
  assert.equal(readFileSync(join(out, 'talk chapters.txt'), 'utf8'), '0:00 Blue\n0:05 Green\n')
  assert.equal(readFileSync(join(out, 'talk.srt'), 'utf8'), '1\n00:00:00,200 --> 00:00:01,000\nTone\n')
  const frame = (at, x, y) => {
    const r = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(at), '-i', join(out, 'talk.mp4'), '-frames:v', '1', '-vf', `crop=8:8:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { timeout: 30_000 })
    return [...r.stdout]
  }
  const [cr, cg, cb] = frame(1, rect.x + rect.width / 2, rect.y + rect.height / 2)
  assert.ok(cr > 180 && cg < 80 && cb < 80, `camera rectangle shows the camera: ${[cr, cg, cb]}`)
  const [sr, sg, sb] = frame(1, 100, 100)
  assert.ok(sb > 150 && sr < 80, `slides behind it: ${[sr, sg, sb]}`)
  const [gr, gg, gb] = frame(5.5, 100, 100)
  assert.ok(gg > 80 && gb < 80 && gr < 80, `after the cut at the start, edited 5.5 s is Run 6.5 s: green ${[gr, gg, gb]}`)
  pass('the exported MP4 has the edited length, H.264 and AAC, chapters, captions, sound only, and the camera in its rectangle')

  const second = await exporter.run({ ...{ layers, cuts: [], camera: false, extras: { captions: true, chapterList: false, sound: false }, destination: join(out, 'talk.mp4'), replace: true, title: 'x', enters: [], slides: {}, words: [], segments: [] } }, () => {})
  assert.equal(second.state, 'done')
  assert.ok(existsSync(join(out, 'talk (2).srt')), 'an existing captions file is not replaced')
  const [r2, g2, b2] = frame(1, rect.x + rect.width / 2, rect.y + rect.height / 2)
  assert.ok(b2 > 150 && r2 < 80, `camera off leaves the slides there: ${[r2, g2, b2]}`)
  pass('re-export replaces only the chosen file; camera off is honoured')

  const cancelOut = join(root, 'cancel'); mkdirSync(cancelOut)
  const pending = exporter.run({ layers, cuts: [], camera: true, extras: { captions: false, chapterList: false, sound: false }, destination: join(cancelOut, 'c.mp4'), replace: true, title: 'c', enters: [], slides: {}, words: [], segments: [] }, () => {})
  assert.equal((await exporter.run({ layers, cuts: [], camera: true, extras: { captions: false, chapterList: false, sound: false }, destination: join(cancelOut, 'd.mp4'), replace: true, title: 'd', enters: [], slides: {}, words: [], segments: [] }, () => {})).state, 'failed', 'one export at a time')
  await new Promise((r) => setTimeout(r, 150)); exporter.cancel()
  assert.equal((await pending).state, 'cancelled')
  assert.deepEqual(readdirSync(cancelOut), [], 'a cancelled export leaves no file at all')
  const failOut = join(root, 'missing-folder', 'f.mp4')
  const failed = await exporter.run({ layers, cuts: [], camera: true, extras: { captions: false, chapterList: false, sound: false }, destination: failOut, replace: true, title: 'f', enters: [], slides: {}, words: [], segments: [] }, () => {})
  assert.equal(failed.state, 'failed'); assert.match(failed.message, /recording and your edits are safe/)
  pass('one export at a time; a cancelled or failed export leaves nothing under the chosen name')

  const audioLayers = { runId, durationMs: 10_000, slides: [], camera: [], missing: [], voice: layers.voice }
  const sound = await exporter.run({ layers: audioLayers, cuts: [{ start: 0, end: 2000 }], camera: true, extras: { captions: false, chapterList: true, sound: true }, destination: join(out, 'voice.m4a'), replace: true, title: 'v', enters: [], slides: {}, words: [], segments: [] }, () => {})
  assert.equal(sound.state, 'done'); assert.deepEqual(sound.extras, [])
  const soundProbe = await inspectMedia(ffmpeg, join(out, 'voice.m4a'))
  assert.equal(soundProbe.video, null); assert.ok(Math.abs(soundProbe.durationMs - 8000) < 80)
  pass('a Run without picture exports sound (and captions) only')
} finally {
  rmSync(root, { recursive: true, force: true })
}
