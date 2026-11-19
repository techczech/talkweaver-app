// Updating in place (ADR-0044 §3): the engine's order and its one restart gate (src/main/update-engine.ts), driven
// with fake timers, a fake download that resolves when the test says so, a fake hand-over and a fake Squirrel.Mac that
// answers late, fails, or arms ShipIt on its own schedule, and a withdrawal that can fail.
//  D1 download and verify, D2 waiting: Squirrel.Mac receives no call at all (no feed address, no check, not even a
//  listener). D3: the hand-over only after a blocker check, then one more check and the spent flag before the native
//  request. D4: a blocker at the last moment, the watchdog, a failed install: the withdrawal is checked, and a failed
//  one is reported, never swallowed.
// Then the real electron-updater MacUpdater, with Electron's autoUpdater replaced by a fake: its own hand-over (local
// address, setFeedURL) is deferred to restart time and its own routes to the native install refuse.
// Then the downloaded file's size and version checks on real zips (macOS only: ditto, unzip and plutil).
// Plain Node; no Electron, no network beyond 127.0.0.1.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inPlaceRefusal, reopenText } from '../src/shared/update-install.ts'
import { delay, standInApp } from './lib/restart-window-standins.mjs'
import { drainWriteQueues, writeQueuesBusy, trackWrite } from '../src/main/write-queues.ts'
import { createConfigOverlay } from '../src/main/settings-overlay.ts'

// Electron's autoUpdater, faked before electron-updater is loaded (it reads require('electron').autoUpdater).
const require = createRequire(import.meta.url)
const electronPath = require.resolve('electron')
const fakeElectron = { autoUpdater: null }
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: fakeElectron }
const { createUpdateEngine, closeDependencyInstallPath, dependencyDownload, verifyMacDownload, RESTART_WATCHDOG_MS, launchdJobPresence, pathPresence } = await import('../src/main/update-engine.ts')
const { MacUpdater } = await import('electron-updater')

// The withdrawal's two checks: only a definite answer counts; a check that failed is never read as "gone".
assert.equal(launchdJobPresence({ status: 0 }), 'present')
assert.equal(launchdJobPresence({ status: 113 }), 'absent')
assert.equal(launchdJobPresence({ status: null, signal: 'SIGTERM' }), 'unknown', 'a timed-out launchctl is not an answer')
assert.equal(launchdJobPresence({ status: null, error: new Error('spawn ENOENT') }), 'unknown')
assert.equal(launchdJobPresence({ status: 1 }), 'unknown', 'an unexpected exit code is not an answer')
assert.equal(pathPresence(() => ({})), 'present')
assert.equal(pathPresence(() => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) }), 'absent')
assert.equal(pathPresence(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }), 'unknown', 'an unreadable path is not an answer')

