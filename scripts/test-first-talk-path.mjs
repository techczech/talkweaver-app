import { readIpcRegistration } from './lib/read-ipc-registration.mjs'
import assert from 'node:assert/strict'

const handler = readIpcRegistration('talk:read-outline')

assert.ok(handler, 'talk:read-outline handler exists')
assert.doesNotMatch(handler, /readFileSync\(/, 'first talk open must not synchronously read the outline on Electron main')

console.log('first-talk path tests passed')
