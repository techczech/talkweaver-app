import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { reportRowsAfterSeparator } from '../e2e/lib/layout-sampler-report.mjs'
import { LAYOUTS } from '../src/shared/layout-registry/entries.ts'

const renamedHeader = `| Entry | Compiled OK | Rendered non-empty | Notes |
| :--- | --- | --- | --- |
| nostep | Yes | Yes | Host slide renders. |
`
assert.deepEqual(
  reportRowsAfterSeparator(renamedHeader),
  ['nostep'],
  'header wording cannot become a registry row'
)

const spacedStaleRow = `| Registry entry | Compiled OK | Rendered non-empty | Notes |
| :--- | --- | --- | --- |
| nostep | Yes | Yes | Host slide renders. |
|   stale entry   | Yes | Yes | Stale row with spaces. |
`
assert.deepEqual(
  reportRowsAfterSeparator(spacedStaleRow),
  ['nostep', 'stale entry'],
  'space-bearing or indented first cells remain visible to exact-membership checks'
)

assert.throws(
  () => reportRowsAfterSeparator('| Entry | Notes |\n| nostep | Missing separator |'),
  /separator row is missing/
)

const report = readFileSync(new URL('../docs/layout-sampler-unverified-report.md', import.meta.url), 'utf8')
const reportRows = reportRowsAfterSeparator(report).sort()
const unverifiedNames = LAYOUTS
  .filter((entry) => entry.status === 'unverified')
  .map((entry) => entry.name)
  .sort()
// O-D Task 14 status note, driver ruling 2026-07-28: Mermaid and SVG stay unverified until
// Task 29 live verification and promotion. Any other unverified entry still makes this exact set red.
assert.deepEqual(unverifiedNames, ['mermaid', 'svg', 'timer-audience'],
  'the O-D Task 14 status note holds exactly Mermaid, SVG and timer-audience as unverified')
assert.deepEqual(reportRows, unverifiedNames,
  'unverified report rows exactly match the registry’s unverified entries')

console.log('layout sampler report parsing: PASS')
