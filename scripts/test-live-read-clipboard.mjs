// The presenter's clipboard read, in main (src/main/live-read-clipboard.ts, src/main/recent-press.ts;
// embed-sandbox design 4.3, matrix row 18): only a focused presenter window that had a real key or
// mouse press in the last five seconds; text capped; one image.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CLIPBOARD_IMAGE_LIMIT_BYTES, CLIPBOARD_TEXT_LIMIT, capClipboardText, decideClipboardRead, liveReadClipboardHandler } from '../src/main/live-read-clipboard.ts'
import { RECENT_PRESS_MS, createPressLedger, installPressLedger, isPressInput } from '../src/main/recent-press.ts'

let passed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}`); throw err }
}

console.log('live: read clipboard')

await test('the decision: presenter window, focused, a recent press — all three', () => {
  assert.equal(decideClipboardRead({ isPresenter: true, focused: true, pressedRecently: true }), 'allow')
  assert.equal(decideClipboardRead({ isPresenter: false, focused: true, pressedRecently: true }), 'not-presenter')
  assert.equal(decideClipboardRead({ isPresenter: true, focused: false, pressedRecently: true }), 'not-focused')
  assert.equal(decideClipboardRead({ isPresenter: true, focused: true, pressedRecently: false }), 'no-recent-press')
  assert.equal(decideClipboardRead({ isPresenter: false, focused: false, pressedRecently: false }), 'not-presenter')
  // Only a real `true` counts.
  assert.equal(decideClipboardRead({ isPresenter: 1, focused: true, pressedRecently: true }), 'not-presenter')
  assert.equal(decideClipboardRead({ isPresenter: true, focused: 'yes', pressedRecently: true }), 'not-focused')
  assert.equal(decideClipboardRead({ isPresenter: true, focused: true, pressedRecently: undefined }), 'no-recent-press')
})

await test('text is cut to 20,000 characters and never ends on half a character', () => {
  assert.equal(CLIPBOARD_TEXT_LIMIT, 20_000)
  assert.equal(capClipboardText('short'), 'short')
  assert.equal(capClipboardText('x'.repeat(20_000)).length, 20_000)
  assert.equal(capClipboardText('x'.repeat(20_001)).length, 20_000)
  assert.equal(capClipboardText('x'.repeat(1_000_000)).length, 20_000)
  const split = 'x'.repeat(19_999) + '😀' + 'tail' // the emoji's two halves straddle the limit
  assert.equal(capClipboardText(split), 'x'.repeat(19_999))
  assert.equal(capClipboardText('x'.repeat(19_998) + '😀' + 'tail'), 'x'.repeat(19_998) + '😀')
  for (const not of [undefined, null, 42, {}, ['a']]) assert.equal(capClipboardText(not), '')
})

await test('what counts as a press: the start of a key or mouse press on the three browser-side events', () => {
  for (const type of ['mouseDown', 'keyDown', 'rawKeyDown', 'touchStart', 'gestureTap']) assert.equal(isPressInput('input-event', { type }), true, type)
  for (const type of ['mouseUp', 'mouseMove', 'mouseEnter', 'mouseLeave', 'mouseWheel', 'keyUp', 'char', 'contextMenu', 'gestureScrollBegin', 'pointerMove', 'undefined', '', undefined]) {
    assert.equal(isPressInput('input-event', { type }), false, String(type))
  }
  assert.equal(isPressInput('before-mouse-event', { type: 'mouseDown' }), true)
  assert.equal(isPressInput('before-mouse-event', { type: 'mouseMove' }), false)
  assert.equal(isPressInput('before-input-event', { type: 'keyDown' }), true)
  assert.equal(isPressInput('before-input-event', { type: 'keyUp' }), false)
  assert.equal(isPressInput('ipc-message', { type: 'mouseDown' }), false, 'no other event records a press')
  assert.equal(isPressInput('input-event', null), false)
})

/** A webContents that records listeners, as Electron's does. */
function fakeContents(id) {
  const listeners = new Map()
  return { id, on(event, fn) { listeners.set(event, [...(listeners.get(event) ?? []), fn]); return this }, emit(event, ...args) { for (const fn of listeners.get(event) ?? []) fn(...args) }, listeners }
}

await test('the press ledger: per window, five seconds, forgotten when the window goes', () => {
  let t = 1_000
  const ledger = createPressLedger({ now: () => t })
  const presenter = fakeContents(11)
  const other = fakeContents(12)
  ledger.watch(presenter); ledger.watch(other)
  assert.equal(RECENT_PRESS_MS, 5_000)
  assert.equal(ledger.pressedRecently(11), false, 'no press yet')
  presenter.emit('input-event', {}, { type: 'mouseMove' })
  presenter.emit('input-event', {}, { type: 'keyUp' })
  assert.equal(ledger.pressedRecently(11), false, 'a move or a release is not a press')
  presenter.emit('input-event', {}, { type: 'mouseDown' })
  assert.equal(ledger.pressedRecently(11), true)
  assert.equal(ledger.pressedRecently(12), false, 'a press in one window says nothing about another')
  t += 5_000
  assert.equal(ledger.pressedRecently(11), true, 'exactly five seconds ago still counts')
  t += 1
  assert.equal(ledger.pressedRecently(11), false, 'five seconds and a millisecond does not')
  presenter.emit('before-input-event', {}, { type: 'keyDown', key: 'Enter' })
  assert.equal(ledger.pressedRecently(11), true, 'Enter in the command palette')
  t += 6_000
  presenter.emit('before-mouse-event', {}, { type: 'mouseDown' })
  assert.equal(ledger.pressedRecently(11), true)
  t -= 10 // a clock that runs backwards never makes a press recent
  assert.equal(ledger.pressedRecently(11), false)
  t += 20
  presenter.emit('input-event', {}, { type: 'rawKeyDown' })
  presenter.emit('destroyed')
  assert.equal(ledger.pressedRecently(11), false, 'forgotten with the window')
  assert.equal(ledger.pressedRecently(999), false)
})

await test('the ledger watches every webContents the app creates', () => {
  let hook = null
  const ledger = createPressLedger({ now: () => 5 })
  installPressLedger({ on: (event, fn) => { assert.equal(event, 'web-contents-created'); hook = fn } }, ledger)
  const wc = fakeContents(3)
  hook({}, wc)
  wc.emit('input-event', {}, { type: 'keyDown' })
  assert.equal(ledger.pressedRecently(3), true)
})

const png = (bytes) => ({ isEmpty: () => bytes === 0, toPNG: () => new Uint8Array(bytes).fill(7) })
function setup(overrides = {}) {
  const reads = { text: 0, image: 0 }
  const logs = []
  const state = { presenter: true, focused: true, pressed: true, text: 'hello', image: png(4), ...overrides }
  const handler = liveReadClipboardHandler({
    isPresenter: (id) => state.presenter && id === 11,
    isFocused: (sender) => state.focused && sender.id === 11,
    pressedRecently: (id) => state.pressed && id === 11,
    clipboard: { readText: () => { reads.text++; return state.text }, readImage: () => { reads.image++; return state.image } },
    log: (m) => logs.push(m),
  })
  return { handler, reads, logs, state }
}
const fromPresenter = { sender: { id: 11 } }

await test('handler: the presenter window gets text and one image', () => {
  const { handler, logs } = setup()
  const clip = handler(fromPresenter)
  assert.equal(clip.text, 'hello')
  assert.ok(clip.image instanceof Uint8Array)
  assert.deepEqual([...clip.image], [7, 7, 7, 7])
  assert.equal(logs.length, 0)
  assert.deepEqual(Object.keys(clip).sort(), ['image', 'text'])
})

await test('handler: refused without touching the clipboard — another window, not focused, no recent press', () => {
  for (const [overrides, event, why] of [
    [{}, { sender: { id: 12 } }, 'not-presenter'],
    [{ presenter: false }, fromPresenter, 'not-presenter'],
    [{ focused: false }, fromPresenter, 'not-focused'],
    [{ pressed: false }, fromPresenter, 'no-recent-press'],
    [{}, { sender: {} }, 'not-presenter'],
    [{}, {}, 'not-presenter'],
  ]) {
    const { handler, reads, logs } = setup(overrides)
    assert.deepEqual(handler(event), { text: '', image: null }, why)
    assert.deepEqual(reads, { text: 0, image: 0 }, `${why}: the clipboard was not read`)
    assert.equal(logs.length, 1)
    assert.match(logs[0], new RegExp(`^\\[clipboard\\] refused a read from window .*: ${why}$`))
  }
})

await test('handler: a check that throws refuses; text is capped; an empty or oversized image is dropped', () => {
  const broken = liveReadClipboardHandler({
    isPresenter: () => { throw new Error('x') }, isFocused: () => true, pressedRecently: () => true,
    clipboard: { readText: () => 'secret', readImage: () => png(1) }, log: () => {},
  })
  assert.deepEqual(broken(fromPresenter), { text: '', image: null })
  assert.equal(setup({ text: 'y'.repeat(50_000) }).handler(fromPresenter).text.length, 20_000)
  assert.equal(setup({ image: png(0) }).handler(fromPresenter).image, null)
  assert.equal(setup({ image: null }).handler(fromPresenter).image, null)
  assert.equal(setup({ image: { isEmpty: () => false, toPNG: () => ({ byteLength: CLIPBOARD_IMAGE_LIMIT_BYTES + 1, length: 0 }) } }).handler(fromPresenter).image, null)
  const throwing = setup({ image: { isEmpty: () => { throw new Error('no image') } } }).handler(fromPresenter)
  assert.deepEqual(throwing, { text: 'hello', image: null })
})

await test('wiring: main owns the read; the preload asks only with a user activation and no longer reads the clipboard', () => {
  const index = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.match(index, /ipcMain\.handle\('live:read-clipboard', liveReadClipboardHandler\(\{/)
  assert.match(index, /isPresenter: \(wcId\) => livePresenterContexts\.has\(wcId\)/)
  assert.match(index, /pressedRecently: \(wcId\) => pressLedger\.pressedRecently\(wcId\)/)
  assert.match(index, /installPressLedger\(app, pressLedger\)/)
  const preload = readFileSync(new URL('../src/preload/present-live-bridge.ts', import.meta.url), 'utf8')
  assert.ok(!/clipboard\.read\w*\(/.test(preload), 'the preload reads nothing from Electron\'s clipboard')
  assert.match(preload, /clipboard\.writeText\(link\)/, 'the join link is still copied')
  const fn = preload.slice(preload.indexOf('readClipboard: async'), preload.indexOf('action: (message'))
  assert.ok(fn.indexOf('navigator.userActivation?.isActive !== true') > 0 && fn.indexOf('navigator.userActivation?.isActive !== true') < fn.indexOf("ipcRenderer.invoke('live:read-clipboard')"), 'the activation check comes before the call')
  // The one caller in the deck awaits the bridge (it was synchronous before).
  const template = readFileSync(new URL('../compiler/assets/templates/presenter-popup-single-html.html', import.meta.url), 'utf8')
  assert.match(template, /clip = await window\.twLivePollBridge\?\.readClipboard\?\.\(\)/)
})

console.log(`live: read clipboard: ${passed} passed`)
