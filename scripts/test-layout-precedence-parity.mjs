import { strict as assert } from 'node:assert'
import { parseGridDims } from '../compiler/scripts/lib/01-cli-utils.mjs'
import { parseHeadingAttrs } from '../compiler/scripts/lib/02-triggers-layout.mjs'
import { adaptMarkdownOutlineV2 } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { scanOutlineTriggers } from '../src/shared/layout-doctor.ts'
import {
  TRIGGER_VOCABULARY,
  winningAuthoredLayout,
} from '../src/shared/layout-registry/vocabulary.ts'

function compilerAuthoredLayout(line) {
  const attrs = parseHeadingAttrs(line).attrs
  if (typeof attrs.layout === 'string') return attrs.layout
  if (attrs.statement != null) return 'statement'
  if (attrs.cols != null && attrs.cols !== true) return 'columns'
  if (attrs.timeline != null && attrs.timeline !== true) return 'timeline'
  if (attrs.chart != null && attrs.chart !== true) return 'chart'
  if (attrs.curve === 'sigmoid') return 'sigmoid'
  if (attrs.contrast != null && attrs.contrast !== true) return 'contrast'
  if (attrs.equation != null && attrs.equation !== true) return 'equation'
  if (parseGridDims(attrs.blocks)) return 'grid'
  if (attrs.cards != null && attrs.cards !== true) return 'cards'
  return null
}

const tokens = new Set(TRIGGER_VOCABULARY.bareWords)
for (const [key, values] of TRIGGER_VOCABULARY.valueVocab) {
  for (const value of values) tokens.add(`${key}=${value}`)
}
tokens.add('blocks:2x3')
tokens.add('cols=4')
tokens.add('curve=sigmoid')

let cases = 0
for (const first of tokens) {
  for (const second of tokens) {
    const line = `{${first}}{${second}}`
    assert.equal(
      winningAuthoredLayout(line)?.layout ?? null,
      compilerAuthoredLayout(line),
      `registry precedence mirror drifted for ${line}`
    )
    cases += 1
  }
}

const equalsBeforeColonVocabulary = {
  bareWords: new Set(),
  dynamicSources: [],
  valueVocab: new Map([['chart', new Set(['pie:labelled'])]]),
  openPatterns: new Map(),
}
assert.deepEqual(
  winningAuthoredLayout('{chart=pie:labelled}', equalsBeforeColonVocabulary),
  { layout: 'chart', triggerToken: 'chart=pie:labelled' },
  'equals-form tokens are resolved before a colon inside their value'
)

const fencePrecedenceSource = [
  '### Fence precedence',
  '{id=fence-precedence}{chart=bar}',
  '',
  '{piechart}',
  '- Block form: 25',
  '',
  '```chart=line',
  '- 2024: 40',
  '- 2025: 60',
  '```',
  '',
].join('\n')
const fencePrecedenceSlide = adaptMarkdownOutlineV2(
  fencePrecedenceSource,
  'Fence precedence'
).slides.find((slide) => slide.id === 'fence-precedence')
assert.deepEqual(
  fencePrecedenceSlide.blocks.map((block) => [
    block.type,
    block.shape ?? null,
    block.objectToken ?? null,
  ]),
  [
    ['chart', 'pie', 'piechart'],
    ['chart', 'line', 'chart=line'],
  ],
  'content-level chart forms remain separate objects in document order'
)
assert.deepEqual(
  scanOutlineTriggers(fencePrecedenceSource)
    .filter((finding) => finding.detail?.includes('shadowed by'))
    .map(({ kind, token, line, detail }) => ({ kind, token, line, detail }))
    .sort((left, right) => left.line - right.line),
  [
    {
      kind: 'trigger-conflict',
      token: 'chart=bar',
      line: 2,
      detail: "chart Trigger-line form is shadowed by fence 'chart=line' at line 7",
    },
    {
      kind: 'trigger-conflict',
      token: 'piechart',
      line: 4,
      detail: "chart block-token form 'piechart' is shadowed by fence 'chart=line' at line 7",
    },
  ],
  'the Doctor names both compatibility forms shadowed by the canonical fence'
)

console.log(
  `layout precedence parity: PASS (${cases} ordered registry-token pairs; `
  + '2 hand-written fence assertions)'
)