let passed = 0
// TEST_KEEP_GOING=1 runs every check and lists each failure (to see that new checks fail without the fix).
const failures = []
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS  ${name}`) } catch (error) {
    console.error(`FAIL  ${name}`)
    if (!process.env.TEST_KEEP_GOING) throw error
    failures.push(name); console.error(`      ${String(error?.message ?? error).split('\n')[0]}`)
  }
}
const tick = () => new Promise((r) => setImmediate(r))
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick() }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

function fakeTimers() {
  let t = 0
  const due = new Map()
  let next = 1
  return {
    set: (fn, ms) => { const id = next++; due.set(id, { at: t + ms, fn }); return id },
    clear: (id) => { due.delete(id) },
    advance(ms) { t += ms; for (const [id, d] of [...due]) if (d.at <= t) { due.delete(id); d.fn() } },
    pending: () => due.size,
  }
}

/**
 * A fake Squirrel.Mac. Every method call is recorded in rig.native calls (with the order of everything the rig sees).
 * arm() models what Squirrel.Mac does before it says "ready": it writes its install request and launches ShipIt;
 * rig.armed is then true until a withdrawal removes it. quitAndInstall records what held at that moment and who called it.
 */
function fakeNative(rig) {
  const n = new EventEmitter()
  const on = n.on.bind(n)
  n.on = (event, fn) => { rig.calls.push(`on:${event}`); return on(event, fn) }
  n.setFeedURL = () => { rig.calls.push('setFeedURL'); rig.order?.push('setFeedURL') }
  n.checkForUpdates = () => { rig.calls.push('checkForUpdates'); rig.order?.push('checkForUpdates'); rig.prepares += 1 }
  n.quitAndInstall = () => {
    rig.calls.push('quitAndInstall')
    rig.quits.push({ blockers: [...rig.blockers], attempt: rig.engine.attemptId(), phase: rig.engine.state().phase, windows: rig.windows, from: new Error().stack })
    // Electron 42, shell/browser/api/electron_api_auto_updater.cc AutoUpdater::QuitAndInstall: with no window open it
    // installs at once; otherwise it adds itself as a window-list observer (never removed), closes every window, and
    // installs from OnWindowAllClosed whenever the last window closes, however much later, with nothing re-checked.
    if (rig.windows === 0) { rig.install('at once'); return }
    rig.observing = true
    rig.windows = rig.keptOpen
    if (rig.windows === 0) rig.install('when the windows closed')
  }
  /** Squirrel.Mac finished: ShipIt armed, then the ready event. */
  n.ready = () => { rig.armed = true; n.emit('update-downloaded') }
  return n
}

const OFFER = { version: '0.46.0', released: '2026-11-20', url: 'https://github.com/techczech/talkweaver-app/releases/download/v0.46.0/TalkWeaver-mac-arm64.zip', sha512: 'x', size: 100 }

/**
 * One engine with every port faked and each await held until the test releases it.
 * withdraw: 'ok' (removes what is armed, checked gone), 'fails' (found, not gone), 'throws', or 'hold' (a deferred
 * the test resolves with a Withdrawal).
 */
function rig({ platform = 'darwin', gate = () => null, autoVerify = true, holdHandOver = false, holdClose = false, app = null } = {}) {
  const r = { blockers: [], quits: [], prepares: 0, withdrawals: 0, releases: 0, checks: 0, fetches: 0, verifies: 0, handOvers: 0, nativeAccess: 0, calls: [], order: [], log: [], d: {}, tokens: [], armed: false, withdraw: 'ok' }
  // Open windows (an editor and the hidden thumbnail renderer, say); keptOpen: how many a close guard keeps ("Stay here").
  r.windows = 2
  r.keptOpen = 0
  r.closes = 0
  r.abandoned = 0
  r.installs = []
  r.observing = false
  /** What really installs: the native install with no window open, now or (Electron's observer) later. */
  r.install = (how) => r.installs.push({ how, blockers: [...r.blockers], attempt: r.engine.attemptId(), phase: r.engine.state().phase })
  /** The person closes the windows that were kept open, some time later. */
  r.closeTheRest = () => { r.windows = 0; if (r.observing) r.install('when the last window closed later') }
  r.timers = fakeTimers()
  r.native = fakeNative(r)
  r.engine = createUpdateEngine({
    platform,
    gate,
    // The blockers as main reads them: the work ones, and (with stand-in windows) the windows that are not editors.
    blockers: () => { r.order.push('blockers'); return [...r.blockers, ...(app ? app.windowBlockers() : [])] },
    downloader: () => ({
      check: () => { r.checks += 1; r.d.check = deferred(); return r.d.check.promise },
      retrieve: (token, progress) => { r.fetches += 1; r.tokens.push(token); r.progress = progress; r.d.fetch = deferred(); return r.d.fetch.promise },
    }),
    verify: () => { r.verifies += 1; if (autoVerify) return Promise.resolve(null); r.d.verify = deferred(); return r.d.verify.promise },
    // electron-updater's hand-over: its local address, then Squirrel.Mac's feed address.
    handOver: (file) => {
      r.handOvers += 1; r.order.push('handOver'); r.handedFile = file
      if (holdHandOver) { r.d.handOver = deferred(); return r.d.handOver.promise.then(() => r.native.setFeedURL()) }
      r.native.setFeedURL(); return Promise.resolve()
    },
    native: () => { r.nativeAccess += 1; return r.native },
    // The app's own close route for every window: a guard (the editor's "Stay here") may keep one open.
    closeWindows: () => {
      r.closes += 1; r.order.push('closeWindows')
      if (app) return app.rw.closeWindows()
      if (r.closeFails === 'throws') throw new Error('the window list is gone')
      if (r.closeFails === 'rejects') return Promise.reject(new Error('a close failed'))
      if (holdClose) { r.d.close = deferred(); return r.d.close.promise }
      r.windows = r.keptOpen
      return Promise.resolve(r.keptOpen === 0)
    },
    openWindows: () => { r.order.push('openWindows'); if (app) return app.rw.openWindows(); if (typeof r.windows !== 'number') throw new Error('the window list is gone'); return r.windows },
    commitAbandoned: () => { r.abandoned += 1; app?.rw.abandoned() },
    // Rule C: the write queues (scripts/test-write-queues.mjs drives the real ones; here the engine's use of them).
    drainWriteQueues: (baseline) => {
      r.order.push('drain')
      if (r.drain) return r.drain(baseline)
      return Promise.resolve(true)
    },
    writeQueuesBusy: () => { r.order.push('busy'); return r.busy ? r.busy() : [] },
    withdrawNative: () => {
      r.withdrawals += 1
      const found = r.armed
      if (r.withdraw === 'throws') return Promise.reject(new Error('launchctl is gone'))
      if (r.withdraw === 'fails') return Promise.resolve({ found: true, gone: false, after: 'unknown' })
      // The check afterwards found the ShipIt job and the install request both still there.
      if (r.withdraw === 'still-armed') return Promise.resolve({ found: true, gone: false, after: 'present' })
      if (r.withdraw === 'hold') { r.d.withdraw = deferred(); return r.d.withdraw.promise }
      r.armed = false
      return Promise.resolve({ found, gone: true, after: 'absent' })
    },
    releaseFiles: () => { r.releases += 1 },
    timers: r.timers,
    now: () => 0,
    changed: () => {},
    log: (m) => r.log.push(m),
  })
  // With stand-in windows (scripts/lib/restart-window-standins.mjs), the fake Squirrel.Mac counts those.
  if (app) Object.defineProperty(r, 'windows', { get: () => app.rw.openWindows(), set: () => {} })
  r.phase = () => r.engine.state().phase
  /** Nothing at all reached Squirrel.Mac or the hand-over. */
  r.untouched = (why) => {
    assert.deepEqual(r.calls, [], `${why}: Squirrel.Mac received no call (no feed address, no check, no listener)`)
    assert.equal(r.handOvers, 0, `${why}: nothing was handed over`)
    assert.equal(r.nativeAccess, 0, `${why}: the native updater was not even asked for`)
    assert.equal(r.armed, false, `${why}: nothing is armed`)
  }
  /** Drive an attempt to a named point. */
  r.to = async (point) => {
    r.started = r.engine.start(OFFER)
    await settle()
    if (point === 'checking') return
    r.d.check.resolve(true); await settle()
    if (point === 'downloading') { r.progress(50, 100); return }
    r.progress(100, 100)
    if (point === 'bytes-in') return
    r.d.fetch.resolve('/cache/TalkWeaver-mac-arm64.zip'); await settle()
    if (point === 'verifying') return
    if (!autoVerify) { r.d.verify.resolve(null); await settle() }
    await r.started
    await settle()
  }
  return r
}

/** The one rule: the native install is called only from quitIfPermitted, with no blocker and a live attempt. */
function onlyThroughTheGate(r) {
  for (const q of r.quits) {
    assert.deepEqual(q.blockers, [], 'the native install is never called while a blocker holds')
    assert.notEqual(q.attempt, null, 'the native install is called only for the live attempt')
    assert.equal(q.phase, 'restarting')
    assert.match(q.from, /quitIfPermitted/, 'the native install is called only from quitIfPermitted')
    assert.equal(q.windows, 0, 'the native install is never called while a window is open')
  }
  for (const i of r.installs) {
    assert.deepEqual(i.blockers, [], 'nothing installs while a blocker holds')
    assert.notEqual(i.attempt, null, 'nothing installs for an attempt that has ended')
  }
}
const D1_POINTS = ['checking', 'downloading', 'bytes-in', 'verifying']
const pointName = (point) => (point === 'bytes-in' ? 'after the bytes are in, before the download resolves' : `while ${point}`)

// ── The happy path ──────────────────────────────────────────────────────────────────────────────

await test('the click with nothing holding: D1 download and check, then (blockers read) the hand-over, (blockers read again) Squirrel.Mac prepares, then the one gate quits and installs', async () => {
  const r = rig()
  await r.to('done')
  assert.equal(r.phase(), 'restarting')
  assert.equal(r.handOvers, 1)
  assert.equal(r.handedFile, '/cache/TalkWeaver-mac-arm64.zip', 'the verified file is the one handed over')
  assert.equal(r.prepares, 1)
  const order = r.order.join(' ')
  assert.match(order, /blockers handOver setFeedURL blockers checkForUpdates$/, 'a blocker check before the hand-over, and another before the native request')
  assert.equal(r.quits.length, 0, 'preparing is not permission to quit')
  assert.equal(r.timers.pending(), 1, 'the watchdog runs')
  r.native.ready()
  await settle()
  assert.equal(r.quits.length, 1)
  onlyThroughTheGate(r)
  assert.equal(r.withdrawals, 0)
})

// ── D1 and D2: nothing native at all ────────────────────────────────────────────────────────────

for (const point of D1_POINTS) {
  await test(`D1 ${pointName(point)}: Squirrel.Mac has received no call at all`, async () => {
    const r = rig({ autoVerify: point !== 'verifying' })
    await r.to(point)
    assert.equal(r.phase(), 'downloading')
    r.untouched(point)
  })
}

await test('D2 (a blocker holds when the download is verified): waiting with the verified file on disk; Squirrel.Mac has received no call; Restart while it holds still none', async () => {
  const r = rig()
  r.blockers = ['presenting']
  await r.to('done')
  assert.equal(r.phase(), 'waiting')
  r.untouched('waiting')
  assert.equal(r.releases, 0, 'the verified file waits on disk')
  assert.equal(r.engine.restart().phase, 'waiting', 'Restart while it holds does nothing')
  r.untouched('Restart while held')
  assert.equal(r.timers.pending(), 0, 'no watchdog while waiting')
})

await test('a simulated exit in D2 leaves nothing armed: the process ends with no hand-over, no native request and no ShipIt', async () => {
  const r = rig()
  r.blockers = ['recording']
  await r.to('done')
  assert.equal(r.phase(), 'waiting')
  // What an exit, a crash or a forced kill would find: nothing was handed to Squirrel.Mac, so ShipIt was never launched.
  r.untouched('the moment of the exit')
  // A late native event (none can come: nothing was asked) would not install either.
  r.native.emit('update-downloaded')
  assert.equal(r.quits.length, 0)
})

// ── Cancel ──────────────────────────────────────────────────────────────────────────────────────

for (const point of D1_POINTS) {
  await test(`Cancel ${pointName(point)}: idle at once; whatever arrives later is ignored and releases its file; nothing native, ever`, async () => {
    const r = rig({ autoVerify: point !== 'verifying' })
    await r.to(point)
    r.engine.cancel()
    assert.equal(r.phase(), 'idle', 'Cancel changes the state at once')
    if (point !== 'verifying') assert.equal(r.releases, 0, 'files are released once the download has settled, not under it')
    if (point === 'checking') r.d.check.resolve(true)
    if (point === 'downloading' || point === 'bytes-in') { assert.equal(r.tokens[0].cancelled, true, 'the download is cancelled'); r.d.fetch.resolve('/cache/late.zip') }
    if (point === 'verifying') r.d.verify.resolve(null)
    await settle()
    await r.started
    assert.equal(r.phase(), 'idle')
    assert.equal(r.fetches, point === 'checking' ? 0 : 1, 'nothing more is downloaded after Cancel')
    assert.equal(r.releases, 1, 'the late result releases its file')
    r.untouched(`Cancel ${point}`)
    assert.equal(r.withdrawals, 0, 'nothing to withdraw')
    assert.equal(r.engine.restart().phase, 'idle', 'Restart after Cancel does nothing: a new click on Update is needed')
    r.untouched(`Restart after Cancel ${point}`)
  })
}

await test('Cancel while the download fails late (electron-updater rejects with its cancellation): still idle, no failure shown', async () => {
  const r = rig()
  await r.to('downloading')
  r.engine.cancel()
  const e = new Error('cancelled'); e.name = 'CancellationError'
  r.d.fetch.reject(e)
  await settle(); await r.started
  assert.equal(r.phase(), 'idle')
  assert.equal(r.releases, 1)
  r.untouched('cancelled download')
})

await test('Cancel in D2 (waiting): idle, the verified file deleted, nothing native ever existed', async () => {
  const r = rig()
  r.blockers = ['exporting']
  await r.to('done')
  r.engine.cancel()
  assert.equal(r.phase(), 'idle')
  assert.equal(r.releases, 1)
  r.untouched('Cancel while waiting')
  r.blockers = []
  assert.equal(r.engine.restart().phase, 'idle')
  r.untouched('Restart after Cancel')
})

await test('no Cancel once restarting (D3): the person committed; Cancel does nothing', async () => {
  const r = rig()
  await r.to('done')
  assert.equal(r.engine.cancel().phase, 'restarting')
  r.native.ready()
  await settle()
  assert.equal(r.quits.length, 1)
  assert.equal(r.engine.cancel().phase, 'restarting')
  onlyThroughTheGate(r)
})

// ── A blocker at every phase ────────────────────────────────────────────────────────────────────

for (const point of D1_POINTS) {
  await test(`a blocker appearing ${pointName(point)}: the download finishes and waits; nothing native; Restart once clear hands over after a blocker check`, async () => {
    const r = rig({ autoVerify: point !== 'verifying' })
    await r.to(point)
    r.blockers = ['recording']
    if (point === 'checking') { r.d.check.resolve(true); await settle(); r.progress(100, 100) }
    if (point !== 'verifying') { if (point !== 'bytes-in' && point !== 'checking') r.progress(100, 100); r.d.fetch.resolve('/cache/f.zip'); await settle() }
    if (point === 'verifying' || r.d.verify) r.d.verify?.resolve(null)
    await settle(); await r.started
    assert.equal(r.phase(), 'waiting')
    r.untouched(`waiting after a blocker ${point}`)
    r.blockers = []
    r.order.length = 0
    assert.equal(r.engine.restart().phase, 'restarting')
    await settle()
    assert.match(r.order.join(' '), /^blockers handOver setFeedURL blockers checkForUpdates$/, 'Restart: blocker check, hand-over, blocker check, native request')
    r.native.ready()
    await settle()
    assert.equal(r.quits.length, 1)
    onlyThroughTheGate(r)
  })
}

await test('a blocker appearing during the hand-over (before Squirrel.Mac is asked): back to waiting; nothing asked, nothing armed', async () => {
  const r = rig({ holdHandOver: true })
  await r.to('done')
  assert.equal(r.phase(), 'restarting')
  r.blockers = ['presenting']
  r.d.handOver.resolve(); await settle()
  assert.equal(r.phase(), 'waiting')
  assert.equal(r.prepares, 0, 'Squirrel.Mac was not asked')
  assert.equal(r.armed, false)
  assert.equal(r.timers.pending(), 0)
  r.blockers = []
  r.engine.restart()
  r.d.handOver.resolve(); await settle()
  assert.equal(r.prepares, 1)
  r.native.ready()
  await settle()
  assert.equal(r.quits.length, 1)
  onlyThroughTheGate(r)
})

// ── D3's commit: every window closes through the app's own route; the native install only with none open ──

await test('D3 commit: after Squirrel.Mac is ready the blockers are read, every window closes through the app\'s own route, the write queues drain, then (blockers, windows and queues read again in the same turn) the native install, with no window open', async () => {
  const r = rig()
  await r.to('done')
  r.order.length = 0
  r.native.ready()
  await settle()
  assert.equal(r.closes, 1, 'the windows were closed by the app first')
  assert.match(r.order.join(' '), /^blockers closeWindows drain blockers openWindows busy$/, 'blockers, close the windows, drain the write queues, then blockers, windows and queues in the turn of the native call')
  assert.equal(r.quits.length, 1)
  assert.equal(r.quits[0].windows, 0, 'no window was open when the native install was called')
  assert.deepEqual(r.installs.map((i) => i.how), ['at once'], 'Electron installs at once: no window-list observer is left behind')
  assert.equal(r.observing, false)
  onlyThroughTheGate(r)
})

await test('the reported scenario: Restart, a close guard ("Stay here") keeps a window open, presenting starts, the window is closed later: nothing installs; the attempt ends with the checked withdrawal', async () => {
  const r = rig()
  r.keptOpen = 1
  await r.to('done')
  r.native.ready()
  await settle()
  assert.equal(r.quits.length, 0, 'the native install is not called while a window is open')
  assert.equal(r.observing, false, 'so Electron registers no window-list observer')
  assert.equal(r.engine.state().phase, 'reopen')
  assert.equal(r.engine.state().cause, 'held')
  assert.equal(r.withdrawals, 1, 'what Squirrel.Mac armed is withdrawn and checked')
  assert.equal(r.engine.state().pending, false, 'checked: quit and reopen')
  assert.equal(r.abandoned, 1, 'the app is told the restart is off (it gives the person a window back)')
  r.blockers = ['presenting']
  r.closeTheRest()
  assert.deepEqual(r.installs, [], 'closing the last window later installs nothing')
  onlyThroughTheGate(r)
})

await test('a close that fails or throws ends the attempt as held, withdrawn and checked; nothing installs', async () => {
  for (const how of ['throws', 'rejects']) {
    const r = rig()
    await r.to('done')
    r.closeFails = how
    r.native.ready()
    await settle()
    assert.equal(r.quits.length, 0, how)
    assert.equal(r.engine.state().phase, 'reopen', how)
    assert.equal(r.engine.state().cause, 'held', how)
    assert.equal(r.withdrawals, 1, how)
    assert.equal(r.installs.length, 0, how)
  }
})

await test('the watchdog while the windows are closing: held, withdrawn; a close that finishes afterwards installs nothing', async () => {
  const r = rig({ holdClose: true })
  await r.to('done')
  r.native.ready()
  await settle()
  assert.equal(r.closes, 1)
  r.timers.advance(RESTART_WATCHDOG_MS)
  await settle()
  assert.equal(r.engine.state().phase, 'reopen')
  assert.equal(r.engine.state().cause, 'held')
  assert.equal(r.abandoned, 1)
  r.windows = 0
  r.d.close.resolve(true); await settle()
  assert.equal(r.quits.length, 0, 'the late close does not reach the native install')
  assert.equal(r.installs.length, 0)
})

await test('the watchdog while the windows are closing, with the windows themselves: the editor waiting on its sheet stays usable; a close that lands afterwards gets an editor back; nothing installs', async () => {
  for (const late of ['sheet answered', 'window closed anyway']) {
    const app = standInApp({ fallbackMs: 30 })
    const sheet = app.editor({ kind: 'editor whose talk changed on disk', sheet: 'wait' })
    const r = rig({ app })
    await r.to('done')
    r.native.ready()
    await delay(20)
    assert.equal(r.phase(), 'restarting', 'the sheet is up: the close waits for the person')
    r.timers.advance(RESTART_WATCHDOG_MS)
    await settle()
    assert.equal(r.engine.state().phase, 'reopen', late)
    assert.equal(r.engine.state().cause, 'held')
    assert.equal(r.withdrawals, 1, 'withdrawn and checked')
    assert.equal(r.engine.state().pending, false)
    if (late === 'sheet answered') sheet.answerSheet('keep')
    else sheet.finish()
    await delay(30)
    assert.equal(app.editors().length, 1, `${late}: an editor is open at the end`)
    if (late === 'sheet answered') assert.equal(sheet.gone, false, 'its late confirmation did not close it')
    else assert.equal(app.opened, 1, 'the window closed after the restart was off: an editor was opened again')
    assert.equal(r.quits.length, 0)
    assert.equal(r.installs.length, 0)
  }
})

for (const blocker of ['presenting', 'recording', 'live', 'exporting', 'publishing', 'sharing', 'unsaved', 'tools', 'settings', 'capture', 'window']) {
  await test(`a blocker that begins while the windows close (${blocker}): re-read in the turn of the native call; nothing installs`, async () => {
    const r = rig({ holdClose: true })
    await r.to('done')
    r.native.ready()
    await settle()
    r.blockers = [blocker]
    r.windows = 0
    r.d.close.resolve(true); await settle()
    assert.equal(r.quits.length, 0)
    assert.equal(r.installs.length, 0)
    assert.equal(r.engine.state().phase, 'reopen')
    assert.equal(r.engine.state().cause, 'held')
    assert.equal(r.abandoned, 1)
  })
}

await test('a window open again when the closing has finished (opened meanwhile, or a count that cannot be read): nothing installs', async () => {
  for (const windows of [1, 'unreadable']) {
    const r = rig({ holdClose: true })
    await r.to('done')
    r.native.ready()
    await settle()
    r.windows = windows
    r.d.close.resolve(true); await settle()
    assert.equal(r.quits.length, 0, String(windows))
    assert.equal(r.engine.state().phase, 'reopen', String(windows))
  }
})

await test('the close route says a window was kept even though the count already reads none (a window being torn down): its answer stands; nothing installs', async () => {
  const r = rig({ holdClose: true })
  await r.to('done')
  r.native.ready()
  await settle()
  r.windows = 0
  r.d.close.resolve(false); await settle()
  assert.equal(r.quits.length, 0)
  assert.equal(r.engine.state().phase, 'reopen')
  assert.equal(r.abandoned, 1)
})

await test('a blocker already holding when Squirrel.Mac says ready: no window is closed at all', async () => {
  const r = rig()
  await r.to('done')
  r.blockers = ['unsaved']
  r.native.ready()
  await settle()
  assert.equal(r.closes, 0, 'the person\'s windows are left alone')
  assert.equal(r.quits.length, 0)
  assert.equal(r.abandoned, 0, 'nothing was stopped, so nothing to give back')
})

// ── §6, the rule end to end: each row of ADR-0044 §6's window table ─────────────────────────────
// The engine with the real restart-windows module (src/main/restart-windows.ts) over stand-ins of each kind of window
// (scripts/lib/restart-window-standins.mjs). The rule: a restart for an update goes ahead only when the only open
// windows were frozen editors that each confirmed the save of their current revision, every other window was already
// closed by the person, every main-process write queue has drained, and every blocker is clear in the same tick as
// the native call. Anything else calls it off, withdraws the update, checks the withdrawal, and leaves an editor open.

/** Squirrel.Mac says ready; the windows' close routes run (real short timers); the outcome settles. */
async function restartWithWindows(app, ms = 80) {
  const r = rig({ app })
  await r.to('done')
  r.native.ready()
  await delay(ms)
  await settle()
  return r
}
/** Called off: nothing installs, the attempt is "held" with its withdrawal checked, and an editor is open. */
function calledOff(r, app, why) {
  assert.equal(r.quits.length, 0, `${why}: the native install is not called`)
  assert.equal(r.installs.length, 0, `${why}: nothing installs`)
  assert.equal(r.engine.state().phase, 'reopen', why)
  assert.equal(r.engine.state().cause, 'held', why)
  assert.equal(r.withdrawals, 1, `${why}: withdrawn and checked`)
  assert.equal(r.engine.state().pending, false, `${why}: the checked withdrawal says quit and reopen`)
  assert.ok(app.editors().length >= 1, `${why}: an editor is open`)
  onlyThroughTheGate(r)
}

await test('§6 the windows the restart closes (editors, frozen and saved at their revision; hidden helpers): the native install, at once, with no window open', async () => {
  const app = standInApp()
  const editors = [app.editor(), app.editor({ kind: 'separate talk window' }), app.editor({ kind: 'Keep mine on the sheet', sheet: 'keep' }), app.editor({ kind: 'no talk', talk: false })]
  for (const kind of ['thumbnail renderer', 'scratchpad page thumbnail', 'offline page capture', 'embed preview artwork', 'presenter layers source']) app.plain(kind, { hidden: true })
  const r = await restartWithWindows(app)
  assert.equal(r.quits.length, 1)
  assert.equal(r.quits[0].windows, 0, 'zero windows, hidden ones included')
  assert.deepEqual(r.installs.map((i) => i.how), ['at once'])
  for (const w of editors.slice(0, 3)) { assert.equal(w.disk, 'typed text', `${w.kind}: its save completed before it closed`); assert.equal(w.frozenSeen, true, `${w.kind}: frozen`) }
  onlyThroughTheGate(r)
})

for (const [kind, blocker] of [['Tools', 'tools'], ['Settings', 'settings'], ['Capture embed', 'capture'], ['audience window a presenter opened', 'presenting'], ['board window', 'presenting'], ['a window of no known kind', 'window']]) {
  await test(`§6 rule A: ${kind} open when Squirrel.Mac says ready: no window is closed, nothing installs, the person reads why (${blocker})`, async () => {
    const app = standInApp()
    const editor = app.editor()
    const r = rig({ app })
    await r.to('done')
    const other = app.plain(kind, { blocker }) // opened while Squirrel.Mac prepared the update
    r.native.ready()
    await delay(80); await settle()
    assert.equal(r.quits.length, 0)
    assert.equal(r.installs.length, 0)
    assert.equal(r.closes, 0, 'the engine did not even start closing: the blocker was read first')
    assert.equal(other.closeCalls + editor.closeCalls, 0, 'nothing was closed')
    assert.equal(r.engine.state().phase, 'reopen')
    assert.equal(r.engine.state().cause, 'held')
    assert.equal(r.withdrawals, 1, 'withdrawn and checked')
  })
}

await test('§6 rule A, Restart pressed with Tools open: the download waits ("Close the Tools window to restart."); nothing is handed to Squirrel.Mac', async () => {
  const app = standInApp()
  app.editor()
  const tools = app.plain('Tools', { blocker: 'tools' })
  const r = rig({ app })
  await r.to('done')
  assert.equal(r.phase(), 'waiting')
  r.untouched('Tools open')
  r.engine.restart()
  await settle()
  assert.equal(r.phase(), 'waiting', 'Restart while Tools is open does nothing')
  r.untouched('Restart pressed with Tools open')
  tools.finish()
  r.engine.restart()
  await settle()
  assert.equal(r.phase(), 'restarting', 'once Tools is closed, Restart goes ahead')
})

for (const [row, make] of [
  ['slow save (longer than the five-second fallback)', (app) => app.editor({ saveMs: 120 })],
  ['failed save', (app) => app.editor({ save: 'fails' })],
  ['failed save whose recovery copy cannot be written', (app) => app.editor({ save: 'fails', recovery: 'fails' })],
  ['unresponsive renderer', (app) => app.editor({ save: 'hung' })],
  ['"Stay here" on the changed-on-disk sheet', (app) => app.editor({ sheet: 'stay' })],
]) {
  await test(`§6 ${row}: the editor stays open with its work, unfrozen; the restart is off, withdrawn and checked`, async () => {
    const app = standInApp({ fallbackMs: 30 })
    const editor = make(app)
    const r = await restartWithWindows(app)
    calledOff(r, app, row)
    assert.equal(editor.gone, false, `${row}: the editor's own window is the one left open`)
    assert.equal(editor.text, 'typed text', `${row}: its text is still there`)
    assert.equal(editor.frozen, false, `${row}: unfrozen`)
    assert.equal(app.opened, 0, `${row}: no new editor was needed`)
    await delay(150)
    assert.equal(editor.gone, false, `${row}: still open after its save (if any) finished`)
    if (row.startsWith('slow')) assert.equal(editor.disk, 'typed text', 'the slow save completed')
  })
}

