// Updates in place (ADR-0044): the states of the one click, what holds a restart back, when a copy cannot
// replace itself, how failures are read, and the work a restart waits for (src/shared/update-install.ts,
// src/main/restart-holds.ts). Plain Node, no Electron, no network.
import { readMainSource } from './lib/read-source.mjs'
import assert from 'node:assert/strict'
import {
  BLOCKER_TEXT, FAIL_TEXT, IDLE, REFUSAL_TEXT, RESTART_BLOCKERS, WINDOW_BLOCKERS, blockersSentence, failReasonOf, inPlaceRefusal, installBusy, installMarkText,
  installStep, reopenText, restartBlockers, sizeText, updateFoot,
} from '../src/shared/update-install.ts'
import { createRestartHolds, holdOnChannels } from '../src/main/restart-holds.ts'
import { closeEveryWindow } from '../src/main/restart-windows.ts'
import { delay, standInApp } from './lib/restart-window-standins.mjs'

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
  for (const b of RESTART_BLOCKERS.filter((x) => !WINDOW_BLOCKERS.includes(x))) assert.ok(BLOCKER_TEXT[b] && !/[A-Z]/.test(BLOCKER_TEXT[b][0]), `${b} reads inside a sentence`)
})

await test('rule A: an open window that is not an editor is a blocker the person closes, named in "Close … to restart."', () => {
  assert.deepEqual(restartBlockers({ ...NONE, windows: ['tools'] }), ['tools'])
  assert.deepEqual(restartBlockers({ ...NONE, windows: ['window', 'settings', 'tools', 'capture', 'tools'] }), ['tools', 'settings', 'capture', 'window'], 'each once, in a fixed order')
  assert.deepEqual(restartBlockers({ ...NONE, windows: ['presenting'] }), ['presenting'], 'a deck child alone still reads as presenting')
  assert.deepEqual(restartBlockers({ ...NONE, recording: true, windows: ['settings'] }), ['recording', 'settings'])
  assert.equal(blockersSentence(['tools']), 'Close the Tools window to restart.')
  assert.equal(blockersSentence(['tools', 'settings', 'capture']), 'Close the Tools window, Settings and Capture embed to restart.')
  assert.equal(blockersSentence(['window']), 'Close the other TalkWeaver windows to restart.')
  assert.equal(blockersSentence(['exporting', 'tools']), 'Not now: an export is running. Close the Tools window to restart.')
  for (const b of WINDOW_BLOCKERS) assert.ok(RESTART_BLOCKERS.includes(b), `${b} is a restart blocker`)
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
  assert.deepEqual(reopen, { phase: 'reopen', version: '0.45.0', cause: 'held', pending: true, armed: false })
  for (const s of [IDLE, downloading, waiting]) assert.equal(installStep(s, { type: 'leftover', cause: 'held' }), s, `leftover from ${s.phase}`)
  for (const event of [{ type: 'start', version: '0.46.0', total: 1 }, { type: 'cancelled' }, { type: 'reset' }, { type: 'prepare' }, { type: 'restart', blockers: [] }, { type: 'failed', reason: 'other' }]) {
    assert.equal(installStep(reopen, event), reopen, `${event.type} while reopen: nothing more in this run`)
  }
  assert.equal(installBusy(IDLE), false)
  assert.ok(installBusy(downloading) && installBusy(waiting) && installBusy(restarting) && installBusy(reopen))
})

