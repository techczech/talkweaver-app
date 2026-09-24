import { strict as assert } from 'node:assert'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { TRIGGER_DICTIONARY } from '../compiler/scripts/triggers.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { lexMarkdownBlocks } from '../compiler/scripts/lib/03-markdown-lexer.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { parseSlideScript } from '../compiler/scripts/lib/slide-script.mjs'
import {
  adaptMarkdownOutlineV2,
  prepareSource,
} from '../compiler/scripts/lib/08-source-adapters.mjs'
import {
  scanOutlineTriggers,
  unresolvedTriggerBlock,
} from '../src/shared/layout-doctor.ts'

const fixturePath = resolve('docs/layout-sampler-outline.md')
const fixtureStat = statSync(fixturePath)
const valueList = ['- Alpha: 40', '- Beta: 60']
const registeredForms = [
  ['chart', 'bar'],
  ['chart=bar', 'bar'],
  ['chart=pie', 'pie'],
  ['chart=line', 'line'],
  ['barchart', 'bar'],
  ['piechart', 'pie'],
  ['linechart', 'line'],
  ['curve', 'line'],
]

function outline(body) {
  return `---
title: Chart fence parity
outline_version: 2
auto_title_slide: false
auto_thanks_slide: false
---

### Equivalent chart
{id=equivalent-chart}

${body}
`
}

async function compiledOutput(body) {
  const compiled = await prepareSource(
    fixturePath,
    outline(body),
    'Chart fence parity',
    fixtureStat
  )
  const slides = extractSlides(compiled.fullHtml)
  return {
    slides,
    handout: buildShareHtml({
      title: compiled.title,
      slides,
      styles: extractStyles(compiled.fullHtml),
      includeNotes: false,
      slug: 'chart-fence-parity',
      license: null,
    }),
  }
}

for (const [token, shape] of registeredForms) {
  const fenced = lexMarkdownBlocks([`\`\`\`${token}`, ...valueList, '```'])
  assert.equal(fenced.length, 1, `${token}: the fence is one compiler block`)
  assert.deepEqual(
    {
      type: fenced[0]?.type,
      token: fenced[0]?.token,
      shape: fenced[0]?.shape,
      list: fenced[0]?.list,
    },
    {
      type: 'object-chart',
      token,
      shape,
      list: {
        type: 'list',
        ordered: false,
        items: ['Alpha: 40', 'Beta: 60'],
        children: [[], []],
      },
    },
    `${token}: the compiler lexer resolves the registered chart info string and list body`
  )

  const blockSlide = adaptMarkdownOutlineV2(
    outline(`{${token}}\n${valueList.join('\n')}`),
    `block-${token}`
  ).slides.find((slide) => slide.id === 'equivalent-chart')
  const fenceSlide = adaptMarkdownOutlineV2(
    outline(`\`\`\`${token}\n${valueList.join('\n')}\n\`\`\``),
    `fence-${token}`
  ).slides.find((slide) => slide.id === 'equivalent-chart')
  assert.deepEqual(
    {
      layout: fenceSlide.layout,
      blocks: fenceSlide.blocks,
    },
    {
      layout: blockSlide.layout,
      blocks: blockSlide.blocks,
    },
    `${token}: fenced and block-token forms reach the same chart model`
  )
}

TRIGGER_DICTIONARY.registrychart = { key: 'chart', value: 'bar' }
try {
  const freshObjectTokenUrl = new URL(
    '../compiler/scripts/lib/03-object-token.mjs',
    import.meta.url
  )
  freshObjectTokenUrl.searchParams.set('registry-extension-test', String(Date.now()))
  const freshObjectToken = await import(freshObjectTokenUrl.href)
  const registryDerivedFenceAliases = Object.keys(TRIGGER_DICTIONARY)
    .filter((token) => freshObjectToken.parseChartObjectTokenLine(`{${token}}`))
    .sort()
  assert.deepEqual(
    Array.from(freshObjectToken.CHART_FENCE_ALIASES ?? []).sort(),
    registryDerivedFenceAliases,
    'the fence-alias set equals every registry token recognised by the block-token resolver'
  )
  assert.equal(
    freshObjectToken.parseChartFenceOpeningLine('```registrychart')?.chartLike,
    true,
    'a registry addition extends chart-like fence detection without changing object-token code'
  )
} finally {
  delete TRIGGER_DICTIONARY.registrychart
}

