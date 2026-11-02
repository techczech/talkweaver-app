// The Check for Updates item in the macOS app menu: its id must be one the registry holds, the
// placement must produce the item, and a missing command must never throw (it once stopped the
// shared settings store from opening). Plain Node, no Electron.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as bridle from '../src/shared/bridle-commands.ts'
import { updateCheckMenuTemplate } from '../src/main/settings-update-menu.ts'
import { openSettings } from '../src/main/settings-open.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { registry, UPDATE_CHECK_ID } = bridle
assert.ok(UPDATE_CHECK_ID, 'bridle-commands must export the update-check registry id')
assert.ok(registry.byId(UPDATE_CHECK_ID), `registry holds no command "${UPDATE_CHECK_ID}"`)
assert.equal(UPDATE_CHECK_ID, bridle.bridleIdOf('check-for-updates'))
assert.equal(registry.byId('app.check-for-updates'), undefined, 'the shortcut id is not a registry id')

const host = readFileSync(new URL('../src/main/settings-host.ts', import.meta.url), 'utf8')
assert.ok(!host.includes("'app.check-for-updates'"), 'settings-host must not hard-code a second update id')

let bag = {}
const opened = await openSettings({ dir: mkdtempSync(join(tmpdir(), 'tw-update-menu-')), appVersion: '0.0.0', file: { read: () => bag, write: (p) => { bag = { ...bag, ...p } } }, watch: false, log: () => {} })
assert.equal(opened.problem, null, 'the settings store opens')
const keys = opened.store.view().keys
const ran = []
const logs = []
const template = updateCheckMenuTemplate({ platform: 'darwin', keys, run: (id) => ran.push(id), log: (l) => logs.push(l) })
assert.ok(template, 'a template is built on macOS')
const appMenu = template[0].submenu
const item = appMenu.find((i) => i.id === UPDATE_CHECK_ID)
assert.ok(item, 'the app menu contains the Check for Updates item')
assert.equal(item.label, registry.byId(UPDATE_CHECK_ID).label)
assert.equal(appMenu.indexOf(item), 1, 'placed right after the About item')
assert.equal(template.slice(1).some((m) => (m.submenu ?? []).some((i) => i.id === UPDATE_CHECK_ID)), false, 'not duplicated in another menu')
item.click(); assert.deepEqual(ran, [UPDATE_CHECK_ID])
assert.equal(bridle.appCommandIdOf(ran[0]), 'check-for-updates')
assert.equal(logs.length, 0)
assert.equal(updateCheckMenuTemplate({ platform: 'linux', keys, run() {}, log: (l) => logs.push(l) }), null, 'off macOS the menu is left alone')
await opened.close()
console.log('PASS Update-check menu: registry id resolves, item placed in the app menu, no throw')
