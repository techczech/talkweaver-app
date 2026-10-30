// Issue 256: what a presenter window writes lands in the vault of the talk it presents, never in the first vault
// because it is first. Two vaults: A is the first (current) vault, B holds the presented talk.
//   1. presented-vault.ts: the talk's own vault; a closed vault, or a talk in no vault while several are open, is
//      refused; with one vault open, the current vault as before;
//   2. recording:save (a Run and a recording) writes the Run into B, A untouched; set-kind and finalise-run from the
//      same window change B's Run; the planned-Run picker reads B's plans; with no vault to name, the Run is kept
//      beside its audio in TalkWeaver's folder and nothing is written into A or B;
//   3. a streamed recording interrupted mid-way is recovered as a Run in B (the marker keeps the vault); a marker
//      with no vault (written before 0.41) still goes to the current vault; a marker whose vault is not open waits.
//   2b. a Run kept in TalkWeaver's folder while B was closed takes its later updates there once B reopens (never a copy
//      in B); a Run saved into B that is closed now is refused, never copied; a null vault (the only open vault gone)
//      is kept with the notice; delete refuses a session id whose Run this window cannot see for that talk.
//   4. Studio and History (not a presenter window) still act in the current vault.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-recording-vault.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import fs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { presentedTalkVault, TALK_VAULT_NOT_OPEN, VAULT_NOT_NAMED } from '../src/main/presented-vault.ts'
import { listRuns, writeNewRunFile } from '../src/main/runs.ts'
import { listKeptRuns } from '../src/main/recording-paths.ts'
import { createRecordingStreams } from '../src/main/recording-stream.ts'

const base = mkdtempSync(join(tmpdir(), 'tw-recording-vault-'))
const A = join(base, 'vault-a')
const B = join(base, 'vault-b')
const userData = join(base, 'userData')
const SLUG = 'ai-research'
for (const dir of [A, join(B, 'Talks', SLUG), userData]) mkdirSync(dir, { recursive: true })
const OUTLINE_B = join(B, 'Talks', SLUG, `${SLUG}-outline.md`)
writeFileSync(OUTLINE_B, '# AI for research teams\n')

const registry = [{ id: 'va', root: A, open: true }, { id: 'vb', root: B, open: true }, { id: 'vclosed', root: join(base, 'closed'), open: false }]
const lookup = (overrides = {}) => ({
  resolve: (p) => { const v = registry.find((vault) => resolve(p).startsWith(vault.root + '/')); return v ? { vault: v } : null },
  available: (v) => v.open && existsSync(v.root),
  writable: (root) => existsSync(root) ? root : undefined,
  openVaults: () => registry.filter((v) => v.open).length,
  current: () => existsSync(A) ? A : null,
  ...overrides,
})

// ---- 1. the resolver
{
  assert.deepEqual(presentedTalkVault(lookup(), OUTLINE_B), { root: B }, 'a talk in B: B, not the first vault')
  assert.deepEqual(presentedTalkVault(lookup(), join(base, 'closed', 'Talks', 'x', 'x-outline.md')), { error: TALK_VAULT_NOT_OPEN }, 'a closed vault is refused')
  assert.deepEqual(presentedTalkVault(lookup(), join(base, 'loose', 'x-outline.md')), { error: VAULT_NOT_NAMED }, 'a talk in no vault while two are open is refused')
  const one = lookup({ openVaults: () => 1 })
  assert.deepEqual(presentedTalkVault(one, join(base, 'loose', 'x-outline.md')), { root: A }, 'one vault open: the current vault, as before')
  assert.deepEqual(presentedTalkVault(lookup({ writable: () => undefined }), OUTLINE_B), { error: TALK_VAULT_NOT_OPEN }, 'B\'s folder gone: refused, never A')
  assert.deepEqual(presentedTalkVault(lookup({ writable: () => undefined, openVaults: () => 1, current: () => null }), OUTLINE_B), { root: null }, 'the only open vault gone: no vault (kept)')
  console.log('ok  1 the presented talk\'s vault')
}

// ---- the recording IPC over an Electron stand-in
const handlers = new Map()
const trashed = []
const closedRoots = new Set() // vaults closed after a save (writableVault answers undefined)
const unavailableRoots = new Set() // still open in the registry, but unavailable to the app
globalThis.__recordingVaultTest = {
  ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  shell: { trashItem: async (p) => { trashed.push(p) } },
  dialog: {},
}
const bundled = await build({ entryPoints: ['src/main/recording.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', plugins: [{ name: 'electron-test-boundary', setup(b) {
  b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test' }))
  b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'module.exports = globalThis.__recordingVaultTest', loader: 'js' }))
} }] })
const module = { exports: {} }
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const recording = module.exports

// New session ids draw from a crypto source by default; section 5 forces a repeating source through `sessionRand`.
let forcedRand = null
let uploadTestMode = true
let transcriptTestMode = false
const uploads = []

const PRESENTER = 41 // presents the talk in B
const STUDIO = 42 // not a presenter window
const OTHER_PRESENTER = 43 // a second presenter window of a talk in B
let presenterPick = { root: B }
recording.registerRecordingIpc({
  compilerDir: () => resolve('compiler/scripts'),
  userDataDir: () => userData,
  vaultRoot: () => A,
  openVaultRoots: () => registry.filter((v) => v.open && !closedRoots.has(v.root) && !unavailableRoots.has(v.root)).map((v) => v.root),
  hasUnavailableOpenVaults: () => registry.some((v) => v.open && unavailableRoots.has(v.root)),
  discardThresholdMs: () => 0,
  storage: () => ({ upload: async (key, body, contentType) => {
    uploads.push({ key, body: Buffer.from(body).toString('utf8'), contentType })
    return { ok: true }
  } }),
  testMode: () => uploadTestMode,
  presenterVault: (id) => id === PRESENTER ? presenterPick : id === OTHER_PRESENTER ? { root: B } : undefined,
  writableVault: (root) => [A, B].includes(root) && !closedRoots.has(root) && existsSync(root) ? root : undefined,
  sessionRand: () => forcedRand ? forcedRand() : Math.random(),
})
const sender = (id) => {
  const events = {}
  return { id, once: (name, fn) => { events[name] = fn }, on: () => {}, fire: (name) => events[name]?.() }
}
const runsIn = (root) => {
  const folder = join(root, '_PRESENTATIONS', SLUG)
  return existsSync(folder) ? readdirSync(folder).filter((n) => n.endsWith('.json')).sort() : []
}
const nothingIn = (root) => !existsSync(join(root, '_PRESENTATIONS'))
const readRun = (root, id) => JSON.parse(readFileSync(join(root, '_PRESENTATIONS', SLUG, `${id}.json`), 'utf8'))
const runPayload = (extra = {}) => ({ talkSlug: SLUG, talkTitle: 'AI for research teams', mode: 'run', kind: 'rehearsal', wallClockMs: 60_000, rawMarks: [], force: true, ...extra })