for (const token of ['chart=bar', 'chart=pie', 'chart=line']) {
  const block = await compiledOutput(`{${token}}\n${valueList.join('\n')}`)
  const fence = await compiledOutput(`\`\`\`${token}\n${valueList.join('\n')}\n\`\`\``)
  assert.deepEqual(
    fence.slides,
    block.slides,
    `${token}: fenced and block-token forms produce byte-identical rendered slide output`
  )
  assert.equal(
    fence.handout,
    block.handout,
    `${token}: fenced and block-token forms produce byte-identical handout output`
  )
}

const iconValueList = ['- Alpha: 40 {icon=zap}', '- Beta: 60']
const iconBlock = await compiledOutput(`{chart=bar}\n${iconValueList.join('\n')}`)
const iconFence = await compiledOutput(
  `\`\`\`chart=bar\n${iconValueList.join('\n')}\n\`\`\``
)
assert.equal(
  iconFence.slides.find((slide) => slide.id === 'equivalent-chart')?.html,
  iconBlock.slides.find((slide) => slide.id === 'equivalent-chart')?.html,
  'fenced and block chart forms compile byte-identical HTML when a list item has an icon token'
)

const coexistenceBodies = [
  {
    name: 'adjacent fenced and block-token charts',
    body: [
      '{chart=pie}',
      '- Block Alpha: 25',
      '- Block Beta: 75',
      '',
      '```chart=line',
      '- Fence 2024: 40',
      '- Fence 2025: 60',
      '```',
    ].join('\n'),
    expectedLayout: 'chart',
    fenceLine: 15,
  },
  {
    name: 'fenced and block-token charts with intervening text',
    body: [
      '{chart=pie}',
      '- Block Alpha: 25',
      '- Block Beta: 75',
      '',
      'The second chart follows this sentence.',
      '',
      '```chart=line',
      '- Fence 2024: 40',
      '- Fence 2025: 60',
      '```',
    ].join('\n'),
    expectedLayout: 'statement',
    fenceLine: 17,
  },
]
for (const scenario of coexistenceBodies) {
  const source = outline(scenario.body)
  const slide = adaptMarkdownOutlineV2(source, scenario.name)
    .slides.find((candidate) => candidate.id === 'equivalent-chart')
  assert.deepEqual(
    {
      layout: slide.layout,
      charts: slide.blocks
        .filter((block) => block.type === 'chart')
        .map((block) => ({
          shape: block.shape,
          labels: block.points.map((point) => point.label),
        })),
    },
    {
      layout: scenario.expectedLayout,
      charts: [
        { shape: 'pie', labels: ['Block Alpha', 'Block Beta'] },
        { shape: 'line', labels: ['Fence 2024', 'Fence 2025'] },
      ],
    },
    `${scenario.name}: both chart objects reach the render model in document order`
  )
  assert.deepEqual(
    scanOutlineTriggers(source),
    [
      {
        kind: 'trigger-conflict',
        token: 'chart=pie',
        line: 11,
        headingLine: 8,
        slideTitle: 'Equivalent chart',
        detail: `chart block-token form 'chart=pie' is shadowed by fence 'chart=line' at line ${scenario.fenceLine}`,
      },
    ],
    `${scenario.name}: the Doctor names the compatibility form shadowed by the canonical fence`
  )
  const output = await compiledOutput(scenario.body)
  const html = output.slides.find((candidate) => candidate.id === 'equivalent-chart')?.html ?? ''
  assert.equal(
    (html.match(/class="chart-pie"/g) ?? []).length,
    1,
    `${scenario.name}: the block-token chart has one rendered host`
  )
  assert.equal(
    (html.match(/class="chart-line"/g) ?? []).length,
    1,
    `${scenario.name}: the fenced chart has one rendered host`
  )
  const authoredOrder = [
    html.indexOf('Block Alpha'),
    html.indexOf('Block Beta'),
    html.indexOf('Fence 2024'),
    html.indexOf('Fence 2025'),
  ]
  assert(
    authoredOrder.every((position) => position >= 0)
      && authoredOrder.every((position, index) => index === 0 || authoredOrder[index - 1] < position),
    `${scenario.name}: both rendered data sets stay in document order`
  )
}

