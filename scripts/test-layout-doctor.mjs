import { strict as assert } from 'node:assert'
import { OPEN_PATTERN_TOKENS } from '../src/shared/layout-registry/entries.ts'
import {
  buildTriggerVocabulary,
  isRegisteredTriggerToken
} from '../src/shared/layout-registry/vocabulary.ts'
import {
  fencedLineFlags,
  scanFencedLines
} from '../src/shared/outline-normalize.ts'
import { lexMarkdownBlocks } from '../compiler/scripts/lib/03-markdown-lexer.mjs'
import { CHART_FENCE_ALIASES } from '../compiler/scripts/lib/03-object-token.mjs'
import {
  extractIdSlides
} from '../compiler/scripts/lib/13-slide-ledger.mjs'
import {
  replaceSlideBlock
} from '../compiler/scripts/lib/14-slide-propagation.mjs'
import {
  identityCanon
} from '../src/renderer/src/components/slideBrowserModel.ts'

const vocab = buildTriggerVocabulary()

assert.equal(OPEN_PATTERN_TOKENS.length, 22, 'open patterns live in the registry (ADR-0020 R1)')
assert(
  OPEN_PATTERN_TOKENS.every((token) =>
    token.key && token.justification && (token.form === 'bare' || Boolean(token.pattern))
  ),
  'every valued open pattern has a regex and every presence declaration is justified'
)

// Bare words come from entry triggerWords (fact: 80 words in the generated dictionary today).
assert(vocab.bareWords.has('statement'), 'statement is a bare word')
assert(vocab.bareWords.has('timelinespine'), 'timelinespine remains a registered bare alias')
assert(!vocab.bareWords.has('nonsense'), 'unknown words are not bare words')

// Value vocabularies come from option-group values + dictionaryTokens + value-form entry triggers.
assert(vocab.valueVocab.get('contrast')?.has('rows'), 'contrast=rows is a registered value')
assert(vocab.valueVocab.get('contrast')?.has('cards'), 'contrast=cards entry trigger contributes its value')
assert(vocab.valueVocab.get('bg')?.has('cobalt'), 'global group values are registered')
assert(vocab.valueVocab.get('mode')?.has('reveal'), 'dictionaryTokens are registered values')
assert.deepEqual(
  [...(vocab.valueVocab.get('icons') ?? [])],
  ['top', 'all', 'off', 'none', 'on', 'yes'],
  'the list renderer icon-level override has a finite registered vocabulary'
)

// The layout key itself has a vocabulary: every layout-kind entry name.
assert(vocab.valueVocab.get('layout')?.has('statement'), 'layout=statement is registered')
assert(vocab.valueVocab.get('layout')?.has('code'), 'layout=code is registered through the code entry resolvesTo target')
assert(!vocab.valueVocab.get('layout')?.has('nonsense'), 'layout=nonsense is not registered')

// Open patterns (interim list until the Register-reality milestone moves them into entries.ts).
assert(vocab.openPatterns.get('id')?.form === 'equals', 'id= is an open pattern')
assert(vocab.openPatterns.get('timer')?.form === 'equals', 'timer= is an open section-duration pattern')
for (const token of ['polltop=2', 'pollselections=2', 'pollsubmissions=2', 'pollsubmissions=unlimited']) {
  assert(isRegisteredTriggerToken(token, vocab), `${token} is a registered poll constraint`)
}
assert(vocab.openPatterns.get('blocks')?.form === 'colon', 'blocks:RxC is an open colon pattern')
assert(new RegExp(`^(?:${vocab.openPatterns.get('blocks').pattern})$`).test('3x3'), 'blocks pattern accepts 3x3')
assert(!new RegExp(`^(?:${vocab.openPatterns.get('blocks').pattern})$`).test('banana'), 'blocks pattern rejects banana')

console.log('vocabulary: PASS')

import * as layoutDoctor from '../src/shared/layout-doctor.ts'

const { scanOutlineTriggers } = layoutDoctor

