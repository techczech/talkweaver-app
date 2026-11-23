import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { applyMainFrameOnly } from '../src/main/ipc-main-frame-only.ts'
import { registerLiveIpc } from '../src/main/live-ipc.ts'
import { readSource } from './lib/read-source.mjs'

const handlers = new Map()
const ipcMain = Object.assign(new EventEmitter(), {
  handle(channel, handler) {
    assert.ok(!handlers.has(channel), `duplicate handler for ${channel}`)
    handlers.set(channel, handler)
  },
  removeHandler(channel) { handlers.delete(channel) },
  async invoke(channel, event, ...args) { return handlers.get(channel)(event, ...args) },
})
applyMainFrameOnly(ipcMain, { log: () => {} })

const calls = []
const boards = [{ pollId: 'board-a' }]
const ended = { success: true, status: 'ended' }
registerLiveIpc({
  ipcMain,
  attachLiveWindow: (id) => { calls.push(['attach', id]); return null },
  livePresenterContexts: new Map(),
  liveSessions: {
    openBoards(id) { calls.push(['openBoards', id]); return boards },
    end(id, options) { calls.push(['end', id, options]); return Promise.resolve(ended) },
    embed(id, value) { calls.push(['embed', id, value]) },
  },
})

const preload = readSource(new URL('../src/preload/present-live-bridge.ts', import.meta.url))
const channels = (pattern) => [...new Set([...preload.matchAll(pattern)].map((match) => match[1]))].sort()
const invokes = channels(/ipcRenderer\.invoke\('(live:[^']+)'/g)
const sends = channels(/ipcRenderer\.send\('(live:[^']+)'/g)
assert.equal(invokes.length + sends.length, 21)
assert.deepEqual([...handlers.keys()].sort(), invokes)
assert.deepEqual(ipcMain.eventNames().sort(), sends)
for (const channel of sends) assert.equal(ipcMain.listenerCount(channel), 1, channel)

const mainFrame = {}
const sender = { id: 7, mainFrame }
const mainEvent = { sender, senderFrame: mainFrame }
const subframeEvent = { sender, senderFrame: {} }
await assert.rejects(ipcMain.invoke('live:open-boards', subframeEvent), /refused call on live:open-boards/)
ipcMain.emit('live:embed', subframeEvent, 'ignored')
assert.deepEqual(calls, [], 'the main-frame guard prevents the host calls')

assert.equal(await ipcMain.invoke('live:open-boards', mainEvent), boards)
assert.equal(await ipcMain.invoke('live:end', mainEvent, { keepBoardsOpen: true }), ended)
ipcMain.emit('live:embed', mainEvent, 'delivered')
assert.deepEqual(calls, [
  ['attach', 7], ['openBoards', 7],
  ['attach', 7], ['end', 7, { keepBoardsOpen: true }],
  ['embed', 7, 'delivered'],
])
console.log('live IPC: all 21 preload channels, main-frame refusals and host replies passed')
