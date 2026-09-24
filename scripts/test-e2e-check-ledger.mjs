import { strict as assert } from 'node:assert'

let createCheckLedger = null
try {
  ;({ createCheckLedger } = await import('../e2e/lib/check-ledger.mjs'))
} catch {
  // The assertion below is the red proof before the harness ledger exists.
}

assert.equal(
  typeof createCheckLedger,
  'function',
  'the e2e harness exposes a fixed-denominator result ledger'
)

const output = []
const ledger = createCheckLedger(
  ['first check', 'second check', 'third check'],
  { log: (line) => output.push(line) }
)
ledger.record('first check', true, 'positive control')
const summary = ledger.summary('LEDGER TEST')

assert.deepEqual(
  summary,
  {
    passed: 1,
    failed: 0,
    notRun: 2,
    total: 3,
    exitCode: 1,
  },
  'unreached checks remain in the denominator and force a failing exit'
)
assert(
  output.some((line) => line.includes('NOT RUN  second check')),
  'each unreached check is printed explicitly'
)
assert(
  output.some((line) => line.includes('1/3 passed; 0 failed; 2 NOT RUN')),
  'the summary line reports the fixed denominator and NOT RUN count'
)

console.log('test:e2e-check-ledger OK')
