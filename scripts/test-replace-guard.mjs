// 0.45 fix round (PR 390): a vault data file that is on disk but cannot be read is never replaced from a record
// held in memory. A sync can leave Git conflict markers in a Run file while a background job is running; when
// the job finishes, its write must leave the file byte for byte as it is and say that it was not saved.
//   1. the Run writer itself (persistRun, persistRunForTalk with and without its guard, writeRunFile): Git
//      markers, truncated JSON, an array, another Run's id are refused with the file named; a missing file is
//      a first save and is written;
//   2. Unpublish, with the real runUnpublishJob: markers arrive while the Worker is asked to withdraw; with the
//      0.44 caller shape (`readRun(...) ?? asked`) the writer refuses, and with the fixed caller the job stops
//      on its own read; either way the file is unchanged and the refusal names it;
//   3. the uploaded flag, through the app's own recording:upload: markers arrive during the upload; the Run
//      is left as it is and the reply says it was not marked; the direct patches (context, kind, trims,
//      finalise) refuse a conflicted file in words that name it;
//   4. transcription completion: markers arrive in the transcript file while the new one is written; it is
//      left as it is and the reply says so;
//   5. the Pathways manifest and the Notes and cleaned-text stores: a conflicted or unreadable file is never
//      replaced, also when the markers arrive just before the rename.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-replace-guard.mjs
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as runs from '../src/main/runs.ts'
import { runUnpublishJob } from '../src/main/run-unpublish.ts'
import { createTranscription } from '../src/main/transcription.ts'
import { pathwayManifestPath, writePathwayManifest } from '../src/main/pathways.ts'
import { emptyCleanedStore, emptyNotesStore, writeCleanedStore, writeNotesStore } from '../src/main/rewritePack.ts'
import { isGitConflictError } from '../src/shared/git-conflict.ts'
import { uploadFailureMessage } from '../src/shared/recording-storage-status.ts'