await test('§6 REPRODUCTION (round two, finding 1): SECOND_EDIT typed during the restart\'s save of FIRST_EDIT is refused; the install is called with nothing unsaved; the code before this round lost it', async () => {
  for (const before of [false, true]) {
    const app = standInApp(before ? { fallbackMs: 400, freeze: false, settle: false, revisions: false } : { fallbackMs: 400 })
    const editor = app.editor({ saveMs: 30, duringSave: (w) => w.type(' SECOND_EDIT') })
    editor.type(' FIRST_EDIT')
    const r = await restartWithWindows(app, 150)
    assert.equal(r.quits.length, 1, 'the restart went ahead')
    assert.equal(r.quits[0].windows, 0)
    if (before) {
      assert.notEqual(editor.closedText, editor.disk, 'before: the window closed holding SECOND_EDIT, which is not on disk')
    } else {
      assert.deepEqual(editor.refused, [' SECOND_EDIT'], 'the keystroke was refused')
      assert.equal(editor.closedText, editor.disk, 'everything the editor held is on disk')
    }
  }
})

await test('§6 a late close after the restart was called off: the close still in flight lands later, and an editor is opened again', async () => {
  const app = standInApp()
  const editor = app.editor({ talk: false })
  editor.close = () => { editor.closeCalls += 1; app.rw.saved(editor.id); setTimeout(editor.finish, 60) }
  app.editor({ sheet: 'stay' }).close = function () { this.closeCalls += 1; setImmediate(() => { app.rw.kept(this.id); this.finish() }) }
  const r = await restartWithWindows(app, 20)
  assert.equal(r.engine.state().phase, 'reopen')
  assert.equal(editor.gone, false, 'the editor\'s close is still in flight when the restart is called off')
  await delay(80)
  assert.equal(editor.gone, true)
  calledOff(r, app, 'late close')
  assert.equal(app.opened, 1, 'an editor was opened again after the late close landed')
})

