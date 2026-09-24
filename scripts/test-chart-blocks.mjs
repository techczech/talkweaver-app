import { strict as assert } from 'node:assert'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { lexMarkdownBlocks } from '../compiler/scripts/lib/03-markdown-lexer.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import {
  adaptMarkdownOutlineV2,
  prepareSource,
} from '../compiler/scripts/lib/08-source-adapters.mjs'
import {
  scanOutlineTriggers,
  unresolvedTriggerBlock,
} from '../src/shared/layout-doctor.ts'
import { detectObjectBlocks } from '../src/renderer/src/extensions/objectBlocks/detect.ts'

const list = ['- Alpha: 40', '- Beta: 60']
assert.deepEqual(
  lexMarkdownBlocks(['{piechart}', '', ...list]),
  [{
    type: 'object-chart',
    token: 'piechart',
    shape: 'pie',
    list: {
      type: 'list',
      ordered: false,
      items: ['Alpha: 40', 'Beta: 60'],
      children: [[], []],
    },
  }],
  'the compiler lexer owns a registered chart token and its blank-tolerant adjacent list'
)
assert.deepEqual(
  lexMarkdownBlocks(['{chart=donut}', ...list]).map((block) => block.type),
  ['paragraph', 'list'],
  'an unregistered chart token does not become an object block'
)
assert.deepEqual(
  lexMarkdownBlocks(['{piechart}', '', '', ...list]).map((block) => block.type),
  ['paragraph', 'list'],
  'a chart token does not bind across two blank lines'
)

for (const [parent, child] of [
  ['- Parent', '  - Alpha: 40'],
  ['1. Parent', '  1. Alpha: 40'],
]) {
  const nestedTokenLines = [parent, '  {piechart}', child]
  assert.equal(
    lexMarkdownBlocks(nestedTokenLines).some((block) => block.type === 'object-chart'),
    false,
    `an indented chart token inside ${parent[0] === '-' ? 'an unordered' : 'an ordered'} list cannot claim its nested list`
  )
  assert.deepEqual(
    detectObjectBlocks(nestedTokenLines.join('\n')),
    [],
    `editor detection rejects the same indented ${parent[0] === '-' ? 'unordered' : 'ordered'} token shape`
  )
}

for (const [token, shape, detectedKind] of [
  ['chart=bar', 'bar', 'chart'],
  ['piechart', 'pie', 'piechart'],
  ['linechart', 'line', 'linechart'],
]) {
  const source = `### ${shape}
{id=block-${shape}}

{${token}}

- Alpha: 40
- Beta: 60
`
  const compiledSlide = adaptMarkdownOutlineV2(source, shape).slides
    .find((slide) => slide.id === `block-${shape}`)
  const [compiledBlock] = compiledSlide.blocks
  const [detectedBlock] = detectObjectBlocks(source)
  assert.deepEqual(
    [compiledBlock.type, compiledBlock.shape, compiledBlock.objectToken],
    ['chart', shape, token],
    `the compiler recognises the ${shape} block token`
  )
  assert.deepEqual(
    [detectedBlock.kind, detectedBlock.triggerToken],
    [detectedKind, token],
    `the editor mirrors the compiler for the ${shape} block token`
  )
}

const splitListSource = `### Split rows
{id=split-rows}

{piechart}
- Alpha: 40

- Beta: 60
`
const splitListSlide = adaptMarkdownOutlineV2(splitListSource, 'Split rows').slides
  .find((slide) => slide.id === 'split-rows')
const [splitListDetected] = detectObjectBlocks(splitListSource)
assert.deepEqual(
  splitListSlide.blocks.find((block) => block.type === 'chart').points.map((point) => point.label),
  ['Alpha'],
  'the compiler ends the chart block at the list reader boundary'
)
assert.equal(
  splitListDetected.source,
  '- Alpha: 40\n',
  'the editor ends the chart block at the same list reader boundary'
)

const consecutiveCanonical = `### Consecutive Trigger lines
{id=consecutive}{chart=bar}
{piechart}
- Alpha: 40
- Beta: 60
`
const consecutiveSlide = adaptMarkdownOutlineV2(consecutiveCanonical, 'Consecutive').slides
  .find((slide) => slide.id === 'consecutive')
assert.deepEqual(
  consecutiveSlide.blocks.map((block) => [block.type, block.shape, block.objectToken]),
  [['chart', 'pie', 'piechart']],
  'only the first Trigger-only line is canonical; a later token can own its adjacent list'
)
assert.equal(
  scanOutlineTriggers(consecutiveCanonical)
    .some((finding) => finding.detail?.includes('shadowed by block token')),
  true,
  'the Doctor flags the first-line chart form shadowed by the later block token'
)

