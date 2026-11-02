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
  let snap = { identity: UPDATE_IDENTITY, arch: 'arm64', running: '0.41.0', platform: 'darwin', source: 'website', enabled: true, checking: false, busy: false, waiting: false, state: { latest, lastResult: 'newer' }, mark: latest, whatsNew: { version: '0.41.0', from: '0.40.0' } }
  const listeners = new Set(), calls = [], records = []
  const publish = async (patch) => { snap = { ...snap, ...patch }; await act(async () => { for (const f of listeners) f(snap) }) }
  window.tw = { updates: {
    get: async () => snap, onChange: (f) => { listeners.add(f); return () => listeners.delete(f) }, onAnswer: () => () => {},
    check: async () => snap, download: async () => calls.push('download'), notNow: async () => calls.push('notNow'), skip: async (v) => calls.push(['skip', v]), stopSkipping: async () => snap,
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
  console.log('update React surfaces: 8 checks passed (actions, wording, presenting, local notes, settings, Store, waiting, held answer)')
  await act(async () => root.unmount()); root = null
} finally {
  if (root) root.unmount()
  dom.window.close()
  for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name] }
  rmSync(dir, { recursive: true, force: true })
}
