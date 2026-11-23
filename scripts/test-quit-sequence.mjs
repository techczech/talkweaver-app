import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { test } from 'node:test'
import { mainSourceFileAt, readMainSource } from './lib/read-source.mjs'
import { createQuitSequence } from '../src/main/quit-sequence.ts'
import { createDirectoryWatchService } from '../src/main/directory-watch.ts'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function settleQuit() {
  await nextTurn()
  await nextTurn()
}

function harness() {
  const trace = [], errors = []
  const app = new EventEmitter()
  let quits = 0, exits = 0, vetoWindow = false
  app.quit = () => {
    quits++
    for (const stage of ['before-quit', 'will-quit']) {
      if (stage === 'will-quit') {
        trace.push('windows')
        if (vetoWindow) {
          if (vetoWindow === 'cancel') sequence.cancel()
          return
        }
      }
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
      app.emit(stage, event)
      if (event.defaultPrevented) return
    }
    exits++
  }
  const sequence = createQuitSequence(app, (name, error) => errors.push([name, error]), () => () => sequence.cancel())
  function add(stage, name, run = () => { trace.push(name) }, timeoutMs = 0, when) {
    sequence.add({ stage, name, run, timeoutMs, when })
  }
  return { app, sequence, add, trace, errors, quits: () => quits, exits: () => exits,
    vetoWindow: value => { vetoWindow = value } }
}

test('synchronous steps run in stage order without reissuing quit', () => {
  const h = harness()
  h.add('will-quit', 'disk guard')
  h.add('before-quit', 'transcription')
  h.add('before-quit', 'inapplicable', undefined, 0, () => false)
  h.add('before-quit', 'scratchpad')
  h.add('will-quit', 'workers')
  h.app.quit()
  assert.deepEqual(h.trace, ['transcription', 'scratchpad', 'windows', 'disk guard', 'workers'])
  assert.equal(h.quits(), 1)
  assert.equal(h.exits(), 1)
})

test('export and the two write drains stay on their native sides of close with one retry per held stage', async () => {
  const h = harness()
  const exportDone = deferred(), settingsDone = deferred(), createsDone = deferred()
  h.add('before-quit', 'export', () => { h.trace.push('export'); return exportDone.promise }, 4000)
  h.add('will-quit', 'settings', () => { h.trace.push('settings'); return settingsDone.promise }, 3000)
  h.add('will-quit', 'creates', () => { h.trace.push('creates'); return createsDone.promise }, 5000)
  h.add('will-quit', 'workers')
  h.app.quit()
  assert.deepEqual(h.trace, ['export'])
  exportDone.resolve()
  await settleQuit()
  assert.deepEqual(h.trace, ['export', 'windows', 'settings'])
  assert.equal(h.quits(), 2)
  settingsDone.resolve()
  await settleQuit()
  assert.deepEqual(h.trace, ['export', 'windows', 'settings', 'creates'])
  assert.equal(h.quits(), 2)
  createsDone.resolve()
  await settleQuit()
  assert.deepEqual(h.trace, ['export', 'windows', 'settings', 'creates', 'workers', 'windows'])
  assert.equal(h.quits(), 3)
  assert.equal(h.exits(), 1)
})

test('a second quit request during a hold cannot close the windows or start a second export', async () => {
  const h = harness(), exportDone = deferred()
  h.add('before-quit', 'export', () => { h.trace.push('export'); return exportDone.promise }, 4000)
  h.app.quit()
  h.app.quit()
  assert.deepEqual(h.trace, ['export'])
  exportDone.resolve()
  await settleQuit()
  assert.deepEqual(h.trace, ['export', 'windows'])
  assert.equal(h.quits(), 3)
  assert.equal(h.exits(), 1)
})

test('throws, rejections and timeouts are logged and later steps still run in order', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness(), stuck = deferred()
  const failed = new Error('failed'), rejected = new Error('rejected')
  h.add('will-quit', 'throwing', () => { throw failed })
  h.add('will-quit', 'rejecting', () => Promise.reject(rejected), 1000)
  h.add('will-quit', 'stuck', () => stuck.promise, 50)
  h.add('will-quit', 'workers')
  h.app.quit()
  await settleQuit()
  t.mock.timers.tick(49)
  assert.equal(h.exits(), 0)
  t.mock.timers.tick(1)
  await settleQuit()
  assert.deepEqual(h.trace, ['windows', 'workers', 'windows'])
  assert.equal(h.exits(), 1)
  assert.deepEqual(h.errors.slice(0, 2), [['throwing', failed], ['rejecting', rejected]])
  assert.deepEqual(h.errors.map(([name]) => name), ['throwing', 'rejecting', 'stuck'])
  assert.match(h.errors[2][1].message, /50 ms/)
  stuck.resolve()
  await settleQuit()
  assert.equal(h.quits(), 2)
})

test('a window veto resets the stages, with no will-quit work left attached to an unrelated close', async () => {
  const h = harness()
  h.add('before-quit', 'export', () => { h.trace.push('export'); return Promise.resolve() }, 4000)
  h.add('will-quit', 'workers')
  h.vetoWindow('cancel')
  h.app.quit()
  await settleQuit()
  assert.deepEqual(h.trace, ['export', 'windows'])
  assert.equal(h.exits(), 0)
  h.app.emit('window-all-closed')
  await settleQuit()
  assert.deepEqual(h.trace, ['export', 'windows'])
  h.vetoWindow(false)
  h.app.quit()
  await settleQuit()
  assert.deepEqual(h.trace, ['export', 'windows', 'export', 'windows', 'workers'])
  assert.equal(h.exits(), 1)
})