await test('the words for a restart that did not happen (D4): never "nothing is installed" unless checked; never "will" unless a check found it still armed', () => {
  const v = '0.45.0'
  const checked = reopenText({ version: v, cause: 'held', pending: false, armed: false })
  assert.equal(checked.mark, 'Reopen TalkWeaver to update')
  assert.equal(checked.title, 'Quit and reopen TalkWeaver to update')
  assert.match(checked.detail, /Nothing is installed when it quits\. Quit and reopen TalkWeaver, then press Update again\.$/)
  for (const cause of ['held', 'no-answer', 'install-failed']) {
    const may = reopenText({ version: v, cause, pending: true, armed: false })
    assert.equal(may.title, 'TalkWeaver may finish updating when it next quits', `${cause}: unconfirmed says "may"`)
    assert.match(may.mark, /may install when TalkWeaver quits/)
    const will = reopenText({ version: v, cause, pending: true, armed: true })
    assert.equal(will.title, 'TalkWeaver will finish updating when it next quits', `${cause}: confirmed present says "will"`)
    assert.match(will.detail, /installs it when you next quit TalkWeaver/)
    assert.doesNotMatch(may.detail, /Nothing is installed/, `${cause} pending never says nothing installs`)
    assert.doesNotMatch(will.detail, /Nothing is installed/)
  }
  assert.equal(installMarkText({ phase: 'reopen', version: v, cause: 'held', pending: false, armed: false }), 'Reopen TalkWeaver to update')
  assert.equal(installMarkText({ phase: 'reopen', version: v, cause: 'held', pending: true, armed: false }), `${v} may install when TalkWeaver quits`)
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
  // This asserts the order of registrations in the app entry point.
  const index = (await import('node:fs')).readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const call = index.indexOf("holdOnChannels(ipcMain, restartHolds, { 'talk:publish-handout': 'publishing', 'run:publish-handout': 'publishing', 'talk:export-handout': 'exporting' })")
  assert.ok(call > 0, 'the app counts its handout publishes and exports')
  for (const ch of ['talk:publish-handout', 'run:publish-handout', 'talk:export-handout']) assert.ok(index.indexOf(`ipcMain.handle('${ch}'`) > call, `${ch} is registered after the wrapping is in place`)
})

// ── An update's restart closes only the editor windows (ADR-0044 §6, restart-windows.ts) ─────────────────────────
// Rule A: only plain editor windows are closed by the restart, and hidden helpers stopped; any other window is a
// blocker the person closes. Rule B: an editor is frozen for the restart's close, saves, and confirms the revision it
// holds. Rule D: the same for every ordinary close. Stand-ins in scripts/lib/restart-window-standins.mjs, with the
// REAL createRestartWindows, editor-revisions.ts and lib/closeFreeze.ts; the engine then drains the write queues and
// reads the blockers, the window count and the queues in the turn of the native call (scripts/test-update-engine.mjs).

await test('restart windows: the editors (each frozen, then saved at its current revision) and the hidden helpers close; true only once all have', async () => {
  const a = standInApp()
  const editors = [a.editor({ kind: 'editor (talk A)' }), a.editor({ kind: 'editor (talk B, a separate talk window)' }), a.editor({ kind: 'editor with no talk open', talk: false })]
  const changed = a.editor({ kind: 'editor whose talk changed on disk: Keep mine', sheet: 'keep' })
  for (const kind of ['thumbnail renderer', 'scratchpad page thumbnail', 'offline page capture', 'embed preview artwork', 'presenter layers source']) a.plain(kind, { hidden: true })
  assert.equal(await a.rw.closeWindows(), true)
  for (const w of a.windows) { assert.equal(w.gone, true, w.kind); assert.ok(w.closeCalls >= 1, `${w.kind}: closed by its own route`) }
  for (const w of [...editors.slice(0, 2), changed]) {
    assert.equal(w.disk, 'typed text', `${w.kind}: saved before it closed`)
    assert.equal(w.frozenSeen, true, `${w.kind}: frozen for the close`)
  }
  assert.equal(a.stopped, 1, 'the thumbnail prewarm is stopped once the windows have closed')
  assert.equal(a.rw.openWindows(), 0)
})