// ---- 2. save, set-kind, finalise-run and the plan picker from the presenter window
{
  const presenter = sender(PRESENTER)
  const saved = await handlers.get('recording:save')({ sender: presenter }, runPayload())
  assert.equal(saved.ok, true, saved.error)
  assert.deepEqual(runsIn(B), [`${saved.sessionId}.json`], 'the Run is written into B, the presented talk\'s vault')
  assert.ok(nothingIn(A), 'and nothing into A, the first vault')

  const kind = await handlers.get('recording:set-kind')({ sender: presenter }, { talkSlug: SLUG, sessionId: saved.sessionId, kind: 'delivery' })
  assert.equal(kind.ok, true, kind.error)
  assert.equal(readRun(B, saved.sessionId).kind, 'delivery', 'set-kind changes B\'s Run')
  const fin = await handlers.get('recording:finalise-run')({ sender: presenter }, { talkSlug: SLUG, sessionId: saved.sessionId, rawMarks: [], wallClockMs: 90_000 })
  assert.equal(fin.ok, true, fin.error)
  assert.equal(readRun(B, saved.sessionId).wallClockMs, 90_000, 'finalise-run changes B\'s Run')
  assert.ok(nothingIn(A))

  // A recording (audio in memory) saved from the presenter: its Run is in B; the audio stays in userData.
  const audio = new Uint8Array([1, 2, 3, 4]).buffer
  const rec = await handlers.get('recording:save')({ sender: presenter }, { ...runPayload({ mode: 'recording', kind: 'delivery' }), rawMarks: [{ event: 'start', tMs: 0 }, { event: 'stop', tMs: 30_000 }], audio })
  assert.equal(rec.ok, true, rec.error)
  assert.ok(runsIn(B).includes(`${rec.sessionId}.json`), 'a recording\'s Run is written into B')
  assert.ok(nothingIn(A))

  // The plan picker lists B's planned Runs (the Run the save attaches to is in B).
  const planned = { ...readRun(B, saved.sessionId), id: 'run-planned-b', status: 'planned', plannedDate: '2026-11-20' }
  writeFileSync(join(B, '_PRESENTATIONS', SLUG, 'run-planned-b.json'), JSON.stringify(planned))
  const picks = await handlers.get('recording:planned-runs')({ sender: presenter }, SLUG, null)
  assert.ok(picks.some((run) => run.id === 'run-planned-b'), 'the presenter is offered B\'s planned Run')
  const attached = await handlers.get('recording:save')({ sender: presenter }, runPayload({ plannedRunId: 'run-planned-b' }))
  assert.equal(attached.ok, true, attached.error)
  assert.equal(readRun(B, 'run-planned-b').status, 'delivered', 'the delivery is attached to B\'s planned Run')
  assert.ok(nothingIn(A))

  // The talk's vault is closed, or several vaults are open and none is named: the recording is never refused and never
  // put in another vault. Its Run is kept beside its audio in TalkWeaver's own folder, and the presenter is told.
  const appRuns = () => existsSync(join(userData, 'recordings')) ? readdirSync(join(userData, 'recordings')).filter((n) => n.endsWith('.json') && !n.endsWith('.recording.json')) : []
  for (const [pick, why] of [[{ error: TALK_VAULT_NOT_OPEN }, 'the talk\'s vault is closed'], [{ error: VAULT_NOT_NAMED }, 'several vaults open, none named']]) {
    presenterPick = pick
    const beforeB = runsIn(B).join(',')
    const beforeApp = appRuns().length
    const kept = await handlers.get('recording:save')({ sender: presenter }, { ...runPayload({ mode: 'recording', kind: 'delivery', plannedRunId: 'run-planned-b' }), rawMarks: [{ event: 'start', tMs: 0 }, { event: 'stop', tMs: 30_000 }], audio: new Uint8Array([5, 6, 7]).buffer })
    assert.equal(kept.ok, true, `${why}: the save succeeds (${kept.error})`)
    assert.equal(kept.kept, 'app-data', `${why}: it says the Run was kept in TalkWeaver's folder`)
    assert.equal(kept.message, recording.KEPT_IN_APP_DATA)
    assert.ok(existsSync(join(userData, 'recordings', `${kept.sessionId}.webm`)), `${why}: the audio is kept`)
    assert.ok(existsSync(join(userData, 'recordings', `${kept.sessionId}.json`)), `${why}: the Run is kept beside its audio`)
    assert.equal(appRuns().length, beforeApp + 1)
    assert.equal(runsIn(B).join(','), beforeB, `${why}: nothing written into B`)
    assert.ok(nothingIn(A), `${why}: nothing written into A`)
    const fin2 = await handlers.get('recording:set-kind')({ sender: presenter }, { talkSlug: SLUG, sessionId: kept.sessionId, kind: 'rehearsal' })
    assert.equal(fin2.ok, true, `${why}: set-kind changes the kept Run (${fin2.error})`)
    assert.equal(JSON.parse(readFileSync(join(userData, 'recordings', `${kept.sessionId}.json`), 'utf8')).kind, 'rehearsal')
    assert.deepEqual(await handlers.get('recording:planned-runs')({ sender: presenter }, SLUG, null), [], 'no plans are offered from another vault')
  }
  presenterPick = { root: B }
  console.log('ok  2 save, set-kind, finalise-run and the plan picker act in the presented talk\'s vault')
}

// ---- 2b. updates follow the Run to where it was saved; a null vault is kept with the notice; delete checks the Run
{
  const presenter = sender(PRESENTER)
  const kept = (id) => join(userData, 'recordings', `${id}.json`)
  const readKept = (id) => JSON.parse(readFileSync(kept(id), 'utf8'))

  // Saved while B was closed (kept in TalkWeaver's folder); B reopens; the presenter finalises and edits the Run.
  presenterPick = { error: TALK_VAULT_NOT_OPEN }
  const saved = await handlers.get('recording:save')({ sender: presenter }, runPayload())
  assert.equal(saved.ok, true, saved.error)
  assert.equal(saved.kept, 'app-data')
  presenterPick = { root: B }
  const beforeB = runsIn(B).join(',')
  const marks = [{ event: 'enter', slideId: 's1', tMs: 0 }, { event: 'enter', slideId: 's2', tMs: 40_000 }]
  const fin = await handlers.get('recording:finalise-run')({ sender: presenter }, { talkSlug: SLUG, sessionId: saved.sessionId, rawMarks: marks, wallClockMs: 95_000 })
  assert.equal(fin.ok, true, `finalise after B reopens reaches the kept Run (${fin.error})`)
  assert.equal(readKept(saved.sessionId).wallClockMs, 95_000, 'the timings land in the kept Run')
  assert.deepEqual(readKept(saved.sessionId).slideTimeIndex.map((m) => m.slideId), ['s1', 's2'], 'and the marks')
  const kind = await handlers.get('recording:set-kind')({ sender: presenter }, { talkSlug: SLUG, sessionId: saved.sessionId, kind: 'recording' })
  assert.equal(kind.ok, true, kind.error)
  const trims = await handlers.get('recording:set-trims')({ sender: presenter }, { talkSlug: SLUG, sessionId: saved.sessionId, trims: [{ start: 0, end: 1000 }] })
  assert.equal(trims.ok, true, trims.error)
  const ctx = await handlers.get('recording:set-context')({ sender: presenter }, { talkSlug: SLUG, sessionId: saved.sessionId, context: 'York' })
  assert.equal(ctx.ok, true, ctx.error)
  const after = readKept(saved.sessionId)
  assert.deepEqual([after.kind, after.trims, after.context], ['recording', [{ start: 0, end: 1000 }], 'York'], 'kind, trims and context land in the kept Run')
  assert.equal(runsIn(B).join(','), beforeB, 'nothing is created in B')
  assert.ok(nothingIn(A))

  // Saved into B, then B closes: the update is refused, and no copy is made in TalkWeaver's folder.
  const inB = await handlers.get('recording:save')({ sender: presenter }, runPayload())
  assert.equal(inB.ok, true, inB.error)
  closedRoots.add(B)
  presenterPick = { error: TALK_VAULT_NOT_OPEN }
  const refusedFin = await handlers.get('recording:finalise-run')({ sender: presenter }, { talkSlug: SLUG, sessionId: inB.sessionId, rawMarks: marks, wallClockMs: 1 })
  assert.equal(refusedFin.ok, false, 'a Run saved into a vault that is closed now is not updated elsewhere')
  assert.deepEqual(await handlers.get('recording:upload')({ sender: presenter }, { talkSlug: SLUG, sessionId: inB.sessionId }), { ok: false, error: 'vault-not-open' }, 'upload also refuses the closed saved home')
  assert.ok(!existsSync(kept(inB.sessionId)), 'and no second copy is written')
  closedRoots.delete(B)
  presenterPick = { root: B }
  assert.equal(readRun(B, inB.sessionId).wallClockMs, 60_000, 'B\'s Run is untouched')

  // The only open vault became unavailable (root null): the save is kept, and the presenter is told.
  presenterPick = { root: null }
  const nul = await handlers.get('recording:save')({ sender: presenter }, { ...runPayload({ mode: 'recording', kind: 'delivery' }), rawMarks: [{ event: 'start', tMs: 0 }, { event: 'stop', tMs: 30_000 }], audio: new Uint8Array([7, 7]).buffer })
  assert.equal(nul.ok, true, nul.error)
  assert.equal(nul.kept, 'app-data', 'a null vault is reported as kept')
  assert.equal(nul.message, recording.KEPT_IN_APP_DATA, 'with the notice')
  assert.ok(existsSync(kept(nul.sessionId)), 'the Run is kept beside its audio')
  presenterPick = { root: B }

  // Delete: a valid session id with a talk slug whose Run is not there is refused, and its audio stays.
  const audio = new Uint8Array([1, 2, 3]).buffer
  const rec = await handlers.get('recording:save')({ sender: presenter }, { ...runPayload({ mode: 'recording', kind: 'delivery' }), rawMarks: [{ event: 'start', tMs: 0 }, { event: 'stop', tMs: 30_000 }], audio })
  assert.equal(rec.ok, true, rec.error)
  const recAudio = join(userData, 'recordings', `${rec.sessionId}.webm`)
  trashed.length = 0
  const other = sender(OTHER_PRESENTER) // another presenter window, of a talk in B, that never saved this Run
  const wrong = await handlers.get('recording:delete-session')({ sender: other }, { talkSlug: 'no-such-talk', sessionId: rec.sessionId })
  assert.equal(wrong.ok, false, 'a session id with a talk slug that has no such Run is refused')
  assert.deepEqual(trashed, [], 'nothing is trashed')
  assert.ok(existsSync(recAudio), 'its audio stays')
  // A Run JSON of this talk copied into another talk's folder in B: deleting under that talk is refused, nothing is
  // trashed and the audio stays (the folder proves nothing; the Run must name the talk itself).
  const otherFolder = join(B, '_PRESENTATIONS', 'other-talk')
  mkdirSync(otherFolder, { recursive: true })
  writeFileSync(join(otherFolder, `${rec.sessionId}.json`), readFileSync(join(B, '_PRESENTATIONS', SLUG, `${rec.sessionId}.json`)))
  const copied = await handlers.get('recording:delete-session')({ sender: other }, { talkSlug: 'other-talk', sessionId: rec.sessionId })
  assert.equal(copied.ok, false, 'a Run JSON copied into another talk\'s folder does not let that talk delete it')
  assert.deepEqual(trashed, [], 'nothing is trashed')
  assert.ok(existsSync(recAudio), 'its audio stays')
  // An older Run with no talkSlug of its own is refused too.
  const { talkSlug: _drop, ...noSlug } = readRun(B, rec.sessionId)
  writeFileSync(join(otherFolder, `${rec.sessionId}.json`), JSON.stringify(noSlug))
  assert.equal((await handlers.get('recording:delete-session')({ sender: other }, { talkSlug: 'other-talk', sessionId: rec.sessionId })).ok, false, 'a Run with no talkSlug is refused')
  assert.deepEqual(trashed, [])
  rmSync(otherFolder, { recursive: true, force: true })
  // The real Run in B, under its own talk: deleted.
  const realDelete = await handlers.get('recording:delete-session')({ sender: other }, { talkSlug: SLUG, sessionId: rec.sessionId })
  assert.equal(realDelete.ok, true, realDelete.error)
  assert.deepEqual(trashed.sort(), [join(B, '_PRESENTATIONS', SLUG, `${rec.sessionId}.json`), recAudio].sort(), 'B\'s Run and its audio are trashed')
  trashed.length = 0
  // The same for a kept Run: TalkWeaver's folder names it by id alone, so its talk must match.
  const wrongKept = await handlers.get('recording:delete-session')({ sender: presenter }, { talkSlug: 'no-such-talk', sessionId: nul.sessionId })
  assert.equal(wrongKept.ok, false, 'a kept Run asked for under another talk is refused')
  assert.deepEqual(trashed, [])
  // The right talk: the Run and its audio go to the Trash.
  const right = await handlers.get('recording:delete-session')({ sender: presenter }, { talkSlug: SLUG, sessionId: nul.sessionId })
  assert.equal(right.ok, true, right.error)
  assert.deepEqual(trashed.sort(), [kept(nul.sessionId), join(userData, 'recordings', `${nul.sessionId}.webm`)].sort(), 'the kept Run and its audio are trashed')
  trashed.length = 0
  console.log('ok  2b updates follow the Run to where it was saved; a null vault is kept with the notice; delete checks the Run')
}

