// Which web permission each frame of each window gets (src/main/recording-permissions.ts; embed-sandbox
// design 4.4, matrix row 19, and the security review of ticket 11.3). One table from app start, for
// requests and for checks: the microphone to a presenter window's own page, audio only; clipboard
// write and full screen to a window's own page; clipboard read to the editor's pages; nothing else,
// and nothing at all to a frame embedded in a slide.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRecordingPermissions, decideMicrophoneRequest, decidePermission } from '../src/main/recording-permissions.ts'

let passed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`) } catch (err) { console.error(`  FAIL ${name}`); throw err }
}
const PRESENTER = 21, EDITOR = 5, PLAIN_DECK = 30
const presenters = new Set([PRESENTER])
const appWindows = new Set([EDITOR])
const ask = (over = {}) => decideMicrophoneRequest({ permission: 'media', contentsId: PRESENTER, presenterIds: presenters, isMainFrame: true, mediaTypes: ['audio'], ...over })
const table = (permission, contentsId, isMainFrame, mediaTypes) => decidePermission({ permission, contentsId, isMainFrame, mediaTypes, presenterIds: presenters, appWindowIds: appWindows })

// Every permission name Electron 42 passes to a request or check handler, and the extra ones a
// hidden-window run saw in checks (automatic-fullscreen, speaker-selection, web-app-installation).
const REFUSED_FOR_EVERYONE = ['notifications', 'geolocation', 'display-capture', 'mediaKeySystem', 'midi', 'midiSysex', 'pointerLock', 'keyboardLock', 'idle-detection',
  'storage-access', 'top-level-storage-access', 'window-management', 'speaker-selection', 'fileSystem', 'openExternal', 'hid', 'serial', 'usb', 'deprecated-sync-clipboard-read',
  'automatic-fullscreen', 'web-app-installation', 'unknown', '', undefined, null, 'CLIPBOARD-READ', 'Fullscreen']

console.log('permissions')

await test('microphone — granted: media, audio, main frame, a presenter window', () => {
  assert.equal(ask(), true)
})

await test('microphone — refused: a subframe of the presenter window (an embedded page)', () => {
  assert.equal(ask({ isMainFrame: false }), false)
  for (const unknown of [undefined, null, 'true', 1]) assert.equal(ask({ isMainFrame: unknown }), false, `isMainFrame ${String(unknown)}`)
})

await test('microphone — refused: the camera, with or without audio, and a request that names no media', () => {
  assert.equal(ask({ mediaTypes: ['video'] }), false)
  assert.equal(ask({ mediaTypes: ['audio', 'video'] }), false)
  assert.equal(ask({ mediaTypes: ['video', 'audio'] }), false)
  assert.equal(ask({ mediaTypes: ['unknown'] }), false)
  assert.equal(ask({ mediaTypes: [] }), false)
  assert.equal(ask({ mediaTypes: undefined }), false)
  assert.equal(ask({ mediaTypes: 'audio' }), false)
  assert.equal(ask({ mediaTypes: ['audio', 'audio'] }), true)
})

await test('microphone — refused: another window, and any other permission asked as if it were the microphone', () => {
  assert.equal(ask({ contentsId: 22 }), false, 'the editor, an audience window, a thumbnail window')
  assert.equal(ask({ contentsId: undefined }), false)
  assert.equal(ask({ contentsId: '21' }), false)
  assert.equal(ask({ presenterIds: new Set() }), false, 'no presenter window is open')
  for (const permission of ['display-capture', 'fullscreen', 'clipboard-sanitized-write', 'clipboard-read', '', undefined]) assert.equal(ask({ permission }), false, String(permission))
})

await test('the table, main frame: clipboard write and full screen in every window; clipboard read in the editor only; the microphone in the presenter only', () => {
  for (const window of [PRESENTER, EDITOR, PLAIN_DECK]) {
    assert.equal(table('clipboard-sanitized-write', window, true), true, `write ${window}`)
    assert.equal(table('fullscreen', window, true), true, `fullscreen ${window}`)
  }
  assert.equal(table('clipboard-read', EDITOR, true), true, 'the editor\'s Paste command')
  assert.equal(table('clipboard-read', PRESENTER, true), false, 'a deck window: an embedded page could ask through the parent')
  assert.equal(table('clipboard-read', PLAIN_DECK, true), false)
  assert.equal(table('media', PRESENTER, true, ['audio']), true)
  assert.equal(table('media', EDITOR, true, ['audio']), false)
  assert.equal(table('media', PLAIN_DECK, true, ['audio']), false)
  for (const window of [PRESENTER, EDITOR, PLAIN_DECK]) for (const permission of REFUSED_FOR_EVERYONE) assert.equal(table(permission, window, true, ['audio']), false, `${String(permission)} in ${window}`)
})

await test('the table, a frame embedded in the page: full screen, and nothing else, in any window', () => {
  for (const window of [PRESENTER, EDITOR, PLAIN_DECK]) {
    assert.equal(table('fullscreen', window, false), true, `a video player's own full-screen button, window ${window}`)
    for (const unknown of [undefined, null, 'true', 1]) assert.equal(table('fullscreen', window, unknown), true, `fullscreen does not depend on the frame (${String(unknown)})`)
    // What full screen must not bring with it.
    for (const permission of ['automatic-fullscreen', 'keyboardLock', 'pointerLock', 'Fullscreen', 'window-management']) assert.equal(table(permission, window, false), false, permission)
    for (const permission of ['media', 'clipboard-sanitized-write', 'clipboard-read', ...REFUSED_FOR_EVERYONE]) {
      assert.equal(table(permission, window, false, ['audio']), false, `${String(permission)} from a frame in ${window}`)
      for (const unknown of [undefined, null, 'true', 1]) assert.equal(table(permission, window, unknown, ['audio']), false, `${String(permission)}, isMainFrame ${String(unknown)}`)
    }
  }
})