for (const [kind, blocker] of [['Tools (Notes and script with a draft)', 'tools'], ['Tools (the recording editor with unsent edits)', 'tools'], ['Settings', 'settings'], ['Capture embed', 'capture'], ['presenter window', 'presenting'], ['audience window a presenter opened', 'presenting'], ['board window', 'presenting'], ['a window of no known kind', 'window']]) {
  await test(`restart windows, rule A: ${kind} open: the restart closes nothing, freezes nothing; it is a blocker (${blocker})`, async () => {
    const a = standInApp()
    const editor = a.editor()
    const other = a.plain(kind, { blocker })
    assert.deepEqual(a.windowBlockers(), [blocker], 'the open window raises its blocker')
    assert.equal(await a.rw.closeWindows(), false)
    assert.equal(other.closeCalls, 0, 'the restart never closes it: the person does')
    assert.equal(editor.closeCalls, 0, 'and no editor was asked to close either')
    assert.equal(editor.frozenSeen, false, 'nor frozen')
    assert.equal(a.stopped, 0)
  })
}

await test('REPRODUCTION (round two, finding 2): a Tools window open with a draft: the restart is refused and nothing is closed; once the person closes Tools, the editors close', async () => {
  const a = standInApp()
  const editor = a.editor()
  const tools = a.plain('Tools (Notes and script, cleaned paragraph not saved)', { blocker: 'tools' })
  assert.deepEqual(a.windowBlockers(), ['tools'])
  assert.equal(await a.rw.closeWindows(), false, 'refused')
  assert.equal(tools.gone, false, 'the Tools window and its draft are still there')
  assert.equal(editor.gone, false)
  tools.finish() // the person closes Tools (and saves or drops the draft there)
  assert.deepEqual(a.windowBlockers(), [])
  assert.equal(await a.rw.closeWindows(), true)
  assert.equal(editor.disk, 'typed text')
})

for (const [label, opts, expect] of [
  ['as built (frozen, saves until clean, revision confirmed)', {}, 'refused'],
  ['mutation: no freeze, one flush (the revision check alone)', { freeze: false, settle: false }, 'saved by the resave'],
  ['mutation: no revision check and no settle (the freeze alone)', { revisions: false, settle: false }, 'refused'],
  ['the code review round two found (no freeze, one flush, no revision)', { freeze: false, settle: false, revisions: false }, 'lost'],
]) {
  for (const close of ['restart', 'ordinary close']) {
    await test(`REPRODUCTION (round two, finding 1), ${close}: SECOND_EDIT typed during the save of FIRST_EDIT — ${label}: ${expect}`, async () => {
      const a = standInApp({ fallbackMs: 400, ...opts })
      const editor = a.editor({ saveMs: 30, duringSave: (w) => w.type(' SECOND_EDIT') })
      editor.type(' FIRST_EDIT')
      if (close === 'restart') assert.equal(await a.rw.closeWindows(), true, 'the restart went ahead')
      else { editor.close(); await delay(200) }
      assert.equal(editor.gone, true, 'the window closed')
      assert.match(editor.disk, /FIRST_EDIT/)
      if (expect === 'lost') {
        assert.notEqual(editor.closedText, editor.disk, 'the fault: the window closed with text that is not on disk')
        assert.doesNotMatch(editor.disk, /SECOND_EDIT/)
        return
      }
      assert.equal(editor.closedText, editor.disk, 'nothing the editor held at its close is missing from disk')
      if (expect === 'refused') { assert.deepEqual(editor.refused, [' SECOND_EDIT'], 'the keystroke was refused'); assert.doesNotMatch(editor.disk, /SECOND_EDIT/) }
      else { assert.deepEqual(editor.refused, []); assert.match(editor.disk, /SECOND_EDIT/, 'main asked for one more save, which wrote it') }
    })
  }
}

await test('restart windows: "Stay here" keeps the window and its text, and unfreezes the editor; the restart is off', async () => {
  const a = standInApp()
  a.editor()
  const kept = a.editor({ kind: 'editor, talk changed on disk', sheet: 'stay' })
  assert.equal(await a.rw.closeWindows(), false)
  assert.equal(kept.gone, false, 'the window stays open')
  assert.equal(kept.text, 'typed text')
  assert.equal(kept.frozen, false, 'unfrozen: the person can type again')
  assert.equal(kept.type(' more'), true)
  assert.equal(a.stopped, 0, 'nothing in the background was stopped for a restart that is off')
  a.rw.kept(kept.id) // a late "kept" for a close nobody waits for does nothing
})

