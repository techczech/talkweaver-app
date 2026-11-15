// Updates in place (ADR-0044): the states of the one click, what holds a restart back, when a copy cannot
// replace itself, how failures are read, and the work a restart waits for (src/shared/update-install.ts,
// src/main/restart-holds.ts). Plain Node, no Electron, no network.
import assert from 'node:assert/strict'
import {
  BLOCKER_TEXT, FAIL_TEXT, IDLE, REFUSAL_TEXT, RESTART_BLOCKERS, blockersSentence, failReasonOf, inPlaceRefusal, installBusy, installMarkText,
  installStep, reopenText, restartBlockers, sizeText, updateFoot,
} from '../src/shared/update-install.ts'
import { createRestartHolds, holdOnChannels } from '../src/main/restart-holds.ts'

let passed = 0
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS  ${name}`) } catch (error) { console.error(`FAIL  ${name}`); throw error }
}

const FILE = { url: 'https://github.com/techczech/talkweaver-app/releases/download/v0.45.0/TalkWeaver-mac-arm64.zip', sha512: 'q'.repeat(86) + '==', size: 288_703_536, bundleId: 'com.techczech.talkweaver' }
const facts = (over = {}) => ({
  platform: 'darwin', arch: 'arm64', source: 'website', file: FILE, appPath: '/Applications/TalkWeaver.app',
  writable: true, writeError: null, bundleId: 'com.techczech.talkweaver', ...over,
})
const NONE = { presentWindows: 0, recording: false, liveSession: false, exporting: false, publishing: false, sharing: false, unsaved: false }

await test('the click: Update → downloading → (no reason to wait) restarting', () => {
  let s = IDLE
  s = installStep(s, { type: 'start', version: '0.45.0', total: 1000 })
  assert.deepEqual(s, { phase: 'downloading', version: '0.45.0', received: 0, total: 1000 })
  s = installStep(s, { type: 'progress', received: 420 })
  assert.equal(s.received, 420)
  assert.equal(installMarkText(s), 'Downloading 0.45.0 · 42%')
  s = installStep(s, { type: 'progress', received: 5000, total: 1000 })
  assert.equal(s.received, 1000, 'progress never passes the total')
  s = installStep(s, { type: 'downloaded', blockers: [] })
  assert.deepEqual(s, { phase: 'restarting', version: '0.45.0' })
  assert.equal(installMarkText(s), 'Restarting into 0.45.0…')
})

await test('every reason not to restart makes the download wait; Restart goes only when none holds', () => {
  for (const blocker of RESTART_BLOCKERS) {
    let s = installStep(installStep(IDLE, { type: 'start', version: '0.45.0', total: 10 }), { type: 'downloaded', blockers: [blocker] })
    assert.deepEqual(s, { phase: 'waiting', version: '0.45.0' }, blocker)
    assert.equal(installMarkText(s), 'Restart to finish updating')
    s = installStep(s, { type: 'restart', blockers: [blocker] })
    assert.equal(s.phase, 'waiting', `${blocker}: pressing Restart while it holds does nothing`)
    s = installStep(s, { type: 'restart', blockers: [] })
    assert.equal(s.phase, 'restarting', `${blocker}: Restart once it is over`)
  }
})

await test('restart blockers: each fact names its reason, in a fixed order', () => {
  assert.deepEqual(restartBlockers(NONE), [])
  const one = {
    presenting: { presentWindows: 1 }, recording: { recording: true }, live: { liveSession: true }, exporting: { exporting: true },
    publishing: { publishing: true }, sharing: { sharing: true }, unsaved: { unsaved: true },
  }
  for (const [blocker, fact] of Object.entries(one)) assert.deepEqual(restartBlockers({ ...NONE, ...fact }), [blocker])
  assert.deepEqual(restartBlockers({ ...NONE, presentWindows: 2, recording: true, unsaved: true }), ['presenting', 'recording', 'unsaved'])
  assert.equal(blockersSentence(['recording']), 'Not now: a recording is in progress.')
  assert.equal(blockersSentence(['recording', 'exporting', 'unsaved']), 'Not now: a recording is in progress, an export is running and a talk has changes that could not be saved yet.')
  assert.equal(blockersSentence([]), '')
  for (const b of RESTART_BLOCKERS) assert.ok(BLOCKER_TEXT[b] && !/[A-Z]/.test(BLOCKER_TEXT[b][0]), `${b} reads inside a sentence`)
})

await test('cancel returns to the offer; failure keeps the version and reason; Try again starts again', () => {
  const downloading = installStep(IDLE, { type: 'start', version: '0.45.0', total: 10 })
  assert.equal(installStep(downloading, { type: 'cancelled' }), IDLE)
  const failed = installStep(downloading, { type: 'failed', reason: 'mismatch' })
  assert.deepEqual(failed, { phase: 'failed', version: '0.45.0', reason: 'mismatch' })
  assert.equal(installMarkText(failed), 'Update to 0.45.0 failed')
  assert.equal(installStep(failed, { type: 'start', version: '0.45.0', total: 10 }).phase, 'downloading', 'Try again')
  // Squirrel.Mac refusing the new app while restarting: failed, the app untouched.
  const restarting = installStep(downloading, { type: 'downloaded', blockers: [] })
  assert.deepEqual(installStep(restarting, { type: 'failed', reason: 'signature' }), { phase: 'failed', version: '0.45.0', reason: 'signature' })
  // A newer offer while failed starts from Update again; while working nothing is reset.
  assert.equal(installStep(failed, { type: 'reset' }), IDLE)
  assert.equal(installStep(downloading, { type: 'reset' }), downloading)
})

await test('events out of turn change nothing', () => {
  const downloading = installStep(IDLE, { type: 'start', version: '0.45.0', total: 10 })
  const waiting = installStep(downloading, { type: 'downloaded', blockers: ['recording'] })
  const restarting = installStep(waiting, { type: 'restart', blockers: [] })
  for (const [name, state, event] of [
    ['a second click while downloading', downloading, { type: 'start', version: '0.46.0', total: 1 }],
    ['a click while waiting', waiting, { type: 'start', version: '0.46.0', total: 1 }],
    ['a click while restarting', restarting, { type: 'start', version: '0.46.0', total: 1 }],
    ['progress while waiting', waiting, { type: 'progress', received: 3 }],
    ['downloaded while idle', IDLE, { type: 'downloaded', blockers: [] }],
    ['restart while idle', IDLE, { type: 'restart', blockers: [] }],
    ['restart while downloading', downloading, { type: 'restart', blockers: [] }],
    ['prepare while idle', IDLE, { type: 'prepare' }],
    ['held while waiting', waiting, { type: 'held' }],
    ['held while downloading', downloading, { type: 'held' }],
    ['failure while idle', IDLE, { type: 'failed', reason: 'network' }],
  ]) assert.equal(installStep(state, event), state, name)
  // Cancel ends an attempt while downloading (D1) and waiting (D2), at once; not once restarting (D3).
  for (const s of [downloading, waiting]) assert.equal(installStep(s, { type: 'cancelled' }), IDLE, s.phase)
  assert.equal(installStep(restarting, { type: 'cancelled' }), restarting, 'no Cancel once restarting')
  // Restarting now from downloading or waiting; held back to waiting from restarting (before macOS was asked).
  assert.deepEqual(installStep(downloading, { type: 'prepare' }), { phase: 'restarting', version: '0.45.0' })
  assert.deepEqual(installStep(waiting, { type: 'prepare' }), { phase: 'restarting', version: '0.45.0' })
  assert.deepEqual(installStep(restarting, { type: 'held' }), { phase: 'waiting', version: '0.45.0' })
  // D4: only from restarting, and pending until a withdrawal has been checked.
  const reopen = installStep(restarting, { type: 'leftover', cause: 'held' })
  assert.deepEqual(reopen, { phase: 'reopen', version: '0.45.0', cause: 'held', pending: true })
  for (const s of [IDLE, downloading, waiting]) assert.equal(installStep(s, { type: 'leftover', cause: 'held' }), s, `leftover from ${s.phase}`)
  for (const event of [{ type: 'start', version: '0.46.0', total: 1 }, { type: 'cancelled' }, { type: 'reset' }, { type: 'prepare' }, { type: 'restart', blockers: [] }, { type: 'failed', reason: 'other' }]) {
    assert.equal(installStep(reopen, event), reopen, `${event.type} while reopen: nothing more in this run`)
  }
  assert.equal(installBusy(IDLE), false)
  assert.ok(installBusy(downloading) && installBusy(waiting) && installBusy(restarting) && installBusy(reopen))
})

await test('the words for a restart that did not happen (D4): never "nothing is installed" unless checked', () => {
  const v = '0.45.0'
  const checked = reopenText({ version: v, cause: 'held', pending: false })
  assert.equal(checked.mark, 'Reopen TalkWeaver to update')
  assert.equal(checked.title, 'Quit and reopen TalkWeaver to update')
  assert.match(checked.detail, /Nothing is installed when it quits\. Quit and reopen TalkWeaver, then press Update again\.$/)
  const will = reopenText({ version: v, cause: 'held', pending: true })
  assert.equal(will.title, 'TalkWeaver will finish updating when it next quits')
  assert.match(will.detail, /installs it when you next quit TalkWeaver/)
  for (const cause of ['no-answer', 'install-failed']) {
    const may = reopenText({ version: v, cause, pending: true })
    assert.equal(may.title, 'TalkWeaver may finish updating when it next quits', cause)
    assert.match(may.mark, /may install when TalkWeaver quits/)
  }
  for (const cause of ['held', 'no-answer', 'install-failed']) {
    assert.doesNotMatch(reopenText({ version: v, cause, pending: true }).detail, /Nothing is installed/, `${cause} pending never says nothing installs`)
  }
  assert.equal(installMarkText({ phase: 'reopen', version: v, cause: 'held', pending: false }), 'Reopen TalkWeaver to update')
})

await test('failures are read in plain words', () => {
  const table = [
    [{ code: 'ERR_CHECKSUM_MISMATCH', message: 'sha512 checksum mismatch, expected x, got y' }, 'mismatch'],
    [new Error('sha512 checksum mismatch, expected abc, got def'), 'mismatch'],
    [{ code: 'ERR_UPDATER_INVALID_SIGNATURE', message: 'New version 0.45.0 is not signed by the application owner' }, 'signature'],
    [new Error('Code signature at URL file:///x/ did not pass validation: code failed to satisfy specified code requirement(s)'), 'signature'],
    [{ code: 'ENOSPC', message: 'ENOSPC: no space left on device, write' }, 'disk'],
    [new Error('net::ERR_CONNECTION_RESET'), 'network'],
    [new Error('net::ERR_INTERNET_DISCONNECTED'), 'network'],
    [{ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 140.82.121.4:443' }, 'network'],
    [new Error('Cannot download "https://github.com/…", status 404: Not Found'), 'network'],
    [new Error('something else entirely'), 'other'],
    [null, 'other'],
  ]
  for (const [error, want] of table) assert.equal(failReasonOf(error), want, JSON.stringify(error?.message ?? error))
  assert.equal(FAIL_TEXT.mismatch, 'The downloaded file did not match the published one, so it was not used.')
  assert.equal(FAIL_TEXT['wrong-version'], 'The download was not the version offered, so it was not installed.')
  assert.equal(FAIL_TEXT.signature, 'The new version is not signed by TalkWeaver’s developer, so it was not installed.')
})

await test('cannot update in place: each case, with its words', () => {
  assert.equal(inPlaceRefusal(facts()), null, 'in /Applications, writable, the published identity')
  assert.equal(inPlaceRefusal(facts({ appPath: '/Users/someone/Applications/TalkWeaver.app' })), null, 'any writable folder will do')
  const table = [
    [{ source: 'store', platform: 'win32', arch: 'x64' }, 'store'],
    [{ source: 'development' }, 'development'],
    [{ arch: 'x64' }, 'platform'],
    [{ platform: 'linux', arch: 'x64' }, 'platform'],
    [{ platform: 'win32', arch: 'arm64' }, 'windows'],
    [{ platform: 'win32', arch: 'x64' }, 'windows'],
    [{ file: null }, 'no-file'],
    [{ appPath: '/Volumes/TalkWeaver 0.44.5-arm64/TalkWeaver.app', writable: false, writeError: 'EROFS' }, 'disk-image'],
    [{ appPath: '/Volumes/TalkWeaver/TalkWeaver.app', writable: false, writeError: 'EACCES' }, 'disk-image'],
    [{ appPath: '/Users/x/Elsewhere/TalkWeaver.app', writable: false, writeError: 'EROFS' }, 'disk-image'],
    [{ appPath: '/private/var/folders/ab/T/AppTranslocation/1234/d/TalkWeaver.app', writable: false, writeError: 'EROFS' }, 'translocated'],
    [{ writable: false, writeError: 'EACCES' }, 'read-only'],
    [{ writable: false, writeError: 'EPERM' }, 'read-only'],
    [{ bundleId: 'net.dominiklukes.talkweaver' }, 'other-copy'],
    [{ bundleId: null }, 'other-copy'],
  ]
  for (const [over, want] of table) assert.equal(inPlaceRefusal(facts(over)), want, JSON.stringify(over))
  // Windows: no in-place update in this release (the installer is not code-signed), whatever else holds; the Store keeps its own answer.
  const win = { platform: 'win32', arch: 'x64', appPath: 'C:\\Users\\x\\AppData\\Local\\Programs\\TalkWeaver', bundleId: null, file: { ...FILE, bundleId: undefined, url: FILE.url.replace('mac-arm64.zip', 'windows-x64-setup.exe') } }
  assert.equal(inPlaceRefusal(facts(win)), 'windows')
  assert.equal(inPlaceRefusal(facts({ ...win, file: null })), 'windows')
  assert.equal(inPlaceRefusal(facts({ ...win, source: 'store' })), 'store')
  assert.equal(REFUSAL_TEXT.windows, 'In-place updates are not available on Windows yet.')
  // A feed entry without a bundle identity checks none.
  assert.equal(inPlaceRefusal(facts({ bundleId: 'anything', file: { ...FILE, bundleId: undefined } })), null)
  assert.match(REFUSAL_TEXT['disk-image'], /running from a disk image/)
  assert.match(REFUSAL_TEXT.translocated, /Move it to Applications and open it again/)
  assert.match(REFUSAL_TEXT['read-only'], /this account cannot change the app’s folder/)
})

await test('sizes and the popover foot read as drawn', () => {
  assert.equal(sizeText(288_703_536), '289 MB')
  assert.equal(sizeText(4_200_000), '4.2 MB')
  assert.equal(sizeText(0), '0 MB')
  assert.equal(updateFoot('0.45.0', FILE), 'Update downloads 0.45.0 (289 MB), replaces this copy and restarts TalkWeaver. Your talks and settings stay as they are.')
})

await test('restart holds: a publish or export counts until it settles, however it ends', async () => {
  let told = 0
  const holds = createRestartHolds(() => { told += 1 })
  let release
  const publish = holds.during('publishing', (a, b) => new Promise((resolve) => { release = () => resolve(a + b) }))
  const pending = publish(2, 3)
  assert.equal(holds.active('publishing'), true)
  assert.equal(holds.active('exporting'), false)
  release()
  assert.equal(await pending, 5)
  assert.equal(holds.active('publishing'), false)
  assert.equal(told, 2, 'the update is told when the work starts and when it settles (Restart is offered again at once)')
  const failing = holds.during('exporting', async () => { throw new Error('boom') })
  await assert.rejects(failing(), /boom/)
  assert.equal(holds.active('exporting'), false, 'a failed export no longer holds the restart')
  const sync = holds.during('exporting', () => 7)
  assert.equal(await sync(), 7)
})

await test('restart holds on IPC channels: a publish handler counts while it runs; other channels are untouched', async () => {
  const holds = createRestartHolds()
  const registered = new Map()
  const ipc = { handle(channel, listener) { registered.set(channel, listener) } }
  holdOnChannels(ipc, holds, { 'talk:publish-handout': 'publishing', 'talk:export-handout': 'exporting' })
  let finish
  const plain = async () => 'plain'
  ipc.handle('talk:publish-handout', (_e, path) => new Promise((resolve) => { finish = () => resolve(`published ${path}`) }))
  ipc.handle('updates:get', plain)
  assert.equal(registered.get('updates:get'), plain, 'another channel keeps its own handler')
  const answer = registered.get('talk:publish-handout')({}, '/t.md')
  assert.equal(holds.active('publishing'), true)
  finish()
  assert.equal(await answer, 'published /t.md')
  assert.equal(holds.active('publishing'), false)
  const index = (await import('node:fs')).readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const call = index.indexOf("holdOnChannels(ipcMain, restartHolds, { 'talk:publish-handout': 'publishing', 'run:publish-handout': 'publishing', 'talk:export-handout': 'exporting' })")
  assert.ok(call > 0, 'the app counts its handout publishes and exports')
  for (const ch of ['talk:publish-handout', 'run:publish-handout', 'talk:export-handout']) assert.ok(index.indexOf(`ipcMain.handle('${ch}'`) > call, `${ch} is registered after the wrapping is in place`)
})

console.log(`update install: ${passed} checks passed`)