// ---- 3. a streamed recording interrupted mid-way is recovered into B
{
  const presenter = sender(PRESENTER)
  const opened = await handlers.get('recording:stream-open')({ sender: presenter }, { talkSlug: SLUG, talkTitle: 'AI for research teams' })
  assert.equal(opened.ok, true, opened.error)
  const marker = JSON.parse(readFileSync(join(userData, 'recordings', `${opened.sessionId}.recording.json`), 'utf8'))
  assert.equal(marker.vaultRoot, B, 'the in-progress marker keeps the presented talk\'s vault')
  assert.equal((await handlers.get('recording:stream-segment')({ sender: presenter }, { sessionId: opened.sessionId, index: 0, startMs: 0 })).ok, true)
  assert.equal((await handlers.get('recording:stream-append')({ sender: presenter }, { sessionId: opened.sessionId, index: 0, bytes: new Uint8Array([9, 9, 9]) })).ok, true)
  presenter.fire('destroyed') // the window goes mid-recording: recovered at once
  for (let i = 0; i < 50 && !runsIn(B).includes(`${opened.sessionId}.json`); i++) await new Promise((r) => setTimeout(r, 20))
  assert.ok(runsIn(B).includes(`${opened.sessionId}.json`), 'the partial Run is recovered into B')
  assert.ok(nothingIn(A), 'never into A')

  // A marker written before 0.41 (no vault): the current vault, as then.
  const legacyId = 'sess-20261001T100000Z-x'
  writeFileSync(join(userData, 'recordings', `${legacyId}.webm`), Buffer.from([1, 2, 3]))
  writeFileSync(join(userData, 'recordings', `${legacyId}.recording.json`), JSON.stringify({ version: 1, sessionId: legacyId, talkSlug: SLUG, talkTitle: 'x', startedAt: '2026-10-01T10:00:00.000Z', segments: [{ index: 0, startMs: 0, endMs: null }], gaps: [], rawMarks: [], recordingMs: 1000 }))
  // A marker naming a vault that is not open now: left for later, written nowhere.
  const waitingId = 'sess-20261001T110000Z-y'
  writeFileSync(join(userData, 'recordings', `${waitingId}.webm`), Buffer.from([1, 2, 3]))
  writeFileSync(join(userData, 'recordings', `${waitingId}.recording.json`), JSON.stringify({ version: 1, sessionId: waitingId, talkSlug: SLUG, talkTitle: 'x', startedAt: '2026-10-01T11:00:00.000Z', vaultRoot: join(base, 'closed'), segments: [{ index: 0, startMs: 0, endMs: null }], gaps: [], rawMarks: [], recordingMs: 1000 }))
  await recording.recoverInterruptedRecordings()
  assert.deepEqual(runsIn(A), [`${legacyId}.json`], 'a marker with no vault is recovered into the current vault, as before')
  assert.ok(!runsIn(B).includes(`${waitingId}.json`) && !runsIn(A).includes(`${waitingId}.json`), 'a marker whose vault is not open is written nowhere')
  assert.ok(existsSync(join(userData, 'recordings', `${waitingId}.recording.json`)), 'and its marker stays for a later recovery')
  assert.ok(!existsSync(join(base, 'closed')), 'the closed vault\'s folder is never created')
  rmSync(join(A, '_PRESENTATIONS'), { recursive: true, force: true })
  console.log('ok  3 an interrupted recording is recovered into the vault it was recorded for')
}

// ---- 4. Studio and History (not a presenter window) act in the current vault, as they list it
{
  const studio = sender(STUDIO)
  mkdirSync(join(A, '_PRESENTATIONS', SLUG), { recursive: true })
  const run = { ...readRun(B, 'run-planned-b'), id: 'run-in-a' }
  writeFileSync(join(A, '_PRESENTATIONS', SLUG, 'run-in-a.json'), JSON.stringify(run))
  const set = await handlers.get('recording:set-context')({ sender: studio }, { talkSlug: SLUG, sessionId: 'run-in-a', context: 'Oxford' })
  assert.equal(set.ok, true, set.error)
  assert.equal(readRun(A, 'run-in-a').context, 'Oxford')
  assert.ok(!runsIn(B).includes('run-in-a.json'))
  console.log('ok  4 Studio and History still act in the current vault')
}

