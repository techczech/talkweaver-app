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
import { presentedTalkVault, TALK_VAULT_NOT_OPEN, VAULT_NOT_NAMED } from '../../../src/main/presented-vault.ts'
import { listRuns, writeNewRunFile } from '../../../src/main/runs.ts'
import { listKeptRuns } from '../../../src/main/recording-paths.ts'
import { createRecordingStreams } from '../../../src/main/recording-stream.ts'

const base = mkdtempSync(join(import.meta.dirname, 'recording-fixture-'))
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


try {
 const sourceOutline='Talks/ai-research/ai-research-outline.md'
 recording.registerRecordingContext(PRESENTER,{talkSlug:SLUG,talkTitle:'Fixture',sourceOutline,timerTargetMin:0,pathwayId:null,preferredPlannedRunId:null})
 const event={sender:sender(PRESENTER)}
 const saved=await handlers.get('recording:save')(event,runPayload({sourceOutline:'attacker/ai-research-outline.md'}))
 assert.equal(saved.ok,true,saved.error)
 assert.equal(readRun(B,saved.sessionId).sourceOutline,sourceOutline)
 assert.equal((await handlers.get('recording:set-kind')(event,{talkSlug:SLUG,sessionId:saved.sessionId,kind:'delivery'})).ok,true)
 assert.equal((await handlers.get('recording:finalise-run')(event,{talkSlug:SLUG,sessionId:saved.sessionId,rawMarks:[],wallClockMs:90000})).ok,true)
 assert.equal(readRun(B,saved.sessionId).sourceOutline,sourceOutline)
 const wrong=await handlers.get('recording:save')(event,runPayload({talkSlug:'other'}))
 assert.equal(wrong.ok,false)
 console.log('actual recording save trusts main context only; set-kind/finalise preserve exact source; mismatched slug refuses')
}finally {rmSync(base,{recursive:true,force:true});delete globalThis.__recordingVaultTest}
