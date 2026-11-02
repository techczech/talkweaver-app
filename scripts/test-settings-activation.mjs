// Exercise the real activate callback at its editor lookup / creation seam, without Electron.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const start = main.indexOf("app.on('activate', () => {")
assert.ok(start >= 0)
const handler = main.slice(start, main.indexOf('\n})', start) + 3)
function activate({ editor = null, windows = [], setup = false, lock = true } = {}) {
  let callback, created = 0
  runInNewContext(handler, {
    app: { on: (name, fn) => { assert.equal(name, 'activate'); callback = fn } },
    SETUP_ARGS: setup ? [] : null,
    holdsInstanceLock: lock,
    BrowserWindow: { getAllWindows: () => windows },
    targetEditorFor: (path) => { assert.equal(path, null); return editor },
    createWindow: () => { created++; return {} }
  })
  callback()
  return created
}
assert.equal(activate({ windows: [{ kind: 'settings' }] }), 1, 'Settings alone must not prevent an editor being created')
assert.equal(activate({ windows: [{ kind: 'thumbnail' }] }), 1, 'utility windows do not count as editors')
assert.equal(activate(), 1, 'no windows: create an editor')
assert.equal(activate({ editor: {}, windows: [{}] }), 0, 'an existing live editor is reused')
assert.equal(activate({ setup: true }), 0, 'setup must not open an editor')
assert.equal(activate({ lock: false }), 0, 'settings CLI and refused second instances must not open an editor')
// Activation uses the same factory as startup; keep its hidden-mode guard intact.
assert.match(main.slice(main.indexOf('function createWindow()'), main.indexOf('const editorWindows =')), /E2E \? \{ show: false \}/)
console.log('PASS Settings activation: Settings/utility windows ignored, existing editor reused, command guards and hidden mode preserved')