// ---- 5. two recordings never share a session id, and a first save never replaces a Run or audio file
{
  const presenter = sender(PRESENTER)
  presenterPick = { root: B }
  const realNow = Date.now
  Date.now = () => Date.UTC(2026, 9, 20, 12, 0, 0) // every id below is made in the same second
  const recDir = join(userData, 'recordings')
  try {
    // The same random draws every time: the second save in that second would get the first one's id.
    forcedRand = () => 0.5
    const first = await handlers.get('recording:save')({ sender: presenter }, runPayload())
    assert.equal(first.ok, true, first.error)
    assert.equal(first.sessionId, 'sess-20261020-120000-iiiiiiii')
    const firstRun = readFileSync(join(B, '_PRESENTATIONS', SLUG, `${first.sessionId}.json`), 'utf8')
    const clash = await handlers.get('recording:save')({ sender: presenter }, { ...runPayload({ mode: 'recording', kind: 'delivery' }), rawMarks: [{ event: 'start', tMs: 0 }, { event: 'stop', tMs: 30_000 }], audio: new Uint8Array([7, 7]).buffer })
    assert.deepEqual([clash.ok, clash.error], [false, 'session-id-taken'], 'every fresh id is taken: the save refuses')
    assert.equal(readFileSync(join(B, '_PRESENTATIONS', SLUG, `${first.sessionId}.json`), 'utf8'), firstRun, 'the earlier Run is untouched')
    assert.ok(!existsSync(join(recDir, `${first.sessionId}.webm`)), 'and no audio is written under its id')

    // The first draw repeats once, then changes: the save takes the next id. An audio file already named for the
    // first id (a recording whose Run is elsewhere) is not replaced.
    const taken = 'sess-20261020-120000-99999999'
    writeFileSync(join(recDir, `${taken}.webm`), Buffer.from('earlier audio'))
    let draws = 0
    forcedRand = () => (draws++ < 8 ? 0.25 + 0.0001 : 0.75)
    const next = await handlers.get('recording:save')({ sender: presenter }, { ...runPayload({ mode: 'recording', kind: 'delivery' }), rawMarks: [{ event: 'start', tMs: 0 }, { event: 'stop', tMs: 30_000 }], audio: new Uint8Array([8, 8]).buffer })
    assert.equal(next.ok, true, next.error)
    assert.equal(next.sessionId, 'sess-20261020-120000-rrrrrrrr', 'a fresh id after the taken one')
    assert.equal(readFileSync(join(recDir, `${taken}.webm`), 'utf8'), 'earlier audio', 'the earlier audio is untouched')
    assert.deepEqual([...readFileSync(join(recDir, `${next.sessionId}.webm`))], [8, 8])

    // A planned Run whose id already names an audio file (a stray earlier file): the save refuses, never replaces it.
    const plannedC = { ...JSON.parse(firstRun), id: 'run-planned-c', status: 'planned', plannedDate: '2026-11-21' }
    writeFileSync(join(B, '_PRESENTATIONS', SLUG, 'run-planned-c.json'), JSON.stringify(plannedC))
    writeFileSync(join(recDir, 'run-planned-c.webm'), 'stray audio')
    const ontoPlanned = await handlers.get('recording:save')({ sender: presenter }, { ...runPayload({ mode: 'recording', kind: 'delivery', plannedRunId: 'run-planned-c' }), rawMarks: [{ event: 'start', tMs: 0 }, { event: 'stop', tMs: 30_000 }], audio: new Uint8Array([6]).buffer })
    assert.deepEqual([ontoPlanned.ok, ontoPlanned.error], [false, 'session-id-taken'])
    assert.equal(readFileSync(join(recDir, 'run-planned-c.webm'), 'utf8'), 'stray audio', 'the existing audio file is not replaced')
    assert.equal(readRun(B, 'run-planned-c').status, 'planned', 'and the planned Run is unchanged')

    // A streamed recording: a second open in the same second with the same draws is refused, not given the open one's id.
    forcedRand = () => 0.1
    const open1 = await handlers.get('recording:stream-open')({ sender: presenter }, { talkSlug: SLUG, talkTitle: 'AI for research teams' })
    assert.equal(open1.ok, true, open1.error)
    const marker1 = readFileSync(join(recDir, `${open1.sessionId}.recording.json`), 'utf8')
    const open2 = await handlers.get('recording:stream-open')({ sender: sender(OTHER_PRESENTER) }, { talkSlug: SLUG, talkTitle: 'AI for research teams' })
    assert.deepEqual([open2.ok, open2.error], [false, 'id-taken'], 'the second open is refused (the bridge then keeps its audio in memory)')
    assert.equal(readFileSync(join(recDir, `${open1.sessionId}.recording.json`), 'utf8'), marker1, 'the open recording\'s marker is untouched')

    // The streamed save creates its Run exclusively: a Run that appeared under its id is never replaced.
    assert.equal((await handlers.get('recording:stream-segment')({ sender: presenter }, { sessionId: open1.sessionId, index: 0, startMs: 0 })).ok, true)
    assert.equal((await handlers.get('recording:stream-append')({ sender: presenter }, { sessionId: open1.sessionId, index: 0, bytes: new Uint8Array([4, 4]) })).ok, true)
    const planted = join(B, '_PRESENTATIONS', SLUG, `${open1.sessionId}.json`)
    writeFileSync(planted, '{"id":"planted"}')
    const streamedSave = await handlers.get('recording:save')({ sender: presenter }, { ...runPayload({ mode: 'recording', kind: 'delivery' }), rawMarks: [{ event: 'start', tMs: 0 }, { event: 'stop', tMs: 30_000 }], stream: { sessionId: open1.sessionId, tail: [] } })
    assert.deepEqual([streamedSave.ok, streamedSave.error], [false, 'session-id-taken'])
    assert.equal(readFileSync(planted, 'utf8'), '{"id":"planted"}', 'the existing Run is untouched')
    assert.ok(existsSync(join(recDir, `${open1.sessionId}.webm`)), 'and the streamed audio stays on disk')
  } finally {
    Date.now = realNow
    forcedRand = null
  }

  // The exclusive Run writer itself: a new file is written whole; an existing one is left and the write throws EEXIST.
  const dir = join(base, 'exclusive')
  const fresh = join(dir, 'sess-1.json')
  writeNewRunFile(fresh, { id: 'sess-1', talkSlug: SLUG })
  assert.equal(JSON.parse(readFileSync(fresh, 'utf8')).id, 'sess-1')
  assert.throws(() => writeNewRunFile(fresh, { id: 'other', talkSlug: SLUG }), (e) => e.code === 'EEXIST')
  assert.equal(JSON.parse(readFileSync(fresh, 'utf8')).id, 'sess-1', 'the existing Run is not replaced')
  assert.deepEqual(readdirSync(dir), ['sess-1.json'], 'no temporary file is left behind')
  console.log('ok  5 two recordings never share a session id; a first save never replaces a Run or audio file')
}

// ---- 6. no hard links: a save that fails after reserving the Run's name leaves no empty Run behind
{
  const dir = join(base, 'no-hard-links')
  const target = join(dir, 'sess-2.json')
  const real = { linkSync: fs.linkSync, renameSync: fs.renameSync }
  const failWith = (code) => () => { throw Object.assign(new Error(code), { code }) }
  const inject = (fns) => { Object.assign(fs, fns); syncBuiltinESMExports() }
  try {
    inject({ linkSync: failWith('ENOTSUP'), renameSync: failWith('EIO') })
    assert.throws(() => writeNewRunFile(target, { id: 'sess-2', talkSlug: SLUG }), (e) => e.code === 'EIO')
    assert.deepEqual(readdirSync(dir), [], 'the empty reservation is removed, and the temporary file')
    // The reservation is no longer the empty file made here (something wrote into it): left alone.
    inject({ linkSync: failWith('ENOTSUP'), renameSync: (_from, to) => { writeFileSync(to, '{"id":"someone"}'); throw Object.assign(new Error('EIO'), { code: 'EIO' }) } })
    assert.throws(() => writeNewRunFile(target, { id: 'sess-2', talkSlug: SLUG }), (e) => e.code === 'EIO')
    assert.equal(readFileSync(target, 'utf8'), '{"id":"someone"}', 'a file that is not the empty reservation is kept')
    rmSync(target)
    // No hard links, rename works: the Run is written whole over the reservation.
    inject({ linkSync: failWith('ENOTSUP'), renameSync: real.renameSync })
    writeNewRunFile(target, { id: 'sess-2', talkSlug: SLUG })
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).id, 'sess-2')
    assert.throws(() => writeNewRunFile(target, { id: 'other', talkSlug: SLUG }), (e) => e.code === 'EEXIST')
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).id, 'sess-2', 'still exclusive without hard links')
    assert.deepEqual(readdirSync(dir), ['sess-2.json'])
  } finally {
    inject(real)
  }
  console.log('ok  6 without hard links, a failed first save leaves no empty Run file in its place')
}

