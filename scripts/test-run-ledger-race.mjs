// Consistency batch 3, review round 1: the Runs ledger belongs to the Run on show.
//   S1  a late reply for Run A never replaces Run B's ledger, and its actions (kind, delete) target B.
//   S2  "Open in Studio" and "Manage notes" are disabled, with the reason, for a Run Studio cannot list
//       (another open vault); they are enabled for one it lists.
//   S4  ⌘1 to ⌘3 are routed by the Tools window's shared key handler, not by each view.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const repo = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'tw-ledger-race-'))
const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { pretendToBeVisual: true })
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Element', 'Event', 'CustomEvent', 'KeyboardEvent']) {
  Object.defineProperty(globalThis, name, { value: name === 'window' ? dom.window : dom.window[name], configurable: true, writable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.MessageChannel = class { constructor() { const p = { onmessage: null }; this.port1 = p; this.port2 = { postMessage: () => setImmediate(() => p.onmessage?.({ data: undefined })) } } }
const bundle = await build({
  stdin: { contents: "export { RunLedger } from './src/renderer/src/components/RunLedger.tsx'; export { createElement, act } from 'react'; export { createRoot } from 'react-dom/client'", resolveDir: repo, loader: 'tsx' },
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' }
})
writeFileSync(join(dir, 'ledger.cjs'), bundle.outputFiles[0].text)
const R = createRequire(join(dir, 'x.cjs'))('./ledger.cjs')

const run = (id, extra = {}) => ({ id, talkSlug: 'talk', talkTitle: `Talk ${id}`, kind: 'delivery', status: 'delivered', startedAt: '2026-10-20T12:00:00Z', endedAt: '2026-10-20T12:30:00Z', recordingMs: 60000, wallClockMs: 60000, timerTargetMin: 0, context: `Context ${id}`, pathwayId: null, audio: { r2Key: 'k', bytes: 1, uploaded: false }, transcript: null, slideTimeIndex: [], home: '/vault', ...extra })
const src = (id) => ({ vaultId: 'v1', talkSlug: 'talk', runId: id, talkTitle: `Talk ${id}`, status: 'delivered', kind: 'delivery', recorded: true })
const waiting = new Map()
const sessionWaits = []
const kindCalls = []
const deleted = []
let listed = ['a', 'b']
dom.window.tw = {
  history: {
    listRuns: (_slug, _vault) => new Promise((resolve) => { waiting.set(`call${waiting.size}`, resolve) }),
    talkHandouts: async () => ({}),
    checkLive: async () => ({ status: 'live', checkedAt: null }),
    instantAnchors: async () => ({}), feedbackSlides: async () => ({})
  },
  recording: {
    listAllSessions: () => new Promise((resolve) => { sessionWaits.push(() => resolve(listed.map((id) => run(id)))) }),
    setKind: async (...args) => { kindCalls.push(args); return { ok: true, kind: args[2] } },
    setContext: async () => ({ ok: true })
  },
  shell: { openExternal: async () => {} }
}
const host = dom.window.document.getElementById('host')
const root = R.createRoot(host)
const show = async (id, extra = {}) => R.act(async () => root.render(R.createElement(R.RunLedger, { key: id, source: src(id), version: 0, onOpenStudio() {}, onOpenNotes() {}, onChanged() {}, flash() {}, onAskDelete: (r) => deleted.push(r.id), ...extra })))
const settle = async () => { for (let i = 0; i < 4; i++) await R.act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
try {
  // S1: select A, select B, resolve B, then resolve A.
  await show('a'); await show('b')
  const [forA, forB] = [...waiting.values()]
  await R.act(async () => forB([run('b')])); await settle()
  await R.act(async () => forA([run('a')])); await settle()
  const text = host.textContent
  assert.match(text, /Context b/, 'the ledger shows B')
  assert.doesNotMatch(text, /Context a/, 'a late reply for A does not replace B\'s ledger')
  await R.act(async () => { [...host.querySelectorAll('[data-run-kind] button')].find((b) => b.textContent === 'Rehearsal').click() }); await settle()
  assert.deepEqual(kindCalls.map((c) => c[1]), ['b'], 'the kind action targets the Run on show')
  await R.act(async () => { host.querySelector('[data-run-delete]').click() })
  assert.deepEqual(deleted, ['b'], 'the delete action targets the Run on show')
  // S2: Studio lists b: both buttons enabled. Then a Run it does not list: disabled, with the reason.
  // S2: while Studio's list is pending both actions are disabled; a primary-vault Run enables them when it answers.
  const studioBtn = () => host.querySelector('[data-run-open-studio]')
  assert.equal(studioBtn().disabled, true, 'disabled while the list is pending')
  assert.equal(studioBtn().title, 'Checking…')
  assert.equal(host.querySelector('[data-run-open-notes]').disabled, true)
  await R.act(async () => { sessionWaits.splice(0).forEach((f) => f()) }); await settle()
  assert.equal(studioBtn().disabled, false, 'enabled once Studio lists the Run')
  listed = ['other']
  waiting.clear()
  await show('c'); await R.act(async () => [...waiting.values()].at(-1)([run('c')])); await settle()
  assert.equal(studioBtn().disabled, true, 'still disabled while pending for the next Run')
  await R.act(async () => { sessionWaits.splice(0).forEach((f) => f()) }); await settle()
  const open = host.querySelector('[data-run-open-studio]')
  assert.equal(open.disabled, true, 'a Run Studio does not list cannot be opened there')
  assert.match(open.title, /another open vault/)
  assert.equal(host.querySelector('[data-run-open-notes]').disabled, true)
  // S4: the shared handler owns the view chords.
  const palette = readFileSync(join(repo, 'src/renderer/src/components/ToolsPalette.tsx'), 'utf8')
  assert.match(palette, /Digit1: 'tools-view-studio', Digit2: 'tools-view-runs', Digit3: 'tools-view-importer'/)
  const app = readFileSync(join(repo, 'src/renderer/src/App.tsx'), 'utf8')
  assert.match(app, /'tools-view-studio': \{ enabled: true, run: \(\) => showRail\('studio'\) \}/)
  assert.match(app, /'tools-view-importer': \{ enabled: true, run: \(\) => showRail\('importer'\) \}/)
  console.log('PASS run ledger: a late reply cannot replace the Run on show; Studio is offered only where it can open; ⌘1–⌘3 are shared')
} finally {
  await R.act(async () => root.unmount())
  dom.window.close()
  rmSync(dir, { recursive: true, force: true })
}
process.exit(0)