await test('§6 a window the person can see opens while the editors close: the restart is off; it is left open; an editor is opened again', async () => {
  const app = standInApp()
  let seen = null
  const e = app.editor({ talk: false })
  const close = e.close
  e.close = () => { close(); seen = app.plain('a new window, opened meanwhile') }
  const r = await restartWithWindows(app)
  calledOff(r, app, 'window opened meanwhile')
  assert.equal(seen.gone, false)
  assert.equal(app.opened, 1)
})

await test('§6 a hidden helper opened again while the others close is closed in a further round; then the install, with no window open', async () => {
  const app = standInApp()
  let again = null
  app.editor()
  app.plain('thumbnail renderer', { hidden: true, route: (w) => { setImmediate(w.finish); if (!again) setImmediate(() => { again = app.plain('thumbnail renderer again', { hidden: true }) }) } })
  const r = await restartWithWindows(app)
  assert.equal(again.gone, true)
  assert.equal(r.quits.length, 1)
  assert.equal(r.quits[0].windows, 0)
})

await test('§6 a close that throws, and a window that closes without saying its work is safe (its renderer crashed): the restart is off; an editor is opened again', async () => {
  for (const how of ['throws', 'crashed']) {
    const app = standInApp()
    if (how === 'throws') { const e = app.editor(); e.close = () => { throw new Error('the window is being destroyed') } }
    else { const e = app.editor({ save: 'hung' }); const close = e.close; e.close = () => { close(); setImmediate(e.finish) } }
    const r = await restartWithWindows(app)
    calledOff(r, app, how)
    assert.equal(app.opened, how === 'throws' ? 0 : 1, how === 'throws' ? 'the editor whose close threw is still open' : 'its window had gone: an editor is opened again')
  }
})

