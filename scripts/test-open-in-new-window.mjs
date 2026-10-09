// "Open in new window" (file-list right-click + palette). Seams: the pure decision and payload parser in
// src/shared/open-in-new-window.ts, the context-menu definitions in talklist/menus.tsx (read as source:
// plain Node cannot load TSX), and the command registry entry.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { decideOpenInNewWindow, parseOpenInNewWindowTarget } from '../src/shared/open-in-new-window.ts'
import { createOpenRequests, refuseOpenTarget } from '../src/main/open-requests.ts'
import { COMMAND_REGISTRY } from '../src/shared/command-registry.ts'

let passed = 0
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok  ${name}`) }

await test('a talk with no holder opens a new window', () => {
  assert.deepEqual(decideOpenInNewWindow(null), { action: 'open' })
  assert.deepEqual(decideOpenInNewWindow(undefined), { action: 'open' })
})
await test('a talk already open in a window focuses that window, never a second editor', () => {
  const win = { id: 7 }
  const decision = decideOpenInNewWindow(win)
  assert.equal(decision.action, 'focus')
  assert.equal(decision.window, win)
})
await test('payloads: talk and folder accepted, junk refused', () => {
  assert.deepEqual(parseOpenInNewWindowTarget({ kind: 'talk', outlinePath: '/v/a/a-outline.md' }), { kind: 'talk', outlinePath: '/v/a/a-outline.md' })
  assert.deepEqual(parseOpenInNewWindowTarget({ kind: 'folder', topic: 'Workshops/2026', vaultId: 'a' }), { kind: 'folder', topic: 'Workshops/2026', vaultId: 'a' })
  assert.deepEqual(parseOpenInNewWindowTarget({ kind: 'folder', topic: 'Workshops' }), { kind: 'folder', topic: 'Workshops' })
  for (const bad of [null, undefined, 'x', {}, { kind: 'talk' }, { kind: 'talk', outlinePath: '' }, { kind: 'folder', topic: '' }, { kind: 'vault', topic: 'x' }]) {
    assert.equal(parseOpenInNewWindowTarget(bad), null)
  }
})

const talk = (outlinePath) => ({ kind: 'talk', outlinePath })
await test('a talk request stays starting until its window claims it, so a second trigger focuses it', () => {
  const r = createOpenRequests((p) => p.toLowerCase())
  r.start(5, talk('/v/A/a.md'))
  assert.equal(r.startingFor('/V/A/A.MD'), 5, 'same identity')
  assert.deepEqual(r.take(5), talk('/v/A/a.md'))
  assert.equal(r.take(5), null, 'taken once')
  assert.equal(r.startingFor('/v/a/a.md'), 5, 'kept after take')
  r.claimed(5)
  assert.equal(r.startingFor('/v/a/a.md'), null)
  assert.equal(r.size(), 0)
})
await test('closing a starting window clears its request', () => {
  const r = createOpenRequests((p) => p)
  r.start(6, talk('/v/a.md'))
  r.closed(6)
  assert.equal(r.startingFor('/v/a.md'), null)
  assert.equal(r.take(6), null)
})
await test('a timed-out starting window releases its talk (claimTalk(null)), so a later request opens a new window', () => {
  const r = createOpenRequests((p) => p)
  r.start(9, talk('/v/a.md'))
  r.take(9)
  assert.equal(r.startingFor('/v/a.md'), 9)
  r.claimed(9) // what window:claim-talk does first, even for null
  assert.equal(r.startingFor('/v/a.md'), null)
})
await test('a folder request is dropped when taken and never counts as starting a talk', () => {
  const r = createOpenRequests((p) => p)
  r.start(7, { kind: 'folder', topic: 'W' })
  assert.deepEqual(r.take(7), { kind: 'folder', topic: 'W' })
  assert.equal(r.size(), 0)
})
await test('a window that is gone is not a starting window', () => {
  const r = createOpenRequests((p) => p, () => false)
  r.start(8, talk('/v/a.md'))
  assert.equal(r.startingFor('/v/a.md'), null)
})
await test('requests outside the vault are refused', () => {
  const deps = { outlineRefused: (p) => (p.startsWith('/v/') ? null : 'outside the vault'), hasVault: (id) => id === 'a' }
  assert.equal(refuseOpenTarget(talk('/v/a.md'), deps), null)
  assert.ok(refuseOpenTarget(talk('/etc/passwd'), deps))
  assert.equal(refuseOpenTarget({ kind: 'folder', topic: 'W/2026', vaultId: 'a' }, deps), null)
  assert.equal(refuseOpenTarget({ kind: 'folder', topic: 'W' }, deps), null)
  for (const topic of ['../x', 'a/../b', '/abs', 'C:\\x', 'a//b', '.', 'a/./b']) {
    assert.ok(refuseOpenTarget({ kind: 'folder', topic }, deps), topic)
  }
  assert.ok(refuseOpenTarget({ kind: 'folder', topic: 'W', vaultId: 'zzz' }, deps), 'unknown vault')
})

const menus = await readFile(new URL('../src/renderer/src/components/talklist/menus.tsx', import.meta.url), 'utf8')
const block = (name) => menus.slice(menus.indexOf(`const ${name}`), menus.indexOf(']\n', menus.indexOf(`const ${name}`)))
await test('the talk right-click menu offers Open in new window', () => {
  assert.match(block('TALK_MENU_ITEMS'), /action: 'open-new-window'[^\n]*label: 'Open in new window'/)
})
await test('the folder right-click menu offers Open in new window', () => {
  assert.match(block('FOLDER_MENU_ITEMS'), /action: 'open-new-window'[^\n]*label: 'Open in new window'/)
})
await test('it is a palette command with no new chord', () => {
  const cmd = COMMAND_REGISTRY.find((c) => c.id === 'open-in-new-window')
  assert.ok(cmd, 'registered')
  assert.equal(cmd.palette.visible, true)
  assert.equal(cmd.shortcutId, undefined)
})
console.log(`${passed} passed`)
