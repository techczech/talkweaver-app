// Execute the actual main-process cancellation and confirm-close routes without Electron.
import { functionBody, readMainSource } from './lib/read-source.mjs'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { mock } from 'node:test'
import { closeFrozen } from '../src/renderer/src/lib/closeFreeze.ts'
import { createThumbnailQueue } from '../src/main/thumbnail-queue.ts'
import { createQuitSequence } from '../src/main/quit-sequence.ts'

const source = readMainSource()
const attemptCode = source.slice(source.indexOf('let quitAttempt:'), source.indexOf('function holdRenderHelpers()'))
const confirmCode = source.slice(source.indexOf("ipcMain.handle('window:confirm-close'"), source.indexOf('// Insert section (talk search 07'))
const quitCode = ['recordQuitAttempt', 'captureQuitVeto'].map(name => functionBody(source, name)).join('\n')
let passed = 0
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name) }
function harness() {
  let held = 0, releases = 0, confirm
  const app = new EventEmitter(), sent = [], closeHolds = new Map()
  const editorWindows = new Map([[1, { win: { isDestroyed: () => false, webContents: { send: channel => sent.push(channel) }, close: () => { throw Error('unexpected close') } } }]])
  const deps = {
    holdRenderHelpers: () => { held++; return () => { held--; releases++ } },
    closeHolds, clearTimeout, thumbnailPrewarm: { nudge() {} }, editorWindows,
    restartWindows: { kept() {}, waiting: () => false, confirm: () => 'keep' },
    editorRevisions: { verdict: () => 'saved' }, editorWorkSaved: () => true, closeConfirmed: new Set(),
    ipcMain: { handle: (_channel, fn) => { confirm = fn } }, app, createQuitSequence,
  }
  const boot = `
    let quitting = false, quitCycle = 0
    const quitSequence = createQuitSequence(app, (_name, error) => { throw error }, captureQuitVeto)
    quitSequence.add({ name: 'Record quit attempt', stage: 'before-quit', timeoutMs: 0, run: recordQuitAttempt })
  `
  const api = new Function(...Object.keys(deps), stripTypeScriptTypes(boot + attemptCode + confirmCode + quitCode) +
    '; return { beginQuitAttempt, cancelQuitAttempt, editorQuitAttempts, active: () => quitAttempt }')(...Object.values(deps))
  return { ...api, app, sent, editorWindows, held: () => held, releases: () => releases,
    confirm: (id = 1) => confirm({ sender: { id } }, { quit: true, revision: 1 }) }
}
await test('restart and native Quit hold once; cancelling releases once', () => {
  const h = harness(); h.beginQuitAttempt(); h.beginQuitAttempt()
  assert.equal(h.held(), 1)
  h.cancelQuitAttempt(); h.cancelQuitAttempt()
  assert.equal(h.held(), 0); assert.equal(h.releases(), 1)
})
await test('a missing editor and a refused confirmation both end the attempt', () => {
  for (const id of [1, 404]) {
    const h = harness(); h.beginQuitAttempt()
    assert.equal(h.confirm(id), false); assert.equal(h.held(), 0)
  }
})
await test('a prevented before-quit, including a later listener, releases the hold', async () => {
  const h = harness()
  h.app.on('before-quit', event => { event.defaultPrevented = true })
  h.app.emit('before-quit', { defaultPrevented: false })
  assert.equal(h.held(), 1)
  await new Promise(setImmediate)
  assert.equal(h.held(), 0)
})
await test('a cancelled attempt unfreezes all its editors and a late confirmation cannot quit', () => {
  const h = harness(); h.beginQuitAttempt(); h.editorQuitAttempts.set(1, h.active())
  h.cancelQuitAttempt(); assert.deepEqual(h.sent, ['outline:close-cancelled'])
  assert.equal(h.confirm(), false); assert.equal(h.held(), 0)
})
await test('the save holds through 9999 ms, then the real ten-second ceiling releases it', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const h = harness(); h.beginQuitAttempt()
    let outcome
    const close = closeFrozen({ freeze() {}, unfreeze() {}, leave: async () => true,
      settle: async () => new Promise(() => {}), forceSave: async () => {}, revision: () => 1,
      confirm: async () => { throw Error('stalled save must not confirm') },
      kept: async () => h.cancelQuitAttempt() }).then(value => { outcome = value })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    mock.timers.tick(9999); assert.equal(h.held(), 1); assert.equal(outcome, undefined)
    mock.timers.tick(2); await close
    assert.equal(outcome, 'kept'); assert.equal(h.held(), 0)
  } finally { mock.timers.reset() }
})
await test('an old attempt cannot cancel the next one', () => {
  const h = harness(); h.beginQuitAttempt(); const old = h.active()
  h.cancelQuitAttempt(); h.beginQuitAttempt(); h.cancelQuitAttempt(old)
  assert.equal(h.held(), 1); h.cancelQuitAttempt()
})
await test('destroyed renderer waits retire on cancellation and the next queued picture runs', async () => {
  const thumbnails = readFileSync(new URL('../src/main/thumbnails.ts', import.meta.url), 'utf8')
  const start = thumbnails.indexOf('async function rendererWork<')
  const end = thumbnails.indexOf('\n/**', start)
  const deadWindow = Object.assign(new EventEmitter(), { destroyed: false, isDestroyed() { return this.destroyed } })
  const subject = new Function('renderWin', stripTypeScriptTypes(thumbnails.slice(start, end)) + '; return { rendererWork, setWindow: window => { renderWin = window } }')(deadWindow)
  const rendererWork = (...args) => subject.rendererWork(...args)
  const queue = createThumbnailQueue(async (input, signal) => {
    await rendererWork(input === 'destroyed' ? new Promise(() => {}) : Promise.resolve(), signal)
    return { [input]: 'drawn' }
  })
  const old = queue('destroyed')
  await Promise.resolve()
  deadWindow.destroyed = true; deadWindow.emit('closed')
  queue.cancelAll()
  subject.setWindow(Object.assign(new EventEmitter(), { isDestroyed: () => false }))
  const next = queue('after cancellation')
  assert.deepEqual(await old, {})
  assert.deepEqual(await next, { 'after cancellation': 'drawn' })
  assert.equal(queue.foregroundBusy(), false)
})
await test('cancelling a live renderer does not overlap its unfinished work with the next job', async () => {
  const thumbnails = readFileSync(new URL('../src/main/thumbnails.ts', import.meta.url), 'utf8')
  const start = thumbnails.indexOf('async function rendererWork<'), end = thumbnails.indexOf('\n/**', start)
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  const rendererWork = new Function('renderWin', stripTypeScriptTypes(thumbnails.slice(start, end)) + '; return rendererWork')(window)
  let finish
  const pending = new Promise(resolve => { finish = resolve }), calls = []
  const queue = createThumbnailQueue(async (name, signal) => {
    calls.push(name)
    await rendererWork(name === 'old' ? pending : Promise.resolve(), signal)
    return { [name]: 'drawn' }
  })
  const old = queue('old')
  queue.cancelAll()
  const next = queue('new')
  try {
    await new Promise(setImmediate)
    assert.deepEqual(calls, ['old'], 'a live renderer is still executing the old request')
  } finally { finish(); await Promise.all([old, next]) }
})
console.log(`quit attempt: ${passed} checks passed`)
