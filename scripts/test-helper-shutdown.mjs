// One lifecycle policy for every helper kind; no Electron or real user data.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WINDOW_KINDS, markHiddenRenderer, registerWindowKind, helperWindowsAllowed, holdHelperWindows, whenHelperWindowsAllowed, windowKindOf } from '../src/main/window-kinds.ts'

let nextId = 80_000, passed = 0
class Window extends EventEmitter {
  webContents = { id: ++nextId }
  destroyed = false
  closes = 0
  destroys = 0
  isDestroyed() { return this.destroyed }
  close() { this.closes++; throw Error('A hidden helper must never hold shutdown in beforeunload') }
  destroy() { this.destroys++; this.destroyed = true; this.emit('closed') }
}
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name) }

await test('shutdown destroys every helper class without asking its close/unload route', () => {
  const helpers = Object.entries(WINDOW_KINDS).filter(([, kind]) => kind.class === 'helper').map(([kind]) => {
    const window = new Window(); markHiddenRenderer(window, kind); return window
  })
  assert.ok(helpers.length >= 5, 'all hidden helper kinds are exercised')
  const editor = new Window(); registerWindowKind(editor, 'editor')
  const tools = new Window(); registerWindowKind(tools, 'tools')
  const release = holdHelperWindows()
  try {
    assert.equal(helperWindowsAllowed(), false)
    for (const helper of helpers) {
      assert.equal(helper.isDestroyed(), true)
      assert.equal(helper.closes, 0)
      assert.equal(helper.destroys, 1)
      assert.equal(windowKindOf(helper.webContents.id), null)
    }
    assert.equal(editor.isDestroyed(), false); assert.equal(tools.isDestroyed(), false)
  } finally { release(); editor.destroy(); tools.destroy() }
})

await test('a late helper registration cannot outlive shutdown', () => {
  const release = holdHelperWindows()
  try {
    const late = new Window(); markHiddenRenderer(late, 'thumbnail')
    assert.equal(late.isDestroyed(), true)
  } finally { release() }
})

await test('overlapping quit and update holds release independently and idempotently', () => {
  const quit = holdHelperWindows(), restart = holdHelperWindows()
  quit(); quit()
  assert.equal(helperWindowsAllowed(), false)
  restart()
  assert.equal(helperWindowsAllowed(), true)
  const window = new Window(); markHiddenRenderer(window, 'scratchpad-capture')
  assert.equal(window.isDestroyed(), false)
  window.destroy()
})

await test('the gate closes before destroying helpers, including synchronous re-entrancy', () => {
  const window = new Window(); markHiddenRenderer(window, 'thumbnail')
  let allowedDuringDestroy
  window.once('closed', () => { allowedDuringDestroy = helperWindowsAllowed() })
  const release = holdHelperWindows()
  try { assert.equal(allowedDuringDestroy, false) } finally { release() }
})
await test('source recovery runs once after every hold ends; stopped recordings unsubscribe', () => {
  const first = holdHelperWindows(), last = holdHelperWindows()
  let restored = 0
  whenHelperWindowsAllowed(() => { assert.equal(helperWindowsAllowed(), true); restored++ })
  const cancel = whenHelperWindowsAllowed(() => { throw Error('stopped owner must not recover') })
  cancel(); first(); assert.equal(restored, 0)
  last(); assert.equal(restored, 1)
  last(); assert.equal(restored, 1)
})
console.log(`helper shutdown: ${passed} checks passed`)