// Transcription's real IPC, with only Electron and process launch handed in: inspect its inputs.
const transcodes = []
globalThis.__recordingTranscode = { spawn: (_command, args) => {
  transcodes.push(args)
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  queueMicrotask(() => child.emit('close', 1, null))
  return child
} }
const transBundle = await build({ entryPoints: ['src/main/transcription.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', plugins: [{ name: 'transcription-boundary', setup(b) {
  b.onResolve({ filter: /^(electron|child_process)$/ }, (args) => ({ path: args.path, namespace: 'test' }))
  b.onLoad({ filter: /.*/, namespace: 'test' }, (args) => ({ contents: `module.exports = globalThis.${args.path === 'electron' ? '__recordingVaultTest' : '__recordingTranscode'}`, loader: 'js' }))
} }] })
const transModule = { exports: {} }
new Function('require', 'module', 'exports', transBundle.outputFiles[0].text)(createRequire(import.meta.url), transModule, transModule.exports)
transModule.exports.registerTranscriptionIpc({
  userDataDir: () => userData, vaultRoot: () => A,
  config: () => ({ python: 'python', script: 'transcribe.py' }), testMode: () => transcriptTestMode,
  readiness: () => ({ row: { state: 'ready' }, ffmpeg: { found: true, path: '/fixture/ffmpeg' } }),
})
const transcribeInputs = async (id) => {
  transcodes.length = 0
  await handlers.get('transcript:run')({ sender: sender(STUDIO) }, SLUG, id)
  return transcodes.flatMap((args) => args.flatMap((arg, i) => arg === '-i' ? [args[i + 1]] : []))
}

// ---- 7. audio consumers follow the Run's list, including replacement files, never neighbours.
{
  const recDir = join(userData, 'recordings')
  const id = 'owned-audio'
  const runPath = join(A, '_PRESENTATIONS', SLUG, `${id}.json`)
  mkdirSync(join(A, '_PRESENTATIONS', SLUG), { recursive: true })
  const foreign = join(recDir, `${id}.webm`)
  const extra = join(recDir, `${id}.seg-3.webm`)
  const prefix = join(recDir, `${id}-other.webm`)
  const owned = join(recDir, `${id}.seg-2.r1.webm`)
  for (const file of [foreign, extra, prefix]) writeFileSync(file, 'FOREIGN')
  writeFileSync(owned, 'OWNED')
  const run = { id, talkSlug: SLUG, audio: { segments: [{ file: `${id}.seg-2.r1.webm`, bytes: 5, startMs: 1000, endMs: 5000 }] } }
  writeFileSync(runPath, JSON.stringify(run))
  assert.equal(await recording.recordingAudioPath(userData, id, A, SLUG), owned, 'playback uses the first listed segment, including a replacement')
  assert.deepEqual(await transcribeInputs(id), [owned], 'transcription uses the replacement, never the unlisted first file')
  const later = join(recDir, `${id}.seg-4.webm`)
  writeFileSync(later, 'LATER')
  writeFileSync(runPath, JSON.stringify({ ...run, audio: { segments: [...run.audio.segments, { file: `${id}.seg-4.webm`, startMs: 8000, endMs: 9000 }] } }))
  assert.deepEqual(await transcribeInputs(id), [owned, 'anullsrc=r=48000:cl=mono', later], 'only listed segments are joined in order with their timing gap')
  assert.ok(transcodes[0].includes('3.000'), 'the silence uses the recorded 3-second gap')
  rmSync(later)
  writeFileSync(runPath, JSON.stringify(run))
  trashed.length = 0
  assert.equal((await handlers.get('recording:delete-session')({ sender: sender(STUDIO) }, { talkSlug: SLUG, sessionId: id })).ok, true)
  assert.deepEqual(trashed.sort(), [runPath, owned].sort(), 'only the Run and its listed audio are trashed')
  for (const file of [foreign, extra, prefix]) assert.equal(readFileSync(file, 'utf8'), 'FOREIGN')

  writeFileSync(runPath, JSON.stringify({ ...run, audio: { segments: [] } }))
  assert.equal(await recording.recordingAudioPath(userData, id, A, SLUG), null, 'an explicit empty list never falls back')
  assert.deepEqual(await transcribeInputs(id), [], 'empty segments do not launch ffmpeg')
  trashed.length = 0
  await handlers.get('recording:delete-session')({ sender: sender(STUDIO) }, { talkSlug: SLUG, sessionId: id })
  assert.deepEqual(trashed, [runPath], 'an empty list deletes no audio')

  // No segment metadata is the legacy contract; do not rewrite the Run to adopt found files.
  const legacy = JSON.stringify({ id, talkSlug: SLUG, audio: { bytes: 7, uploaded: false } })
  writeFileSync(runPath, legacy)
  assert.equal(await recording.recordingAudioPath(userData, id, A, SLUG), foreign, 'a legacy Run still plays')
  assert.deepEqual(await transcribeInputs(id), [foreign, extra], 'legacy transcription retains the exact old lookup')
  assert.equal(readFileSync(runPath, 'utf8'), legacy, 'legacy playback and source lookup are read-only')
  trashed.length = 0
  await handlers.get('recording:delete-session')({ sender: sender(STUDIO) }, { talkSlug: SLUG, sessionId: id })
  assert.deepEqual(trashed.sort(), [runPath, foreign, extra].sort(), 'legacy deletion uses only the exact old session filenames')
  // Listed paths are checked just like recovery, including symlinks and another session's name.
  const outside = join(base, 'outside.webm')
  writeFileSync(outside, 'OUTSIDE')
  rmSync(owned)
  symlinkSync(outside, owned)
  for (const file of [`${id}.seg-2.r1.webm`, 'other.webm', '../outside.webm', `${id}.seg-9999.webm`]) {
    writeFileSync(runPath, JSON.stringify({ ...run, audio: { segments: [{ file, startMs: 0, endMs: 5000 }] } }))
    assert.equal(recording.recordingAudioPath(userData, id, A, SLUG), null, `playback refuses ${file}`)
    assert.deepEqual(await transcribeInputs(id), [], `transcription refuses ${file}`)
    trashed.length = 0
    await handlers.get('recording:delete-session')({ sender: sender(STUDIO) }, { talkSlug: SLUG, sessionId: id })
    assert.deepEqual(trashed, [runPath], `delete refuses ${file}`)
  }
  rmSync(owned)
  writeFileSync(owned, 'OWNED')
  rmSync(runPath)
  const marker = join(recDir, `${id}.recording.json`)
  writeFileSync(marker, JSON.stringify({ sessionId: id, talkSlug: SLUG, segments: [{ index: 1, file: `${id}.seg-2.r1.webm`, startMs: 1000, endMs: 5000 }] }))
  assert.equal(recording.recordingAudioPath(userData, id, A, SLUG), owned, 'the marker supplies its own listed files before recovery')
  assert.deepEqual(await transcribeInputs(id), [owned])
  trashed.length = 0
  assert.equal((await handlers.get('recording:delete-session')({ sender: sender(STUDIO) }, { talkSlug: SLUG, sessionId: id })).ok, true)
  assert.deepEqual(trashed.sort(), [marker, owned].sort(), 'deleting an interrupted session uses only its marker list')
  assert.equal(readFileSync(outside, 'utf8'), 'OUTSIDE')
  console.log('ok  7 playback, transcription and delete follow the Run/marker list; legacy audio still works')
}

// ---- 8. upload reads the first owned segment, including a replacement, never an unlisted file.
{
  const id = 'upload-owned'
  const recDir = join(userData, 'recordings')
  const runPath = join(A, '_PRESENTATIONS', SLUG, `${id}.json`)
  const store = createRecordingStreams({ userDataDir: () => userData })
  assert.equal(store.open(STUDIO, { sessionId: id, talkSlug: SLUG }).ok, true)
  const foreign = join(recDir, `${id}.webm`)
  writeFileSync(foreign, 'FOREIGN') // arrives after open, before segment 0 reserves its file
  assert.equal(store.startSegment(STUDIO, id, 0, 0).ok, false)
  const fin = store.finalise(STUDIO, id, { recordingMs: 5000 }, [{ index: 0, bytes: new Uint8Array(Buffer.from('OWNED')) }])
  assert.equal(fin.ok, true)
  assert.equal(fin.segments[0].file, `${id}.seg-1.r1.webm`)
  store.complete(id)
  const r2Key = `presentations/${SLUG}/${id}/audio.webm`
  const run = { id, talkSlug: SLUG, audio: { r2Key, uploaded: false, segments: fin.segments } }
  const upload = () => handlers.get('recording:upload')({ sender: sender(STUDIO) }, { talkSlug: SLUG, sessionId: id })
  uploadTestMode = false // exercises the real handler with an in-memory uploader; no R2 or keys
  try {
    writeFileSync(runPath, JSON.stringify(run))
    uploads.length = 0
    assert.deepEqual(await upload(), { ok: true, uploaded: true })
    assert.deepEqual(uploads, [{ key: r2Key, body: 'OWNED', contentType: 'audio/webm' }], 'upload reads the listed replacement, never the foreign exact-name file')
    assert.equal(readRun(A, id).audio.uploaded, true)
    assert.equal(readFileSync(foreign, 'utf8'), 'FOREIGN')

    const later = `${id}.seg-2.webm`
    writeFileSync(join(recDir, later), 'LATER')
    writeFileSync(runPath, JSON.stringify({ ...run, audio: { ...run.audio, segments: [...fin.segments, { file: later, startMs: 6000, endMs: 7000 }] } }))
    uploads.length = 0
    assert.equal((await upload()).ok, true)
    assert.equal(uploads[0].body, 'OWNED', 'multi-segment upload keeps the first-segment-only contract')

    const firstPath = join(recDir, fin.segments[0].file)
    rmSync(firstPath)
    writeFileSync(runPath, JSON.stringify({ ...run, audio: { ...run.audio, segments: [...fin.segments, { file: later, startMs: 6000, endMs: 7000 }] } }))
    uploads.length = 0
    assert.deepEqual(await upload(), { ok: false, error: 'audio-missing' }, 'a missing first listed segment cannot be replaced by a later surviving segment')
    assert.deepEqual(uploads, [], 'incomplete audio is not uploaded')
    assert.equal(readRun(A, id).audio.uploaded, false, 'a refused upload remains retryable')
    writeFileSync(firstPath, 'OWNED')
    assert.deepEqual(await upload(), { ok: true, uploaded: true }, 'restoring the first listed segment allows a retry')
    assert.equal(uploads[0].body, 'OWNED')

    const outside = join(base, 'upload-outside.webm')
    writeFileSync(outside, 'OUTSIDE')
    const linked = `${id}.seg-3.webm`
    symlinkSync(outside, join(recDir, linked))
    for (const segments of [[], [{ file: `${id}.seg-4.webm` }], [{ file: linked }], [{ file: '../upload-outside.webm' }], [{ file: 'other.webm' }]]) {
      writeFileSync(runPath, JSON.stringify({ ...run, audio: { ...run.audio, segments } }))
      uploads.length = 0
      assert.deepEqual(await upload(), { ok: false, error: 'audio-missing' }, 'an empty or invalid list never falls back to the foreign file')
      assert.deepEqual(uploads, [])
      assert.equal(readRun(A, id).audio.uploaded, false)
      if (segments.length) {
        writeFileSync(runPath, JSON.stringify({ ...run, audio: { ...run.audio, segments: [...segments, { file: later, startMs: 6000, endMs: 7000 }] } }))
        assert.deepEqual(await upload(), { ok: false, error: 'audio-missing' }, 'an invalid first entry cannot be replaced by a later owned segment')
        assert.deepEqual(uploads, [])
        assert.equal(readRun(A, id).audio.uploaded, false)
      }
    }
    const legacy = { id, talkSlug: SLUG, audio: { r2Key, uploaded: false } }
    writeFileSync(runPath, JSON.stringify(legacy))
    uploads.length = 0
    assert.equal((await upload()).ok, true)
    assert.equal(uploads[0].body, 'FOREIGN', 'a legacy Run with no list keeps the exact-name lookup')
  } finally {
    uploadTestMode = true
  }
  console.log('ok  8 upload uses the first listed segment; invalid lists cannot upload neighbours; legacy lookup stays')
}

// ---- 9. repeated list entries trash each file once and finish deleting both Runs and markers.
{
  const originalTrash = globalThis.__recordingVaultTest.shell.trashItem
  globalThis.__recordingVaultTest.shell.trashItem = async (p) => { trashed.push(p); rmSync(p) }
  try {
    for (const kind of ['run', 'marker']) {
      const id = `delete-duplicate-${kind}`
      const recDir = join(userData, 'recordings')
      const runPath = join(A, '_PRESENTATIONS', SLUG, `${id}.json`)
      const markerPath = join(recDir, `${id}.recording.json`)
      const file = `${id}.seg-1.r1.webm`
      const later = `${id}.seg-2.webm`
      const segments = [{ index: 0, file }, { index: 0, file }, { index: 1, file: later }]
      writeFileSync(join(recDir, file), 'OWNED')
      writeFileSync(join(recDir, later), 'LATER')
      writeFileSync(markerPath, JSON.stringify({ sessionId: id, talkSlug: SLUG, segments }))
      if (kind === 'run') writeFileSync(runPath, JSON.stringify({ id, talkSlug: SLUG, audio: { segments } }))
      trashed.length = 0
      const result = await handlers.get('recording:delete-session')({ sender: sender(STUDIO) }, { talkSlug: SLUG, sessionId: id })
      assert.deepEqual(result, { ok: true }, `${kind} deletion completes when a segment is listed twice`)
      const expected = [markerPath, join(recDir, file), join(recDir, later), ...(kind === 'run' ? [runPath] : [])]
      assert.deepEqual(trashed.sort(), expected.sort(), 'every target is trashed exactly once')
      for (const path of expected) assert.equal(existsSync(path), false)
    }
  } finally {
    globalThis.__recordingVaultTest.shell.trashItem = originalTrash
  }
  console.log('ok  9 duplicate segment entries do not interrupt Run or marker deletion')
}

// ---- 10. kept Runs remain usable from the presenter and a fresh History/Studio window.
{
  presenterPick = { error: TALK_VAULT_NOT_OPEN }
  const saved = await handlers.get('recording:save')({ sender: sender(PRESENTER) }, {
    ...runPayload({ mode: 'recording', kind: 'delivery' }),
    rawMarks: [{ event: 'start', tMs: 0 }, { event: 'stop', tMs: 30_000 }], audio: new Uint8Array([5, 6, 7]).buffer
  })
  assert.equal(saved.ok, true)
  presenterPick = { root: B }
  await handlers.get('recording:run-state')({ sender: sender(PRESENTER) }, { talkSlug: SLUG, sessionId: saved.sessionId, saved: true })
  assert.deepEqual(await handlers.get('recording:planned-runs')({ sender: sender(PRESENTER) }, SLUG, null), [], 'the kept Run cannot pick a reopened vault’s plans')
  for (const owner of [PRESENTER, STUDIO]) {
    const path = join(userData, 'recordings', `${saved.sessionId}.json`)
    const run = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...run, audio: { ...run.audio, uploaded: false } }))
    const result = await handlers.get('recording:upload')({ sender: sender(owner) }, { talkSlug: SLUG, sessionId: saved.sessionId })
    assert.deepEqual(result, { ok: true, uploaded: true }, 'upload follows the kept home even after the vault reopens')
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).audio.uploaded, true)
    assert.equal(existsSync(join(B, '_PRESENTATIONS', SLUG, `${saved.sessionId}.json`)), false)
  }
  const listed = await handlers.get('recording:list-all-sessions')({ sender: sender(STUDIO) })
  assert.equal(listed.find((run) => run.id === saved.sessionId)?.kept, 'app-data', 'Studio lists kept Runs for History’s Open in Studio')
  assert.ok((await handlers.get('recording:list-sessions')({}, SLUG)).some((run) => run.id === saved.sessionId))
  assert.ok(!(await handlers.get('recording:list-sessions')({}, 'another-talk')).some((run) => run.id === saved.sessionId))
  assert.equal(recording.recordingAudioPath(userData, saved.sessionId, A, SLUG), join(userData, 'recordings', `${saved.sessionId}.webm`))
  assert.deepEqual(await transcribeInputs(saved.sessionId), [join(userData, 'recordings', `${saved.sessionId}.webm`)])
  transcriptTestMode = true
  try {
    assert.equal((await handlers.get('transcript:run')({ sender: sender(STUDIO) }, SLUG, saved.sessionId)).ok, true)
    assert.equal(existsSync(join(userData, 'recordings', `${saved.sessionId}.transcript.json`)), true, 'the transcript stays beside its kept Run')
    assert.equal(existsSync(join(A, '_PRESENTATIONS', SLUG, `${saved.sessionId}.transcript.json`)), false, 'transcribing a kept Run writes nothing into the vault')
    assert.ok((await handlers.get('transcript:get')({}, SLUG, saved.sessionId))?.segments.length)
  } finally { transcriptTestMode = false }
  // The same id in both homes: explicit row actions never choose the other copy.
  const id = 'same-id-two-homes'
  const keptPath = join(userData, 'recordings', `${id}.json`)
  const vaultPath = join(A, '_PRESENTATIONS', SLUG, `${id}.json`)
  const run = { id, talkSlug: SLUG, kind: 'delivery', context: 'original', startedAt: '2026-10-20T12:00:00Z', audio: { bytes: 5, uploaded: false, segments: [{ file: `${id}.webm`, bytes: 5, startMs: 0, endMs: 3000 }] } }
  for (const path of [keptPath, vaultPath]) writeFileSync(path, JSON.stringify(run))
  writeFileSync(join(userData, 'recordings', `${id}.webm`), 'AUDIO')
  const event = { sender: sender(STUDIO) }
  const payload = { talkSlug: SLUG, sessionId: id }
  assert.equal((await handlers.get('recording:set-context')(event, { ...payload, home: null, context: 'kept only' })).ok, true)
  assert.equal((await handlers.get('recording:set-kind')(event, { ...payload, home: null, kind: 'rehearsal' })).ok, true)
  assert.equal((await handlers.get('recording:upload')(event, { ...payload, home: null })).ok, true)
  assert.deepEqual(JSON.parse(readFileSync(vaultPath, 'utf8')), run, 'kept actions leave the vault Run byte-for-byte unchanged')
  assert.equal(JSON.parse(readFileSync(keptPath, 'utf8')).context, 'kept only')
  assert.equal(JSON.parse(readFileSync(keptPath, 'utf8')).kind, 'rehearsal')
  const keptBefore = readFileSync(keptPath, 'utf8')
  assert.equal((await handlers.get('recording:set-kind')(event, { ...payload, home: A, kind: 'recording' })).ok, true)
  assert.equal(readFileSync(keptPath, 'utf8'), keptBefore, 'explicit vault actions leave the kept Run unchanged')
  assert.equal((await handlers.get('recording:set-kind')(event, { ...payload, home: join(base, 'unavailable-vault'), kind: 'recording' })).ok, false, 'an unavailable explicit home is refused')
  trashed.length = 0
  assert.equal((await handlers.get('recording:delete-session')(event, { ...payload, home: null })).ok, true)
  assert.ok(trashed.includes(keptPath))
  assert.ok(!trashed.includes(vaultPath), 'kept deletion does not trash the same-id vault Run')
  console.log('ok  10 kept Runs are listed, playable, transcribable and uploadable; plans follow their home')
}