await test('the table: a question that names no window is refused', () => {
  for (const contentsId of [null, undefined, '5', {}, NaN]) {
    for (const permission of ['media', 'clipboard-sanitized-write', 'fullscreen', 'clipboard-read', 'notifications']) {
      assert.equal(table(permission, contentsId, true, ['audio']), false, `${permission} from ${String(contentsId)}`)
    }
  }
})

/** A BrowserWindow, as far as the permissions need it. */
function fakeWindow(id) {
  let closed = null
  return { webContents: { id }, once(event, fn) { assert.equal(event, 'closed'); closed = fn }, close() { closed?.() } }
}
const fakeSession = () => ({ handler: undefined, check: undefined, sets: [], setPermissionRequestHandler(h) { this.handler = h; this.sets.push('request') }, setPermissionCheckHandler(h) { this.check = h; this.sets.push('check') } })
const request = (session, contentsId, permission, details) => { let answer = null; session.handler(contentsId === null ? null : { id: contentsId }, permission, (granted) => { answer = granted }, details); return answer }
const check = (session, contentsId, permission, details, origin = 'file:///') => session.check(contentsId === null ? null : { id: contentsId }, permission, origin, details)
const mic = { isMainFrame: true, mediaTypes: ['audio'] }
const main = { isMainFrame: true }
const frame = { isMainFrame: false }

function running() {
  const session = fakeSession()
  const permissions = createRecordingPermissions()
  permissions.install(session)
  const windows = { editor: fakeWindow(EDITOR), presenter: fakeWindow(PRESENTER), deck: fakeWindow(PLAIN_DECK) }
  return { session, permissions, windows }
}

