import { strict as assert } from 'node:assert'
import { parseHeadingAttrs } from '../compiler/scripts/lib/02-triggers-layout.mjs'
import { DYNAMIC_PATTERNS } from '../compiler/scripts/lib/trigger-dictionary.generated.mjs'
import { TRIGGER_DICTIONARY, VALUE_TRIGGER_DICTIONARY } from '../compiler/scripts/triggers.mjs'
import { scanOutlineTriggers } from '../src/shared/layout-doctor.ts'
import { LAYOUTS, OPEN_PATTERN_TOKENS } from '../src/shared/layout-registry/entries.ts'
import { fencedLineFlags } from '../src/shared/outline-normalize.ts'
import { TRIGGER_LINE_RE } from '../src/shared/trigger-line.ts'

const warningsOf = (raw) => parseHeadingAttrs(raw).warnings
const assertCleanValues = (key, values) => {
  for (const value of values) {
    assert.deepEqual(
      warningsOf(`T {${key}=${value}}`),
      [],
      `${key}=${value} is accepted by the frame normaliser and must be clean in compiler validation`
    )
  }
}

// The measured gaps (PRD): total silent pass-through must end.
assert.deepEqual(warningsOf('T {layout=nonsense}'), ['unresolved-trigger:layout=nonsense'])
assert.deepEqual(warningsOf('T {timeline=banana}'), ['unresolved-trigger:timeline=banana'])
assert.deepEqual(warningsOf('T {frobnicate=7}'), ['unresolved-trigger:frobnicate=7'])
assert.deepEqual(warningsOf('T {blocks:banana}'), ['unresolved-trigger:blocks=banana'])

// Ticket 13: {page-60|70|80} is registered; any other width is unresolved (the compiler falls back to 70).
for (const value of ['60', '70', '80']) assert.deepEqual(warningsOf(`T {page-${value}}`), [], `page-${value} is registered`)
assert.deepEqual(warningsOf('T {page-55}'), ['unknown-trigger:page-55'])

// Registered reality stays silent (Milestone B registrations + approved audit closures).
assert.deepEqual(warningsOf('T {timeline=rail}'), [])
assert.deepEqual(warningsOf('T {contrast=cards}'), [])
assert.deepEqual(warningsOf('T {chart=pie}'), [])
assert.deepEqual(warningsOf('T {layout=timeline-visual}'), [])
assert.deepEqual(warningsOf('T {layout=code}'), [])
assertCleanValues('title', ['side', 'sidebar', 'top', 'off', 'none', 'hide'])
assert.deepEqual(warningsOf('T {title=banana}'), ['unresolved-trigger:title=banana'])
assertCleanValues('align', ['top', 'center', 'centre', 'middle'])
assert.deepEqual(warningsOf('T {align=banana}'), ['unresolved-trigger:align=banana'])
assertCleanValues('icons', ['top', 'all', 'off', 'none', 'on', 'yes'])
assert.deepEqual(warningsOf('T {icons=banana}'), ['unresolved-trigger:icons=banana'])
assert.deepEqual(warningsOf('T {section=corner}'), [])
assert.deepEqual(warningsOf('T {section=off}'), [])
assert.deepEqual(warningsOf('T {section=banana}'), ['unresolved-trigger:section=banana'])