const structuralFenceFixtures = [
  {
    name: 'tilde fence',
    opening: '~~~',
    interiorMarker: '## Two',
    closing: '~~~'
  },
  {
    name: 'four-backtick fence',
    opening: '````md',
    interiorMarker: '```',
    closing: '````'
  }
]
for (const fixture of structuralFenceFixtures) {
  const lines = [
    '## One',
    '{id=one}',
    fixture.opening,
    fixture.interiorMarker,
    '{nonsense}',
    fixture.closing,
    '{statement}{quote}',
    'Real body text.'
  ]
  const source = lines.join('\n')
  assert.deepEqual(
    scanFencedLines(lines),
    {
      flags: [false, false, true, true, true, true, false, false],
      extents: [{
        opening: {
          marker: fixture.opening.match(/^(`+|~+)/)[0],
          info: fixture.opening.replace(/^(`+|~+)/, '')
        },
        start: 2,
        bodyEnd: 5,
        end: 6,
        closed: true
      }]
    },
    `${fixture.name}: the shared structural scan reports the exact authored extent`
  )
  assert.deepEqual(
    fencedLineFlags(lines),
    [false, false, true, true, true, true, false, false],
    `${fixture.name}: the public line-mask consumer reads the same fence extent`
  )
  assert.deepEqual(
    lexMarkdownBlocks(lines.slice(2, 6)),
    [{
      type: 'code',
      lang: fixture.opening.replace(/^(`+|~+)/, '').toLowerCase(),
      text: `${fixture.interiorMarker}\n{nonsense}`
    }],
    `${fixture.name}: the lexer keeps the exact shared extent opaque`
  )
  assert.equal(
    extractIdSlides(source)[0]?.markdown,
    source,
    `${fixture.name}: the slide ledger does not split on a heading-shaped fenced line`
  )
  assert.deepEqual(
    scanOutlineTriggers(source).map(({ kind, token, line }) => ({ kind, token, line })),
    [{
      kind: 'duplicate-layout',
      token: 'quote',
      line: 7
    }],
    `${fixture.name}: the Doctor ignores fenced tokens and diagnoses the real outer conflict`
  )

  const replacement = [
    '### One',
    '{id=target}',
    fixture.opening,
    fixture.interiorMarker,
    fixture.closing,
    'Real body text.'
  ].join('\n')
  const propagated = replaceSlideBlock(
    '#### Target\n{id=target}\nOld body',
    'target',
    replacement
  )
  assert.equal(
    propagated,
    replacement.replace(/^### One/, '#### One'),
    `${fixture.name}: propagation re-depths the slide heading without touching fenced headings`
  )
  assert.equal(
    identityCanon(replacement.replace(/^### One/, '## One')),
    replacement
      .replace(/^### One/, '### One')
      .replace('{id=target}\n', ''),
    `${fixture.name}: the slide browser normalises only structural headings outside the fence`
  )
}

const kinds = (text) => scanOutlineTriggers(text).map((f) => `${f.kind}:${f.token}`)
const assertCleanValues = (key, values) => {
  for (const value of values) {
    assert.deepEqual(
      kinds(`### T\n{${key}=${value}}\n`),
      [],
      `${key}=${value} is accepted by the compiler normaliser and must be clean in the Doctor`
    )
  }
}

const resolverDoctorBattery = [
  ['statement', true],
  ['chart=pie', true],
  ['flow=horizontal', true],
  ['blocks:3x3', true],
  ['countdown-digits-90s', true],
  ['id=abc123', true],
  ['layout=statement', true],
  ['nonsense', false],
  ['quote=bar', false],
  ['blocks:banana', false],
  ['layout=nonsense', false],
]
for (const [token, expected] of resolverDoctorBattery) {
  const resolverAccepts = isRegisteredTriggerToken(token)
  const doctorAccepts = kinds(`### T\n{${token}}\n`).length === 0
  assert.equal(resolverAccepts, expected, `shared resolver classifies ${token}`)
  assert.equal(
    doctorAccepts,
    resolverAccepts,
    `Layout Doctor copy agrees with the shared resolver for ${token}`
  )
}

// Silent pass-through today (PRD "measured gaps"): these MUST become findings.
assert.deepEqual(kinds('### T\n{layout=nonsense}\n'), ['unregistered-value:layout=nonsense'])
assert.deepEqual(kinds('### T\n{layout=code}\n'), [])
assert.deepEqual(kinds('### T\n{nonsense}\n'), ['unknown-word:nonsense'])
// D2 landed: timeline modes are registered values now.
assert.deepEqual(kinds('### T\n{timeline=rail}\n'), [])
assert.deepEqual(kinds('### T\n{timeline=spine}\n'), [])
assert.deepEqual(kinds('### T\n{timeline=vertical}\n'), [])
assert.deepEqual(kinds('### T\n{timeline=banana}\n'), ['unregistered-value:timeline=banana'])
assert.deepEqual(kinds('### T\n{timelinespine}\n'), [])
assert.deepEqual(kinds('### T\n{timeline-visual}\n'), [])
assert.deepEqual(kinds('### T\n{list-visual}\n'), [])
assert.deepEqual(kinds('### T\n{layout=timeline-visual}\n'), [])
assert.deepEqual(kinds('### T\n{chart=pie}\n'), [])
assert.deepEqual(kinds('### T\n{chart=donut}\n'), ['unregistered-value:chart=donut'])
assertCleanValues('title', ['side', 'sidebar', 'top', 'off', 'none', 'hide'])
assert.deepEqual(kinds('### T\n{title=banana}\n'), ['unregistered-value:title=banana'])
assertCleanValues('align', ['top', 'center', 'centre', 'middle'])
assert.deepEqual(kinds('### T\n{align=banana}\n'), ['unregistered-value:align=banana'])
assertCleanValues('icons', ['top', 'all', 'off', 'none', 'on', 'yes'])
assert.deepEqual(kinds('### T\n{icons=banana}\n'), ['unregistered-value:icons=banana'])
assert.deepEqual(
  [...(vocab.valueVocab.get('section') ?? [])],
  ['corner', 'off', 'on', 'show', 'none', 'hide'],
  'the frame section label has the compiler normaliser’s complete finite vocabulary'
)
assert.deepEqual(kinds('### T\n{section=corner}\n'), [])
assert.deepEqual(kinds('### T\n{section=off}\n'), [])
assert.deepEqual(kinds('### T\n{section=banana}\n'), ['unregistered-value:section=banana'])

// Registered things are clean.
assert.deepEqual(kinds('### Clean\n{statement}\n'), [])
assert.deepEqual(kinds('### Clean\n{contrast=rows}{reveal}\n'), [])
assert.deepEqual(kinds('### Clean\n{blocks:3x3}\n'), [])
assert.deepEqual(kinds('### Clean\n{id=abc123}{kicker="A, B"}\n'), [])
assert.deepEqual(kinds('### T\n{id=pptx-e9231736f173-101}\n'), [])
// Heading-trailing triggers are scanned too (parseHeadingAttrs peels them the same way).
assert.deepEqual(kinds('### Clean {statement}\n'), [])
// Dynamic families resolve.
assert.deepEqual(kinds('### Clean\n{countdown-digits-90s}\n'), [])
// Fenced heading-shaped lines are code, not slides.
assert.deepEqual(kinds('### T\n{statement}\n```\n### fake {nonsense}\n```\n'), [])

// Exclusivity (ADR-0020 R2): two layout words on one slide.
assert.deepEqual(kinds('### T\n{statement}{quote}\n'), ['duplicate-layout:quote'])
assert.deepEqual(kinds('### T\n{contrast=cards}\n'), [])
// Same non-layout key, two values.
assert.deepEqual(kinds('### T\n{bg=cobalt}{bg=emerald}\n'), ['trigger-conflict:bg=emerald'])
// Same key, same value: no conflict (alias last-wins stays silent, ADR-0020 D2).
assert.deepEqual(kinds('### T\n{bg=cobalt}{bg=cobalt}\n'), [])

const chartAuthorityFindings = scanOutlineTriggers(
  '### Gate shape\n{id=gate-shape}{chart=bar}\n\n{piechart}\n\n- Alpha: 40\n- Beta: 60\n'
)
assert.deepEqual(
  chartAuthorityFindings.map(({ kind, token, line, detail }) => ({ kind, token, line, detail })),
  [{
    kind: 'trigger-conflict',
    token: 'chart=bar',
    line: 2,
    detail: "chart Trigger-line form is shadowed by block token 'piechart' at line 4"
  }],
  'the Doctor flags the competing Trigger-line form at its authored line'
)
assert.deepEqual(
  scanOutlineTriggers(
    '### Statement wins {chart=bar} {statement}\n{id=statement-wins}\n\n{piechart}\n- Alpha: 40\n'
  ).filter((finding) => finding.detail?.includes('shadowed by block token')),
  [],
  'the Doctor records chart authority from the whole Trigger line winner, not a losing chart token'
)

const multipleBlockShadowFindings = scanOutlineTriggers([
  '### Multiple content charts',
  '{id=multiple-content-charts}{chart=bar}',
  '',
  '{piechart}',
  '- Block Alpha: 40',
  '',
  '{linechart}',
  '- Block 2025: 60',
  '',
].join('\n'))
assert.deepEqual(
  multipleBlockShadowFindings
    .filter((finding) => finding.detail?.includes('shadowed by block token'))
    .map(({ kind, token, line, detail }) => ({ kind, token, line, detail })),
  [
    {
      kind: 'trigger-conflict',
      token: 'chart=bar',
      line: 2,
      detail: "chart Trigger-line form is shadowed by block token 'piechart' at line 4",
    },
    {
      kind: 'trigger-conflict',
      token: 'chart=bar',
      line: 2,
      detail: "chart Trigger-line form is shadowed by block token 'linechart' at line 7",
    },
  ],
  'the Doctor emits one Trigger shadow finding for every block token at its authored line'
)
assert.deepEqual(
  scanOutlineTriggers(
    '### Same chart shape\n{id=same-chart}{chart=pie}\n\n{piechart}\n- Alpha: 40\n'
  ).filter((finding) => finding.detail?.includes('shadowed by block token'))
    .map(({ kind, token, line, detail }) => ({ kind, token, line, detail })),
  [{
    kind: 'trigger-conflict',
    token: 'chart=pie',
    line: 2,
    detail: "chart Trigger-line form is shadowed by block token 'piechart' at line 4",
  }],
  'every content-level chart form shadows the slide-scoped compatibility form'
)

// Deck-wide defaults use the same parseHeadingAttrs token surface as slide trigger lines.
const frontmatterFindings = scanOutlineTriggers(
  '---\ntriggers: reveal nonsense\n---\n# Deck\n\n### T\n{statement}\n'
)
assert.deepEqual(
  frontmatterFindings.map(({ kind, token, line, headingLine, slideTitle }) => ({
    kind,
    token,
    line,
    headingLine,
    slideTitle
  })),
  [{
    kind: 'unknown-word',
    token: 'nonsense',
    line: 2,
    headingLine: 2,
    slideTitle: 'Deck frontmatter (triggers:)'
  }]
)
assert.deepEqual(
  kinds('---\ntriggers: reveal bg=cobalt\n### YAML comment {nonsense}\n---\n# Deck\n\n### T\n{statement}\n'),
  []
)

// Byte-identical findings from repeated tokens on one source line are reported once.
assert.deepEqual(
  kinds('### T\n{statement quote quote}\n'),
  ['duplicate-layout:quote']
)

// Duplicate slide ids across slides.
assert.deepEqual(
  kinds('### A\n{id=abc}\n\n### B\n{id=abc}\n'),
  ['duplicate-slide-id:id=abc']
)

CHART_FENCE_ALIASES.add('id')
try {
  assert.deepEqual(
    kinds('```id=duplicate\n- Alpha: 40\n```\n\n### Later\n{id=duplicate}\n'),
    [],
    'a resolvable chart-like token in the deck preamble cannot claim an id from a later slide'
  )
} finally {
  CHART_FENCE_ALIASES.delete('id')
}

assert.equal(typeof layoutDoctor.unresolvedTriggerFindings, 'function', 'D1 exposes one shared outbound-blocking predicate')
assert.equal(layoutDoctor.unresolvedTriggerFindings('### T\n{nonsense}\n').length, 1)
assert.equal(layoutDoctor.unresolvedTriggerFindings('### T\n{statement}{quote}\n').length, 0)
const unresolvedBlock = layoutDoctor.unresolvedTriggerBlock(
  '### Safe\n{statement}\n\n### Broken\n{nonsense}\n\n### Later\n{layout=banana}\n'
)
assert.equal(unresolvedBlock.count, 2)
assert.equal(unresolvedBlock.first.slideTitle, 'Broken', 'the outbound block names the first offending slide')
assert.equal(unresolvedBlock.first.headingLine, 4, 'the outbound block carries the first slide heading line')
assert.equal(
  unresolvedBlock.message,
  'This talk has 2 unresolved triggers. Publishing, exporting and presenting live are blocked until they are fixed.',
  'the outbound block uses the human British-English refusal'
)

console.log('layout doctor: PASS')
