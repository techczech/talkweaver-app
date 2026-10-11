// Onboarding 0.38.1 ticket 10: the Guide in the presenter, main's side (src/main/guide-present.ts,
// src/shared/guide-present.ts). No Electron, no browser:
//   - who may ask: only a presenter window main opened gets the Present chapter or may record its
//     column open; any other sender gets null; a subframe is refused by the app's frame guard
//     (applyMainFrameOnly) before the handlers run;
//   - what may be sent: from a deck window, only an id on the registries' finite presenter list
//     (presenter.* shortcut ids, presenter-palette.* entries) reaches the store (review round 1);
//   - what is sent back: the Present chapter's rows and counts only (never the learn record);
//   - the column: main only records open or closed (a strict boolean) for a reload; it holds no
//     window and so can never resize or move one (review round 1);
//   - the bridge, one way each: a presenter command reported once produces one progress change, and
//     the state pushed to the presenter is the store's.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const guidePresentMain = await import(new URL('../src/main/guide-present.ts', import.meta.url))
const { PresenterGuideHost, registerPresenterGuideIpc, acceptCommandRan } = guidePresentMain
const { GUIDE_COLUMN_WIDTH, GUIDE_COLUMN_MIN_WIDTH, GUIDE_COLUMN_GAP, GUIDE_COLUMN_CSS_WIDTH, PRESENTER_COMMAND_IDS, isPresenterCommandId, presentGuideView, isPresentGuideView, guideChipCount } = await import(new URL('../src/shared/guide-present.ts', import.meta.url))
const { PRESENTER_PALETTE } = await import(new URL('../src/shared/presenter-palette.ts', import.meta.url))
const { applyMainFrameOnly } = await import(new URL('../src/main/ipc-main-frame-only.ts', import.meta.url))
const { GuideLearnStore } = await import(new URL('../src/main/guide-learn-store.ts', import.meta.url))
const { chapterFor } = await import(new URL('../src/shared/guide-chapters.ts', import.meta.url))
const { emptyGuideLearn } = await import(new URL('../src/shared/guide-learn.ts', import.meta.url))
const { SHORTCUT_REGISTRY } = await import(new URL('../src/shared/shortcut-registry.ts', import.meta.url))

let passed = 0
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`PASS  ${name}`) } catch (error) { console.error(`FAIL  ${name}`); throw error }
}
const chordOf = (id) => SHORTCUT_REGISTRY.find((row) => row.id === id)?.keys ?? ''

/** Electron's ipcMain as far as handle / invoke go (as scripts/test-ipc-main-frame-only.mjs fakes it). */
function fakeIpcMain() {
  const handlers = new Map()
  return {
    handle(channel, fn) { if (handlers.has(channel)) throw new Error(`second handler for ${channel}`); handlers.set(channel, fn) },
    handleOnce(channel, fn) { this.handle(channel, fn) },
    removeHandler(channel) { handlers.delete(channel) },
    on() { return this }, once() { return this }, removeListener() { return this },
    async invoke(channel, event, ...args) { const fn = handlers.get(channel); if (!fn) throw new Error(`No handler for ${channel}`); return fn(event, ...args) },
    channels: () => [...handlers.keys()]
  }
}
function sender(id) {
  const mainFrame = { name: 'main' }
  const s = { id, mainFrame }
  return { main: { sender: s, senderFrame: mainFrame }, sub: { sender: s, senderFrame: { name: 'slide preview' } } }
}
console.log('presenter Guide: IPC surface, column record, view, bridge')

await test('the column takes clamp(320px, 24vw, 400px) inside the page; nothing in main can move a window', () => {
  assert.equal(GUIDE_COLUMN_WIDTH, 400)
  assert.equal(GUIDE_COLUMN_MIN_WIDTH, 320)
  assert.equal(GUIDE_COLUMN_GAP, 14)
  assert.equal(GUIDE_COLUMN_CSS_WIDTH, 'clamp(320px, 24vw, 400px)')
  // Review round 1: the widen / shift / restore capability is removed, not guarded.
  for (const gone of ['widenedBounds', 'restoredBounds', 'PRESENTER_MIN_WIDTH']) assert.ok(!(gone in guidePresentMain), `${gone} is gone`)
  const source = readFileSync(new URL('../src/main/guide-present.ts', import.meta.url), 'utf8')
  assert.ok(!/setBounds|getBounds|workArea|isMaximized|isFullScreen/.test(source), 'main\'s Guide host holds no window geometry')
  const preload = readFileSync(new URL('../src/preload/present-guide.ts', import.meta.url), 'utf8')
  assert.ok(!/widenedBy|full ===|freezeColumns|gridTemplateColumns\s*=/.test(preload), 'the page never freezes the grid for a widened window')
})

