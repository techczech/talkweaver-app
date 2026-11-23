import assert from 'node:assert/strict'
import * as source from './lib/read-source.mjs'

assert.equal(typeof source.readMainSource, 'function', 'the main source reader covers the whole tree')
const text = source.readMainSource()
const entry = text.indexOf('function createWindow(): BrowserWindow')
const module = text.indexOf("deps.ipc.handle('scratchpad:subscribe'")
assert.ok(entry >= 0, 'includes the Electron entry point')
assert.ok(module > entry, 'includes a later main module in path order')
assert.equal(source.mainSourceFileAt(entry), 'src/main/index.ts')
assert.equal(source.mainSourceFileAt(module), 'src/main/scratchpad-ipc.ts')
assert.equal(source.mainSourceFileAt(-1), undefined)
assert.equal(source.mainSourceFileAt(text.length), undefined)
assert.equal(text.includes('\r'), false)

for (const [file, declaration] of [
  ['backup-scope.mjs', 'export function loadScope(raw)'],
  ['capture-network-frame.js', 'export function lockCaptureNetwork() {'],
  ['conflict-copies.mjs', 'export function conflictCandidateNames('],
  ['conflict-merge.mjs', 'export function splitGitConflict(text)'],
]) {
  const offset = text.indexOf(declaration)
  assert.ok(offset >= 0, `includes the declaration from ${file}`)
  assert.equal(source.mainSourceFileAt(offset), `src/main/${file}`)
}

console.log('Main source includes the entry point and extracted modules in path order')