await test('restart windows: a slow save (longer than the five-second fallback) keeps the window open with its work; the restart is off; the editor is released (unfrozen) and its late confirmation does not close it', async () => {
  const a = standInApp({ fallbackMs: 20 })
  const slow = a.editor({ kind: 'editor whose save takes longer than the fallback', saveMs: 60 })
  assert.equal(await a.rw.closeWindows(), false, 'no answer in time is not a safe close')
  assert.equal(slow.gone, false, 'the fallback did not close it')
  a.rw.abandoned() // the engine calls the restart off
  assert.equal(slow.releases, 1, 'released')
  assert.equal(slow.frozen, false, 'unfrozen with nothing lost')
  await delay(100)
  assert.equal(slow.disk, 'typed text', 'the save completed')
  assert.equal(slow.gone, false, 'its late confirmation, for a close already answered, left it open')
  assert.equal(a.editors().length, 1)
})

await test('restart windows: a failed save keeps the window open with its text; the restart is off (whether or not the recovery copy could be written)', async () => {
  for (const recovery of ['ok', 'fails']) {
    const a = standInApp()
    const failed = a.editor({ kind: 'editor whose save fails', save: 'fails', recovery })
    assert.equal(await a.rw.closeWindows(), false, recovery)
    assert.equal(failed.gone, false, `recovery ${recovery}: the window stays open`)
    assert.equal(failed.text, 'typed text')
    assert.equal(failed.disk, 'old text', 'not saved')
    assert.equal(failed.frozen, false, 'unfrozen')
  }
})

await test('restart windows: an editor whose renderer does not answer is left open (the ordinary fallback would close it); the restart is off', async () => {
  const a = standInApp()
  const hung = a.editor({ kind: 'editor whose renderer does not answer', save: 'hung' })
  assert.equal(await a.rw.closeWindows(), false)
  await delay(40)
  assert.equal(hung.gone, false)
  assert.equal(hung.recoveryCopy, null, 'nothing needed the fallback\'s recovery copy: the window and its text are there')
  a.rw.abandoned()
  assert.equal(hung.frozen, false, 'released when the restart is called off')
})

await test('the ordinary close (rule D): frozen, saved, closed; a failed save keeps its old handling (recovery copy, then the window closes); "Stay here" unfreezes', async () => {
  const a = standInApp()
  const w = a.editor({ saveMs: 5 })
  w.close()
  await delay(40)
  assert.equal(w.gone, true, 'an ordinary close after a save closes')
  assert.equal(w.frozenSeen, true, 'frozen while it saved')
  assert.equal(w.disk, w.closedText)
  const b = standInApp()
  const failed = b.editor({ save: 'fails' })
  failed.close()
  await delay(40)
  assert.equal(failed.gone, true, 'a failed save: the ordinary close still closes, as before')
  assert.equal(failed.recoveryCopy, 'typed text', 'with the recovery copy')
  const c = standInApp()
  const stay = c.editor({ sheet: 'stay' })
  stay.close()
  await delay(20)
  assert.equal(stay.gone, false)
  assert.equal(stay.frozen, false, 'Stay here unfreezes')
})

await test('the ordinary close is unchanged where the renderer does not answer: the five-second fallback writes the recovery copy and closes the window', async () => {
  const a = standInApp()
  const w = a.editor({ save: 'hung' })
  w.lastUnsaved = 'typed text' // a save failed earlier
  w.close()
  await delay(40)
  assert.equal(w.gone, true)
  assert.equal(w.recoveryCopy, 'typed text')
})

await test('restart windows: a window that closes without its route saying its work is safe (a renderer that crashed) is not a safe close', async () => {
  const a = standInApp()
  const crashed = a.editor({ save: 'hung' })
  const closing = a.rw.closeWindows()
  setImmediate(crashed.finish)
  assert.equal(await closing, false)
})