await test('a presenter command id is one of the registries\' finite presenter list', () => {
  const shortcutIds = SHORTCUT_REGISTRY.filter((row) => row.id.startsWith('presenter.')).map((row) => row.id)
  const paletteIds = PRESENTER_PALETTE.flatMap(([, entries]) => entries.map((entry) => `presenter-palette.${entry.id}`))
  assert.ok(shortcutIds.length > 30 && paletteIds.length > 30)
  assert.deepEqual([...PRESENTER_COMMAND_IDS].sort(), [...new Set([...shortcutIds, ...paletteIds])].sort(), 'exactly the presenter shortcut ids and palette entries')
  for (const id of [...shortcutIds, ...paletteIds]) assert.ok(isPresenterCommandId(id), id)
  for (const id of ['presenter-palette.guide', 'presenter.next', 'presenter-palette.reset-timer', 'presenter-palette.notes-camera-column']) assert.ok(isPresenterCommandId(id), id)
  // Well-formed but made up: dropped (a deck script could otherwise mint unlimited ids).
  for (const id of ['presenter.not-a-command', 'presenter-palette.not-an-entry', 'presenter.abc123', 'presenter-palette.x', 'format-bold', 'browser.delete-talk', 'delete-slide', 'presenter.', 'presenter..next', 'presenter.Next', 'presenter.next ', 'presenter.next/../x', 'presenter-palette.', '__proto__', 'constructor', 'presenter.next\u0000', `presenter.${'a'.repeat(60)}`, '', null, 42, { id: 'presenter.next' }, ['presenter.next']]) {
    assert.ok(!isPresenterCommandId(id), JSON.stringify(id))
  }
  for (let i = 0; i < 200; i++) {
    const made = `presenter.${Math.random().toString(36).slice(2, 12)}`
    if (!shortcutIds.includes(made)) assert.ok(!isPresenterCommandId(made), made)
  }
})

await test('who may report: an app window anything; a deck window main opened only a presenter id; anyone else nothing', () => {
  assert.ok(acceptCommandRan({ appWindow: true, deckWindow: false }, 'delete-slide'))
  assert.ok(acceptCommandRan({ appWindow: false, deckWindow: true }, 'presenter.next'))
  assert.ok(!acceptCommandRan({ appWindow: false, deckWindow: true }, 'delete-slide'), 'a deck cannot tick a deleting command')
  assert.ok(!acceptCommandRan({ appWindow: false, deckWindow: true }, 'browser.delete-talk'))
  assert.ok(!acceptCommandRan({ appWindow: false, deckWindow: true }, 'presenter.Next'))
  assert.ok(!acceptCommandRan({ appWindow: false, deckWindow: true }, 'presenter.not-a-command'), 'a well-formed id that is not on the list')
  assert.ok(!acceptCommandRan({ appWindow: false, deckWindow: true }, 'presenter-palette.not-an-entry'))
  assert.ok(acceptCommandRan({ appWindow: false, deckWindow: true }, 'presenter-palette.reset-timer'))
  assert.ok(!acceptCommandRan({ appWindow: false, deckWindow: false }, 'presenter.next'), 'a window main did not open (an audience, a board, a deck opened on its own)')
})

