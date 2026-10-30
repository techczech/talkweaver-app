// Update notices (ADR-0041): the check's decisions and every state's words (@app-patterns/updates, with
// TalkWeaver's identity in src/shared/update-identity.ts), with no network, no Electron and a clock the test turns.
//  1. when a check runs: store copy, development run, first check, a launch within a day, checking off,
//     presenting (waits, then runs), a failed check, a second check joining the first;
//  2. the result: newer, equal, older, a preview against its own release, rejected feed;
//  3. the mark: newer, skipped, Not now, a later version after a skip, checking off, presenting, Store;
//  4. Check for Updates…: each of the four answers, a skipped version shown, Settings card states;
//  5. What's new: shown after an update, not after a first install or a downgrade, an upgrade from a
//     version that recorded none, gone when clicked or after seven days;
//  6. the files: the check's request is made in one place, nothing is run or installed, commands exist.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createUpdateChecker } from '@app-patterns/updates'
import {
  CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, BUSY_RETRY_MS, WHATS_NEW_DAYS, aboutLines, answerView, availableMark, cardView, copySource,
  dateText, localDay, noteReducer, noteLaunch, parseWhatsNew, readUpdateState as readState, whatsNewMark, whenText, updatedMarkText, availableMarkText,
} from '@app-patterns/updates'
import { COMMAND_REGISTRY, menuCommands } from '../src/shared/command-registry.ts'
import { SHORTCUT_REGISTRY } from '../src/shared/shortcut-registry.ts'

import { UPDATE_IDENTITY, FEED_URL, notesLinkFor } from '../src/shared/update-identity.ts'
const readUpdateState = (raw) => readState(raw, FEED_URL)
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS  ${name}`) } catch (error) { console.error(`FAIL  ${name}`); throw error }
}

const feedText = (version = '0.42.0') => JSON.stringify({
  schema: 1,
  latest: {
    version, released: '2026-11-12', summary: ['One.', 'Two.', 'Three.'], notes: `https://talkweaver.app/whats-new#${version}`,
    download: { mac: 'https://talkweaver.app/download#mac', windows: 'https://talkweaver.app/download#windows' },
  },
})
const T0 = new Date(2026, 10, 12, 9, 12).getTime() // 12 Nov 2026 09:12 local

const ctx = (snap, now = snap.state.lastCheckAt ?? T0) => ({ identity: UPDATE_IDENTITY, arch: 'arm64', running: snap.running, platform: snap.platform, source: snap.source, enabled: snap.enabled, checking: snap.checking, now })

/** A checker over stand-ins: a clock the test turns, a timer list it runs by hand, and a feed it scripts. */
function harness(over = {}) {
  const h = {
    now: T0, state: {}, config: { enabled: true, presenting: false, vaults: true, notes: new Set(['0.42.0', '0.41.0']) },
    requests: 0, answers: [], told: [], timers: [],
  }
  h.nextAnswer = (answer) => h.answers.push(answer)
  h.checker = createUpdateChecker({
    identity: UPDATE_IDENTITY, arch: 'arm64', running: '0.41.0', platform: 'darwin', source: 'website',
    fetchFeed: async () => { h.requests += 1; return h.answers.shift() ?? { ok: true, text: feedText() } },
    readState: () => readUpdateState(JSON.parse(JSON.stringify(h.state))),
    writeState: (state) => { h.state = JSON.parse(JSON.stringify(state)) },
    enabled: () => h.config.enabled,
    isBusy: () => h.config.presenting,
    hasNotes: (v) => h.config.notes.has(v),
    hadConfiguration: () => h.config.vaults,
    now: () => h.now,
    changed: (s) => h.told.push(s),
    schedule: (fn, ms) => { const t = { fn, ms, live: true }; h.timers.push(t); return t },
    cancel: (t) => { if (t) t.live = false },
    ...over,
  })
  h.live = () => h.timers.filter((t) => t.live).at(-1)
  h.fire = async () => { const t = h.live(); assert.ok(t, 'a timer is armed'); t.live = false; t.fn(); await new Promise((r) => setImmediate(r)) }
  return h
}

await test('a website copy: first check two minutes after launch, then every day', async () => {
  const h = harness()
  h.checker.start()
  assert.equal(h.requests, 0, 'nothing during start-up')
  assert.equal(h.live().ms, FIRST_CHECK_DELAY_MS)
  h.now += FIRST_CHECK_DELAY_MS
  await h.fire()
  assert.equal(h.requests, 1)
  assert.equal(h.live().ms, CHECK_INTERVAL_MS, 'the next one is a day on')
  h.now += CHECK_INTERVAL_MS
  await h.fire()
  assert.equal(h.requests, 2)
})

await test('a launch within a day of a successful check does not check; it waits for the rest of the day', async () => {
  const h = harness()
  h.state = { lastCheckAt: T0 - 5 * 3600_000 }
  h.checker.start()
  h.now += FIRST_CHECK_DELAY_MS
  await h.fire()
  assert.equal(h.requests, 0)
  assert.equal(h.live().ms, CHECK_INTERVAL_MS - 5 * 3600_000 - FIRST_CHECK_DELAY_MS)
})

