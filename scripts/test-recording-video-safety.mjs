// PR 347 review round: one test per finding, each the reviewer's reproduction turned into an assertion.
// Plain Node; ffmpeg-static stands in for the app's ffmpeg where a real encode is needed.
import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { applyEditOp, effectiveCuts, emptyEdits, EDITS_MAX_BYTES, EDITS_WRITE_BUDGET, fitEditsBudget, parseEdits, recordingFingerprint, serialiseEdits } from '../src/shared/recording-edits.ts'
import { captionCues, keptSpans, toSrt, toWebVtt } from '../src/shared/recording-video.ts'
import { createRecordingEditsStore, writeTextAtomic } from '../src/main/recording-edits-store.ts'
import { createOwnedFile, createPlaybackPreparer, createTempRecord, createVideoExporter, exclusiveCopy, EXPORT_TEMP_NAME, identifies, inspectMedia, isSameFile, playbackFile, publishExclusive, removePlaybackCopies, resolvePictureLayers } from '../src/main/recording-video.ts'
import { createWarmSources } from '../src/main/recording-warm.ts'
import { shortcutEventMatches } from '../src/shared/shortcut-registry.ts'
import { exportDestination, pr316Source } from '../src/main/recording-video-ipc.ts'

let count = 0
const pass = (name) => console.log(`PASS ${++count} ${name}`)
const root = mkdtempSync(join(tmpdir(), 'tw-recording-safety-'))
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
const D = 60_000
const gen = (args) => { const r = spawnSync(ffmpeg, ['-v', 'error', '-y', '-threads', '2', ...args], { timeout: 300_000 }); assert.equal(r.status, 0, r.stderr?.toString()) }
try {
  // ---- 1. Links in the playback cache path are never followed --------------------------------------
  {
    const userData = join(root, 'u1'), outside = join(root, 'outside'), victim = join(outside, 'a'.repeat(24))
    mkdirSync(join(userData, 'recordings', 'sess-one'), { recursive: true }); mkdirSync(victim, { recursive: true })
    writeFileSync(join(victim, 'sentinel'), 'keep')
    writeFileSync(join(userData, 'recordings', 'sess-one', 'slides.webm'), 'x')
    const layers = { runId: 'sess-one', durationMs: 1000, slides: [], camera: [], missing: [], voice: [] }
    // The whole cache root is a link to an unrelated folder holding a 24-hex folder.
    symlinkSync(outside, join(userData, 'recording-playback'))
    const preparer = createPlaybackPreparer({ userDataDir: () => userData, ffmpeg: () => ffmpeg })
    await assert.rejects(() => preparer.prepare(layers), /not a plain folder/)
    assert.equal(readFileSync(join(victim, 'sentinel'), 'utf8'), 'keep', 'nothing in the link target is touched')
    // The Run's folder inside a real cache root is a link.
    rmSync(join(userData, 'recording-playback'))
    mkdirSync(join(userData, 'recording-playback'))
    symlinkSync(outside, join(userData, 'recording-playback', 'sess-one'))
    await assert.rejects(() => preparer.prepare(layers), /not a plain folder/)
    assert.equal(readFileSync(join(victim, 'sentinel'), 'utf8'), 'keep')
    assert.equal(playbackFile(userData, 'sess-one', 'a'.repeat(24), 'voice.webm'), null)
    removePlaybackCopies(userData, 'sess-one')
    assert.ok(existsSync(join(victim, 'sentinel')), 'retiring a linked Run folder removes nothing through it')
    assert.ok(lstatSync(join(userData, 'recording-playback', 'sess-one')).isSymbolicLink(), 'an unexpected link is left in place')
    rmSync(join(userData, 'recording-playback', 'sess-one'))
    // Neighbour: the recordings folder itself is a link.
    const u2 = join(root, 'u2'), realRecordings = join(root, 'real-recordings')
    mkdirSync(join(realRecordings, 'sess-two'), { recursive: true }); writeFileSync(join(realRecordings, 'sess-two', 'slides.webm'), 'x')
    mkdirSync(u2); symlinkSync(realRecordings, join(u2, 'recordings'))
    const picture = resolvePictureLayers(u2, 'sess-two', { layers: { slides: { file: 'slides.webm', bytes: 1, startMs: 0 } } }, 1000)
    assert.deepEqual(picture.slides, []); assert.deepEqual(picture.missing, [{ layer: 'slides', file: 'slides.webm' }])
    pass('1: a linked cache root, Run cache folder or recordings folder is refused, never followed or emptied')
  }

  // ---- 2. A folder that cannot be flushed does not turn a committed edit into a failure ---------------
  {
    const folder = join(root, 'flush'); mkdirSync(folder)
    const path = join(folder, 'sess-f.edits.json')
    const store = createRecordingEditsStore({ locate: () => ({ path, runId: 'sess-f', durationMs: D, fingerprint: 'f' }) })
    // As on Windows: opening a folder fails. The store's own flush must absorb it.
    const fs = createRequire(import.meta.url)('node:fs'), realOpen = fs.openSync
    fs.openSync = (p, ...rest) => { if (p === folder) throw Object.assign(Error('EISDIR: illegal operation on a directory, open'), { code: 'EISDIR' }); return realOpen(p, ...rest) }
    syncBuiltinESMExports()
    try {
      const r1 = store.apply({}, { kind: 'trim-start', at: 2000 }, 0)
      assert.equal(r1.edits.revision, 1); assert.equal(JSON.parse(readFileSync(path, 'utf8')).revision, 1)
      const r2 = store.apply({}, { kind: 'trim-end', at: 50_000 }, r1.edits.revision)
      assert.equal(r2.edits.revision, 2, 'the next edit is not refused as a conflict')
      writeFileSync(path, '{ broken')
      assert.ok(store.startFresh({}).keptAs, 'Start new edits also succeeds')
    } finally { fs.openSync = realOpen; syncBuiltinESMExports() }
    pass('2: a folder that cannot be opened for flushing does not fail a committed edit or Start new edits')
  }

  // ---- 3. Extension case and an appended extension -----------------------------------------------------
  {
    assert.deepEqual(exportDestination('/x/lecture.MP4', '.mp4'), { destination: '/x/lecture.MP4', replace: true })
    assert.deepEqual(exportDestination('/x/talk.M4a', '.m4a'), { destination: '/x/talk.M4a', replace: true })
    assert.deepEqual(exportDestination('/x/lecture', '.mp4'), { destination: '/x/lecture.mp4', replace: false })
    assert.deepEqual(exportDestination('/x/lecture.mov', '.mp4'), { destination: '/x/lecture.mov.mp4', replace: false })
    pass('3a: the save panel’s file is used as approved whatever the case of its extension; an added extension is never approved')
  }

  // ---- 4. PR 316 sidecars keep their restorations and their binding -----------------------------------
  {
    const trims = [{ start: 1000, end: 5000 }]
    const v2 = parseEdits({ version: 2, source: 'abc', revision: 3, cuts: [{ start: 20_000, end: 21_000 }], restoredLegacy: [{ start: 2000, end: 3000 }] }, D, { runTrims: trims, legacySource: () => 'abc' })
    assert.ok(v2.ok)
    assert.deepEqual(effectiveCuts(v2.edits.cuts, trims, D, v2.edits.restoredTrims), [{ start: 1000, end: 2000 }, { start: 3000, end: 5000 }, { start: 20_000, end: 21_000 }], 'the restored stretch stays restored')
    const v1 = parseEdits({ version: 1, source: 'old', revision: 1, cuts: [{ start: 1000, end: 2000 }] }, D, { runTrims: trims, legacySource: (v) => (v === 1 ? 'old' : null) })
    assert.ok(v1.ok)
    assert.deepEqual(effectiveCuts(v1.edits.cuts, trims, D, v1.edits.restoredTrims), [{ start: 1000, end: 2000 }])
    assert.equal(parseEdits({ version: 2, source: 'zzz', revision: 1, cuts: [], restoredLegacy: [] }, D, { legacySource: () => 'abc' }).problem.kind, 'stale')
    assert.equal(parseEdits({ version: 2, source: 'abc', revision: 1, cuts: [], restoredLegacy: [] }, D, { legacySource: () => null }).problem.kind, 'stale')
    // The binding is PR 316's: a hash of the Run and its audio files (plus the folder for version 1).
    const folder = join(root, 'legacy'); mkdirSync(folder)
    const media = join(folder, 'a.webm'); writeFileSync(media, 'audio')
    const record = { id: 'sess-l', talkSlug: 't', startedAt: 's', recordingMs: 5, slideTimeIndex: [], audio: { segments: [{ file: 'a.webm' }], gaps: [], audioMs: 5 } }
    const st = statSync(media)
    const parts = [record.id, record.talkSlug, record.startedAt, record.recordingMs, record.slideTimeIndex, record.audio.segments, record.audio.gaps, record.audio.audioMs, [[media, st.dev, st.ino, st.size, st.mtimeMs]]]
    assert.equal(pr316Source(2, folder, record, [media]), createHash('sha256').update(JSON.stringify(parts)).digest('hex'))
    assert.equal(pr316Source(2, folder, record, [join(folder, 'missing.webm')]), null)
    pass('4: version 1 and 2 sidecars migrate with their restorations when their source binding matches, and are refused otherwise')
  }

  // ---- 5. Never write what the same build cannot reopen ----------------------------------------------
  {
    const many = Array.from({ length: 10_000 }, (_, i) => ({ start: i * 5, end: i * 5 + 2 }))
    const huge = { ...emptyEdits(), revision: 1, cuts: many, undo: Array.from({ length: 100 }, () => ({ cuts: many, boundaries: [], leftOut: [] })), redo: [] }
    assert.ok(serialiseEdits(huge).length > EDITS_MAX_BYTES, 'the reviewer’s 10,000 × 100 case is over the read limit')
    const fitted = fitEditsBudget(huge)
    assert.ok(fitted && Buffer.byteLength(serialiseEdits(fitted)) <= EDITS_WRITE_BUDGET); assert.ok(fitted.undo.length < 100 && fitted.undo.length > 0)
    assert.deepEqual(fitted.undo.at(-1), huge.undo.at(-1), 'the newest steps are kept, the oldest dropped')
    const folder = join(root, 'budget'); mkdirSync(folder)
    const path = join(folder, 'sess-b.edits.json')
    writeFileSync(path, serialiseEdits({ ...emptyEdits(), revision: 1, recording: 'fb', cuts: many.slice(0, 3000), undo: Array.from({ length: 90 }, () => ({ cuts: many.slice(0, 3000), boundaries: [], leftOut: [] })), redo: [] }))
    assert.ok(statSync(path).size > EDITS_WRITE_BUDGET && statSync(path).size < EDITS_MAX_BYTES, `fixture ${statSync(path).size} bytes: readable, over the write budget`)
    const store = createRecordingEditsStore({ locate: () => ({ path, runId: 'sess-b', durationMs: 100_000, fingerprint: 'fb' }) })
    store.apply({}, { kind: 'cut', ranges: [{ start: 60_000, end: 61_000 }] }, 1)
    assert.ok(statSync(path).size <= EDITS_WRITE_BUDGET)
    assert.equal(store.get({}).problem, null, 'what was written reopens')
    assert.equal(fitEditsBudget({ ...emptyEdits(), cuts: many }, 1000), null, 'cuts alone over the budget are refused')
    pass('5: over the write budget the oldest history goes first; the store never writes a sidecar it cannot reopen')
  }

  // ---- 9. Edits belong to one recording -------------------------------------------------------------
  {
    const fp = recordingFingerprint({ id: 'sess-x', talkSlug: 't', startedAt: '2026-11-11T09:00:00Z', recordingMs: 9077.4 })
    assert.equal(fp, 't/sess-x@2026-11-11T09:00:00Z/9077')
    const folder = join(root, 'stale'); mkdirSync(folder)
    const path = join(folder, 'sess-x.edits.json')
    const old = createRecordingEditsStore({ locate: () => ({ path, runId: 'sess-x', durationMs: D, fingerprint: 'old-recording' }) })
    old.apply({}, { kind: 'trim-start', at: 3000 }, 0)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).recording, 'old-recording')
    const fresh = createRecordingEditsStore({ locate: () => ({ path, runId: 'sess-x', durationMs: D, fingerprint: fp }) })
    const seen = fresh.get({})
    assert.equal(seen.problem.kind, 'stale'); assert.deepEqual(seen.edits.cuts, [], 'a new recording with the same name does not inherit the old cuts')
    assert.throws(() => fresh.apply({}, { kind: 'trim-end', at: 5000 }, 1), /different recording/)
    const kept = fresh.startFresh({})
    assert.ok(kept.keptAs && existsSync(kept.keptAs))
    pass('9a: a sidecar made for another recording with the same talk and id is refused and kept aside, not applied')
  }

  // ---- 11 and 12. Captions -------------------------------------------------------------------------
  {
    const spans = keptSpans([{ start: 2000, end: 3000 }], 10_000)
    const segments = [{ text: 'Kept whole.', start: 0, end: 1500 }, { text: 'Cut through the middle.', start: 1500, end: 4000 }, { text: 'After.', start: 5000, end: 6000 }]
    const bySegment = captionCues([], spans, segments)
    assert.deepEqual(bySegment.cues.map((c) => c.text), ['Kept whole.', 'After.']); assert.equal(bySegment.leftOut, 1)
    const byWord = captionCues([{ text: 'Cut', start: 1500, end: 1900 }, { text: 'through', start: 2100, end: 2900 }, { text: 'kept', start: 3100, end: 3500 }], spans)
    assert.deepEqual(byWord.cues.map((c) => c.text), ['Cut kept']); assert.equal(byWord.leftOut, 0)
    const tricky = captionCues([{ text: '<i>hi</i>', start: 0, end: 300 }, { text: 'A & B', start: 310, end: 600 }, { text: '{\\an8}\n\nnext', start: 610, end: 900 }, { text: '<00:00:01.000>', start: 910, end: 1000 }], keptSpans([], 10_000)).cues
    const vtt = toWebVtt(tricky), srt = toSrt(tricky)
    assert.match(vtt, /\n&lt;i&gt;hi&lt;\/i&gt; A &amp; B \{\\an8\} next &lt;00:00:01\.000&gt;\n/)
    assert.doesNotMatch(vtt.split('\n').slice(2).join('\n'), /<|\n\n[^0-9]/, 'no markup and no blank line inside a cue')
    assert.match(srt, /\n‹i›hi‹\/i› A & B \(\\an8\) next ‹00:00:01\.000›\n/)
    assert.equal(srt.trim().split(/\n\n/).length, tricky.length, 'one block per cue')
    pass('11, 12: segment captions a cut touches are left out and counted; caption text is escaped for each format')
  }

  // ---- 13. The sidecar's temporary file never stays behind -------------------------------------------
  {
    const folder = join(root, 'tmp'); mkdirSync(folder)
    const target = join(folder, 'sess-t.edits.json')
    assert.throws(() => writeTextAtomic(target, 'x'.repeat(1000), undefined, { write: () => { throw Object.assign(Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) } }), /ENOSPC/)
    assert.deepEqual(readdirSync(folder), [], 'the exclusively created temporary file is removed after a failed write')
    assert.throws(() => writeTextAtomic(target, 'abc', undefined, { write: () => 0 }), /stopped accepting/)
    assert.deepEqual(readdirSync(folder), [])
    writeTextAtomic(target, 'done', undefined, { flushFolder: () => {} })
    assert.deepEqual(readdirSync(folder), ['sess-t.edits.json'])
    pass('13: a failed write after creating the temporary file removes it')
  }

  // ---- 7. Exclusive publication ----------------------------------------------------------------------
  {
    const folder = join(root, 'pub'); mkdirSync(folder)
    const temp = join(folder, '.tw-export-x'); writeFileSync(temp, 'new')
    let raced = false
    // Another process creates the name between any check and the publication.
    const link = (from, to) => { if (!raced) { raced = true; writeFileSync(to, 'theirs'); throw Object.assign(Error('EEXIST'), { code: 'EEXIST' }) } return createRequire(import.meta.url)('node:fs').linkSync(from, to) }
    const final = publishExclusive(temp, join(folder, 'talk.srt'), { link }).path
    assert.equal(final, join(folder, 'talk (2).srt'))
    assert.equal(readFileSync(join(folder, 'talk.srt'), 'utf8'), 'theirs', 'the other file is never replaced')
    assert.equal(readFileSync(final, 'utf8'), 'new'); assert.equal(existsSync(temp), false)
    const temp2 = join(folder, '.tw-export-y'); writeFileSync(temp2, 'copy')
    const noLinks = () => { throw Object.assign(Error('ENOTSUP'), { code: 'ENOTSUP' }) }
    assert.equal(publishExclusive(temp2, join(folder, 'talk.srt'), { link: noLinks }).path, join(folder, 'talk (3).srt'), 'a disk without hard links uses an exclusive copy')
    pass('7: extras are published with an exclusive operation and move to the next name on a late collision')
  }

  // ---- Real exports: 3, 6, 10, 14 -------------------------------------------------------------------
  const userData = join(root, 'userData'), runId = 'sess-fixture', rec = join(userData, 'recordings', runId)
  mkdirSync(rec, { recursive: true })
  gen(['-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=30:d=4', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '200k', '-f', 'webm', join(rec, 'slides.webm')])
  const voicePath = join(userData, 'recordings', `${runId}.webm`)
  gen(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:a', 'libopus', '-f', 'webm', voicePath])
  const pictures = resolvePictureLayers(userData, runId, { layers: { slides: { file: 'slides.webm', bytes: statSync(join(rec, 'slides.webm')).size, startMs: 0 } } }, 4000)
  const layers = { runId, durationMs: 4000, ...pictures, voice: [{ path: voicePath, startMs: 0, endMs: 4000 }] }
  const base = { layers, cuts: [], camera: true, title: 't', enters: [], slides: {}, words: [{ text: 'Hello', start: 100, end: 600 }], segments: [] }
  const tempFile = join(root, 'export-temps.json')
  const temps = createTempRecord(tempFile)
  const exporter = createVideoExporter({ ffmpeg: () => ffmpeg, temps })

  {
    const out = join(root, 'case'); mkdirSync(out)
    writeFileSync(join(out, 'lecture.mp4'), 'keep me')
    // The panel returned "lecture" without an extension: "lecture.mp4" was never approved.
    const { destination, replace } = exportDestination(join(out, 'lecture'), '.mp4')
    const done = await exporter.run({ ...base, destination, replace, extras: { captions: false, chapterList: false, sound: false } }, () => {})
    assert.equal(done.state, 'done', JSON.stringify(done))
    assert.equal(readFileSync(join(out, 'lecture.mp4'), 'utf8'), 'keep me', 'the unapproved existing file is not replaced')
    assert.equal(done.name, 'lecture (2).mp4'); assert.ok(statSync(join(out, 'lecture (2).mp4')).size > 1000)
    pass('3b: an existing file under a name the owner did not approve is never replaced; the name used is reported')
  }
  {
    const out = join(root, 'commit'); mkdirSync(out)
    writeFileSync(join(out, 'talk.mp4'), 'the old video')
    const failing = createVideoExporter({ ffmpeg: () => ffmpeg, temps, io: { rename: () => { throw Object.assign(Error('EACCES: permission denied, rename'), { code: 'EACCES' }) } } })
    const s = await failing.run({ ...base, destination: join(out, 'talk.mp4'), replace: true, extras: { captions: true, chapterList: false, sound: true } }, () => {})
    assert.equal(s.state, 'failed'); assert.match(s.message, /cannot be written/)
    assert.deepEqual(readdirSync(out), ['talk.mp4'], 'no extra is left and no temporary file')
    assert.equal(readFileSync(join(out, 'talk.mp4'), 'utf8'), 'the old video', 'the chosen file is untouched')
    let calls = 0
    const linkFails = createVideoExporter({ ffmpeg: () => ffmpeg, temps, io: { link: (a, b) => { if (++calls === 2) throw Object.assign(Error('EIO'), { code: 'EIO' }); return createRequire(import.meta.url)('node:fs').linkSync(a, b) }, copy: () => { throw Object.assign(Error('EIO'), { code: 'EIO' }) } } })
    const s2 = await linkFails.run({ ...base, destination: join(out, 'talk.mp4'), replace: true, extras: { captions: true, chapterList: false, sound: false } }, () => {})
    assert.equal(s2.state, 'failed')
    assert.deepEqual(readdirSync(out), ['talk.mp4']); assert.equal(readFileSync(join(out, 'talk.mp4'), 'utf8'), 'the old video', 'an extra that fails leaves the chosen file untouched')
    pass('6: a commit that fails part-way removes what it published and never replaces the chosen file first')
  }
  {
    const out = join(root, 'long'); mkdirSync(out)
    const name = `${'a'.repeat(220)}.mp4`
    const done = await exporter.run({ ...base, destination: join(out, name), replace: true, extras: { captions: true, chapterList: false, sound: false } }, () => {})
    assert.equal(done.state, 'done', JSON.stringify(done))
    assert.ok(existsSync(join(out, name)) && existsSync(join(out, `${'a'.repeat(220)}.srt`)))
    pass('14: a 224-character destination name exports (temporary names are short)')
  }
  {
    const out = join(root, 'quit'); mkdirSync(out)
    const slow = { ...base, layers: { ...layers, durationMs: 4000 } }
    const running = exporter.run({ ...slow, destination: join(out, 'q.mp4'), replace: true, extras: { captions: false, chapterList: false, sound: false } }, () => {})
    await new Promise((r) => setTimeout(r, 120))
    const t0 = Date.now()
    await exporter.shutdown(4000)
    assert.ok(Date.now() - t0 < 4000); assert.equal((await running).state, 'cancelled')
    assert.deepEqual(readdirSync(out), [], 'after a bounded shutdown no temporary file remains')
    assert.equal(exporter.busy(), false)
    // A crash leaves files only the record names; the next start removes exactly those.
    const crashed = join(out, '.tw-export-12345678-1234-1234-1234-123456789abc.mp4.part'), foreign = join(out, 'mine.mp4.part')
    assert.ok(EXPORT_TEMP_NAME.test('.tw-export-12345678-1234-1234-1234-123456789abc.mp4.part'))
    temps.add({ path: crashed, identity: createOwnedFile(crashed, 'x') }); temps.add({ path: foreign, identity: createOwnedFile(foreign, 'y') })
    assert.deepEqual(createTempRecord(tempFile).sweep(), [crashed])
    assert.equal(existsSync(crashed), false); assert.equal(existsSync(foreign), true, 'a file without this app’s temporary name is never removed')
    const aborted = new AbortController(); aborted.abort()
    await assert.rejects(() => inspectMedia(ffmpeg, voicePath, aborted.signal), (e) => e.cancelled === true)
    pass('10: quitting waits a bounded time for the export to stop and clean up; inspection is cancellable; leftovers of a crash are swept by record')
  }


  // ==== Second review round (head 370887a1) ===========================================================
  {
    // R2-1: the Run's cache folder is swapped for a link between the check and the listing.
    const u = join(root, 'race'), outside = join(root, 'race-outside'), hex = 'c'.repeat(24)
    mkdirSync(join(u, 'recording-playback', 'sess-race', 'd'.repeat(24)), { recursive: true })
    mkdirSync(join(outside, hex, 'inner'), { recursive: true }); writeFileSync(join(outside, hex, 'sentinel'), 'keep'); writeFileSync(join(outside, hex, 'inner', 'deep'), 'keep')
    const runFolder = join(u, 'recording-playback', 'sess-race')
    const fs = createRequire(import.meta.url)('node:fs'), realReaddir = fs.readdirSync
    let swapped = false
    fs.readdirSync = (p, ...rest) => {
      if (!swapped && p === runFolder) { swapped = true; fs.renameSync(runFolder, `${runFolder}.real`); fs.symlinkSync(outside, runFolder) }
      return realReaddir(p, ...rest)
    }
    syncBuiltinESMExports()
    try { removePlaybackCopies(u, 'sess-race') } finally { fs.readdirSync = realReaddir; syncBuiltinESMExports() }
    assert.ok(swapped, 'the swap happened between the check and the listing')
    assert.equal(readFileSync(join(outside, hex, 'sentinel'), 'utf8'), 'keep'); assert.equal(readFileSync(join(outside, hex, 'inner', 'deep'), 'utf8'), 'keep')
    pass('R2-1: a cache folder swapped for a link after the check never loses a tree: only this app’s file names are removed, folders by rmdir')
  }
  {
    // R2-2: another file now sits at a recorded temporary path.
    const folder = join(root, 'sweep2'); mkdirSync(folder)
    const recordFile = join(root, 'temps2.json'), record = createTempRecord(recordFile)
    const mine = join(folder, '.tw-export-11111111-2222-3333-4444-555555555555.mp4.part'), theirs = join(folder, '.tw-export-66666666-7777-8888-9999-000000000000.srt.part')
    record.add({ path: mine, identity: createOwnedFile(mine, 'x') })
    record.add({ path: theirs, identity: createOwnedFile(theirs, 'y') })
    rmSync(theirs); writeFileSync(theirs, 'a different file now')
    assert.deepEqual(createTempRecord(recordFile).sweep(), [mine])
    assert.equal(existsSync(mine), false); assert.equal(readFileSync(theirs, 'utf8'), 'a different file now', 'a file that replaced the temporary one is left alone')
    writeFileSync(recordFile, JSON.stringify([theirs]))
    assert.deepEqual(createTempRecord(recordFile).sweep(), []); assert.ok(existsSync(theirs), 'an entry of the old format removes nothing')
    pass('R2-2: the start-up sweep removes a recorded temporary path only if it is still the same file')
  }
  {
    // R2-4: 10,000 disjoint cuts, then one more.
    const folder = join(root, 'count'); mkdirSync(folder)
    const path = join(folder, 'sess-c.edits.json')
    const cuts = Array.from({ length: 10_000 }, (_, i) => ({ start: i * 10, end: i * 10 + 5 }))
    writeFileSync(path, serialiseEdits({ ...emptyEdits(), revision: 1, recording: 'fc', cuts }))
    const store = createRecordingEditsStore({ locate: () => ({ path, runId: 'sess-c', durationMs: 200_000, fingerprint: 'fc' }) })
    assert.equal(store.get({}).problem, null)
    assert.throws(() => store.apply({}, { kind: 'cut', ranges: [{ start: 150_000, end: 150_005 }] }, 1), /too many cuts/)
    const after = store.get({})
    assert.equal(after.problem, null, 'the sidecar still reads'); assert.equal(after.edits.cuts.length, 10_000)
    pass('R2-4: a change the reader would refuse (10,001 cuts) is refused before writing; the sidecar stays readable')
  }
  {
    // R2-5: Control on Windows and Linux, Command on a Mac; the text-field guard stays in Studio.
    const key = (k, mods = {}) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods })
    for (const mod of [{ metaKey: true }, { ctrlKey: true }]) {
      assert.equal(shortcutEventMatches(key('z', mod), 'studio.trim-undo'), true)
      assert.equal(shortcutEventMatches(key('Z', { ...mod, shiftKey: true }), 'studio.trim-redo'), true)
      assert.equal(shortcutEventMatches(key('Z', { ...mod, shiftKey: true }), 'studio.trim-undo'), false)
    }
    assert.equal(shortcutEventMatches(key('i'), 'studio.trim-start'), true); assert.equal(shortcutEventMatches(key('i', { ctrlKey: true }), 'studio.trim-start'), false)
    const studio = readFileSync(new URL('../src/renderer/src/components/Studio.tsx', import.meta.url), 'utf8')
    assert.match(studio, /STUDIO_TRIM_KEYS\.find\(\(id\) => shortcutEventMatches\(e, id\)\)/, 'Studio matches the trim keys with the registry’s matcher')
    assert.ok(studio.indexOf('if (typing) return') < studio.indexOf('STUDIO_TRIM_KEYS.find'), 'the trim keys never act while typing')
    pass('R2-5: trim undo and redo match ⌘Z / ⇧⌘Z on a Mac and Ctrl+Z / Ctrl+Shift+Z elsewhere, outside text fields')
  }
  {
    // R2-6 fallback: taking the warmed surface never waits for it to settle; unused surfaces close.
    const made = []
    let settle
    const sources = createWarmSources({
      create: () => { const s = { destroyed: false, isDestroyed() { return this.destroyed }, destroy() { this.destroyed = true } }; made.push(s); return s },
      load: async () => {}, settle: () => new Promise((r) => { settle = r }), idleMs: 50
    })
    sources.warm(1, 'file:///deck.html?audience=1')
    const taken = sources.take(1, 'file:///deck.html?audience=1')
    assert.ok(taken && taken.source === made[0] && !made[0].destroyed, 'handed over at once though it has not settled')
    let settledYet = false; taken.settled.then(() => { settledYet = true })
    await new Promise((r) => setTimeout(r, 10)); assert.equal(settledYet, false); settle()
    sources.warm(2, 'file:///a.html'); assert.equal(sources.take(2, 'file:///b.html'), null); assert.equal(made[1].destroyed, true, 'a surface for another page is closed')
    sources.warm(3, 'file:///c.html'); await new Promise((r) => setTimeout(r, 80)); assert.equal(made[2].destroyed, true); assert.equal(sources.take(3, 'file:///c.html'), null, 'a surface nobody takes is closed')
    const failing = createWarmSources({ create: () => ({ d: false, isDestroyed() { return this.d }, destroy() { this.d = true } }), load: async () => { throw Error('load failed') }, settle: async () => {}, idleMs: 1000 })
    failing.warm(4, 'file:///d.html'); await new Promise((r) => setTimeout(r, 5)); assert.equal(failing.take(4, 'file:///d.html'), null, 'a failed load is no surface; open makes its own')
    pass('R2-6: the warmed slides surface is handed over without waiting; a failed or unused one never blocks the start')
  }
  {
    // R2-3: after a failed final rename, a published extra that another program has replaced stays.
    const out = join(root, 'rollback2'); mkdirSync(out)
    writeFileSync(join(out, 'talk.mp4'), 'the old video')
    const replacing = createVideoExporter({ ffmpeg: () => ffmpeg, temps, io: { rename: () => { rmSync(join(out, 'talk.srt')); writeFileSync(join(out, 'talk.srt'), 'theirs'); throw Object.assign(Error('EACCES: permission denied, rename'), { code: 'EACCES' }) } } })
    const s = await replacing.run({ ...base, destination: join(out, 'talk.mp4'), replace: true, extras: { captions: true, chapterList: false, sound: false } }, () => {})
    assert.equal(s.state, 'failed'); assert.match(s.message, /talk\.srt/)
    assert.equal(readFileSync(join(out, 'talk.srt'), 'utf8'), 'theirs', 'the replacement is not deleted')
    assert.deepEqual(readdirSync(out).sort(), ['talk.mp4', 'talk.srt'], 'the extra still ours (talk.vtt) is removed; no temporary file is left')
    assert.equal(readFileSync(join(out, 'talk.mp4'), 'utf8'), 'the old video')
    pass('R2-3: a rollback removes only the objects it published; a replaced one is left and named')
  }
  {
    // Round 2 note (a): after a crash between extras and video, extras under the final names stay; the next export to that name numbers its extras.
    const out = join(root, 'after-crash'); mkdirSync(out)
    writeFileSync(join(out, 'talk.srt'), 'from the crashed export')
    const s = await exporter.run({ ...base, destination: join(out, 'talk.mp4'), replace: true, extras: { captions: true, chapterList: false, sound: false } }, () => {})
    assert.equal(s.state, 'done'); assert.ok(s.extras.some((p) => p.endsWith('talk (2).srt'))); assert.equal(readFileSync(join(out, 'talk.srt'), 'utf8'), 'from the crashed export')
    pass('note (a): extras left by a crash are kept; the next export to that name writes numbered extras')
  }

  // ---- 8 and 9. Playback copies: retry after a failure; bounded by the Runs that exist ----------------
  {
    let tool = join(root, 'no-such-ffmpeg')
    const preparer = createPlaybackPreparer({ userDataDir: () => userData, ffmpeg: () => tool })
    const first = await preparer.prepare(layers)
    assert.equal(first.unreadable.length, 2, 'a failing tool leaves both outputs unmade')
    tool = ffmpeg
    const second = await preparer.prepare(layers)
    assert.equal(second.unreadable.length, 0, 'the next open tries again instead of reusing the failure')
    assert.ok(second.voice && second.slides.length === 1)
    // A copy that went missing behind ready.json is made again.
    rmSync(playbackFile(userData, runId, second.identity, 'slides-0.webm'))
    const third = await preparer.prepare(layers)
    assert.ok(playbackFile(userData, runId, third.identity, 'slides-0.webm'))
    // Copies of a Run whose recording is gone are removed when copies are next prepared.
    mkdirSync(join(userData, 'recording-playback', 'sess-gone', 'b'.repeat(24)), { recursive: true })
    await preparer.prepare(layers)
    assert.equal(existsSync(join(userData, 'recording-playback', 'sess-gone')), false)
    assert.ok(existsSync(join(userData, 'recording-playback', runId)))
    removePlaybackCopies(userData, runId)
    assert.equal(existsSync(join(userData, 'recording-playback', runId)), false)
    pass('8, 9b: a failed copy is retried on the next open; copies of deleted Runs are removed')
  }

  // ---- Third review round ----------------------------------------------------------------------------
  // A. The fallback copy fails after another program replaced the half-written file: the replacement stays.
  {
    const folder = join(root, 'copy-race'); mkdirSync(folder)
    const from = join(folder, 'source.bin'), to = join(folder, 'talk.srt'), aside = join(folder, 'moved-aside')
    writeFileSync(from, Buffer.alloc(64 * 1024, 7))
    assert.throws(() => exclusiveCopy(from, to, { afterChunk: () => {
      renameSync(to, aside)                       // a sync tool moves our partial file away…
      writeFileSync(to, 'the owner’s own captions') // …and puts another file under the name
      throw Object.assign(Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    } }), /ENOSPC/)
    assert.equal(readFileSync(to, 'utf8'), 'the owner’s own captions', 'a replacement under the final name is never removed')
    // The ordinary failure still leaves nothing under the final name.
    const plain = join(folder, 'plain.srt')
    assert.throws(() => exclusiveCopy(from, plain, { afterChunk: () => { throw Error('ENOSPC') } }), /ENOSPC/)
    assert.equal(existsSync(plain), false, 'our own partial file is removed')
    pass('A: a failed fallback copy removes only the file it created')
  }

  // B. A temporary file that cannot be removed keeps its record, so the next start tries again.
  if (process.getuid?.() !== 0) {
    const locked = join(root, 'locked'); mkdirSync(locked)
    const temp = join(locked, '.tw-export-00000000-0000-4000-8000-000000000001.mp4')
    const recordFile = join(root, 'temps-retry.json'), record = createTempRecord(recordFile)
    record.add({ path: temp, identity: createOwnedFile(temp, 'partial') })
    chmodSync(locked, 0o555)
    try {
      assert.deepEqual(createTempRecord(recordFile).sweep(), [], 'nothing could be removed')
      assert.ok(existsSync(temp) && existsSync(recordFile), 'the file and its record both remain')
    } finally { chmodSync(locked, 0o755) }
    assert.deepEqual(createTempRecord(recordFile).sweep(), [temp], 'the next start removes it')
    assert.equal(existsSync(recordFile), false)
    pass('B: a temporary file that could not be removed is retried at the next start')
  }

  // C. An identity a disk did not really report identifies nothing, so nothing is removed on its strength.
  {
    for (const id of [{ dev: '1', ino: '0', birth: '0' }, { dev: '1', ino: 'undefined', birth: 'undefined' }, { dev: '0', ino: '5', birth: '9' }, undefined]) assert.equal(identifies(id), false)
    assert.equal(identifies({ dev: '16777233', ino: '42', birth: '0' }), true, 'no creation time is fine when the inode is real')
    const file = join(root, '.tw-export-00000000-0000-4000-8000-000000000002.mp4'); writeFileSync(file, 'someone else’s')
    assert.equal(isSameFile(file, { dev: '1', ino: '0', birth: '0' }), false)
    const recordFile = join(root, 'temps-noid.json')
    writeFileSync(recordFile, JSON.stringify([{ path: file, identity: { dev: '1', ino: '0', birth: '0' } }]))
    assert.deepEqual(createTempRecord(recordFile).sweep(), []); assert.ok(existsSync(file))
    pass('C: an unreported identity removes nothing')
  }

  // D. A surface whose loading fails late does not close the newer surface warmed for the same presenter.
  {
    const made = []
    let failFirst
    const sources = createWarmSources({
      create: () => { const s = { d: false, isDestroyed() { return this.d }, destroy() { this.d = true } }; made.push(s); return s },
      load: (source) => (source === made[0] ? new Promise((_, reject) => { failFirst = reject }) : Promise.resolve()),
      settle: async () => {}, idleMs: 60_000
    })
    sources.warm(7, 'talk://a'); sources.warm(7, 'talk://b')
    failFirst(Error('load failed')); await new Promise((r) => setTimeout(r, 10))
    const taken = sources.take(7, 'talk://b')
    assert.ok(taken && taken.source === made[1] && !made[1].d, 'the newer surface survives the older one’s failure')
    assert.equal(made[0].d, true, 'the older surface is closed')
    pass('D: an old warm-up failing does not close its replacement')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