await test('main wires the channels through the frame-guarded ipcMain, with the sender checks named', () => {
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.ok(main.indexOf('applyMainFrameOnly(ipcMain)') < main.indexOf('registerPresenterGuideIpc(ipcMain, presenterGuide)'), 'the guard is applied before the handlers are registered')
  assert.ok(main.includes("if (presentWindows.get(senderId)?.mode !== 'presenter') return undefined"), 'only a presenter main opened')
  assert.ok(main.includes('acceptCommandRan({ appWindow, deckWindow: presentWindows.has(event.sender.id) }, id)'), 'command-ran from a deck: presenter ids only')
  assert.ok(main.includes("const hit = appWindow && typeof outlinePath === 'string'"), 'a deck window cannot name a talk for decision 12')
  assert.ok(main.includes("ipcMain.handle('guide:get-learn', (event) => (isAppWindow(event.sender.id) ? guideLearn.read() : null))"), 'the learn record goes to app windows only')
  assert.ok(main.includes("isAppWindow(win.webContents.id)) win.webContents.send('guide:learn-changed', record)"), 'its broadcast too')
  assert.ok(!/broadcastToWindows\('guide:learn-changed'/.test(main), 'never to every window')
  assert.ok(main.includes("win.webContents.send('guide:present-chapter-changed', presenterGuide.chapter(wcId))"), 'presenters get their chapter')
  assert.ok(main.includes('presenterGuide.forget(deckWcId)'), 'a closed presenter is forgotten')
  assert.ok(main.includes('isPresenter: (senderId) => presenterDeck(senderId) !== undefined'), 'the host is told only whether a sender is a presenter, never handed its window')
})

await test('the read path and the column answer a presenter main opened; null for every other sender and argument', async () => {
  const ipc = fakeIpcMain()
  const logs = []
  applyMainFrameOnly(ipc, { log: (m) => logs.push(m) })
  const view = presentGuideView(chapterFor(new GuideLearnStore({ read: () => null, write: () => {} }).chapters(), 'Present'), emptyGuideLearn(), chordOf, false)
  const host = new PresenterGuideHost({ isPresenter: (id) => id === 7, view: (id) => (id === 7 ? view : null), showChapterList: () => true, hideButton: () => {} })
  registerPresenterGuideIpc(ipc, host)
  assert.deepEqual(ipc.channels().sort(), ['guide:present-all-chapters', 'guide:present-chapter', 'guide:present-column', 'guide:present-hide-button'])
  const presenter = sender(7)
  const other = sender(9)
  assert.deepEqual(await ipc.invoke('guide:present-chapter', presenter.main), { view, open: false })
  assert.equal(await ipc.invoke('guide:present-chapter', other.main), null, 'an editor, audience, board or plain deck window')
  assert.equal(await ipc.invoke('guide:present-column', other.main, true), null)
  assert.ok(!host.isOpen(9), 'another sender records nothing')
  for (const bad of ['true', 1, 0, null, undefined, { open: true }]) assert.equal(await ipc.invoke('guide:present-column', presenter.main, bad), null, `argument ${JSON.stringify(bad)}`)
  assert.ok(!host.isOpen(7), 'a non-boolean records nothing')
  // A subframe of the presenter (a slide preview, an embedded page) is refused before the handler runs.
  await assert.rejects(ipc.invoke('guide:present-chapter', presenter.sub), /refused call on guide:present-chapter/)
  await assert.rejects(ipc.invoke('guide:present-column', presenter.sub, true), /refused call on guide:present-column/)
  assert.ok(!host.isOpen(7))
  assert.equal(logs.length, 2)
})

await test('All chapters and Hide the button: one-way requests from a presenter main opened, no argument, nothing sent back', async () => {
  const ipc = fakeIpcMain()
  const logs = []
  applyMainFrameOnly(ipc, { log: (m) => logs.push(m) })
  const view = presentGuideView(chapterFor(new GuideLearnStore({ read: () => null, write: () => {} }).chapters(), 'Present'), emptyGuideLearn(), chordOf, false)
  let on = true
  const shown = []
  let hidden = 0
  const host = new PresenterGuideHost({
    isPresenter: (id) => id === 7, view: () => (on ? view : null),
    showChapterList: (id) => { shown.push(id); return true },
    hideButton: () => { hidden += 1; on = false }
  })
  registerPresenterGuideIpc(ipc, host)
  const presenter = sender(7)
  const other = sender(9)
  // The editor window is asked once, with the presenter's id only; the answer is a boolean, never chapter data.
  assert.equal(await ipc.invoke('guide:present-all-chapters', presenter.main), true)
  assert.deepEqual(shown, [7])
  assert.equal(await ipc.invoke('guide:present-all-chapters', other.main), false, 'an editor, audience, board or plain deck window')
  assert.equal(await ipc.invoke('guide:present-all-chapters', presenter.main, 'Share'), false, 'a payload is refused: the presenter cannot name a chapter')
  assert.equal(await ipc.invoke('guide:present-all-chapters', presenter.main, { task: 'Share' }), false)
  assert.deepEqual(shown, [7], 'only the plain request reached the editor')
  await assert.rejects(ipc.invoke('guide:present-all-chapters', presenter.sub), /refused call on guide:present-all-chapters/)
  assert.equal(await ipc.invoke('guide:present-hide-button', other.main), false)
  assert.equal(await ipc.invoke('guide:present-hide-button', presenter.main, false), false, 'no argument allowed')
  assert.equal(hidden, 0)
  await assert.rejects(ipc.invoke('guide:present-hide-button', presenter.sub), /refused call on guide:present-hide-button/)
  assert.equal(await ipc.invoke('guide:present-hide-button', presenter.main), true)
  assert.equal(hidden, 1)
  // With the Guide button off the presenter has no Guide at all: neither request does anything.
  assert.equal(await ipc.invoke('guide:present-all-chapters', presenter.main), false)
  assert.equal(await ipc.invoke('guide:present-hide-button', presenter.main), false)
  assert.equal(hidden, 1)
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.ok(main.includes('const win = targetEditorFor(presentWindows.get(senderId)?.outlinePath ?? null)') && main.includes('win.webContents.send(SHOW_CHAPTER_LIST_CHANNEL)'), 'main focuses the editor window and sends a bare signal')
  assert.ok(main.includes('hideButton: () => { setGuideButtonVisible(false) }'), 'the × turns off the one Settings switch')
})

await test('the presenter is sent the Present chapter only: rows, counts, the practice line, the live count', () => {
  const store = new GuideLearnStore({ read: () => null, write: () => {} })
  const present = chapterFor(store.chapters(), 'Present')
  const learn = { ...emptyGuideLearn(), ran: ['presenter.next', 'presenter.font-smaller', 'format-bold', 'presenter.live'], opened: ['Write the outline'] }
  const view = presentGuideView(present, learn, chordOf, true)
  assert.ok(isPresentGuideView(view))
  assert.deepEqual(Object.keys(view).sort(), ['live', 'practice', 'status', 'subgroups', 'total', 'tried'])
  assert.equal(view.total, present.rows.length)
  assert.equal(view.tried, 2, 'Next, and the merged text-size row by its smaller key; not Bold, not the live G')
  assert.equal(view.status, `2 of ${present.rows.length} tried`)
  assert.equal(guideChipCount(view), `2 of ${present.rows.length}`)
  assert.equal(view.live, present.live.length)
  assert.deepEqual(view.practice, { talk: 'Lightning round', section: '06 Present', openNow: true })
  const text = JSON.stringify(view)
  for (const leak of ['format-bold', 'Write the outline', 'presenter.live', 'ran', 'opened', 'finished', 'read']) assert.ok(!text.includes(`"${leak}"`), `no ${leak} in what the presenter receives`)
  const rows = view.subgroups.flatMap((g) => g.rows)
  assert.equal(rows.length, present.rows.length)
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ['id', 'keys', 'label', 'noKey', 'tried'])
  const next = rows.find((r) => r.id === 'presenter.next')
  assert.deepEqual([next.label, next.tried, next.keys], ['Next', true, ['→ Space +3']], 'keys as drawn: the first two and +N')
  assert.deepEqual(rows.find((r) => r.id === 'presenter-palette.guide')?.noKey, true, 'the Guide command is a key-less row of Help and commands (no C since the owner check of 10 Oct)')
  assert.ok(!rows.some((r) => r.id === 'presenter.guide'), 'no presenter.guide key row')
  assert.ok(!rows.some((r) => ['present-window', 'present-audience'].includes(r.id)), 'Presentation window and Audience view are not rows of the Present column')
  assert.ok(view.subgroups.some((g) => g.name === 'Speaker notes'), 'sub-group names as drawn ("(added)" dropped)')
  assert.equal(rows.find((r) => r.id === 'presenter-palette.reset-timer')?.noKey, true)
  assert.equal(rows.find((r) => r.id === 'presenter-palette.notes-off')?.noKey, false, 'a variants row names its variants, no "no key"')
  // A finished chapter reads its date.
  const done = presentGuideView(present, { ...emptyGuideLearn(), ran: present.rows.map((r) => r.id), finished: { Present: Date.UTC(2026, 9, 6, 12) } }, chordOf, false)
  assert.equal(done.status, 'Finished 6 Oct')
  // Anything else is no view.
  for (const bad of [null, {}, { ...view, subgroups: [{ name: 'x', tried: 0, total: 1, rows: [{ id: 'a', label: '<b>', tried: 'yes', keys: [], noKey: false }] }] }, { ...view, practice: null }, { ...view, total: -1 }]) assert.ok(!isPresentGuideView(bad))
})

