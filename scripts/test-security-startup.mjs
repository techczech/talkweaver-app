import assert from 'node:assert/strict'
import { forbiddenDebuggingSwitch } from '../src/main/security-switches.ts'
for (const flag of ['--remote-debugging-port=9222', '--remote-debugging-port', '--remote-debugging-pipe', '--inspect', '--inspect=0', '--inspect-brk=0', '--inspect-port=9229']) assert.equal(forbiddenDebuggingSwitch([flag]), flag)
assert.equal(forbiddenDebuggingSwitch(['--user-data-dir=fixture', '--inspection-note']), '--inspection-note')
assert.equal(forbiddenDebuggingSwitch(['--user-data-dir=fixture', 'notes--inspect']), undefined)
console.log('PASS startup debugging switch refusal: 9 cases')