// ── Rule C: the main-process write queues drain before the native call ─────────────────────────
for (const [how, drain] of [
  ['a write failed', () => Promise.resolve(false)],
  ['the drain threw', () => Promise.reject(new Error('the settings store is gone'))],
  ['the drain timed out', () => new Promise((resolve) => setTimeout(() => resolve(false), 10))],
]) {
  await test(`rule C, ${how}: the restart is off, withdrawn and checked, and an editor opened again`, async () => {
    const app = standInApp()
    app.editor()
    const r = rig({ app })
    r.drain = drain
    await r.to('done')
    r.native.ready()
    await delay(80); await settle()
    assert.ok(r.order.includes('drain'), 'the queues were waited for after the windows closed')
    calledOff(r, app, how)
    assert.equal(app.opened, 1, 'the editors had closed: one is opened again')
  })
}

await test('rule C: a write that starts again after the drain is caught in the turn of the native call; nothing installs', async () => {
  const app = standInApp()
  app.editor()
  const r = rig({ app })
  r.busy = () => ['settings-overlay']
  await r.to('done')
  r.native.ready()
  await delay(80); await settle()
  calledOff(r, app, 'busy at the native call')
})

await test('rule C: the drain is waited for; the native call comes only after it answers', async () => {
  const app = standInApp()
  app.editor()
  const r = rig({ app })
  let finish
  r.drain = () => new Promise((resolve) => { finish = resolve })
  await r.to('done')
  r.native.ready()
  await delay(80); await settle()
  assert.equal(r.quits.length, 0, 'still draining: no native call')
  finish(true)
  await settle()
  assert.equal(r.quits.length, 1)
  assert.equal(r.quits[0].windows, 0)
})

await test('rule C, REPRODUCTION (round two, finding 3): a preference write still pending when Squirrel.Mac says ready is on disk before the native install; the install is not called while it is pending', async () => {
  const events = []
  const settings = {}
  // The settings store, slow to answer (as when its file lock is held): the overlay's queue waits for it.
  const store = {
    view: () => ({ settings: { ...settings } }),
    set: (key, value) => new Promise((resolve) => setTimeout(() => { settings[key] = value; events.push(`stored ${key}`); resolve({ ok: true }) }, 60)),
    reset: (key) => new Promise((resolve) => setTimeout(() => { delete settings[key]; resolve({ ok: true }) }, 60)),
  }
  const overlay = createConfigOverlay({ file: { read: () => ({}), write: () => {} }, store, log: () => {} })
  const app = standInApp()
  app.editor()
  const r = rig({ app })
  r.drain = () => drainWriteQueues(2_000).then((o) => o.ok)
  r.busy = () => writeQueuesBusy()
  const quit = r.native.quitAndInstall
  r.native.quitAndInstall = (...args) => { events.push(`install (store: ${JSON.stringify(settings)})`); return quit(...args) }
  await r.to('done')
  overlay.write({ updatesAlphaVersions: true }) // the alpha switch, pressed just before Restart
  assert.deepEqual(writeQueuesBusy(), ['settings-overlay'], 'the write is pending')
  r.native.ready()
  await delay(20); await settle()
  assert.equal(r.quits.length, 0, 'not while the write is pending')
  await delay(120); await settle()
  assert.equal(r.quits.length, 1)
  assert.deepEqual(events, ['stored updates.alphaVersions', 'install (store: {"updates.alphaVersions":true})'], 'the preference was stored first')
})

for (const when of ['while closing', 'after draining']) {
  await test(`rule C: a write failure ${when} is caught from the pre-close baseline at the final gate`, async () => {
    const r = rig({ holdClose: true })
    r.drain = (baseline) => drainWriteQueues(1_000, baseline).then(async (outcome) => {
      if (when === 'after draining') await trackWrite('research', Promise.reject(new Error('late failure'))).catch(() => {})
      return outcome.ok
    })
    r.busy = () => writeQueuesBusy()
    await r.to('done')
    r.native.ready()
    await settle()
    if (when === 'while closing') await trackWrite('research', Promise.reject(new Error('close-time failure'))).catch(() => {})
    r.windows = 0
    r.d.close.resolve(true)
    await settle()
    assert.equal(r.quits.length, 0, 'a settled failed write must not pass as idle and safe')
    assert.equal(r.phase(), 'reopen')
    assert.equal(r.withdrawals, 1)
  })
}

// ── D4: the narrow leftovers ────────────────────────────────────────────────────────────────────