const unresolvedSource = [
  '### Broken chart fence',
  '{id=broken-chart-fence}',
  '',
  '```chart=donut',
  '- Alpha: 40',
  '```',
  '',
].join('\n')
assert.deepEqual(
  lexMarkdownBlocks(['```chart=donut', '- Alpha: 40', '```']).map((block) => block.type),
  ['code'],
  'an unregistered chart fence never reaches the chart render path'
)
assert.deepEqual(
  scanOutlineTriggers(unresolvedSource)
    .map(({ kind, token, line, headingLine, slideTitle }) => ({
      kind,
      token,
      line,
      headingLine,
      slideTitle,
    })),
  [{
    kind: 'unregistered-value',
    token: 'chart=donut',
    line: 4,
    headingLine: 1,
    slideTitle: 'Broken chart fence',
  }],
  'the Doctor reports an unresolved chart info string at the opening-fence line'
)
assert.equal(
  unresolvedTriggerBlock(unresolvedSource)?.first.token,
  'chart=donut',
  'an unresolved chart fence blocks publishing'
)

const whitespaceBeforeEqualsSource = [
  '### Spaced chart fence',
  '{id=spaced-chart-fence}',
  '',
  '```chart =bar',
  '- Alpha: 40',
  '```',
  '',
].join('\n')
assert.deepEqual(
  scanOutlineTriggers(whitespaceBeforeEqualsSource)
    .map(({ kind, token, line, headingLine, slideTitle }) => ({
      kind,
      token,
      line,
      headingLine,
      slideTitle,
    })),
  [{
    kind: 'unregistered-key',
    token: 'chart =bar',
    line: 4,
    headingLine: 1,
    slideTitle: 'Spaced chart fence',
  }],
  'whitespace before the equals sign remains unresolved but cannot hide a chart-like typo'
)
assert.equal(
  unresolvedTriggerBlock(whitespaceBeforeEqualsSource)?.first.token,
  'chart =bar',
  'a chart-like fence with whitespace before the equals sign blocks publishing'
)

const invalidRegisteredBodySource = [
  '### Invalid registered chart body',
  '{id=invalid-registered-chart-body}',
  '',
  '```chart=bar',
  '- Alpha: 40',
  'This paragraph makes the body more than one list block.',
  '```',
  '',
].join('\n')
assert.deepEqual(
  lexMarkdownBlocks([
    '```chart=bar',
    '- Alpha: 40',
    'This paragraph makes the body more than one list block.',
    '```',
  ]).map((block) => block.type),
  ['code'],
  'a registered chart fence compiles only when its body is exactly one list'
)
assert.deepEqual(
  scanOutlineTriggers(invalidRegisteredBodySource)
    .map(({ kind, token, line, headingLine, slideTitle, detail }) => ({
      kind,
      token,
      line,
      headingLine,
      slideTitle,
      detail,
    })),
  [{
    kind: 'unregistered-value',
    token: 'chart=bar',
    line: 4,
    headingLine: 1,
    slideTitle: 'Invalid registered chart body',
    detail: 'registered chart fence body must be exactly one list',
  }],
  'a registered chart fence with an invalid body produces a visible Doctor finding'
)
assert.equal(
  unresolvedTriggerBlock(invalidRegisteredBodySource)?.first.token,
  'chart=bar',
  'an invalid registered chart fence blocks publishing'
)

const partiallyConsumedBodySource = [
  '### Partially consumed chart body',
  '{id=partially-consumed-chart-body}',
  '',
  '```chart=bar',
  '- Alpha: 40',
  '| Beta: 60',
  '```',
  '',
].join('\n')
assert.deepEqual(
  lexMarkdownBlocks([
    '```chart=bar',
    '- Alpha: 40',
    '| Beta: 60',
    '```',
  ]).map((block) => ({
    type: block.type,
    text: block.text,
  })),
  [{
    type: 'code',
    text: '- Alpha: 40\n| Beta: 60',
  }],
  'a registered chart fence never renders a partially consumed list body as a complete chart'
)
assert.deepEqual(
  scanOutlineTriggers(partiallyConsumedBodySource)
    .map(({ kind, token, line, detail }) => ({ kind, token, line, detail })),
  [{
    kind: 'unregistered-value',
    token: 'chart=bar',
    line: 4,
    detail: 'registered chart fence body must be exactly one list',
  }],
  'the lexer and Doctor reject the same partially consumed chart body'
)