await test('the column: main records open and closed, strictly; a reload sees it; a closed window is forgotten', () => {
  const view = { tried: 0, total: 1, status: '0 of 1 tried', practice: { talk: 'Lightning round', section: '06 Present', openNow: false }, subgroups: [], live: 0 }
  let on = true
  const host = new PresenterGuideHost({ isPresenter: (id) => id === 3, view: () => (on ? view : null), showChapterList: () => true, hideButton: () => {} })
  assert.deepEqual(host.column(3, true), { open: true })
  assert.deepEqual(host.column(3, true), { open: true }, 'asking twice is the same')
  assert.ok(host.isOpen(3))
  assert.deepEqual(host.chapter(3), { view, open: true }, 'a reload with the column open reports it open')
  on = false
  assert.deepEqual(host.chapter(3), { view: null, open: false }, 'the Guide button off: no column')
  on = true
  assert.deepEqual(host.column(3, false), { open: false })
  assert.deepEqual(host.column(3, false), { open: false })
  assert.deepEqual(host.chapter(3), { view, open: false })
  host.column(3, true)
  host.forget(3)
  assert.deepEqual(host.chapter(3), { view, open: false }, 'a closed window is forgotten')
  assert.equal(host.column(4, true), null, 'not a presenter')
  assert.equal(host.column(3, 'true'), null)
})

