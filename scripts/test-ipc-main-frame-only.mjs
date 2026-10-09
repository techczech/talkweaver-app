// No IPC listener answers a frame that is not its window's main frame (src/main/ipc-main-frame-only.ts,
// embed-sandbox design 4.2, matrix row 17). Driven against a fake ipcMain that behaves as Electron's
// does: one handler per channel for invoke, an event emitter for send.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMainFrameOnly, senderFrameVerdict } from '../src/main/ipc-main-frame-only.ts'

let passed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}`); throw err }
}

/** Electron's ipcMain, as far as registration and dispatch go. */
function fakeIpcMain() {
  const handlers = new Map()
  const listeners = new Map()
  return {
    handlers, listeners,
    handle(channel, fn) { if (handlers.has(channel)) throw new Error(`second handler for ${channel}`); handlers.set(channel, fn) },
    handleOnce(channel, fn) { this.handle(channel, (e, ...a) => { this.removeHandler(channel); return fn(e, ...a) }) },
    removeHandler(channel) { handlers.delete(channel) },
    on(channel, fn) { listeners.set(channel, [...(listeners.get(channel) ?? []), fn]); return this },
    once(channel, fn) { const w = (...a) => { this.removeListener(channel, w); fn(...a) }; return this.on(channel, w) },
    removeListener(channel, fn) { listeners.set(channel, (listeners.get(channel) ?? []).filter((l) => l !== fn)); return this },
    off(channel, fn) { return this.removeListener(channel, fn) },
    // What a renderer's ipcRenderer.invoke / send does in main.
    async invoke(channel, event, ...args) { const fn = handlers.get(channel); if (!fn) throw new Error(`No handler registered for '${channel}'`); return fn(event, ...args) },
    send(channel, event, ...args) { for (const fn of [...(listeners.get(channel) ?? [])]) fn(event, ...args) },
  }
}

/** A window with a main frame and one embedded frame; events as Electron builds them. */
function fakeWindow(id = 7) {
  const mainFrame = { name: 'main', parent: null }
  const subframe = { name: 'embed', parent: mainFrame }
  const sender = { id, mainFrame, getURL: () => 'file:///present/talk.html?presenter=1' }
  return {
    fromMain: () => ({ sender, senderFrame: mainFrame }),
    fromSubframe: () => ({ sender, senderFrame: subframe }),
    fromGoneFrame: () => ({ sender, senderFrame: null }),
  }
}

console.log('ipc: main frame only')

await test('the verdict: main frame, subframe, no frame, and everything unreadable', () => {
  const w = fakeWindow()
  assert.equal(senderFrameVerdict(w.fromMain()), 'main-frame')
  assert.equal(senderFrameVerdict(w.fromSubframe()), 'subframe')
  assert.equal(senderFrameVerdict(w.fromGoneFrame()), 'no-frame')
  assert.equal(senderFrameVerdict({ sender: { mainFrame: {} } }), 'no-frame', 'senderFrame missing')
  assert.equal(senderFrameVerdict({ senderFrame: {}, sender: {} }), 'no-frame', 'no main frame to compare with')
  assert.equal(senderFrameVerdict({ senderFrame: {}, sender: { mainFrame: null } }), 'no-frame')
  assert.equal(senderFrameVerdict({ senderFrame: null, sender: { mainFrame: null } }), 'no-frame', 'null is never equal to null here')
  assert.equal(senderFrameVerdict({ senderFrame: undefined, sender: { mainFrame: undefined } }), 'no-frame')
  assert.equal(senderFrameVerdict(null), 'no-frame')
  assert.equal(senderFrameVerdict({ get senderFrame() { throw new Error('destroyed') }, sender: {} }), 'no-frame')
  // Another window's main frame is not this window's main frame.
  assert.equal(senderFrameVerdict({ sender: fakeWindow(1).fromMain().sender, senderFrame: fakeWindow(2).fromMain().senderFrame }), 'subframe')
})

await test('handle: runs for the main frame; rejects for a subframe and for a gone frame, with one log line each', async () => {
  const ipc = fakeIpcMain()
  const logs = []
  applyMainFrameOnly(ipc, { log: (m) => logs.push(m) })
  const calls = []
  ipc.handle('live:go', (event, a, b) => { calls.push([event.sender.id, a, b]); return { success: true } })
  const w = fakeWindow()
  assert.deepEqual(await ipc.invoke('live:go', w.fromMain(), 1, 'x'), { success: true })
  assert.deepEqual(calls, [[7, 1, 'x']])
  await assert.rejects(ipc.invoke('live:go', w.fromSubframe(), 2), /refused call on live:go from a frame that is not the window's main frame/)
  await assert.rejects(ipc.invoke('live:go', w.fromGoneFrame(), 3), /refused call on live:go from a frame that is gone or unknown/)
  assert.equal(calls.length, 1, 'the listener never ran for either')
  assert.equal(logs.length, 2)
  assert.match(logs[0], /^\[ipc\] refused call on live:go .* in window 7 \(file:\/\/\/present\/talk\.html/)
  // An async listener's promise comes back unchanged.
  ipc.handle('recording:save', async () => 'saved')
  assert.equal(await ipc.invoke('recording:save', w.fromMain()), 'saved')
})

await test('handleOnce: a refused call does not use the registration up', async () => {
  const ipc = fakeIpcMain()
  applyMainFrameOnly(ipc, { log: () => {} })
  let ran = 0
  ipc.handleOnce('once:thing', () => { ran++; return 'done' })
  const w = fakeWindow()
  await assert.rejects(ipc.invoke('once:thing', w.fromSubframe()))
  await assert.rejects(ipc.invoke('once:thing', w.fromGoneFrame()))
  assert.equal(ran, 0)
  assert.equal(await ipc.invoke('once:thing', w.fromMain()), 'done')
  assert.equal(ran, 1)
  await assert.rejects(ipc.invoke('once:thing', w.fromMain()), /No handler registered/, 'used up by the main frame only')
})

await test('on: delivers the main frame\'s messages; drops a subframe\'s and a gone frame\'s, with one log line each', () => {
  const ipc = fakeIpcMain()
  const logs = []
  applyMainFrameOnly(ipc, { log: (m) => logs.push(m) })
  const got = []
  ipc.on('live:publish-slide', (_event, state) => got.push(state))
  const w = fakeWindow()
  ipc.send('live:publish-slide', w.fromMain(), { slideId: 'a' })
  ipc.send('live:publish-slide', w.fromSubframe(), { slideId: 'forged' })
  ipc.send('live:publish-slide', w.fromGoneFrame(), { slideId: 'late' })
  ipc.send('live:publish-slide', w.fromMain(), { slideId: 'b' })
  assert.deepEqual(got, [{ slideId: 'a' }, { slideId: 'b' }])
  assert.equal(logs.length, 2)
  assert.match(logs[0], /^\[ipc\] refused message on live:publish-slide from a frame that is not the window's main frame/)
})

await test('once: a refused message does not use the listener up; the main frame\'s first message does', () => {
  const ipc = fakeIpcMain()
  applyMainFrameOnly(ipc, { log: () => {} })
  const got = []
  ipc.once('ready', (_event, n) => got.push(n))
  const w = fakeWindow()
  ipc.send('ready', w.fromSubframe(), 1)
  ipc.send('ready', w.fromMain(), 2)
  ipc.send('ready', w.fromMain(), 3)
  assert.deepEqual(got, [2])
  assert.equal(ipc.listeners.get('ready').length, 0)
})

await test('removeListener / off take the listener that was registered', () => {
  const ipc = fakeIpcMain()
  applyMainFrameOnly(ipc, { log: () => {} })
  const got = []
  const a = () => got.push('a')
  const b = () => got.push('b')
  ipc.on('x', a); ipc.on('x', b); ipc.once('x', a)
  ipc.removeListener('x', a) // the once
  ipc.off('x', b)
  ipc.send('x', fakeWindow().fromMain())
  assert.deepEqual(got, ['a'])
  ipc.removeListener('x', a)
  ipc.send('x', fakeWindow().fromMain())
  assert.deepEqual(got, ['a'])
  assert.equal(ipc.listeners.get('x').length, 0)
})

await test('a throwing log never lets a refused call through; applying twice wraps once', async () => {
  const ipc = fakeIpcMain()
  applyMainFrameOnly(ipc, { log: () => { throw new Error('log is broken') } })
  const once = ipc.handle
  applyMainFrameOnly(ipc, { log: () => {} })
  assert.equal(ipc.handle, once)
  let ran = 0
  ipc.handle('h', () => { ran++ })
  ipc.on('m', () => { ran++ })
  await assert.rejects(ipc.invoke('h', fakeWindow().fromSubframe()))
  ipc.send('m', fakeWindow().fromSubframe())
  assert.equal(ran, 0)
})

// ── The app's own wiring ─────────────────────────────────────────────────────────────────────────
const mainDir = fileURLToPath(new URL('../src/main/', import.meta.url))
const sources = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? sources(path) : /\.(ts|mts|mjs|js)$/.test(name) ? [path] : []
})

await test('no window runs a preload in subframes: the preference is named nowhere in src/main', () => {
  const preference = ['nodeIntegration', 'In', 'SubFrames'].join('')
  for (const path of sources(mainDir)) {
    assert.ok(!readFileSync(path, 'utf8').includes(preference), `${path} names ${preference}`)
  }
  for (const path of sources(mainDir)) assert.ok(!/webviewTag\s*:\s*true/.test(readFileSync(path, 'utf8')), `${path} turns <webview> on`)
})

await test('index.ts applies the guard to ipcMain before the first registration, and no module registers on import', () => {
  const index = readFileSync(join(mainDir, 'index.ts'), 'utf8')
  const applied = index.indexOf('\napplyMainFrameOnly(ipcMain)')
  assert.ok(applied > 0, 'applied at module top level')
  const firstUse = index.search(/^(?!import\b|\s*\/\/).*\bipcMain\b/m)
  const firstRegistration = index.search(/\bipcMain\.(handle|handleOnce|on|once)\(/)
  assert.ok(firstRegistration > applied, 'before the first ipcMain.handle / on')
  assert.equal(firstUse, applied + 1, 'the first line of code that touches ipcMain is the guard')
  // Every other module registers inside a function that index.ts calls; none at its own top level.
  for (const path of sources(mainDir)) {
    if (path.endsWith('/index.ts') || path.endsWith('ipc-main-frame-only.ts')) continue
    const text = readFileSync(path, 'utf8')
    assert.ok(!/^(ipcMain|ipc)\.(handle|handleOnce|on|once)\(/m.test(text), `${path} registers an IPC listener when it is imported`)
    assert.ok(!/^register\w*Ipc\w*\(/m.test(text), `${path} calls an IPC registration when it is imported`)
  }
})

console.log(`ipc: main frame only: ${passed} passed`)