await test('a blocker appearing during D3\'s preparation: the app does not quit; "reopen" pending at once; the withdrawal is checked, then "quit and reopen"; the run is spent', async () => {
  const r = rig()
  r.withdraw = 'hold'
  await r.to('done')
  r.blockers = ['presenting']
  r.native.ready()
  await settle()
  assert.equal(r.quits.length, 0, 'presenting began while Squirrel.Mac was preparing: no quit')
  assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.46.0', cause: 'held', pending: true, armed: false }, 'until the withdrawal is checked, it says the update may install at the next quit')
  assert.equal(r.withdrawals, 1)
  assert.equal(r.timers.pending(), 0)
  r.armed = false
  r.d.withdraw.resolve({ found: true, gone: true, after: 'absent' }); await settle()
  assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.46.0', cause: 'held', pending: false, armed: false }, 'checked: nothing will install; quit and reopen')
  assert.equal(r.releases, 1)
  // Spent: nothing native, no download, until TalkWeaver is reopened.
  r.blockers = []
  const checks = r.checks
  assert.equal((await r.engine.start(OFFER)).phase, 'reopen')
  assert.equal(r.engine.restart().phase, 'reopen')
  assert.equal(r.engine.cancel().phase, 'reopen')
  r.native.emit('update-downloaded')
  assert.equal(r.checks, checks, 'nothing is downloaded')
  assert.equal(r.prepares, 1, 'Squirrel.Mac is not asked again')
  assert.equal(r.quits.length, 0)
})

await test('a withdrawal that fails is reported, not swallowed: the state stays "TalkWeaver may finish updating when it next quits" (never "will" without a check that found it armed)', async () => {
  for (const how of ['fails', 'throws']) {
    const r = rig()
    r.withdraw = how
    await r.to('done')
    r.blockers = ['unsaved']
    r.native.ready()
    await settle()
    assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.46.0', cause: 'held', pending: true, armed: false }, `${how}: still pending, "may"`)
    assert.equal(reopenText(r.engine.state()).title, 'TalkWeaver may finish updating when it next quits', how)
    assert.match(r.log.join('\n'), /withdrawal NOT confirmed \(afterwards: unknown\)/, `${how}: logged`)
    assert.equal(r.quits.length, 0)
  }
})

await test('a withdrawal whose check finds the ShipIt job and the install request still there: "TalkWeaver will finish updating when it next quits"', async () => {
  const r = rig()
  r.withdraw = 'still-armed'
  await r.to('done')
  r.blockers = ['unsaved']
  r.native.ready()
  await settle()
  assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.46.0', cause: 'held', pending: true, armed: true })
  assert.equal(reopenText(r.engine.state()).title, 'TalkWeaver will finish updating when it next quits')
})

await test('a withdrawal that says gone but cannot say absent is not taken as gone', async () => {
  const r = rig()
  r.withdraw = 'hold'
  await r.to('done')
  r.blockers = ['unsaved']
  r.native.ready()
  await settle()
  r.d.withdraw.resolve({ found: true, gone: true, after: 'unknown' }); await settle()
  assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.46.0', cause: 'held', pending: true, armed: false })
})

await test('a blocker read that fails holds the restart (fail closed): before the hand-over → waiting; at the gate → reopen', async () => {
  const before = rig()
  before.blockers = { [Symbol.iterator]() { throw new Error('the window list is gone') } }
  await before.to('done')
  assert.equal(before.phase(), 'waiting')
  before.untouched('a failed blocker read')
  const atGate = rig()
  await atGate.to('done')
  atGate.blockers = { [Symbol.iterator]() { throw new Error('the window list is gone') } }
  atGate.native.ready()
  await settle()
  assert.equal(atGate.quits.length, 0)
  assert.equal(atGate.phase(), 'reopen')
})

await test('the watchdog in D3 with no answer: "may finish when it next quits" (pending, even after a clean check: Squirrel.Mac may still arm); its late answer never installs and a clean check then says "reopen"', async () => {
  const r = rig()
  await r.to('done')
  r.timers.advance(RESTART_WATCHDOG_MS - 1)
  assert.equal(r.phase(), 'restarting')
  r.timers.advance(1)
  await settle()
  assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.46.0', cause: 'no-answer', pending: true, armed: false })
  assert.equal(r.withdrawals, 1, 'withdrawn and checked at once')
  assert.equal(r.releases, 1)
  r.native.ready() // Squirrel.Mac arms ShipIt late
  await settle()
  assert.equal(r.quits.length, 0, 'a native answer after the watchdog never installs')
  assert.equal(r.withdrawals, 2, 'what it armed late is withdrawn')
  assert.equal(r.armed, false)
  assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.46.0', cause: 'no-answer', pending: false, armed: false })
  assert.equal(r.engine.restart().phase, 'reopen', 'Restart cannot revive it')
})

await test('the watchdog in D3, then a late answer whose withdrawal fails: stays pending', async () => {
  const r = rig()
  await r.to('done')
  r.timers.advance(RESTART_WATCHDOG_MS)
  await settle()
  r.withdraw = 'fails'
  r.native.ready()
  await settle()
  assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.46.0', cause: 'no-answer', pending: true, armed: false })
})

await test('the watchdog during the hand-over itself (Squirrel.Mac never asked): failed; the late hand-over asks nothing', async () => {
  const r = rig({ holdHandOver: true })
  await r.to('done')
  r.timers.advance(RESTART_WATCHDOG_MS)
  assert.deepEqual(r.engine.state(), { phase: 'failed', version: '0.46.0', reason: 'other' })
  r.d.handOver.resolve(); await settle()
  assert.equal(r.prepares, 0)
})

await test('a failed install after the native install was called: "may finish when it next quits", then the checked withdrawal', async () => {
  const r = rig()
  await r.to('done')
  r.native.ready()
  await settle()
  assert.equal(r.quits.length, 1)
  r.native.emit('error', new Error('Code signature at URL file:///x did not pass validation'))
  assert.equal(r.engine.state().phase, 'reopen')
  assert.equal(r.engine.state().cause, 'install-failed')
  await settle()
  assert.equal(r.engine.state().pending, false)
  onlyThroughTheGate(r)
})

await test('Squirrel.Mac refusing the new app in D3 (before it arms anything): failed with the reason; checked; Try again may use Squirrel.Mac again', async () => {
  const r = rig()
  await r.to('done')
  r.native.emit('error', new Error('Code signature at URL file:///x did not pass validation: code failed to satisfy specified code requirement(s)'))
  await settle()
  assert.equal(r.withdrawals, 1, 'checked that nothing is armed')
  assert.equal(r.engine.state().phase, 'failed')
  assert.equal(r.engine.state().reason, 'signature')
  const again = r.engine.start(OFFER)
  await settle(); r.d.check.resolve(true); await settle(); r.d.fetch.resolve('/f.zip'); await settle(); await again; await settle()
  assert.equal(r.prepares, 2, 'nothing was armed, so Squirrel.Mac may be asked again')
  r.native.ready()
  await settle()
  assert.equal(r.quits.length, 1)
  onlyThroughTheGate(r)
})

await test('Squirrel.Mac refusing, but the check finds something armed it cannot remove: the person reads that it may install at the next quit', async () => {
  const r = rig()
  await r.to('done')
  r.withdraw = 'fails'
  r.native.emit('error', new Error('something odd'))
  await settle()
  assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.46.0', cause: 'install-failed', pending: true, armed: false })
})

// ── The spent flag, re-read before any native request (the reviewer's follow-up) ─────────────────

await test('Squirrel.Mac refusing while its check is still running: "restarting" (no Try again) until the check answers; Update meanwhile starts nothing', async () => {
  const r = rig()
  r.withdraw = 'hold'
  await r.to('done')
  r.native.emit('error', new Error('something odd'))
  await settle()
  assert.equal(r.phase(), 'restarting', 'the outcome is not shown until the check has answered')
  const checks = r.checks
  assert.equal((await r.engine.start(OFFER)).phase, 'restarting', 'Update while the check runs does nothing')
  assert.equal(r.checks, checks, 'nothing is downloaded')
  // The check answers: something was armed and it is gone. The run is spent: Try again says reopen, asks nothing.
  r.d.withdraw.resolve({ found: true, gone: true, after: 'absent' }); await settle()
  assert.deepEqual(r.engine.state(), { phase: 'failed', version: '0.46.0', reason: 'other' })
  assert.deepEqual(await r.engine.start(OFFER), { phase: 'failed', version: '0.46.0', reason: 'reopen' })
  assert.equal(r.checks, checks)
  assert.equal(r.prepares, 1, 'no second native request in a spent run')
  assert.equal(r.quits.length, 0)
})

