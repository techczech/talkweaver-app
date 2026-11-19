// Real React surfaces in jsdom: no browser, Electron process or window is launched.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'
import { build } from 'esbuild'
import { UPDATE_IDENTITY } from '../../src/shared/update-identity.ts'

const dir = mkdtempSync(join(tmpdir(), 'tw-update-ui-'))
const dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'https://talkweaver.test/' })
const previous = new Map()
let root
try {
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'CustomEvent', 'Event']) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] })
  }
  previous.set('IS_REACT_ACT_ENVIRONMENT', Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'))
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  await build({ stdin: { contents: `
    export { UpdateMarks, UpdateAnswerNote } from './src/renderer/src/components/UpdateNotices.tsx'
    export { default as About } from './src/renderer/src/components/AboutUpdatesSettings.tsx'
    export { default as React, act } from 'react'
    export { createRoot } from 'react-dom/client'
  `, resolveDir: fileURLToPath(new URL('../..', import.meta.url)), loader: 'tsx' }, bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', outfile: join(dir, 'bundle.mjs'), define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' })
  const { React, act, createRoot, UpdateMarks, UpdateAnswerNote, About } = await import(pathToFileURL(join(dir, 'bundle.mjs')).href)
  const latest = { version: '0.42.0', released: '2026-11-12', summary: ['One.'], notes: 'https://talkweaver.app/whats-new#0.42.0', download: { mac: 'https://talkweaver.app/download#mac', windows: 'https://talkweaver.app/download#windows' } }
  let snap = { identity: UPDATE_IDENTITY, arch: 'arm64', running: '0.41.0', platform: 'darwin', source: 'website', enabled: true, checking: false, busy: false, waiting: false, state: { latest, lastResult: 'newer' }, mark: latest, whatsNew: { version: '0.41.0', from: '0.40.0' }, alpha: false, install: { phase: 'idle' }, file: null, refusal: 'no-file', blockers: [] }
  const listeners = new Set(), calls = [], records = []
  const publish = async (patch) => { snap = { ...snap, ...patch }; await act(async () => { for (const f of listeners) f(snap) }) }
  window.tw = { updates: {
    get: async () => snap, onChange: (f) => { listeners.add(f); return () => listeners.delete(f) }, onAnswer: () => () => {},
    check: async () => snap, download: async () => calls.push('download'), update: async () => { calls.push('update'); return snap }, cancel: async () => { calls.push('cancel'); return snap }, restart: async () => { calls.push('restart'); return snap },
    setAlpha: async (on) => { calls.push(['alpha', on]); return snap }, notNow: async () => calls.push('notNow'), skip: async (v) => calls.push(['skip', v]), stopSkipping: async () => snap,
    setEnabled: async (on) => { calls.push(['enabled', on]); return snap }, openNotes: async (v) => calls.push(['notes', v]), openStore: async () => calls.push('store'),
    whatsNew: async () => ({ version: snap.running, from: '0.40.0', items: [{ title: null, text: 'Local notes.' }] }), dismissWhatsNew: async () => calls.push('dismiss'),
  } }
  root = createRoot(document.getElementById('root'))
  const look = { sectionHead: {}, hint: {}, rowFolder: {}, folderLabel: {}, btn: {} }
  await act(async () => root.render(React.createElement(React.Fragment, null, React.createElement(UpdateMarks), React.createElement(UpdateAnswerNote), React.createElement(About, { look, record: (...args) => records.push(args), onShowWhatsNew: () => calls.push('show') }))))
  const click = async (selector) => { const button = document.querySelector(selector); assert.ok(button, selector); await act(async () => button.click()) }
  await click('[data-update-mark]')
  assert.match(document.querySelector('[data-update-popover]').textContent, /your talks and settings stay as they are/)
  await click('[data-update-popover] [data-update-download]')
  assert.ok(calls.includes('download'))
  assert.equal(document.querySelector('[data-update-popover]'), null)
  await click('[data-update-mark]'); await click('[data-update-not-now]')
  assert.ok(calls.includes('notNow'))
  await click('[data-update-mark]'); await click('[data-update-skip]')
  assert.deepEqual(calls.at(-1), ['skip', '0.42.0'])
  await click('[data-update-mark]')
  await publish({ busy: true, mark: null })
  assert.equal(document.querySelector('[data-update-popover]'), null)
  assert.ok(document.querySelector('[data-whats-new-mark]'), 'local Updated mark remains visible while presenting')
  let opened = 0
  window.addEventListener('tw-whats-new-open', () => opened++)
  await click('[data-whats-new-mark]')
  assert.equal(opened, 1)
  assert.match(document.querySelector('[data-update-sends]').textContent, /your talks or your version/)
  await click('[role="switch"]')
  assert.deepEqual(records.at(-1), ['updates.checkForNewVersions', 'Check for new versions', 'on', 'off'])
  await publish({ source: 'store', busy: false, mark: null })
  assert.equal(document.querySelector('[data-updates-card]'), null)
  assert.match(document.querySelector('[data-about-store]').textContent, /TalkWeaver does not check for new versions itself in this copy/)
  await click('[data-update-open-store]')
  assert.equal(calls.at(-1), 'store')
  await publish({ source: 'website', busy: true, waiting: true })
  assert.match(document.querySelector('[data-update-state]').textContent, /TalkWeaver will check when your talk ends/)
  await publish({ busy: false, waiting: false })
  // A failed manual check that completes during a talk is held until the talk ends.
  await publish({ busy: true })
  await act(async () => window.dispatchEvent(new CustomEvent('tw-update-answer', { detail: { presenting: true, view: { tone: 'warn', title: 'Could not check for updates.', detail: 'TalkWeaver could not ask for the answer. Try again.', action: 'try-again' } } })))
  assert.equal(document.querySelector('[data-update-note]'), null)
  await publish({ busy: false })
  assert.match(document.querySelector('[data-update-note]').textContent, /Could not check for updates/)
  await publish({ busy: true })
  assert.equal(document.querySelector('[data-update-note]'), null)
  // ADR-0044: the one click, its states and the alpha switch.
  const file = { url: 'https://github.com/techczech/talkweaver-app/releases/download/v0.42.0/TalkWeaver-mac-arm64.zip', sha512: 'A'.repeat(86) + '==', size: 275_000_000 }
  await publish({ busy: false, mark: latest, refusal: null, file })
  await click('[data-update-mark]')
  const pop = () => document.querySelector('[data-update-popover]')
  assert.match(pop().textContent, /Update downloads 0\.42\.0 \(275 MB\), replaces this copy and restarts TalkWeaver/)
  assert.equal(pop().querySelector('[data-update-download]'), null, 'Update, not the download page, where this copy can update itself')
  await click('[data-update-popover] [data-update-update]')
  assert.equal(calls.at(-1), 'update')
  await publish({ install: { phase: 'downloading', version: '0.42.0', received: 115_500_000, total: 275_000_000 } })
  assert.match(document.querySelector('[data-update-mark]').textContent, /Downloading 0\.42\.0 · 42%/)
  assert.equal(pop().querySelector('[data-update-progress]').getAttribute('data-update-progress'), '42')
  assert.match(pop().textContent, /116 MB of 275 MB\. You can keep working\./)
  await click('[data-update-popover] [data-update-cancel]')
  assert.equal(calls.at(-1), 'cancel')
  await publish({ install: { phase: 'waiting', version: '0.42.0' }, blockers: ['recording'] })
  assert.match(document.querySelector('[data-update-mark]').textContent, /Restart to finish updating/)
  assert.match(pop().textContent, /It opens when you restart\. Not now: a recording is in progress\./)
  assert.equal(pop().querySelector('[data-update-restart]').disabled, true, 'Restart waits while a recording is in progress')
  await publish({ blockers: [] })
  assert.equal(pop().querySelector('[data-update-restart]').disabled, false)
  await click('[data-update-popover] [data-update-restart]')
  assert.equal(calls.at(-1), 'restart')
  // Restarting (D3): the person has committed; no Cancel.
  await publish({ install: { phase: 'restarting', version: '0.42.0' }, blockers: [] })
  assert.match(document.querySelector('[data-update-mark]').textContent, /Restarting into 0\.42\.0…/)
  assert.ok(pop().querySelector('[data-update-restarting]'))
  assert.equal(pop().querySelector('[data-update-cancel]'), null, 'no Cancel once restarting')
  // A restart that did not happen (D4): "may" until checked (whatever the cause), "will" only when a check found the
  // preparation definitely still armed, then a checked "quit and reopen".
  await publish({ install: { phase: 'reopen', version: '0.42.0', cause: 'held', pending: true, armed: false } })
  assert.match(document.querySelector('[data-update-mark]').textContent, /0\.42\.0 may install when TalkWeaver quits/)
  assert.match(pop().textContent, /TalkWeaver may finish updating when it next quits/)
  assert.doesNotMatch(pop().textContent, /will finish updating/, 'an unconfirmed withdrawal never says "will"')
  assert.equal(pop().querySelector('[data-update-reopen]').getAttribute('data-update-reopen'), 'pending')
  await publish({ install: { phase: 'reopen', version: '0.42.0', cause: 'held', pending: true, armed: true } })
  assert.match(document.querySelector('[data-update-mark]').textContent, /0\.42\.0 installs when TalkWeaver quits/)
  assert.match(pop().textContent, /TalkWeaver will finish updating when it next quits/)
  await publish({ install: { phase: 'reopen', version: '0.42.0', cause: 'held', pending: false, armed: false } })
  assert.match(document.querySelector('[data-update-mark]').textContent, /Reopen TalkWeaver to update/)
  assert.match(pop().textContent, /Quit and reopen TalkWeaver to update.*Nothing is installed when it quits/)
  assert.equal(pop().querySelectorAll('[data-update-popover] button').length, 0, 'no button: nothing more happens in this run')
  await publish({ install: { phase: 'waiting', version: '0.42.0' }, busy: true })
  assert.equal(document.querySelector('[data-update-mark]'), null, 'no mark while presenting, whatever the state')
  await publish({ busy: false, install: { phase: 'failed', version: '0.42.0', reason: 'mismatch' } })
  assert.match(document.querySelector('[data-update-mark]').textContent, /Update to 0\.42\.0 failed/)
  if (!pop()) await click('[data-update-mark]')
  assert.match(pop().textContent, /The downloaded file did not match the published one, so it was not used\. TalkWeaver 0\.41\.0 is unchanged\./)
  assert.ok(pop().querySelector('[data-update-retry]') && pop().querySelector('[data-update-download]'), 'Try again, and the download page that always works')
  await publish({ install: { phase: 'idle' }, refusal: 'disk-image' })
  if (!pop()) await click('[data-update-mark]')
  assert.match(pop().textContent, /it is running from a disk image/)
  assert.ok(pop().querySelector('[data-update-download]') && !pop().querySelector('[data-update-update]'), 'cannot update in place: the download page')
  const alpha = document.querySelector('[data-update-alpha]')
  assert.match(document.querySelector('[data-update-alpha-hint]').textContent, /Alphas come first and can break\. To go back, switch this off/)
  await act(async () => alpha.click())
  assert.deepEqual(calls.at(-1), ['alpha', true])
  assert.deepEqual(records.at(-1), ['updates.alphaVersions', 'Get early versions (alpha)', 'off', 'on'])
  console.log('update React surfaces: 17 checks passed (actions, wording, presenting, local notes, settings, Store, waiting, held answer, Update, progress and Cancel, deferred restart, restarting without Cancel, reopen pending and checked, failed, cannot update in place, alpha switch)')
  await act(async () => root.unmount()); root = null
} finally {
  if (root) root.unmount()
  dom.window.close()
  for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name] }
  rmSync(dir, { recursive: true, force: true })
}