// ---- 10b. deleting either duplicate keeps shared audio; deleting the last Run cleans it up.
for (const home of [null, A, B]) {
  await test(`delete ${home === null ? 'kept' : home === A ? 'current-vault' : 'presented-vault'} duplicate preserves the other Run's audio`, async () => {
    const recDir = join(userData, 'recordings')
    const id = `duplicate-delete-${home === null ? 'kept' : home === A ? 'a' : 'b'}`
    const vault = home ?? A
    const keptPath = join(recDir, `${id}.json`)
    const vaultPath = join(vault, '_PRESENTATIONS', SLUG, `${id}.json`)
    const audioPaths = [join(recDir, `${id}.webm`), join(recDir, `${id}.seg-2.webm`)]
    const marker = join(recDir, `${id}.recording.json`)
    const run = { id, talkSlug: SLUG, startedAt: '2026-10-20T12:00:00Z', audio: { segments: audioPaths.map((path, index) => ({ file: path.split('/').at(-1), startMs: index * 1000, endMs: (index + 1) * 1000 })) } }
    for (const path of [keptPath, vaultPath]) writeFileSync(path, JSON.stringify(run))
    for (const path of audioPaths) writeFileSync(path, 'SHARED AUDIO')
    writeFileSync(marker, JSON.stringify({ sessionId: id, talkSlug: SLUG, segments: [] }))
    const originalTrash = globalThis.__recordingVaultTest.shell.trashItem
    globalThis.__recordingVaultTest.shell.trashItem = async (path) => { trashed.push(path); rmSync(path) }
    const event = { sender: sender(home === B ? PRESENTER : STUDIO) }
    const selected = home === null ? keptPath : vaultPath
    const remaining = home === null ? vaultPath : keptPath
    const before = readFileSync(remaining, 'utf8')
    try {
      trashed.length = 0
      assert.deepEqual(await handlers.get('recording:delete-session')(event, { talkSlug: SLUG, sessionId: id, home }), { ok: true })
      assert.deepEqual(trashed, [selected], 'only the selected JSON goes to Trash while another valid Run exists')
      assert.equal(readFileSync(remaining, 'utf8'), before, 'the other home is unchanged')
      for (const path of audioPaths) assert.equal(readFileSync(path, 'utf8'), 'SHARED AUDIO')
      assert.ok(existsSync(marker), 'shared recovery metadata stays too')
      trashed.length = 0
      const lastHome = home === null ? vault : null
      assert.deepEqual(await handlers.get('recording:delete-session')(event, { talkSlug: SLUG, sessionId: id, home: lastHome }), { ok: true })
      assert.deepEqual(trashed.sort(), [remaining, marker, ...audioPaths].sort(), 'the last Run and its audio go to Trash')
      for (const path of [remaining, marker, ...audioPaths]) assert.equal(existsSync(path), false)
    } finally {
      globalThis.__recordingVaultTest.shell.trashItem = originalTrash
      for (const path of [keptPath, vaultPath, marker, ...audioPaths]) rmSync(path, { force: true })
    }
  })
}