await test('the bridge, one way each: a presenter key reported once is one progress change; the pushed state is the store\'s', () => {
  let config = null
  const writes = []
  const store = new GuideLearnStore({ read: () => config, write: (record) => { config = record; writes.push(record) } })
  const present = chapterFor(store.chapters(), 'Present')
  let buttonOn = true
  const host = new PresenterGuideHost({ isPresenter: (id) => id === 7, view: () => (buttonOn ? presentGuideView(present, store.read(), chordOf, false) : null), showChapterList: () => true, hideButton: () => {} })
  const pushes = []
  store.onChange = () => pushes.push(host.chapter(7))
  // What main's guide:command-ran does for a deck window (index.ts): accept, then the store.
  const report = (id) => (acceptCommandRan({ appWindow: false, deckWindow: true }, id) ? store.commandRan(id, { inExample: false }) : { id: null, ticked: false })
  assert.deepEqual(report('presenter.next'), { id: 'presenter.next', ticked: true })
  assert.equal(writes.length, 1)
  assert.equal(pushes.length, 1, 'one progress event')
  assert.deepEqual(pushes[0], { view: presentGuideView(present, store.read(), chordOf, false), open: false })
  assert.equal(pushes[0].view.subgroups.flatMap((g) => g.rows).find((r) => r.id === 'presenter.next').tried, true)
  assert.equal(pushes[0].view.tried, 1)
  assert.deepEqual(report('presenter.next'), { id: 'presenter.next', ticked: false })
  assert.equal(pushes.length, 1, 'a second press changes nothing and pushes nothing')
  assert.deepEqual(report('delete-slide'), { id: null, ticked: false }, 'a deck cannot report a command of the editor')
  assert.deepEqual(report('presenter-palette.reset-timer'), { id: 'presenter-palette.reset-timer', ticked: true })
  assert.equal(pushes.length, 2)
  buttonOn = false
  assert.deepEqual(host.chapter(7), { view: null, open: false }, 'the Guide button off: no chip, no column')
})

await test('the preload builds the column from text only, and its button needs main\'s view', () => {
  const preload = readFileSync(new URL('../src/preload/present-guide.ts', import.meta.url), 'utf8')
  const htmlSinks = preload.match(/\.innerHTML\s*=/g) ?? []
  assert.equal(htmlSinks.length, 1, 'one innerHTML, for the generated lucide icon')
  assert.ok(preload.includes('holder.innerHTML = presenterIconSvg(name)'))
  assert.ok(!/insertAdjacentHTML|outerHTML\s*=|document\.write/.test(preload))
  assert.ok(preload.includes("if (!r || !isPresentGuideView(r.view))"), 'a reply that is not a view removes the chip')
  assert.ok(!preload.includes("addEventListener('keydown'"), 'the Guide binds no key (owner check 10 Oct)')
  assert.ok(preload.includes("ipcRenderer.invoke('guide:present-all-chapters')") && preload.includes("ipcRenderer.invoke('guide:present-hide-button')"), 'All chapters and the × send the bare requests')
  assert.ok(!/invoke\('guide:present-(all-chapters|hide-button)',/.test(preload), 'neither request carries an argument')
  assert.ok(preload.includes("document.getElementById('outlineBtn')"), 'the button sits beside Outline in the bottom bar')
  const bridge = readFileSync(new URL('../src/preload/present-edit-bridge.ts', import.meta.url), 'utf8')
  assert.ok(bridge.includes('if (!isPresenterCommandId(id) || sent.has(id)) return'), 'the bridge checks the list before it retains or forwards, and forwards a listed id once per page')
  assert.ok(bridge.indexOf('if (!isPresenterCommandId(id) || sent.has(id)) return') < bridge.indexOf('sent.add(id)'), 'nothing unlisted enters the retained set')
  assert.ok(bridge.includes('if (presenterEditSlot()) mountPresenterGuide()'), 'the presenter only')
  const recorderOnly = readFileSync(new URL('../src/preload/present-edit.ts', import.meta.url), 'utf8')
  assert.ok(!recorderOnly.includes('mountPresenterGuide'))
})

console.log(`\n${passed} passed`)
