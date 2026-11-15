// 0.45, second Mac: say where a recording is. A Run record travels with the vault; its audio and video stay
// in the app data of the Mac that recorded them (src/shared/recording-place.ts).
//   1. the words, as a table: media present or absent on this Mac × the Run names this Mac, another Mac, no Mac,
//      or a different Mac with this Mac's name. Presence comes from the files, never the `uploaded` flag or the name;
//   2. recording:save writes `recordedOn` (this Mac's listed name) into a Run that has a recording, and none into one
//      without; Studio's list (recording:list-all-sessions, recording:list-sessions) carries the place, read-time only;
//   3. the recording editor (recording-video:open) says where the recording is when none of its files is here, and
//      lists missing files as before when some are here;
//   4. an older app (0.44.5: runs.ts, recording.ts and run-ink-readback.ts are byte-identical to the code tested
//      here) keeps the field: normaliseRun keeps unknown fields, and every rewrite writes the whole record.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-recording-place.mjs
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mediaAwaySentence, mediaPlaceOf, recordedOnFor, recordedOnOf, studioAudioLabel } from '../src/shared/recording-place.ts'
import { runVoiceHere } from '../src/main/recording-paths.ts'
import { attachDeliveryToPlanned, normaliseRun, writeRunFile } from '../src/main/runs.ts'
import { registerRecordingVideoIpc } from '../src/main/recording-video-ipc.ts'

let count = 0
const pass = (name) => console.log(`ok  ${++count} ${name}`)
const base = mkdtempSync(join(tmpdir(), 'tw-recording-place-'))
const THIS_MAC = 'Studio Air'
const OTHER_MAC = 'Dominik’s MacBook Pro'

// The four ways a Run can name a Mac. "This Mac" and "a different Mac with this Mac's name" are the same to the
// app (it has no per-install id): both read as the same name, and the files decide.
const NAMES = {
  'this Mac': { recordedOn: { computer: THIS_MAC } },
  'another Mac': { recordedOn: { computer: OTHER_MAC } },
  'no Mac (older Run)': {},
  'a different Mac with the same name': { recordedOn: { computer: 'studio air' } }
}
const EXPECTED = {
  present: {
    'this Mac': ['here', 'on this Mac', null],
    'another Mac': ['here', 'on this Mac', null],
    'no Mac (older Run)': ['here', 'on this Mac', null],
    'a different Mac with the same name': ['here', 'on this Mac', null]
  },
  absent: {
    'this Mac': ['same-name', 'not on this Mac', 'Recorded on a Mac named Studio Air. The recording is not on this Mac.'],
    'another Mac': ['elsewhere', `on ${OTHER_MAC}`, `Recorded on ${OTHER_MAC}. The recording is on that Mac.`],
    'no Mac (older Run)': ['unknown', 'not on this Mac', 'The recording is not on this Mac.'],
    'a different Mac with the same name': ['same-name', 'not on this Mac', 'Recorded on a Mac named studio air. The recording is not on this Mac.']
  }
}