// A fresh Studio window resolves to A, but another open vault B can own the same audio id.
for (const home of [null, A]) {
  await test(`delete ${home === null ? 'kept' : 'current-vault'} duplicate preserves audio used in another open vault`, async () => {
    const recDir = join(userData, 'recordings')
    const id = `other-open-vault-${home === null ? 'kept' : 'current'}`
    const selected = home === null ? join(recDir, `${id}.json`) : join(A, '_PRESENTATIONS', SLUG, `${id}.json`)
    const otherTalk = 'another-talk'
    const other = join(B, '_PRESENTATIONS', otherTalk, `${id}.json`)
    const audioPaths = [join(recDir, `${id}.webm`), join(recDir, `${id}.seg-2.webm`)]
    const marker = join(recDir, `${id}.recording.json`)
    const run = { id, talkSlug: SLUG, startedAt: '2026-10-20T12:00:00Z', audio: { segments: audioPaths.map((path, index) => ({ file: path.split('/').at(-1), startMs: index * 1000, endMs: (index + 1) * 1000 })) } }
    mkdirSync(join(B, '_PRESENTATIONS', otherTalk), { recursive: true })
    writeFileSync(selected, JSON.stringify(run))
    writeFileSync(other, JSON.stringify({ ...run, talkSlug: otherTalk }))
    const before = readFileSync(other, 'utf8')
    for (const path of audioPaths) writeFileSync(path, 'SHARED AUDIO')
    writeFileSync(marker, JSON.stringify({ sessionId: id, talkSlug: SLUG, segments: [] }))
    const originalTrash = globalThis.__recordingVaultTest.shell.trashItem
    globalThis.__recordingVaultTest.shell.trashItem = async (path) => { trashed.push(path); rmSync(path) }
    const event = { sender: sender(STUDIO) }
    try {
      trashed.length = 0
      assert.deepEqual(await handlers.get('recording:delete-session')(event, { talkSlug: SLUG, sessionId: id, home }), { ok: true })
      assert.deepEqual(trashed, [selected], 'the duplicate in B preserves shared audio even though the sender and current vault resolve to A')
      assert.equal(readFileSync(other, 'utf8'), before, 'the other open vault Run is unchanged')
      for (const path of audioPaths) assert.equal(readFileSync(path, 'utf8'), 'SHARED AUDIO')
      assert.ok(existsSync(marker), 'shared recovery metadata remains')
      trashed.length = 0
      assert.deepEqual(await handlers.get('recording:delete-session')(event, { talkSlug: otherTalk, sessionId: id, home: B }), { ok: true })
      assert.deepEqual(trashed.sort(), [other, marker, ...audioPaths].sort(), 'the last Run still cleans up its listed audio and marker')
    } finally {
      globalThis.__recordingVaultTest.shell.trashItem = originalTrash
      for (const path of [selected, other, marker, ...audioPaths]) rmSync(path, { force: true })
    }
  })
}

await test('a Run without a valid duplicate still trashes its audio', async () => {
  const recDir = join(userData, 'recordings')
  const originalTrash = globalThis.__recordingVaultTest.shell.trashItem
  globalThis.__recordingVaultTest.shell.trashItem = async (path) => { trashed.push(path); rmSync(path) }
  try {
    for (const home of [null, A]) {
      const id = `no-valid-duplicate-${home === null ? 'kept' : 'vault'}`
      const keptPath = join(recDir, `${id}.json`)
      const vaultPath = join(A, '_PRESENTATIONS', SLUG, `${id}.json`)
      const selected = home === null ? keptPath : vaultPath
      const invalid = home === null ? vaultPath : keptPath
      const audio = join(recDir, `${id}.webm`)
      const run = { id, talkSlug: SLUG, audio: { bytes: 5 } } // legacy audio lookup stays supported
      writeFileSync(selected, JSON.stringify(run))
      writeFileSync(invalid, JSON.stringify({ ...run, id: 'someone-else' }))
      writeFileSync(audio, 'AUDIO')
      trashed.length = 0
      assert.deepEqual(await handlers.get('recording:delete-session')({ sender: sender(STUDIO) }, { talkSlug: SLUG, sessionId: id, home }), { ok: true })
      assert.deepEqual(trashed.sort(), [selected, audio].sort(), 'invalid JSON identity in the other home does not retain audio')
      assert.equal(existsSync(audio), false)
      assert.equal(existsSync(invalid), true, 'the other home is never trashed')
      rmSync(invalid)
    }
  } finally { globalThis.__recordingVaultTest.shell.trashItem = originalTrash }
})