await test('restart windows: called off while another close is still in flight: no further close is asked; when the late close lands, an editor is opened again', async () => {
  const a = standInApp()
  const editor = a.editor({ kind: 'editor with no talk open, slow to close', talk: false })
  editor.close = () => { editor.closeCalls += 1; a.rw.saved(editor.id); setTimeout(editor.finish, 30) }
  const kept = a.editor({ sheet: 'stay' })
  assert.equal(await a.rw.closeWindows(), false, 'Stay here kept its window')
  kept.finish() // the person closes it the ordinary way, later
  a.rw.abandoned()
  assert.equal(a.opened, 0, 'an editor was still open (closing) when the restart was called off')
  await delay(60)
  assert.equal(editor.gone, true, 'the close in flight landed afterwards')
  assert.equal(a.opened, 1, 'and an editor was opened again')
  assert.equal(a.editors().length, 1)
})

await test('restart windows: called off (the watchdog) while an editor still saves: its save completes, its window stays open and is unfrozen, and nothing further is closed or stopped', async () => {
  const a = standInApp({ fallbackMs: 200 })
  const saving = a.editor({ saveMs: 20 })
  const hidden = a.plain('thumbnail renderer', { hidden: true, route: () => {} }) // its close never lands
  const closing = a.rw.closeWindows()
  await delay(5)
  a.rw.abandoned() // the engine's watchdog ended the attempt
  assert.equal(saving.frozen, false, 'released at once')
  assert.equal(await closing, false)
  await delay(60)
  assert.equal(saving.disk, 'typed text', 'the save completed')
  assert.equal(saving.gone, false, 'the late confirmation did not close a window the called-off restart had asked for')
  assert.equal(a.stopped, 0, 'no background work was stopped after the restart was called off')
  assert.equal(hidden.closeCalls, 1, 'no further round of closes')
  saving.confirmed = false
  saving.close() // the person closes it later: the ordinary close, with its own save
  await delay(60)
  assert.equal(saving.gone, true, 'an ordinary close later is not held')
})

await test('restart windows: a hidden helper opened again by background work is closed in a further round; any other window that opened meanwhile is not closed', async () => {
  const a = standInApp()
  let reopened = null
  a.editor()
  a.plain('thumbnail renderer', { hidden: true, route: (w) => { setImmediate(w.finish); if (!reopened) setImmediate(() => { reopened = a.plain('thumbnail renderer (again)', { hidden: true }) }) } })
  assert.equal(await a.rw.closeWindows(), true)
  assert.equal(reopened.gone, true, 'closed in the next round')
  const b = standInApp()
  let seen = null
  const e = b.editor({ talk: false })
  const close = e.close
  e.close = () => { close(); seen = b.plain('a new presenter window, opened while the windows closed', { blocker: 'presenting' }) }
  assert.equal(await b.rw.closeWindows(), false, 'a window that opened meanwhile calls the restart off')
  assert.equal(seen.closeCalls, 0, 'and is not closed by the restart')
  b.rw.abandoned()
  assert.equal(b.editors().length, 1, 'an editor is opened again')
})

await test('restart windows: a close that throws, or a window list that keeps refilling with hidden helpers, calls the restart off', async () => {
  const a = standInApp()
  const e = a.editor()
  e.close = () => { throw new Error('the window is being destroyed') }
  assert.equal(await a.rw.closeWindows(), false)
  const b = standInApp()
  const spawn = () => b.plain('thumbnail renderer', { hidden: true, route: (w) => { spawn(); setImmediate(w.finish) } })
  spawn()
  assert.equal(await b.rw.closeWindows(), false, 'never true while a window is open')
  assert.equal(await closeEveryWindow([], () => Promise.resolve('kept')), true, 'no window: nothing to keep open')
})