await test('the reported race: a Try again pressed while a refused preparation\'s check runs, then the check is NOT confirmed: the person still reads that the update may install at the next quit', async () => {
  const r = rig()
  r.withdraw = 'hold'
  await r.to('done')
  r.native.emit('error', new Error('something odd'))
  await settle()
  const first = r.d.withdraw
  // Try again at once. Before the fix this started a new download and the unconfirmed check below was ignored.
  const again = r.engine.start(OFFER)
  await settle()
  if (r.d.check && r.checks > 1) { r.d.check.resolve(true); await settle(); r.d.fetch.resolve('/f.zip'); await settle() }
  await again; await settle()
  first.resolve({ found: true, gone: false, after: 'unknown' }); await settle()
  // A later attempt, if one had started, must not hide it either.
  r.d.handOver?.resolve?.(); await settle()
  assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.46.0', cause: 'install-failed', pending: true, armed: false })
  assert.equal(r.quits.length, 0)
})

await test('an unconfirmed withdrawal is kept apart from the attempt: whatever is shown later never drops "may install at the next quit" until a clean check', async () => {
  const r = rig()
  await r.to('done')
  r.windows = 2
  r.timers.advance(RESTART_WATCHDOG_MS) // no answer: reopen, pending; its check is clean but Squirrel.Mac may still arm
  await settle()
  assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.46.0', cause: 'no-answer', pending: true, armed: false })
  r.withdraw = 'fails'
  r.native.ready() // armed late; its withdrawal is not confirmed
  await settle()
  assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.46.0', cause: 'no-answer', pending: true, armed: false })
  r.engine.reset() // the offer changed meanwhile: reset only acts on a failed attempt
  assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.46.0', cause: 'no-answer', pending: true, armed: false })
  assert.equal(r.installs.length, 0)
})

// ── Clicks during an attempt, a new attempt after an old one ────────────────────────────────────

await test('a second click during an attempt does nothing; Try again after a failure starts a new attempt', async () => {
  const r = rig()
  await r.to('downloading')
  await r.engine.start(OFFER).then((s) => assert.equal(s.phase, 'downloading'))
  assert.equal(r.checks, 1)
  r.d.fetch.reject(new Error('net::ERR_CONNECTION_RESET'))
  await settle(); await r.started
  assert.deepEqual(r.engine.state(), { phase: 'failed', version: '0.46.0', reason: 'network' })
  assert.equal(r.releases, 1)
  r.untouched('a failed download')
  const again = r.engine.start(OFFER)
  await settle()
  assert.equal(r.checks, 2)
  r.d.check.resolve(true); await settle()
  r.d.fetch.resolve('/f.zip'); await settle(); await again; await settle()
  assert.equal(r.phase(), 'restarting')
  assert.equal(await r.engine.start(OFFER).then((s) => s.phase), 'restarting', 'a click while restarting does nothing')
  assert.equal(r.handOvers, 1)
})

await test('Update straight after Cancel waits for the cancelled download to settle (they never share electron-updater)', async () => {
  const r = rig()
  await r.to('downloading')
  const first = r.d.fetch
  r.engine.cancel()
  const second = r.engine.start(OFFER)
  await settle()
  assert.equal(r.checks, 1, 'the new attempt has not asked yet')
  first.resolve('/late.zip')
  await settle()
  assert.equal(r.releases, 1, 'the old file was released first')
  assert.equal(r.checks, 2, 'then the new attempt starts')
  r.d.check.resolve(true); await settle(); r.d.fetch.resolve('/f.zip'); await settle(); await second; await settle()
  assert.equal(r.phase(), 'restarting')
  assert.equal(r.handedFile, '/f.zip', 'the new attempt\'s file is the one handed over')
  r.native.ready()
  await settle()
  assert.equal(r.quits.length, 1)
  onlyThroughTheGate(r)
})

await test('a download that is not the version offered: failed "wrong-version", never handed to Squirrel.Mac', async () => {
  const r = rig({ autoVerify: false })
  await r.to('verifying')
  r.d.verify.resolve('wrong-version')
  await settle(); await r.started
  assert.deepEqual(r.engine.state(), { phase: 'failed', version: '0.46.0', reason: 'wrong-version' })
  r.untouched('a refused file')
})

// ── Refused before anything happens ─────────────────────────────────────────────────────────────

await test('Windows: no in-place update in this release; refused before any download, whatever the gate says', async () => {
  const r = rig({ platform: 'win32' })
  const s = await r.engine.start(OFFER)
  assert.equal(s.phase, 'idle')
  assert.equal(r.checks + r.fetches + r.prepares + r.handOvers, 0)
  assert.match(r.log.join('\n'), /no in-place update on win32/)
})

await test('a Store copy and a protected task are refused at the engine, before any download', async () => {
  const facts = (source) => ({ platform: 'darwin', arch: 'arm64', source, file: { url: OFFER.url, sha512: 'x', size: 1 }, appPath: '/Applications/TalkWeaver.app', writable: true, writeError: null, bundleId: 'com.techczech.talkweaver' })
  for (const [why, gate] of [['store', () => inPlaceRefusal(facts('store'))], ['development', () => inPlaceRefusal(facts('development'))], ['protected', () => 'a protected task is active']]) {
    const r = rig({ gate })
    const s = await r.engine.start(OFFER)
    assert.equal(s.phase, 'idle', why)
    assert.equal(r.checks + r.fetches, 0, `${why}: nothing is asked or downloaded`)
    r.untouched(why)
  }
  // And a website copy passes the same gate.
  assert.equal(inPlaceRefusal(facts('website')), null)
})

// ── The real electron-updater: its hand-over deferred, its own route to the native install closed ─

function fakeApp(dir) {
  return {
    version: '0.45.0', name: 'TalkWeaver', isPackaged: true, appUpdateConfigPath: join(dir, 'app-update.yml'), userDataPath: dir, baseCachePath: dir,
    whenReady: () => Promise.resolve(), quit: () => { throw new Error('the app must not quit') }, relaunch: () => {}, onQuit: () => {},
  }
}