test('a misconfigured synchronous step cannot hold quit or cause a retry loop', async () => {
  const h = harness()
  const unexpected = deferred()
  h.add('before-quit', 'misconfigured', () => unexpected.promise)
  h.add('before-quit', 'scratchpad')
  try {
    h.app.quit()
    assert.deepEqual(h.trace, ['scratchpad', 'windows'])
    assert.match(h.errors[0][1].message, /positive timeout/)
    unexpected.resolve()
    await settleQuit()
    assert.equal(h.quits(), 1)
    assert.equal(h.exits(), 1)
  } finally {
    // If the regression returns, stop its pending reissue so the failure can exit.
    h.sequence.cancel()
    unexpected.resolve()
  }
})

test('a frozen editor can finish saving then reissue quit without restarting the export wait', async () => {
  const h = harness(), exportDone = deferred()
  let transcriptionRunning = false
  h.add('before-quit', 'transcription', () => {
    if (transcriptionRunning) h.trace.push('stop new transcription')
    transcriptionRunning = false
  })
  h.add('before-quit', 'export', () => { h.trace.push('export'); return exportDone.promise }, 4000)
  h.add('will-quit', 'workers')
  h.vetoWindow(true)
  h.app.quit()
  transcriptionRunning = true
  exportDone.resolve()
  await settleQuit()
  assert.deepEqual(h.trace, ['export', 'stop new transcription', 'windows'])
  assert.equal(h.exits(), 0)
  h.vetoWindow(false)
  h.app.quit()
  assert.deepEqual(h.trace, ['export', 'stop new transcription', 'windows', 'windows', 'workers'])
  assert.equal(h.quits(), 3)
  assert.equal(h.exits(), 1)
})

test('an abandoned native restart still exits once will-quit has started closing its stores', async () => {
  const h = harness(), preferences = deferred()
  h.add('will-quit', 'settings', () => { h.trace.push('settings'); return preferences.promise }, 3000)
  h.add('will-quit', 'workers')
  h.app.quit()
  assert.deepEqual(h.trace, ['windows', 'settings'])
  h.sequence.cancel()
  preferences.resolve()
  await settleQuit()
  assert.deepEqual(h.trace, ['windows', 'settings', 'workers', 'windows'])
  assert.equal(h.quits(), 2)
  assert.equal(h.exits(), 1)
})

test('settlement from a cancelled hold cannot continue work or reissue quit', async () => {
  const h = harness(), old = deferred(), current = deferred()
  let pending = old
  h.add('before-quit', 'export', () => pending.promise, 4000)
  h.add('before-quit', 'scratchpad')
  h.app.quit()
  h.sequence.cancel()
  pending = current
  h.app.quit()
  old.resolve()
  await settleQuit()
  assert.deepEqual(h.trace, [])
  assert.equal(h.quits(), 2)
  current.resolve()
  await settleQuit()
  assert.deepEqual(h.trace, ['scratchpad', 'scratchpad', 'windows'])
  assert.equal(h.quits(), 3)
  assert.equal(h.exits(), 1)
})

test('the main process registers exactly one listener per native quit stage, both in the sequence', () => {
  const source = readMainSource()
  const stages = [...source.matchAll(/\.\s*(?:on|once|addListener|prependListener|prependOnceListener)\s*\(\s*(['"\x60])(before-quit|will-quit)\1/g)]
  assert.deepEqual(stages.map(match => [match[2], mainSourceFileAt(match.index)]), [
    ['before-quit', 'src/main/quit-sequence.ts'],
    ['will-quit', 'src/main/quit-sequence.ts'],
  ])
})


test('unwatch returns immediately and drops late events without disturbing the other subscription', () => {
  const commands = []
  const child = Object.assign(new EventEmitter(), { postMessage: command => commands.push(command), kill() {} })
  const watcher = createDirectoryWatchService(() => child)
  const changes = []
  const first = watcher.watch('/first', {}, (...change) => changes.push(['first', ...change]))
  watcher.watch('/second', { recursive: true }, (...change) => changes.push(['second', ...change]))
  child.emit('message', { type: 'ready', id: 1 })
  first.close()
  first.close()
  child.emit('message', { type: 'change', id: 1, event: 'change', name: 'old.md' })
  child.emit('message', { type: 'change', id: 2, event: 'rename', name: 'current.md' })
  assert.deepEqual(commands, [
    { type: 'watch', id: 1, path: '/first', recursive: false },
    { type: 'watch', id: 2, path: '/second', recursive: true },
    { type: 'unwatch', id: 1 },
  ])
  assert.deepEqual(changes, [['first', 'rename', null], ['second', 'rename', 'current.md']])
})

test('watcher errors release the subscription and committed Quit kills the child once', () => {
  const errors = []
  let killed = 0
  const child = Object.assign(new EventEmitter(), { postMessage() {}, kill() { killed++ } })
  const watcher = createDirectoryWatchService(() => child)
  const first = watcher.watch('/missing', {}, () => assert.fail('a failed watch cannot report a change'))
  first.on('error', error => errors.push(error.message))
  child.emit('message', { type: 'error', id: 1, message: 'missing' })
  child.emit('message', { type: 'change', id: 1, event: 'rename', name: null })
  watcher.watch('/live', {}, () => assert.fail('Quit has discarded every callback'))
  watcher.stop()
  watcher.stop()
  child.emit('message', { type: 'change', id: 2, event: 'rename', name: null })
  assert.deepEqual(errors, ['missing'])
  assert.equal(killed, 1)
})
