import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
const handlers = new Map()
let destroyed = false
const win = { isDestroyed: () => destroyed, destroy: () => { destroyed = true } }
globalThis.__recordingCloseTest = { ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, BrowserWindow: { fromWebContents: () => win }, shell: {} }
const bundled = await build({ entryPoints: ['src/main/recording.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external', plugins: [{ name: 'electron-test-boundary', setup(build) {
  build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test' }))
  build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'module.exports = globalThis.__recordingCloseTest', loader: 'js' }))
} }] })
const module = { exports: {} }
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const recording = module.exports
let release
let outcome = { ok: false, error: 'Could not end live session' }
const seen = []
recording.registerRecordingIpc({ beforeCloseWindow: async (id, action) => {
  seen.push([id, action])
  await new Promise(resolve => { release = resolve })
  return outcome
} })
const event = { sender: { id: 71 } }
recording.registerRecordingContext(71, { talkSlug: 'deck' })
handlers.get('recording:run-state')(event, { talkSlug: 'deck', sessionId: 'run-1', saved: true })
const pending = handlers.get('recording:close-window')(event, 'end')
assert.equal(destroyed, false, 'window survives while the live close operation is pending')
assert.deepEqual(recording.recordingRunReference(71), { talkSlug: 'deck', runId: 'run-1' })
release()
assert.deepEqual(await pending, outcome)
assert.equal(destroyed, false, 'failed live close preserves presentation')
assert.deepEqual(recording.recordingRunReference(71), { talkSlug: 'deck', runId: 'run-1' })
outcome = { ok: true }
const successful = handlers.get('recording:close-window')(event, 'keep')
release()
assert.deepEqual(await successful, { ok: true })
assert.equal(destroyed, true)
assert.deepEqual(seen, [[71, 'end'], [71, 'keep']])
assert.equal(recording.recordingRunReference(71), null)
destroyed = false
handlers.get('recording:run-state')(event, { talkSlug: 'deck', audioArmed: true })
assert.equal(recording.recordingAudioArmed(71), true)
assert.deepEqual(await handlers.get('recording:close-window')(event, 'keep'), { ok: false, error: 'Save the recording before closing the presentation.' })
assert.equal(destroyed, false)
assert.equal(seen.length, 2, 'armed audio blocks even the live close hook')
assert.deepEqual(await handlers.get('recording:close-window')(event, 'unexpected'), { ok: false, error: 'Invalid live session close choice.' })
recording.unregisterRecordingContext(71)
delete globalThis.__recordingCloseTest
console.log('recording close lifecycle: await live action, retain state on failure, validate action and block unsaved audio passed')