await test('the app wires the restart\'s close through the editor\'s own close route, its fallback, its revision-checked confirmation, its "Stay here" and the release', async () => {
  const fs = await import('node:fs')
  const index = readMainSource()
  assert.match(index, /ipcMain\.handle\('window:close-kept', \(event\) => \{\n[^\n]*\n[^\n]*\n  restartWindows\.kept\(event\.sender\.id\)/)
  assert.match(index, /const verdict = editorRevisions\.verdict\(id, opts\?\.revision, forRestart \? 'restart' : 'close'\)\n  if \(verdict === 'resave' && \(!forRestart \|\| editorWorkSaved\(id\)\)\) return 'resave'/)
  assert.match(index, /if \(restartWindows\.confirm\(id, verdict === 'saved' && editorWorkSaved\(id\)\) === 'keep'\) return keep\(\)\n  closeConfirmed\.add/)
  assert.match(index, /if \(win\.isDestroyed\(\)\) return\n[^\n]*\n[^\n]*\n      if \(restartWindows\.timedOut\(wcId\)\) return\n/, 'the fallback leaves a restart\'s window open before anything else')
  assert.match(index, /restartWindows\.ordinaryClose\(wcId\)/)
  assert.match(index, /closeWindowsForRestart: \(\) => \{\n      beginQuitAttempt\(\)\n      return restartWindows\.closeWindows\(\)/,
    'the helper gate is held before closing editors through their existing save route')
  assert.match(index, /restartAbandoned: \(\) => \{\n      cancelQuitAttempt\(\)\n      restartWindows\.abandoned\(\)/,
    'abandonment releases the helper gate and still restores/unfreezes the editor')
  assert.match(index, /classOf: \(win\) => windowClassOf\(windowKindNow\(win\)\)/)
  assert.match(index, /release: \(win\) => \{ if \(!win\.isDestroyed\(\)\) win\.webContents\.send\('outline:close-cancelled'\) \}/)
  assert.match(index, /windows: windowRestartBlockers\(\),/, 'the open windows are read as blockers with the others')
  assert.match(index, /windows: \(\) => BrowserWindow\.getAllWindows\(\),/, 'every window counts, hidden ones too: Electron\'s window list holds them all')
  assert.match(index, /const finished = editorRevisions\.writeStarted\(event\.sender\.id, opts\?\.revision\)/)
  assert.match(index, /editorRevisions\.loaded\(event\.sender\.id, opts\.revision\)/)
  assert.match(index, /function runBackupFor\([^)]*\): Promise<BackupRun> \{\n  return restartHolds\.during\('exporting', runBackupExports\)\(talks\)/, 'a backup run holds the restart as an export, from its first talk to its last')
  const hook = fs.readFileSync(new URL('../src/renderer/src/components/useOutlineDiskChange.ts', import.meta.url), 'utf8')
  assert.match(hook, /await closeFrozen\(\{ \.\.\.editorDeps, leave: async \(\) => \{\n          const mayLeave = await leave\(\)\n          if \(update !== true\) await window\.tw\.talk\.ackCloseRequest\?\.\(\)/, 'every close of a window with a talk goes through the freeze; only the ordinary close switches the fallback off after its flush')
  assert.match(hook, /onCloseCancelled\?\.\(\(\) => \{ for \(const release of/, 'a called-off restart releases the frozen editor')
  const editor = fs.readFileSync(new URL('../src/renderer/src/components/Editor.tsx', import.meta.url), 'utf8')
  assert.match(editor, /closeFrozenRef\.current && !tr\.annotation\(savedTextAdopted\) && !tr\.annotation\(closeFreezeExempt\)\)\) && tr\.docChanged \? \[\] : tr/, 'the freeze refuses every edit but Reload and a save\'s ids')
  assert.match(editor, /EditorView\.editable\.of\(false\),\n    EditorState\.readOnly\.of\(true\),/)
  assert.match(editor, /window\.tw\.talk\.writeOutline\(outlinePath, text, \{ revision, expectedDiskHash: baseline\.diskHash \}\)/, 'every editor save carries its revision and adopted disk version')
})

console.log(`update install: ${passed} checks passed`)
