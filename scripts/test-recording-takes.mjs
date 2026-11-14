// Release 0.44.5, Record one slide again (the record-and-edit-video design of 10 Nov 2026, contract
// "retake"): the video clock, the chosen take in the edits file, the resolved plan and a real export.
// Plain Node; ffmpeg-static stands in for the app's bundled ffmpeg.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyEditOp, emptyEdits, parseEditsText, serialiseEdits } from '../src/shared/recording-edits.ts'
import { captionCues, chaptersFor, toSrt, toWebVtt } from '../src/shared/recording-video.ts'
import { captionCuesOf, planDigest, resolveRecording } from '../src/shared/recording-editor.ts'
import { clipsOnVideoClock, fromVideoClock, isTakeRun, parseRetake, RECORD_AGAIN_ENV, rowTakeControls, takesEnabled, takesInUse, verifyRetake, rangesToVideoClock, takeAt, takeClock, toVideoClock, videoClockMs } from '../src/shared/recording-takes.ts'
import { createVideoExporter, layersOnVideoClock, resolvePictureLayers } from '../src/main/recording-video.ts'
import { makeEditorFixture } from './fixtures/recording-editor-fixture.mjs'
import { listRuns } from '../src/main/runs.ts'
import { listKeptRuns, runAtHome } from '../src/main/recording-paths.ts'
import { collectSessions } from '../src/main/sessions-list.ts'

let count = 0
const pass = (name) => console.log(`PASS ${++count} ${name}`)
const root = mkdtempSync(join(tmpdir(), 'tw-recording-takes-'))
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
const gen = (args) => { const r = spawnSync(ffmpeg, ['-v', 'error', '-y', '-threads', '2', ...args], { timeout: 300_000 }); assert.equal(r.status, 0, r.stderr?.toString()) }
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