await test('a Store copy and a development run make no request at all, even when asked', async () => {
  for (const source of ['store', 'development']) {
    const h = harness({ source })
    h.checker.start()
    assert.equal(h.timers.filter((t) => t.live).length, 0, `${source}: no timer`)
    const snap = await h.checker.checkNow()
    assert.equal(h.requests, 0, `${source}: Check for Updates… makes no request`)
    assert.equal(snap.source, source)
    assert.equal(snap.mark, null)
  }
})

await test('checking off: no automatic request, but Check for Updates… still checks', async () => {
  const h = harness()
  h.config.enabled = false
  h.checker.start()
  h.now += FIRST_CHECK_DELAY_MS
  await h.fire()
  assert.equal(h.requests, 0)
  const snap = await h.checker.checkNow()
  assert.equal(h.requests, 1)
  assert.equal(snap.state.latest.version, '0.42.0')
  assert.equal(snap.mark, null, 'no mark while checking is off')
  assert.equal(answerView(snap.state, { ...ctx(snap) }).title, 'TalkWeaver 0.42.0 is available.')
})

await test('switching checking on checks soon', async () => {
  const h = harness()
  h.config.enabled = false
  h.checker.start()
  h.config.enabled = true
  h.checker.settingChanged()
  assert.equal(h.live().ms, FIRST_CHECK_DELAY_MS)
  await h.fire()
  assert.equal(h.requests, 1)
})

await test('presenting: no request while a presenter, audience window, live session or recording is open; it runs within a minute of the end', async () => {
  const h = harness()
  h.checker.start()
  h.config.presenting = true
  h.now += FIRST_CHECK_DELAY_MS
  await h.fire()
  assert.equal(h.requests, 0)
  assert.equal(h.live().ms, BUSY_RETRY_MS)
  assert.ok(BUSY_RETRY_MS <= 60_000, 'within a minute')
  for (let i = 0; i < 5; i += 1) { h.now += BUSY_RETRY_MS; await h.fire() }
  assert.equal(h.requests, 0, 'still waiting')
  h.config.presenting = false
  h.now += BUSY_RETRY_MS
  await h.fire()
  assert.equal(h.requests, 1, 'the postponed check runs')
})

await test('Check for Updates… while presenting sends nothing; it waits, runs when presenting ends and shows its answer then', async () => {
  const answered = []
  const h = harness({ answered: (s) => answered.push(s) })
  h.checker.start()
  h.config.presenting = true
  const asked = await h.checker.checkNow()
  assert.equal(h.requests, 0, 'no request while presenting')
  assert.equal(asked.waiting, true, 'the window is told the check is waiting')
  assert.equal(h.live().ms, BUSY_RETRY_MS)
  for (let i = 0; i < 3; i += 1) { h.now += BUSY_RETRY_MS; await h.fire() }
  assert.equal(h.requests, 0, 'still presenting: still nothing sent')
  assert.equal(answered.length, 0)
  h.config.presenting = false
  h.checker.busyChanged()
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  assert.equal(h.requests, 1, 'the waiting check runs as presenting ends')
  assert.equal(answered.length, 1, 'and its answer is handed to the main window')
  assert.equal(answered[0].state.lastResult, 'newer')
  assert.equal(answered[0].waiting, false)
})

await test('a waiting check never runs if presenting started again before it fired', async () => {
  const h3 = harness()
  h3.checker.start()
  h3.config.presenting = true
  await h3.checker.checkNow()
  h3.now += BUSY_RETRY_MS
  await h3.fire() // the retry fires while a (second) talk is on
  assert.equal(h3.requests, 0, 'no request while presenting again')
})