let count = 0
const pass = (name) => console.log(`ok  ${++count} ${name}`)
const base = mkdtempSync(join(tmpdir(), 'tw-replace-guard-'))
const TALK = 'guard-talk'
const conflictOf = (a, b) => `{\n<<<<<<< HEAD\n  "id": "${a}",\n=======\n  "id": "${b}",\n>>>>>>> origin/main\n  "talkSlug": "${TALK}"\n}\n`
const makeRun = (id, extra = {}) => normaliseRun({ id, talkSlug: TALK, talkTitle: 'Guard', kind: 'delivery', status: 'delivered', startedAt: '2026-11-01T10:00:00.000Z', slideSet: { kind: 'all' }, ...extra })
/** The refusal: typed, says the file was left as it is, names `<talk>/<file>`. */
function refused(error, file, gitConflict = true) {
  assert.ok(error, 'a refusal was reported')
  assert.equal(error.name, 'ReplaceRefusedError', `a typed refusal, got ${error?.name}: ${error?.message}`)
  assert.equal(error.gitConflict, gitConflict)
  if (gitConflict) assert.ok(isGitConflictError(error), 'the existing Git conflict check recognises it (Show in Finder)')
  assert.ok(error.message.includes(file), `the message names ${file}: ${error.message}`)
  assert.match(error.message, gitConflict ? /Git conflict from syncing/ : /could not be read/)
  return true
}
const throwsRefusal = (fn, file, gitConflict) => { let caught; try { fn() } catch (error) { caught = error } refused(caught, file, gitConflict) }
const { normaliseRun, persistRun, persistRunForTalk, readRun, writeRunFile } = runs
// Each section runs on its own and reports; the script fails when any does (so each can be seen failing alone).
const sections = []
const section = (name, fn) => sections.push({ name, fn })


  // ── 1. The Run writer ──────────────────────────────────────────────────────────────────────────────────
  section('run writer', async () => {
    const vault = join(base, 'v1'), dir = join(vault, '_PRESENTATIONS', TALK)
    mkdirSync(dir, { recursive: true })
    const path = (id) => join(dir, `${id}.json`)
    const cases = [
      ['git markers', conflictOf('r1', 'r1'), true],
      ['truncated JSON', '{"id": "r1", "talkSlug": "gua', false],
      ['an array', '[{"id":"r1"}]', false],
      ['another Run', JSON.stringify({ id: 'someone-else', talkSlug: TALK }), false],
      ['no id', JSON.stringify({ talkSlug: TALK }), false],
    ]
    const writers = [
      ['persistRun', (run) => persistRun(vault, run)],
      ['persistRunForTalk', (run) => persistRunForTalk(vault, TALK, run.id, run)],
      ['persistRunForTalk with its guard', (run) => persistRunForTalk(vault, TALK, run.id, run, (_p, _r, _s, replace) => replace())],
      ['writeRunFile', (run) => writeRunFile(path(run.id), run)],
    ]
    for (const [label, bytes, gitConflict] of cases) for (const [writer, write] of writers) {
      writeFileSync(path('r1'), bytes)
      throwsRefusal(() => write(makeRun('r1', { eventTitle: 'from memory' })), `${TALK}/r1.json`, gitConflict)
      assert.equal(readFileSync(path('r1'), 'utf8'), bytes, `${label} / ${writer}: the file is byte for byte as it was`)
      assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), [], `${label} / ${writer}: no temporary file left`)
    }
    rmSync(path('r1'))
    persistRun(vault, makeRun('r1', { eventTitle: 'first save' }))
    assert.equal(readRun(vault, TALK, 'r1').eventTitle, 'first save', 'a missing file is a first save')
    persistRun(vault, makeRun('r1', { eventTitle: 'second save' }))
    assert.equal(readRun(vault, TALK, 'r1').eventTitle, 'second save', 'a readable Run is replaced as before')
    pass(`the Run writer refuses ${cases.length} kinds of unreadable file through ${writers.length} entry points, names the file, keeps its bytes; a missing or readable file is written`)
  })

  // ── 2. Unpublish, with the real job ────────────────────────────────────────────────────────────────────
  section('unpublish', async () => {
    const vault = join(base, 'v2'), dir = join(vault, '_PRESENTATIONS', TALK)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'run-u.json')
    const conflicted = conflictOf('run-u', 'run-u')
    const service = (onWithdraw) => ({
      phasesSent: () => ['pre'], ownerRecord: () => 'usable', ownerUnknown: () => false,
      withdraw: async () => { onWithdraw(); return { ok: true } },
    })
    // As run:unpublish-handout wires it, with the run reader given.
    const job = (run) => runUnpublishJob({
      run, siteExists: () => false, readRegistry: () => ({}), writeRegistry: () => {}, notAvailablePage: async () => 'NA', vaultRoot: vault,
      service: service(() => writeFileSync(file, conflicted)),
      persist: (next) => {
        const current = readRun(vault, TALK, 'run-u')
        if (JSON.stringify(current) !== JSON.stringify(next)) persistRun(vault, next)
      },
    })
    for (const [shape, reader] of [
      ['the 0.44 caller (falls back to the Run read when Unpublish was asked for)', (asked) => () => readRun(vault, TALK, 'run-u') ?? asked],
      ['the fixed caller (reads the file at each step)', () => () => runs.requireRunForTalk(vault, TALK, 'run-u')],
    ]) {
      rmSync(file, { force: true }) // the previous case left it conflicted: the writer would rightly refuse
      persistRun(vault, makeRun('run-u', { work: undefined }))
      const asked = readRun(vault, TALK, 'run-u')
      let caught
      try { await job(reader(asked)).begin() } catch (error) { caught = error }
      refused(caught, `${TALK}/run-u.json`)
      assert.equal(readFileSync(file, 'utf8'), conflicted, `${shape}: both sides of the conflict are kept, byte for byte`)
      pass(`Unpublish, ${shape}: markers that arrive while the Worker withdraws are kept and the refusal names the Run file`)
    }
  })

  // ── 3. The uploaded flag and the direct patches, through the app's own handlers ────────────────────────
  section('uploaded flag and patches', async () => {
    const bundled = await build({
      entryPoints: ['src/main/recording.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', logLevel: 'silent',
      plugins: [{ name: 'electron-test-boundary', setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test' }))
        b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'module.exports = globalThis.__replaceGuardElectron', loader: 'js' }))
      } }],
    })
    const handlers = new Map()
    globalThis.__replaceGuardElectron = { ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, BrowserWindow: { fromWebContents: () => null }, shell: {}, dialog: {}, app: { isPackaged: false, getAppPath: () => base } }
    const module = { exports: {} }
    const quiet = console.warn
    new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
    const vault = join(base, 'v3'), userData = join(base, 'ud3'), dir = join(vault, '_PRESENTATIONS', TALK)
    mkdirSync(dir, { recursive: true }); mkdirSync(join(userData, 'recordings'), { recursive: true })
    let onUpload = () => {}
    module.exports.registerRecordingIpc({
      compilerDir: () => null, userDataDir: () => userData, vaultRoot: () => vault, discardThresholdMs: () => 20000, testMode: () => false,
      storage: () => ({ upload: async () => { onUpload(); return { ok: true } } }),
    })
    const runFile = (id) => join(dir, `${id}.json`)
    const recorded = (id) => {
      writeFileSync(join(userData, 'recordings', `${id}.webm`), 'made-up audio')
      writeFileSync(runFile(id), JSON.stringify({ id, talkSlug: TALK, kind: 'delivery', startedAt: '2026-11-01T10:00:00.000Z', audio: { r2Key: `presentations/${TALK}/${id}/audio.webm`, bytes: 13, uploaded: false } }, null, 2))
    }
    // The upload goes through; a sync leaves markers in the Run before it is marked.
    recorded('up-1')
    const conflicted = conflictOf('up-1', 'up-1')
    onUpload = () => writeFileSync(runFile('up-1'), conflicted)
    console.warn = () => {}
    const reply = await handlers.get('recording:upload')({ sender: { id: 1 } }, { talkSlug: TALK, sessionId: 'up-1' })
    console.warn = quiet
    assert.deepEqual(reply, { ok: false, error: 'run-not-saved' }, 'the upload says the Run was not marked')
    assert.match(uploadFailureMessage(reply.error), /^Uploaded, but the Run was not marked as uploaded: its file has a Git conflict from syncing/)
    assert.equal(readFileSync(runFile('up-1'), 'utf8'), conflicted, 'the conflicted Run is byte for byte as the sync left it')
    // Without the sync, the flag is set as before.
    recorded('up-2'); onUpload = () => {}
    assert.deepEqual(await handlers.get('recording:upload')({ sender: { id: 1 } }, { talkSlug: TALK, sessionId: 'up-2' }), { ok: true, uploaded: true })
    assert.equal(JSON.parse(readFileSync(runFile('up-2'), 'utf8')).audio.uploaded, true)
    pass('recording:upload: markers that arrive during the upload are kept, and the reply says the Run was not marked (run-not-saved)')

    const patches = [
      ['recording:set-context', { context: 'Oxford' }],
      ['recording:set-kind', { kind: 'rehearsal' }],
      ['recording:set-trims', { trims: [{ startMs: 0, endMs: 10 }] }],
    ]
    for (const [channel, args] of patches) {
      writeFileSync(runFile('patch'), conflictOf('patch', 'patch'))
      const answer = await handlers.get(channel)({ sender: { id: 1 } }, { talkSlug: TALK, sessionId: 'patch', ...args })
      assert.equal(answer.ok, false, channel)
      assert.match(answer.error, new RegExp(`^This Run was not saved: its file has a Git conflict from syncing \\(${TALK}/patch\\.json\\)`), `${channel}: ${answer.error}`)
      assert.equal(readFileSync(runFile('patch'), 'utf8'), conflictOf('patch', 'patch'), `${channel}: the file is unchanged`)
    }
    pass(`the direct Run patches (${patches.map(([c]) => c).join(', ')}) refuse a conflicted Run in words that name it and leave it unchanged`)
  })

  // ── 4. Transcription completion ────────────────────────────────────────────────────────────────────────
  section('transcription completion', async () => {
    const vault = join(base, 'v4'), userData = join(base, 'ud4'), dir = join(vault, '_PRESENTATIONS', TALK)
    mkdirSync(dir, { recursive: true }); mkdirSync(userData, { recursive: true })
    const target = join(dir, 'tx.transcript.json')
    const conflicted = '{\n<<<<<<< HEAD\n  "segments": [{"text":"Mine","start":0,"end":1}]\n=======\n  "segments": [{"text":"Theirs","start":0,"end":1}]\n>>>>>>> origin/main\n}\n'
    writeFileSync(target, JSON.stringify({ engine: 'parakeet', createdAt: 'old', segments: [{ text: 'Old', start: 0, end: 1000 }] }))
    const files = {
      // The new transcript is written to its temporary file; then a sync leaves markers in the stored one.
      writeFile: (path, text) => { writeFileSync(path, text); writeFileSync(target, conflicted) },
      rename: (from, to) => renameSync(from, to),
      remove: (path) => rmSync(path, { force: true }),
    }
    const tx = createTranscription({ vaultRoot: () => vault, userDataDir: () => userData, config: () => ({ python: '', script: '' }), readiness: () => { throw new Error('no engine') }, testMode: () => true, files })
    const result = await tx.run(TALK, 'tx', null)
    assert.equal(result.ok, false, 'the transcription reports that it was not saved')
    assert.match(result.error, /^The new transcript was not saved: the transcript file has a Git conflict from syncing \(tx\.transcript\.json\)/)
    assert.equal(readFileSync(target, 'utf8'), conflicted, 'the conflicted transcript is byte for byte as the sync left it')
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), [], 'no temporary file left')
    pass('transcription completion: markers that arrive while the new transcript is written are kept, and the reply says so')
  })

  // ── 5. Pathways, Notes and cleaned text ────────────────────────────────────────────────────────────────
  section('pathways and notes', async () => {
    const vault = join(base, 'v5')
    mkdirSync(join(vault, '_PRESENTATIONS', TALK), { recursive: true })
    const manifest = pathwayManifestPath(vault, TALK)
    const conflicted = '{\n<<<<<<< HEAD\n  "pathways": [{"id":"a","name":"Mine","slideIds":[]}]\n=======\n  "pathways": [{"id":"a","name":"Theirs","slideIds":[]}]\n>>>>>>> origin/main\n}\n'
    const next = JSON.stringify({ pathways: [{ id: 'b', name: 'From memory', slideIds: [] }] }, null, 2)
    for (const [label, bytes, gitConflict] of [['Git markers', conflicted, true], ['broken JSON', '{"pathways": [', false]]) {
      writeFileSync(manifest, bytes)
      throwsRefusal(() => writePathwayManifest(manifest, next), `${TALK}/manifest.json`, gitConflict)
      assert.equal(readFileSync(manifest, 'utf8'), bytes, `Pathways, ${label}: unchanged`)
    }
    rmSync(manifest)
    writePathwayManifest(manifest, next)
    assert.equal(readFileSync(manifest, 'utf8'), next, 'a first Pathways save is written')
    pass('the Pathways manifest: a conflicted or broken manifest is refused with the file named and kept; a first save is written')

    const packDir = join(base, 'pack')
    mkdirSync(packDir, { recursive: true })
    const notesConflict = '{\n<<<<<<< HEAD\n  "approved": {"a": 1}\n=======\n  "approved": {"b": 2}\n>>>>>>> origin/main\n}\n'
    for (const [label, write, empty] of [['notes.json', writeNotesStore, emptyNotesStore], ['cleaned.json', writeCleanedStore, emptyCleanedStore]]) {
      const store = join(packDir, label)
      for (const [kind, bytes, gitConflict] of [['Git markers', notesConflict, true], ['another shape', '[1,2,3]', false]]) {
        writeFileSync(store, bytes)
        throwsRefusal(() => write(store, empty()), label, gitConflict)
        assert.equal(readFileSync(store, 'utf8'), bytes, `${label}, ${kind}: unchanged`)
      }
      // A store that reads when the write starts, and is conflicted just before the rename.
      writeFileSync(store, JSON.stringify(empty()))
      throwsRefusal(() => write(store, empty(), { beforeCommit: () => writeFileSync(store, notesConflict) }), label)
      assert.equal(readFileSync(store, 'utf8'), notesConflict, `${label}: markers that arrive before the rename are kept`)
      rmSync(store)
      write(store, empty())
      assert.ok(existsSync(store), `${label}: a first save is written`)
    }
    pass('the Notes and cleaned-text stores: a conflicted or wrong-shaped store is refused and kept, also when the markers arrive just before the rename')
  })

const failed = []
try {
  for (const { name, fn } of sections) {
    try { await fn() } catch (error) { failed.push(name); console.log(`FAIL ${name}: ${error?.message ?? error}`) }
  }
} finally {
  rmSync(base, { recursive: true, force: true })
}
assert.deepEqual(failed, [], `failed: ${failed.join(', ')}`)
console.log(`PASS: ${count} replacement-guard checks`)