const blockOnly = `---
title: Chart blocks
outline_version: 2
auto_title_slide: false
auto_thanks_slide: false
---

### Block only
{id=block-only}

{piechart}
- Alpha: 40
- Beta: 60
`
const blockModel = adaptMarkdownOutlineV2(blockOnly, 'Chart blocks')
const blockSlide = blockModel.slides.find((slide) => slide.id === 'block-only')
assert.equal(
  blockSlide.layout,
  'chart',
  '2026-07-29 ruling: a block-scoped chart that is the slide’s only content fills the chart stage'
)
assert.deepEqual(
  blockSlide.blocks.map((block) => [block.type, block.shape, block.objectToken]),
  [['chart', 'pie', 'piechart']],
  'the object token owns only its adjacent list'
)

const mixedBlockSource = `---
title: Mixed chart block
outline_version: 2
auto_title_slide: false
auto_thanks_slide: false
---

### Mixed chart block
{id=mixed-chart-block}

Context before the chart.

{piechart}
- Alpha: 40
- Beta: 60
`
const mixedBlockSlide = adaptMarkdownOutlineV2(mixedBlockSource, 'Mixed chart block').slides
  .find((slide) => slide.id === 'mixed-chart-block')
assert.equal(
  mixedBlockSlide.layout,
  'statement',
  'a chart block mixed with other content keeps the slide’s ordinarily inferred default chrome'
)

const gateShape = `---
title: Gate shape
outline_version: 2
auto_title_slide: false
auto_thanks_slide: false
---

### Gate shape
{id=gate-shape}{chart=bar}

{piechart}

- Alpha: 40
- Beta: 60
`
const gateModel = adaptMarkdownOutlineV2(gateShape, 'Gate shape')
const gateSlide = gateModel.slides.find((slide) => slide.id === 'gate-shape')
assert.equal(gateSlide.layout, 'chart', 'the canonical Trigger line still owns the slide layout')
assert.deepEqual(
  gateSlide.blocks.filter((block) => block.type === 'chart')
    .map((block) => [block.shape, block.objectToken]),
  [['pie', 'piechart']],
  'the block token wins its chart block over the Trigger-line compatibility shape'
)

const competingLists = `---
title: Competing lists
outline_version: 2
auto_title_slide: false
auto_thanks_slide: false
---

### Competing lists
{id=competing-lists}{chart=bar}

- Compatibility list: 10

{piechart}
- Block list: 90
`
const competingModel = adaptMarkdownOutlineV2(competingLists, 'Competing lists')
const competingSlide = competingModel.slides.find((slide) => slide.id === 'competing-lists')
assert.deepEqual(
  competingSlide.blocks.map((block) => [block.type, block.shape ?? null, block.objectToken ?? null]),
  [
    ['feature-list', null, null],
    ['chart', 'pie', 'piechart'],
  ],
  'a competing block suppresses the trigger-only compatibility reading'
)

const compatibility = `---
title: Compatibility
outline_version: 2
auto_title_slide: false
auto_thanks_slide: false
---

### Old chart
{id=old-chart}{chart=bar}

- Alpha: 40
- Beta: 60
`
const compatibilityModel = adaptMarkdownOutlineV2(compatibility, 'Compatibility')
const compatibilitySlide = compatibilityModel.slides.find((slide) => slide.id === 'old-chart')
assert.deepEqual(
  compatibilitySlide.blocks.map((block) => [block.type, block.shape, block.objectToken]),
  [['chart', 'bar', undefined]],
  'a trigger-line-only chart keeps the compatibility reading'
)

const unresolvedBlockSource = `### Broken block
{id=broken-block}

{chart=donut}
- Alpha: 40
`
assert.equal(
  unresolvedTriggerBlock(unresolvedBlockSource)?.first.token,
  'chart=donut',
  'an unresolved block-shaped token blocks publishing'
)

const fixturePath = resolve('docs/layout-sampler-outline.md')
const runtimeSource = `---
title: Chart block runtime parity
outline_version: 2
auto_title_slide: false
auto_thanks_slide: false
---

### Block only
{id=block-only}

{piechart}
- Alpha: 40
- Beta: 60

### Gate shape
{id=gate-shape}{chart=bar}

{piechart}
- Alpha: 40
- Beta: 60

### Old chart
{id=old-chart}{chart=bar}

- Alpha: 40
- Beta: 60
`
const compiled = await prepareSource(
  fixturePath,
  runtimeSource,
  'Chart block runtime parity',
  statSync(fixturePath)
)
const deckSlides = extractSlides(compiled.fullHtml)
const handout = buildShareHtml({
  title: compiled.title,
  slides: deckSlides,
  styles: extractStyles(compiled.fullHtml),
  includeNotes: false,
  slug: 'chart-block-runtime-parity',
  license: null,
})
assert.equal((compiled.fullHtml.match(/class="chart-pie/g) ?? []).length, 2)
assert.equal((handout.match(/class="chart-pie/g) ?? []).length, 2)
assert.equal((compiled.fullHtml.match(/class="chart-cols/g) ?? []).length, 1)
assert.equal((handout.match(/class="chart-cols/g) ?? []).length, 1)

console.log('chart block compiler and deck/handout parity: PASS')