await test('the note: a waiting note is never shown during a talk, and a deferred answer arriving during a second talk is held until it ends', () => {
  const none = { shown: null, held: null }
  // scenario 1: a check asked during a talk shows nothing (the window shows no note at all while presenting)
  let st = noteReducer(none, { kind: 'answer', view: 'waiting', busy: true })
  assert.equal(st.shown, null, 'nothing shown while presenting')
  assert.equal(noteReducer(st, { kind: 'busy', busy: true }).shown, null)
  // scenario 2: the deferred answer arrives after a second talk started: held, then shown when it ends
  st = noteReducer(none, { kind: 'answer', view: 'answer', busy: true })
  assert.deepEqual(st, { shown: null, held: 'answer' })
  assert.equal(noteReducer(st, { kind: 'busy', busy: true }).shown, null)
  assert.equal(noteReducer(st, { kind: 'busy', busy: false }).shown, 'answer')
  // a note on screen is cleared when a talk starts
  assert.equal(noteReducer({ shown: 'note', held: null }, { kind: 'busy', busy: true }).shown, null)
  assert.equal(noteReducer({ shown: 'note', held: null }, { kind: 'answer', view: 'b', busy: false }).shown, 'b')
  const read = (rel) => readFileSync(join(REPO, rel), 'utf8')
  const lib = read('src/renderer/src/lib/updateNotices.ts')
  assert.ok(/if \(snap\.waiting\) return null/.test(lib) && !/snap\.waiting \|\| snap\.presenting/.test(lib), 'no waiting note is raised, and a finished answer is never dropped')
  assert.ok(/showAnswer\(answerOf\(snap\), snap\.busy\)/.test(lib), 'a finished answer is handed to the holding note even when a talk began meanwhile')
  assert.ok(/d\?\.busy === true/.test(read('src/renderer/src/components/UpdateNotices.tsx')), 'the note holds an answer flagged busy')
  // the reproduced case: a check started idle fails during a talk; the answer is held, then shown when the talk ends
  const failed = noteReducer({ shown: null, held: null }, { kind: 'answer', view: 'try again', busy: true })
  assert.equal(failed.shown, null)
  assert.equal(noteReducer(failed, { kind: 'busy', busy: false }).shown, 'try again')
  const notices = read('src/renderer/src/components/UpdateNotices.tsx')
  assert.ok(/const view = presenting \? null : note\.shown/.test(notices) && /!snap\.busy && createPortal/.test(notices), 'note and popover are gated on presenting at render')
})

await test('every presenting transition pushes a snapshot that says so (windows close an open popover and note)', () => {
  const h = harness()
  h.checker.start()
  const before = h.told.length
  h.config.presenting = true
  h.checker.busyChanged()
  assert.equal(h.told.length, before + 1)
  assert.equal(h.told.at(-1).busy, true)
  h.checker.busyChanged()
  assert.equal(h.told.length, before + 1, 'no change, no push')
  h.config.presenting = false
  h.checker.busyChanged()
  assert.equal(h.told.length, before + 2)
  assert.equal(h.told.at(-1).busy, false)
})

await test('the windows close their popover and note when presenting starts, and the Settings card follows the latest snapshot', () => {
  const read = (rel) => readFileSync(join(REPO, rel), 'utf8')
  const notices = read('src/renderer/src/components/UpdateNotices.tsx')
  assert.ok(/snap\.busy\) setOpen\(false\)/.test(notices), 'the popover closes')
  assert.ok(/kind: 'busy', busy: presenting/.test(notices), 'the note closes')
  const card = read('src/renderer/src/components/AboutUpdatesSettings.tsx')
  assert.ok(!/setLocal|useState<AnswerView/.test(card), 'no local answer outlives a newer snapshot')
  assert.ok(/data-update-check/.test(card) && /view\.action !== 'check' && view\.action !== 'try-again'/.test(card), 'Check for updates shows after every answer')
  const live = read('src/main/live-session-manager.ts')
  assert.ok(!/windowId !== null && !isTerminalLiveStatus/.test(live.slice(live.indexOf('anyOpen'), live.indexOf('anyOpen') + 300)), 'a detached live session counts as presenting')
})

await test('presenting hides the mark in every window; it returns when presenting ends', async () => {
  const h = harness()
  await h.checker.checkNow()
  assert.equal(h.checker.snapshot().mark.version, '0.42.0')
  h.config.presenting = true
  assert.equal(h.checker.snapshot().mark, null)
  h.config.presenting = false
  assert.equal(h.checker.snapshot().mark.version, '0.42.0')
})

await test('a second check asked for while one is under way joins it', async () => {
  let release
  const h = harness({ fetchFeed: () => new Promise((resolve) => { release = () => resolve({ ok: true, text: feedText() }) }) })
  const a = h.checker.checkNow()
  const b = h.checker.checkNow()
  assert.equal(h.checker.snapshot().checking, true)
  release()
  await Promise.all([a, b])
  assert.equal(h.checker.snapshot().checking, false)
})

await test('a failed check changes nothing outside the state: offline, an HTML page, a bad feed, too large, a thrown error', async () => {
  const cases = [
    [{ ok: false, reason: 'unreachable' }, 'unreachable'],
    [{ ok: false, reason: 'too-large' }, 'unreadable'],
    [{ ok: false, reason: 'unreadable' }, 'unreadable'],
    [{ ok: true, text: '<html>Log in</html>' }, 'unreadable'],
    [{ ok: true, text: feedText().replace('https://talkweaver.app/download#mac', 'https://evil.example/') }, 'unreadable'],
  ]
  for (const [answer, outcome] of cases) {
    const h = harness()
    await h.checker.checkNow() // a good answer first
    const before = h.state.latest
    h.nextAnswer(answer)
    const snap = await h.checker.checkNow()
    assert.equal(snap.state.lastResult, outcome)
    assert.deepEqual(snap.state.latest, before, 'what was known stays')
    assert.equal(snap.mark.version, '0.42.0', 'a failed check does not take the mark away')
  }
  const h = harness({ fetchFeed: async () => { throw new Error('boom') } })
  assert.equal((await h.checker.checkNow()).state.lastResult, 'unreachable')
  const failing = harness()
  failing.nextAnswer({ ok: false, reason: 'unreachable' })
  failing.checker.start()
  failing.now += FIRST_CHECK_DELAY_MS
  await failing.fire()
  assert.equal(failing.live().ms, CHECK_INTERVAL_MS, 'the next try is a day later')
})