try {
  // ---- The video clock ------------------------------------------------------------------------------
  {
    const clock = takeClock([{ at: 4000, length: 2500, run: 'take-b', change: 4000, end: 8000 }])
    assert.equal(toVideoClock(clock, 3999), 3999); assert.equal(toVideoClock(clock, 4000), 4000, 'the slide start is the take start')
    assert.equal(toVideoClock(clock, 4001), 6501); assert.equal(toVideoClock(clock, 9000), 11_500)
    assert.equal(fromVideoClock(clock, 5000), 4000, 'inside the take: the slide start'); assert.equal(fromVideoClock(clock, 11_500), 9000); assert.equal(fromVideoClock(clock, 1000), 1000)
    assert.deepEqual(takeAt(clock, 5000), { insert: clock.inserts[0], takeMs: 1000 }); assert.equal(takeAt(clock, 7000), null)
    assert.equal(videoClockMs(clock, 12_000), 14_500)
    assert.deepEqual(rangesToVideoClock(clock, [{ start: 1000, end: 2000 }, { start: 3000, end: 5000 }, { start: 4000, end: 8000 }]), [{ start: 1000, end: 2000 }, { start: 3000, end: 4000 }, { start: 6500, end: 7500 }, { start: 6500, end: 10_500 }], 'a range across the slide start is split around the take')
    const pieces = clipsOnVideoClock(clock, [{ startMs: 100, endMs: 12_000, file: 'slides.webm' }], () => [{ startMs: 200, endMs: 2600, file: 'take.webm' }], (c, first) => (first ? 0 : c.startMs))
    assert.deepEqual(pieces.map((p) => [p.file, p.startMs, p.endMs, p.offsetMs, p.shownFromMs]), [['slides.webm', 100, 4000, 0, 0], ['slides.webm', 6500, 14_500, 3900, 6500], ['take.webm', 4200, 6500, 0, 4000]], 'the Run\'s file in two pieces, the take\'s file in between, its first frame held from the take start')
    pass('the video clock: a take goes in at its slide start; Run time, ranges and files move with it')
  }

  // ---- Off in 0.44.5 (takesEnabled): no control offers it, no choice is used, main refuses a retake ----
  {
    assert.equal(RECORD_AGAIN_ENV, 'TW_RECORD_AGAIN')
    assert.equal(takesEnabled({ packaged: true, flag: '1' }), false, 'never in a release build')
    assert.equal(takesEnabled({ packaged: false, flag: undefined }), false, 'off in development unless asked for')
    assert.equal(takesEnabled({ packaged: false, flag: '1' }), true, 'the development override')
    const row = { hasPicture: true, slideId: 'b', leftOut: false, takes: 2 }
    assert.deepEqual(rowTakeControls(false, row), { recordAgain: false, chooser: false }, 'off: no Record this slide again, no Which take of slide n?')
    assert.deepEqual(rowTakeControls(true, row), { recordAgain: true, chooser: true })
    assert.deepEqual(rowTakeControls(true, { ...row, leftOut: true }), { recordAgain: false, chooser: false })
    assert.deepEqual(takesInUse(false, [{ change: 4000, run: 'sess-take' }]), [], 'off: a choice in the edits file is not used')
    assert.deepEqual(takesInUse(true, [{ change: 4000, run: 'sess-take' }]), [{ change: 4000, run: 'sess-take' }])
    // The editor and Studio's panel read these, and main decides once and refuses a retake before anything else.
    const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    const editor = read('src/renderer/src/components/recording/RecordingEditor.tsx'), panel = read('src/renderer/src/components/recording/RecordingPanel.tsx')
    assert.match(editor, /const takesOn = !!opened\?\.recordAgain/); assert.match(editor, /rowTakeControls\(takesOn, \{ hasPicture[^}]*\}\)\.recordAgain \?/); assert.match(editor, /if \(!takesOn\) return null/)
    assert.match(panel, /takesInUse\(takesOn, savedChoices\)/)
    const main = read('src/main/index.ts')
    assert.match(main, /const TAKES_ENABLED = takesEnabled\(\{ packaged: app\.isPackaged, flag: process\.env\[RECORD_AGAIN_ENV\] \}\)/)
    const present = main.slice(main.indexOf("ipcMain.handle('talk:present'"))
    assert.ok(present.indexOf('if (asked && !TAKES_ENABLED) return { success: false, error: TAKES_OFF_ERROR }') > 0 && present.indexOf('if (asked && !TAKES_ENABLED)') < present.indexOf('verifyRetake('), 'talk:present refuses a retake first')
    assert.ok((main.match(/takesEnabled: \(\) => TAKES_ENABLED/g) ?? []).length === 2, 'both recording IPCs are told')
    pass('Record one slide again is off unless a development build sets TW_RECORD_AGAIN=1: no row control, no choice used, main refuses a retake')
  }

  // ---- The chosen take is an edit ------------------------------------------------------------------
  {
    const D = 12_000
    let e = applyEditOp(emptyEdits(), { kind: 'take', change: 4000, run: 'sess-take-1' }, D)
    assert.deepEqual(e.takes, [{ change: 4000, run: 'sess-take-1' }]); assert.equal(e.undo.length, 1)
    assert.equal(applyEditOp(e, { kind: 'take', change: 4000, run: 'sess-take-1' }, D), e, 'no change is no step')
    const back = applyEditOp(e, { kind: 'take', change: 4000, run: null }, D)
    assert.deepEqual(back.takes, [], 'Use the first take'); assert.deepEqual(applyEditOp(back, { kind: 'undo' }, D).takes, e.takes, 'undo brings the new take back')
    assert.throws(() => applyEditOp(e, { kind: 'take', change: 4000, run: '../x' }, D), /Invalid take/)
    const read = parseEditsText(serialiseEdits(e), D)
    assert.ok(read.ok); assert.deepEqual(read.edits.takes, e.takes); assert.deepEqual(read.edits.undo, e.undo)
    assert.equal(parseEditsText(serialiseEdits({ ...e, takes: [{ change: 1, run: 'a b' }] }), D).problem?.kind, 'corrupt')
    assert.deepEqual(parseRetake({ runId: 'sess-1', change: 4000.4, slideId: 'b', slideN: 2, camera: true }), { runId: 'sess-1', change: 4000, slideId: 'b', slideN: 2, camera: true })
    for (const bad of [null, { runId: '../x', change: 1, slideId: 'b', slideN: 2, camera: true }, { runId: 'a', change: 'x', slideId: 'b', slideN: 2, camera: true }, { runId: 'a', change: 1, slideId: 'b', slideN: 0, camera: true }, { runId: 'a', change: 1, slideId: 'b', slideN: 2 }])
      assert.equal(parseRetake(bad), null)
    pass('the chosen take is stored in the edits file, one undo step; Use the first take puts it back; a retake request is checked')
  }

  // ---- The resolved plan with a take (a generated talk: words, pauses, three slides) ----------------
  const fx = makeEditorFixture({ slides: 3, wordsPerSlide: 20, seed: 3 })
  const marks = fx.marks, transcript = fx.transcript, D = fx.durationMs
  const titles = { s1: { title: 'A' }, s2: { title: 'B' }, s3: { title: 'C' } }
  const none = resolveRecording({ durationMs: D, edits: emptyEdits(), marks, transcript })
  const B = none.rows.find((x) => x.slideId === 's2'), C = none.rows.find((x) => x.slideId === 's3')
  {
    assert.equal(none.replacedRows.size, 0); assert.equal(none.clockMs, D)
    const r = resolveRecording({ durationMs: D, edits: emptyEdits(), marks, transcript, takes: [{ change: B.change, run: 'take-b', durationMs: 2500 }] })
    const b = r.rows.find((x) => x.change === B.change)
    assert.equal(r.replacedRows.get(b.index), 'take-b')
    assert.equal(Math.abs(r.editedMs - (none.editedMs - (b.end - b.start) + 2500)) <= 34, true, 'the slide\'s own stretch is replaced by the take')
    const chapters = chaptersFor(r.chapterMarks, titles, r.spans).map((c) => [c.title, c.startMs])
    const shift = 2500 - (b.end - b.start)
    assert.deepEqual(chapters.map((c) => c[0]), ['A', 'B', 'C'])
    assert.ok(Math.abs(chapters[1][1] - b.start) <= 34, 'B starts where the take starts')
    assert.ok(Math.abs(chapters[2][1] - (C.enterMs + shift)) <= 34, 'C moves by the difference in length')
    const kept = captionCues(r.captionWords, r.spans).cues.map((c) => c.text).join(' ')
    const bWords = transcript.words.slice(b.firstWord, b.endWord).map((w) => w.text).join(' ')
    assert.ok(!kept.includes(bWords), 'the first take\'s words of B leave the captions')
    assert.ok(r.captionWords.every((w, k, all) => k === 0 || w.start >= all[k - 1].start), 'caption words stay in order on the video clock')
    const firstC = r.captionWords.find((w) => w.order === C.firstWord)
    assert.equal(firstC.start, transcript.words[C.firstWord].alignment.start + 2500, 'a word after the take moves by the take\'s length on the video clock')
    const leftOut = resolveRecording({ durationMs: D, edits: { ...emptyEdits(), leftOut: [B.change] }, marks, transcript, takes: [{ change: B.change, run: 'take-b', durationMs: 2500 }] })
    assert.equal(leftOut.replacedRows.size, 0, 'a slide left out plays no take either')
    pass('the plan with a take: the slide\'s stretch replaced, length, chapters and captions on the video clock')
  }

  // ---- Captions with a take: segments only (review blocker), the take's own words, never another's ----
  {
    const marks3 = [{ event: 'enter', slideId: 'a', tMs: 0 }, { event: 'enter', slideId: 'b', tMs: 4000 }, { event: 'enter', slideId: 'c', tMs: 8000 }]
    const segOnly = { words: [], segments: [{ start: 1000, end: 1500, text: 'Slide A says this.' }, { start: 4500, end: 5000, text: 'Old B words.' }, { start: 9000, end: 10_000, text: 'Slide C says that.' }] }
    const take = { change: 4000, run: 'take-b', durationMs: 2500 }
    const r = resolveRecording({ durationMs: 12_000, edits: emptyEdits(), marks: marks3, transcript: segOnly, takes: [{ ...take, words: null }] })
    assert.equal(r.captionSource, 'segments'); assert.equal(r.takesWithoutWords, 1)
    const cues = captionCuesOf(r).cues
    assert.deepEqual(cues.map((c) => [c.text, c.startMs]), [['Slide A says this.', 1000], ['Slide C says that.', 7500]], 'the old B segment is gone and C is on the video clock')
    assert.ok(!toSrt(cues).includes('Old B') && !toWebVtt(cues).includes('Old B'), 'SRT and WebVTT alike')
    // The take's own words, once written out, caption its stretch; the first take's never come back.
    const withWords = resolveRecording({ durationMs: 12_000, edits: emptyEdits(), marks: marks3, transcript: segOnly, takes: [{ ...take, words: [{ text: 'New', start: 300, end: 600 }, { text: 'B', start: 700, end: 900 }] }] })
    assert.equal(withWords.takesWithoutWords, 0)
    assert.deepEqual(captionCuesOf(withWords).cues.map((c) => [c.text, c.startMs]), [['Slide A says this.', 1000], ['New B', 4300], ['Slide C says that.', 7500]])
    assert.notEqual(planDigest(withWords), planDigest(r), 'the fingerprint covers the cues written')
    // Timed words, all of them deliberately cut: no captions, never the transcript's segments.
    const timed = { words: [{ text: 'Only', start: 4500, end: 4800 }, { text: 'B', start: 4900, end: 5100 }], segments: segOnly.segments }
    const allCut = resolveRecording({ durationMs: 12_000, edits: emptyEdits(), marks: marks3, transcript: timed, takes: [{ ...take, words: null }] })
    assert.equal(allCut.captionSource, 'words'); assert.deepEqual(captionCuesOf(allCut).cues, [], 'no resurrected segments')
    pass('captions with a new take: segments on the video clock without the replaced slide\'s; the take\'s own words once written; timed words never fall back to segments')
  }

  // ---- A retake request is checked against the Run on disk (review item 4) --------------------------
  {
    const parent = { id: 'sess-1', talkSlug: 'talk', slideTimeIndex: [{ event: 'enter', slideId: 'a', tMs: 120 }, { event: 'enter', slideId: 'b', tMs: 4000.4 }], capture: { layers: { slides: { bytes: 10 }, camera: { bytes: 0, segments: [{ bytes: 5 }] } } } }
    const ask = { runId: 'sess-1', change: 4000, slideId: 'b', slideN: 2, camera: false }
    const ok = verifyRetake(ask, parent, 'talk')
    assert.ok(ok.ok); assert.equal(ok.retake.camera, true, 'the camera choice is the Run\'s, not the request\'s')
    assert.equal(verifyRetake({ ...ask, camera: true }, { ...parent, capture: { layers: { slides: { bytes: 10 } } } }, 'talk').retake.camera, false)
    assert.ok(verifyRetake({ ...ask, change: 0, slideId: 'a' }, parent, 'talk').ok, 'the first slide is change 0')
    for (const [why, req, p, slug] of [
      ['no such Run', ask, null, 'talk'],
      ['another talk', ask, parent, 'other'],
      ['another Run', { ...ask, runId: 'sess-2' }, parent, 'talk'],
      ['a slide it did not record', { ...ask, slideId: 'z' }, parent, 'talk'],
      ['a slide at another change', { ...ask, change: 8000 }, parent, 'talk'],
      ['a take of a take', ask, { ...parent, takeOf: { runId: 'sess-0', change: 1 } }, 'talk'],
      ['a Run with no slides picture', ask, { ...parent, capture: null }, 'talk']
    ]) assert.equal(verifyRetake(req, p, slug).ok, false, why)
    // In main: only the Tools window may ask, the request is checked before any context is registered,
    // and the context registered is the checked one.
    const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
    const start = main.indexOf("ipcMain.handle('talk:present'"), body = main.slice(start, main.indexOf('\nipcMain.handle(', start + 10))
    const at = (needle) => { const i = body.indexOf(needle); assert.ok(i > 0, `talk:present has ${needle}`); return i }
    assert.ok(at('isToolsWindowSender(event.sender, toolsWindow)') < at('verifyRetake(') && at('verifyRetake(') < at('registerRecordingContext('), 'sender, then truth, then the context')
    assert.match(body, /plannedRunId\) \|\| pathwayId\)\) return \{ success: false, error: 'Invalid retake' \}/, 'a retake with a planned Run or a pathway is refused')
    assert.match(body, /retake = verified\.retake/)
    assert.match(body, /verifyRetake\(requested, runAtHome\(root, /, 'the Run is read at exactly the home the take is saved in')
    // runAtHome: a vault's Run, or a Run kept in app data, never one for the other.
    const vault = join(root, 'home-vault'), ud = join(root, 'home-ud')
    mkdirSync(join(vault, '_PRESENTATIONS', 'talk'), { recursive: true }); mkdirSync(join(ud, 'recordings'), { recursive: true })
    const inVault = { id: 'sess-v', talkSlug: 'talk' }, kept = { id: 'sess-k', talkSlug: 'talk' }
    writeFileSync(join(vault, '_PRESENTATIONS', 'talk', 'sess-v.json'), JSON.stringify(inVault))
    writeFileSync(join(ud, 'recordings', 'sess-k.json'), JSON.stringify(kept))
    assert.deepEqual(runAtHome(vault, ud, 'talk', 'sess-v'), inVault)
    assert.equal(runAtHome(vault, ud, 'talk', 'sess-k'), null, 'a Run kept in app data is not found through a vault')
    assert.deepEqual(runAtHome(null, ud, 'talk', 'sess-k'), kept)
    assert.equal(runAtHome(null, ud, 'talk', 'sess-v'), null, 'nor a vault Run through app data')
    assert.equal(runAtHome(vault, ud, 'other', 'sess-v'), null, 'nor another talk\'s')
    pass('a retake request: the Run in the presented talk, a slide it recorded, its own camera choice; Tools window only; checked before its context is registered')
  }

  // ---- Without precise word timing: the chapter and the captions keep to their side of the take (re-check item 1) ----
  {
    const un = makeEditorFixture({ slides: 3, wordsPerSlide: 20, seed: 3, aligned: false })
    const base = resolveRecording({ durationMs: un.durationMs, edits: emptyEdits(), marks: un.marks, transcript: un.transcript })
    const b = base.rows[1], at = Math.round(b.start)
    const lastA = un.transcript.words.filter((w) => w.start < b.start).at(-1)
    const r = resolveRecording({ durationMs: un.durationMs, edits: emptyEdits(), marks: un.marks, transcript: un.transcript, takes: [{ change: b.change, run: 't', durationMs: 2500, words: [{ text: 'Hello', start: 100, end: 600 }, { text: 'again.', start: 700, end: 1200 }] }] })
    const chapters = chaptersFor(r.chapterMarks, { s1: { title: 'A' }, s2: { title: 'B' }, s3: { title: 'C' } }, r.spans)
    const B = chapters.find((c) => c.title === 'B'), A = chapters.find((c) => c.title === 'A')
    assert.ok(Math.abs(B.startMs - at) <= 34, `B's chapter starts where the take starts (${B.startMs} vs ${at})`)
    assert.ok(B.endMs - B.startMs >= 2500 - 34, `B's chapter covers the take (${B.endMs - B.startMs} ms)`)
    assert.ok(A.endMs <= at + 34, 'A\'s chapter ends at the take')
    const cues = captionCuesOf(r).cues
    const over = cues.filter((c) => c.startMs < at + 2500 && c.endMs > at && !/Hello|again/.test(c.text))
    assert.deepEqual(over, [], `no Run caption stays up over the take (last A word ${lastA.start}–${lastA.end} ms, slide change ${b.start})`)
    const hello = cues.find((c) => /Hello/.test(c.text))
    assert.ok(hello && hello.startMs >= at && hello.startMs < at + 500, `the take's words are in the take (${hello?.startMs})`)
    for (const text of [toSrt(cues), toWebVtt(cues)]) assert.ok(text.includes('Hello'))
    pass('without precise word timing: B\'s chapter starts and runs with the take; a word across the slide change keeps to its side; the take\'s words are in the take')
  }

  // ---- Takes stay out of every list of Runs (review item 3) ----------------------------------------
  {
    const vault = join(root, 'vault'), runsDir = join(vault, '_PRESENTATIONS', 'talk'), ud = join(root, 'ud'), rec = join(ud, 'recordings')
    mkdirSync(runsDir, { recursive: true }); mkdirSync(rec, { recursive: true })
    const run = { id: 'sess-run', talkSlug: 'talk', talkTitle: 'Talk', kind: 'recording', status: 'delivered', startedAt: '2026-11-12T10:00:00Z', recordingMs: 12_000 }
    const take = { ...run, id: 'sess-take', startedAt: '2026-11-12T11:00:00Z', recordingMs: 2500, takeOf: { runId: 'sess-run', change: 4000, slideId: 'b' } }
    for (const r of [run, take]) { writeFileSync(join(runsDir, `${r.id}.json`), JSON.stringify(r)); writeFileSync(join(rec, `${r.id}.json`), JSON.stringify(r)) }
    assert.equal(isTakeRun(take), true); assert.equal(isTakeRun(run), false); assert.equal(isTakeRun({ takeOf: 'x' }), false)
    assert.deepEqual(listRuns(vault).map((r) => r.id), ['sess-run'], 'History and every list built on listRuns')
    assert.deepEqual(listRuns(vault, 'talk', undefined, true).map((r) => r.id).sort(), ['sess-run', 'sess-take'], 'asked for: take discovery and deletion')
    assert.deepEqual(listRuns(vault, undefined, { strictSessionId: 'sess-take' }).map((r) => r.id).sort(), ['sess-run', 'sess-take'], 'id checks see takes')
    assert.deepEqual(listKeptRuns(ud).map((r) => r.id), ['sess-run']); assert.equal(listKeptRuns(ud, 'talk', undefined, true).length, 2)
    const sessions = collectSessions([{ id: 'v', root: vault }], [], undefined, undefined, true)
    assert.ok(!JSON.stringify(sessions).includes('sess-take'), 'Sessions, with every kind, leave the take out')
    pass('takes are left out of History, Sessions and kept Runs; asked for, they are there for take discovery, deletion and id checks')
  }

  // ---- A real export with a new take ---------------------------------------------------------------
  {
    const userData = join(root, 'userData')
    const make = (runId, colours, tone, seconds) => {
      const folder = join(userData, 'recordings', runId)
      mkdirSync(folder, { recursive: true })
      const inputs = colours.flatMap(([c, d]) => ['-f', 'lavfi', '-i', `color=c=${c}:s=320x180:r=30:d=${d}`])
      gen([...inputs, '-filter_complex', `${colours.map((_, i) => `[${i}]`).join('')}concat=n=${colours.length}:v=1`, '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '200k', '-f', 'webm', join(folder, 'slides.webm')])
      const voice = join(userData, 'recordings', `${runId}.webm`)
      gen(['-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${seconds}`, '-c:a', 'libopus', '-f', 'webm', voice])
      const pictures = resolvePictureLayers(userData, runId, { layers: { slides: { file: 'slides.webm', bytes: statSync(join(folder, 'slides.webm')).size, startMs: 0 } } }, seconds * 1000)
      return { runId, durationMs: seconds * 1000, ...pictures, voice: [{ path: voice, startMs: 0, endMs: seconds * 1000 }], files: [join(folder, 'slides.webm'), voice] }
    }
    const secs = D / 1000, bS = B.enterMs / 1000, cS = C.enterMs / 1000
    const run = make('sess-parent', [['blue', bS], ['green', cS - bS], ['blue', secs - cS]], 300, secs)
    const take = make('sess-take', [['red', 2.5]], 900, 2.5)
    const hashes = [...run.files, ...take.files].map(sha)
    const r = resolveRecording({ durationMs: D, edits: emptyEdits(), marks, transcript, takes: [{ change: B.change, run: 'sess-take', durationMs: 2500 }] })
    const b = r.rows.find((x) => x.change === B.change)
    const onClock = { ...run, ...layersOnVideoClock(run, new Map([['sess-take', take]]), r.clock, r.clockMs) }
    const exporter = createVideoExporter({ ffmpeg: () => ffmpeg })
    const out = join(root, 'out'); mkdirSync(out)
    const done = await exporter.run({ layers: onClock, cuts: r.clockCuts, camera: true, evenVolume: false, smoothJoins: false, extras: { captions: true, chapterList: true, sound: false }, destination: join(out, 'take.mp4'), replace: true, title: 'Take', enters: r.chapterMarks, slides: titles, words: r.captionWords, segments: [] }, () => {})
    assert.equal(done.state, 'done', JSON.stringify(done))
    assert.ok(Math.abs(done.durationMs - r.editedMs) <= 34, `the video is the edited length (${done.durationMs} vs ${r.editedMs})`)
    const colourAt = (sec) => { const p = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(sec), '-i', done.file, '-frames:v', '1', '-vf', 'scale=4:4,format=rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 }).stdout; const [R, G, B] = [p[15], p[16], p[17]]; return R > 150 && G < 90 ? 'red' : G > 100 && R < 90 && B < 90 ? 'green' : B > 150 && R < 90 ? 'blue' : `${R},${G},${B}` }
    const toneAt = (sec) => { const pcm = new Int16Array(new Uint8Array(spawnSync(ffmpeg, ['-v', 'error', '-ss', String(sec), '-t', '0.2', '-i', done.file, '-map', '0:a:0', '-f', 's16le', '-ar', '48000', '-ac', '1', '-'], { maxBuffer: 1 << 22 }).stdout).buffer); let z = 0; for (let i = 1; i < pcm.length; i++) if ((pcm[i - 1] < 0) !== (pcm[i] < 0)) z++; return Math.round((z / 2) / (pcm.length / 48000)) }
    const takeMid = (b.start + 1250) / 1000
    console.log(`  slide B ran ${b.start}–${b.end} ms; the take plays from ${b.start} ms for 2500 ms; colours: ${colourAt(1)}, ${colourAt(takeMid)}, ${colourAt((b.start + 2500 + 1000) / 1000)}; tones: ${toneAt(1)} Hz, ${toneAt(takeMid)} Hz, ${toneAt((b.start + 3000) / 1000)} Hz`)
    const afterTake = (b.start + 2500 + (C.enterMs - b.end) + 1000) / 1000
    assert.equal(colourAt(1), 'blue'); assert.equal(colourAt(takeMid), 'red', 'the new take\'s picture plays where slide B was'); assert.equal(colourAt(afterTake), 'blue', 'then slide C')
    assert.ok(Math.abs(toneAt(takeMid) - 900) < 40, 'the new take\'s voice plays there'); assert.ok(Math.abs(toneAt(1) - 300) < 20 && Math.abs(toneAt(afterTake) - 300) < 20, 'the Run\'s voice before and after')
    const listed = readFileSync(join(out, 'take chapters.txt'), 'utf8').trim().split('\n').map((l) => l.split(' ')[1])
    assert.deepEqual(listed, ['A', 'B', 'C'], 'the chapter list names every slide')
    assert.deepEqual([...run.files, ...take.files].map(sha), hashes, 'neither recording is changed')
    // Use the first take again: the Run as recorded.
    const first = resolveRecording({ durationMs: D, edits: emptyEdits(), marks, transcript, takes: [] })
    const again = await exporter.run({ layers: run, cuts: first.clockCuts, camera: true, evenVolume: false, smoothJoins: false, extras: { captions: false, chapterList: false, sound: false }, destination: join(out, 'first.mp4'), replace: true, title: 'First', enters: first.chapterMarks, slides: {}, words: [], segments: [] }, () => {})
    assert.equal(again.state, 'done'); assert.ok(Math.abs(again.durationMs - first.editedMs) <= 34)
    pass('a real export plays the new take where its slide was (picture and voice), with chapters after it; the first take restores the recording as it was')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
