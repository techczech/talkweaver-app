import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test as check } from 'node:test'
import { sendEditorMenuCommand } from '../src/main/app-menu.ts'
import { updateCheckMenuTemplate } from '../src/main/settings-update-menu.ts'
import { registry, appCommandIdOf } from '../src/shared/bridle-commands.ts'
import { COMMAND_REGISTRY, toolbarCommands, listedPaletteCommands } from '../src/shared/command-registry.ts'
import { TASK_GROUPS } from '../src/shared/task-groups.ts'
import { toAccelerator } from '@app-patterns/commands'

const ran = [], bindings = registry.bindingsOf({})
const template = updateCheckMenuTemplate({ platform: 'darwin', keys: {}, run: id => ran.push(id), log() {} })
const walk = items => items.flatMap(item => [item, ...walk(Array.isArray(item.submenu) ? item.submenu : [])])
const all = walk(template)
check('native menus expose each task group exactly once', () => {
  for (const group of TASK_GROUPS) assert.equal(all.filter(item => item.label === group).length, 1, group)
})
check('commands live under their registry task and subgroup with unchanged runners', () => {
  for (const def of registry.defs) {
    const source = COMMAND_REGISTRY.find(c => c.id === appCommandIdOf(def.id))
    if (!source || def.noMenu || ['settings', 'cheat', 'check-for-updates'].includes(def.id)) continue
    assert.equal(def.group, source.taskGroup, `${def.id}: same task in palette and menu`)
    const parent = all.find(item => item.label === source.taskGroup)
    assert.ok(parent, `${def.id}: task group`)
    const subgroup = parent.submenu.find(item => item.label === source.subgroup)
    assert.ok(subgroup, `${def.id}: subgroup`)
    const items = subgroup.submenu.filter(item => item.id === def.id)
    assert.equal(items.length, 1, `${def.id}: exactly once`)
    items[0].click(); assert.equal(ran.at(-1), def.id)
    assert.equal(items[0].accelerator, toAccelerator(bindings[def.id] ?? '') ?? undefined)
    if (items[0].accelerator) assert.equal(items[0].registerAccelerator, false)
  }
})
check('the Present dropdown, native menu and palette share their launch commands', () => {
  const expected = [
    ['present-from-here', 'Presenter view from this slide', 'Shift+F5'],
    ['present-presenter', 'Presenter view from the start', 'F5'],
    ['present-slide-window', 'Present in single screen from this slide', undefined],
    ['present-window', 'Present in single screen from the start', undefined],
    ['plan-run', 'Plan a session with an audience…', undefined]
  ]
  const toolbar = toolbarCommands('present')
  const present = walk(template.find(item => item.label === 'Present').submenu)
  const palette = listedPaletteCommands()
  assert.deepEqual(toolbar.map(command => [command.id, command.label]), expected.map(([id, label]) => [id, label]))
  for (const [id, label, accelerator] of expected) {
    assert.equal(palette.find(command => command.id === id)?.label, label)
    const item = present.find(item => item.id === id)
    assert.equal(item?.label, label)
    assert.equal(item.accelerator, accelerator)
    item.click()
    assert.equal(ran.at(-1), id)
  }
})
check('native Edit roles remain direct children in the platform frame', () => {
  const edit = template.find(m => m.label === 'Edit').submenu
  assert.deepEqual(edit.filter(item => item.role).map(item => item.role), ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
  const tasks = edit.filter(item => item.submenu)
  assert.deepEqual(tasks.map(item => item.label), ['Outlining', 'Formatting'])
  assert.ok(walk(tasks[0].submenu).some(item => item.id === 'new-slide'))
  assert.ok(walk(tasks[1].submenu).some(item => item.id === 'format-bold'))
  assert.equal(template[0].submenu[1].id, 'check-for-updates')
  assert.ok(template[0].submenu.some(item => /Settings/.test(item.label)))
  assert.ok(template.find(m => m.label === 'Help').submenu.some(item => item.label === registry.byId('cheat').label))
})
check('rebound effective chords reach the nested native leaf', () => {
  const keys = { 'format-bold': '⌘⌥⇧9' }
  // Use the actual settings format; the same registry computes both projections.
  const rebound = updateCheckMenuTemplate({ platform: 'darwin', keys, run() {}, log() {} })
  const expected = registry.bindingsOf(keys)
  assert.notEqual(expected['format-bold'], registry.bindingsOf({})['format-bold'], 'override takes effect')
  for (const item of walk(rebound).filter(item => item.id && item.click)) assert.equal(item.accelerator, toAccelerator(expected[item.id] ?? '') ?? undefined, item.id)
})
check('the native Present menu honours bare function-key overrides as well as registry chords', () => {
  const editorKeys = JSON.stringify({ 'present-from-here': 'F6', 'present-presenter': 'F8' })
  const menu = updateCheckMenuTemplate({
    platform: 'darwin', editorKeys, keys: { 'present-presenter': '⌥F7' }, run() {}, log() {}
  })
  const items = walk(menu)
  assert.equal(items.find(item => item.id === 'present-from-here').accelerator, 'F6')
  assert.equal(items.find(item => item.id === 'present-presenter').accelerator, 'Alt+F7')
})
check('a native menu command reaches the editor while a slide preview frame loads', () => {
  const sent = []
  let editorLoading = false
  const contents = Object.assign(new EventEmitter(), {
    isLoading: () => true,
    isLoadingMainFrame: () => editorLoading,
    send: (...args) => sent.push(args)
  })
  const menu = updateCheckMenuTemplate({
    platform: 'darwin', keys: {}, log() {}, run: id => sendEditorMenuCommand(contents, id)
  })
  const grid = walk(menu).find(item => item.id === 'view-grid')

  grid.click()
  assert.deepEqual(sent, [['app:run-command', 'view-grid']])

  editorLoading = true
  grid.click()
  assert.equal(sent.length, 1, 'a newly opened editor still waits for its main document')
  editorLoading = false
  contents.emit('did-finish-load')
  contents.emit('did-finish-load')
  assert.deepEqual(sent, [['app:run-command', 'view-grid'], ['app:run-command', 'view-grid']])
})

// Exercise the registered Settings callback without starting Electron.
function settingsEditorAction(contents) {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const start = source.indexOf("handleFromSettingsWindow('settings-window:editor-action',")
  const end = source.indexOf("\nipcMain.handle(", start)
  assert.ok(start >= 0 && end > start, 'find the Settings editor-action registration')
  let handler
  new Function('handleFromSettingsWindow', 'targetEditorFor', 'E2E', 'sendEditorMenuCommand',
    stripTypeScriptTypes(source.slice(start, end)))(
    (_channel, _refused, callback) => { handler = callback },
    () => ({ webContents: contents }), true, sendEditorMenuCommand
  )
  return action => handler({}, action)
}

check("Settings What's New reaches the editor while a slide preview frame loads", () => {
  const sent = []
  const contents = Object.assign(new EventEmitter(), {
    isLoading: () => true,
    isLoadingMainFrame: () => false,
    send: (...args) => sent.push(args)
  })
  assert.equal(settingsEditorAction(contents)('whats-new'), true)
  assert.deepEqual(sent, [['app:run-command', 'whats-new']])
})

check('Settings Get started actions reach the editor while a slide preview frame loads', () => {
  const sent = []
  const contents = Object.assign(new EventEmitter(), {
    isLoading: () => true,
    isLoadingMainFrame: () => false,
    send: (...args) => sent.push(args)
  })
  const invoke = settingsEditorAction(contents)
  const actions = ['open-guide', 'restore-example', 'add-vault']
  for (const action of actions) assert.equal(invoke(action), true)
  assert.deepEqual(sent, actions.map(action => ['settings-window:editor-action', action]))
})

for (const event of ['did-fail-load', 'did-fail-provisional-load']) {
  check('a main-frame ' + event + ' drops queued commands before the next reload', () => {
    const sent = []
    const contents = Object.assign(new EventEmitter(), {
      isLoadingMainFrame: () => true,
      send: (...args) => sent.push(args)
    })
    const fail = isMainFrame => contents.emit(event, {}, -2, 'load failed', 'file:///editor', isMainFrame)
    sendEditorMenuCommand(contents, 'view-grid')
    fail(false)
    contents.emit('did-finish-load')
    assert.deepEqual(sent, [['app:run-command', 'view-grid']], 'a subframe failure leaves the queue intact')
    assert.equal(contents.listenerCount(event), 0, 'success removes the failure listener')

    sendEditorMenuCommand(contents, 'view-outline')
    fail(false)
    fail(true)
    contents.emit('did-finish-load')
    assert.deepEqual(sent, [['app:run-command', 'view-grid']], 'the next load cannot replay a stale command')
    assert.equal(contents.listenerCount(event), 0, 'failure removes the failure listener')

    sendEditorMenuCommand(contents, 'view-slide')
    contents.emit('did-finish-load')
    assert.deepEqual(sent.at(-1), ['app:run-command', 'view-slide'])
  })
}