await test('results: newer, equal, older; a preview against its own release', async () => {
  const h = harness()
  assert.equal((await h.checker.checkNow()).state.lastResult, 'newer')
  h.nextAnswer({ ok: true, text: feedText('0.41.0') })
  const equal = await h.checker.checkNow()
  assert.equal(equal.state.lastResult, 'current')
  assert.equal(equal.mark, null)
  h.nextAnswer({ ok: true, text: feedText('0.40.0') })
  assert.equal((await h.checker.checkNow()).state.lastResult, 'current')
  const preview = harness({ running: '0.42.0-preview.3', source: 'preview' })
  const snap = await preview.checker.checkNow()
  assert.equal(snap.state.lastResult, 'newer', '0.42.0 is newer than 0.42.0-preview.3')
  assert.equal(snap.mark.version, '0.42.0')
  preview.nextAnswer({ ok: true, text: feedText('0.41.0') })
  assert.equal((await preview.checker.checkNow()).mark, null, 'a preview is not told about older versions')
})

await test('skip, Not now, Stop skipping', async () => {
  const h = harness()
  await h.checker.checkNow()
  assert.ok(h.checker.snapshot().mark)
  h.checker.notNow()
  assert.equal(h.checker.snapshot().mark, null, 'Not now hides the mark')
  h.now += CHECK_INTERVAL_MS - 1
  assert.equal(h.checker.snapshot().mark, null)
  h.now += 2
  assert.ok(h.checker.snapshot().mark, 'back after the next daily check')
  h.checker.skip('0.42.0')
  assert.equal(h.checker.snapshot().mark, null)
  h.nextAnswer({ ok: true, text: feedText('0.42.1') })
  assert.equal((await h.checker.checkNow()).mark.version, '0.42.1', 'a later version is marked again')
  h.nextAnswer({ ok: true, text: feedText('0.42.0') })
  await h.checker.checkNow()
  assert.equal(h.checker.snapshot().mark, null, 'the skipped version stays skipped')
  h.checker.stopSkipping()
  assert.equal(h.checker.snapshot().mark.version, '0.42.0', 'Stop skipping brings the mark back at once')
  h.checker.notNow()
  await h.checker.checkNow()
  assert.ok(h.checker.snapshot().mark, 'a fresh answer ends Not now')
})

await test('Check for Updates…: up to date, a new version, could not check, the Store', async () => {
  const h = harness()
  h.nextAnswer({ ok: true, text: feedText('0.41.0') })
  const current = answerView((await h.checker.checkNow()).state, ctx(h.checker.snapshot()))
  assert.deepEqual([current.tone, current.title, current.detail, current.action], ['good', 'You have the newest version.', 'TalkWeaver 0.41.0 is the latest. Checked just now.', null])

  const newer = answerView((await h.checker.checkNow()).state, ctx(h.checker.snapshot()))
  assert.deepEqual([newer.tone, newer.title, newer.detail, newer.action, newer.whatsNew, newer.version], ['new', 'TalkWeaver 0.42.0 is available.', 'You have 0.41.0.', 'download', true, '0.42.0'])

  h.checker.skip('0.42.0')
  const skipped = answerView(h.state, ctx(h.checker.snapshot()))
  assert.equal(skipped.action, 'stop-skipping', 'a deliberate check shows a skipped version, with Stop skipping')
  assert.equal(skipped.title, 'TalkWeaver 0.42.0 is available.')

  h.nextAnswer({ ok: false, reason: 'unreachable' })
  const offline = answerView((await h.checker.checkNow()).state, ctx(h.checker.snapshot(), T0 + 3 * 86_400_000))
  assert.equal(offline.tone, 'warn')
  assert.equal(offline.title, 'Could not check for updates.')
  assert.match(offline.detail, /talkweaver\.app could not be reached\. This computer may be offline\. Last successful check: /)
  assert.equal(offline.action, 'try-again')
  h.nextAnswer({ ok: true, text: 'not json' })
  const odd = answerView((await h.checker.checkNow()).state, ctx(h.checker.snapshot()))
  assert.match(odd.detail, /answered, but not with a version list/)

  const store = harness({ source: 'store', platform: 'win32' })
  const view = answerView((await store.checker.checkNow()).state, ctx(store.checker.snapshot()))
  assert.deepEqual([view.tone, view.title, view.action], ['store', 'Updates come from the Microsoft Store.', 'open-store'])
  assert.match(view.detail, /This copy does not check talkweaver\.app\./)
  assert.equal(store.requests, 0)
})