// Every registry entry must prove its own documentation sample against both validators. A sample
// is executable registry data: accepting the entry while rejecting its sample is a release blocker.
for (const entry of LAYOUTS) {
  const lines = entry.sample.split('\n')
  const fenced = fencedLineFlags(lines)
  const compilerWarnings = lines.flatMap((line, index) => {
    if (fenced[index]) return []
    if (!/^#{2,6}\s/.test(line) && !TRIGGER_LINE_RE.test(line.trim())) return []
    return parseHeadingAttrs(line).warnings
  })
  assert.deepEqual(
    scanOutlineTriggers(entry.sample),
    [],
    `${entry.name}: registry sample is clean under scanOutlineTriggers`
  )
  assert.deepEqual(
    compilerWarnings,
    [],
    `${entry.name}: registry sample is clean under parseHeadingAttrs`
  )
}
console.log(`registry samples: PASS (${LAYOUTS.length} entries under both validators)`)

// Differential law: the Doctor and compiler must classify the complete generated vocabulary
// identically. Every finite value is legal only in equals form; colon form is reserved for an
// explicitly colon-declared open pattern.
const doctorValidationKinds = new Set(['unknown-word', 'unregistered-key', 'unregistered-value'])
const doctorFlags = (token) => scanOutlineTriggers(`### T\n{${token}}\n`)
  .some((finding) => doctorValidationKinds.has(finding.kind))
const compilerFlags = (token) => warningsOf(`T {${token}}`)
  .some((warning) => warning.startsWith('unknown-trigger:') || warning.startsWith('unresolved-trigger:'))
let differentialCases = 0
const assertAgreement = (token, expectedFlagged) => {
  const doctorFlagged = doctorFlags(token)
  const compilerFlagged = compilerFlags(token)
  assert.equal(doctorFlagged, expectedFlagged, `Doctor classification for ${token}`)
  assert.equal(compilerFlagged, expectedFlagged, `compiler classification for ${token}`)
  assert.equal(doctorFlagged, compilerFlagged, `Doctor/compiler disagreement for ${token}`)
  differentialCases += 1
}

for (const word of Object.keys(TRIGGER_DICTIONARY)) assertAgreement(word, false)
for (const [key, values] of Object.entries(VALUE_TRIGGER_DICTIONARY)) {
  for (const value of values) {
    assertAgreement(`${key}=${value}`, false)
    assertAgreement(`${key}:${value}`, true)
  }
}

const openPatternSamples = new Map([
  ['pollselections', '2'],
  ['pollsubmissions', 'unlimited'],
  ['id', 'abc-123'],
  ['tags', 'intro,team'],
  ['reactions', 'agree,disagree'],
  ['from', 'source-talk'],
  ['clonedFrom', 'source-talk'],
  ['icon', 'sparkles'],
  ['kicker', 'Opening'],
  ['remind', 'Slow-down'],
  ['remind-at', '09:30'],
  ['remind-in', '10min'],
  ['countdown', '30s'],
  ['timer', '10min'],
  ['countdown-style', 'digits'],
  ['blocks', '3x3'],
  ['cols', '4'],
  ['polltop', '2'],
  ['palette', 'oxford'],
  ['centre', 'Core'],
  ['center', 'Core'],
  ['curve', 'sigmoid'],
  ['titlestyle', 'rail'],
  ['results', 'pwtools']
])
assert.deepEqual(
  [...openPatternSamples.keys()].sort(),
  OPEN_PATTERN_TOKENS.map(({ key }) => key).sort(),
  'every open pattern has a differential sample'
)
for (const pattern of OPEN_PATTERN_TOKENS) {
  const value = openPatternSamples.get(pattern.key)
  if (pattern.form === 'bare') {
    assert.equal(value, null, `${pattern.key}: presence declaration carries no invented value`)
    assertAgreement(pattern.key, false)
    assertAgreement(`${pattern.key}=true`, true)
    assertAgreement(`${pattern.key}:true`, true)
    continue
  }
  assert.ok(value && pattern.pattern && new RegExp(`^(?:${pattern.pattern})$`).test(value), `${pattern.key}: differential sample matches its pattern`)
  const ownForm = pattern.form === 'equals' ? `${pattern.key}=${value}` : `${pattern.key}:${value}`
  const wrongForm = pattern.form === 'equals' ? `${pattern.key}:${value}` : `${pattern.key}=${value}`
  assertAgreement(ownForm, false)
  assertAgreement(wrongForm, true)
}

const dynamicSamples = [
  'countdown-digits-30s',
  'countdown-bar-3min',
  'sidebar-30',
  'sidebar-50',
  'page-60',
  'page-70',
  'page-80'
]
for (const pattern of DYNAMIC_PATTERNS) {
  const matches = dynamicSamples.filter((sample) => new RegExp(pattern.source).test(sample))
  assert.ok(matches.length > 0, `${pattern.source}: dynamic family has a differential sample`)
  for (const sample of matches) assertAgreement(sample, false)
}

for (const [token, expectedFlagged] of [
  ['=side', false],
  ['title:', true],
  ['title::side', true],
  ['title=side=extra', true],
  ['title!side', false],
  ['title side', true],
  ['title,,side', true],
  ['blocks=3x3', true],
  ['id:abc', true],
  ['nonsense:value', true],
  ['nonsense=value', true]
]) assertAgreement(token, expectedFlagged)

// Open patterns stay silent, including quoted list-values.
assert.deepEqual(warningsOf('T {blocks:3x3}{cols=4}{id=abc123}'), [])
assert.deepEqual(warningsOf('T {kicker="A, B"}{tags=intro,team}'), [])

// Ticket 04: every {reactions=…} form is registered in both validators — off, named sets (list
// commas bind to the value), quoted custom labels with spaces, and a mix; an empty value is not.
for (const token of [
  'reactions=off', 'reactions=agree,disagree', 'reactions=agree,disagree,bookmark',
  'reactions="Too fast","Just right","Too slow"', 'reactions=agree,"Too fast"'
]) assertAgreement(token, false)
assertAgreement('reactions=', true)
assert.deepEqual(warningsOf('T {reactions="Too fast","Just right","Too slow"}{id=abc123}'), [])

// Ticket 01 (ADR-0032): {poll=board} and every board setting value — the defaults spelled out
// included — are registered in both validators; values off the drawn choices are not.
for (const token of [
  'poll=board', 'limit=12', 'limit=24', 'limit=36', 'limit=all', 'length=60', 'length=100', 'length=140', 'length=200',
  'cards=1', 'cards=3', 'cards=5', 'cards=10', 'names', 'names=optional', 'names=off', 'closes=1d', 'closes=7d', 'closes=30d'
]) assertAgreement(token, false)
for (const token of ['poll=boards', 'limit=13', 'length=150', 'cards=4', 'names=on', 'closes=7', 'closes=2d']) assertAgreement(token, true)
assert.deepEqual(warningsOf('T {poll=board}{limit=36}{length=100}{cards=3}{names}{closes=30d}{id=abc123}'), [])

// Ticket 08 (ADR-0032 amendment point 5): the pre-work tokens are registered in both validators;
// a time off the drawn choices and a results value that is no id are not.
for (const token of ['prework', 'task', 'readonly', 'check', 'right', 'noask', 'minutes=5', 'minutes=10', 'minutes=20', 'minutes=30', 'results=pwtools', 'results=step-2']) assertAgreement(token, false)
for (const token of ['minutes=15', 'minutes=10m', 'results=a b', 'results:pwtools']) assertAgreement(token, true)
assert.deepEqual(warningsOf('T {poll=single}{check}{id=pwquiz}'), [])
assert.deepEqual(warningsOf('T {task}{readonly}{minutes=20}{noask}{id=pwtask1}'), [])
// Fix round S3: {results=…} takes exactly the ids {id=…} takes.
for (const value of ['pwtools', 'step-2', 'A1', 'a_b', 'a.b', 'a b']) assert.deepEqual(warningsOf(`T {results=${value}}`).length === 0, warningsOf(`T {id=${value}}`).length === 0, `results=${value} and id=${value} agree`)
// The {task} flip: {done} is no longer a token.
assertAgreement('done', true)
assert.deepEqual(warningsOf('T {results=pwtools}{id=r1tools}'), [])

// Dictionary-resolved bare words are never re-validated; unknown bare words keep their id.
assert.deepEqual(warningsOf('T {timelinespine}'), [])
assert.deepEqual(warningsOf('T {nonsense}'), ['unknown-trigger:nonsense'])

// Conflict semantics untouched: last wins, one warning.
assert.deepEqual(warningsOf('T {statement}{quote}'), ['trigger-conflict:layout:statement→quote'])

console.log(`trigger validation: PASS (${differentialCases} differential cases)`)