await test('control: an unclosed MacUpdater does reach the native install by itself (what the reviewer found)', async () => {
  const r = { blockers: ['presenting'], quits: [], prepares: 0, calls: [], windows: 0, installs: [], install: () => {}, engine: { attemptId: () => null, state: () => ({ phase: 'waiting' }) } }
  fakeElectron.autoUpdater = fakeNative(r)
  const dir = mkdtempSync(join(tmpdir(), 'tw-engine-control-'))
  try {
    const u = new MacUpdater(undefined, fakeApp(dir))
    u.logger = null
    u.autoInstallOnAppQuit = false
    u.quitAndInstall()
    fakeElectron.autoUpdater.emit('update-downloaded')
    assert.equal(r.quits.length, 1, 'the dependency\'s own listener calls the native install while a blocker holds')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test('control: an unclosed MacUpdater sets the native feed address as soon as a download finishes (what D1 must not do)', async () => {
  const r = { blockers: [], quits: [], prepares: 0, calls: [] }
  fakeElectron.autoUpdater = fakeNative(r)
  const dir = mkdtempSync(join(tmpdir(), 'tw-engine-control2-'))
  const file = join(dir, 'f.zip'); writeFileSync(file, Buffer.alloc(10, 1))
  try {
    const u = new MacUpdater(undefined, fakeApp(dir))
    u.logger = null
    u.autoInstallOnAppQuit = false
    await u.updateDownloaded({ url: new URL(OFFER.url), info: { url: OFFER.url, sha512: 'x', size: 10 } }, { downloadedFile: file, version: OFFER.version })
    assert.ok(r.calls.includes('setFeedURL'), 'the dependency hands the file to Squirrel.Mac at download time by itself')
    u.closeServerIfExists()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

/** The real MacUpdater, closed by closeDependencyInstallPath, behind the real engine; its download stubbed (no network). */
async function realRig(dir) {
  const r = { blockers: [], quits: [], prepares: 0, calls: [], withdrawn: 0, windows: 1, keptOpen: 0, installs: [] }
  r.install = (how) => r.installs.push({ how, blockers: [...r.blockers], attempt: r.engine.attemptId(), phase: r.engine.state().phase })
  fakeElectron.autoUpdater = fakeNative(r)
  const file = join(dir, 'TalkWeaver-mac-arm64.zip')
  writeFileSync(file, Buffer.alloc(100, 7))
  r.refusals = []
  const u = new MacUpdater(undefined, fakeApp(dir))
  u.logger = null
  const closed = closeDependencyInstallPath(u, (m) => r.refusals.push(m))
  u.checkForUpdates = async () => ({ isUpdateAvailable: true })
  // electron-updater's download ends, as the real one does, by calling its own updateDownloaded().
  u.downloadUpdate = async () => {
    await u.updateDownloaded({ url: new URL(OFFER.url), info: { url: OFFER.url, sha512: 'x', size: 100 } }, { downloadedFile: file, version: OFFER.version })
    return []
  }
  r.u = u
  r.engine = createUpdateEngine({
    platform: 'darwin', gate: () => null, blockers: () => [...r.blockers],
    downloader: () => dependencyDownload(u, () => {}),
    verify: async (f) => (f === file ? null : 'other'),
    handOver: (f) => closed.handOver(f),
    native: () => u.nativeUpdater,
    closeWindows: async () => { r.windows = 0; return true },
    openWindows: () => r.windows,
    drainWriteQueues: async () => true,
    writeQueuesBusy: () => [],
    withdrawNative: async () => { r.withdrawn += 1; return { found: true, gone: true, after: 'absent' } },
    releaseFiles: () => { u.closeServerIfExists() },
    timers: fakeTimers(), // the restart watchdog must not keep this process alive
    changed: () => {}, log: () => {},
  })
  return r
}

await test('the real MacUpdater: D1 and D2 make no call on Squirrel.Mac (no feed address, no check) and open no local address; Restart hands over, then prepares; a blocker at the gate does not quit; its own methods refuse', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-engine-real-'))
  try {
    const r = await realRig(dir)
    const u = r.u
    const constructorListeners = [...r.calls]
    assert.equal(u.nativeUpdater, fakeElectron.autoUpdater)
    r.blockers = ['recording']
    await r.engine.start(OFFER)
    assert.equal(r.engine.state().phase, 'waiting')
    assert.deepEqual(r.calls, constructorListeners, 'downloaded and verified while a blocker holds: Squirrel.Mac received no setFeedURL, no checkForUpdates')
    assert.equal(u.server, undefined, 'no local address was opened for Squirrel.Mac')
    // Every route the dependency has to the native install refuses.
    u.quitAndInstall()
    u.handleUpdateDownloaded()
    u.nativeUpdater.emit('update-downloaded')
    assert.equal(r.quits.length, 0, 'electron-updater\'s quitAndInstall and handleUpdateDownloaded cannot install')
    assert.equal(r.refusals.length, 2)
    assert.throws(() => { u.quitAndInstall = () => {} }, TypeError, 'and they cannot be put back')
    assert.throws(() => { u.updateDownloaded = async () => [] }, TypeError, 'nor its deferred hand-over')
    assert.deepEqual(r.calls.filter((c) => c === 'setFeedURL' || c === 'checkForUpdates'), [], 'still nothing native')
    // Restart with nothing holding: the hand-over (local address, then the feed address), then the native request.
    r.blockers = []
    r.engine.restart()
    for (let i = 0; i < 50 && r.prepares === 0; i++) await tick()
    const native = r.calls.filter((c) => c === 'setFeedURL' || c === 'checkForUpdates')
    assert.deepEqual(native, ['setFeedURL', 'checkForUpdates'], 'at restart time: feed address, then prepare')
    assert.ok(u.server?.listening, 'the local address is open only now')
    // Presenting starts while Squirrel.Mac is still preparing; then it says it is ready.
    r.blockers = ['presenting']
    u.nativeUpdater.ready()
    await settle()
    assert.equal(r.quits.length, 0, 'the native event while a blocker holds does not quit')
    assert.equal(r.engine.state().phase, 'reopen')
    assert.equal(r.withdrawn, 1, 'and what it armed is withdrawn')
    u.closeServerIfExists()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test('the real MacUpdater: the click with nothing holding hands over, prepares and installs once through the gate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tw-engine-real2-'))
  try {
    const r = await realRig(dir)
    await r.engine.start(OFFER)
    for (let i = 0; i < 50 && r.prepares === 0; i++) await tick()
    assert.equal(r.engine.state().phase, 'restarting')
    assert.equal(r.prepares, 1, 'only the engine asked Squirrel.Mac to prepare (autoInstallOnAppQuit is false)')
    r.u.nativeUpdater.ready()
    await settle()
    assert.equal(r.quits.length, 1)
    onlyThroughTheGate(r)
    r.u.closeServerIfExists()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── The downloaded file: size and the version inside (real zips; macOS) ──────────────────────────

if (process.platform === 'darwin') {
  await test('the downloaded file: the feed\'s size, and inside it the version offered, newer than the running one, with the stated bundle identifier', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-engine-zip-'))
    const zip = (name, version, bundleId, extra = []) => {
      const root = join(dir, `src-${name}`)
      for (const app of [`TalkWeaver.app`, ...extra]) {
        mkdirSync(join(root, app, 'Contents'), { recursive: true })
        writeFileSync(join(root, app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`)
      }
      const out = join(dir, `${name}.zip`)
      if (extra.length) execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', root, out])
      else execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', join(root, 'TalkWeaver.app'), out])
      return { path: out, size: statSync(out).size }
    }
    try {
      const offer = (z, over = {}) => ({ ...OFFER, version: '0.46.0', size: z.size, bundleId: 'com.techczech.talkweaver', ...over })
      const good = zip('good', '0.46.0', 'com.techczech.talkweaver')
      assert.equal(await verifyMacDownload(good.path, offer(good), '0.45.0'), null)
      assert.equal(await verifyMacDownload(good.path, offer(good, { bundleId: undefined }), '0.45.0'), null, 'a stand-in feed without a bundle identifier checks none')
      assert.equal(await verifyMacDownload(good.path, offer(good, { size: good.size + 1 }), '0.45.0'), 'mismatch', 'a size other than the feed\'s is refused')
      const older = zip('older', '0.44.0', 'com.techczech.talkweaver')
      assert.equal(await verifyMacDownload(older.path, offer(older), '0.45.0'), 'wrong-version', 'an older signed build under the new name is refused')
      assert.equal(await verifyMacDownload(good.path, offer(good, { version: '0.47.0' }), '0.45.0'), 'wrong-version', 'not the version offered')
      assert.equal(await verifyMacDownload(good.path, offer(good), '0.46.0'), 'wrong-version', 'not newer than the running version')
      const other = zip('other', '0.46.0', 'net.example.other')
      assert.equal(await verifyMacDownload(other.path, offer(other), '0.45.0'), 'wrong-version', 'another app')
      const two = zip('two', '0.46.0', 'com.techczech.talkweaver', ['Other.app'])
      assert.equal(await verifyMacDownload(two.path, offer(two), '0.45.0'), 'wrong-version', 'two apps in one zip')
      const junk = join(dir, 'junk.zip'); writeFileSync(junk, Buffer.alloc(50, 1))
      assert.equal(await verifyMacDownload(junk, offer({ size: 50 }), '0.45.0'), 'wrong-version', 'not a zip')
      // A real build's zip has the same shape: the release workflow zips with ditto --keepParent.
      assert.match(readFileSync(new URL('../src/main/update-engine.ts', import.meta.url), 'utf8'), /\^\[\^\/\]\+\\\.app\\\/Contents\\\/Info\\\.plist\$/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}

if (failures.length) { console.error(`update engine: ${failures.length} failed, ${passed} passed`); process.exit(1) }
console.log(`update engine: ${passed} checks passed`)