await test('the Settings card: every state of frames 03, 04 and 06', async () => {
  const h = harness()
  const base = () => { const s = h.checker.snapshot(); return { state: s.state, ctx: ctx(s) } }
  let { state, ctx: c } = base()
  assert.equal(cardView(state, c).title, 'Not checked yet.')
  assert.equal(cardView(state, { ...c, checking: true }).title, 'Checking talkweaver.app…')
  assert.equal(cardView(state, { ...c, enabled: false }).title, 'TalkWeaver does not check for new versions.')
  assert.equal(cardView(state, { ...c, enabled: false }).detail, 'Check for updates still checks once.')
  h.nextAnswer({ ok: true, text: feedText('0.41.0') })
  await h.checker.checkNow(); ;({ state, ctx: c } = base())
  const ok = cardView(state, { ...c, now: T0 + 60_000 * 5 })
  assert.deepEqual([ok.title, ok.detail, ok.action], ['You have the newest version.', 'Last checked today at 09:12.', 'check'])
  await h.checker.checkNow(); ;({ state, ctx: c } = base())
  const newer = cardView(state, c)
  assert.deepEqual([newer.title, newer.action], ['TalkWeaver 0.42.0 is available. You have 0.41.0.', 'download'])
  h.checker.skip('0.42.0'); ;({ state, ctx: c } = base())
  const skipped = cardView(state, c)
  assert.deepEqual([skipped.title, skipped.detail, skipped.action], ['You skipped 0.42.0.', 'You will hear about the next version after it.', 'stop-skipping'])
  h.nextAnswer({ ok: false, reason: 'unreachable' })
  await h.checker.checkNow(); ;({ state, ctx: c } = base())
  const offline = cardView(state, c)
  assert.equal(offline.title, 'Could not reach talkweaver.app.')
  assert.match(offline.detail, /^This computer may be offline\. TalkWeaver will try again tomorrow\. Last successful check: /)
  assert.equal(offline.action, 'try-again')
  h.nextAnswer({ ok: true, text: '{}' })
  await h.checker.checkNow(); ;({ state, ctx: c } = base())
  const unreadable = cardView(state, c)
  assert.deepEqual([unreadable.title, unreadable.detail], ['talkweaver.app answered, but not with a version list.', 'Nothing was changed. TalkWeaver will try again tomorrow.'])
  assert.equal(cardView(state, { ...c, source: 'store' }), null, 'a Store copy has no New versions card')
  assert.equal(cardView(state, { ...c, source: 'development' }).action, null)
})

await test('About lines: version, platform and where the copy came from', () => {
  assert.deepEqual(aboutLines({ identity: UPDATE_IDENTITY, arch: 'arm64', running: '0.41.0', platform: 'darwin', source: 'website' }), { version: 'Version 0.41.0', where: 'Mac (Apple silicon) · downloaded from talkweaver.app' })
  assert.deepEqual(aboutLines({ identity: UPDATE_IDENTITY, arch: 'arm64', running: '0.42.0', platform: 'win32', source: 'store' }), { version: 'Version 0.42.0', where: 'Windows · installed from the Microsoft Store' })
  assert.deepEqual(aboutLines({ identity: UPDATE_IDENTITY, arch: 'arm64', running: '0.42.0-preview.3', platform: 'darwin', source: 'preview' }), { version: 'Version 0.42.0, preview 3', where: 'Mac (Apple silicon) · preview built for testing' })
  assert.equal(copySource({ packaged: true, store: true, running: '0.42.0' }), 'store')
  assert.equal(copySource({ packaged: false, store: false, running: '0.42.0' }), 'development')
  assert.equal(copySource({ packaged: true, store: false, running: '0.42.0-preview.3' }), 'preview')
  assert.equal(copySource({ packaged: true, store: false, running: '0.42.0' }), 'website')
})

await test('the marks read as drawn', async () => {
  const h = harness()
  const snap = await h.checker.checkNow()
  assert.equal(availableMarkText(snap.mark), '0.42.0 is available')
  assert.equal(updatedMarkText({ version: '0.42.0', from: '0.41.0' }), 'Updated to 0.42.0 · What’s new'.replace('’', "'"))
  assert.equal(dateText('2026-11-12'), '12 November 2026')
})

await test('time words: just now, today, yesterday, a weekday, a date', () => {
  const at = (d, h, m) => new Date(2026, 10, d, h, m).getTime()
  const now = at(12, 9, 12)
  assert.equal(whenText(at(12, 9, 5), now), 'today at 09:05')
  assert.equal(whenText(at(11, 18, 40), now), 'yesterday at 18:40')
  assert.equal(whenText(at(9, 9, 5), now), 'Monday at 09:05')
  assert.equal(whenText(at(1, 9, 5), now), '1 November 2026 at 09:05')
})

