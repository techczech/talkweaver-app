import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseChartListSource,
  parseChartItems,
  renderChartBlock,
} from '../compiler/scripts/lib/06-chart-renderer.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const points = [
  { value: 40, valueText: '40', label: '**Alpha**' },
  { value: -25, valueText: '-25', label: 'Beta & beyond' },
  { value: 35, valueText: '35', label: 'Gamma' },
]

const goldenHashes = {
  bar: '7dedac922b1b33eabc816fe68652edca72387b417c916c514c893ecddb784756',
  pie: 'e161ad2a7b36e1275dd9e43f269f3be5932256949b92b3b8b9417f2ea1b6a8b9',
  line: '1cec8754c210cdc31a6521968ed56638504886e2384081a70df85792b8d5d896',
}
for (const shape of ['bar', 'pie', 'line']) {
  assert.equal(
    createHash('sha256').update(renderChartBlock({ type: 'chart', shape, points })).digest('hex'),
    goldenHashes[shape],
    `${shape} shared chart HTML matches its independent golden bytes`
  )
}
assert.equal(
  renderChartBlock({ type: 'chart', shape: 'bar', points: [] }),
  '',
  'an empty shared chart render preserves the compiler’s blank result'
)

assert.deepEqual(
  parseChartItems(
    ['Alpha: 40', '50', '2024 · 60', 'not numeric'],
    [[], [{ text: 'Nested label' }], [], []]
  ),
  {
    points: [
      { value: 40, valueText: '40', label: 'Alpha' },
      { value: 50, valueText: '50', label: 'Nested label' },
      { value: 60, valueText: '60', label: '2024' },
    ],
    unparsed: ['not numeric'],
  },
  'the shared parser preserves the compiler’s four authored chart shapes and visible rejection'
)

assert.deepEqual(
  parseChartListSource('- Alpha: 40\n- 50\n  - Nested label\n- 2024 · 60'),
  {
    points: [
      { value: 40, valueText: '40', label: 'Alpha' },
      { value: 50, valueText: '50', label: 'Nested label' },
      { value: 60, valueText: '60', label: '2024' },
    ],
    unparsed: [],
    invalidLines: [],
  },
  'the browser-safe list adapter feeds the exact compiler point parser'
)
assert.deepEqual(
  parseChartListSource('- Alpha: 40\nthis is not a list item\n- no number'),
  {
    points: [{ value: 40, valueText: '40', label: 'Alpha' }],
    unparsed: ['no number'],
    invalidLines: ['this is not a list item'],
  },
  'invalid list rows and compiler-unparsed chart items remain visible to the renderer'
)

const source = `---
title: Chart lift fixture
---

# Charts

### Generic bars
{chart=bar}

- Alpha: 40
- Beta: 25
- Gamma: 35

### Bar alias
{barchart}

- Alpha: 40
- Beta: 25
- Gamma: 35

### Pie alias
{piechart}

- Alpha: 40
- Beta: 25
- Gamma: 35

### Line alias
{linechart}

- 2022: 1
- 2024: 50
- 2026: 100
`
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixturePath = resolve(root, 'docs/layout-sampler-outline.md')
const model = await prepareSource(
  fixturePath,
  source,
  'chart-lift-fixture',
  statSync(fixturePath)
)
// Chart output is pinned above. A whole-deck hash also includes unrelated presenter controls,
// so it changes when a new control is added even if chart markup remains byte-identical.
assert.equal((model.fullHtml.match(/class="chart-cols/g) ?? []).length, 2)
assert.equal((model.fullHtml.match(/class="chart-pie/g) ?? []).length, 1)
assert.equal((model.fullHtml.match(/class="chart-line/g) ?? []).length, 1)

console.log('chart renderer: golden bar/pie/line bytes and compiled chart counts PASS')