// Uncertainty in another home retains audio without blocking deletion of the selected Run.
for (const scenario of ['unavailable-vault', 'malformed-run', 'unreadable-run', 'unreadable-run-verification', 'unreadable-talk', 'malformed-kept-run', 'unreadable-kept-run', 'no-duplicate']) {
  await test(`delete with ${scenario} in another home ${scenario === 'no-duplicate' ? 'trashes' : 'keeps'} audio`, async () => {
    const recDir = join(userData, 'recordings')
    const id = `conservative-delete-${scenario}`
    const selected = join(A, '_PRESENTATIONS', SLUG, `${id}.json`)
    const otherTalk = 'uncertain-talk'
    const otherDir = join(B, '_PRESENTATIONS', otherTalk)
    const other = scenario.includes('kept-run') ? join(recDir, `${id}.json`) : join(otherDir, `${id}.json`)
    const audioPaths = [join(recDir, `${id}.webm`), join(recDir, `${id}.seg-2.webm`)]
    const marker = join(recDir, `${id}.recording.json`)
    const run = { id, talkSlug: SLUG, audio: { segments: audioPaths.map((path) => ({ file: path.split('/').at(-1) })) } }
    mkdirSync(otherDir, { recursive: true })
    writeFileSync(selected, JSON.stringify(run))
    if (scenario !== 'no-duplicate') writeFileSync(other, scenario.startsWith('malformed-') ? '{"id":' : JSON.stringify({ ...run, talkSlug: otherTalk }))
    for (const path of audioPaths) writeFileSync(path, 'AUDIO')
    writeFileSync(marker, JSON.stringify({ sessionId: id, talkSlug: SLUG, segments: [] }))
    const original = { trash: globalThis.__recordingVaultTest.shell.trashItem, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync }
    const otherBefore = scenario !== 'no-duplicate' ? readFileSync(other, 'utf8') : null
    let failedReads = 0
    let otherReads = 0
    globalThis.__recordingVaultTest.shell.trashItem = async (path) => { trashed.push(path); rmSync(path) }
    if (scenario === 'unavailable-vault') unavailableRoots.add(B)
    // Inject EACCES rather than chmod, so this also exercises the failure when run as root.
    fs.readFileSync = (path, ...args) => {
      if (path === other) {
        otherReads++
        if (scenario === 'unreadable-run' || scenario === 'unreadable-kept-run' || (scenario === 'unreadable-run-verification' && otherReads > 1)) {
          failedReads++
          throw Object.assign(new Error('Run unreadable'), { code: 'EACCES' })
        }
      }
      return original.readFileSync(path, ...args)
    }
    fs.readdirSync = (path, ...args) => {
      if (scenario === 'unreadable-talk' && path === otherDir) { failedReads++; throw Object.assign(new Error('Talk unreadable'), { code: 'EACCES' }) }
      assert.ok(scenario !== 'unavailable-vault' || !String(path).startsWith(B + '/'), 'an unavailable vault is never scanned')
      return original.readdirSync(path, ...args)
    }
    syncBuiltinESMExports()
    try {
      // Ordinary History listings continue past both malformed and inaccessible entries.
      if (scenario.startsWith('malformed-') || (scenario.startsWith('unreadable-') && scenario !== 'unreadable-run-verification')) {
        assert.ok(!listRuns(B).some((run) => run.id === id))
        assert.ok(!listKeptRuns(userData).some((run) => run.id === id))
        failedReads = 0
      }
      trashed.length = 0
      assert.deepEqual(await handlers.get('recording:delete-session')({ sender: sender(STUDIO) }, { talkSlug: SLUG, sessionId: id, home: A }), { ok: true })
      if (scenario.startsWith('unreadable-')) assert.ok(failedReads > 0, 'the duplicate scan encountered the injected read failure')
      const expected = scenario === 'no-duplicate' ? [selected, marker, ...audioPaths] : [selected]
      assert.deepEqual([...trashed].sort(), expected.sort(), 'uncertain duplicates keep audio and marker; a proven last Run cleans them up')
      assert.equal(existsSync(selected), false, 'the selected Run JSON still goes to Trash')
      for (const path of [...audioPaths, marker]) assert.equal(existsSync(path), scenario !== 'no-duplicate')
      if (otherBefore !== null) assert.equal(original.readFileSync(other, 'utf8'), otherBefore, 'the other Run stays unchanged')
    } finally {
      globalThis.__recordingVaultTest.shell.trashItem = original.trash
      fs.readFileSync = original.readFileSync
      fs.readdirSync = original.readdirSync
      syncBuiltinESMExports()
      unavailableRoots.delete(B)
      for (const path of [selected, other, marker, ...audioPaths]) rmSync(path, { force: true })
      rmSync(otherDir, { recursive: true, force: true })
    }
  })
}

// ---- 11. recovery only completes an empty reservation it can prove belongs to this session.
{
  const dir = join(B, '_PRESENTATIONS', SLUG)
  const recDir = join(userData, 'recordings')
  const real = { linkSync: fs.linkSync, renameSync: fs.renameSync, unlinkSync: fs.unlinkSync }
  const inject = (fns) => { Object.assign(fs, fns); syncBuiltinESMExports() }
  for (const kind of ['owned-empty', 'unknown-empty', 'nonempty', 'wrong-session', 'changed-inode']) {
    const id = `recover-${kind}`
    const target = join(dir, `${id}.json`)
    const marker = join(recDir, `${id}.recording.json`)
    writeFileSync(join(recDir, `${id}.webm`), 'AUDIO')
    writeFileSync(marker, JSON.stringify({ sessionId: id, talkSlug: SLUG, vaultRoot: B, segments: [{ index: 0, startMs: 0, endMs: 3000 }], recordingMs: 3000 }))
    // Simulate a process stopping after reservation: no hard links, then neither rename nor cleanup completes.
    try {
      inject({ linkSync: () => { throw Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' }) },
        renameSync: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) },
        unlinkSync: (p) => { if (existsSync(p) && (p === target || p === `${target}.reservation`)) throw new Error('crashed'); return real.unlinkSync(p) } })
      assert.throws(() => writeNewRunFile(target, { id, talkSlug: SLUG }), /EIO/)
    } finally { inject(real) }
    assert.equal(readFileSync(target, 'utf8'), '')
    if (kind === 'unknown-empty') rmSync(`${target}.reservation`, { force: true })
    if (kind === 'nonempty') writeFileSync(target, 'FOREIGN NON-EMPTY FILE')
    if (kind === 'wrong-session') {
      const proof = JSON.parse(readFileSync(`${target}.reservation`, 'utf8'))
      writeFileSync(`${target}.reservation`, JSON.stringify({ ...proof, sessionId: 'someone-else' }))
    }
    if (kind === 'changed-inode') {
      fs.renameSync(target, `${target}.old`)
      writeFileSync(target, '')
    }
    const before = readFileSync(target)
    let recovered
    try {
      // Recovery must still work on the filesystem that needed the reservation fallback.
      if (kind === 'owned-empty') inject({ linkSync: () => { throw Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' }) } })
      recovered = await recording.recoverInterruptedRecordings()
    } finally { inject(real) }
    if (kind === 'owned-empty') {
      const saved = JSON.parse(readFileSync(target, 'utf8'))
      assert.equal(saved.id, id, 'its proven empty reservation becomes a complete Run')
      assert.equal(saved.audio.partial, true)
      assert.equal(saved.audio.bytes, 5)
      assert.ok(recovered >= 1, 'the completed Run is counted, alongside any earlier interrupted fixture')
      assert.equal(existsSync(marker), false)
      assert.equal(existsSync(`${target}.reservation`), false)
    } else {
      assert.deepEqual(readFileSync(target), before, 'unproven or non-empty files are never overwritten')
      assert.equal(existsSync(marker), true, 'the audio recovery record remains')
      const recovery = await handlers.get('recording:list-recovery')()
      assert.equal(recovery.find((run) => run.sessionId === id)?.status, 'needs-attention', 'a blocked recovery is visible')
    }
    assert.equal(readFileSync(join(recDir, `${id}.webm`), 'utf8'), 'AUDIO')
  }
  const id = 'recover-orphaned-proof'
  const target = join(dir, `${id}.json`)
  const marker = join(recDir, `${id}.recording.json`)
  writeFileSync(join(recDir, `${id}.webm`), 'AUDIO')
  writeFileSync(marker, JSON.stringify({ sessionId: id, talkSlug: SLUG, vaultRoot: B, segments: [{ index: 0, startMs: 0, endMs: 3000 }], recordingMs: 3000 }))
  writeFileSync(`${target}.reservation`, '{"sessionId":')
  assert.equal((await handlers.get('recording:list-recovery')()).find((run) => run.sessionId === id)?.status, 'needs-attention', 'a missing Run with an orphaned proof never silently waits forever')
  try {
    inject({ linkSync: () => { throw Object.assign(new Error('ENOTSUP'), { code: 'ENOTSUP' }) } })
    await recording.recoverInterruptedRecordings()
  } finally { inject(real) }
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).id, id, 'recovery replaces the stale proof after exclusively reserving its Run')
  assert.equal(existsSync(marker), false)
  assert.equal(existsSync(`${target}.reservation`), false)
  console.log('ok  11 recovery completes proven empty reservations; foreign and non-empty files need attention')
}

rmSync(base, { recursive: true, force: true })
delete globalThis.__recordingVaultTest
delete globalThis.__recordingTranscode
console.log('recording vault: a presenter window writes into the presented talk\'s vault passed')