await test('What’s new: an update starts the mark; a first install, a downgrade and a clean run do not', () => {
  const day = (d) => new Date(2026, 10, d, 10, 0).getTime()
  // first install: no last version run and no vaults yet
  assert.equal(whatsNewMark(noteLaunch({}, '0.41.0', day(1), false), '0.41.0'), null)
  // 0.41 recorded no last version run: a configuration that already holds vaults is an upgrade
  const upgraded = noteLaunch({}, '0.42.0', day(1), true)
  assert.deepEqual(whatsNewMark(upgraded, '0.42.0'), { version: '0.42.0', from: null })
  // an ordinary update
  const updated = noteLaunch({ lastVersionRun: '0.41.0' }, '0.42.0', day(1), true)
  assert.deepEqual(whatsNewMark(updated, '0.42.0'), { version: '0.42.0', from: '0.41.0' })
  assert.equal(updated.lastVersionRun, '0.42.0')
  // a downgrade
  const down = noteLaunch({ lastVersionRun: '0.42.0' }, '0.41.0', day(1), true)
  assert.equal(whatsNewMark(down, '0.41.0'), null)
  assert.equal(down.lastVersionRun, '0.41.0')
  // an equal launch with no mark changes nothing
  const same = { lastVersionRun: '0.42.0' }
  assert.equal(noteLaunch(same, '0.42.0', day(2), true), same)
  // a preview built over a release counts as an update from it, and is held to the notes shipped
  assert.deepEqual(whatsNewMark(noteLaunch({ lastVersionRun: '0.41.0' }, '0.42.0-preview.1', day(1), true), '0.42.0-preview.1'), { version: '0.42.0-preview.1', from: '0.41.0' })
  // the mark goes after seven days on which the app was opened
  let state = updated
  for (let d = 2; d <= WHATS_NEW_DAYS; d += 1) { state = noteLaunch(state, '0.42.0', day(d), true); assert.ok(whatsNewMark(state, '0.42.0'), `still there on day ${d}`) }
  state = noteLaunch(state, '0.42.0', day(WHATS_NEW_DAYS + 1), true)
  assert.equal(whatsNewMark(state, '0.42.0'), null, 'gone after seven days of use')
  assert.equal(localDay(day(5)), '2026-11-05')
})

await test('What’s new through the checker: shown only with notes shipped, gone when clicked', async () => {
  const h = harness()
  h.state = { lastVersionRun: '0.40.0' }
  h.checker.start()
  assert.deepEqual(h.checker.snapshot().whatsNew, { version: '0.41.0', from: '0.40.0' })
  h.checker.dismissWhatsNew()
  assert.equal(h.checker.snapshot().whatsNew, null, 'gone when clicked')
  assert.equal(h.state.lastVersionRun, '0.41.0')
  const noNotes = harness()
  noNotes.state = { lastVersionRun: '0.40.0' }
  noNotes.config.notes = new Set()
  noNotes.checker.start()
  assert.equal(noNotes.checker.snapshot().whatsNew, null, 'no notes file, no mark')
  const first = harness()
  first.config.vaults = false
  first.checker.start()
  assert.equal(first.checker.snapshot().whatsNew, null, 'a first install shows no mark')
  const presenting = harness()
  presenting.state = { lastVersionRun: '0.40.0' }
  presenting.checker.start()
  presenting.config.presenting = true
  assert.ok(presenting.checker.snapshot().whatsNew, 'the main window’s status bar keeps it while presenting')
})

await test('stored state is read tolerantly and re-validated', () => {
  assert.deepEqual(readUpdateState(null), {})
  assert.deepEqual(readUpdateState('x'), {})
  assert.deepEqual(readUpdateState({ lastCheckAt: 'soon', skippedVersion: 'x', latest: { version: '9.9.9' }, whatsNew: 5, lastResult: 'weird' }), {})
  const tampered = JSON.parse(feedText()).latest
  tampered.download.mac = 'https://evil.example/x'
  assert.equal(readUpdateState({ latest: tampered }).latest, undefined, 'a feed entry in the config file is validated again')
  assert.equal(readUpdateState({ latest: JSON.parse(feedText()).latest }).latest.version, '0.42.0')
})

await test('notes files: bullets with an optional bold title', () => {
  assert.deepEqual(parseWhatsNew('# 0.42.0\n\n- **Copy slides.** Drag a slide from another vault.\n- A plain item.\n\nnot an item\n'), [
    { title: 'Copy slides', text: 'Drag a slide from another vault.' },
    { title: null, text: 'A plain item.' },
  ])
})

await test('Check for Updates… and What’s new are registry commands in the palette and the Help menu, with no default key', () => {
  for (const [id, label] of [['check-for-updates', 'Check for Updates…'], ['whats-new', 'What’s new in TalkWeaver'.replace('’', "'")]]) {
    const command = COMMAND_REGISTRY.find((c) => c.id === id)
    assert.ok(command, id)
    assert.equal(command.label, label)
    assert.equal(command.palette.visible, true)
    assert.deepEqual(command.menu.path, ['Help'])
    const shortcut = SHORTCUT_REGISTRY.find((s) => s.id === command.shortcutId)
    assert.ok(shortcut?.unbound, `${id} has no default key and can be rebound`)
  }
  assert.ok(menuCommands().some((c) => c.id === 'check-for-updates'))
})