const fenceExtentScenarios = [
  {
    name: 'four-backtick chart fence',
    opening: '````chart=bar',
    closing: '````',
  },
  {
    name: 'three-backtick chart fence with a four-backtick close',
    opening: '```chart=bar',
    closing: '````',
  },
]
for (const scenario of fenceExtentScenarios) {
  const fenceLines = [
    scenario.opening,
    '- Alpha: 40',
    '- Beta: 60',
    scenario.closing,
  ]
  assert.deepEqual(
    lexMarkdownBlocks(fenceLines).map((block) => ({
      type: block.type,
      token: block.token,
      shape: block.shape,
      items: block.list?.items,
    })),
    [{
      type: 'object-chart',
      token: 'chart=bar',
      shape: 'bar',
      items: ['Alpha: 40', 'Beta: 60'],
    }],
    `${scenario.name}: the lexer uses the authored opening marker to determine extent`
  )
  const source = [
    `### ${scenario.name}`,
    '{id=fence-extent}',
    '',
    ...fenceLines,
    '',
  ].join('\n')
  assert.deepEqual(
    scanOutlineTriggers(source),
    [],
    `${scenario.name}: the Doctor reads the same fence extent as the lexer`
  )
  assert.deepEqual(
    parseSlideScript(source),
    [{
      type: 'list',
      items: [
        { depth: 0, text: 'Alpha: 40' },
        { depth: 0, text: 'Beta: 60' },
      ],
    }],
    `${scenario.name}: slide script reads the same fence extent as the lexer`
  )
}

const shorterMarkerInsideLongFence = await compiledOutput([
  '````chart=bar',
  '- Alpha: 40',
  '```',
  '- Beta: 60',
  '````',
].join('\n'))
const shorterMarkerSlideHtml = shorterMarkerInsideLongFence.slides
  .find((slide) => slide.id === 'equivalent-chart')?.html ?? ''
assert.match(
  shorterMarkerSlideHtml,
  /- Alpha: 40\n```\n- Beta: 60/,
  'a four-backtick chart fence keeps a three-backtick marker inside the compiled code body'
)

const tildeProtectedSource = [
  '### Tilde-protected example',
  '{id=tilde-protected}',
  '',
  '~~~md',
  '```chart=donut',
  '- Alpha: 40',
  '```',
  '~~~',
  '',
].join('\n')
assert.deepEqual(
  lexMarkdownBlocks([
    '~~~md',
    '```chart=donut',
    '- Alpha: 40',
    '```',
    '~~~',
  ]).map((block) => block.type),
  ['code'],
  'a tilde fence is one opaque compiler code block'
)
assert.deepEqual(
  scanOutlineTriggers(tildeProtectedSource),
  [],
  'a chart-shaped backtick line inside a tilde fence is opaque to the Doctor'
)

const unterminatedFencePublishBlocks = ['~~~', '```'].map((opening) => {
  const source = [
    '### Real',
    '{id=real}',
    opening,
    'some code',
    '',
    '### Later',
    '{id=later}',
    '{bogustoken}',
    '',
  ].join('\n')
  const block = unresolvedTriggerBlock(source)
  return block
    ? {
        marker: opening,
        token: block.first.token,
        line: block.first.line,
        headingLine: block.first.headingLine,
        slideTitle: block.first.slideTitle,
      }
    : null
})
assert.deepEqual(
  unterminatedFencePublishBlocks,
  [
    {
      marker: '~~~',
      token: 'bogustoken',
      line: 8,
      headingLine: 6,
      slideTitle: 'Later',
    },
    {
      marker: '```',
      token: 'bogustoken',
      line: 8,
      headingLine: 6,
      slideTitle: 'Later',
    },
  ],
  'unterminated tilde and backtick fences reset at a later slide heading and cannot silence publishing'
)

