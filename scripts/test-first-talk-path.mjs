import { readMainSource } from './lib/read-source.mjs'
import assert from 'node:assert/strict'

const main = readMainSource()
const handler = main.match(/ipcMain\.handle\('talk:read-outline',[\s\S]*?\n\}\)/)?.[0] ?? ''

assert.ok(handler, 'talk:read-outline handler exists')
assert.doesNotMatch(handler, /readFileSync\(/, 'first talk open must not synchronously read the outline on Electron main')

console.log('first-talk path tests passed')