await test('the files: one place makes the request, nothing is run or installed, no other site is named', () => {
  const ts = require('typescript')
  const WIRING = 'src/main/update-notices.ts'
  const IDENTITY = 'src/shared/update-identity.ts'
  const ALLOWED_HOSTS = new Set(['talkweaver.app', 'apps.microsoft.com'])
  const walk = (dir) => readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`])
  const all = walk('src')
  const codeFiles = all.filter((f) => /\.(ts|tsx|mjs|js)$/.test(f))
  const kind = (f) => (f.endsWith('.tsx') ? ts.ScriptKind.TSX : f.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS)
  const nodesOf = (f) => {
    const sf = ts.createSourceFile(f, readFileSync(join(REPO, f), 'utf8'), ts.ScriptTarget.Latest, true, kind(f))
    const out = []
    const visit = (n) => { out.push(n); ts.forEachChild(n, visit) }   // comments are trivia: never nodes
    visit(sf)
    return { sf, nodes: out }
  }
  /** Every piece of text the code carries: string literals, template pieces, JSX text. */
  const textOf = (n) => (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || n.kind === ts.SyntaxKind.JsxText) ? n.text ?? '' : null
  const parsed = new Map(codeFiles.map((f) => [f, nodesOf(f)]))
  const importsUpdates = (nodes) => nodes.some((n) => (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && /@app-patterns\/updates|update-identity/.test(n.moduleSpecifier.text))
  const files = new Set(['src/main/app-menu.ts', WIRING, IDENTITY])
  for (const [f, { nodes }] of parsed) if (importsUpdates(nodes)) files.add(f)
  for (const f of ['src/main/index.ts', 'src/preload/index.ts', 'src/preload/settings.ts']) assert.ok(files.has(f), `${f} is a listed update consumer`)

  // index.ts and the preloads are large shared files that legitimately write and spawn elsewhere: they get the feed-address and download checks only (they name other sites and make other requests for other features, so the guarantee there is that none of them can reach the feed address).
  const SHARED = new Set(['src/main/index.ts', 'src/preload/index.ts', 'src/preload/settings.ts'])
  const FORBIDDEN = /child_process|execFile|execSync|spawn|autoUpdater|electron-updater|quitAndInstall|writeFile|createWriteStream|downloadURL|downloadUpdate|openPath/
  const REQUEST_CALL = /^(new )?(net\.(request|fetch)|fetch|(https?|http2)\.(get|request)|[\w.]*\.fetch|[\w.]*fetchFromPartition|XMLHttpRequest)$/
  const hostsIn = (text) => [...text.matchAll(/(?:https?|wss?|ftp):\/\/[a-z0-9@\[][^\s'"`<>)\\]+/gi)].map((m) => { try { return new URL(m[0]).hostname } catch { return m[0] } })
  const feedHits = []
  for (const f of codeFiles) {
    const { nodes, sf } = parsed.get(f)
    const listed = files.has(f)
    for (const n of nodes) {
      if (ts.isIdentifier(n) && (n.text === 'FEED_URL' || n.text === 'feedUrl')) feedHits.push(f)
      const text = textOf(n)
      if (text !== null && /https?:\/\/[^\s'"`]*updates\.json/.test(text)) feedHits.push(f)   // the address; the Settings sentence naming the file is wording
      if (!listed) continue
      if (!SHARED.has(f) && (ts.isIdentifier(n) || text !== null)) assert.ok(!FORBIDDEN.test(text ?? n.text), `${f} runs, writes or downloads nothing`)
      if (text !== null) {
        if (!SHARED.has(f)) assert.ok(!/persist:/.test(text), `${f} stores nothing the request receives`)
        if (!SHARED.has(f)) for (const host of hostsIn(text)) assert.ok(ALLOWED_HOSTS.has(host), `${f} names no other site (${host})`)
      }
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const callee = n.expression.getText(sf)
        if (/(^|\.)download$/.test(callee)) assert.equal(n.arguments?.length ?? 0, 0, `${f}: ${callee}(…) takes no address`)
        if (f !== WIRING && !SHARED.has(f)) assert.ok(!REQUEST_CALL.test((ts.isNewExpression(n) ? 'new ' : '') + callee), `${f} makes no request of its own (${callee})`)
      }
    }
  }
  for (const f of new Set(feedHits)) assert.ok(f === WIRING || f === IDENTITY, `${f} does not reach the feed`)
  assert.ok(feedHits.includes(WIRING) && feedHits.includes(IDENTITY), 'the feed address is used where expected')
  // stylesheets can name sites too (url(…))
  for (const f of all.filter((x) => x.endsWith('.css') && /update/i.test(x))) {
    const css = readFileSync(join(REPO, f), 'utf8')
    for (const host of hostsIn(css)) assert.ok(ALLOWED_HOSTS.has(host), `${f} names no other site (${host})`)
    assert.ok(!/updates\.json/.test(css), `${f} does not reach the feed`)
  }
  const main = readFileSync(join(REPO, WIRING), 'utf8')
  // the windows send no address: every link handed to the browser is built in main
  assert.ok(/ipcMain\.handle\('updates:download', \(\)/.test(main), 'Download takes no argument')
  assert.ok(/ipcMain\.handle\('updates:open-store', \(\)/.test(main), 'Open in Microsoft Store takes no argument')
  assert.ok(!/ipcMain\.handle\('updates:(download|open-store)', \([^)]/.test(main), 'neither handler declares a parameter')
  assert.ok(readFileSync(join(REPO, IDENTITY), 'utf8').includes('https://talkweaver.app/updates.json'), 'the feed address lives in the identity file')
})

await test('a rejected notes read does not escape the Updated mark: loadNotes resolves to [] so the notes tab opens', async () => {
  const ts = require('typescript')
  const src = readFileSync(join(REPO, 'src/renderer/src/lib/updateNotices.ts'), 'utf8')
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const dir = join(REPO, 'node_modules/.cache/tw-update-test')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'updateNotices.mjs')
  writeFileSync(file, js)
  const { updateActions } = await import(pathToFileURL(file).href)
  const actions = updateActions({ whatsNew: () => Promise.reject(new Error('ipc closed')) })
  assert.deepEqual(await actions.loadNotes('1.0.0'), [])
  assert.equal(await updateActions({ whatsNew: async () => null }).loadNotes('1.0.0'), null)
  assert.deepEqual(await updateActions({ whatsNew: async () => ({ items: [1] }) }).loadNotes('1.0.0'), [1])
})

await test('the host uses the shared bounded fetcher and retains the filtered in-memory session', () => {
  const main = readFileSync(join(REPO, 'src/main/update-notices.ts'), 'utf8')
  assert.match(main, /createElectronFeedFetcher\(UPDATE_IDENTITY/)
  assert.match(main, /session: \{ fromPartition: \(\) => checkSession\(\) \}/)
  assert.match(main, /session.fromPartition\(UPDATES_PARTITION, \{ cache: false \}\)/)
  assert.match(main, /installLocalAddressFilter\(updatesSession\)/)
  assert.match(main, /windowsStore/)
  assert.doesNotMatch(main, /autoUpdater|downloadUpdate|quitAndInstall/)
})

await test('the loopback test path destroys the request on timeout and caps every answer, a non-200 one too', () => {
  const main = readFileSync(join(REPO, 'src/main/update-notices.ts'), 'utf8')
  const stand = main.slice(main.indexOf('function fetchStandIn'), main.indexOf('const notesDir'))
  assert.ok(/if \(!answer\.ok\) \{ try \{ request\?\.destroy\(\)/.test(stand), 'every failure, a timeout included, destroys the request')
  assert.ok(!/response\.resume\(\)/.test(stand), 'a non-200 body is not drained unbounded')
  assert.ok(/bytes > FEED_REQUEST\.maxBytes/.test(stand) && /const ok = response\.statusCode === 200/.test(stand), 'the size cap applies whatever the status')
})



await test('About and updates lives in the shared Settings window and its preference is searchable and resettable', () => {
  const read = (rel) => readFileSync(join(REPO, rel), 'utf8')
  assert.ok(read('src/renderer/src/settings-main.tsx').includes('AboutUpdatesSettings'))
  assert.ok(read('src/preload/settings.ts').includes("'updates:get'"))
  assert.ok(read('src/shared/settings-schema.ts').includes("key: 'updates.checkForNewVersions', label:"))
  assert.ok(read('src/shared/bridle-commands.ts').includes("'app.check-for-updates': 'check-for-updates'"))
})

await test('subscribers receive the check-start state before the result', async () => {
  const h = harness();
  await h.checker.checkNow();
  assert.equal(h.told[0].checking, true);
  assert.equal(h.told.at(-1).checking, false);
})

await test('release notes use the validated feed link for the matching version, otherwise the built link', async () => {
  const latest = readUpdateState({ latest: JSON.parse(feedText()).latest }).latest
  latest.notes = 'https://talkweaver.app/release-notes/custom'
  assert.equal(notesLinkFor(latest, '0.42.0'), latest.notes)
  assert.equal(notesLinkFor(latest, '0.41.0'), 'https://talkweaver.app/whats-new#0.41.0')
  assert.equal(notesLinkFor(undefined, '0.41.0'), 'https://talkweaver.app/whats-new#0.41.0')
  assert.equal(notesLinkFor(latest, '../bad'), null)
  const host = readFileSync(join(REPO, 'src/main/settings-update-menu.ts'), 'utf8')
  assert.match(host, /buildMenuTemplate/)
  assert.match(host, /item as \{ id\?: string \}\)\.id === id/)
  assert.doesNotMatch(host, /const clone|label === 'Check for Updates/)
})

console.log(`update check: ${passed} checks passed`)

await import('./lib/update-notices-dom-checks.mjs')
process.exit(0) // The bundled React scheduler keeps MessagePorts alive after jsdom is closed.