try {
  // ---- 1. the table, through the files
  {
    const ud = join(base, 'table-ud')
    mkdirSync(join(ud, 'recordings'), { recursive: true })
    for (const media of ['present', 'absent']) {
      for (const [label, extra] of Object.entries(NAMES)) {
        for (const uploaded of [false, true]) {
          const id = `2026-11-14-1000-${Object.keys(NAMES).indexOf(label)}${media[0]}${uploaded ? 'u' : 'l'}`
          const run = { id, talkSlug: 'talk', audio: { r2Key: 'k', bytes: 4, uploaded, segments: [{ file: `${id}.webm`, startMs: 0, endMs: 1000 }] }, ...extra }
          const file = join(ud, 'recordings', `${id}.webm`)
          if (media === 'present') writeFileSync(file, 'webm'); else if (existsSync(file)) unlinkSync(file)
          const place = mediaPlaceOf(runVoiceHere(ud, run), recordedOnOf(run), THIS_MAC)
          const [state, text, sentence] = EXPECTED[media][label]
          assert.equal(place.state, state, `${media} × ${label}${uploaded ? ' (uploaded)' : ''}`)
          const shown = studioAudioLabel(place, uploaded)
          assert.equal(shown.text, media === 'present' && uploaded ? 'uploaded' : text, `${media} × ${label}: Studio's label`)
          assert.equal(shown.here, media === 'present')
          assert.equal(mediaAwaySentence(place), sentence, `${media} × ${label}: the editor's sentence`)
          if (sentence) assert.equal(shown.title, sentence, 'the label\'s tooltip is the full sentence')
        }
      }
    }
    // A Run from before segment lists (`audio` without `segments`): its files are found by its id.
    writeFileSync(join(ud, 'recordings', 'old-run.webm'), 'webm')
    assert.equal(runVoiceHere(ud, { id: 'old-run', audio: { r2Key: 'k', bytes: 4, uploaded: false } }), true)
    assert.equal(runVoiceHere(ud, { id: 'gone-run', audio: { r2Key: 'k', bytes: 4, uploaded: true } }), false, 'the uploaded flag never says the files are here')
    assert.equal(runVoiceHere(ud, null), false)
    assert.equal(runVoiceHere(ud, { id: '../escape', audio: { segments: [{ file: '../escape.webm' }] } }), false)
    // The field's own reading: a name, trimmed; anything else is "no Mac".
    assert.equal(recordedOnOf({ recordedOn: { computer: '  Air  ' } }), 'Air')
    for (const bad of [{}, { recordedOn: 'Air' }, { recordedOn: { computer: '' } }, { recordedOn: { computer: 42 } }, { recordedOn: { computer: 'x'.repeat(81) } }, null]) assert.equal(recordedOnOf(bad), null, JSON.stringify(bad))
    assert.deepEqual(recordedOnFor('Studio Air'), { computer: 'Studio Air' })
    assert.equal(recordedOnFor(''), undefined)
    pass(`the table: media present or absent × the Run names this Mac, another Mac, no Mac, or a different Mac with the same name (${2 * 4 * 2} rows)`)
  }

  // ---- 2. recording:save writes the field; Studio's list carries the place (read-time only)
  {
    const vault = join(base, 'vault')
    const userData = join(base, 'userData')
    const SLUG = 'ai-research'
    mkdirSync(join(vault, 'Talks', SLUG), { recursive: true })
    mkdirSync(userData, { recursive: true })
    const handlers = new Map()
    globalThis.__recordingPlaceTest = {
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
      shell: { trashItem: async () => {} },
      dialog: {},
      app: { getPath: () => userData }
    }
    const bundled = await build({ entryPoints: ['src/main/recording.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', plugins: [{ name: 'electron-test-boundary', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test' }))
      b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'module.exports = globalThis.__recordingPlaceTest', loader: 'js' }))
    } }] })
    const module = { exports: {} }
    new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
    let thisMac = THIS_MAC
    module.exports.registerRecordingIpc({
      compilerDir: () => resolve('compiler/scripts'),
      userDataDir: () => userData,
      vaultRoot: () => vault,
      discardThresholdMs: () => 0,
      storage: () => ({ upload: async () => ({ ok: true }) }),
      testMode: () => true,
      computerName: () => thisMac
    })
    const sender = { id: 42, isDestroyed: () => false, send: () => {}, once: () => {}, on: () => {} }
    const payload = (extra = {}) => ({ talkSlug: SLUG, talkTitle: 'AI for research teams', mode: 'recording', kind: 'delivery', wallClockMs: 30_000, rawMarks: [{ event: 'start', tMs: 0 }, { event: 'stop', tMs: 30_000 }], force: true, ...extra })
    const runFile = (id) => JSON.parse(readFileSync(join(vault, '_PRESENTATIONS', SLUG, `${id}.json`), 'utf8'))

    const rec = await handlers.get('recording:save')({ sender }, payload({ audio: new Uint8Array([1, 2, 3, 4]).buffer }))
    assert.equal(rec.ok, true, rec.error)
    assert.deepEqual(runFile(rec.sessionId).recordedOn, { computer: THIS_MAC }, 'a Run with a recording names the Mac that holds it')
    const plain = await handlers.get('recording:save')({ sender }, payload({ mode: 'run' }))
    assert.equal(plain.ok, true, plain.error)
    assert.equal(runFile(plain.sessionId).recordedOn, undefined, 'a Run with no recording names no Mac')

    const listed = async () => Object.fromEntries((await handlers.get('recording:list-all-sessions')()).map((s) => [s.id, s]))
    let all = await listed()
    assert.deepEqual(all[rec.sessionId].mediaPlace, { state: 'here' }, 'the files are here: on this Mac')
    // The same vault opened on the other Mac: same Run, no files, another name.
    const audioFile = join(userData, 'recordings', `${rec.sessionId}.webm`)
    const kept = readFileSync(audioFile)
    unlinkSync(audioFile)
    thisMac = OTHER_MAC
    all = await listed()
    assert.deepEqual(all[rec.sessionId].mediaPlace, { state: 'elsewhere', computer: THIS_MAC })
    assert.equal(studioAudioLabel(all[rec.sessionId].mediaPlace, false).text, `on ${THIS_MAC}`)
    const perTalk = Object.fromEntries((await handlers.get('recording:list-sessions')({}, SLUG)).map((s) => [s.id, s]))
    assert.deepEqual(perTalk[rec.sessionId].mediaPlace, { state: 'elsewhere', computer: THIS_MAC }, 'the one-talk list says the same')
    // An older Run in the vault with no name, its files on neither Mac.
    writeFileSync(join(vault, '_PRESENTATIONS', SLUG, 'older-run.json'), JSON.stringify({ id: 'older-run', talkSlug: SLUG, talkTitle: 'Older', kind: 'delivery', startedAt: '2026-01-01T10:00:00Z', recordingMs: 1000, audio: { r2Key: 'k', bytes: 4, uploaded: true } }))
    all = await listed()
    assert.deepEqual(all['older-run'].mediaPlace, { state: 'unknown' }, 'uploaded, but the files are not here: not on this Mac')
    // Back on the recording Mac, files back: here again. The name alone never decides.
    writeFileSync(audioFile, kept)
    thisMac = 'Some third Mac'
    all = await listed()
    assert.deepEqual(all[rec.sessionId].mediaPlace, { state: 'here' }, 'files here under any name: on this Mac')
    // Read-time only: listing never writes the place into a Run.
    assert.equal(runFile(rec.sessionId).mediaPlace, undefined)
    assert.ok(!readdirSync(join(vault, '_PRESENTATIONS', SLUG)).some((n) => n.endsWith('.tmp')))
    pass('recording:save names this Mac in a Run with a recording (not in one without); Studio\'s lists carry the place, read-time only')
  }

  // ---- 3. the recording editor's notice
  {
    const dir = join(base, 'editor'), vault = join(dir, 'vault'), ud = join(dir, 'ud'), runs = join(vault, '_PRESENTATIONS', 'talk')
    mkdirSync(runs, { recursive: true }); mkdirSync(join(ud, 'recordings'), { recursive: true })
    const handlers = new Map(), wc = {}, win = { isDestroyed: () => false, webContents: wc }
    registerRecordingVideoIpc({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, toolsWindow: () => win, userDataDir: () => ud, vaultFor: () => vault, tempRecordFile: () => join(ud, 'temps.json'),
      readiness: () => ({ ffmpeg: { found: false, path: null } }), readTranscript: async () => ({ state: 'none' }), showSaveDialog: async () => ({ canceled: true }), reveal: () => {}, defaultFolder: () => dir, computerName: () => THIS_MAC })
    const put = (id, extra) => writeFileSync(join(runs, `${id}.json`), JSON.stringify({ id, talkSlug: 'talk', startedAt: '2026-11-11T10:00:00Z', recordingMs: 10000,
      audio: { r2Key: 'k', bytes: 4, uploaded: false, segments: [{ file: `${id}.webm`, startMs: 0, endMs: 10000 }, { file: `${id}.seg-2.webm`, startMs: 0, endMs: 10000 }] },
      slideTimeIndex: [{ event: 'enter', slideId: 'A', tMs: 0 }], capture: null, ...extra }))
    const open = (id) => handlers.get('recording-video:open')({ sender: wc }, { talkSlug: 'talk', runId: id })
    for (const [label, extra] of Object.entries(NAMES)) {
      const id = `run-${Object.keys(NAMES).indexOf(label)}`
      put(id, extra)
      const away = await open(id)
      assert.equal(away.ok, true, away.error)
      assert.equal(mediaAwaySentence(away.away), EXPECTED.absent[label][2], `absent × ${label}`)
      writeFileSync(join(ud, 'recordings', `${id}.webm`), 'webm')
      const partly = await open(id)
      assert.equal(partly.away, null, `present × ${label}: some files here, so the missing ones are listed as before`)
      assert.deepEqual(partly.missing, [{ layer: 'voice', file: `${id}.seg-2.webm` }])
    }
    pass('the recording editor: none of the files here → where the recording is; some here → the missing files, as before')
  }

  // ---- 4. an older app keeps the field
  {
    const dir = join(base, 'older')
    mkdirSync(dir)
    const raw = { id: 'r1', talkSlug: 'talk', talkTitle: 'T', kind: 'delivery', status: 'delivered', startedAt: '2026-11-14T09:00:00Z', recordingMs: 1000, audio: { r2Key: 'k', bytes: 4, uploaded: false }, recordedOn: { computer: OTHER_MAC } }
    const read = normaliseRun(raw)
    assert.deepEqual(read.recordedOn, { computer: OTHER_MAC }, 'read: kept')
    writeRunFile(join(dir, 'r1.json'), read)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'r1.json'), 'utf8')).recordedOn, { computer: OTHER_MAC }, 'rewritten through the Run writer: kept')
    const planned = normaliseRun({ id: 'p1', talkSlug: 'talk', talkTitle: 'T', status: 'planned', plannedDate: '2026-11-14' })
    assert.deepEqual(attachDeliveryToPlanned(planned, read).recordedOn, { computer: OTHER_MAC }, 'a delivery attached to a planned Run: kept')
    pass('0.44.5\'s Run reader and writers keep `recordedOn` (it is read, rewritten whole, never dropped)')
  }
} finally {
  rmSync(base, { recursive: true, force: true })
}
console.log(`\n${count} passed`)