await test('request handler: from app start, before any presenter window, a frame in any window is granted nothing', () => {
  const { session, permissions, windows } = running()
  assert.deepEqual(session.sets, ['request', 'check'], 'both handlers are set at install')
  permissions.addAppWindow(windows.editor)
  // What the review reproduced: a hostile frame asking before a presenter window had ever opened.
  for (const permission of ['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'automatic-fullscreen', 'keyboardLock', 'geolocation', 'display-capture', 'midi', 'pointerLock', 'openExternal', 'fileSystem', 'unknown']) {
    assert.equal(request(session, EDITOR, permission, frame), false, `${permission} from a frame in the editor's preview`)
    assert.equal(request(session, PLAIN_DECK, permission, frame), false, `${permission} from a frame in a plain deck window`)
  }
  // The one thing a frame may have: full screen (a video player's own button). Electron 42 sends it as a request that names the window.
  assert.equal(request(session, PLAIN_DECK, 'fullscreen', frame), true)
  assert.equal(request(session, EDITOR, 'fullscreen', frame), true)
  assert.equal(request(session, PLAIN_DECK, 'fullscreen', undefined), true, 'no details: the window is known, the frame does not matter')
  assert.equal(request(session, null, 'fullscreen', frame), false, 'a request that names no window cannot be placed')
  assert.equal(request(session, PLAIN_DECK, 'media', { isMainFrame: false, mediaTypes: ['audio'] }), false)
  assert.equal(request(session, PLAIN_DECK, 'media', mic), false, 'no window has the microphone before a presenter window opens')
  // The app's own pages.
  assert.equal(request(session, EDITOR, 'clipboard-sanitized-write', main), true, 'the editor\'s copy buttons')
  assert.equal(request(session, EDITOR, 'clipboard-read', main), true, 'the editor\'s Paste command')
  assert.equal(request(session, PLAIN_DECK, 'fullscreen', main), true, 'the deck\'s own full-screen control')
  assert.equal(request(session, PLAIN_DECK, 'clipboard-read', main), false)
  assert.equal(request(session, PLAIN_DECK, 'notifications', main), false)
  assert.equal(request(session, EDITOR, 'notifications', main), false)
})

await test('request handler: opening a presenter window changes nothing but the microphone for that window\'s own page', () => {
  const { session, permissions, windows } = running()
  permissions.addAppWindow(windows.editor)
  const before = ['clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'notifications'].map((p) => [request(session, EDITOR, p, main), request(session, EDITOR, p, frame)])
  permissions.addPresenter(windows.presenter)
  const after = ['clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'notifications'].map((p) => [request(session, EDITOR, p, main), request(session, EDITOR, p, frame)])
  assert.deepEqual(after, before)
  assert.deepEqual(before, [[true, false], [true, false], [true, true], [false, false]], 'write, read, fullscreen, notifications — main frame, embedded frame')
  assert.equal(request(session, PRESENTER, 'media', mic), true)
  assert.equal(request(session, PRESENTER, 'media', { isMainFrame: false, mediaTypes: ['audio'] }), false, 'an embedded page in the presenter window')
  assert.equal(request(session, PRESENTER, 'media', { isMainFrame: true, mediaTypes: ['audio', 'video'] }), false)
  assert.equal(request(session, PRESENTER, 'media', undefined), false, 'no details')
  assert.equal(request(session, EDITOR, 'media', mic), false, 'the editor')
  assert.equal(request(session, null, 'media', mic), false)
  assert.equal(request(session, PRESENTER, 'clipboard-read', main), false, 'the presenter reads the clipboard through main, not the web clipboard')
  assert.equal(request(session, PRESENTER, 'notifications', frame), false)
})

await test('request handler: two presenter windows both keep the microphone; a closed window loses what it had', () => {
  const { session, permissions, windows } = running()
  const second = fakeWindow(22)
  const handler = session.handler
  permissions.addPresenter(windows.presenter)
  permissions.addPresenter(second)
  permissions.addAppWindow(windows.editor)
  assert.equal(session.handler, handler, 'one shared handler: no window replaces it')
  assert.deepEqual(session.sets, ['request', 'check'])
  assert.equal(request(session, PRESENTER, 'media', mic), true)
  assert.equal(request(session, 22, 'media', mic), true)
  windows.presenter.close()
  assert.equal(request(session, PRESENTER, 'media', mic), false)
  assert.equal(request(session, 22, 'media', mic), true)
  assert.deepEqual([...permissions.presenterIds()], [22])
  windows.editor.close()
  assert.equal(request(session, EDITOR, 'clipboard-read', main), false)
  assert.deepEqual([...permissions.appWindowIds()], [])
})

await test('check handler: the same table — permissions.query and device labels say "granted" to nobody the request handler would refuse', () => {
  const { session, permissions, windows } = running()
  permissions.addAppWindow(windows.editor)
  permissions.addPresenter(windows.presenter)
  // The window's own page.
  assert.equal(check(session, EDITOR, 'clipboard-sanitized-write', main), true)
  assert.equal(check(session, EDITOR, 'clipboard-read', main), true)
  assert.equal(check(session, PLAIN_DECK, 'clipboard-read', main), false)
  assert.equal(check(session, PLAIN_DECK, 'fullscreen', main), true)
  assert.equal(check(session, PRESENTER, 'media', { isMainFrame: true, mediaType: 'audio' }), true, 'the recorder sees its microphone')
  assert.equal(check(session, PRESENTER, 'media', { isMainFrame: true, mediaType: 'video' }), false)
  assert.equal(check(session, PRESENTER, 'media', { isMainFrame: true, mediaType: 'unknown' }), false)
  assert.equal(check(session, PRESENTER, 'media', { isMainFrame: true }), false, 'no media type named')
  assert.equal(check(session, EDITOR, 'media', { isMainFrame: true, mediaType: 'audio' }), false)
  // A frame embedded in the page, in every window.
  for (const window of [EDITOR, PRESENTER, PLAIN_DECK]) {
    for (const permission of ['clipboard-read', 'clipboard-sanitized-write', 'automatic-fullscreen', 'keyboardLock', 'pointerLock', 'notifications', 'geolocation', 'hid', 'serial', 'usb', 'deprecated-sync-clipboard-read']) {
      assert.equal(check(session, window, permission, frame), false, `${permission} from a frame in ${window}`)
    }
    assert.equal(check(session, window, 'fullscreen', frame), true, `fullscreen from a frame in ${window}: the same answer as the request`)
    assert.equal(check(session, window, 'media', { isMainFrame: false, mediaType: 'audio' }), false)
  }
  // No window: Electron passes null for a cross-origin frame and for some checks (notifications). It cannot be placed,
  // and that includes fullscreen: a player's button makes no fullscreen check at all (it makes one request, with its
  // window), so nothing the button needs is refused here.
  for (const permission of ['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'notifications', 'media']) {
    assert.equal(check(session, null, permission, { isMainFrame: true, mediaType: 'audio' }, 'https://remote.example'), false, `${permission} with no window`)
    assert.equal(check(session, null, permission, undefined, 'file:///'), false)
  }
  for (const permission of REFUSED_FOR_EVERYONE) assert.equal(check(session, EDITOR, permission, main), false, String(permission))
  assert.equal(check(session, EDITOR, 'clipboard-read', undefined), false, 'no details')
  assert.equal(check(session, EDITOR, 'clipboard-read', { get isMainFrame() { throw new Error('x') } }), false, 'details that cannot be read')
})

await test('wiring: installed at app start; the three editor-kind windows are registered; the app has no other permission handler', () => {
  const recording = readFileSync(new URL('../src/main/recording.ts', import.meta.url), 'utf8')
  assert.match(recording, /recordingPermissions\.addPresenter\(win/)
  assert.match(recording, /recordingPermissions\.addAppWindow\(win/)
  assert.ok(!/setPermission\w+Handler/.test(recording), 'recording.ts sets no handler of its own')
  const index = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.match(index, /installRecordingPermissions\(session\.defaultSession\)/)
  assert.match(index, /setupRecordingPermissions\(win\)/)
  // Editor, Tools and Pathways: every window that gets the app handler is registered on the next line.
  const appWindows = [...index.matchAll(/win\.webContents\.setWindowOpenHandler\(appWindowOpenHandler\(appWindowOpenOpts, [^\n]*\)\)\n\s*(\S+)/g)].map((m) => m[1])
  assert.deepEqual(appWindows, ['registerAppWindowPermissions(win)', 'registerAppWindowPermissions(win)', 'registerAppWindowPermissions(win)'])
  assert.equal(index.match(/registerAppWindowPermissions\(win\)/g).length, 3, 'and no other window (never a deck window)')
  // One list of editor-kind windows for every rule (window-kinds.ts): the permissions share it, they keep no copy.
  assert.match(recording, /createRecordingPermissions\(\{ appWindowIds \}\)/)
  const shared = new Set()
  const sharing = createRecordingPermissions({ appWindowIds: shared })
  sharing.addAppWindow(fakeWindow(77))
  assert.deepEqual([...shared], [77])
  assert.equal(sharing.appWindowIds(), shared)
  // Every permission-like handler in the main process is in recording-permissions.ts. A new one
  // anywhere must be checked for the same gap (a request from a frame that is not the main frame).
  const mainDir = fileURLToPath(new URL('../src/main/', import.meta.url))
  const sources = (dir) => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|mts|mjs|js)$/.test(name) ? [path] : []
  })
  const found = []
  for (const path of sources(mainDir)) {
    const text = readFileSync(path, 'utf8')
    for (const m of text.matchAll(/\b(setPermissionRequestHandler|setPermissionCheckHandler|setDevicePermissionHandler|setDisplayMediaRequestHandler|setBluetoothPairingHandler|setUSBProtectedClassesHandler)\(/g)) found.push(`${path.slice(mainDir.length)}:${m[1]}`)
  }
  assert.deepEqual([...new Set(found)].sort(), ['recording-permissions.ts:setPermissionCheckHandler', 'recording-permissions.ts:setPermissionRequestHandler'])
})

console.log(`permissions: ${passed} passed`)