const caseMismatchSource = [
  '### Case-mismatched value form',
  '{id=case-mismatched-value}',
  '',
  '```CHART=BAR',
  '- Alpha: 40',
  '```',
  '',
  '### Case-mismatched bare alias',
  '{id=case-mismatched-alias}',
  '',
  '```BARCHART',
  '- Alpha: 40',
  '```',
  '',
  '### Case-mismatched chart word',
  '{id=case-mismatched-word}',
  '',
  '```Chart',
  '- Alpha: 40',
  '```',
  '',
].join('\n')
assert.deepEqual(
  lexMarkdownBlocks(['```CHART=BAR', '- Alpha: 40', '```']).map((block) => block.type),
  ['code'],
  'the fence accepts exactly the case-sensitive forms accepted by the chart token grammar'
)
assert.equal(
  unresolvedTriggerBlock(caseMismatchSource)?.count,
  3,
  'every case-mismatched chart-like fence is unresolved rather than silently normalised'
)
assert.deepEqual(
  scanOutlineTriggers(caseMismatchSource)
    .map(({ kind, token, line }) => ({ kind, token, line })),
  [
    { kind: 'unregistered-key', token: 'CHART=BAR', line: 4 },
    { kind: 'unknown-word', token: 'BARCHART', line: 11 },
    { kind: 'unknown-word', token: 'Chart', line: 18 },
  ],
  'chart-like detection is case-insensitive while registered chart resolution stays exact'
)

const preambleChartLikeSource = [
  '```Chart',
  '- Alpha: 40',
  '```',
  '',
  '### Later slide',
  '{id=later-slide}',
  '',
].join('\n')
assert.deepEqual(
  scanOutlineTriggers(preambleChartLikeSource)
    .map(({ kind, token, line, headingLine, slideTitle }) => ({
      kind,
      token,
      line,
      headingLine,
      slideTitle,
    })),
  [{
    kind: 'unknown-word',
    token: 'Chart',
    line: 1,
    headingLine: 1,
    slideTitle: 'Deck preamble',
  }],
  'a chart-like fence before the first heading is anchored to a preamble pseudo-heading'
)
assert.equal(
  unresolvedTriggerBlock(preambleChartLikeSource)?.first.token,
  'Chart',
  'a chart-like fence in the preamble blocks publishing'
)

assert.deepEqual(
  scanOutlineTriggers('### Ordinary code\n\n```python\nprint(1)\n```\n'),
  [],
  'ordinary code-fence languages remain outside chart authority'
)
assert.deepEqual(
  scanOutlineTriggers([
    '### Nested fenced example',
    '{chart=pie}',
    '',
    '````md',
    '```chart=bar',
    '- Alpha: 40',
    '```',
    '````',
    '',
  ].join('\n')).filter((finding) => finding.detail?.includes('shadowed by fence')),
  [],
  'a chart-shaped fence nested inside a longer Markdown fence is opaque to precedence'
)

const sampler = readFileSync(fixturePath, 'utf8')
const compiledSampler = await prepareSource(
  fixturePath,
  sampler,
  'Layout sampler',
  fixtureStat
)
const compiledSamplerSlides = extractSlides(compiledSampler.fullHtml)
for (const [id, chartClass, labels] of [
  ['fenced-chart-bar', 'chart-cols', ['Alpha', 'Beta', 'Gamma']],
  ['fenced-chart-pie', 'chart-pie', ['Deep work', 'Meetings', 'Email and admin', 'Learning']],
  ['fenced-chart-line', 'chart-line', ['2022', '2023', '2024', '2025']],
]) {
  const html = compiledSamplerSlides.find((slide) => slide.id === id)?.html ?? ''
  assert.match(
    html,
    new RegExp(`class="${chartClass}(?:\\s|")`),
    `${id}: the sampler compiles the expected chart host`
  )
  for (const label of labels) {
    assert.match(
      html,
      new RegExp(`>${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`),
      `${id}: the compiled chart renders ${label}`
    )
  }
}

console.log(
  `chart fences: PASS (${registeredForms.length} registered readings; `
  + '3 byte-parity pairs; unresolved publish block; sampler trio)'
)
